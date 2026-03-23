'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AGING_BUCKETS, ageBucketKey, type AgingBucketKey } from '@/lib/aging';
import { formatDueDate } from '@/lib/dateUtils';
import { isHistoryStatusFilter } from '@/lib/currentWork';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOperationalModel } from '@/lib/useOperationalModel';
import { useOrgMembers } from '@/lib/useOrgMembers';
import { OverdueBadge, TASK_OPEN_STATUSES, isTaskOverdue } from '@/lib/overdue';
import type { OperationalActionQueueItem } from '@/lib/server/operationalQueue';

type DocumentRef = { id: string; title: string | null; name: string } | null;
type AssigneeRef = { id: string; display_name: string | null } | null;

type HistoryTaskRow = {
  id: string;
  decision_id: string | null;
  document_id: string | null;
  task_type: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  created_at: string;
  due_at: string | null;
  assigned_to: string | null;
  assignee: AssigneeRef | AssigneeRef[];
  documents?: DocumentRef | DocumentRef[];
};

type ActionListItem = {
  id: string;
  taskId: string | null;
  decisionId: string | null;
  documentId: string | null;
  taskType: string;
  title: string;
  summary: string;
  instructions: string;
  priority: string;
  status: string;
  dueAt: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  projectLabel: string | null;
  sourceDocumentTitle: string | null;
  sourceDocumentType: string | null;
  sourceDocumentTarget: string | null;
  deepLinkTarget: string;
  createdAt: string;
  kind: 'history' | OperationalActionQueueItem['kind'];
  blocked: boolean;
  overdue: boolean;
  isUrgentUnassigned: boolean;
  isVague: boolean;
};

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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: 'border-amber-500/40 text-amber-400',
    in_progress: 'border-blue-500/40 text-blue-400',
    blocked: 'border-red-500/40 text-red-400',
    resolved: 'border-emerald-500/40 text-emerald-400',
    cancelled: 'border-[#1A1A3E] text-[#8B94A3]',
  };
  const cls = map[status] ?? 'border-[#1A1A3E] text-[#8B94A3]';
  return (
    <span className={`inline-flex rounded border bg-[#0A0A20] px-2 py-1 text-[11px] ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function resolveAssignee(ref: AssigneeRef | AssigneeRef[]): AssigneeRef {
  return Array.isArray(ref) ? ref[0] ?? null : ref;
}

function isVagueDescription(title: string | null | undefined, description?: string | null): boolean {
  const titleValue = title?.trim().toLowerCase() ?? '';
  const descriptionValue = description?.trim().toLowerCase() ?? '';
  return (
    (!titleValue || titleValue.length <= 18 || titleValue.includes('manual review')) &&
    (!descriptionValue || descriptionValue.length <= 18 || descriptionValue.includes('follow up'))
  );
}

function mapHistoryTask(row: HistoryTaskRow): ActionListItem {
  const documentRef = Array.isArray(row.documents) ? row.documents[0] ?? null : row.documents ?? null;
  return {
    id: row.id,
    taskId: row.id,
    decisionId: row.decision_id,
    documentId: row.document_id,
    taskType: row.task_type,
    title: row.title,
    summary: row.description ?? row.title,
    instructions: row.description ?? row.title,
    priority: row.priority,
    status: row.status,
    dueAt: row.due_at,
    assignedTo: row.assigned_to,
    assignedName: resolveAssignee(row.assignee)?.display_name ?? null,
    projectLabel: null,
    sourceDocumentTitle: documentRef?.title ?? documentRef?.name ?? null,
    sourceDocumentType: null,
    sourceDocumentTarget: row.document_id ? `/platform/documents/${row.document_id}` : null,
    deepLinkTarget: `/platform/workflows/${row.id}`,
    createdAt: row.created_at,
    kind: 'history',
    blocked: row.status === 'blocked',
    overdue: isTaskOverdue(row.due_at, row.status),
    isUrgentUnassigned: !row.assigned_to && (row.priority === 'critical' || row.priority === 'high'),
    isVague: isVagueDescription(row.title, row.description),
  };
}

function mapOperationalTask(item: OperationalActionQueueItem): ActionListItem {
  return {
    id: item.id,
    taskId: item.task_id,
    decisionId: item.decision_id,
    documentId: item.document_id,
    taskType: item.kind,
    title: item.title,
    summary: item.summary,
    instructions: item.instructions,
    priority: item.priority,
    status: item.status,
    dueAt: item.due_at,
    assignedTo: item.assigned_to,
    assignedName: item.assigned_to_name,
    projectLabel: item.project_label,
    sourceDocumentTitle: item.source_document_title,
    sourceDocumentType: item.source_document_type,
    sourceDocumentTarget: item.source_document_target,
    deepLinkTarget: item.deep_link_target,
    createdAt: item.created_at,
    kind: item.kind,
    blocked: item.blocked,
    overdue: item.is_overdue,
    isUrgentUnassigned: item.is_urgent_unassigned,
    isVague: item.is_vague,
  };
}

export default function WorkflowsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { organization, userId, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const { members } = useOrgMembers(organizationId);
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
  const { data: operationalModel, loading: operationalLoading, error: operationalError, reload } =
    useOperationalModel(!orgLoading && !!organizationId && !includeHistory);

  const [historyTasks, setHistoryTasks] = useState<HistoryTaskRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const fetchHistoryTasks = useCallback(async (orgId: string) => {
    setHistoryLoading(true);
    setHistoryError(null);

    let query = supabase
      .from('workflow_tasks')
      .select('id, decision_id, document_id, task_type, title, description, priority, status, created_at, due_at, assigned_to, assignee:user_profiles!assigned_to(id, display_name), documents(id, title, name)')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });

    if (filterStatus) query = query.eq('status', filterStatus);
    if (filterPriority) query = query.eq('priority', filterPriority);
    if (filterAssigned === '__unassigned') query = query.is('assigned_to', null);
    else if (filterAssigned === '__me' && userId) query = query.eq('assigned_to', userId);
    else if (filterAssigned && filterAssigned !== '__me') query = query.eq('assigned_to', filterAssigned);

    const { data, error } = await query;
    if (error) {
      setHistoryError('Failed to load actions.');
      setHistoryTasks([]);
    } else {
      setHistoryTasks((data as HistoryTaskRow[]) ?? []);
    }
    setHistoryLoading(false);
  }, [filterAssigned, filterPriority, filterStatus, userId]);

  useEffect(() => {
    if (!includeHistory || orgLoading || !organizationId) {
      if (!includeHistory) {
        setHistoryTasks([]);
        setHistoryLoading(false);
        setHistoryError(null);
      }
      return;
    }

    fetchHistoryTasks(organizationId);
  }, [fetchHistoryTasks, includeHistory, organizationId, orgLoading]);

  const updateTaskStatus = useCallback(async (taskId: string, status: string) => {
    setUpdatingId(taskId);
    setUpdateErrorId(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setUpdateErrorId(taskId);
        return;
      }

      const response = await fetch(`/api/workflow-tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status }),
      });

      if (redirectIfUnauthorized(response, router.replace)) return;
      if (!response.ok) {
        setUpdateErrorId(taskId);
        return;
      }

      if (includeHistory && organizationId) {
        await fetchHistoryTasks(organizationId);
      } else {
        await reload();
      }
    } finally {
      setUpdatingId(null);
    }
  }, [fetchHistoryTasks, includeHistory, organizationId, reload, router]);

  const actionItems = useMemo(() => {
    if (includeHistory) return historyTasks.map(mapHistoryTask);
    return (operationalModel?.actions ?? []).map(mapOperationalTask);
  }, [historyTasks, includeHistory, operationalModel?.actions]);

  const filteredTasks = useMemo(() => {
    let list = actionItems;

    if (!includeHistory && filterStatus) list = list.filter((item) => item.status === filterStatus);
    if (filterPriority) list = list.filter((item) => item.priority === filterPriority);
    if (filterAssigned === '__unassigned') list = list.filter((item) => !item.assignedTo);
    else if (filterAssigned === '__me' && userId) list = list.filter((item) => item.assignedTo === userId);
    else if (filterAssigned && filterAssigned !== '__me') list = list.filter((item) => item.assignedTo === filterAssigned);
    if (filterDue === '__overdue') list = list.filter((item) => item.overdue);
    else if (filterDue === '__my_overdue') list = list.filter((item) => item.assignedTo === userId && item.overdue);
    else if (filterDue === '__no_due') list = list.filter((item) => !item.dueAt);
    if (filterAge && AGING_BUCKETS.some((bucket) => bucket.key === filterAge)) {
      list = list.filter((item) =>
        TASK_OPEN_STATUSES.includes(item.status) &&
        ageBucketKey(item.createdAt) === (filterAge as AgingBucketKey),
      );
    }

    return list;
  }, [actionItems, filterAge, filterAssigned, filterDue, filterPriority, filterStatus, includeHistory, userId]);

  const scanSummary = useMemo(() => {
    const blocked = filteredTasks.filter((item) => item.blocked).length;
    const overdue = filteredTasks.filter((item) => item.overdue).length;
    const criticalHigh = filteredTasks.filter((item) => item.priority === 'critical' || item.priority === 'high').length;
    const unassignedCrit = filteredTasks.filter(
      (item) => !item.assignedTo && (item.priority === 'critical' || item.priority === 'high'),
    ).length;
    return { blocked, overdue, criticalHigh, unassignedCrit };
  }, [filteredTasks]);

  const isLoading = orgLoading || (includeHistory ? historyLoading : operationalLoading);
  const listError = includeHistory ? historyError : operationalError;
  const hasActiveFilter = !!(filterStatus || filterPriority || filterAssigned || filterDue || filterAge);

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">My Actions</h2>
          <p className="text-xs text-[#8B94A3]">
            Shared operational actions from persisted workflow tasks and unresolved document next steps.
          </p>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Status</span>
          <select
            value={filterStatus}
            onChange={(event) => setFilterStatus(event.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">{includeHistory ? 'History' : 'Current'}</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Priority</span>
          <select
            value={filterPriority}
            onChange={(event) => setFilterPriority(event.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            {PRIORITY_OPTIONS.map((priority) => (
              <option key={priority} value={priority}>{priority}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Assigned</span>
          <select
            value={filterAssigned}
            onChange={(event) => setFilterAssigned(event.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            <option value="__me">Assigned to me</option>
            <option value="__unassigned">Unassigned</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>{member.display_name ?? member.id.slice(0, 8)}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Due date</span>
          <select
            value={filterDue}
            onChange={(event) => setFilterDue(event.target.value)}
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
            onChange={(event) => setFilterAge(event.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            {AGING_BUCKETS.map((bucket) => (
              <option key={bucket.key} value={bucket.key}>{bucket.label}</option>
            ))}
          </select>
        </label>
        {hasActiveFilter ? (
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
        ) : null}
      </section>

      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        {listError ? (
          <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] font-medium text-red-400">{listError}</p>
          </div>
        ) : null}

        {!isLoading && filteredTasks.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-4 border-b border-[#1A1A3E] pb-3">
            <span className="text-[11px] font-semibold text-[#F5F7FA]">
              {filteredTasks.length} action{filteredTasks.length !== 1 ? 's' : ''}
            </span>
            {scanSummary.blocked > 0 ? <span className="text-[11px] font-medium text-red-400">{scanSummary.blocked} blocked</span> : null}
            {scanSummary.overdue > 0 ? <span className="text-[11px] font-medium text-red-400">{scanSummary.overdue} overdue</span> : null}
            {scanSummary.criticalHigh > 0 ? <span className="text-[11px] font-medium text-amber-400">{scanSummary.criticalHigh} critical / high</span> : null}
            {scanSummary.unassignedCrit > 0 ? <span className="text-[11px] font-medium text-amber-400">{scanSummary.unassignedCrit} unassigned critical</span> : null}
          </div>
        ) : null}

        {isLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : filteredTasks.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            {includeHistory
              ? 'No actions matched this history view.'
              : 'No unresolved actions are currently waiting in the shared operational queue.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Priority</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Status</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Title</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Due</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Assigned</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Source</th>
                  <th className="pb-2 font-medium text-[#8B94A3]">Created</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((item) => (
                  <tr
                    key={item.id}
                    className={`border-b border-[#1A1A3E] last:border-0 transition-colors hover:bg-[#12122E] ${item.blocked ? 'bg-red-500/[0.07]' : item.priority === 'critical' || item.priority === 'high' ? 'bg-red-500/[0.03]' : ''}`}
                  >
                    <td className="py-2.5 pr-3">
                      <PriorityBadge priority={item.priority} />
                    </td>
                    <td className="py-2.5 pr-3">
                      {item.taskId ? (
                        <div className="flex flex-col gap-1">
                          <select
                            aria-label={`Update status for ${item.title}`}
                            value={item.status}
                            onChange={(event) => updateTaskStatus(item.taskId as string, event.target.value)}
                            disabled={updatingId === item.id}
                            className="rounded border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF] disabled:opacity-60"
                          >
                            {STATUS_OPTIONS.map((status) => (
                              <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>
                            ))}
                          </select>
                          {updateErrorId === item.id ? <span className="text-[10px] text-red-400">Update failed</span> : null}
                        </div>
                      ) : (
                        <StatusBadge status={item.status} />
                      )}
                    </td>
                    <td className="max-w-[280px] py-2.5 pr-3">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={item.deepLinkTarget} className="font-medium text-[#8B5CFF] hover:underline">
                            {item.title}
                          </Link>
                          {item.projectLabel ? <span className="text-[10px] uppercase tracking-wide text-[#5B6578]">{item.projectLabel}</span> : null}
                          {item.kind !== 'persisted_task' && item.kind !== 'history' ? (
                            <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                              Derived from shared operational model
                            </span>
                          ) : null}
                        </div>
                        <p className="text-[11px] text-[#8B94A3]">{item.instructions}</p>
                        {item.isVague ? <span className="text-[10px] text-amber-300">Action text needs specificity</span> : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3">
                      {item.dueAt ? (
                        <span className={`flex items-center gap-1.5 ${item.overdue ? 'font-medium text-red-400' : 'text-[#8B94A3]'}`}>
                          <span>{formatDueDate(item.dueAt)}</span>
                          {item.overdue ? <OverdueBadge /> : null}
                        </span>
                      ) : (
                        <span className="text-[#3a3f5a]">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3">
                      {item.assignedName ? (
                        <span className="text-[#F5F7FA]">{item.assignedName}</span>
                      ) : (
                        <span className={item.isUrgentUnassigned ? 'font-medium text-amber-400' : 'text-[#8B94A3]'}>
                          Unassigned
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-[#8B94A3]">
                      {item.sourceDocumentTarget ? (
                        <Link href={item.sourceDocumentTarget} className="text-[#8B5CFF] hover:underline">
                          {item.sourceDocumentTitle ?? 'View document'}
                        </Link>
                      ) : item.decisionId ? (
                        <Link href={`/platform/decisions/${item.decisionId}`} className="text-[#8B5CFF] hover:underline">
                          Linked decision
                        </Link>
                      ) : (
                        <span className="text-[#3a3f5a]">Project record</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-[#8B94A3]">
                      {new Date(item.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
