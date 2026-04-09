'use client';

import { useEffect, useState } from 'react';
import type {
  ApprovalActionHistoryResult,
  ApprovalExecutionGroup,
  ApprovalActionLogEntry,
} from '@/lib/server/approvalActionHistory';

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
    case 'blocked':               return 'bg-[#EF4444]';
    case 'needs_review':
    case 'approved_with_exceptions': return 'bg-[#F59E0B]';
    case 'approved':              return 'bg-[#22C55E]';
    default:                      return 'bg-[#2F3B52]';
  }
}

function statusTextClass(status: string): string {
  switch (status) {
    case 'blocked':               return 'text-[#EF4444]';
    case 'needs_review':
    case 'approved_with_exceptions': return 'text-[#F59E0B]';
    case 'approved':              return 'text-[#22C55E]';
    default:                      return 'text-[#94A3B8]';
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'blocked':               return 'border-[#EF4444]/25 bg-[#EF4444]/10 text-[#EF4444]';
    case 'needs_review':
    case 'approved_with_exceptions': return 'border-[#F59E0B]/25 bg-[#F59E0B]/10 text-[#F59E0B]';
    case 'approved':              return 'border-[#22C55E]/25 bg-[#22C55E]/10 text-[#22C55E]';
    default:                      return 'border-[#2F3B52] bg-[#1A2333] text-[#94A3B8]';
  }
}

function priorityDotClass(priority: string): string {
  switch (priority) {
    case 'critical': return 'bg-[#EF4444]';
    case 'high':     return 'bg-[#F97316]';
    case 'medium':   return 'bg-[#F59E0B]';
    default:         return 'bg-[#3B82F6]';
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
        isFailed ? 'bg-[#EF4444]/5' : 'bg-white/[0.02]'
      }`}
    >
      {/* Priority dot */}
      <div
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
          isFailed ? 'bg-[#EF4444]' : priorityDotClass(entry.priority)
        }`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* Action type */}
          <span className="text-[11px] font-semibold text-[#E5EDF7]">
            {displayType}
          </span>

          {/* Invoice number */}
          {entry.invoice_number ? (
            <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-[#8FA1BC]">
              {entry.invoice_number}
            </span>
          ) : null}

          {/* Amount */}
          {amountStr ? (
            <span className="font-mono text-[11px] tabular-nums text-[#C7D2E3]">
              {amountStr}
            </span>
          ) : null}

          {/* Outcome pill */}
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${
              isFailed
                ? 'bg-[#EF4444]/15 text-[#F87171]'
                : entry.task_outcome === 'updated'
                ? 'bg-[#F59E0B]/10 text-[#FCD34D]'
                : 'bg-[#22C55E]/10 text-[#4ADE80]'
            }`}
          >
            {OUTCOME_DISPLAY[entry.task_outcome] ?? entry.task_outcome}
          </span>
        </div>

        {/* Reason */}
        {entry.reason ? (
          <p className="mt-0.5 text-[11px] leading-5 text-[#7F90AA]">
            {entry.reason}
          </p>
        ) : null}

        {/* Error */}
        {isFailed && entry.error ? (
          <p className="mt-0.5 text-[11px] text-[#F87171]">
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
    <div className="border-b border-[#2F3B52]/40 last:border-b-0">
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
              className="text-[11px] font-medium text-[#94A3B8]"
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
                className={`text-[10px] font-medium ${hasFailures ? 'text-[#F87171]' : 'text-[#94A3B8]'}`}
              >
                {summaryParts.join(' · ')}
              </span>
            ) : null}
          </div>
        </div>

        {/* Chevron */}
        <svg
          className={`h-3.5 w-3.5 shrink-0 text-[#4A5E78] transition-transform ${open ? 'rotate-180' : ''}`}
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
        const res = await fetch(`/api/projects/${projectId}/approval-action-history`);
        if (!res.ok) {
          throw new Error(`${res.status}`);
        }
        const data: ApprovalActionHistoryResult = await res.json();
        if (!cancelled) setHistory(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load');
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
      <div className="mt-4 animate-pulse rounded-xl border border-[#2F3B52]/40 bg-[#111827] px-5 py-4">
        <div className="h-3 w-32 rounded bg-[#2F3B52]/60" />
        <div className="mt-3 space-y-2">
          <div className="h-2.5 w-full rounded bg-[#2F3B52]/40" />
          <div className="h-2.5 w-3/4 rounded bg-[#2F3B52]/40" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4 rounded-xl border border-[#2F3B52]/40 bg-[#111827] px-5 py-4">
        <p className="text-[11px] text-[#F87171]">
          Could not load approval action history.
        </p>
      </div>
    );
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
    <div className="mt-4 overflow-hidden rounded-xl border border-[#2F3B52]/50 bg-[#0B101D]">
      {/* Section header */}
      <div className="flex items-center justify-between border-b border-[#2F3B52]/40 px-5 py-3">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">
            Approval Actions
          </p>
          <p className="mt-0.5 text-[11px] text-[#5A7090]">
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
        <div className="border-t border-[#2F3B52]/40 px-5 py-2.5">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#3B82F6] transition-colors hover:text-[#60A5FA]"
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
