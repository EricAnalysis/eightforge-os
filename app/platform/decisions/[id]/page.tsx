'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { useOrgMembers, memberDisplayName } from '@/lib/useOrgMembers';
import { formatDueDate, dueDateInputValue, dueDateToISO } from '@/lib/dateUtils';
import { isDecisionOverdue, OverdueBadge } from '@/lib/overdue';
import { ActivityTimeline } from '@/components/ActivityTimeline';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocumentRef = { id: string; title: string | null; name: string } | null;

type DecisionDetail = {
  id: string;
  document_id: string | null;
  decision_type: string;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  confidence: number | null;
  source: string;
  created_at: string;
  first_detected_at: string | null;
  last_detected_at: string | null;
  resolved_at: string | null;
  due_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
  details: Record<string, unknown> | null;
  documents?: DocumentRef | DocumentRef[];
};

type FeedbackRow = {
  id: string;
  created_at: string;
  feedback_type: string;
  disposition: string | null;
  decision_status_at_feedback: string | null;
  created_by: string | null;
  metadata: Record<string, unknown> | null;
};

// ─── Constants ──────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['open', 'in_review', 'resolved', 'suppressed'] as const;

// ─── Badges (aligned with list page) ───────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    in_review: 'bg-blue-500/20 text-blue-400 border border-blue-500/40',
    resolved: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    suppressed: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[status] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high: 'bg-red-500/20 text-red-400 border border-red-500/40',
    medium: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    low: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[severity] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {severity}
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

function truncateId(id: string | null): string {
  if (!id) return '—';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}


// ─── Page ──────────────────────────────────────────────────────────────────────

