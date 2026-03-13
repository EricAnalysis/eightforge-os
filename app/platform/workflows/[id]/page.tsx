'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOrgMembers, memberDisplayName } from '@/lib/useOrgMembers';
import { formatDueDate, dueDateInputValue, dueDateToISO } from '@/lib/dateUtils';
import { isTaskOverdue, OverdueBadge } from '@/lib/overdue';
import { ActivityTimeline } from '@/components/ActivityTimeline';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocumentRef = { id: string; title: string | null; name: string } | null;

type WorkflowTaskDetail = {
  id: string;
  decision_id: string | null;
  document_id: string | null;
  task_type: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  source: string | null;
  source_metadata: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  due_at: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
  documents?: DocumentRef | DocumentRef[];
};

// ─── Constants ──────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['open', 'in_progress', 'blocked', 'resolved', 'cancelled'] as const;

// ─── Badges ─────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    in_progress: 'bg-blue-500/20 text-blue-400 border border-blue-500/40',
    blocked: 'bg-red-500/20 text-red-400 border border-red-500/40',
    resolved: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    cancelled: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[status] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
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
    medium: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
    low: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[priority] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
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

// ─── Helpers ───────────────────────────────────────────────────────────────────

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-[11px]">
      <span className="w-36 shrink-0 text-[#8B94A3]">{label}</span>
      <span className="text-[#F5F7FA]">{children}</span>
    </div>
  );
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}


// ─── Page ──────────────────────────────────────────────────────────────────────

