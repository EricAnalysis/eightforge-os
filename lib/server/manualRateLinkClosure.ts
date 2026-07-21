import type { SupabaseClient } from '@supabase/supabase-js';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { finalizeDecision } from '@/lib/server/decisionClosure';

const MANUAL_RATE_LINK_RULE_IDS = [
  'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
  'FINANCIAL_RATE_CODE_MISSING',
] as const;

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

/** Inserts an active link and preserves the prior selection in a supersession chain. */
export async function insertManualRateLink(
  input: InsertManualRateLinkInput,
): Promise<InsertManualRateLinkResult> {
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

export type ClosedManualRateLinkFinding = {
  findingId: string;
  ruleId: string;
  closurePath: 'direct_update' | 'finalize_decision';
};

export type CloseManualRateLinkFindingsResult = {
  closedFindings: ClosedManualRateLinkFinding[];
  errors: string[];
};

/**
 * Closes findings resolved by an operator-confirmed rate mapping.
 *
 * Validation-time manual-link injection is live in cross-document rate
 * verification, exposure, and financial integrity, so the persisted mapping
 * remains authoritative on subsequent validation runs.
 */
export async function closeManualRateLinkFindings(
  input: CloseManualRateLinkFindingsInput,
): Promise<CloseManualRateLinkFindingsResult> {
  const result: CloseManualRateLinkFindingsResult = {
    closedFindings: [],
    errors: [],
  };

  const { data: findings, error: findingError } = await input.admin
    .from('project_validation_findings')
    .select('id, rule_id, status, linked_decision_id')
    .eq('project_id', input.projectId)
    .in('rule_id', [...MANUAL_RATE_LINK_RULE_IDS])
    .eq('subject_id', input.invoiceLineSubjectId)
    .eq('status', 'open');

  if (findingError) {
    result.errors.push(`finding_fetch_failed:${findingError.message}`);
    return result;
  }

  const findingRows = (findings ?? []) as Array<{
    id: string;
    rule_id: string;
    status: string;
    linked_decision_id: string | null;
  }>;
  const now = new Date().toISOString();
  const finalizedDecisionIds = new Set<string>();

  for (const findingRow of findingRows) {
    if (findingRow.linked_decision_id) {
      if (finalizedDecisionIds.has(findingRow.linked_decision_id)) continue;
      finalizedDecisionIds.add(findingRow.linked_decision_id);

      const { data: decision, error: decisionError } = await input.admin
        .from('decisions')
        .select('id, organization_id, project_id, document_id, status, severity')
        .eq('id', findingRow.linked_decision_id)
        .single();

      if (decisionError || !decision) {
        result.errors.push(`decision_fetch_failed:${decisionError?.message ?? 'not found'}`);
        continue;
      }

      try {
        const closureResult = await finalizeDecision({
          admin: input.admin,
          decision: decision as {
            id: string;
            organization_id: string;
            project_id: string | null;
            document_id: string | null;
            status: string | null;
            severity: string | null;
          },
          organizationId: input.organizationId,
          actorId: input.actorId,
          status: 'dismissed',
          operatorAction: 'manual_rate_link',
        });
        const closedIds = new Set(closureResult.linkedFindingIds);
        for (const linkedFinding of findingRows) {
          if (
            linkedFinding.linked_decision_id === findingRow.linked_decision_id
            && closedIds.has(linkedFinding.id)
          ) {
            result.closedFindings.push({
              findingId: linkedFinding.id,
              ruleId: linkedFinding.rule_id,
              closurePath: 'finalize_decision',
            });
          }
        }
      } catch (error) {
        result.errors.push(
          `finalize_decision_failed:${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

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
      result.errors.push(`finding_update_failed:${findingRow.id}:${updateError.message}`);
      continue;
    }

    result.closedFindings.push({
      findingId: findingRow.id,
      ruleId: findingRow.rule_id,
      closurePath: 'direct_update',
    });

    const activityResult = await logActivityEvent({
      organization_id: input.organizationId,
      project_id: input.projectId,
      entity_type: 'project_validation_finding',
      entity_id: findingRow.id,
      event_type: 'override_applied',
      changed_by: input.actorId,
      old_value: { status: 'open', rule_id: findingRow.rule_id },
      new_value: {
        status: 'resolved',
        closure_method: 'manual_rate_link',
        contract_rate_row_id: input.contractRateRowId,
        rate_row_description: input.rateRowDescription,
        reason: input.reason,
      },
    });

    if (!activityResult.ok) {
      result.errors.push(`activity_event_failed:${findingRow.id}:${activityResult.error}`);
    }
  }

  return result;
}
