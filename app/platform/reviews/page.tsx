'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOperationalModel } from '@/lib/useOperationalModel';

function toneClass(tone: 'danger' | 'warning' | 'info' | 'success' | 'muted') {
  switch (tone) {
    case 'danger':
      return 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]';
    case 'warning':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'info':
      return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]';
    case 'success':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    default:
      return 'border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-muted)]';
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
    <Link href={href} className={`rounded-lg border p-4 transition-colors hover:bg-[var(--ef-surface-elevated)] ${toneClass(tone)}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em]">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[var(--ef-text-primary)]">{value}</p>
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
        href: '/platform/decisions',
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
          <h2 className="mb-1 text-sm font-semibold text-[var(--ef-text-primary)]">Intelligence</h2>
          <p className="text-xs text-[var(--ef-text-muted)]">
            Diagnostic rollups from the same operational model powering Decision Queue and remediation.
          </p>
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-4 py-3">
          <p className="text-[11px] font-medium text-[var(--ef-critical)]">{error}</p>
        </div>
      ) : null}

      {!loading && operationalModel?.warnings.length ? (
        <div className="space-y-2">
          {operationalModel.warnings.map((warning) => (
            <div key={warning} className="rounded-lg border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-4 py-3 text-[11px] text-[var(--ef-warning-soft)]">
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading
          ? Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
                <div className="h-3 w-24 animate-pulse rounded bg-[var(--ef-surface-elevated)]" />
                <div className="mt-3 h-8 w-16 animate-pulse rounded bg-[var(--ef-surface-elevated)]" />
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

      <section id="needs-review" className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
        <div className="mb-3 border-b border-[var(--ef-surface-elevated)] pb-3">
          <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">Needs Review</h3>
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">Documents still waiting on operator review or correction.</p>
        </div>

        {loading ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">Loading…</p>
        ) : !operationalModel || operationalModel.intelligence.needs_review_documents.length === 0 ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">No linked documents currently need review.</p>
        ) : (
          <div className="space-y-2">
            {operationalModel.intelligence.needs_review_documents.map((item) => (
              <Link key={item.document_id} href={item.href} className="block rounded-md border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-3 hover:bg-[var(--ef-surface-elevated)]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium text-[var(--ef-text-primary)]">{item.title}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                      {item.document_type ?? 'Unknown type'} / {item.review_status.replace(/_/g, ' ')}
                    </p>
                  </div>
                  <div className="text-right text-[10px] uppercase tracking-[0.14em] text-[var(--ef-warning)]">
                    <div>{item.unresolved_finding_count} findings</div>
                    <div>{item.pending_action_count} actions</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section id="blocked" className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
        <div className="mb-3 border-b border-[var(--ef-surface-elevated)] pb-3">
          <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">Blocked Documents</h3>
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">Real source records behind the current blocked count.</p>
        </div>

        {loading ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">Loading…</p>
        ) : !operationalModel || operationalModel.intelligence.blocked_documents.length === 0 ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">No blocked documents are currently active.</p>
        ) : (
          <div className="space-y-2">
            {operationalModel.intelligence.blocked_documents.map((item) => (
              <Link key={item.document_id} href={item.href} className="block rounded-md border border-[var(--ef-critical-a20)] bg-[var(--ef-critical-a05)] px-3 py-3 hover:bg-[var(--ef-critical-a10)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium text-[var(--ef-text-primary)]">{item.title}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                      {item.status_label} / {item.document_type ?? 'Unknown type'}
                    </p>
                  </div>
                  <div className="text-right text-[10px] uppercase tracking-[0.14em] text-[var(--ef-critical-soft)]">
                    <div>{item.blocked_count} blocked</div>
                    <div>{item.unresolved_finding_count} findings</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section id="low-trust" className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
        <div className="mb-3 border-b border-[var(--ef-surface-elevated)] pb-3">
          <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">Low Trust Extraction Modes</h3>
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">Documents still using fallback extraction modes already surfaced in the operational model.</p>
        </div>

        {loading ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">Loading…</p>
        ) : !operationalModel || operationalModel.intelligence.low_trust_documents.length === 0 ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">No low-trust extraction documents are currently flagged.</p>
        ) : (
          <div className="space-y-2">
            {operationalModel.intelligence.low_trust_documents.map((item) => (
              <Link key={item.document_id} href={item.href} className="block rounded-md border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-a08)] px-3 py-3 hover:bg-[var(--ef-warning-bg)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium text-[var(--ef-text-primary)]">{item.title}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                      {item.low_trust_mode?.replace(/_/g, ' ')} / {item.document_type ?? 'Unknown type'}
                    </p>
                  </div>
                  <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--ef-warning-soft)]">{item.status_label}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-4">
        <div className="mb-3 border-b border-[var(--ef-surface-elevated)] pb-3">
          <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">Recent Feedback Exceptions</h3>
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">Incorrect, escalated, or correction-oriented feedback pulled from the shared operational model.</p>
        </div>

        {loading ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">Loading…</p>
        ) : !operationalModel || operationalModel.intelligence.recent_feedback_exceptions.length === 0 ? (
          <p className="text-[11px] text-[var(--ef-text-muted)]">No recent feedback exceptions are currently recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="border-b border-[var(--ef-surface-elevated)] text-left">
                <tr>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Decision</th>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Feedback</th>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Disposition</th>
                  <th className="pb-2 pr-3 font-medium text-[var(--ef-text-muted)]">Reason</th>
                  <th className="pb-2 font-medium text-[var(--ef-text-muted)]">When</th>
                </tr>
              </thead>
              <tbody>
                {operationalModel.intelligence.recent_feedback_exceptions.map((item) => (
                  <tr key={item.id} className="border-b border-[var(--ef-surface-elevated)] last:border-0 hover:bg-[var(--ef-surface-elevated)]">
                    <td className="py-2.5 pr-3">
                      <Link href={item.href} className="font-medium text-[var(--ef-purple-primary)] hover:underline">
                        {item.decision_title}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 text-[var(--ef-text-muted)]">
                      {item.feedback_type ?? '—'}
                    </td>
                    <td className="py-2.5 pr-3 text-[var(--ef-text-muted)]">
                      {item.disposition ?? '—'}
                    </td>
                    <td className="py-2.5 pr-3 text-[var(--ef-text-muted)]">
                      {item.review_error_type ?? '—'}
                    </td>
                    <td className="py-2.5 text-[var(--ef-text-muted)]">
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
