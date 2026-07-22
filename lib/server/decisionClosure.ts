import type { SupabaseClient } from '@supabase/supabase-js';
import { executionItemSuppressionSignatureForRow, type ProjectExecutionItemRow } from '@/lib/executionItems';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { logDecisionFeedback } from '@/lib/server/decisionFeedback';
import { processWorkflowTriggers } from '@/lib/server/workflows/processWorkflowTriggers';
import { requestDecisionStatusRevalidation } from '@/lib/validator/revalidationRequests';
import { emitValidationFindingLifecycleActivity } from '@/lib/validator/validationFindingActivity';
import type { ValidationFinding } from '@/types/validator';

export type TerminalDecisionStatus = 'resolved' | 'dismissed';
export type DecisionTerminalStatus = TerminalDecisionStatus;

export type CloseDecisionLinkedWorkInput = {
  admin: SupabaseClient;
  decisionId: string;
  organizationId: string;
  projectId: string | null;
  documentId: string | null;
  actorId: string;
  status: TerminalDecisionStatus;
  now: string;
};

export type CloseDecisionLinkedWorkResult = {
  closedFindingIds: string[];
  closedWorkflowTaskIds: string[];
  closedExecutionItemIds: string[];
  recomputedDocumentStatus: boolean;
  errors: string[];
};

export type DecisionClosureInput = {
  admin: SupabaseClient;
  decision: {
    id: string;
    organization_id: string;
    project_id: string | null;
    document_id?: string | null;
    status: string | null;
    severity: string | null;
  };
  organizationId: string;
  actorId: string;
  status: DecisionTerminalStatus;
  operatorAction?: string | null;
  writeLegacyFeedback?: boolean;
};

export type DecisionClosureResult = {
  decision: Record<string, unknown>;
  linkedFindingIds: string[];
  linkedClosure: CloseDecisionLinkedWorkResult | null;
};

const ACTIVE_WORKFLOW_TASK_STATUSES = ['open', 'in_progress', 'blocked'] as const;
const OPEN_EXECUTION_ITEM_STATUSES = ['open', 'resolvable'] as const;

