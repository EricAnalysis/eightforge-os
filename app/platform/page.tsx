'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  FloatingCommandBar,
  IntelligenceInsightCard,
  StatusStrip,
  type IntelligenceInsight,
  type StatusStripMetric,
} from '@/components/platform/command-center';
import { buildOperatorGraphData } from '@/lib/operatorGraph';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOperationalModel } from '@/lib/useOperationalModel';
import { OperatorGraphPanel } from '@/components/platform/OperatorGraphPanel';
import { AskOperationsSection } from '@/components/platform/AskOperationsSection';

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'muted';

function buildProjectTabHref(params: {
  projectId: string;
  hash: '#project-decisions' | '#project-actions' | '#project-documents';
  query?: Record<string, string | number | boolean | null | undefined>;
}): string {
  const base = `/platform/projects/${params.projectId}`;
  const queryEntries = Object.entries(params.query ?? {}).filter(([, value]) => value != null);
  if (queryEntries.length === 0) return `${base}${params.hash}`;

  const search = new URLSearchParams();
  for (const [key, value] of queryEntries) {
    search.set(key, String(value));
  }
  return `${base}?${search.toString()}${params.hash}`;
}

function buildLastSyncLabel(value: string | null | undefined): string {
  if (!value) return 'Last sync unavailable';
  const diffMs = Date.now() - new Date(value).getTime();
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

  if (diffMinutes <= 1) return 'Last sync just now';
  if (diffMinutes < 60) return `Last sync ${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `Last sync ${diffHours}h ago`;

  return `Last sync ${Math.floor(diffHours / 24)}d ago`;
}

function DiagnosticLink({
  label,
  value,
  detail,
  href,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  href: string;
  tone: Tone;
}) {
  const badgeClass =
    tone === 'danger'
      ? 'border-red-500/40 bg-red-500/10 text-red-300'
      : tone === 'warning'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
        : tone === 'success'
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : tone === 'brand'
            ? 'border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[#93C5FD]'
            : tone === 'info'
              ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
              : 'border-[#2F3B52] bg-[#243044]/70 text-[#C7D2E3]';

  return (
    <Link
      href={href}
      className="rounded-2xl border border-[#2F3B52]/80 bg-[#111827] p-4 shadow-[0_24px_90px_-64px_rgba(11,16,32,0.95)] transition hover:bg-[#1A2333]"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8]">
          {label}
        </p>
        <span className={`rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${badgeClass}`}>
          {value}
        </span>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-[#C7D2E3]">
        {detail}
      </p>
    </Link>
  );
}

export default function PlatformDashboardPage() {
  const { organization, userId, loading: orgLoading } = useCurrentOrg();
  const { data: operationalModel, loading, error, reload } =
    useOperationalModel(!orgLoading && !!organization?.id);

  const isLoading = orgLoading || loading;

  const counts = useMemo(() => {
    const actions = operationalModel?.actions ?? [];

    return {
      assignedActions: userId
        ? actions.filter((item) => item.assigned_to === userId).length
        : actions.filter((item) => item.assigned_to != null).length,
      highRisk: operationalModel?.intelligence.high_risk_count ?? 0,
      blocked: operationalModel?.intelligence.blocked_count ?? 0,
      recentDocuments: operationalModel?.recent_documents_count ?? 0,
      lowTrust: operationalModel?.intelligence.low_trust_document_count ?? 0,
      feedbackExceptions: operationalModel?.intelligence.recent_feedback_exception_count ?? 0,
      hiddenRows:
        (operationalModel?.superseded_counts.decisions ?? 0) +
        (operationalModel?.superseded_counts.actions ?? 0),
    };
  }, [operationalModel, userId]);

  const statusStripMetrics = useMemo<StatusStripMetric[]>(() => [
    {
      label: 'Actions Assigned',
      value: isLoading ? '...' : counts.assignedActions,
      tone: !isLoading && counts.assignedActions > 0 ? 'success' : 'muted',
      emphasize: !isLoading && counts.assignedActions > 0,
    },
    {
      label: 'High Risk',
      value: isLoading ? '...' : counts.highRisk,
      tone: !isLoading && counts.highRisk > 0 ? 'danger' : 'muted',
      emphasize: !isLoading && counts.highRisk > 0,
    },
    {
      label: 'Blocked',
      value: isLoading ? '...' : counts.blocked,
      tone: !isLoading && counts.blocked > 0 ? 'danger' : 'muted',
      emphasize: !isLoading && counts.blocked > 0,
    },
    {
      label: 'Low Trust',
      value: isLoading ? '...' : counts.lowTrust,
      tone: !isLoading && counts.lowTrust > 0 ? 'warning' : 'muted',
      emphasize: !isLoading && counts.lowTrust > 0,
    },
    {
      label: 'Recent Docs',
      value: isLoading ? '...' : counts.recentDocuments ?? 0,
      tone: !isLoading && (counts.recentDocuments ?? 0) > 0 ? 'info' : 'muted',
      emphasize: !isLoading && (counts.recentDocuments ?? 0) > 0,
    },
  ], [counts, isLoading]);

  const intelligenceInsight = useMemo<IntelligenceInsight>(() => {
    if (isLoading) {
      return {
        title: 'Loading operational intelligence',
        body: 'Workspace signals are being refreshed from the shared operational model.',
        tone: 'muted',
        href: '/platform/reviews',
        ctaLabel: 'Open intelligence',
      };
    }

    if (counts.highRisk > 0) {
      return {
        title: 'High-risk work needs attention',
        body: `${counts.highRisk} high-risk item${counts.highRisk === 1 ? '' : 's'} are currently open across the portfolio and should be reviewed first.`,
        tone: 'danger',
        href: '/platform/decisions?severity=high',
        ctaLabel: 'Open Decision Queue',
      };
    }

    if (counts.blocked > 0) {
      return {
        title: 'Blocked work is constraining flow',
        body: `${counts.blocked} blocked item${counts.blocked === 1 ? '' : 's'} are holding up execution across the workspace.`,
        tone: 'warning',
        href: '/platform/reviews#blocked',
        ctaLabel: 'Review blocked items',
      };
    }

    if (counts.lowTrust > 0) {
      return {
        title: 'Low-trust extraction still needs review',
        body: `${counts.lowTrust} document${counts.lowTrust === 1 ? '' : 's'} are still using lower-trust extraction modes and may need closer operator review.`,
        tone: 'info',
        href: '/platform/reviews#low-trust',
        ctaLabel: 'Inspect trust surface',
      };
    }

    return {
      title: 'Portfolio signals are currently stable',
      body: 'Current rollups and operational diagnostics look healthy, so the command center can stay focused on prioritization and routing.',
      tone: 'success',
      href: '/platform/reviews',
      ctaLabel: 'Review intelligence',
    };
  }, [counts.blocked, counts.highRisk, counts.lowTrust, isLoading]);

  const operatorGraph = useMemo(
    () => buildOperatorGraphData(operationalModel ?? null, null),
    [operationalModel],
  );

  const isEmpty =
    !isLoading &&
    (operationalModel?.recent_documents_count ?? 0) === 0 &&
    (operationalModel?.project_rollups.length ?? 0) === 0 &&
    (operationalModel?.actions.length ?? 0) === 0 &&
    counts.highRisk === 0 &&
    counts.blocked === 0 &&
    counts.lowTrust === 0 &&
    counts.feedbackExceptions === 0;

  return (
    <div className="space-y-6 pb-24">
      <StatusStrip
        metrics={statusStripMetrics}
        lastSyncLabel={buildLastSyncLabel(operationalModel?.generated_at)}
      />

      <AskOperationsSection operationalModel={operationalModel ?? null} loading={isLoading} />

      {error ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
          <p className="text-[11px] font-medium text-red-300">{error}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded-lg border border-red-500/30 px-3 py-1.5 text-[11px] font-medium text-red-300 transition hover:bg-red-500/10"
          >
            Retry
          </button>
        </div>
      ) : null}

      {!isLoading && operationalModel?.warnings.length ? (
        <div className="space-y-2">
          {operationalModel.warnings.map((warning) => (
            <div
              key={warning}
              className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-[11px] text-amber-200"
            >
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      {isEmpty ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[#3B82F6]/30 bg-[#3B82F6]/[0.06] px-5 py-4">
          <div>
            <p className="text-[12px] font-semibold text-[#E5EDF7]">Get started</p>
            <p className="mt-1 text-[11px] text-[#94A3B8]">
              Upload a document to begin generating project rollups, actions, and shared operational context.
            </p>
          </div>
          <Link
            href="/platform/documents"
            className="rounded-xl bg-[#3B82F6] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white transition hover:bg-[#2563EB]"
          >
            Upload Document
          </Link>
        </div>
      ) : null}

      <OperatorGraphPanel data={operatorGraph} />

      <section className="grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
        <section className="rounded-2xl border border-[#2F3B52]/80 bg-[#111827] p-5 shadow-[0_24px_90px_-64px_rgba(11,16,32,0.95)]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#94A3B8]">
                Rollups
              </p>
              <h2 className="mt-2 text-[15px] font-semibold tracking-tight text-[#E5EDF7]">
                Project Rollups
              </h2>
            </div>
            <Link
              href="/platform/projects"
              className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3B82F6] transition hover:text-[#60A5FA]"
            >
              View All
            </Link>
          </div>

          {isLoading ? (
            <div className="rounded-xl border border-[#2F3B52]/70 bg-[#0F1728] px-4 py-4 text-[12px] text-[#94A3B8]">
              Loading project rollups...
            </div>
          ) : !operationalModel || operationalModel.project_rollups.length === 0 ? (
            <div className="rounded-xl border border-[#2F3B52]/70 bg-[#0F1728] px-4 py-4 text-[12px] text-[#94A3B8]">
              No project context is connected yet.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {operationalModel.project_rollups.slice(0, 4).map((item) => (
                <div
                  key={item.project.id}
                  className="relative rounded-xl border border-[#2F3B52]/70 bg-[#0F1728] p-4 transition hover:bg-[#1A2333]"
                >
                  <Link
                    href={item.href}
                    aria-label={`Open ${item.project.name}`}
                    className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]"
                  />
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-[#E5EDF7]">
                        {item.project.name}
                      </p>
                      {item.project.code ? (
                        <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[#94A3B8]">
                          {item.project.code}
                        </p>
                      ) : null}
                    </div>
                    <span
                      className={`rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] ${
                        item.rollup.status.key === 'blocked'
                          ? 'border-red-500/40 bg-red-500/10 text-red-300'
                          : item.rollup.status.key === 'needs_review' ||
                              item.rollup.status.key === 'attention_required'
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      }`}
                    >
                      {item.rollup.status.label}
                    </span>
                  </div>

                  <div className="relative z-10 mt-4 grid grid-cols-2 gap-2 text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
                    <div className="rounded-lg border border-[#2F3B52]/70 bg-[#111827] px-3 py-2">
                      {item.rollup.unresolved_finding_count} findings
                    </div>
                    <Link
                      href={buildProjectTabHref({
                        projectId: item.project.id,
                        hash: '#project-actions',
                      })}
                      className="rounded-lg border border-[#2F3B52]/70 bg-[#111827] px-3 py-2 transition hover:bg-[#1A2333] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]"
                    >
                      {item.rollup.open_document_action_count} actions
                    </Link>
                    <Link
                      href={buildProjectTabHref({
                        projectId: item.project.id,
                        hash: '#project-documents',
                      })}
                      className="rounded-lg border border-[#2F3B52]/70 bg-[#111827] px-3 py-2 transition hover:bg-[#1A2333] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]"
                    >
                      {item.rollup.linked_document_count ?? item.rollup.processed_document_count} docs
                    </Link>
                    <Link
                      href={buildProjectTabHref({
                        projectId: item.project.id,
                        hash: '#project-decisions',
                        query: { filter: 'blocked' },
                      })}
                      className="rounded-lg border border-[#2F3B52]/70 bg-[#111827] px-3 py-2 transition hover:bg-[#1A2333] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#60A5FA]"
                    >
                      {item.rollup.blocked_count} blocked
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          {!isLoading &&
          counts.lowTrust === 0 &&
          counts.feedbackExceptions === 0 &&
          counts.hiddenRows === 0 ? (
            <div className="rounded-2xl border border-[#2F3B52]/80 bg-[#111827] p-4 text-[12px] text-[#C7D2E3] shadow-[0_24px_90px_-64px_rgba(11,16,32,0.95)]">
              No trust issues detected in current workspace
            </div>
          ) : (
            <>
              {isLoading || counts.lowTrust > 0 ? (
                <DiagnosticLink
                  label="Low Trust Surface"
                  value={isLoading ? 0 : counts.lowTrust}
                  detail={
                    isLoading
                      ? 'Loading extraction trust diagnostics...'
                      : `${counts.lowTrust} document${counts.lowTrust === 1 ? '' : 's'} still depend on lower-trust extraction modes.`
                  }
                  href="/platform/reviews#low-trust"
                  tone={!isLoading && counts.lowTrust > 0 ? 'warning' : 'success'}
                />
              ) : null}

              {isLoading || counts.feedbackExceptions > 0 ? (
                <DiagnosticLink
                  label="Feedback Exceptions"
                  value={isLoading ? 0 : counts.feedbackExceptions}
                  detail={
                    isLoading
                      ? 'Loading feedback diagnostics...'
                      : `${counts.feedbackExceptions} recent feedback exception${counts.feedbackExceptions === 1 ? '' : 's'} need follow-up.`
                  }
                  href="/platform/reviews"
                  tone={!isLoading && counts.feedbackExceptions > 0 ? 'danger' : 'info'}
                />
              ) : null}

              {isLoading || counts.hiddenRows > 0 ? (
                <DiagnosticLink
                  label="Filtered Stale Rows"
                  value={isLoading ? 0 : counts.hiddenRows}
                  detail={
                    isLoading
                      ? 'Loading queue hygiene diagnostics...'
                      : `${counts.hiddenRows} superseded generated row${counts.hiddenRows === 1 ? '' : 's'} are hidden from the active queue.`
                  }
                  href="/platform/reviews"
                  tone={!isLoading && counts.hiddenRows > 0 ? 'brand' : 'muted'}
                />
              ) : null}
            </>
          )}
        </section>
      </section>

      <IntelligenceInsightCard insight={intelligenceInsight} />

      {organization && (
        <PortfolioTeaserCard organizationId={organization.id} />
      )}

      <FloatingCommandBar />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Portfolio teaser — lightweight summary linking to /platform/portfolio
// ---------------------------------------------------------------------------

type PortfolioSummary = {
  totalRequiresVerification: number;
  totalAtRisk: number;
  projectsRequiringReview: number;
};

function formatShortCurrency(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toFixed(0)}`;
}

