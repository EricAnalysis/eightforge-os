'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

// ─── Types ────────────────────────────────────────────────────────────────────

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
};

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['open', 'in_progress', 'resolved', 'cancelled'] as const;
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'] as const;

// ─── Badges ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    in_progress: 'bg-blue-500/20 text-blue-400 border border-blue-500/40',
    resolved: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    cancelled: 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
  };
  const cls = map[status] ?? 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    medium: 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
    low: 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
  };
  const cls = map[priority] ?? 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkflowsPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const [tasks, setTasks] = useState<WorkflowTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterPriority, setFilterPriority] = useState<string>('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updateErrorId, setUpdateErrorId] = useState<string | null>(null);

  const fetchTasks = async (orgId: string) => {
    setLoading(true);
    const { data, error } = await supabase
      .from('workflow_tasks')
      .select('id, decision_id, document_id, task_type, title, description, priority, status, source, created_at, updated_at')
      .eq('organization_id', orgId)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });
    if (!error && data) setTasks(data as WorkflowTaskRow[]);
    else setTasks([]);
    setLoading(false);
  };

  useEffect(() => {
    if (orgLoading || !organizationId) {
      if (!orgLoading) setLoading(false);
      return;
    }
    fetchTasks(organizationId);
  }, [organizationId, orgLoading]);

  const filteredTasks = useMemo(() => {
    let list = tasks;
    if (filterStatus) list = list.filter((t) => t.status === filterStatus);
    if (filterPriority) list = list.filter((t) => t.priority === filterPriority);
    return list;
  }, [tasks, filterStatus, filterPriority]);

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

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">Workflow Tasks</h2>
          <p className="text-xs text-[#8B94A3]">
            Review, prioritize, and resolve tasks created by the decision engine.
          </p>
        </div>
      </section>

      {/* Filters */}
      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F1F3F5]">Status</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-md border border-[#1A1F27] bg-[#0A0C10] px-2 py-1.5 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF]"
          >
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F1F3F5]">Priority</span>
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            className="rounded-md border border-[#1A1F27] bg-[#0A0C10] px-2 py-1.5 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF]"
          >
            <option value="">All</option>
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        {(filterStatus || filterPriority) && (
          <button
            type="button"
            onClick={() => {
              setFilterStatus('');
              setFilterPriority('');
            }}
            className="rounded-md border border-[#1A1F27] px-2 py-1.5 text-[11px] text-[#8B94A3] hover:text-[#F1F3F5] hover:bg-[#1A1F27]"
          >
            Clear filters
          </button>
        )}
      </section>

      {/* Table */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Task list</div>

        {isLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : filteredTasks.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No workflow tasks yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px] text-[#8B94A3]">
              <thead className="border-b border-[#1A1F27] text-left">
                <tr>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Title</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Priority</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Status</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Task type</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Decision</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Document</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Created</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-[#1A1F27] last:border-0 hover:bg-[#13171E]"
                  >
                    <td className="py-2 pr-3 max-w-[200px] truncate text-[#F1F3F5]" title={row.title}>
                      {row.title || '—'}
                    </td>
                    <td className="py-2 pr-3">
                      <PriorityBadge priority={row.priority} />
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-col gap-1">
                        <select
                          aria-label={`Update status for ${row.title || 'task'}`}
                          value={STATUS_OPTIONS.includes(row.status as (typeof STATUS_OPTIONS)[number]) ? row.status : STATUS_OPTIONS[0]}
                          onChange={(e) => updateStatus(row.id, e.target.value)}
                          disabled={updatingId === row.id}
                          className="rounded border border-[#1A1F27] bg-[#0A0C10] px-2 py-1 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF] disabled:opacity-60"
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
                    <td className="py-2 pr-3">{titleize(row.task_type)}</td>
                    <td className="py-2 pr-3">
                      {row.decision_id ? (
                        <Link
                          href={`/platform/decisions/${row.decision_id}`}
                          className="text-[#7C5CFF] hover:underline"
                        >
                          View decision
                        </Link>
                      ) : (
                        <span className="text-[#3a3f4a]">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {row.document_id ? (
                        <Link
                          href={`/platform/documents/${row.document_id}`}
                          className="text-[#7C5CFF] hover:underline"
                        >
                          View document
                        </Link>
                      ) : (
                        <span className="text-[#3a3f4a]">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{displayCreated(row)}</td>
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
