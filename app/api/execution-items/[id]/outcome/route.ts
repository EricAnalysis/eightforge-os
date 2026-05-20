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

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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
    const updates: {
      status: ExecutionItemStatus;
      outcome: ExecutionItemOutcome;
      override_reason: string | null;
      suppression_signature: string | null;
      last_seen_at: string;
      overridden_at: string | null;
      resolved_at: string;
      updated_at: string;
    } = {
      status: 'resolved',
      outcome: resolution.outcome,
      override_reason: action === 'override' ? reason : null,
      suppression_signature: suppressionSignature,
      last_seen_at: now,
      overridden_at: action === 'override' ? now : null,
      resolved_at: now,
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

    if (executionItem.source_type === 'validator_finding' && executionItem.source_id) {
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
        status: executionItem.status,
        outcome: executionItem.outcome,
        override_reason: executionItem.override_reason,
        suppression_signature: executionItem.suppression_signature,
        overridden_at: executionItem.overridden_at,
      },
      new_value: {
        status: updates.status,
        outcome: updates.outcome,
        override_reason: updates.override_reason,
        suppression_signature: updates.suppression_signature,
        overridden_at: updates.overridden_at,
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