function PortfolioTeaserCard({ organizationId }: { organizationId: string }) {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/portfolio/summary?organizationId=${organizationId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: PortfolioSummary | null) => {
        if (!cancelled) { setSummary(data); setLoading(false); }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [organizationId]);

  const metrics: Array<{ label: string; value: string; colorClass: string }> = [
    {
      label: 'Requires Verification',
      value: loading ? '—' : formatShortCurrency(summary?.totalRequiresVerification ?? 0),
      colorClass: 'text-red-300',
    },
    {
      label: 'At Risk',
      value: loading ? '—' : formatShortCurrency(summary?.totalAtRisk ?? 0),
      colorClass: 'text-amber-200',
    },
    {
      label: 'Needs Review',
      value: loading ? '—' : `${summary?.projectsRequiringReview ?? 0}`,
      colorClass: 'text-sky-300',
    },
  ];

  return (
    <section className="rounded-2xl border border-[#2F3B52]/80 bg-[#111827] p-5 shadow-[0_24px_90px_-64px_rgba(11,16,32,0.95)]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#94A3B8]">
            Workspace
          </p>
          <h2 className="mt-2 text-[15px] font-semibold tracking-tight text-[#E5EDF7]">
            Portfolio Command Center
          </h2>
          <p className="mt-1 text-[11px] text-[#94A3B8]">
            Cross-project approval exposure and review triage
          </p>
        </div>
        <Link
          href="/platform/portfolio"
          className="shrink-0 rounded-xl border border-[#2F3B52]/80 bg-[#1A2333] px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3B82F6] transition hover:border-[#3B82F6]/50 hover:text-[#60A5FA]"
        >
          Open →
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {metrics.map((m) => (
          <div
            key={m.label}
            className="rounded-xl border border-[#2F3B52]/70 bg-[#0F1728] px-4 py-3"
          >
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">{m.label}</p>
            <p className={`mt-2 text-[20px] font-bold tabular-nums ${m.colorClass}`}>
              {m.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
