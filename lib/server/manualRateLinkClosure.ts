import type { SupabaseClient } from '@supabase/supabase-js';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { finalizeDecision } from '@/lib/server/decisionClosure';

const CROSS_DOCUMENT_RATE_RULE_ID = 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS';

// ─────────────────────────────────────────────────────────────────────────────
// insertManualRateLink
//
// Inserts a new active invoice_line_rate_links row.  If an active link already
// exists for the same invoice line, it is deactivated and its superseded_by
// is set to the new row's id so the supersession chain is maintained.
// ─────────────────────────────────────────────────────────────────────────────

export type InsertManualRateLinkInput = {
  admin: SupabaseClient;
  organizationId: string;
  projectId: string;
  invoiceDocumentId: string;
  invoiceLineSubjectId: string;
  invoiceLineNumber: string | null;
  invoiceLineDescription: string | null;
  invoiceLineBillingCode: string | null;
  contractDocumentId: string;
  contractRateRowId: string;
  rateRowDescription: string | null;
  rateRowUnitType: string | null;
  rateRowRateAmount: number | null;
  actorId: string;
  reason: string | null;
};

export type InsertManualRateLinkResult =
  | { ok: true; linkId: string; supersededLinkId: string | null }
  | { ok: false; error: string; status: number };

export async function insertManualRateLink(
  input: InsertManualRateLinkInput,
): Promise<InsertManualRateLinkResult> {
  // Find any currently-active link for this invoice line.
  const { data: existing, error: existingError } = await input.admin
    .from('invoice_line_rate_links')
    .select('id')
    .eq('organization_id', input.organizationId)
    .eq('project_id', input.projectId)
    .eq('invoice_document_id', input.invoiceDocumentId)
    .eq('invoice_line_subject_id', input.invoiceLineSubjectId)
    .eq('is_active', true)
    .maybeSingle();

  if (existingError) {
    return { ok: false, error: existingError.message, status: 500 };
  }

  const existingRow = existing as { id: string } | null;

  // Deactivate the old link before inserting so the unique partial index does
  // not reject the insert.  superseded_by is set after we have the new id.
  if (existingRow) {
    const { error: deactivateError } = await input.admin
      .from('invoice_line_rate_links')
      .update({ is_active: false })
      .eq('id', existingRow.id);

    if (deactivateError) {
      return { ok: false, error: deactivateError.message, status: 500 };
    }
  }

  const { data: inserted, error: insertError } = await input.admin
    .from('invoice_line_rate_links')
    .insert({
      organization_id: input.organizationId,
      project_id: input.projectId,
      invoice_document_id: input.invoiceDocumentId,
      invoice_line_subject_id: input.invoiceLineSubjectId,
      invoice_line_number: input.invoiceLineNumber,
      invoice_line_description: input.invoiceLineDescription,
      invoice_line_billing_code: input.invoiceLineBillingCode,
      contract_document_id: input.contractDocumentId,
      contract_rate_row_id: input.contractRateRowId,
      rate_row_description: input.rateRowDescription,
      rate_row_unit_type: input.rateRowUnitType,
      rate_row_rate_amount: input.rateRowRateAmount,
      actor_id: input.actorId,
      reason: input.reason,
      is_active: true,
      superseded_by: null,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    return {
      ok: false,
      error: insertError?.message ?? 'Insert returned no row',
      status: 500,
    };
  }

  const newLinkId = (inserted as { id: string }).id;

  // Point the old link's superseded_by to the new link.  Non-fatal if this
  // fails because the deactivation already prevents the old link from being
  // used as an active link.
  if (existingRow) {
    const { error: supersededError } = await input.admin
      .from('invoice_line_rate_links')
      .update({ superseded_by: newLinkId })
      .eq('id', existingRow.id);

    if (supersededError) {
      console.error('[manualRateLinkClosure] failed to set superseded_by on old link', {
        oldLinkId: existingRow.id,
        newLinkId,
        error: supersededError.message,
      });
    }
  }

  return { ok: true, linkId: newLinkId, supersededLinkId: existingRow?.id ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────
// closeManualRateLinkFindings
//
// One-time closure bridge for CROSS_DOCUMENT_CONTRACT_RATE_EXISTS findings.
//
// PASS 1 KNOWN LIMITATION: This closure is one-shot.  Because Pass 2's
// validation-time injection into matchRateScheduleItemForInvoiceLine has not
// been built yet, the next re-validation run will reopen this finding.
// The manual link IS persisted in invoice_line_rate_links; Pass 2 will use it
// to prevent the finding from being generated again.
//
// Closure path selection:
//   linked_decision_id present → finalizeDecision('dismissed') cascade
//   linked_decision_id null    → direct finding update to 'resolved' +
//                                explicit activity event for audit trail
//                                (current confirmed real-world path)
//
// Exposure rollup NOTE: requestDecisionStatusRevalidation is intentionally NOT
// called here.  Triggering a full re-validation run in Pass 1 would immediately
// reopen the CROSS_DOCUMENT_CONTRACT_RATE_EXISTS finding since the validator's
// matchRateScheduleItemForInvoiceLine has no injection point yet.  Exposure
// rollup findings (INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO, etc.) will not
// recompute until Pass 2 ships the injection and re-validation succeeds end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

export type CloseManualRateLinkFindingsInput = {
  admin: SupabaseClient;
  organizationId: string;
  projectId: string;
  invoiceLineSubjectId: string;
  actorId: string;
  contractRateRowId: string;
  rateRowDescription: string | null;
  reason: string | null;
};

export type CloseManualRateLinkFindingsResult = {
  closedFindingIds: string[];
  closurePath: 'direct_update' | 'finalize_decision' | 'no_open_finding';
  errors: string[];
};

export async function closeManualRateLinkFindings(
  input: CloseManualRateLinkFindingsInput,
): Promise<CloseManualRateLinkFindingsResult> {
  const result: CloseManualRateLinkFindingsResult = {
    closedFindingIds: [],
    closurePath: 'no_open_finding',
    errors: [],
  };

  const { data: finding, error: findingError } = await input.admin
    .from('project_validation_findings')
    .select('id, status, linked_decision_id')
    .eq('project_id', input.projectId)
    .eq('rule_id', CROSS_DOCUMENT_RATE_RULE_ID)
    .eq('subject_id', input.invoiceLineSubjectId)
    .eq('status', 'open')
    .maybeSingle();

  if (findingError) {
    result.errors.push(`finding_fetch_failed:${findingError.message}`);
    return result;
  }

  if (!finding) {
    return result;
  }

  const findingRow = finding as {
    id: string;
    status: string;
    linked_decision_id: string | null;
  };

  const now = new Date().toISOString();

  if (findingRow.linked_decision_id) {
    // The finding has a linked decision → cascade closure through finalizeDecision.
    const { data: decision, error: decisionError } = await input.admin
      .from('decisions')
      .select('id, organization_id, project_id, document_id, status, severity')
      .eq('id', findingRow.linked_decision_id)
      .single();

    if (decisionError || !decision) {
      result.errors.push(`decision_fetch_failed:${decisionError?.message ?? 'not found'}`);
      return result;
    }

    const decisionRow = decision as {
      id: string;
      organization_id: string;
      project_id: string | null;
      document_id: string | null;
      status: string | null;
      severity: string | null;
    };

    try {
      const closureResult = await finalizeDecision({
        admin: input.admin,
        decision: decisionRow,
        organizationId: input.organizationId,
        actorId: input.actorId,
        status: 'dismissed',
        operatorAction: 'manual_rate_link',
      });
      result.closedFindingIds = closureResult.linkedFindingIds;
      result.closurePath = 'finalize_decision';
    } catch (err) {
      result.errors.push(
        `finalize_decision_failed:${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }

  // No linked decision — resolve the finding directly.
  // An explicit audit event is required here because we bypass finalizeDecision's
  // cascade so there is no other durable record of this resolution.
  const { error: updateError } = await input.admin
    .from('project_validation_findings')
    .update({
      status: 'resolved',
      resolved_by_user_id: input.actorId,
      resolved_at: now,
      updated_at: now,
    })
    .eq('id', findingRow.id)
    .eq('status', 'open');

  if (updateError) {
    result.errors.push(`finding_update_failed:${updateError.message}`);
    return result;
  }

  result.closedFindingIds = [findingRow.id];
  result.closurePath = 'direct_update';

  const activityResult = await logActivityEvent({
    organization_id: input.organizationId,
    project_id: input.projectId,
    entity_type: 'project_validation_finding',
    entity_id: findingRow.id,
    event_type: 'override_applied',
    changed_by: input.actorId,
    old_value: { status: 'open', rule_id: CROSS_DOCUMENT_RATE_RULE_ID },
    new_value: {
      status: 'resolved',
      closure_method: 'manual_rate_link',
      contract_rate_row_id: input.contractRateRowId,
      rate_row_description: input.rateRowDescription,
      reason: input.reason,
    },
  });

  if (!activityResult.ok) {
    result.errors.push(`activity_event_failed:${activityResult.error}`);
  }

  return result;
}
