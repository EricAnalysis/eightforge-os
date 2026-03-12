'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocumentRef = { id: string; title: string | null; name: string } | null;

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
  documents?: DocumentRef | DocumentRef[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['open', 'in_review', 'resolved', 'suppressed'] as const;
const SEVERITY_OPTIONS = ['low', 'medium', 'high'] as const;

// ─── Badges ───────────────────────────────────────────────────────────────────

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DecisionsPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;

  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterSeverity, setFilterSeverity] = useState<string>('');
  const [filterDecisionType, setFilterDecisionType] = useState<string>('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updateErrorId, setUpdateErrorId] = useState<string | null>(null);

  const fetchDecisions = async (orgId: string) => {
    setLoading(true);
    let query = supabase
      .from('decisions')
      .select('id, document_id, decision_type, title, summary, severity, status, confidence, last_detected_at, created_at, documents(id, title, name)')
      .eq('organization_id', orgId)
      .order('last_detected_at', { ascending: false });

    if (filterStatus) query = query.eq('status', filterStatus);
    if (filterSeverity) query = query.eq('severity', filterSeverity);
    if (filterDecisionType) query = query.eq('decision_type', filterDecisionType);

    const { data, error } = await query;
    if (!error && data) setDecisions(data as DecisionRow[]);
    else setDecisions([]);
    setLoading(false);
  };

  useEffect(() => {
    if (orgLoading || !organizationId) {
      if (!orgLoading) setLoading(false);
      return;
    }
    fetchDecisions(organizationId);
  }, [organizationId, orgLoading, filterStatus, filterSeverity, filterDecisionType]);

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

  const decisionTypeOptions = useMemo(() => {
    const set = new Set(decisions.map((d) => d.decision_type).filter(Boolean));
    return Array.from(set).sort();
  }, [decisions]);

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
        className="text-[#7C5CFF] hover:underline"
      >
        {text}
      </Link>
    );
  };

  const isLoading = orgLoading || loading;

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">Decisions</h2>
          <p className="text-xs text-[#8B94A3]">
            Persisted findings from the decision engine. Review by status, severity, and type.
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
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F1F3F5]">Severity</span>
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            className="rounded-md border border-[#1A1F27] bg-[#0A0C10] px-2 py-1.5 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF]"
          >
            <option value="">All</option>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-[#8B94A3]">
          <span className="font-medium text-[#F1F3F5]">Type</span>
          <select
            value={filterDecisionType}
            onChange={(e) => setFilterDecisionType(e.target.value)}
            className="rounded-md border border-[#1A1F27] bg-[#0A0C10] px-2 py-1.5 text-[11px] text-[#F1F3F5] outline-none focus:border-[#7C5CFF] min-w-[140px]"
          >
            <option value="">All</option>
            {decisionTypeOptions.map((t) => (
              <option key={t} value={t}>{titleize(t)}</option>
            ))}
          </select>
        </label>
        {(filterStatus || filterSeverity || filterDecisionType) && (
          <button
            type="button"
            onClick={() => {
              setFilterStatus('');
              setFilterSeverity('');
              setFilterDecisionType('');
            }}
            className="rounded-md border border-[#1A1F27] px-2 py-1.5 text-[11px] text-[#8B94A3] hover:text-[#F1F3F5] hover:bg-[#1A1F27]"
          >
            Clear filters
          </button>
        )}
      </section>

      {/* Table */}
      <section className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-3">
        <div className="mb-3 text-[11px] font-medium text-[#F1F3F5]">Decision list</div>

        {isLoading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : decisions.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">
            No decisions yet. Run document analysis to generate and persist findings.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px] text-[#8B94A3]">
              <thead className="border-b border-[#1A1F27] text-left">
                <tr>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Last detected</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Type</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Title</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Severity</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Status</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Confidence</th>
                  <th className="py-2 pr-3 font-medium text-[#F1F3F5]">Document</th>
                  <th className="py-2 font-medium text-[#F1F3F5]">Summary</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-[#1A1F27] last:border-0 hover:bg-[#13171E]"
                  >
                    <td className="py-2 pr-3 whitespace-nowrap">{displayDate(row)}</td>
                    <td className="py-2 pr-3">{titleize(row.decision_type)}</td>
                    <td className="py-2 pr-3 max-w-[200px] truncate text-[#F1F3F5]" title={row.title}>
                      <Link
                        href={`/platform/decisions/${row.id}`}
                        className="text-[#7C5CFF] hover:underline"
                      >
                        {row.title || '—'}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">
                      <SeverityBadge severity={row.severity} />
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-col gap-1">
                        <select
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
                    <td className="py-2 pr-3">{displayConfidence(row.confidence)}</td>
                    <td className="py-2 pr-3 max-w-[180px] truncate">
                      {row.document_id ? documentDisplay(row) : <span className="text-[#3a3f4a]">—</span>}
                    </td>
                    <td className="py-2 max-w-[240px] text-[#F1F3F5]" title={row.summary ?? undefined}>
                      {displaySummary(row.summary)}
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
