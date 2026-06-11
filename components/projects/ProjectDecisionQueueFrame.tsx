'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { IssueObject } from '@/lib/issueObjects';
import type { ProjectDecisionLifecycleState, ProjectOverviewDecisionCard } from '@/lib/projectOverview';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';

type ProjectDecisionFrameAction = 'escalate' | 'verify';
type ProjectDecisionBucketKey = ProjectDecisionLifecycleState;
export const PROJECT_DECISION_QUEUE_TRIAGE_ACTIONS = ['escalate', 'verify'] as const;

type ProjectDecisionQueueFrameProps = {
  decisions: readonly ProjectOverviewDecisionCard[];
  issues?: readonly IssueObject[];
  emptyState: string;
  onProjectRefresh?: (() => void) | (() => Promise<void>);
};

const BUCKETS: Array<{ key: ProjectDecisionBucketKey; label: string }> = [
  { key: 'blocked', label: 'Blocked' },
  { key: 'needs_verification', label: 'Needs verification' },
  { key: 'ready_for_authorization', label: 'Ready for authorization' },
  { key: 'escalated', label: 'Escalated' },
  { key: 'overridden', label: 'Overridden' },
  { key: 'resolved', label: 'Resolved' },
];

function lifecycleForAction(action: ProjectDecisionFrameAction): ProjectDecisionLifecycleState {
  if (action === 'escalate') return 'escalated';
  return 'needs_verification';
}

function labelForLifecycle(state: ProjectDecisionLifecycleState): string {
  return BUCKETS.find((bucket) => bucket.key === state)?.label ?? state.replace(/_/g, ' ');
}

function actionLabel(action: ProjectDecisionFrameAction): string {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function isResolvedDecision(decision: ProjectOverviewDecisionCard): boolean {
  return ['resolved', 'overridden'].includes(decision.lifecycle_state);
}

function FrameRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">{label}</p>
      <p className="mt-2 text-sm leading-6 text-[var(--ef-text-secondary)]">{value}</p>
    </div>
  );
}

function formatIssueDate(value: Date | null): string {
  if (!value || value.getTime() === 0) return 'Not available';
  return value.toLocaleString();
}

