/**
 * lib/server/resolveApprovalTask.ts
 * Phase 12: Resolution lifecycle helper for approval-generated workflow tasks.
 *
 * Two resolution paths:
 *
 *   resolved          — operator has cleared the blocking issue.
 *                       Sets task closed, then re-runs executeApprovalActions()
 *                       so the project's task queue reflects the new state.
 *
 *   accepted_exception — operator accepts the risk and overrides the block.
 *                       Sets task closed with exception flag.
 *                       Does NOT recompute approval actions — the override
 *                       is the operator's deliberate decision.
 *
 * Both paths:
 *   - Set status = 'resolved'
 *   - Set resolution_state = type
 *   - Set resolved_by, resolved_at, resolution_note
 *   - Log activity event (status_changed)
 *
 * Does not throw. All errors returned in result.errors.
 */

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { executeApprovalActions } from '@/lib/server/approvalActionEngine';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ResolutionType = 'resolved' | 'accepted_exception';

export type ResolveApprovalTaskInput = {
  taskId: string;
  organizationId: string;
  resolution: ResolutionType;
  resolvedBy: string;
  note?: string | null;
};

export type ResolvedTaskRow = {
  id: string;
  status: string;
  resolution_state: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  project_id: string | null;
  task_type: string;
  title: string;
};

export type ResolveApprovalTaskResult =
  | {
      ok: true;
      task: ResolvedTaskRow;
      /** For 'resolved': outcome of re-running the approval action engine. null for accepted_exception. */
      recompute: {
        approval_status: string;
        tasks_created: number;
        tasks_updated: number;
        errors: string[];
      } | null;
    }
  | { ok: false; error: string; status: number };

// ---------------------------------------------------------------------------
// Internal — load + verify task ownership
// ---------------------------------------------------------------------------

type TaskLoadRow = {
  id: string;
  organization_id: string;
  project_id: string | null;
  status: string;
  task_type: string;
  title: string;
  resolution_state: string | null;
};

async function loadTask(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  taskId: string,
  organizationId: string,
): Promise<TaskLoadRow | null> {
  const { data, error } = await admin
    .from('workflow_tasks')
    .select('id, organization_id, project_id, status, task_type, title, resolution_state')
    .eq('id', taskId)
    .single();

  if (error || !data) return null;
  if ((data as TaskLoadRow).organization_id !== organizationId) return null;
  return data as TaskLoadRow;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Resolve an approval-generated workflow task.
 *
 * Called by:
 *   - POST /api/workflow-tasks/[id]/resolve
 *
 * Does not throw.
 */
export async function resolveApprovalTask(
  input: ResolveApprovalTaskInput,
): Promise<ResolveApprovalTaskResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: 'Server not configured', status: 503 };
  }

  // 1. Load and verify task
  const existing = await loadTask(admin, input.taskId, input.organizationId);
  if (!existing) {
    return { ok: false, error: 'Task not found', status: 404 };
  }

  // 2. Guard: already resolved tasks should not be resolved again
  //    (allow idempotent re-resolve only if resolution_state matches)
  if (existing.status === 'resolved') {
    if (existing.resolution_state === input.resolution) {
      // Idempotent — already in this resolution state, return current row
      const { data: current } = await admin
        .from('workflow_tasks')
        .select('id, status, resolution_state, resolved_by, resolved_at, resolution_note, project_id, task_type, title')
        .eq('id', input.taskId)
        .single();
      return {
        ok: true,
        task: current as ResolvedTaskRow,
        recompute: null,
      };
    }
    return {
      ok: false,
      error: `Task is already resolved with state '${existing.resolution_state}'`,
      status: 409,
    };
  }

  const now = new Date().toISOString();

  // 3. Update task: set resolution fields + status = 'resolved'
  const updates = {
    status: 'resolved',
    resolution_state: input.resolution,
    resolved_by: input.resolvedBy,
    resolved_at: now,
    resolution_note: input.note ?? null,
    completed_at: now,
    updated_at: now,
  };

  const { data: updated, error: updateError } = await admin
    .from('workflow_tasks')
    .update(updates)
    .eq('id', input.taskId)
    .eq('organization_id', input.organizationId)
    .select('id, status, resolution_state, resolved_by, resolved_at, resolution_note, project_id, task_type, title')
    .single();

  if (updateError || !updated) {
    console.error('[resolveApprovalTask] update failed:', updateError?.message);
    return {
      ok: false,
      error: updateError?.message ?? 'Update failed',
      status: 500,
    };
  }

  // 4. Log activity event
  const activityResult = await logActivityEvent({
    organization_id: input.organizationId,
    project_id: existing.project_id,
    entity_type: 'workflow_task',
    entity_id: input.taskId,
    event_type: 'status_changed',
    changed_by: input.resolvedBy,
    old_value: { status: existing.status, resolution_state: null },
    new_value: {
      status: 'resolved',
      resolution_state: input.resolution,
      resolution_note: input.note ?? null,
    },
  });

  if (!activityResult.ok) {
    // Non-fatal — log and continue
    console.error('[resolveApprovalTask] activity event failed:', activityResult.error);
  }

  const task = updated as ResolvedTaskRow;

  // 5. Post-resolution actions
  if (input.resolution === 'resolved' && existing.project_id) {
    // Re-run approval action engine so remaining tasks reflect current state.
    // This may mark the project ready if all blocking tasks are now resolved.
    const recompute = await executeApprovalActions({
      projectId: existing.project_id,
      organizationId: input.organizationId,
    });

    return {
      ok: true,
      task,
      recompute: {
        approval_status: recompute.approval_status,
        tasks_created: recompute.tasks_created,
        tasks_updated: recompute.tasks_updated,
        errors: recompute.errors,
      },
    };
  }

  // accepted_exception: no recompute — the operator's override stands
  return { ok: true, task, recompute: null };
}

// ---------------------------------------------------------------------------
// Convenience: set task status to in_review
// ---------------------------------------------------------------------------

export type MarkInReviewResult =
  | { ok: true; task: { id: string; status: string } }
  | { ok: false; error: string; status: number };

/**
 * Transition a task to in_review status.
 * Does not set resolution fields — those are only set on final resolution.
 */
export async function markApprovalTaskInReview(
  taskId: string,
  organizationId: string,
  actorId: string,
): Promise<MarkInReviewResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'Server not configured', status: 503 };

  const existing = await loadTask(admin, taskId, organizationId);
  if (!existing) return { ok: false, error: 'Task not found', status: 404 };

  if (existing.status === 'resolved') {
    return { ok: false, error: 'Task is already resolved', status: 409 };
  }
  if (existing.status === 'in_review') {
    return { ok: true, task: { id: taskId, status: 'in_review' } };
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await admin
    .from('workflow_tasks')
    .update({ status: 'in_review', updated_at: now })
    .eq('id', taskId)
    .eq('organization_id', organizationId)
    .select('id, status')
    .single();

  if (updateError || !updated) {
    return { ok: false, error: updateError?.message ?? 'Update failed', status: 500 };
  }

  await logActivityEvent({
    organization_id: organizationId,
    project_id: existing.project_id,
    entity_type: 'workflow_task',
    entity_id: taskId,
    event_type: 'status_changed',
    changed_by: actorId,
    old_value: { status: existing.status },
    new_value: { status: 'in_review' },
  });

  return { ok: true, task: updated as { id: string; status: string } };
}
