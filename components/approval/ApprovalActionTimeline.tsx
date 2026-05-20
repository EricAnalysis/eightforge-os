'use client';

import { useEffect, useState } from 'react';
import type {
  ApprovalActionHistoryResult,
  ApprovalExecutionGroup,
  ApprovalActionLogEntry,
} from '@/lib/server/approvalActionHistory';
import { supabase } from '@/lib/supabaseClient';

// ---------------------------------------------------------------------------
// Display mappings — match Phase 8 language rules (blocked → "Requires Verification")
// ---------------------------------------------------------------------------

const STATUS_DISPLAY: Record<string, string> = {
  blocked: 'Requires Verification',
  needs_review: 'Needs Review',
  approved_with_exceptions: 'Approved with Notes',
  approved: 'Approved',
  not_evaluated: 'Not Evaluated',
};

const ACTION_DISPLAY: Record<string, string> = {
  requires_verification_review: 'Verification Review',
  flag_project: 'Flag Project',
  notify_operator: 'Notify Operator',
  needs_review_queue: 'Review Queue',
  assign_analyst: 'Assign Analyst',
  mark_project_ready: 'Mark Ready',
  generate_approval_log: 'Approval Log',
};

const OUTCOME_DISPLAY: Record<string, string> = {
  created: 'created',
  updated: 'updated',
  failed: 'failed',
};

// ---------------------------------------------------------------------------
// Tone helpers — mirrors ProjectOverview.tsx palette exactly
// ---------------------------------------------------------------------------

function statusDotClass(status: string): string {
  switch (status) {
    case 'blocked':               return 'bg-[var(--ef-critical)]';
    case 'needs_review':
    case 'approved_with_exceptions': return 'bg-[var(--ef-warning)]';
    case 'approved':              return 'bg-[var(--ef-success)]';
    default:                      return 'bg-[var(--ef-border-subtle)]';
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'blocked':               return 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical)]';
    case 'needs_review':
    case 'approved_with_exceptions': return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning)]';
    case 'approved':              return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success)]';
    default:                      return 'border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)]';
  }
}

function priorityDotClass(priority: string): string {
  switch (priority) {
    case 'critical': return 'bg-[var(--ef-critical)]';
    case 'high':     return 'bg-[var(--ef-warning)]';
    case 'medium':   return 'bg-[var(--ef-warning)]';
    default:         return 'bg-[var(--ef-purple-primary)]';
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents >= 100000 ? 0 : 2,
  }).format(cents / 100);
}

function fmtRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (isNaN(then)) return iso;

  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1)   return 'just now';
  if (diffMin < 60)  return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7)   return `${diffDay}d ago`;

  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function fmtAbsTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ---------------------------------------------------------------------------
// Action row — one line per log entry in an execution group
// ---------------------------------------------------------------------------