export default function DecisionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const { members } = useOrgMembers(organizationId);

  const [decision, setDecision] = useState<DecisionDetail | null>(null);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
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
      setDecision(null);
      setFeedback([]);

      const { data: decisionData, error: decisionError } = await supabase
        .from('decisions')
        .select(
          'id, document_id, decision_type, title, summary, severity, status, confidence, source, created_at, first_detected_at, last_detected_at, resolved_at, due_at, assigned_to, assigned_at, assigned_by, details, documents(id, title, name)'
        )
        .eq('id', id)
        .eq('organization_id', organizationId)
        .single();

      if (decisionError || !decisionData) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setDecision(decisionData as DecisionDetail);

      const { data: feedbackData } = await supabase
        .from('decision_feedback')
        .select('id, created_at, feedback_type, disposition, decision_status_at_feedback, created_by, metadata')
        .eq('decision_id', id)
        .order('created_at', { ascending: false });

      if (feedbackData) setFeedback(feedbackData as FeedbackRow[]);
      setLoading(false);
    };

    load();
  }, [id, organizationId, orgLoading]);

  const updateStatus = async (newStatus: string) => {
    if (!organizationId || !decision) return;
    setUpdateError(false);
    setStatusSaved(false);
    setUpdatingStatus(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setUpdateError(true); return; }

      const res = await fetch(`/api/decisions/${decision.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      if (redirectIfUnauthorized(res, router.replace)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setUpdateError(true); return; }

      setDecision((prev) =>
        prev ? { ...prev, ...data, documents: prev.documents } : null
      );

      clearTimeout(statusTimer.current);
      setStatusSaved(true);
      statusTimer.current = setTimeout(() => setStatusSaved(false), 2000);
      setActivityKey((k) => k + 1);

      const { data: feedbackData } = await supabase
        .from('decision_feedback')
        .select('id, created_at, feedback_type, disposition, decision_status_at_feedback, created_by, metadata')
        .eq('decision_id', decision.id)
        .order('created_at', { ascending: false });
      if (feedbackData) setFeedback(feedbackData as FeedbackRow[]);
    } finally {
      setUpdatingStatus(false);
    }
  };

  const assignDecision = async (assignedTo: string | null) => {
    if (!organizationId || !decision) return;
    setAssignError(false);
    setAssignSaved(false);
    setAssigning(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setAssignError(true); return; }

      const res = await fetch(`/api/decisions/${decision.id}/assign`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ assigned_to: assignedTo }),
      });
      if (redirectIfUnauthorized(res, router.replace)) return;
      if (!res.ok) { setAssignError(true); return; }

      const data = await res.json().catch(() => ({}));
      setDecision((prev) =>
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

  const updateDueDate = async (dueAt: string | null) => {
    if (!organizationId || !decision) return;
    setDueDateError(false);
    setDueDateSaved(false);
    setUpdatingDueDate(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) { setDueDateError(true); return; }

      const res = await fetch(`/api/decisions/${decision.id}/due-date`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ due_at: dueAt }),
      });
      if (redirectIfUnauthorized(res, router.replace)) return;
      if (!res.ok) { setDueDateError(true); return; }

      const data = await res.json().catch(() => ({}));
      setDecision((prev) =>
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

  // ── Loading ───────────────────────────────────────────────────────────────────

  if (loading || orgLoading) {
    return (
      <div className="space-y-3">
        <Link
          href="/platform/decisions"
          className="text-[11px] text-[#8B5CFF] hover:underline"
        >
          ← Decisions
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Loading…</p>
      </div>
    );
  }

  // ── Not found ───────────────────────────────────────────────────────────────

  if (notFound || !decision) {
    return (
      <div className="space-y-3">
        <Link
          href="/platform/decisions"
          className="text-[11px] text-[#8B5CFF] hover:underline"
        >
          ← Decisions
        </Link>
        <p className="text-[11px] text-[#8B94A3]">Decision not found.</p>
      </div>
    );
  }

  const doc = decision.documents;
  const documentRef = Array.isArray(doc) ? doc?.[0] : doc;
  const docLabel = documentRef?.title ?? documentRef?.name ?? 'View document';

  return (
    <div className="space-y-4">
      {/* Header */}
      <section className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/platform/decisions"
            className="text-[11px] text-[#8B5CFF] hover:underline"
          >
            ← Decisions
          </Link>
          <h2 className="mt-1 text-sm font-semibold text-[#F5F7FA]">{decision.title || '—'}</h2>
          <p className="text-xs text-[#8B94A3]">
            {titleize(decision.decision_type)} · <SeverityBadge severity={decision.severity} /> · <StatusBadge status={decision.status} />
            {isDecisionOverdue(decision.due_at, decision.status) && <> · <OverdueBadge /></>}
          </p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-2">
          <div>
            <select
              aria-label="Update decision status"
              value={STATUS_OPTIONS.includes(decision.status as (typeof STATUS_OPTIONS)[number]) ? decision.status : STATUS_OPTIONS[0]}
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
              aria-label="Assign decision"
              value={decision.assigned_to ?? ''}
              onChange={(e) => assignDecision(e.target.value || null)}
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
              value={decision.due_at ? dueDateInputValue(decision.due_at) : ''}
              onChange={(e) => updateDueDate(dueDateToISO(e.target.value))}
              disabled={updatingDueDate}
              className="rounded border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF] disabled:opacity-60"
            />
            {decision.due_at && (
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

      {/* Decision details */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Details</div>
        <div className="space-y-2">
          <MetaRow label="Title">{decision.title || '—'}</MetaRow>
          <MetaRow label="Decision type">{titleize(decision.decision_type)}</MetaRow>
          <MetaRow label="Severity"><SeverityBadge severity={decision.severity} /></MetaRow>
          <MetaRow label="Status"><StatusBadge status={decision.status} /></MetaRow>
          <MetaRow label="Confidence">
            {decision.confidence != null ? `${Math.round(decision.confidence * 100)}%` : '—'}
          </MetaRow>
          <MetaRow label="Summary">{decision.summary ?? '—'}</MetaRow>
          <MetaRow label="Source">{decision.source ?? '—'}</MetaRow>
          <MetaRow label="Created at">{formatDate(decision.created_at)}</MetaRow>
          <MetaRow label="First detected at">{formatDate(decision.first_detected_at)}</MetaRow>
          <MetaRow label="Last detected at">{formatDate(decision.last_detected_at)}</MetaRow>
          <MetaRow label="Due date">
            {decision.due_at ? (
              <span className="flex items-center gap-1.5">
                {formatDueDate(decision.due_at)}
                {isDecisionOverdue(decision.due_at, decision.status) && <OverdueBadge />}
              </span>
            ) : (
              <span className="text-[#8B94A3]">No due date</span>
            )}
          </MetaRow>
          <MetaRow label="Resolved at">{formatDate(decision.resolved_at)}</MetaRow>
          <MetaRow label="Assigned to">{memberDisplayName(members, decision.assigned_to)}</MetaRow>
          <MetaRow label="Assigned at">{formatDate(decision.assigned_at)}</MetaRow>
          <MetaRow label="Document">
            {decision.document_id ? (
              <Link
                href={`/platform/documents/${decision.document_id}`}
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
      <ActivityTimeline organizationId={organizationId} entityType="decision" entityId={decision.id} refreshKey={activityKey} />

      {/* Details JSON */}
      {decision.details != null && Object.keys(decision.details).length > 0 && (
        <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
          <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Details (JSON)</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-[#1A1A3E] bg-[#0A0A20] p-3 text-[10px] text-[#F5F7FA]">
            {JSON.stringify(decision.details, null, 2)}
          </pre>
        </section>
      )}

      {/* Feedback history */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F5F7FA]">Feedback history</div>
        {feedback.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No feedback recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px] text-[#8B94A3]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Created</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Type</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Disposition</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Status at feedback</th>
                  <th className="py-2 pr-3 font-medium text-[#F5F7FA]">Created by</th>
                  <th className="py-2 font-medium text-[#F5F7FA]">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {feedback.map((row) => (
                  <tr key={row.id} className="border-b border-[#1A1A3E] last:border-0 hover:bg-[#12122E]">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDate(row.created_at)}</td>
                    <td className="py-2 pr-3">{row.feedback_type ?? '—'}</td>
                    <td className="py-2 pr-3">{row.disposition ?? '—'}</td>
                    <td className="py-2 pr-3">{row.decision_status_at_feedback ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-[10px]">{truncateId(row.created_by)}</td>
                    <td className="py-2">
                      {row.metadata && Object.keys(row.metadata).length > 0 ? (
                        <pre className="max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap text-[10px]" title={JSON.stringify(row.metadata)}>
                          {JSON.stringify(row.metadata)}
                        </pre>
                      ) : (
                        '—'
                      )}
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
