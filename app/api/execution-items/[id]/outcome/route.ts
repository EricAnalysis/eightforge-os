import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { triggerProjectValidation } from '@/lib/validator/triggerProjectValidation';
import type {
  ExecutionItemOutcome,
  ExecutionItemStatus,
  ProjectExecutionItemRow,
} from '@/lib/executionItems';
import { executionItemSuppressionSignatureForRow } from '@/lib/executionItems';
import type { FindingStatus, ValidationTriggerSource } from '@/types/validator';

type OutcomeAction = 'approve' | 'correct' | 'override';
type MutationEvidenceResult = {
  verified: boolean;
  checked: boolean;
  warning: string | null;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function hasCanonicalTruthMutation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.canonical_mutation_id === 'string' ||
    typeof body.canonicalMutationId === 'string' ||
    (
      body.canonicalMutation != null &&
      typeof body.canonicalMutation === 'object'
    )
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function mutationLookupTargets(
  executionItem: ProjectExecutionItemRow,
  body: unknown,
): { documentIds: string[]; fieldKeys: string[] } {
  const bodyRecord = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const mutationRecord =
    bodyRecord.canonicalMutation && typeof bodyRecord.canonicalMutation === 'object'
      ? bodyRecord.canonicalMutation as Record<string, unknown>
      : {};
  const documentIds = new Set<string>();
  const fieldKeys = new Set<string>();

  for (const value of [
    mutationRecord.document_id,
    mutationRecord.documentId,
    bodyRecord.document_id,
    bodyRecord.documentId,
  ]) {
    if (typeof value === 'string' && value.trim().length > 0) documentIds.add(value.trim());
  }
  for (const value of [
    mutationRecord.field_key,
    mutationRecord.fieldKey,
    bodyRecord.field_key,
    bodyRecord.fieldKey,
  ]) {
    if (typeof value === 'string' && value.trim().length > 0) fieldKeys.add(value.trim());
  }

  for (const ref of [
    ...stringArray(executionItem.evidence_refs),
    ...stringArray(executionItem.fact_refs),
    executionItem.source_key,
  ]) {
    const documentMatch = ref.match(/(?:document|doc):([^:|/?#]+)/i);
    if (documentMatch?.[1]) documentIds.add(documentMatch[1]);

    const factMatch = ref.match(/fact:([^:|/?#]+):([^:|/?#]+)/i);
    if (factMatch?.[1]) documentIds.add(factMatch[1]);
    if (factMatch?.[2]) fieldKeys.add(factMatch[2]);

    const fieldMatch = ref.match(/(?:field|field_key|fieldKey)[:=]([^:|/?#&]+)/i);
    if (fieldMatch?.[1]) fieldKeys.add(fieldMatch[1]);
  }

  return {
    documentIds: [...documentIds],
    fieldKeys: [...fieldKeys],
  };
}

async function verifyCanonicalTruthMutation(params: {
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  executionItem: ProjectExecutionItemRow;
  organizationId: string;
  body: unknown;
}): Promise<MutationEvidenceResult> {
  const targets = mutationLookupTargets(params.executionItem, params.body);
  if (targets.documentIds.length === 0 && targets.fieldKeys.length === 0) {
    return {
      verified: false,
      checked: false,
      warning: 'canonical_mutation_linkage_missing',
    };
  }

  const createdAt = params.executionItem.created_at;
  const matchesTarget = (row: Record<string, unknown>): boolean => {
    const documentId = typeof row.document_id === 'string' ? row.document_id : null;
    const fieldKey = typeof row.field_key === 'string' ? row.field_key : null;
    const documentMatches = targets.documentIds.length === 0 || (documentId != null && targets.documentIds.includes(documentId));
    const fieldMatches = targets.fieldKeys.length === 0 || (fieldKey != null && targets.fieldKeys.includes(fieldKey));
    return documentMatches && fieldMatches;
  };

  try {
    const overrideResult = await params.admin
      .from('document_fact_overrides')
      .select('id, document_id, field_key, created_at')
      .eq('organization_id', params.organizationId)
      .in('document_id', targets.documentIds)
      .eq('is_active', true)
      .gte('created_at', createdAt)
      .limit(10);
    if (!overrideResult.error && ((overrideResult.data ?? []) as Record<string, unknown>[]).some(matchesTarget)) {
      return { verified: true, checked: true, warning: null };
    }
  } catch {
    return {
      verified: false,
      checked: false,
      warning: 'canonical_mutation_override_check_unavailable',
    };
  }

  try {
    const reviewResult = await params.admin
      .from('document_fact_reviews')
      .select('id, document_id, field_key, review_status, reviewed_at')
      .eq('organization_id', params.organizationId)
      .in('document_id', targets.documentIds)
      .in('review_status', ['corrected', 'confirmed'])
      .gte('reviewed_at', createdAt)
      .limit(10);
    if (!reviewResult.error && ((reviewResult.data ?? []) as Record<string, unknown>[]).some(matchesTarget)) {
      return { verified: true, checked: true, warning: null };
    }
  } catch {
    return {
      verified: false,
      checked: false,
      warning: 'canonical_mutation_review_check_unavailable',
    };
  }

  return {
    verified: false,
    checked: true,
    warning: 'canonical_mutation_not_found',
  };
}

function resolveOutcome(action: OutcomeAction): {
  outcome: ExecutionItemOutcome;
  findingStatus: FindingStatus;
  eventType:
    | 'execution_item_approved'
    | 'execution_item_corrected'
    | 'execution_item_overridden';
  triggerSource: ValidationTriggerSource;
} {
  switch (action) {
    case 'approve':
      return {
        outcome: 'confirmed',
        findingStatus: 'resolved',
        eventType: 'execution_item_approved',
        triggerSource: 'review_confirmed',
      };
    case 'correct':
      return {
        outcome: 'resolved',
        findingStatus: 'resolved',
        eventType: 'execution_item_corrected',
        triggerSource: 'review_corrected',
      };
    case 'override':
      return {
        outcome: 'overridden',
        findingStatus: 'dismissed',
        eventType: 'execution_item_overridden',
        triggerSource: 'override_applied',
      };
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`Unsupported execution action: ${exhaustiveCheck}`);
    }
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) return jsonError('Execution item not found', 404);

    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);
    const { actorId, organizationId } = ctx.actor;

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    const body = await req.json().catch(() => ({}));
    const action = body?.action;
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (action !== 'approve' && action !== 'correct' && action !== 'override') {
      return jsonError('Invalid execution action', 400);
    }
    if (action === 'override' && reason.length === 0) {
      return jsonError('Override reason is required', 400);
    }

    const { data: existing, error: fetchError } = await admin
      .from('execution_items')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchError || !existing) {
      return jsonError('Execution item not found', 404);
    }

    const executionItem = existing as ProjectExecutionItemRow;
    if (executionItem.organization_id !== organizationId) {
      return jsonError('Execution item not found', 404);
    }

    const now = new Date().toISOString();
    const resolution = resolveOutcome(action);
    const suppressionSignature = executionItemSuppressionSignatureForRow(executionItem);
    const correctHasCanonicalMutationMarker = action === 'correct' && hasCanonicalTruthMutation(body);
    const mutationEvidence = action === 'correct'
      ? await verifyCanonicalTruthMutation({
        admin,
        executionItem,
        organizationId,
        body,
      })
      : { verified: true, checked: false, warning: null };
    const correctHasCanonicalMutation =
      mutationEvidence.verified ||
      (!mutationEvidence.checked && correctHasCanonicalMutationMarker);
    const shouldFinalize = action !== 'correct' || correctHasCanonicalMutation;
    const updates: {
      status: ExecutionItemStatus;
      outcome: ExecutionItemOutcome | null;
      override_reason: string | null;
      suppression_signature: string | null;
      last_seen_at: string;
      overridden_at: string | null;
      resolved_at: string | null;
      updated_at: string;
    } = {
      status: shouldFinalize ? 'resolved' : 'resolvable',
      outcome: shouldFinalize ? resolution.outcome : null,
      override_reason: action === 'override' ? reason : null,
      suppression_signature: shouldFinalize ? suppressionSignature : null,
      last_seen_at: now,
      overridden_at: action === 'override' ? now : null,
      resolved_at: shouldFinalize ? now : null,
      updated_at: now,
    };

    const { data: updated, error: updateError } = await admin
      .from('execution_items')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (updateError || !updated) {
      return jsonError(updateError?.message ?? 'Failed to update execution item', 500);
    }

    if (shouldFinalize && executionItem.source_type === 'validator_finding' && executionItem.source_id) {
      await admin
        .from('project_validation_findings')
        .update({
          status: resolution.findingStatus,
          resolved_by_user_id: actorId,
          resolved_at: now,
          updated_at: now,
        })
        .eq('id', executionItem.source_id)
        .eq('project_id', executionItem.project_id);
    }

    const activityResult = await logActivityEvent({
      organization_id: organizationId,
      project_id: executionItem.project_id,
      entity_type: 'execution_item',
      entity_id: executionItem.id,
      event_type: resolution.eventType,
      changed_by: actorId,
      old_value: {
        execution_item_id: executionItem.id,
        finding_id: executionItem.source_type === 'validator_finding' ? executionItem.source_id : null,
        status: executionItem.status,
        previous_status: executionItem.status,
        outcome: executionItem.outcome,
        override_reason: executionItem.override_reason,
        suppression_signature: executionItem.suppression_signature,
        overridden_at: executionItem.overridden_at,
        evidence_refs: executionItem.evidence_refs,
        fact_refs: executionItem.fact_refs,
      },
      new_value: {
        execution_item_id: executionItem.id,
        finding_id: executionItem.source_type === 'validator_finding' ? executionItem.source_id : null,
        status: updates.status,
        new_status: updates.status,
        outcome: updates.outcome,
        override_reason: updates.override_reason,
        suppression_signature: updates.suppression_signature,
        overridden_at: updates.overridden_at,
        resolved_at: updates.resolved_at,
        evidence_refs: executionItem.evidence_refs,
        fact_refs: executionItem.fact_refs,
        source_type: executionItem.source_type,
        source_id: executionItem.source_id,
        canonical_truth_mutation_recorded: shouldFinalize,
        canonical_truth_mutation_verified: mutationEvidence.verified,
        canonical_truth_mutation_warning: mutationEvidence.warning,
      },
    });

    if (!activityResult.ok) {
      console.error('[execution-items/outcome] activity event failed', activityResult.error);
    }

    void triggerProjectValidation(executionItem.project_id, resolution.triggerSource, actorId);

    return NextResponse.json(updated);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Internal error',
      500,
    );
  }
}
