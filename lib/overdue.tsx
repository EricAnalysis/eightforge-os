/**
 * Shared overdue logic, open-status constants, and OverdueBadge component.
 *
 * Single source of truth for what constitutes an "open" status and when
 * a decision or workflow task is considered overdue.
 */

export const DECISION_OPEN_STATUSES: readonly string[] = ['open', 'in_review'];
export const TASK_OPEN_STATUSES: readonly string[] = ['open', 'in_progress', 'blocked'];

export function isDecisionOverdue(dueAt: string | null, status: string): boolean {
  if (!dueAt) return false;
  if (!DECISION_OPEN_STATUSES.includes(status)) return false;
  return new Date(dueAt) < new Date();
}

export function isTaskOverdue(dueAt: string | null, status: string): boolean {
  if (!dueAt) return false;
  if (!TASK_OPEN_STATUSES.includes(status)) return false;
  return new Date(dueAt) < new Date();
}

export function OverdueBadge() {
  return (
    <span className="inline-block rounded px-2 py-0.5 text-[11px] font-medium bg-red-500/15 text-red-400 border border-red-500/30">
      overdue
    </span>
  );
}
