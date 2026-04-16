// lib/server/workflows/processWorkflowTriggers.ts
// Evaluates hard-coded business rules after a mutation + activity event.
// Called synchronously at the end of an API route — no background jobs.

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { upsertWorkflowTask } from '@/lib/server/workflows/upsertWorkflowTask';

export type WorkflowTriggerInput = {
  organizationId: string;
  eventType: string;
  entityType: 'decision' | 'workflow_task';
  entityId: string;
  payload: Record<string, unknown>;
};

export type TriggerResult = {
  rulesEvaluated: string[];
  tasksCreated: string[];
  errors: string[];
};

// ---------------------------------------------------------------------------
// Rule 1 — Critical decision opened → escalation task
// ---------------------------------------------------------------------------
async function ruleEscalateOpenCritical(
  input: WorkflowTriggerInput,
  result: TriggerResult,
): Promise<void> {
  if (input.entityType !== 'decision') return;
  if (input.eventType !== 'status_changed') return;

  const toStatus = input.payload.to as string | undefined;
  const severity = input.payload.severity as string | undefined;
  if (toStatus !== 'open' || severity !== 'critical') return;

  result.rulesEvaluated.push('escalate_open_critical');

  const res = await upsertWorkflowTask({
    organization_id: input.organizationId,
    related_entity_type: 'decision',
    related_entity_id: input.entityId,
    task_type: 'escalation',
    title: `Escalation: critical decision opened`,
    description: `Decision ${input.entityId} was marked open with critical severity.`,
    priority: 'critical',
  });

  if (res.ok) {
    result.tasksCreated.push(res.task_id);
  } else {
    result.errors.push(`escalate_open_critical: ${res.error}`);
  }
}

// ---------------------------------------------------------------------------
// Rule 2 — Decision reassigned → follow-up task for new assignee
// ---------------------------------------------------------------------------
async function ruleFollowUpOnReassign(
  input: WorkflowTriggerInput,
  result: TriggerResult,
): Promise<void> {
  if (input.entityType !== 'decision') return;
  if (input.eventType !== 'assignment_changed') return;

  const newAssignee = input.payload.to as string | undefined;
  if (!newAssignee) return;

  result.rulesEvaluated.push('follow_up_on_reassign');

  const res = await upsertWorkflowTask({
    organization_id: input.organizationId,
    related_entity_type: 'decision',
    related_entity_id: input.entityId,
    task_type: 'follow_up',
    title: `Follow up: decision assigned`,
    description: `Decision ${input.entityId} was assigned to ${newAssignee}.`,
    assigned_to: newAssignee,
    priority: 'medium',
  });

  if (res.ok) {
    result.tasksCreated.push(res.task_id);
  } else {
    result.errors.push(`follow_up_on_reassign: ${res.error}`);
  }
}

// ---------------------------------------------------------------------------
// Rule 3 — Decision due_date changed → activity only (no task)
// ---------------------------------------------------------------------------
function ruleDueDateChanged(
  input: WorkflowTriggerInput,
  result: TriggerResult,
): void {
  if (input.entityType !== 'decision') return;
  if (input.eventType !== 'due_date_changed') return;

  result.rulesEvaluated.push('due_date_changed_noop');
  // Activity event already logged by the calling route — nothing else for now.
}

// ---------------------------------------------------------------------------
// Rule 4 — Workflow task completed → stub for decision advancement
// ---------------------------------------------------------------------------
async function ruleTaskCompletedAdvance(
  input: WorkflowTriggerInput,
  result: TriggerResult,
): Promise<void> {
  if (input.entityType !== 'workflow_task') return;
  if (input.eventType !== 'status_changed') return;

  const toStatus = input.payload.to as string | undefined;
  if (toStatus !== 'resolved') return;

  result.rulesEvaluated.push('task_completed_advance');

  // Stub: load the related decision and check whether all sibling tasks are
  // complete. If so, the decision could be auto-advanced. Full logic deferred.
  const admin = getSupabaseAdmin();
  if (!admin) return;

  const relatedDecisionId = input.payload.related_decision_id as string | undefined;
  if (!relatedDecisionId) return;

  const { data: openTasks } = await admin
    .from('workflow_tasks')
    .select('id')
    .eq('organization_id', input.organizationId)
    .eq('decision_id', relatedDecisionId)
    .in('status', ['open', 'in_progress', 'blocked'])
    .limit(1);

  if (!openTasks || openTasks.length === 0) {
    // All tasks resolved — placeholder for auto-advancing the decision.
    console.info(
      `[processWorkflowTriggers] All tasks for decision ${relatedDecisionId} resolved. Auto-advance ready for implementation.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 5 — Document extraction with high-confidence issue → stub
// ---------------------------------------------------------------------------
// NOTE: This rule cannot fire yet because the DB entity_type CHECK constraint
// only allows 'decision' and 'workflow_task'. When document-level events are
// added to the schema, this stub can be reactivated by updating the CHECK
// constraint and the WorkflowTriggerInput type.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs all registered business rules against the provided event.
 * Call after a successful mutation + activity event insert.
 * Does not throw — collects errors in the result object.
 */
export async function processWorkflowTriggers(
  input: WorkflowTriggerInput,
): Promise<TriggerResult> {
  const result: TriggerResult = {
    rulesEvaluated: [],
    tasksCreated: [],
    errors: [],
  };

  await ruleEscalateOpenCritical(input, result);
  await ruleFollowUpOnReassign(input, result);
  ruleDueDateChanged(input, result);
  await ruleTaskCompletedAdvance(input, result);

  if (result.errors.length > 0) {
    console.error('[processWorkflowTriggers] errors:', result.errors);
  }

  return result;
}