function ActionRow({ entry }: { entry: ApprovalActionLogEntry }) {
  const isFailed = entry.task_outcome === 'failed';
  const amountStr = fmtCents(entry.amount);
  const displayType = ACTION_DISPLAY[entry.action_type] ?? entry.action_type;

  return (
    <div
      className={`flex items-start gap-3 rounded-sm px-3 py-2 ${
        isFailed ? 'bg-[var(--ef-critical-a05)]' : 'bg-white/[0.02]'
      }`}
    >
      {/* Priority dot */}
      <div
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
          isFailed ? 'bg-[var(--ef-critical)]' : priorityDotClass(entry.priority)
        }`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* Action type */}
          <span className="text-[11px] font-semibold text-[var(--ef-text-primary)]">
            {displayType}
          </span>

          {/* Invoice number */}
          {entry.invoice_number ? (
            <span className="rounded border border-[var(--ef-border-white-10)] bg-[var(--ef-border-white-06)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ef-text-soft)]">
              {entry.invoice_number}
            </span>
          ) : null}

          {/* Amount */}
          {amountStr ? (
            <span className="font-mono text-[11px] tabular-nums text-[var(--ef-text-secondary)]">
              {amountStr}
            </span>
          ) : null}

          {/* Outcome pill */}
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${
              isFailed
                ? 'bg-[var(--ef-critical-a15)] text-[var(--ef-critical-soft)]'
                : entry.task_outcome === 'updated'
                ? 'bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]'
                : 'bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]'
            }`}
          >
            {OUTCOME_DISPLAY[entry.task_outcome] ?? entry.task_outcome}
          </span>
        </div>

        {/* Reason */}
        {entry.reason ? (
          <p className="mt-0.5 text-[11px] leading-5 text-[var(--ef-text-soft)]">
            {entry.reason}
          </p>
        ) : null}

        {/* Error */}
        {isFailed && entry.error ? (
          <p className="mt-0.5 text-[11px] text-[var(--ef-critical-soft)]">
            Error: {entry.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution group row — one collapsible entry per engine run
// ---------------------------------------------------------------------------

function ExecutionGroupRow({ group, defaultOpen }: { group: ApprovalExecutionGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const statusDisplay = STATUS_DISPLAY[group.approval_status] ?? group.approval_status;
  const hasFailures = group.failures > 0;

  const summaryParts: string[] = [];
  if (group.tasks_created > 0) summaryParts.push(`${group.tasks_created} created`);
  if (group.tasks_updated > 0) summaryParts.push(`${group.tasks_updated} updated`);
  if (group.failures > 0)      summaryParts.push(`${group.failures} failed`);

  return (
    <div className="border-b border-[var(--ef-border-subtle-a40)] last:border-b-0">
      {/* Group header — always visible, clickable to expand */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-white/[0.02]"
        aria-expanded={open}
      >
        {/* Timeline dot + connector */}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <div className={`h-2 w-2 rounded-full ${statusDotClass(group.approval_status)}`} />
        </div>

        {/* Timestamp */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              className="text-[11px] font-medium text-[var(--ef-text-muted)]"
              title={fmtAbsTime(group.batch_timestamp)}
            >
              {fmtRelativeTime(group.batch_timestamp)}
            </span>

            {/* Status badge */}
            <span
              className={`rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${statusBadgeClass(group.approval_status)}`}
            >
              {statusDisplay}
            </span>

            {/* Task summary */}
            {summaryParts.length > 0 ? (
              <span
                className={`text-[10px] font-medium ${hasFailures ? 'text-[var(--ef-critical-soft)]' : 'text-[var(--ef-text-muted)]'}`}
              >
                {summaryParts.join(' · ')}
              </span>
            ) : null}
          </div>
        </div>

        {/* Chevron */}
        <svg
          className={`h-3.5 w-3.5 shrink-0 text-[var(--ef-text-faint)] transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded action list */}
      {open ? (
        <div className="space-y-0.5 pb-3 pl-10 pr-5">
          {group.actions.map((entry) => (
            <ActionRow key={entry.id} entry={entry} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

type ApprovalActionTimelineProps = {
  projectId: string;
};

async function getAuthHeaders(): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
}

export function ApprovalActionTimeline({ projectId }: ApprovalActionTimelineProps) {
  const [history, setHistory] = useState<ApprovalActionHistoryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const headers = await getAuthHeaders();
        if (!('Authorization' in headers)) {
          if (!cancelled) setHistory(null);
          return;
        }

        const res = await fetch(`/api/projects/${projectId}/approval-action-history`, {
          headers,
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 503) {
            if (!cancelled) setHistory(null);
            return;
          }
          throw new Error(`${res.status}`);
        }
        const data: ApprovalActionHistoryResult = await res.json();
        if (!cancelled) setHistory(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load');
          setHistory(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [projectId]);

  // Don't render anything until we know there's data to show
  if (loading) {
    return (
      <div className="mt-4 animate-pulse rounded-xl border border-[var(--ef-border-subtle-a40)] bg-[var(--ef-background-secondary)] px-5 py-4">
        <div className="h-3 w-32 rounded bg-[var(--ef-border-subtle-a60)]" />
        <div className="mt-3 space-y-2">
          <div className="h-2.5 w-full rounded bg-[var(--ef-border-subtle-a40)]" />
          <div className="h-2.5 w-3/4 rounded bg-[var(--ef-border-subtle-a40)]" />
        </div>
      </div>
    );
  }

  if (error) {
    return null;
  }

  // No history yet — render nothing (engine hasn't run for this project)
  if (!history || history.executions.length === 0) {
    return null;
  }

  const COLLAPSED_LIMIT = 3;
  const visibleGroups = showAll
    ? history.executions
    : history.executions.slice(0, COLLAPSED_LIMIT);
  const hasMore = history.executions.length > COLLAPSED_LIMIT;

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-[var(--ef-border-subtle-a50)] bg-[var(--ef-background-secondary)]">
      {/* Section header */}
      <div className="flex items-center justify-between border-b border-[var(--ef-border-subtle-a40)] px-5 py-3">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-soft)]">
            Approval Actions
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--ef-text-soft)]">
            {history.total_actions} action{history.total_actions === 1 ? '' : 's'} across{' '}
            {history.executions.length} execution{history.executions.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {/* Execution groups */}
      <div>
        {visibleGroups.map((group, i) => (
          <ExecutionGroupRow
            key={group.batch_timestamp}
            group={group}
            defaultOpen={i === 0}
          />
        ))}
      </div>

      {/* Show more / show less toggle */}
      {hasMore ? (
        <div className="border-t border-[var(--ef-border-subtle-a40)] px-5 py-2.5">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-purple-primary)] transition-colors hover:text-[var(--ef-purple-glow)]"
          >
            {showAll
              ? 'Show less'
              : `Show ${history.executions.length - COLLAPSED_LIMIT} more`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
