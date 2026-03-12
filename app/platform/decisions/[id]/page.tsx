'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

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
    suppressed: 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
  };
  const cls = map[status] ?? 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    high: 'bg-red-500/20 text-red-400 border border-red-500/40',
    medium: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    low: 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]',
  };
  const cls = map[severity] ?? 'bg-[#1A1F27] text-[#8B94A3] border border-[#1A1F27]';
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
      <span className="text-[#F1F3F5]">{children}</span>
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
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const [decision, setDecision] = useState<DecisionDetail | null>(null);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [updateError, setUpdateError] = useState(false);

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
          'id, document_id, decision_type, title, summary, severity, status, confidence, source, created_at, first_detected_at, last_detected_at, resolved_at, details, documents(id, title, name)'
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
    setUpdatingStatus(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setUpdateError(true);
        return;
      }
      const res = await fetch(`/api/decisions/${decision.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUpdateError(true);
        return;
      }
      setDecision((prev) =>
        prev ? { ...prev, status: (data.status ?? newStatus) as string, resolved_at: data.resolved_at ?? prev.resolved_at } : null
      );
      setUpdateError(false);

      // Refetch feedback so the new audit row appears without full page refresh
      const { data: feedbackData } = await supabase
        .from('decision_feedback')
        .select('id, created_at, feedback_type, disposition, decision_status_at_feedback, created_by, metadata')
        .eq('decision_id', decision.id)
        .order('created_at', { ascending: false });
      if (feedbackData) setFeedback(feedbackData as FeedbackRow[]);

      // Refetch decision from server so status and resolved_at match saved row
      const { data: decisionData, error: decisionError } = await supabase
        .from('decisions')
        .select(
          'id, document_id, decision_type, title, summary, severity, status, confidence, source, created_at, first_detected_at, last_detected_at, resolved_at, details, documents(id, title, name)'
        )
        .eq('id', decision.id)
        .eq('organization_id', organizationId)
        .single();
      if (!decisionError && decisionData) setDecision(decisionData as DecisionDetail);
    } finally {
      setUpdatingStatus(false);
    }
  };

  // ── Loading ───────────────────────────────────────────────────────────────────

  if (loading || orgLoading) {
    return (
      <div className="space-y-3">
        <Link
          href="/platform/decisions"
          className="text-[11px] text-[#7C5CFF] hover:underline"
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
          className="text-[11px] text-[#7C5CFF] hover:underline"
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
            className="text-[11px] text-[#7C5CFF] hover:underline"
          >
            ← Decisions
          </Link>
          <h2 className="mt-1 text-sm font-semibold text-[#F1F3F5]">{decision.title || '—'}</h2>
          <p className="text-xs text-[#8B94A3]">
            {titleize(decision.decision_type)} · <SeverityBadge severity={decision.severity} /> · <StatusBadge status={decision.status} />
          </p>
        </div>
        <div className="shrink-0">
          <select
            value={STATUS_OPTIONS.includes(decision.status as (typeof STATUS_OPTIONS)[number]) ? decision.status : STATUS_OPTIONS[0]}
            onChange={(e) => updateStatus(e.target.value)}
            disabled={updatingStatus}
            className="rounded border border-[#1A1F27] bg-[#0A0C10] px-2 py-1.5 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF] disabled:opacity-60"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
          {updatingStatus && <span className="ml-2 text-[10px] text-[#8B94A3]">Updating…</span>}
          {updateError && <span className="ml-2 text-[10px] text-red-400">Update failed</span>}
        </div>
      </section>

      {/* Decision details */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Details</div>
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
          <MetaRow label="Resolved at">{formatDate(decision.resolved_at)}</MetaRow>
          <MetaRow label="Document">
            {decision.document_id ? (
              <Link
                href={`/platform/documents/${decision.document_id}`}
                className="text-[#7C5CFF] hover:underline"
              >
                {docLabel}
              </Link>
            ) : (
              '—'
            )}
          </MetaRow>
        </div>
      </section>

      {/* Details JSON */}
      {decision.details != null && Object.keys(decision.details).length > 0 && (
        <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
          <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Details (JSON)</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-[#1A1F27] bg-[#0A0C10] p-3 text-[10px] text-[#F1F3F5]">
            {JSON.stringify(decision.details, null, 2)}
          </pre>
        </section>
      )}

      {/* Feedback history */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Feedback history</div>
        {feedback.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No feedback recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px] text-[#8B94A3]">
              <thead className="border-b border-[#1A1F27] text-left">
                <tr>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Created</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Type</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Disposition</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Status at feedback</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Created by</th>
                  <th className="py-2 font-medium text-[#F1F3F5]">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {feedback.map((row) => (
                  <tr key={row.id} className="border-b border-[#1A1F27] last:border-0 hover:bg-[#13171E]">
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