function formatIssueMoney(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Not available';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function IssueDetailSurface({
  issue,
  action,
  setAction,
  notes,
  setNotes,
  submitAction,
  saving,
  message,
  error,
}: {
  issue: IssueObject;
  action: ProjectDecisionFrameAction | null;
  setAction: (action: ProjectDecisionFrameAction) => void;
  notes: string;
  setNotes: (notes: string) => void;
  submitAction: () => void;
  saving: boolean;
  message: string | null;
  error: string | null;
}) {
  const decision = issue.decision;
  const execution = issue.executionItem;
  const canRecordDecisionAction = issue.decisionId != null;

  return (
    <div className="mt-5 space-y-5">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">The Issue</p>
        <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{issue.title}</p>
        <p className="mt-2 text-sm leading-6 text-[var(--ef-text-muted)]">{issue.summary}</p>
      </div>

      <div className="grid gap-3">
        <FrameRow label="Finding type" value={issue.issueType} />
        <FrameRow label="Confidence" value={`${Math.round(issue.confidence * 100)}%`} />
        <FrameRow label="Exposure" value={formatIssueMoney(issue.exposureAmount)} />
        <FrameRow label="Created" value={formatIssueDate(issue.createdAt)} />
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">Evidence chain</p>
        <div className="mt-2 space-y-2">
          {issue.evidenceTargets.length > 0 ? issue.evidenceTargets.map((target) => (
            <div key={target.id} className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-2 text-[11px] text-[var(--ef-text-secondary)]">
              <p className="font-semibold text-[var(--ef-text-primary)]">{target.sourceName}</p>
              <p className="mt-1 text-[var(--ef-text-muted)]">{target.snippet}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                <span>{target.sourceType}</span>
                <span>{Math.round(target.confidence * 100)}% confidence</span>
                {target.pdfAnchor?.page ? <span>Page {target.pdfAnchor.page}</span> : null}
              </div>
              {target.pdfAnchor?.url ? (
                <Link href={target.pdfAnchor.url} className="mt-2 inline-flex text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-purple-glow)] hover:underline">
                  Open PDF anchor
                </Link>
              ) : null}
            </div>
          )) : (
            <p className="text-sm text-[var(--ef-text-muted)]">No structured evidence targets are attached to this issue yet.</p>
          )}
        </div>
      </div>

      <div className="grid gap-3">
        <FrameRow label="Decision question" value={decision?.summary ?? issue.finding.required_action ?? issue.nextAction} />
        <FrameRow label="Rule applied" value={String(decision?.details?.decision_rule_type ?? decision?.details?.rule_id ?? issue.finding.rule_id)} />
        <FrameRow label="Impact" value={issue.finding.impact ?? decision?.summary ?? 'Impact is captured on the validator finding and decision record.'} />
        <FrameRow label="Recommended action" value={String(decision?.details?.recommended_action ?? issue.finding.required_action ?? issue.nextAction)} />
        <FrameRow label="Decision status" value={decision?.status ?? 'No decision record yet'} />
      </div>

      <div className="space-y-3 border-t border-[var(--ef-border-subtle-a70)] pt-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">Operator actions</p>
        {canRecordDecisionAction ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              {PROJECT_DECISION_QUEUE_TRIAGE_ACTIONS.map((nextAction) => (
                <button
                  key={nextAction}
                  type="button"
                  onClick={() => setAction(nextAction)}
                  className={`rounded-sm border px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] transition-colors ${
                    action === nextAction
                      ? 'border-[var(--ef-purple-primary-a60)] bg-[var(--ef-purple-primary-a12)] text-[var(--ef-purple-glow)]'
                      : 'border-[var(--ef-border-subtle)] text-[var(--ef-text-secondary)] hover:bg-[var(--ef-surface-elevated)] hover:text-[var(--ef-text-primary)]'
                  }`}
                >
                  {nextAction}
                </button>
              ))}
            </div>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Notes optional for escalation or verification triage"
              className="min-h-24 w-full rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
            />
            <button
              type="button"
              onClick={submitAction}
              disabled={saving}
              className="w-full rounded-sm border border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a12)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--ef-purple-glow)] transition-colors hover:border-[var(--ef-purple-primary-a70)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Recording...' : 'Record action'}
            </button>
          </>
        ) : (
          <p className="text-sm text-[var(--ef-text-muted)]">This finding needs a decision before triage actions are available.</p>
        )}
        {message ? <p className="text-sm text-[var(--ef-success)]">{message}</p> : null}
        {error ? <p className="text-sm text-[var(--ef-critical)]">{error}</p> : null}
      </div>

      <div className="grid gap-3">
        <FrameRow label="Execution outcome" value={execution ? [
          `Status ${execution.status}`,
          execution.outcome ? `Outcome ${execution.outcome}` : null,
          execution.override_reason ? `Reason ${execution.override_reason}` : null,
          issue.executedAt ? `Timestamp ${formatIssueDate(issue.executedAt)}` : null,
        ].filter(Boolean).join(' / ') : 'Execution not yet initiated'} />
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">Audit trail</p>
        <div className="mt-2 space-y-2">
          {issue.auditChain.length > 0 ? issue.auditChain.map((entry, index) => (
            <div key={`${entry.timestamp.toISOString()}:${index}`} className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-2 text-[11px] text-[var(--ef-text-secondary)]">
              <p className="font-semibold text-[var(--ef-text-primary)]">{entry.activityType}</p>
              <p className="mt-1 text-[var(--ef-text-muted)]">{entry.description}</p>
              <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                {formatIssueDate(entry.timestamp)}{entry.actorId ? ` / ${entry.actorId}` : ''}
              </p>
            </div>
          )) : (
            <p className="text-sm text-[var(--ef-text-muted)]">No issue-specific audit events have been recorded yet.</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href={issue.evidenceTargets[0]?.pdfAnchor?.url ?? issue.nextHref} className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] hover:text-[var(--ef-text-primary)]">
          Inspect Evidence
        </Link>
        <Link href={issue.nextHref} className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] hover:text-[var(--ef-text-primary)]">
          Open Execution
        </Link>
        {issue.decisionId ? (
          <Link href={`/platform/decisions/${issue.decisionId}`} className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] hover:text-[var(--ef-text-primary)]">
            Open Decision Context
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function ProjectDecisionQueueFrame(props: ProjectDecisionQueueFrameProps) {
  const { decisions, issues = [], emptyState, onProjectRefresh } = props;
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDecisionId = searchParams.get('decisionId');
  const requestedIssueId = searchParams.get('selectedIssue');
  const requestedExecutionItemId = searchParams.get('executionItemId');
  const [selectedId, setSelectedId] = useState<string | null>(decisions[0]?.id ?? null);
  const [showResolved, setShowResolved] = useState(false);
  const [action, setAction] = useState<ProjectDecisionFrameAction | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localLifecycleById, setLocalLifecycleById] = useState<Record<string, ProjectDecisionLifecycleState>>({});
  const [localActionById, setLocalActionById] = useState<Record<string, string>>({});
  const queueScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopBeforeSave = useRef(0);

  const renderedDecisions = useMemo(
    () => decisions.map((decision) => {
      const localLifecycle = localLifecycleById[decision.id];
      const localAction = localActionById[decision.id];
      if (!localLifecycle && !localAction) return decision;
      return {
        ...decision,
        lifecycle_state: localLifecycle ?? decision.lifecycle_state,
        lifecycle_label: localLifecycle ? labelForLifecycle(localLifecycle) : decision.lifecycle_label,
        last_operator_action: localAction ?? decision.last_operator_action,
        audit_summary: localAction
          ? `${localAction} recorded in this session. Audit refresh is in progress.`
          : decision.audit_summary,
      };
    }),
    [decisions, localActionById, localLifecycleById],
  );

  const activeDecisions = useMemo(
    () => renderedDecisions.filter((decision) => !isResolvedDecision(decision)),
    [renderedDecisions],
  );

  const resolvedDecisions = useMemo(
    () => renderedDecisions.filter(isResolvedDecision),
    [renderedDecisions],
  );

  useEffect(() => {
    if (renderedDecisions.length === 0) {
      setSelectedId(null);
      return;
    }
    const requestedExecutionIssue = requestedExecutionItemId
      ? issues.find((issue) =>
          issue.executionItemId === requestedExecutionItemId
          || issue.issueId === `exec:${requestedExecutionItemId}`,
        ) ?? null
      : null;
    const requestedExecutionSelection =
      requestedExecutionIssue && renderedDecisions.some((decision) => decision.id === requestedExecutionIssue.issueId)
        ? requestedExecutionIssue.issueId
        : null;
    const requestedSelection =
      requestedExecutionSelection
        ?? (requestedIssueId && renderedDecisions.some((decision) => decision.id === requestedIssueId)
          ? requestedIssueId
          : requestedDecisionId && renderedDecisions.some((decision) => decision.id === requestedDecisionId)
            ? requestedDecisionId
            : null);
    if (
      requestedExecutionSelection
      && resolvedDecisions.some((decision) => decision.id === requestedExecutionSelection)
    ) {
      setShowResolved(true);
    }
    if (requestedSelection && selectedId !== requestedSelection) {
      setSelectedId(requestedSelection);
      return;
    }
    if (!selectedId || !renderedDecisions.some((decision) => decision.id === selectedId)) {
      setSelectedId(requestedSelection ?? activeDecisions[0]?.id ?? (showResolved ? resolvedDecisions[0]?.id ?? null : null));
    }
  }, [
    activeDecisions,
    issues,
    renderedDecisions,
    requestedDecisionId,
    requestedExecutionItemId,
    requestedIssueId,
    resolvedDecisions,
    selectedId,
    showResolved,
  ]);

  const activeBuckets = useMemo(() => {
    const grouped: Record<ProjectDecisionBucketKey, ProjectOverviewDecisionCard[]> = {
      blocked: [],
      needs_verification: [],
      ready_for_authorization: [],
      escalated: [],
      overridden: [],
      resolved: [],
    };
    for (const decision of activeDecisions) grouped[decision.lifecycle_state].push(decision);
    return grouped;
  }, [activeDecisions]);

  const resolvedBuckets = useMemo(() => {
    const grouped: Record<ProjectDecisionBucketKey, ProjectOverviewDecisionCard[]> = {
      blocked: [],
      needs_verification: [],
      ready_for_authorization: [],
      escalated: [],
      overridden: [],
      resolved: [],
    };
    for (const decision of resolvedDecisions) grouped[decision.lifecycle_state].push(decision);
    return grouped;
  }, [resolvedDecisions]);

  const selectedCandidate = renderedDecisions.find((decision) => decision.id === selectedId) ?? null;
  const selected = selectedCandidate && (showResolved || !isResolvedDecision(selectedCandidate))
    ? selectedCandidate
    : activeDecisions[0] ?? (showResolved ? resolvedDecisions[0] ?? null : null);
  const issuesById = useMemo(() => new Map(issues.map((issue) => [issue.issueId, issue] as const)), [issues]);
  const selectedIssue = selected ? issuesById.get(selected.id) ?? null : null;

  const metrics = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return {
      open: renderedDecisions.filter((decision) => !['resolved', 'overridden'].includes(decision.lifecycle_state)).length,
      blocked: renderedDecisions.filter((decision) => decision.lifecycle_state === 'blocked').length,
      escalated: renderedDecisions.filter((decision) => decision.lifecycle_state === 'escalated').length,
      resolvedToday: renderedDecisions.filter((decision) =>
        decision.lifecycle_state === 'resolved'
        && decision.updated_at
        && new Date(decision.updated_at).getTime() >= startOfToday.getTime(),
      ).length,
    };
  }, [renderedDecisions]);

  async function authorizedFetch(path: string, init: RequestInit): Promise<Response> {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Authentication required.');

    const response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

    if (redirectIfUnauthorized(response, router.replace)) {
      throw new Error('Unauthorized');
    }

    return response;
  }

  async function submitAction() {
    const actionDecisionId = selectedIssue?.decisionId ?? selected?.id ?? null;
    if (!selected || !action || !actionDecisionId) {
      setError('Choose a decision and operator action first.');
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    scrollTopBeforeSave.current = queueScrollRef.current?.scrollTop ?? 0;

    try {
      const nextLifecycle = lifecycleForAction(action);
      const nextActionLabel = actionLabel(action);
      const response = await authorizedFetch(`/api/decisions/${actionDecisionId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({
          is_correct: false,
          feedback_type: 'needs_review',
          disposition: action === 'escalate' ? 'escalate' : null,
          review_error_type: 'edge_case',
          operator_action: action,
          notes: notes.trim() || null,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'Decision action failed.');
      }

      setMessage('Decision triage action recorded. Open Execution to finalize approval-impacting outcomes.');
      setLocalLifecycleById((current) => ({
        ...current,
        [selected.id]: nextLifecycle,
      }));
      setLocalActionById((current) => ({
        ...current,
        [selected.id]: nextActionLabel,
      }));
      setAction(null);
      setNotes('');
      await onProjectRefresh?.();
      window.requestAnimationFrame(() => {
        if (queueScrollRef.current) queueScrollRef.current.scrollTop = scrollTopBeforeSave.current;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Decision action failed.');
    } finally {
      setSaving(false);
    }
  }

  if (renderedDecisions.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-6 text-sm text-[var(--ef-text-muted)]">
        {emptyState}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <FrameRow label="Open decisions" value={String(metrics.open)} />
        <FrameRow label="Blocked" value={String(metrics.blocked)} />
        <FrameRow label="Escalated" value={String(metrics.escalated)} />
        <FrameRow label="Resolved today" value={String(metrics.resolvedToday)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_430px]">
      <div ref={queueScrollRef} className="max-h-[72vh] space-y-4 overflow-auto pr-1">
        {BUCKETS.filter((bucket) => bucket.key !== 'resolved' && bucket.key !== 'overridden').map((bucket) => (
          <section key={bucket.key} className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)]">
            <div className="flex items-center justify-between border-b border-[var(--ef-border-subtle-a70)] px-4 py-3">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-primary)]">{bucket.label}</h3>
              <span className="text-[10px] text-[var(--ef-text-muted)]">{activeBuckets[bucket.key].length}</span>
            </div>
            {activeBuckets[bucket.key].length === 0 ? (
              <p className="px-4 py-3 text-sm text-[var(--ef-text-muted)]">No decisions in this state.</p>
            ) : (
              <div className="divide-y divide-[var(--ef-border-subtle-a70)]">
                {activeBuckets[bucket.key].map((decision) => (
                  <button
                    key={decision.id}
                    type="button"
                    onClick={() => setSelectedId(decision.id)}
                    className={`w-full px-4 py-4 text-left transition-colors hover:bg-[var(--ef-surface-elevated)] ${
                      selected?.id === decision.id ? 'border-l-2 border-[var(--ef-purple-primary)] bg-[var(--ef-purple-primary-a10)]' : 'border-l-2 border-transparent'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[var(--ef-text-primary)]">{decision.title}</p>
                        <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-[var(--ef-text-muted)]">{decision.reason}</p>
                      </div>
                      <span className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)]">
                        {decision.lifecycle_label}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                      <span>Evidence: {decision.evidence_refs.length}</span>
                      <span>ID: {decision.id.slice(0, 8)}</span>
                      <span>Owner: {decision.assigned_operator}</span>
                      {decision.last_operator_action ? <span>Last: {decision.last_operator_action}</span> : null}
                      {decision.source_identity_key ? <span>Key: {decision.source_identity_key}</span> : null}
                      {decision.exposure_amount != null ? <span>Exposure: ${Math.round(decision.exposure_amount).toLocaleString()}</span> : null}
                      <span>{decision.freshness_label}</span>
                      {decision.due_label ? <span>{decision.due_label}</span> : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
        {resolvedDecisions.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowResolved((current) => !current)}
            className="w-full rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] transition-colors hover:bg-[var(--ef-surface-elevated)] hover:text-[var(--ef-text-primary)]"
          >
            {showResolved ? 'Hide resolved history' : `Show resolved history (${resolvedDecisions.length})`}
          </button>
        ) : null}
        {showResolved && resolvedDecisions.length > 0 ? (
          <section className="space-y-4">
            <h3 className="px-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">Resolved / History</h3>
            {BUCKETS.filter((bucket) => bucket.key === 'overridden' || bucket.key === 'resolved').map((bucket) => (
              <section key={bucket.key} className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)]">
                <div className="flex items-center justify-between border-b border-[var(--ef-border-subtle-a70)] px-4 py-3">
                  <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-primary)]">{bucket.label}</h3>
                  <span className="text-[10px] text-[var(--ef-text-muted)]">{resolvedBuckets[bucket.key].length}</span>
                </div>
                {resolvedBuckets[bucket.key].length === 0 ? (
                  <p className="px-4 py-3 text-sm text-[var(--ef-text-muted)]">No decisions in this state.</p>
                ) : (
                  <div className="divide-y divide-[var(--ef-border-subtle-a70)]">
                    {resolvedBuckets[bucket.key].map((decision) => (
                      <button
                        key={decision.id}
                        type="button"
                        onClick={() => setSelectedId(decision.id)}
                        className={`w-full px-4 py-4 text-left transition-colors hover:bg-[var(--ef-surface-elevated)] ${
                          selected?.id === decision.id ? 'border-l-2 border-[var(--ef-purple-primary)] bg-[var(--ef-purple-primary-a10)]' : 'border-l-2 border-transparent'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-[var(--ef-text-primary)]">{decision.title}</p>
                            <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-[var(--ef-text-muted)]">{decision.reason}</p>
                          </div>
                          <span className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)]">
                            {decision.lifecycle_label}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                          <span>Evidence: {decision.evidence_refs.length}</span>
                          <span>ID: {decision.id.slice(0, 8)}</span>
                          <span>Owner: {decision.assigned_operator}</span>
                          {decision.last_operator_action ? <span>Last: {decision.last_operator_action}</span> : null}
                          {decision.source_identity_key ? <span>Key: {decision.source_identity_key}</span> : null}
                          {decision.exposure_amount != null ? <span>Exposure: ${Math.round(decision.exposure_amount).toLocaleString()}</span> : null}
                          <span>{decision.freshness_label}</span>
                          {decision.due_label ? <span>{decision.due_label}</span> : null}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </section>
        ) : null}
      </div>

      <aside className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-5">
        <h3 className="text-base font-bold text-[var(--ef-text-primary)]">Decision Frame</h3>
        {selectedIssue ? (
          <IssueDetailSurface
            issue={selectedIssue}
            action={action}
            setAction={setAction}
            notes={notes}
            setNotes={setNotes}
            submitAction={() => void submitAction()}
            saving={saving}
            message={message}
            error={error}
          />
        ) : selected ? (
          <div className="mt-5 space-y-5">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">Issue</p>
              <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{selected.title}</p>
              <p className="mt-2 text-sm leading-6 text-[var(--ef-text-muted)]">{selected.reason}</p>
            </div>

            <div className="grid gap-3">
              <FrameRow label="Decision question" value={selected.decision_question} />
              <FrameRow label="Impact" value={selected.impact} />
              <FrameRow label="Governing truth" value={selected.source_evidence_label || selected.source_document_title || 'Project decision record'} />
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">Evidence chain</p>
              <div className="mt-2 space-y-2">
                {selected.evidence_summaries.length > 0 ? selected.evidence_summaries.slice(0, 5).map((evidence) => (
                  <div key={evidence.id} className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-2 text-[11px] text-[var(--ef-text-secondary)]">
                    <p className="font-semibold text-[var(--ef-text-primary)]">{evidence.label}</p>
                    <p className="mt-1 text-[var(--ef-text-muted)]">
                      {[evidence.document_title, evidence.page_label, evidence.field_label, evidence.anchor_summary].filter(Boolean).join(' / ')}
                    </p>
                  </div>
                )) : (
                  <p className="text-sm text-[var(--ef-text-muted)]">No structured evidence refs are available on this project decision yet.</p>
                )}
              </div>
            </div>

            <div className="grid gap-3">
              <FrameRow label="Context / confidence" value={selected.metadata.length > 0 ? selected.metadata.join(' / ') : 'Confidence not quantified on this project decision.'} />
              <FrameRow label="Recommended action" value={selected.primary_action ?? selected.required_action} />
              <FrameRow label="Workflow context" value={[
                `Decision ${selected.id}`,
                `Lifecycle ${selected.lifecycle_label}`,
                `Operator status ${selected.operator_status}`,
                `Owner ${selected.assigned_operator}`,
                selected.last_operator_action ? `Last action ${selected.last_operator_action}` : null,
                selected.escalation_state ? `Escalation ${selected.escalation_state}` : null,
                selected.updated_at ? `Updated ${new Date(selected.updated_at).toLocaleString()}` : null,
              ].filter(Boolean).join(' / ')} />
              <FrameRow label="Linked references" value={[
                selected.linked_execution_label,
                selected.linked_finding_label,
                selected.linked_evidence_label,
                selected.source_identity_key ? `Source key ${selected.source_identity_key}` : null,
                selected.source_document_title ? `Document ${selected.source_document_title}` : null,
                selected.exposure_amount != null ? `Exposure $${Math.round(selected.exposure_amount).toLocaleString()}` : null,
              ].filter(Boolean).join(' / ') || 'No linked execution, finding, or evidence references are attached yet.'} />
            </div>

            <div className="space-y-3 border-t border-[var(--ef-border-subtle-a70)] pt-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">Operator triage actions</p>
              <div className="grid grid-cols-2 gap-2">
                {PROJECT_DECISION_QUEUE_TRIAGE_ACTIONS.map((nextAction) => (
                  <button
                    key={nextAction}
                    type="button"
                    onClick={() => setAction(nextAction)}
                    className={`rounded-sm border px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] transition-colors ${
                      action === nextAction
                        ? 'border-[var(--ef-purple-primary-a60)] bg-[var(--ef-purple-primary-a12)] text-[var(--ef-purple-glow)]'
                        : 'border-[var(--ef-border-subtle)] text-[var(--ef-text-secondary)] hover:bg-[var(--ef-surface-elevated)] hover:text-[var(--ef-text-primary)]'
                    }`}
                  >
                    {nextAction}
                  </button>
                ))}
              </div>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Notes optional for escalation or verification triage"
                className="min-h-24 w-full rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
              />
              <button
                type="button"
                onClick={() => void submitAction()}
                disabled={saving}
                className="w-full rounded-sm border border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a12)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--ef-purple-glow)] transition-colors hover:border-[var(--ef-purple-primary-a70)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? 'Recording...' : 'Record action'}
              </button>
              {message ? <p className="text-sm text-[var(--ef-success)]">{message}</p> : null}
              {error ? <p className="text-sm text-[var(--ef-critical)]">{error}</p> : null}
            </div>

            <FrameRow label="Audit summary" value={selected.audit_summary} />

            <div className="flex flex-wrap gap-2">
              <Link href={selected.evidence_href} className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] hover:text-[var(--ef-text-primary)]">
                Inspect Evidence
              </Link>
              {selected.linked_execution_label ? (
                <Link href={selected.execution_href} className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] hover:text-[var(--ef-text-primary)]">
                  Open Execution
                </Link>
              ) : (
                <Link href={selected.execution_href} className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]">
                  No execution item yet
                </Link>
              )}
              <Link href={selected.href} className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] hover:text-[var(--ef-text-primary)]">
                Open Decision Context
              </Link>
              {selected.source_document_href ? (
                <Link href={selected.source_document_href} className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] hover:text-[var(--ef-text-primary)]">
                  Open evidence
                </Link>
              ) : null}
              <span className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[11px] text-[var(--ef-text-muted)]">
                {selected.freshness_label}
              </span>
            </div>
          </div>
        ) : null}
      </aside>
      </div>
    </div>
  );
}
