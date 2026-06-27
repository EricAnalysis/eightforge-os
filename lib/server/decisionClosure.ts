import type { SupabaseClient } from '@supabase/supabase-js';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { logDecisionFeedback } from '@/lib/server/decisionFeedback';
import { processWorkflowTriggers } from '@/lib/server/workflows/processWorkflowTriggers';
import { requestDecisionStatusRevalidation } from '@/lib/validator/revalidationRequests';

export type DecisionTerminalStatus = 'resolved' | 'suppressed';

export type DecisionClosureInput = {
  admin: SupabaseClient;
  decision: {
    id: string;
    organization_id: string;
    project_id: string | null;
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
};

async function recomputeProjectDocumentStatus(params: {
  admin: SupabaseClient;
  projectId: string | null;
}) {
  if (!params.projectId) return;

  try {
    const { error } = await params.admin.rpc(
      'recompute_project_documents_operational_status',
      { p_project_id: params.projectId },
    );
    if (error) {
      console.error('[decisionClosure] document status recompute failed:', error.message);
    }
  } catch (error) {
    console.error('[decisionClosure] document status recompute unavailable:', error);
  }
}

async function closeLinkedWorkflowTasks(params: DecisionClosureInput & { now: string }) {
  const { error } = await params.admin
    .from('workflow_tasks')
    .update({
      status: 'resolved',
      completed_at: params.now,
      updated_at: params.now,
    })
    .eq('organization_id', params.organizationId)
    .eq('decision_id', params.decision.id)
    .in('status', ['open', 'in_progress', 'blocked']);

  if (error) {
    console.error('[decisionClosure] failed to close linked workflow tasks:', error.message);
  }
}

async function closeLinkedExecutionItems(params: {
  admin: SupabaseClient;
  organizationId: string;
  projectId: string | null;
  linkedFindingIds: string[];
  linkedActionIds: string[];
  now: string;
}) {
  if (params.linkedFindingIds.length === 0 && params.linkedActionIds.length === 0) return;

  const updates = {
    status: 'resolved',
    outcome: 'resolved',
    resolved_at: params.now,
    last_seen_at: params.now,
    updated_at: params.now,
  };

  if (params.linkedActionIds.length > 0) {
    const { error } = await params.admin
      .from('execution_items')
      .update(updates)
      .eq('organization_id', params.organizationId)
      .in('id', params.linkedActionIds);

    if (error) {
      console.error('[decisionClosure] failed to close linked execution items:', error.message);
    }
  }

  if (params.linkedFindingIds.length > 0) {
    let query = params.admin
      .from('execution_items')
      .update(updates)
      .eq('organization_id', params.organizationId)
      .eq('source_type', 'validator_finding')
      .in('source_id', params.linkedFindingIds);

    if (params.projectId) {
      query = query.eq('project_id', params.projectId);
    }

    const { error } = await query;
    if (error) {
      console.error('[decisionClosure] failed to close finding execution items:', error.message);
    }
  }
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

  const linkedFindingIds: string[] = [];
  const linkedActionIds: string[] = [];

  if (params.decision.project_id) {
    const { data: linkedFindings, error: linkedFindingsError } = await params.admin
      .from('project_validation_findings')
      .select('id, linked_action_id')
      .eq('linked_decision_id', params.decision.id)
      .eq('project_id', params.decision.project_id);

    if (linkedFindingsError) {
      console.error('[decisionClosure] failed to load linked findings:', linkedFindingsError.message);
    } else {
      for (const row of (linkedFindings ?? []) as Array<{ id: string; linked_action_id: string | null }>) {
        linkedFindingIds.push(row.id);
        if (row.linked_action_id) linkedActionIds.push(row.linked_action_id);
      }
    }

    const findingStatus = params.status === 'suppressed' ? 'dismissed' : 'resolved';
    const { error: findingCloseError } = await params.admin
      .from('project_validation_findings')
      .update({
        status: findingStatus,
        resolved_by_user_id: params.actorId,
        resolved_at: now,
        updated_at: now,
      })
      .eq('linked_decision_id', params.decision.id)
      .eq('project_id', params.decision.project_id)
      .eq('status', 'open');

    if (findingCloseError) {
      console.error('[decisionClosure] failed to close linked findings:', findingCloseError.message);
    }
  }

  await closeLinkedWorkflowTasks({ ...params, now });
  await closeLinkedExecutionItems({
    admin: params.admin,
    organizationId: params.organizationId,
    projectId: params.decision.project_id,
    linkedFindingIds,
    linkedActionIds: Array.from(new Set(linkedActionIds)),
    now,
  });
  await recomputeProjectDocumentStatus({
    admin: params.admin,
    projectId: params.decision.project_id,
  });

  if (previousStatus !== params.status) {
    const activityResult = await logActivityEvent({
      organization_id: params.organizationId,
      project_id: params.decision.project_id,
      entity_type: 'decision',
      entity_id: params.decision.id,
      event_type: 'status_changed',
      changed_by: params.actorId,
      old_value: { status: previousStatus },
      new_value: { status: params.status, operator_action: params.operatorAction ?? null },
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
    linkedFindingIds,
  };
}
