// lib/server/workflowEngine.ts
// Creates workflow tasks from decisions based on rule action_json.
//
// Production schema (public.workflow_tasks):
//   id, organization_id, decision_id, document_id, task_type, title,
//   description, status, priority, assigned_to, created_by, due_at,
//   started_at, completed_at, source, source_metadata, details,
//   created_at, updated_at, assigned_at, assigned_by
//
// Behaviors:
//   - Only creates tasks when action_json.create_task === true
//   - Deduplicates by decision_id + task_type (open/in_progress)
//   - Sets source = 'rule_engine' and source_metadata with rule context
//   - Only creates tasks for newly inserted decisions (is_new = true)

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { ActionJson } from '@/lib/types/rules';
import type { CreatedDecision } from '@/lib/server/decisionEngine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateTasksResult = {
  /** Number of new workflow_task rows inserted */
  created: number;
  /** Number of decisions skipped (existing task, no create_task, or re-detection) */
  skipped: number;
};

// ---------------------------------------------------------------------------
// Main Function
// ---------------------------------------------------------------------------

/**
 * Create workflow tasks from newly created decisions.
 *
 * Only processes decisions where is_new = true (skips re-detections that
 * already have tasks from their first detection).
 *
 * Deduplication: checks for existing open/in_progress tasks matching
 * (decision_id, task_type) before inserting.
 */
export async function createTasksFromDecisions(params: {
  organizationId: string;
  projectId?: string | null;
  decisions: CreatedDecision[];
}): Promise<CreateTasksResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { created: 0, skipped: 0 };

  const { organizationId, decisions } = params;
  if (decisions.length === 0) return { created: 0, skipped: 0 };

  // ── Filter to new decisions that request task creation ──────────────
  const needsTasks = decisions.filter(
    (d) => d.is_new && d.action_json?.create_task === true,
  );

  if (needsTasks.length === 0) {
    return { created: 0, skipped: 0 };
  }

  // ── Load existing open/in_progress tasks for dedup ──────────────────
  const decisionIds = needsTasks.map((d) => d.decision_id);

  const { data: existingTasks } = await admin
    .from('workflow_tasks')
    .select('decision_id, task_type')
    .in('decision_id', decisionIds)
    .in('status', ['open', 'in_progress']);

  const existingKeys = new Set(
    (existingTasks ?? []).map((t) => {
      const row = t as { decision_id: string; task_type: string };
      return `${row.decision_id}::${row.task_type}`;
    }),
  );

  // ── Build insert batch ──────────────────────────────────────────────
  type TaskRow = {
    organization_id: string;
    document_id: string;
    project_id: string | null;
    decision_id: string;
    task_type: string;
    title: string;
    description: string | null;
    priority: string;
    status: string;
    due_at: string | null;
    source: string;
    source_metadata: Record<string, unknown>;
  };

  const toInsert: TaskRow[] = [];
  let skipped = 0;

  for (const d of needsTasks) {
    const action = d.action_json as ActionJson;
    const taskType = action.task_type || 'general_review';
    const dedupKey = `${d.decision_id}::${taskType}`;

    if (existingKeys.has(dedupKey)) {
      skipped++;
      continue;
    }

    // Compute due_at from due_in_hours
    let dueAt: string | null = null;
    if (action.due_in_hours && action.due_in_hours > 0) {
      const due = new Date();
      due.setHours(due.getHours() + action.due_in_hours);
      dueAt = due.toISOString();
    }

    toInsert.push({
      organization_id: organizationId,
      document_id: d.document_id,
      project_id: params.projectId ?? null,
      decision_id: d.decision_id,
      task_type: taskType,
      title: formatTaskTitle(taskType, d.title),
      description: `Auto-generated from rule decision: ${d.decision_type} (${d.severity})`,
      priority: severityToPriority(d.severity),
      status: 'open',
      due_at: dueAt,
      source: 'rule_engine',
      source_metadata: {
        rule_id: d.rule_id,
        decision_id: d.decision_id,
        decision_type: d.decision_type,
        assign_to_role: action.assign_to_role ?? null,
      },
    });
  }

  if (toInsert.length === 0) {
    return { created: 0, skipped };
  }

  // ── Insert ──────────────────────────────────────────────────────────
  const { error } = await admin.from('workflow_tasks').insert(toInsert);

  if (error) {
    console.error('[workflowEngine] insert error:', error);
    return { created: 0, skipped };
  }

  return { created: toInsert.length, skipped };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map rule severity to workflow task priority. */
function severityToPriority(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'low':
      return 'low';
    default:
      return 'medium';
  }
}

/** Format a human-readable task title from task_type and rule name. */
function formatTaskTitle(taskType: string, ruleName: string): string {
  const readableType = taskType.replace(/_/g, ' ');
  return `${readableType}: ${ruleName}`;
}