type LinkedFindingRow = ValidationFinding & {
  id: string;
  linked_action_id: string | null;
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

async function recomputeDocumentOperationalStatus(params: {
  admin: SupabaseClient;
  documentId: string | null;
  projectId: string | null;
}): Promise<{ recomputed: boolean; error: string | null }> {
  const rpcName = params.documentId
    ? 'recompute_document_operational_status'
    : params.projectId
      ? 'recompute_project_documents_operational_status'
      : null;
  if (!rpcName) return { recomputed: false, error: null };

  const args = params.documentId
    ? { p_document_id: params.documentId }
    : { p_project_id: params.projectId };

  const { error } = await params.admin.rpc(rpcName, args);
  return {
    recomputed: !error,
    error: error?.message ?? null,
  };
}

export async function closeDecisionLinkedWork(
  input: CloseDecisionLinkedWorkInput,
): Promise<CloseDecisionLinkedWorkResult> {
  const result: CloseDecisionLinkedWorkResult = {
    closedFindingIds: [],
    closedWorkflowTaskIds: [],
    closedExecutionItemIds: [],
    recomputedDocumentStatus: false,
    errors: [],
  };

  if (!input.projectId) {
    result.errors.push('decision_project_missing');
    return result;
  }

  const terminalFindingStatus = input.status === 'dismissed' ? 'dismissed' : 'resolved';
  const terminalTaskStatus = input.status === 'dismissed' ? 'cancelled' : 'resolved';
  const terminalExecutionOutcome = input.status === 'dismissed' ? 'overridden' : 'resolved';

  const { data: linkedFindings, error: findingFetchError } = await input.admin
    .from('project_validation_findings')
    .select('*')
    .eq('linked_decision_id', input.decisionId)
    .eq('project_id', input.projectId);

  if (findingFetchError) {
    result.errors.push(`findings_fetch_failed:${findingFetchError.message}`);
  }

  const findingRows = (linkedFindings ?? []) as LinkedFindingRow[];
  const openFindingIds = findingRows
    .filter((finding) => finding.status === 'open')
    .map((finding) => finding.id);
  const linkedExecutionItemIds = uniqueStrings(findingRows.map((finding) => finding.linked_action_id));

  if (openFindingIds.length > 0) {
    const { data: closedFindings, error: findingCloseError } = await input.admin
      .from('project_validation_findings')
      .update({
        status: terminalFindingStatus,
        resolved_by_user_id: input.actorId,
        resolved_at: input.now,
        updated_at: input.now,
      })
      .in('id', openFindingIds)
      .eq('project_id', input.projectId)
      .eq('status', 'open')
      .select('id');

    if (findingCloseError) {
      result.errors.push(`findings_close_failed:${findingCloseError.message}`);
    } else {
      result.closedFindingIds = ((closedFindings ?? []) as Array<{ id: string }>).map((row) => row.id);
      const closedFindingIds = new Set(result.closedFindingIds);
      for (const finding of findingRows.filter((row) => closedFindingIds.has(row.id))) {
        const activityResult = await emitValidationFindingLifecycleActivity({
          organizationId: input.organizationId,
          projectId: input.projectId,
          findingId: finding.id,
          changedBy: input.actorId,
          previousFinding: finding,
          currentFinding: {
            ...finding,
            status: terminalFindingStatus,
            resolved_by_user_id: input.actorId,
            resolved_at: input.now,
            updated_at: input.now,
          },
        });
        if (!activityResult.ok) {
          result.errors.push(`activity_event_failed:${finding.id}:${activityResult.error}`);
        }
      }
    }
  }

  const { data: linkedTasks, error: taskFetchError } = await input.admin
    .from('workflow_tasks')
    .select('id')
    .eq('organization_id', input.organizationId)
    .eq('decision_id', input.decisionId)
    .in('status', [...ACTIVE_WORKFLOW_TASK_STATUSES]);

  if (taskFetchError) {
    result.errors.push(`workflow_tasks_fetch_failed:${taskFetchError.message}`);
  }

  const taskIds = uniqueStrings(((linkedTasks ?? []) as Array<{ id: string }>).map((task) => task.id));
  if (taskIds.length > 0) {
    const { error: taskCloseError } = await input.admin
      .from('workflow_tasks')
      .update({
        status: terminalTaskStatus,
        completed_at: input.now,
        updated_at: input.now,
      })
      .eq('organization_id', input.organizationId)
      .eq('decision_id', input.decisionId)
      .in('status', [...ACTIVE_WORKFLOW_TASK_STATUSES]);

    if (taskCloseError) {
      result.errors.push(`workflow_tasks_close_failed:${taskCloseError.message}`);
    } else {
      result.closedWorkflowTaskIds = taskIds;
    }
  }

  if (linkedExecutionItemIds.length > 0) {
    const { data: executionItems, error: executionFetchError } = await input.admin
      .from('execution_items')
      .select('*')
      .eq('organization_id', input.organizationId)
      .eq('project_id', input.projectId)
      .in('id', linkedExecutionItemIds)
      .in('status', [...OPEN_EXECUTION_ITEM_STATUSES]);

    if (executionFetchError) {
      result.errors.push(`execution_items_fetch_failed:${executionFetchError.message}`);
    }

    const executionRows = (executionItems ?? []) as ProjectExecutionItemRow[];
    for (const item of executionRows) {
      const { error: executionCloseError } = await input.admin
        .from('execution_items')
        .update({
          status: 'resolved',
          outcome: terminalExecutionOutcome,
          override_reason: input.status === 'dismissed' ? 'Suppressed through linked decision closure.' : null,
          suppression_signature: executionItemSuppressionSignatureForRow(item),
          last_seen_at: input.now,
          overridden_at: input.status === 'dismissed' ? input.now : item.overridden_at,
          resolved_at: input.now,
          updated_at: input.now,
        })
        .eq('id', item.id)
        .eq('organization_id', input.organizationId)
        .in('status', [...OPEN_EXECUTION_ITEM_STATUSES]);

      if (executionCloseError) {
        result.errors.push(`execution_item_close_failed:${item.id}:${executionCloseError.message}`);
      } else {
        result.closedExecutionItemIds.push(item.id);
      }
    }
  }

  const recomputeResult = await recomputeDocumentOperationalStatus({
    admin: input.admin,
    documentId: input.documentId,
    projectId: input.projectId,
  });
  result.recomputedDocumentStatus = recomputeResult.recomputed;
  if (recomputeResult.error) {
    result.errors.push(`document_status_recompute_failed:${recomputeResult.error}`);
  }

  return result;
}

export async function finalizeDecision(
  params: DecisionClosureInput,
): Promise<DecisionClosureResult> {
  const previousStatus = params.decision.status;
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status: params.status,
    updated_at: now,
    resolved_at: params.status === 'resolved' ? now : null,
  };

  const { data: updated, error: updateError } = await params.admin
    .from('decisions')
    .update(updates)
    .eq('id', params.decision.id)
    .eq('organization_id', params.organizationId)
    .select()
    .single();

  if (updateError || !updated) {
    throw new Error(updateError?.message ?? 'Failed to update decision');
  }

  const linkedClosure = await closeDecisionLinkedWork({
    admin: params.admin,
    decisionId: params.decision.id,
    organizationId: params.organizationId,
    projectId: params.decision.project_id,
    documentId: params.decision.document_id ?? null,
    actorId: params.actorId,
    status: params.status,
    now,
  });
  if (linkedClosure.errors.length > 0) {
    console.error('[decisionClosure] linked closure completed with errors:', linkedClosure.errors);
  }

  if (previousStatus !== params.status) {
    const activityResult = await logActivityEvent({
      organization_id: params.organizationId,
      project_id: params.decision.project_id,
      entity_type: 'decision',
      entity_id: params.decision.id,
      event_type: 'status_changed',
      changed_by: params.actorId,
      old_value: { status: previousStatus },
      new_value: {
        status: params.status,
        operator_action: params.operatorAction ?? null,
        linked_closure: {
          findings: linkedClosure.closedFindingIds.length,
          workflow_tasks: linkedClosure.closedWorkflowTaskIds.length,
          execution_items: linkedClosure.closedExecutionItemIds.length,
          document_status_recomputed: linkedClosure.recomputedDocumentStatus,
          errors: linkedClosure.errors,
        },
      },
    });

    if (!activityResult.ok) {
      console.error('[decisionClosure] activity event failed:', activityResult.error);
    }

    if (params.writeLegacyFeedback) {
      const feedbackResult = await logDecisionFeedback(params.admin, {
        organization_id: params.organizationId,
        decision_id: params.decision.id,
        new_status: params.status,
        previous_status: previousStatus,
        created_by: params.actorId,
      });
      if (!feedbackResult.ok) {
        console.error('[decisionClosure] feedback insert failed:', feedbackResult.error);
      }
    }

    await processWorkflowTriggers({
      organizationId: params.organizationId,
      eventType: 'status_changed',
      entityType: 'decision',
      entityId: params.decision.id,
      payload: {
        from: previousStatus,
        to: params.status,
        severity: params.decision.severity,
      },
    });

    void requestDecisionStatusRevalidation({
      projectId: params.decision.project_id,
      actorId: params.actorId,
      newStatus: params.status,
    });
  }

  return {
    decision: updated as Record<string, unknown>,
    linkedFindingIds: linkedClosure.closedFindingIds,
    linkedClosure,
  };
}
