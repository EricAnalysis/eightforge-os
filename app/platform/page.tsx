'use client';

import Link from 'next/link';
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOperationalModel } from '@/lib/useOperationalModel';
import type {
  OperationalDecisionQueueItem,
  OperationalProjectRollupItem,
} from '@/lib/server/operationalQueue';
import type { ActionableItemSummary } from '@/types/executionQueue';

type QueueAction = OperationalProjectRollupItem['rollup']['pending_actions'][number];

type AttentionMetric = {
  label: string;
  value: string | number;
  subtext: string;
  tone: 'danger' | 'warning' | 'brand' | 'muted';
};

type CriticalActionCardItem = {
  id: string;
  href: string;
  severityLabel: 'BLOCKER' | 'WARNING';
  severityTone: 'danger' | 'warning';
  title: string;
  projectLabel: string;
  context: string;
  atRiskLabel: string | null;
};

type ProjectRollupRow = {
  id: string;
  href: string;
  projectLabel: string;
  projectCode: string | null;
  statusLabel: string;
  statusKey: string;
  blockers: number;
  atRiskLabel: string;
  atRiskHint: string | null;
  pendingDecisions: number;
  nextAction: string;
  lastActivityLabel: string;
  searchText: string;
};

const EMPTY_ACTIONABLE_SUMMARY: ActionableItemSummary = {
  total: 0,
  blocked: 0,
  needs_review: 0,
  needs_verification: 0,
  by_project: {},
  highest_severity: null,
};

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

function formatShortCurrency(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
  return `$${Math.round(amount)}`;
}

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return '--';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return '--';

  const diffMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (diffMinutes <= 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function titleize(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function statusBadgeClass(statusKey: string): string {
  if (statusKey === 'blocked') {
    return 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]';
  }
  if (statusKey === 'needs_review') {
    return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
  }
  if (statusKey === 'attention_required') {
    return 'border-[var(--ef-purple-primary-a35)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]';
  }
  return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
}

function severityBadgeClass(tone: CriticalActionCardItem['severityTone']): string {
  return tone === 'danger'
    ? 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]'
    : 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
}

function metricToneClass(tone: AttentionMetric['tone']): string {
  if (tone === 'danger') return 'border-[var(--ef-critical-a20)] bg-[var(--ef-critical-a05)] text-[var(--ef-critical-soft)]';
  if (tone === 'warning') return 'border-[var(--ef-warning-a20)] bg-[var(--ef-warning-a08)] text-[var(--ef-warning-soft)]';
  if (tone === 'brand') return 'border-[var(--ef-purple-primary-a25)] bg-[var(--ef-purple-primary)]/[0.08] text-[var(--ef-purple-glow)]';
  return 'border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-primary)]';
}

function primaryRiskAmount(action: QueueAction): number | null {
  return (
    action.at_risk_amount ??
    action.requires_verification_amount ??
    action.blocked_amount ??
    null
  );
}

function formatRiskLabel(amount: number | null): string {
  return amount != null && amount > 0 ? formatShortCurrency(amount) : 'Not calculated';
}

function buildActionContext(action: QueueAction): string {
  const parts = [
    action.invoice_number ? `Invoice ${action.invoice_number}` : null,
    action.variance_label ? `Variance ${action.variance_label}` : null,
    action.source_document_title ?? titleize(action.source_document_type),
    action.next_step,
  ].filter((value): value is string => Boolean(value));

  if (parts.length === 0) {
    return 'Open the linked project queue item and review the approval context.';
  }

  return truncateText(parts.slice(0, 3).join(' | '), 140);
}

function buildDecisionContext(item: OperationalDecisionQueueItem): string {
  const detail = item.evidence_summary?.trim() || item.summary?.trim() || null;
  const parts = [
    item.source_document_title,
    titleize(item.source_document_type),
    detail,
  ].filter((value): value is string => Boolean(value));

  if (parts.length === 0) {
    return 'Review the linked queue item for the latest blocker context.';
  }

  return truncateText(parts.join(' | '), 140);
}

function pickProjectNextAction(
  rollupItem: OperationalProjectRollupItem,
  decision: OperationalDecisionQueueItem | null,
): string {
  const primaryAction = rollupItem.rollup.pending_actions[0];
  if (primaryAction?.next_step) return primaryAction.next_step;
  if (primaryAction?.title) return primaryAction.title;
  if (decision?.title) return decision.title;
  return 'Open project queue';
}

