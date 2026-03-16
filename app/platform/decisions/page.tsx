'use client';

import { useEffect, useState, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOrgMembers } from '@/lib/useOrgMembers';
import { formatDueDate } from '@/lib/dateUtils';
import { isDecisionOverdue, OverdueBadge, DECISION_OPEN_STATUSES } from '@/lib/overdue';
import { AGING_BUCKETS, ageBucketKey, type AgingBucketKey } from '@/lib/aging';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocumentRef = { id: string; title: string | null; name: string } | null;
type AssigneeRef = { id: string; display_name: string | null } | null;

type DecisionRow = {
  id: string;
  document_id: string | null;
  decision_type: string;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  confidence: number | null;
  last_detected_at: string | null;
  created_at: string;
  due_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  assignee: AssigneeRef | AssigneeRef[];
  documents?: DocumentRef | DocumentRef[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['open', 'in_review', 'resolved', 'suppressed'] as const;
const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;

// ─── Badges ───────────────────────────────────────────────────────────────────

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
    <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>
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

function resolveAssignee(ref: AssigneeRef | AssigneeRef[]): AssigneeRef {
  return Array.isArray(ref) ? ref[0] ?? null : ref;
}

// ─── Status select color — makes the inline-edit control reflect current state ─

function getStatusSelectCls(status: string): string {
  const map: Record<string, string> = {
    open: 'border-amber-500/40 text-amber-400',
    in_review: 'border-blue-500/40 text-blue-400',
    resolved: 'border-emerald-500/40 text-emerald-400',
    suppressed: 'border-[#1A1A3E] text-[#8B94A3]',
  };
  return map[status] ?? 'border-[#1A1A3E] text-[#8B94A3]';
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DecisionsPage() {
  const router = useRouter();
  const { organization, userId, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const { members } = useOrgMembers(organizationId);
  const searchParams = useSearchParams();

  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>(searchParams.get('status') ?? '');
  const [filterSeverity, setFilterSeverity] = useState<string>(searchParams.get('severity') ?? '');
  const [filterDecisionType, setFilterDecisionType] = useState<string>(searchParams.get('type') ?? '');
  const [filterAssigned, setFilterAssigned] = useState<string>(searchParams.get('assigned') ?? '');
  const [filterDue, setFilterDue] = useState<string>(searchParams.get('due') ?? '');
  const [filterAge, setFilterAge] = useState<string>(searchParams.get('age') ?? '');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updateErrorId, setUpdateErrorId] = useState<string | null>(null);

  const fetchDecisions = async (orgId: string) => {
    setLoading(true);
    setListError(null);
    let query = supabase
      .from('decisions')
      .select('id, document_id, decision_type, title, summary, severity, status, confidence, last_detected_at, created_at, due_at, assigned_to, assigned_at, assignee:user_profiles!assigned_to(id, display_name), documents(id, title, name)')
      .eq('organization_id', orgId)
      .order('last_detected_at', { ascending: false });

    if (filterStatus) query = query.eq('status', filterStatus);
    if (filterSeverity) query = query.eq('severity', filterSeverity);
    if (filterDecisionType) query = query.eq('decision_type', filterDecisionType);
    if (filterAssigned === '__unassigned') query = query.is('assigned_to', null);
    else if (filterAssigned === '__me' && userId) query = query.eq('assigned_to', userId);
    else if (filterAssigned && filterAssigned !== '__me') query = query.eq('assigned_to', filterAssigned);

    const { data, error } = await query;
    if (error) {
      setListError('Failed to load decisions.');
      setDecisions([]);
    } else {
      setDecisions(data as DecisionRow[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (orgLoading || !organizationId) {
      if (!orgLoading) setLoading(false);
      return;
    }
    fetchDecisions(organizationId);
  }, [organizationId, orgLoading, filterStatus, filterSeverity, filterDecisionType, filterAssigned]);

  const updateStatus = async (decisionId: string, newStatus: string) => {
    if (!organizationId) return;
    setUpdateErrorId(null);
    setUpdatingId(decisionId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setUpdateErrorId(decisionId);
        return;
      }
      const res = await fetch(`/api/decisions/${decisionId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      if (redirectIfUnauthorized(res, router.replace)) return;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUpdateErrorId(decisionId);
        return;
      }
      setDecisions((prev) =>
        prev.map((d) => (d.id === decisionId ? { ...d, status: (data.status ?? newStatus) as string } : d))
      );
      setUpdateErrorId(null);
    } finally {
      setUpdatingId(null);
    }
  };

  const filteredDecisions = useMemo(() => {
    let list = decisions;
    if (filterDue === '__overdue') list = list.filter((d) => isDecisionOverdue(d.due_at, d.status));
    else if (filterDue === '__my_overdue') list = list.filter((d) => d.assigned_to === userId && isDecisionOverdue(d.due_at, d.status));
    else if (filterDue === '__no_due') list = list.filter((d) => !d.due_at);
    if (filterAge && AGING_BUCKETS.some((b) => b.key === filterAge)) {
      list = list.filter((d) =>
        DECISION_OPEN_STATUSES.includes(d.status) && ageBucketKey(d.created_at) === filterAge as AgingBucketKey,
      );
    }
    return list;
  }, [decisions, filterDue, filterAge, userId]);

  const decisionTypeOptions = useMemo(() => {
    const set = new Set(decisions.map((d) => d.decision_type).filter(Boolean));
    return Array.from(set).sort();
  }, [decisions]);

  // Scan summary counts computed from current filter results
  const scanSummary = useMemo(() => {
    const criticalHigh = filteredDecisions.filter((d) => d.severity === 'critical' || d.severity === 'high').length;
    const overdue = filteredDecisions.filter((d) => isDecisionOverdue(d.due_at, d.status)).length;
    const unassignedCrit = filteredDecisions.filter(
      (d) => !d.assigned_to && (d.severity === 'critical' || d.severity === 'high'),
    ).length;
    return { criticalHigh, overdue, unassignedCrit };
  }, [filteredDecisions]);

  const displayDate = (row: DecisionRow) => {
    const at = row.last_detected_at ?? row.created_at;
    return at ? new Date(at).toLocaleString() : '—';
  };

  const displayConfidence = (confidence: number | null) => {
    if (confidence == null) return '—';
    return `${Math.round(confidence * 100)}%`;
  };

  const displaySummary = (summary: string | null) => {
    if (summary == null || summary.trim() === '') return '—';
    return summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
  };

  const documentDisplay = (row: DecisionRow) => {
    if (!row.document_id) return null;
    const doc = row.documents;
    const single = Array.isArray(doc) ? doc[0] : doc;
    const label = single?.title ?? single?.name ?? 'View document';
    const text = typeof label === 'string' && label.length > 40 ? `${label.slice(0, 40)}…` : label;
    return (
      <Link
        href={`/platform/documents/${row.document_id}`}
        className="text-[#8B5CFF] hover:underline"
      >
        {text}
      </Link>
    );
  };

  const isLoading = orgLoading || loading;
  const hasActiveFilter = !!(filterStatus || filterSeverity || filterDecisionType || filterAssigned || filterDue || filterAge);

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Decisions</h2>
          <p className="text-xs text-[#8B94A3]">
            Persisted findings from the decision engine. Review by status, severity, and type.
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
            <option value="">All</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Severity</span>
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF]"
          >
            <option value="">All</option>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F5F7FA]">Type</span>
          <select
            value={filterDecisionType}
            onChange={(e) => setFilterDecisionType(e.target.value)}
            className="rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-2 py-1.5 text-[11px] text-[#F5F7FA] outline-none focus:border-[#8B5CFF] min-w-[140px]"
          >
            <option value="">All</option>
            {decisionTypeOptions.map((t) => (
              <option key={t} value={t}>{titleize(t)}</option>
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
              setFilterSeverity('');
              setFilterDecisionType('');
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
        {!isLoading && filteredDecisions.length > 0 && (
          <div className="mb-3 flex items-center gap-4 border-b border-[#1A1A3E] pb-3 flex-wrap">
            <span className="text-[11px] font-semibold text-[#F5F7FA]">
              {filteredDecisions.length} decision{filteredDecisions.length !== 1 ? 's' : ''}
            </span>
            {scanSummary.criticalHigh > 0 && (
              <span className="text-[11px] font-medium text-red-400">
                {scanSummary.criticalHigh} critical / high
              </span>
            )}
            {scanSummary.overdue > 0 && (
              <span className="text-[11px] font-medium text-red-400">
                {scanSummary.overdue} overdue
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
        ) : filteredDecisions.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No decisions yet. Run document analysis to generate and persist findings.
          </p>
        ) : (
          <div className="overflow-x-auto">
            {/* Column order: signal → state → identity → urgency → owner → context → metadata */}
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Severity</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Status</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Title</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Due</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Assigned</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Type</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Last detected</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Document</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Confidence</th>
                  <th className="pb-2 font-medium text-[#8B94A3]">Summary</th>
                </tr>
              </thead>
              <tbody>
                {filteredDecisions.map((row) => {
                  const isCritHigh = row.severity === 'critical' || row.severity === 'high';
                  const assignee = resolveAssignee(row.assignee);
                  const overdue = isDecisionOverdue(row.due_at, row.status);
                  const rowBg = isCritHigh ? 'bg-red-500/[0.04]' : '';
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-[#1A1A3E] last:border-0 transition-colors hover:bg-[#12122E] ${rowBg}`}
                    >
                      {/* Severity — leftmost, immediate visual signal */}
                      <td className="py-2.5 pr-3">
                        <SeverityBadge severity={row.severity} />
                      </td>

                      {/* Status — inline editable, styled to reflect current state */}
                      <td className="py-2.5 pr-3">
                        <div className="flex flex-col gap-1">
                          <select
                            aria-label={`Update status for ${row.title || 'decision'}`}
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
                          href={`/platform/decisions/${row.id}`}
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

                      {/* Type — context */}
                      <td className="py-2.5 pr-3 whitespace-nowrap text-[#8B94A3]">
                        {titleize(row.decision_type)}
                      </td>

                      {/* Last detected — recency */}
                      <td className="py-2.5 pr-3 whitespace-nowrap text-[#8B94A3]">
                        {displayDate(row)}
                      </td>

                      {/* Document — source context */}
                      <td className="py-2.5 pr-3 max-w-[180px] truncate">
                        {row.document_id ? documentDisplay(row) : <span className="text-[#3a3f5a]">—</span>}
                      </td>

                      {/* Confidence — analysis metadata */}
                      <td className="py-2.5 pr-3 text-[#8B94A3]">
                        {displayConfidence(row.confidence)}
                      </td>

                      {/* Summary — detail text */}
                      <td className="py-2.5 max-w-[240px] text-[#8B94A3]" title={row.summary ?? undefined}>
                        {displaySummary(row.summary)}
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
