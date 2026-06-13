/**
 * lib/server/approvalActionHistory.ts
 * Phase 11: Query helper for the approval action execution log.
 *
 * Reads approval_action_log entries for a project and groups them by
 * execution batch so the UI can render a clear timeline:
 *   "At 14:22, approval status was BLOCKED → 3 tasks created."
 *
 * Grouping heuristic: entries within BATCH_WINDOW_SECONDS of each other
 * that share the same approval_status belong to one execution run.
 * executeApprovalActions() runs synchronously, so all log entries from
 * a single call land within a second or two of each other.
 */

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApprovalActionLogEntry = {
  id: string;
  approval_status: string;
  action_type: string;
  invoice_number: string | null;
  /** Amount in cents. Null when not applicable. */
  amount: number | null;
  reason: string | null;
  priority: string;
  task_id: string | null;
  task_outcome: 'created' | 'updated' | 'failed';
  error: string | null;
  executed_at: string;
};

export type ApprovalExecutionGroup = {
  /** ISO timestamp of the first entry in this batch (newest-first ordering). */
  batch_timestamp: string;
  /** Approval status that triggered this execution run. */
  approval_status: string;
  /** All actions executed in this batch, newest first. */
  actions: ApprovalActionLogEntry[];
  tasks_created: number;
  tasks_updated: number;
  failures: number;
};

export type ApprovalActionHistoryResult = {
  project_id: string;
  /** Execution groups, newest first. */
  executions: ApprovalExecutionGroup[];
  /** Total raw log entries fetched (before grouping). */
  total_actions: number;
};

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

type ActionLogRow = {
  id: string;
  approval_status: string;
  action_type: string;
  invoice_number: string | null;
  amount: number | null;
  reason: string | null;
  priority: string;
  task_id: string | null;
  task_outcome: string;
  error: string | null;
  executed_at: string;
};

/**
 * Maximum seconds between consecutive log entries that still belong to
 * the same execution run. Generous to handle slow DB round-trips.
 */
const BATCH_WINDOW_SECONDS = 30;

function buildGroup(rows: ActionLogRow[]): ApprovalExecutionGroup {
  const actions: ApprovalActionLogEntry[] = rows.map((r) => ({
    id: r.id,
    approval_status: r.approval_status,
    action_type: r.action_type,
    invoice_number: r.invoice_number,
    amount: r.amount,
    reason: r.reason,
    priority: r.priority,
    task_id: r.task_id,
    task_outcome: r.task_outcome as 'created' | 'updated' | 'failed',
    error: r.error,
    executed_at: r.executed_at,
  }));

  return {
    batch_timestamp: rows[0].executed_at,
    approval_status: rows[0].approval_status,
    actions,
    tasks_created: actions.filter((a) => a.task_outcome === 'created').length,
    tasks_updated: actions.filter((a) => a.task_outcome === 'updated').length,
    failures: actions.filter((a) => a.task_outcome === 'failed').length,
  };
}

/**
 * Group a flat list of log rows (newest-first) into execution batches.
 * Exported for unit testing.
 */
export function groupIntoBatches(rows: ActionLogRow[]): ApprovalExecutionGroup[] {
  if (rows.length === 0) return [];

  const batches: ApprovalExecutionGroup[] = [];
  let current: ActionLogRow[] = [rows[0]];

  for (let i = 1; i < rows.length; i++) {
    const prevMs = new Date(rows[i - 1].executed_at).getTime();
    const currMs = new Date(rows[i].executed_at).getTime();
    const diffSeconds = Math.abs(prevMs - currMs) / 1000;
    const sameStatus = rows[i].approval_status === current[0].approval_status;

    if (diffSeconds <= BATCH_WINDOW_SECONDS && sameStatus) {
      current.push(rows[i]);
    } else {
      batches.push(buildGroup(current));
      current = [rows[i]];
    }
  }

  batches.push(buildGroup(current));
  return batches;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Retrieve and group approval action execution history for a project.
 * Returns up to maxExecutions batches ordered newest-first.
 *
 * Does not throw. Returns empty result on any error.
 */
export async function getApprovalActionHistory(
  projectId: string,
  maxExecutions: number = 10,
): Promise<ApprovalActionHistoryResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { project_id: projectId, executions: [], total_actions: 0 };
  }

  // Fetch enough rows to fill maxExecutions groups.
  // Worst case: 7 actions per execution (3 per-invoice + flag + notify, etc.)
  const fetchLimit = maxExecutions * 10;

  const { data, error } = await admin
    .from('approval_action_log')
    .select(
      'id, approval_status, action_type, invoice_number, amount, reason, priority, task_id, task_outcome, error, executed_at',
    )
    .eq('project_id', projectId)
    .order('executed_at', { ascending: false })
    .limit(fetchLimit);

  if (error || !data) {
    console.error('[approvalActionHistory] query failed:', error?.message);
    return { project_id: projectId, executions: [], total_actions: 0 };
  }

  const rows = data as ActionLogRow[];
  const allGroups = groupIntoBatches(rows);

  return {
    project_id: projectId,
    executions: allGroups.slice(0, maxExecutions),
    total_actions: rows.length,
  };
}
