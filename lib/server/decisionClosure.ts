import type { SupabaseClient } from '@supabase/supabase-js';
import { executionItemSuppressionSignatureForRow, type ProjectExecutionItemRow } from '@/lib/executionItems';

export type TerminalDecisionStatus = 'resolved' | 'suppressed';

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

const ACTIVE_WORKFLOW_TASK_STATUSES = ['open', 'in_progress', 'blocked'] as const;
const OPEN_EXECUTION_ITEM_STATUSES = ['open', 'resolvable'] as const;

type LinkedFindingRow = {
  id: string;
  status: string | null;
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

  const terminalFindingStatus = input.status === 'suppressed' ? 'dismissed' : 'resolved';
  const terminalTaskStatus = input.status === 'suppressed' ? 'cancelled' : 'resolved';
  const terminalExecutionOutcome = input.status === 'suppressed' ? 'overridden' : 'resolved';

  const { data: linkedFindings, error: findingFetchError } = await input.admin
    .from('project_validation_findings')
    .select('id, status, linked_action_id')
    .eq('linked_decision_id', input.decisionId)
    .eq('project_id', input.projectId);

  if (findingFetchError) {
    result.errors.push(`findings_fetch_failed:${findingFetchError.message}`);
  }

  const findingRows = ((linkedFindings ?? []) as LinkedFindingRow[]);
  const openFindingIds = findingRows
    .filter((finding) => finding.status === 'open')
    .map((finding) => finding.id);
  const linkedExecutionItemIds = uniqueStrings(findingRows.map((finding) => finding.linked_action_id));

  if (openFindingIds.length > 0) {
    const { error: findingCloseError } = await input.admin
      .from('project_validation_findings')
      .update({
        status: terminalFindingStatus,
        resolved_by_user_id: input.actorId,
        resolved_at: input.now,
        updated_at: input.now,
      })
      .eq('linked_decision_id', input.decisionId)
      .eq('project_id', input.projectId)
      .eq('status', 'open');

    if (findingCloseError) {
      result.errors.push(`findings_close_failed:${findingCloseError.message}`);
    } else {
      result.closedFindingIds = openFindingIds;
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
          override_reason: input.status === 'suppressed' ? 'Suppressed through linked decision closure.' : null,
          suppression_signature: executionItemSuppressionSignatureForRow(item),
          last_seen_at: input.now,
          overridden_at: input.status === 'suppressed' ? input.now : item.overridden_at,
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
