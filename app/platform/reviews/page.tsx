'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOperationalModel } from '@/lib/useOperationalModel';

function toneClass(tone: 'danger' | 'warning' | 'info' | 'success' | 'muted') {
  switch (tone) {
    case 'danger':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'warning':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    case 'info':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-200';
    case 'success':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
    default:
      return 'border-[#1A1A3E] bg-[#0A0A20] text-[#8B94A3]';
  }
}

function MetricCard({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: number;
  href: string;
  tone: 'danger' | 'warning' | 'info' | 'success' | 'muted';
}) {
  return (
    <Link href={href} className={`rounded-lg border p-4 transition-colors hover:bg-[#12122E] ${toneClass(tone)}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em]">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[#F5F7FA]">{value}</p>
    </Link>
  );
}

export default function ReviewsPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const { data: operationalModel, loading, error } =
    useOperationalModel(!orgLoading && !!organization?.id);

  const metrics = useMemo(() => {
    if (!operationalModel) return [];

    return [
      {
        label: 'Open decisions',
        value: operationalModel.intelligence.open_decisions_count,
        href: '/platform/decisions',
        tone: operationalModel.intelligence.open_decisions_count > 0 ? 'warning' : 'success',
      },
      {
        label: 'Open actions',
        value: operationalModel.intelligence.open_actions_count,
        href: '/platform/workflows',
        tone: operationalModel.intelligence.open_actions_count > 0 ? 'warning' : 'success',
      },
      {
        label: 'Needs review',
        value: operationalModel.intelligence.needs_review_count,
        href: '/platform/reviews#needs-review',
        tone: operationalModel.intelligence.needs_review_count > 0 ? 'warning' : 'success',
      },
      {
        label: 'Blocked',
        value: operationalModel.intelligence.blocked_count,
        href: '/platform/reviews#blocked',
        tone: operationalModel.intelligence.blocked_count > 0 ? 'danger' : 'success',
      },
      {
        label: 'High risk',
        value: operationalModel.intelligence.high_risk_count,
        href: '/platform/decisions?severity=high',
        tone: operationalModel.intelligence.high_risk_count > 0 ? 'danger' : 'muted',
      },
      {
        label: 'Low trust docs',
        value: operationalModel.intelligence.low_trust_document_count,
        href: '/platform/reviews#low-trust',
        tone: operationalModel.intelligence.low_trust_document_count > 0 ? 'warning' : 'muted',
      },
    ] as const;
  }, [operationalModel]);

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F5F7FA]">Intelligence</h2>
          <p className="text-xs text-[#8B94A3]">
            Diagnostic rollups from the same operational model powering Decision Queue and My Actions.
          </p>
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
          <p className="text-[11px] font-medium text-red-400">{error}</p>
        </div>
      ) : null}

      {!loading && operationalModel?.warnings.length ? (
        <div className="space-y-2">
          {operationalModel.warnings.map((warning) => (
            <div key={warning} className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-[11px] text-amber-200">
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading
          ? Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
                <div className="h-3 w-24 animate-pulse rounded bg-[#1A1A3E]" />
                <div className="mt-3 h-8 w-16 animate-pulse rounded bg-[#1A1A3E]" />
              </div>
            ))
          : metrics.map((metric) => (
              <MetricCard
                key={metric.label}
                label={metric.label}
                value={metric.value}
                href={metric.href}
                tone={metric.tone}
              />
            ))}
      </section>

      <section id="needs-review" className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 border-b border-[#1A1A3E] pb-3">
          <h3 className="text-sm font-semibold text-[#F5F7FA]">Needs Review</h3>
          <p className="mt-1 text-[11px] text-[#8B94A3]">Documents still waiting on operator review or correction.</p>
        </div>

        {loading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : !operationalModel || operationalModel.intelligence.needs_review_documents.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No linked documents currently need review.</p>
        ) : (
          <div className="space-y-2">
            {operationalModel.intelligence.needs_review_documents.map((item) => (
              <Link key={item.document_id} href={item.href} className="block rounded-md border border-[#1A1A3E] bg-[#0A0A20] px-3 py-3 hover:bg-[#12122E]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium text-[#F5F7FA]">{item.title}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[#8B94A3]">
                      {item.document_type ?? 'Unknown type'} / {item.review_status.replace(/_/g, ' ')}
                    </p>
                  </div>
                  <div className="text-right text-[10px] uppercase tracking-[0.14em] text-[#F59E0B]">
                    <div>{item.unresolved_finding_count} findings</div>
                    <div>{item.pending_action_count} actions</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section id="blocked" className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 border-b border-[#1A1A3E] pb-3">
          <h3 className="text-sm font-semibold text-[#F5F7FA]">Blocked Documents</h3>
          <p className="mt-1 text-[11px] text-[#8B94A3]">Real source records behind the current blocked count.</p>
        </div>

        {loading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : !operationalModel || operationalModel.intelligence.blocked_documents.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No blocked documents are currently active.</p>
        ) : (
          <div className="space-y-2">
            {operationalModel.intelligence.blocked_documents.map((item) => (
              <Link key={item.document_id} href={item.href} className="block rounded-md border border-red-500/20 bg-red-500/5 px-3 py-3 hover:bg-red-500/10">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium text-[#F5F7FA]">{item.title}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[#8B94A3]">
                      {item.status_label} / {item.document_type ?? 'Unknown type'}
                    </p>
                  </div>
                  <div className="text-right text-[10px] uppercase tracking-[0.14em] text-red-300">
                    <div>{item.blocked_count} blocked</div>
                    <div>{item.unresolved_finding_count} findings</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section id="low-trust" className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 border-b border-[#1A1A3E] pb-3">
          <h3 className="text-sm font-semibold text-[#F5F7FA]">Low Trust Extraction Modes</h3>
          <p className="mt-1 text-[11px] text-[#8B94A3]">Documents still using fallback extraction modes already surfaced in the operational model.</p>
        </div>

        {loading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : !operationalModel || operationalModel.intelligence.low_trust_documents.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No low-trust extraction documents are currently flagged.</p>
        ) : (
          <div className="space-y-2">
            {operationalModel.intelligence.low_trust_documents.map((item) => (
              <Link key={item.document_id} href={item.href} className="block rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-3 hover:bg-amber-500/10">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium text-[#F5F7FA]">{item.title}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[#8B94A3]">
                      {item.low_trust_mode?.replace(/_/g, ' ')} / {item.document_type ?? 'Unknown type'}
                    </p>
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.16em] text-amber-300">{item.status_label}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-[#1A1A3E] bg-[#0E0E2A] p-4">
        <div className="mb-3 border-b border-[#1A1A3E] pb-3">
          <h3 className="text-sm font-semibold text-[#F5F7FA]">Recent Feedback Exceptions</h3>
          <p className="mt-1 text-[11px] text-[#8B94A3]">Incorrect, escalated, or correction-oriented feedback pulled from the shared operational model.</p>
        </div>

        {loading ? (
          <p className="text-[11px] text-[#8B94A3]">Loading…</p>
        ) : !operationalModel || operationalModel.intelligence.recent_feedback_exceptions.length === 0 ? (
          <p className="text-[11px] text-[#8B94A3]">No recent feedback exceptions are currently recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[#1A1A3E] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Decision</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Feedback</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Disposition</th>
                  <th className="pb-2 pr-3 font-medium text-[#8B94A3]">Reason</th>
                  <th className="pb-2 font-medium text-[#8B94A3]">When</th>
                </tr>
              </thead>
              <tbody>
                {operationalModel.intelligence.recent_feedback_exceptions.map((item) => (
                  <tr key={item.id} className="border-b border-[#1A1A3E] last:border-0 hover:bg-[#12122E]">
                    <td className="py-2.5 pr-3">
                      <Link href={item.href} className="font-medium text-[#8B5CFF] hover:underline">
                        {item.decision_title}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 text-[#8B94A3]">
                      {item.feedback_type ?? '—'}
                    </td>
                    <td className="py-2.5 pr-3 text-[#8B94A3]">
                      {item.disposition ?? '—'}
                    </td>
                    <td className="py-2.5 pr-3 text-[#8B94A3]">
                      {item.review_error_type ?? '—'}
                    </td>
                    <td className="py-2.5 text-[#8B94A3]">
                      {new Date(item.created_at).toLocaleString()}
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