export default function WorkflowTaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const { members } = useOrgMembers(organizationId);

  const [task, setTask] = useState<WorkflowTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [updateError, setUpdateError] = useState(false);
  const [statusSaved, setStatusSaved] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState(false);
  const [assignSaved, setAssignSaved] = useState(false);
  const [updatingDueDate, setUpdatingDueDate] = useState(false);
  const [dueDateError, setDueDateError] = useState(false);
  const [dueDateSaved, setDueDateSaved] = useState(false);
  const [activityKey, setActivityKey] = useState(0);

  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const assignTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dueDateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(statusTimer.current);
      clearTimeout(assignTimer.current);
      clearTimeout(dueDateTimer.current);
    };
  }, []);

  useEffect(() => {
    if (orgLoading || !organizationId) {
      if (!orgLoading) setLoading(false);
      return;
    }

    const load = async () => {
      setLoading(true);
      setNotFound(false);
      setTask(null);

      const { data, error } = await supabase
        .from('workflow_tasks')
        .select(
          'id, decision_id, document_id, task_type, title, description, priority, status, source, source_metadata, details, created_at, updated_at, due_at, completed_at, assigned_to, assigned_at, assigned_by, documents(id, title, name)'
        )
        .eq('id', id)
        .eq('organization_id', organizationId)
        .single();

      if (error || !data) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setTask(data as WorkflowTaskDetail);
      setLoading(false);
    };

    load();
  }, [id, organizationId, orgLoading]);

  const updateStatus = async (newStatus: string) => {
    if (!organizationId || !task) return;
    setUpdateError(false);
    setStatusSaved(false);
    setUpdatingStatus(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setUpdateError(true); return; }

      const res = await fetch(`/api/workflow-tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setUpdateError(true); return; }

      setTask((prev) =>
        prev ? { ...prev, ...data, documents: prev.documents } : null
      );

      clearTimeout(statusTimer.current);
      setStatusSaved(true);
      statusTimer.current = setTimeout(() => setStatusSaved(false), 2000);
      setActivityKey((k) => k + 1);
    } finally {
      setUpdatingStatus(false);
    }
  };

  const updateDueDate = async (dueAt: string | null) => {
    if (!organizationId || !task) return;
    setDueDateError(false);
    setDueDateSaved(false);
    setUpdatingDueDate(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setDueDateError(true); return; }

      const res = await fetch(`/api/workflow-tasks/${task.id}/due-date`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ due_at: dueAt }),
      });
      if (!res.ok) { setDueDateError(true); return; }

      const data = await res.json().catch(() => ({}));
      setTask((prev) =>
        prev ? { ...prev, ...data, documents: prev.documents } : null
      );

      clearTimeout(dueDateTimer.current);
      setDueDateSaved(true);
      dueDateTimer.current = setTimeout(() => setDueDateSaved(false), 2000);
      setActivityKey((k) => k + 1);
    } finally {
      setUpdatingDueDate(false);
    }
  };

  const assignTask = async (assignedTo: string | null) => {
    if (!organizationId || !task) return;
    setAssignError(false);
    setAssignSaved(false);
    setAssigning(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setAssignError(true); return; }

      const res = await fetch(`/api/workflow-tasks/${task.id}/assign`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ assigned_to: assignedTo }),
      });
      if (!res.ok) { setAssignError(true); return; }

      const data = await res.json().catch(() => ({}));
      setTask((prev) =>
        prev ? { ...prev, ...data, documents: prev.documents } : null
      );

      clearTimeout(assignTimer.current);
      setAssignSaved(true);
      assignTimer.current = setTimeout(() => setAssignSaved(false), 2000);
      setActivityKey((k) => k + 1);
    } finally {
      setAssigning(false);
    }
  };

  // ── Loading ─────────────────────────────────────────────────────────────────

  if (loading || orgLoading) {
    return (
      <div className="space-y-3">
        <Link href="/platform/workflows" className="text-[11px] text-[#8B5CFF] hover:underline">
          ← Workflow Tasks
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Loading…</p>
      </div>
    );
  }

  // ── Not found ───────────────────────────────────────────────────────────────

  if (notFound || !task) {
    return (
      <div className="space-y-3">
        <Link href="/platform/workflows" className="text-[11px] text-[#8B5CFF] hover:underline">
          ← Workflow Tasks
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Workflow task not found.</p>
      </div>
    );
  }

  const doc = task.documents;
  const documentRef = Array.isArray(doc) ? doc?.[0] : doc;
  const docLabel = documentRef?.title ?? documentRef?.name ?? 'View document';

  return (
    <div className="space-y-4">
      {/* Header */}
      <section className="flex items-start justify-between gap-4">
        <div>
          <Link href="/platform/workflows" className="text-[11px] text-[#8B5CFF] hover:underline">
            ← Workflow Tasks
          </Link>
          <h2 className="mt-1 text-sm font-semibold text-[#F5F7FA]">{task.title || '—'}</h2>
          <p className="text-xs text-[#8B94A3]">
            {titleize(task.task_type)} · <PriorityBadge priority={task.priority} /> · <StatusBadge status={task.status} />
            {isTaskOverdue(task.due_at, task.status) && <> · <OverdueBadge /></>}
          </p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-2">
          <div>
            <select
              aria-label="Update task status"
              value={STATUS_OPTIONS.includes(task.status as (typeof STATUS_OPTIONS)[number]) ? task.status : STATUS_OPTIONS[0]}
              onChange={(e) => updateStatus(e.target.value)}
              disabled={updatingStatus}
              className="rounded border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF] disabled:opacity-60"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
            {updatingStatus && <span className="ml-2 text-[10px] text-[#8B94A3]">Saving…</span>}
            {statusSaved && <span className="ml-2 text-[10px] text-emerald-400">Saved</span>}
            {updateError && <span className="ml-2 text-[10px] text-red-400">Save failed</span>}
          </div>
          <div>
            <select
              aria-label="Assign task"
              value={task.assigned_to ?? ''}
              onChange={(e) => assignTask(e.target.value || null)}
              disabled={assigning}
              className="rounded border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF] disabled:opacity-60"
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.display_name ?? m.id.slice(0, 8)}</option>
              ))}
            </select>
            {assigning && <span className="ml-2 text-[10px] text-[#8B94A3]">Saving…</span>}
            {assignSaved && <span className="ml-2 text-[10px] text-emerald-400">Saved</span>}
            {assignError && <span className="ml-2 text-[10px] text-red-400">Save failed</span>}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-[#8B94A3]">Due</label>
            <input
              type="date"
              aria-label="Set due date"
              value={task.due_at ? dueDateInputValue(task.due_at) : ''}
              onChange={(e) => updateDueDate(dueDateToISO(e.target.value))}
              disabled={updatingDueDate}
              className="rounded border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF] disabled:opacity-60"
            />
            {task.due_at && (
              <button
                type="button"
                onClick={() => updateDueDate(null)}
                disabled={updatingDueDate}
                className="text-[10px] text-[#8B94A3] hover:text-[#F5F7FA] disabled:opacity-60"
              >
                Clear
              </button>
            )}
            {updatingDueDate && <span className="text-[10px] text-[#8B94A3]">Saving…</span>}
            {dueDateSaved && <span className="text-[10px] text-emerald-400">Saved</span>}
            {dueDateError && <span className="text-[10px] text-red-400">Save failed</span>}
          </div>
        </div>
      </section>

      {/* Task details */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Details</div>
        <div className="space-y-2">
          <MetaRow label="Title">{task.title || '—'}</MetaRow>
          <MetaRow label="Task type">{titleize(task.task_type)}</MetaRow>
          <MetaRow label="Priority"><PriorityBadge priority={task.priority} /></MetaRow>
          <MetaRow label="Status"><StatusBadge status={task.status} /></MetaRow>
          <MetaRow label="Description">{task.description ?? '—'}</MetaRow>
          <MetaRow label="Source">{task.source ?? '—'}</MetaRow>
          <MetaRow label="Created at">{formatDate(task.created_at)}</MetaRow>
          <MetaRow label="Updated at">{formatDate(task.updated_at)}</MetaRow>
          <MetaRow label="Due date">
            {task.due_at ? (
              <span className="flex items-center gap-1.5">
                {formatDueDate(task.due_at)}
                {isTaskOverdue(task.due_at, task.status) && <OverdueBadge />}
              </span>
            ) : (
              <span className="text-[#8B94A3]">No due date</span>
            )}
          </MetaRow>
          <MetaRow label="Completed at">{formatDate(task.completed_at)}</MetaRow>
          <MetaRow label="Assigned to">{memberDisplayName(members, task.assigned_to)}</MetaRow>
          <MetaRow label="Assigned at">{formatDate(task.assigned_at)}</MetaRow>
          <MetaRow label="Decision">
            {task.decision_id ? (
              <Link
                href={`/platform/decisions/${task.decision_id}`}
                className="text-[#8B5CFF] hover:underline"
              >
                View decision
              </Link>
            ) : (
              '—'
            )}
          </MetaRow>
          <MetaRow label="Document">
            {task.document_id ? (
              <Link
                href={`/platform/documents/${task.document_id}`}
                className="text-[#8B5CFF] hover:underline"
              >
                {docLabel}
              </Link>
            ) : (
              '—'
            )}
          </MetaRow>
        </div>
      </section>

      {/* Activity timeline */}
      <ActivityTimeline organizationId={organizationId} entityType="workflow_task" entityId={task.id} refreshKey={activityKey} />

      {/* Details JSON */}
      {task.details != null && Object.keys(task.details).length > 0 && (
        <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
          <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Details (JSON)</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-[#1A1A3E] bg-[#0A0A20] p-3 text-[10px] text-[#F5F7FA]">
            {JSON.stringify(task.details, null, 2)}
          </pre>
        </section>
      )}

      {/* Source metadata */}
      {task.source_metadata != null && Object.keys(task.source_metadata).length > 0 && (
        <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
          <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Source metadata</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-[#1A1A3E] bg-[#0A0A20] p-3 text-[10px] text-[#F5F7FA]">
            {JSON.stringify(task.source_metadata, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
