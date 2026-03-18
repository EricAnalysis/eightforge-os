'use client';

import { useCallback, useEffect, useState, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOrgMembers } from '@/lib/useOrgMembers';
import { formatDueDate } from '@/lib/dateUtils';
import { isTaskOverdue, OverdueBadge, TASK_OPEN_STATUSES } from '@/lib/overdue';
import { AGING_BUCKETS, ageBucketKey, type AgingBucketKey } from '@/lib/aging';
import { filterCurrentQueueRecords, isHistoryStatusFilter } from '@/lib/currentWork';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocumentRef = { id: string; title: string | null; name: string } | null;
type AssigneeRef = { id: string; display_name: string | null } | null;

type WorkflowTaskRow = {
  id: string;
  decision_id: string | null;
  document_id: string | null;
  task_type: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  source: string | null;
  created_at: string;
  updated_at: string;
  due_at: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  source_metadata?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  assignee: AssigneeRef | AssigneeRef[];
  documents?: DocumentRef | DocumentRef[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['open', 'in_progress', 'blocked', 'resolved', 'cancelled'] as const;
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'] as const;

function PriorityBadge({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    medium: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
    low: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[priority] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>
      {priority}
    </span>
  );
}

function titleize(s: string): string {
  return s
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function resolveAssignee(ref: AssigneeRef | AssigneeRef[]): AssigneeRef {
  return Array.isArray(ref) ? ref[0] ?? null : ref;
}

function docLabel(row: WorkflowTaskRow): string {
  const doc = row.documents;
  const ref = Array.isArray(doc) ? doc?.[0] : doc;
  return ref?.title ?? ref?.name ?? 'View document';
}

// ─── Status select color — makes the inline-edit control reflect current state ─

function getStatusSelectCls(status: string): string {
  const map: Record<string, string> = {
    open: 'border-amber-500/40 text-amber-400',
    in_progress: 'border-blue-500/40 text-blue-400',
    blocked: 'border-red-500/40 text-red-400 font-semibold',
    resolved: 'border-emerald-500/40 text-emerald-400',
    cancelled: 'border-[#1A1A3E] text-[#8B94A3]',
  };
  return map[status] ?? 'border-[#1A1A3E] text-[#8B94A3]';
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkflowsPage() {
  const router = useRouter();
  const { organization, userId, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const { members } = useOrgMembers(organizationId);
  const searchParams = useSearchParams();

  const [tasks, setTasks] = useState<WorkflowTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>(searchParams.get('status') ?? '');
  const [filterPriority, setFilterPriority] = useState<string>(searchParams.get('priority') ?? '');
  const [filterAssigned, setFilterAssigned] = useState<string>(searchParams.get('assigned') ?? '');
  const [filterDue, setFilterDue] = useState<string>(searchParams.get('due') ?? '');
  const [filterAge, setFilterAge] = useState<string>(searchParams.get('age') ?? '');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updateErrorId, setUpdateErrorId] = useState<string | null>(null);
  const includeHistory =
    searchParams.get('history') === '1' ||
    isHistoryStatusFilter(filterStatus, TASK_OPEN_STATUSES);

  const fetchTasks = useCallback(async (orgId: string) => {
    setLoading(true);
    setListError(null);
    let query = supabase
      .from('workflow_tasks')
      .select('id, decision_id, document_id, task_type, title, description, priority, status, source, source_metadata, details, created_at, updated_at, due_at, completed_at, assigned_to, assigned_at, assignee:user_profiles!assigned_to(id, display_name), documents(id, title, name)')
      .eq('organization_id', orgId)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });
    if (filterStatus) query = query.eq('status', filterStatus);
    else query = query.in('status', [...TASK_OPEN_STATUSES]);
    const { data, error } = await query;
    if (error) {
      setListError('Failed to load workflow tasks.');
      setTasks([]);
    } else {
      const rows = (data as WorkflowTaskRow[]) ?? [];
      setTasks(includeHistory ? rows : filterCurrentQueueRecords(rows));
    }
    setLoading(false);
  }, [filterStatus, includeHistory]);

  useEffect(() => {
    if (orgLoading || !organizationId) {
      if (!orgLoading) setLoading(false);
      return;
    }
    fetchTasks(organizationId);
  }, [fetchTasks, organizationId, orgLoading]);

  const filteredTasks = useMemo(() => {
    let list = tasks;
    if (filterStatus) list = list.filter((t) => t.status === filterStatus);
    if (filterPriority) list = list.filter((t) => t.priority === filterPriority);
    if (filterAssigned === '__unassigned') list = list.filter((t) => !t.assigned_to);
    else if (filterAssigned === '__me' && userId) list = list.filter((t) => t.assigned_to === userId);
    else if (filterAssigned && filterAssigned !== '__me') list = list.filter((t) => t.assigned_to === filterAssigned);
    if (filterDue === '__overdue') list = list.filter((t) => isTaskOverdue(t.due_at, t.status));
    else if (filterDue === '__my_overdue') list = list.filter((t) => t.assigned_to === userId && isTaskOverdue(t.due_at, t.status));
    else if (filterDue === '__no_due') list = list.filter((t) => !t.due_at);
    if (filterAge && AGING_BUCKETS.some((b) => b.key === filterAge)) {
      list = list.filter((t) =>
        TASK_OPEN_STATUSES.includes(t.status) && ageBucketKey(t.created_at) === filterAge as AgingBucketKey,
      );
    }
    return list;
  }, [tasks, filterStatus, filterPriority, filterAssigned, filterDue, filterAge, userId]);

  // Scan summary counts for the current filter results
  const scanSummary = useMemo(() => {
    const blocked = filteredTasks.filter((t) => t.status === 'blocked').length;
    const overdue = filteredTasks.filter((t) => isTaskOverdue(t.due_at, t.status)).length;
    const criticalHigh = filteredTasks.filter((t) => t.priority === 'critical' || t.priority === 'high').length;
    const unassignedCrit = filteredTasks.filter(
      (t) => !t.assigned_to && (t.priority === 'critical' || t.priority === 'high'),
    ).length;
    return { blocked, overdue, criticalHigh, unassignedCrit };
  }, [filteredTasks]);

  const updateStatus = async (taskId: string, newStatus: string) => {
    if (!organizationId) return;
    setUpdateErrorId(null);
    setUpdatingId(taskId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setUpdateErrorId(taskId);
        return;
      }
      const res = await fetch(`/api/workflow-tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      if (redirectIfUnauthorized(res, router.replace)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUpdateErrorId(taskId);
        return;
      }
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: (data.status ?? newStatus) as string, updated_at: data.updated_at ?? t.updated_at } : t))
      );
      setUpdateErrorId(null);
    } finally {
      setUpdatingId(null);
    }
  };

  const displayCreated = (row: WorkflowTaskRow) =>
    row.created_at ? new Date(row.created_at).toLocaleString() : '—';

  const isLoading = orgLoading || loading;
  const hasActiveFilter = !!(filterStatus || filterPriority || filterAssigned || filterDue || filterAge);

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Workflow Tasks</h2>
          <p className="text-xs text-[#8B94A3]">
            Review, prioritize, and resolve tasks created by the decision engine.
          </p>
        </div>
      </section>

      {/* Filters */}
      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Status</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">Current</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Priority</span>
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Assigned</span>
          <select
            value={filterAssigned}
            onChange={(e) => setFilterAssigned(e.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            <option value="__me">Assigned to me</option>
            <option value="__unassigned">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.display_name ?? m.id.slice(0, 8)}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Due date</span>
          <select
            value={filterDue}
            onChange={(e) => setFilterDue(e.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            <option value="__overdue">Overdue</option>
            <option value="__my_overdue">My overdue</option>
            <option value="__no_due">No due date</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Age</span>
          <select
            value={filterAge}
            onChange={(e) => setFilterAge(e.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            {AGING_BUCKETS.map((b) => (
              <option key={b.key} value={b.key}>{b.label}</option>
            ))}
          </select>
        </label>
        {hasActiveFilter && (
          <button
            type="button"
            onClick={() => {
              setFilterStatus('');
              setFilterPriority('');
              setFilterAssigned('');
              setFilterDue('');
              setFilterAge('');
            }}
            className="rounded-md border border-[#1A1A3E] px-2 py-1.5 text-[11px] text-[#8B94A3] hover:bg-[#1A1A3E] hover:text-[#F5F7FA]"
          >
            Clear filters
          </button>
        )}
      </section>

      {/* Table */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">

        {listError && (
          <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] font-medium text-red-400">{listError}</p>
          </div>
        )}

        {/* Scan summary bar — instant health snapshot before reading the table */}
        {!isLoading && filteredTasks.length > 0 && (
          <div className="mb-3 flex items-center gap-4 border-b border-[#1A1A3E] pb-3 flex-wrap">
            <span className="text-[11px] font-semibold text-[#F5F7FA]">
              {filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}
            </span>
            {scanSummary.blocked > 0 && (
              <span className="text-[11px] font-medium text-red-400">
                {scanSummary.blocked} blocked
              </span>
            )}
            {scanSummary.overdue > 0 && (
              <span className="text-[11px] font-medium text-red-400">
                {scanSummary.overdue} overdue
              </span>
            )}
            {scanSummary.criticalHigh > 0 && (
              <span className="text-[11px] font-medium text-amber-400">
                {scanSummary.criticalHigh} critical / high
              </span>
            )}
            {scanSummary.unassignedCrit > 0 && (
              <span className="text-[11px] font-medium text-amber-400">
                {scanSummary.unassignedCrit} unassigned critical
              </span>
            )}
          </div>
        )}

        {isLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : filteredTasks.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No workflow tasks yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            {/* Column order: signal → state → identity → urgency → owner → context */}
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Priority</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Status</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Title</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Due</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Assigned</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Task type</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Decision</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Document</th>
                  <th className="pb-2 font-medium text-[#8B94A3]">Created</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((row) => {
                  const isCritHigh = row.priority === 'critical' || row.priority === 'high';
                  const isBlocked = row.status === 'blocked';
                  const assignee = resolveAssignee(row.assignee);
                  const overdue = isTaskOverdue(row.due_at, row.status);
                  const rowBg = isBlocked
                    ? 'bg-red-500/[0.07]'
                    : isCritHigh
                      ? 'bg-red-500/[0.03]'
                      : '';
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-[#1A1A3E] last:border-0 transition-colors hover:bg-[#12122E] ${rowBg}`}
                    >
                      {/* Priority — visual signal column */}
                      <td className="py-2.5 pr-3">
                        <PriorityBadge priority={row.priority} />
                      </td>

                      {/* Status — inline editable, styled to reflect current state */}
                      <td className="py-2.5 pr-3">
                        <div className="flex flex-col gap-1">
                          <select
                            aria-label={`Update status for ${row.title || 'task'}`}
                            value={STATUS_OPTIONS.includes(row.status as (typeof STATUS_OPTIONS)[number]) ? row.status : STATUS_OPTIONS[0]}
                            onChange={(e) => updateStatus(row.id, e.target.value)}
                            disabled={updatingId === row.id}
                            className={`rounded border bg-[#0A0A20] px-2 py-1 text-[11px] outline-none focus:border-[#8B5CFF] disabled:opacity-60 ${getStatusSelectCls(row.status)}`}
                          >
                            {STATUS_OPTIONS.map((s) => (
                              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                            ))}
                          </select>
                          {updatingId === row.id && (
                            <span className="text-[10px] text-[#8B94A3]">Updating…</span>
                          )}
                          {updateErrorId === row.id && (
                            <span className="text-[10px] text-red-400">Update failed</span>
                          )}
                        </div>
                      </td>

                      {/* Title — identity */}
                      <td className="py-2.5 pr-3 max-w-[220px] truncate" title={row.title}>
                        <Link
                          href={`/platform/workflows/${row.id}`}
                          className="font-medium text-[#8B5CFF] hover:underline"
                        >
                          {row.title || '—'}
                        </Link>
                      </td>

                      {/* Due — urgency with red color when overdue */}
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {row.due_at ? (
                          <span className={`flex items-center gap-1.5 ${overdue ? 'font-medium text-red-400' : 'text-[#8B94A3]'}`}>
                            <span>{formatDueDate(row.due_at)}</span>
                            {overdue && <OverdueBadge />}
                          </span>
                        ) : (
                          <span className="text-[#3a3f5a]">—</span>
                        )}
                      </td>

                      {/* Assigned — amber if critical/high and unassigned */}
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {assignee ? (
                          <span className="text-[#F5F7FA]">{assignee.display_name ?? row.assigned_to?.slice(0, 8)}</span>
                        ) : (
                          <span className={isCritHigh ? 'font-medium text-amber-400' : 'text-[#8B94A3]'}>
                            Unassigned
                          </span>
                        )}
                      </td>

                      {/* Task type — context */}
                      <td className="py-2.5 pr-3 text-[#8B94A3]">
                        {titleize(row.task_type)}
                      </td>

                      {/* Decision — traceability */}
                      <td className="py-2.5 pr-3">
                        {row.decision_id ? (
                          <Link
                            href={`/platform/decisions/${row.decision_id}`}
                            className="text-[#8B5CFF] hover:underline"
                          >
                            View decision
                          </Link>
                        ) : (
                          <span className="text-[#3a3f5a]">—</span>
                        )}
                      </td>

                      {/* Document — context */}
                      <td className="py-2.5 pr-3 max-w-[160px] truncate">
                        {row.document_id ? (
                          <Link
                            href={`/platform/documents/${row.document_id}`}
                            className="text-[#8B5CFF] hover:underline"
                            title={docLabel(row)}
                          >
                            {docLabel(row)}
                          </Link>
                        ) : (
                          <span className="text-[#3a3f5a]">—</span>
                        )}
                      </td>

                      {/* Created — age reference */}
                      <td className="py-2.5 whitespace-nowrap text-[#8B94A3]">
                        {displayCreated(row)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
