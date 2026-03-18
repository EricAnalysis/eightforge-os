'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { filterCurrentQueueRecords } from '@/lib/currentWork';

// ─── Types ────────────────────────────────────────────────────────────────────

type DecisionRef = {
  id: string;
  title: string;
  severity: string;
};

type ReviewQueueItem = {
  id: string;
  title: string;
  severity: string;
  decision_type: string;
  created_at: string;
  document_id: string | null;
  details?: Record<string, unknown> | null;
};

type FeedbackRow = {
  id: string;
  is_correct: boolean | null;
  feedback_type: string | null;
  notes: string | null;
  disposition: string | null;
  created_at: string;
  decisions: DecisionRef;
};

// ─── Badges ───────────────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/20 text-red-400 border border-red-500/40',
    high: 'bg-red-500/20 text-red-400 border border-red-500/40',
    medium: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
    low: 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]',
  };
  const cls = map[severity] ?? 'bg-[#1A1A3E] text-[#8B94A3] border border-[#1A1A3E]';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>
      {severity}
    </span>
  );
}

function CorrectnessBadge({ isCorrect }: { isCorrect: boolean | null }) {
  if (isCorrect === true) {
    return (
      <span className="inline-block rounded px-2 py-0.5 text-[11px] font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
        ✓ Correct
      </span>
    );
  }
  if (isCorrect === false) {
    return (
      <span className="inline-block rounded px-2 py-0.5 text-[11px] font-medium bg-red-500/20 text-red-400 border border-red-500/40">
        ✗ Incorrect
      </span>
    );
  }
  return null;
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

export default function ReviewsPage() {
  const router = useRouter();
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  // Review Queue state
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [reviewQueueLoading, setReviewQueueLoading] = useState(true);
  const [reviewQueueError, setReviewQueueError] = useState<string | null>(null);
  const [reviewUpdatingId, setReviewUpdatingId] = useState<string | null>(null);
  const [reviewUpdateErrorId, setReviewUpdateErrorId] = useState<string | null>(null);

  // Recent Feedback state
  const [feedbackList, setFeedbackList] = useState<FeedbackRow[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(true);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  // Fetch review queue
  const fetchReviewQueue = async (orgId: string) => {
    setReviewQueueLoading(true);
    setReviewQueueError(null);
    const { data, error } = await supabase
      .from('decisions')
      .select('id, title, severity, decision_type, created_at, document_id, details')
      .eq('organization_id', orgId)
      .eq('status', 'in_review')
      .order('created_at', { ascending: false });

    if (error) {
      setReviewQueueError('Failed to load review queue.');
      setReviewQueue([]);
    } else {
      setReviewQueue(filterCurrentQueueRecords((data as ReviewQueueItem[]) ?? []));
    }
    setReviewQueueLoading(false);
  };

  // Fetch recent feedback
  const fetchFeedback = async (orgId: string) => {
    setFeedbackLoading(true);
    setFeedbackError(null);
    const { data, error } = await supabase
      .from('decision_feedback')
      .select('id, is_correct, feedback_type, notes, disposition, created_at, decisions(id, title, severity)')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      setFeedbackError('Failed to load feedback.');
      setFeedbackList([]);
    } else {
      setFeedbackList(data as unknown as FeedbackRow[]);
    }
    setFeedbackLoading(false);
  };

  useEffect(() => {
    if (orgLoading || !organizationId) {
      if (!orgLoading) {
        setReviewQueueLoading(false);
        setFeedbackLoading(false);
      }
      return;
    }
    fetchReviewQueue(organizationId);
    fetchFeedback(organizationId);
  }, [organizationId, orgLoading]);

  const updateDecisionStatus = async (decisionId: string, newStatus: string) => {
    if (!organizationId) return;
    setReviewUpdateErrorId(null);
    setReviewUpdatingId(decisionId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setReviewUpdateErrorId(decisionId);
        return;
      }
      const res = await fetch(`/api/decisions/${decisionId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      if (redirectIfUnauthorized(res, router.replace)) return;
      if (!res.ok) {
        setReviewUpdateErrorId(decisionId);
        return;
      }
      // Remove from queue after approval/flag
      setReviewQueue((prev) => prev.filter((d) => d.id !== decisionId));
    } finally {
      setReviewUpdatingId(null);
    }
  };

  const displayDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return '—';
    }
  };

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Reviews</h2>
          <p className="text-xs text-[#8B94A3]">
            Queue and manage human-in-the-loop reviews. Approve decisions or flag them for further investigation.
          </p>
        </div>
      </section>

      {/* Review Queue Section */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 border-b border-[#1A1A3E] pb-3">
          <h3 className="text-sm font-semibold text-[#F5F7FA]">Review Queue</h3>
          <p className="mt-1 text-[11px] text-[#8B94A3]">Decisions awaiting approval or flagging</p>
        </div>

        {reviewQueueError && (
          <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] font-medium text-red-400">{reviewQueueError}</p>
          </div>
        )}

        {reviewQueueLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : reviewQueue.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No decisions in review queue</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Severity</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Title</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Type</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Created</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Document</th>
                  <th className="pb-2 font-medium text-[#8B94A3]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reviewQueue.map((item) => {
                  const isCritHigh = item.severity === 'critical' || item.severity === 'high';
                  const rowBg = isCritHigh ? 'bg-red-500/[0.04]' : '';
                  return (
                    <tr
                      key={item.id}
                      className={`border-b border-[#1A1A3E] last:border-0 transition-colors hover:bg-[#12122E] ${rowBg}`}
                    >
                      <td className="py-2.5 pr-3">
                        <SeverityBadge severity={item.severity} />
                      </td>
                      <td className="py-2.5 pr-3 max-w-[240px] truncate" title={item.title}>
                        <Link
                          href={`/platform/decisions/${item.id}`}
                          className="font-medium text-[#8B5CFF] hover:underline"
                        >
                          {item.title || '—'}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap text-[#8B94A3]">
                        {titleize(item.decision_type)}
                      </td>
                      <td className="py-2.5 pr-3 whitespace-nowrap text-[#8B94A3]">
                        {displayDate(item.created_at)}
                      </td>
                      <td className="py-2.5 pr-3">
                        {item.document_id ? (
                          <Link
                            href={`/platform/documents/${item.document_id}`}
                            className="text-[#8B5CFF] hover:underline text-[11px]"
                          >
                            View
                          </Link>
                        ) : (
                          <span className="text-[#3a3f5a]">—</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => updateDecisionStatus(item.id, 'resolved')}
                            disabled={reviewUpdatingId === item.id}
                            className="rounded px-2 py-1 text-[11px] font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 transition-colors"
                          >
                            {reviewUpdatingId === item.id ? 'Approving…' : 'Approve'}
                          </button>
                          <button
                            type="button"
                            onClick={() => updateDecisionStatus(item.id, 'open')}
                            disabled={reviewUpdatingId === item.id}
                            className="rounded px-2 py-1 text-[11px] font-medium bg-amber-500/20 text-amber-400 border border-amber-500/40 hover:bg-amber-500/30 disabled:opacity-50 transition-colors"
                          >
                            {reviewUpdatingId === item.id ? 'Flagging…' : 'Flag'}
                          </button>
                          {reviewUpdateErrorId === item.id && (
                            <span className="text-[10px] text-red-400">Failed</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent Feedback Section */}
      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 border-b border-[#1A1A3E] pb-3">
          <h3 className="text-sm font-semibold text-[#F5F7FA]">Recent Feedback</h3>
          <p className="mt-1 text-[11px] text-[#8B94A3]">Latest feedback on decisions</p>
        </div>

        {feedbackError && (
          <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] font-medium text-red-400">{feedbackError}</p>
          </div>
        )}

        {feedbackLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : feedbackList.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No feedback yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Decision</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Severity</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Correctness</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Type</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Notes</th>
                  <th className="pb-2 font-medium text-[#8B94A3]">Date</th>
                </tr>
              </thead>
              <tbody>
                {feedbackList.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-[#1A1A3E] last:border-0 transition-colors hover:bg-[#12122E]"
                  >
                    <td className="py-2.5 pr-3 max-w-[240px] truncate" title={row.decisions.title}>
                      <Link
                        href={`/platform/decisions/${row.decisions.id}`}
                        className="font-medium text-[#8B5CFF] hover:underline"
                      >
                        {row.decisions.title || '—'}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3">
                      <SeverityBadge severity={row.decisions.severity} />
                    </td>
                    <td className="py-2.5 pr-3">
                      {row.is_correct !== null ? (
                        <CorrectnessBadge isCorrect={row.is_correct} />
                      ) : (
                        <span className="text-[#8B94A3]">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-[#8B94A3] whitespace-nowrap">
                      {row.feedback_type ? titleize(row.feedback_type) : '—'}
                    </td>
                    <td className="py-2.5 pr-3 max-w-[200px] truncate text-[#8B94A3]" title={row.notes ?? undefined}>
                      {row.notes && row.notes.trim() ? row.notes : '—'}
                    </td>
                    <td className="py-2.5 whitespace-nowrap text-[#8B94A3]">
                      {displayDate(row.created_at)}
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