function latestProjectTimestamp(
  projectId: string,
  decisions: OperationalDecisionQueueItem[],
  fallback: string,
): string {
  let latest = new Date(fallback).getTime();

  for (const decision of decisions) {
    if (decision.project_id !== projectId) continue;
    const timestamp = new Date(decision.detected_at ?? decision.created_at).getTime();
    if (!Number.isNaN(timestamp) && timestamp > latest) latest = timestamp;
  }

  return Number.isFinite(latest) ? new Date(latest).toISOString() : fallback;
}

function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h2 className="text-[18px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
        {title}
      </h2>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function ArrowLinkLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span>{children}</span>
      <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
        <path
          d="M3 8H13M9 4L13 8L9 12"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export default function PlatformDashboardPage() {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const { data: operationalModel, loading, error, reload } =
    useOperationalModel(!orgLoading && !!organization?.id);
  const [actionableSummary, setActionableSummary] = useState<ActionableItemSummary>(
    EMPTY_ACTIONABLE_SUMMARY,
  );
  const [actionableSummaryLoading, setActionableSummaryLoading] = useState(false);
  const [projectSearchValue, setProjectSearchValue] = useState('');
  const deferredProjectSearch = useDeferredValue(projectSearchValue);

  const loadActionableSummary = useCallback(async () => {
    if (orgLoading || !organization?.id) {
      setActionableSummary(EMPTY_ACTIONABLE_SUMMARY);
      setActionableSummaryLoading(false);
      return;
    }

    setActionableSummaryLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        setActionableSummary(EMPTY_ACTIONABLE_SUMMARY);
        setActionableSummaryLoading(false);
        return;
      }

      const response = await fetch('/api/actionable-summary', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((body as { error?: string }).error ?? 'Failed to load actionable summary.');
      }

      setActionableSummary(
        (body as { summary?: ActionableItemSummary }).summary ?? EMPTY_ACTIONABLE_SUMMARY,
      );
    } catch (summaryError) {
      console.warn(
        '[platform] actionable summary unavailable:',
        summaryError instanceof Error ? summaryError.message : summaryError,
      );
      setActionableSummary(EMPTY_ACTIONABLE_SUMMARY);
    } finally {
      setActionableSummaryLoading(false);
    }
  }, [orgLoading, organization?.id]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadActionableSummary();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [loadActionableSummary]);

  const isLoading = orgLoading || loading || actionableSummaryLoading;
  const decisions = useMemo(
    () => operationalModel?.decisions ?? [],
    [operationalModel?.decisions],
  );
  const rollups = useMemo(
    () => operationalModel?.project_rollups ?? [],
    [operationalModel?.project_rollups],
  );
  const warnings = useMemo(
    () => operationalModel?.warnings ?? [],
    [operationalModel?.warnings],
  );

  const projectDecisionCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const decision of decisions) {
      if (!decision.project_id) continue;
      counts.set(decision.project_id, (counts.get(decision.project_id) ?? 0) + 1);
    }
    return counts;
  }, [decisions]);

  const decisionByProjectId = useMemo(() => {
    const map = new Map<string, OperationalDecisionQueueItem>();
    for (const decision of decisions) {
      if (!decision.project_id || map.has(decision.project_id)) continue;
      map.set(decision.project_id, decision);
    }
    return map;
  }, [decisions]);

  const attentionMetrics = useMemo<AttentionMetric[]>(() => {
    const blockedProjects = rollups.filter(
      (item) => item.rollup.status.key === 'blocked' || item.rollup.blocked_count > 0,
    ).length;
    const actionableProjectCount = Object.keys(actionableSummary.by_project).length;

    return [
      {
        label: 'Blocked Projects',
        value: isLoading ? '...' : blockedProjects,
        subtext: isLoading
          ? 'Refreshing portfolio blockers'
          : `${operationalModel?.intelligence.blocked_count ?? 0} blocker${(operationalModel?.intelligence.blocked_count ?? 0) === 1 ? '' : 's'} active across the queue`,
        tone: blockedProjects > 0 ? 'danger' : 'muted',
      },
      {
        label: 'High Risk Projects',
        value: isLoading ? '...' : actionableProjectCount,
        subtext: isLoading
          ? 'Refreshing high-severity items'
          : actionableSummary.blocked > 0
            ? `${actionableSummary.blocked} blocked items open`
            : `${actionableSummary.needs_review} items need review`,
        tone: actionableProjectCount > 0 ? 'warning' : 'muted',
      },
      {
        label: 'Pending Decisions',
        value: isLoading ? '...' : actionableSummary.total,
        subtext: isLoading
          ? 'Refreshing decision queue'
          : 'Current operator actions awaiting review',
        tone: actionableSummary.total > 0 ? 'brand' : 'muted',
      },
      {
        label: 'Needs Review',
        value: isLoading ? '...' : operationalModel?.intelligence.needs_review_count ?? 0,
        subtext: isLoading
          ? 'Refreshing review surface'
          : `${operationalModel?.intelligence.needs_review_documents.length ?? 0} document${(operationalModel?.intelligence.needs_review_documents.length ?? 0) === 1 ? '' : 's'} currently waiting for review`,
        tone: (operationalModel?.intelligence.needs_review_count ?? 0) > 0 ? 'warning' : 'muted',
      },
    ];
  }, [actionableSummary, decisions.length, isLoading, operationalModel, rollups]);

  const criticalActions = useMemo<CriticalActionCardItem[]>(() => {
    const rollupActions = rollups.flatMap((rollupItem) =>
      rollupItem.rollup.pending_actions.slice(0, 2).map((action) => {
        const riskAmount = primaryRiskAmount(action);
        const isBlocker =
          action.approval_status === 'blocked' ||
          (action.blocked_amount ?? 0) > 0 ||
          rollupItem.rollup.status.key === 'blocked';
        const severityLabel: CriticalActionCardItem['severityLabel'] = isBlocker
          ? 'BLOCKER'
          : 'WARNING';
        const severityTone: CriticalActionCardItem['severityTone'] = isBlocker
          ? 'danger'
          : 'warning';

        return {
          id: `${rollupItem.project.id}:${action.id}`,
          href: action.href,
          severityLabel,
          severityTone,
          title: action.title,
          projectLabel: rollupItem.project.name,
          context: buildActionContext(action),
          atRiskLabel: riskAmount != null && riskAmount > 0 ? formatRiskLabel(riskAmount) : null,
        };
      }),
    );

    const decisionActions = decisions
      .filter(
        (item) =>
          item.blocked ||
          item.severity === 'critical' ||
          item.severity === 'high' ||
          item.review_status === 'needs_correction',
      )
      .map((item) => {
        const isBlocker = item.blocked || item.severity === 'critical';
        const severityLabel: CriticalActionCardItem['severityLabel'] = isBlocker
          ? 'BLOCKER'
          : 'WARNING';
        const severityTone: CriticalActionCardItem['severityTone'] = isBlocker
          ? 'danger'
          : 'warning';

        return {
          id: item.id,
          href: item.deep_link_target,
          severityLabel,
          severityTone,
          title: item.title,
          projectLabel: item.project_label ?? 'Unscoped project',
          context: buildDecisionContext(item),
          atRiskLabel: null,
        };
      });

    const deduped: CriticalActionCardItem[] = [];
    const seen = new Set<string>();
    for (const candidate of [...rollupActions, ...decisionActions]) {
      const key = `${candidate.href}:${candidate.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
      if (deduped.length === 6) break;
    }
    return deduped;
  }, [decisions, rollups]);

  const projectRows = useMemo<ProjectRollupRow[]>(() => {
    return rollups.map((rollupItem) => {
      const leadAction = rollupItem.rollup.pending_actions[0] ?? null;
      const leadDecision = decisionByProjectId.get(rollupItem.project.id) ?? null;
      const atRiskAmount = leadAction ? primaryRiskAmount(leadAction) : null;
      const lastActivity = latestProjectTimestamp(
        rollupItem.project.id,
        decisions,
        rollupItem.project.created_at,
      );
      const nextAction = pickProjectNextAction(rollupItem, leadDecision);
      const href =
        rollupItem.rollup.pending_actions.length > 0
          ? buildProjectTabHref({
              projectId: rollupItem.project.id,
              hash: '#project-actions',
            })
          : buildProjectTabHref({
              projectId: rollupItem.project.id,
              hash: '#project-decisions',
            });

      return {
        id: rollupItem.project.id,
        href,
        projectLabel: rollupItem.project.name,
        projectCode: rollupItem.project.code,
        statusLabel: rollupItem.rollup.status.label,
        statusKey: rollupItem.rollup.status.key,
        blockers: rollupItem.rollup.blocked_count,
        atRiskLabel: formatRiskLabel(atRiskAmount),
        atRiskHint:
          atRiskAmount != null && atRiskAmount > 0 ? 'Top exposure' : null,
        pendingDecisions: projectDecisionCountById.get(rollupItem.project.id) ?? 0,
        nextAction,
        lastActivityLabel: formatRelativeTime(lastActivity),
        searchText: normalizeSearchText(
          [
            rollupItem.project.name,
            rollupItem.project.code,
            rollupItem.rollup.status.label,
            nextAction,
          ].filter(Boolean).join(' '),
        ),
      };
    });
  }, [
    decisionByProjectId,
    decisions,
    projectDecisionCountById,
    rollups,
  ]);

  const filteredProjectRows = useMemo(() => {
    const query = normalizeSearchText(deferredProjectSearch);
    if (!query) return projectRows;
    return projectRows.filter((row) => row.searchText.includes(query));
  }, [deferredProjectSearch, projectRows]);

  return (
    <div className="mx-auto max-w-[1600px] space-y-8 px-4 py-6 pb-10 sm:px-6 lg:px-8">
      <section className="space-y-4 border-b border-[var(--ef-surface-elevated)] pb-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--ef-purple-glow)]">
              Command Center
            </p>
            <h1 className="mt-3 text-[30px] font-semibold tracking-tight text-[var(--ef-text-primary)] sm:text-[34px]">
              Command Center
            </h1>
            <p className="mt-2 text-[14px] text-[var(--ef-text-muted)]">
              Execute decisions. Resolve blockers. Move work forward.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-[var(--ef-purple-primary-a25)] bg-[var(--ef-purple-primary-a10)] px-4 py-2 text-[11px] font-medium text-[var(--ef-purple-glow)]">
              <span className="h-2 w-2 rounded-full bg-[var(--ef-purple-glow)] shadow-[0_0_12px_var(--ef-purple-glow-a70)]" />
              <span>{buildLastSyncLabel(operationalModel?.generated_at)}</span>
            </div>
          </div>
        </div>

        {error ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] font-medium text-[var(--ef-critical-soft)]">{error}</p>
            <button
              type="button"
              onClick={() => void reload()}
              className="inline-flex shrink-0 items-center justify-center rounded-xl border border-[var(--ef-critical-a30)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-critical-soft)] transition hover:bg-[var(--ef-critical-a10)]"
            >
              Retry
            </button>
          </div>
        ) : null}

        {!isLoading && warnings.length > 0 ? (
          <div className="grid gap-2">
            {warnings.map((warning) => (
              <div
                key={warning}
                className="rounded-2xl border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-4 py-3 text-[11px] text-[var(--ef-warning-soft)]"
              >
                {warning}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="What Needs Your Attention"
          action={(
            <Link
              href="/platform/decisions"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-purple-glow)] transition hover:bg-[var(--ef-purple-primary-a18)]"
            >
              View Decision Queue
            </Link>
          )}
        />

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {attentionMetrics.map((metric) => (
            <div
              key={metric.label}
              className={`rounded-2xl border p-5 ${metricToneClass(metric.tone)}`}
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                {metric.label}
              </p>
              <p className="mt-4 text-[32px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
                {metric.value}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--ef-text-muted)]">
                {metric.subtext}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Critical Actions"
          action={(
            <Link
              href="/platform/decisions"
              className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-glow)] transition hover:text-[var(--ef-purple-glow)]"
            >
              <ArrowLinkLabel>View all actions</ArrowLinkLabel>
            </Link>
          )}
        />

        {isLoading ? (
          <div className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-5 py-10 text-[13px] text-[var(--ef-text-muted)]">
            Loading critical actions...
          </div>
        ) : criticalActions.length === 0 ? (
          <div className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-5 py-10">
            <p className="text-[14px] font-medium text-[var(--ef-text-primary)]">
              No critical actions are active right now.
            </p>
            <p className="mt-2 text-[12px] text-[var(--ef-text-muted)]">
              The queue is currently clear of blocker-level items and approval issues needing immediate review.
            </p>
            {rollups.length === 0 ? (
              <Link
                href="/platform/documents"
                className="mt-4 inline-flex items-center justify-center rounded-xl bg-[var(--ef-purple-primary)] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white transition hover:bg-[var(--ef-purple-glow)]"
              >
                Upload Document
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {criticalActions.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                className="group flex h-full flex-col justify-between rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] p-5 transition hover:border-[var(--ef-purple-primary-a40)] hover:bg-[var(--ef-background-secondary)]"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${severityBadgeClass(item.severityTone)}`}
                    >
                      {item.severityLabel}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                      {item.projectLabel}
                    </span>
                  </div>

                  <h3 className="mt-4 text-[18px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
                    {item.title}
                  </h3>

                  <p className="mt-3 text-[13px] leading-relaxed text-[var(--ef-text-muted)]">
                    {item.context}
                  </p>

                  {item.atRiskLabel ? (
                    <div className="mt-4 inline-flex rounded-full border border-[var(--ef-purple-primary-a20)] bg-[var(--ef-purple-primary-a10)] px-3 py-1 text-[11px] font-medium text-[var(--ef-purple-glow)]">
                      At Risk: {item.atRiskLabel}
                    </div>
                  ) : null}
                </div>

                <div className="mt-5 inline-flex items-center justify-between rounded-xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-purple-glow)] transition group-hover:border-[var(--ef-purple-primary-a30)]">
                  <span>Review</span>
                  <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                    <path
                      d="M3 8H13M9 4L13 8L9 12"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeader title="Project Rollups" />

        <div className="rounded-2xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)]">
          <div className="flex flex-col gap-3 border-b border-[var(--ef-surface-elevated)] px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
              <label className="relative w-full max-w-md">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ef-text-faint)]">
                  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
                    <circle cx="8.75" cy="8.75" r="4.5" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M12.25 12.25L16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </span>
                <input
                  type="search"
                  value={projectSearchValue}
                  onChange={(event) => setProjectSearchValue(event.target.value)}
                  placeholder="Search projects"
                  className="w-full rounded-xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] py-2.5 pl-9 pr-4 text-[12px] text-[var(--ef-text-primary)] outline-none transition placeholder:text-[var(--ef-text-faint)] focus:border-[var(--ef-purple-primary)]"
                />
              </label>

              <button
                type="button"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--ef-surface-elevated)] bg-[var(--ef-background-secondary)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-secondary)] transition hover:border-[var(--ef-purple-primary-a35)] hover:text-[var(--ef-text-primary)]"
              >
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                  <path
                    d="M2.5 4H13.5M4.5 8H11.5M6.5 12H9.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
                <span>Filter</span>
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className="px-4 py-10 text-[13px] text-[var(--ef-text-muted)]">
              Loading project rollups...
            </div>
          ) : filteredProjectRows.length === 0 ? (
            <div className="px-4 py-10">
              <p className="text-[14px] font-medium text-[var(--ef-text-primary)]">
                {projectRows.length === 0 ? 'No project rollups are connected yet.' : 'No projects match that search.'}
              </p>
              <p className="mt-2 text-[12px] text-[var(--ef-text-muted)]">
                {projectRows.length === 0
                  ? 'Upload documents to generate project summaries, blockers, and approval actions.'
                  : 'Try a different project name, code, or action keyword.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left">
                <thead>
                  <tr className="border-b border-[var(--ef-surface-elevated)] text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-faint)]">
                    <th className="px-4 py-3">Project</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Blockers</th>
                    <th className="px-4 py-3">At Risk</th>
                    <th className="px-4 py-3">Pending Decisions</th>
                    <th className="px-4 py-3">Next Action</th>
                    <th className="px-4 py-3">Last Activity</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProjectRows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-[var(--ef-surface-elevated-a80)] transition hover:bg-[var(--ef-background-secondary)]"
                    >
                      <td className="px-4 py-4 align-top">
                        <div className="min-w-[220px]">
                          <p className="text-[13px] font-semibold text-[var(--ef-text-primary)]">
                            {row.projectLabel}
                          </p>
                          {row.projectCode ? (
                            <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                              {row.projectCode}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-4 align-top">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${statusBadgeClass(row.statusKey)}`}
                        >
                          {row.statusLabel}
                        </span>
                      </td>
                      <td className="px-4 py-4 align-top text-[13px] font-medium text-[var(--ef-text-primary)]">
                        {row.blockers}
                      </td>
                      <td className="px-4 py-4 align-top">
                        <p className="text-[13px] font-medium text-[var(--ef-text-primary)]">{row.atRiskLabel}</p>
                        {row.atRiskHint ? (
                          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                            {row.atRiskHint}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 align-top text-[13px] font-medium text-[var(--ef-text-primary)]">
                        {row.pendingDecisions}
                      </td>
                      <td className="px-4 py-4 align-top">
                        <div className="max-w-[320px] text-[13px] text-[var(--ef-text-secondary)]">
                          {truncateText(row.nextAction, 90)}
                        </div>
                      </td>
                      <td className="px-4 py-4 align-top text-[13px] text-[var(--ef-text-muted)]">
                        {row.lastActivityLabel}
                      </td>
                      <td className="px-4 py-4 align-top text-right">
                        <Link
                          href={row.href}
                          className="inline-flex items-center justify-center rounded-xl border border-[var(--ef-purple-primary-a25)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-purple-glow)] transition hover:bg-[var(--ef-purple-primary-a18)]"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
