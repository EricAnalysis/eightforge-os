'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { WorkflowOutcomesResult } from '@/app/api/decisions/[id]/workflow-outcomes/route';

// ---------------------------------------------------------------------------
// Operator-friendly label maps
// ---------------------------------------------------------------------------

const TASK_TYPE_LABEL: Record<string, string> = {
  general_review:                 'Review opened',
  review_decision:                'Decision review queued',
  requires_verification_review:   'Verification review opened',
  needs_review_queue:             'Added to review queue',
  flag_project:                   'Project flagged',
  notify_operator:                'Operator notified',
  assign_analyst:                 'Analyst assigned',
  mark_project_ready:             'Ready signal sent',
  generate_approval_log:          'Approval log generated',
  audit_entry:                    'Audit entry created',
  lock_invoice:                   'Invoice locked',
  approve_invoice:                'Invoice approved',
  follow_up_task:                 'Follow-up task created',
};

const ACTION_TYPE_LABEL: Record<string, string> = {
  requires_verification_review:   'Verification review',
  flag_project:                   'Project flagged',
  notify_operator:                'Operator notified',
  needs_review_queue:             'Review queue entry',
  assign_analyst:                 'Analyst assigned',
  mark_project_ready:             'Project marked ready',
  generate_approval_log:          'Approval log generated',
};

const TASK_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  open:        { label: 'Open',        color: 'text-[#60A5FA]' },
  in_progress: { label: 'In progress', color: 'text-[#FBBF24]' },
  resolved:    { label: 'Completed',   color: 'text-[#34D399]' },
  cancelled:   { label: 'Cancelled',   color: 'text-[#94A3B8]' },
  blocked:     { label: 'Blocked',     color: 'text-[#F87171]' },
};

const OUTCOME_LABEL: Record<string, { label: string; color: string }> = {
  created: { label: 'Created', color: 'text-[#34D399]' },
  updated: { label: 'Updated', color: 'text-[#FBBF24]' },
  failed:  { label: 'Failed',  color: 'text-[#F87171]' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (isNaN(diffMs)) return iso;
  const m = Math.floor(diffMs / 60_000);
  const h = Math.floor(diffMs / 3_600_000);
  const d = Math.floor(diffMs / 86_400_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d === 1) return 'yesterday';
  if (d < 7)  return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtAbsolute(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    maximumFractionDigits: cents >= 100_000 ? 0 : 2,
  }).format(cents / 100);
}

function taskLabel(taskType: string): string {
  return TASK_TYPE_LABEL[taskType] ?? taskType.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function actionLabel(actionType: string): string {
  return ACTION_TYPE_LABEL[actionType] ?? actionType.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Sub-renderers
// ---------------------------------------------------------------------------

type TriggeredTask = WorkflowOutcomesResult['triggered_tasks'][number];
type ApprovalAction = WorkflowOutcomesResult['approval_engine_actions'][number];

function TriggeredTaskRow({ task }: { task: TriggeredTask }) {
  const statusInfo = TASK_STATUS_LABEL[task.status] ?? { label: task.status, color: 'text-[#94A3B8]' };

  return (
    <div className="group flex items-start gap-3 rounded-lg border border-[#2F3B52]/60 bg-[#0B1020]/60 px-3 py-2.5">
      {/* Outcome dot */}
      <div className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
        task.status === 'resolved' ? 'bg-[#22C55E]' :
        task.status === 'blocked'  ? 'bg-[#EF4444]' :
        task.status === 'in_progress' ? 'bg-[#F59E0B]' :
                                    'bg-[#3B82F6]'
      }`} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[12px] font-semibold text-[#C7D2E3] group-hover:text-[#E5EDF7]">
            {taskLabel(task.task_type)}
          </span>
          <span className={`text-[10px] font-medium ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
        </div>
        <p className="mt-0.5 text-[10px] text-[#475569]" title={fmtAbsolute(task.created_at)}>
          Triggered {fmtRelative(task.created_at)}
        </p>
      </div>

      {/* Link chevron */}
      <svg
        className="mt-0.5 h-3 w-3 shrink-0 text-[#2F3B52]"
        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </div>
  );
}

function ApprovalActionRow({ action }: { action: ApprovalAction }) {
  const outcomeInfo = OUTCOME_LABEL[action.task_outcome] ?? { label: action.task_outcome, color: 'text-[#94A3B8]' };
  const isFailed = action.task_outcome === 'failed';
  const amountStr = fmtCents(action.amount);

  return (
    <div className={`flex items-start gap-3 rounded-lg px-3 py-2.5 ${
      isFailed ? 'border border-[#EF4444]/20 bg-[#EF4444]/5' : 'border border-[#2F3B52]/40 bg-[#0B1020]/40'
    }`}>
      <div className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
        isFailed ? 'bg-[#EF4444]' :
        action.task_outcome === 'updated' ? 'bg-[#F59E0B]' : 'bg-[#22C55E]'
      }`} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[12px] font-semibold text-[#C7D2E3]">
            {actionLabel(action.action_type)}
          </span>
          {action.invoice_number && (
            <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-[#8FA1BC]">
              {action.invoice_number}
            </span>
          )}
          {amountStr && (
            <span className="font-mono text-[10px] tabular-nums text-[#94A3B8]">
              {amountStr}
            </span>
          )}
          <span className={`text-[10px] font-medium ${outcomeInfo.color}`}>
            {outcomeInfo.label}
          </span>
        </div>
        {action.reason && !isFailed && (
          <p className="mt-0.5 text-[10px] text-[#475569]">{action.reason}</p>
        )}
        {isFailed && action.error && (
          <p className="mt-0.5 text-[10px] text-[#F87171]">{action.error}</p>
        )}
        <p className="mt-0.5 text-[10px] text-[#334155]" title={fmtAbsolute(action.executed_at)}>
          {fmtRelative(action.executed_at)}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

type Props = { decisionId: string };

export function DecisionWorkflowOutcomePanel({ decisionId }: Props) {
  const [data, setData] = useState<WorkflowOutcomesResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/decisions/${decisionId}/workflow-outcomes`);
        if (!res.ok) return;
        const json: WorkflowOutcomesResult = await res.json();
        if (!cancelled) setData(json);
      } catch {
        // Silently skip — non-critical panel
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [decisionId]);

  const hasTasks   = (data?.triggered_tasks.length ?? 0) > 0;
  const hasActions = (data?.approval_engine_actions.length ?? 0) > 0;

  // Render nothing while loading or if there's genuinely nothing to show
  if (loading) {
    return (
      <div className="animate-pulse rounded-xl border border-[#2F3B52]/40 bg-[#0B1020]/60 px-4 py-3">
        <div className="h-2 w-28 rounded bg-[#2F3B52]/60" />
        <div className="mt-2.5 space-y-1.5">
          <div className="h-2 w-full rounded bg-[#2F3B52]/40" />
          <div className="h-2 w-2/3 rounded bg-[#2F3B52]/30" />
        </div>
      </div>
    );
  }

  if (!hasTasks && !hasActions) return null;

  return (
    <div className="rounded-xl border border-[#2F3B52] bg-[#0B1020] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        Execution outcomes
      </p>

      {/* Section 1: Tasks triggered directly from this decision */}
      {hasTasks && (
        <div className="mt-3 space-y-2">
          <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#334155]">
            Triggered by this decision
          </p>
          {data!.triggered_tasks.map((task) => (
            <TriggeredTaskRow key={task.id} task={task} />
          ))}
        </div>
      )}

      {/* Section 2: Approval engine actions that ran for this project */}
      {hasActions && (
        <div className={`space-y-2 ${hasTasks ? 'mt-4' : 'mt-3'}`}>
          <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#334155]">
            Approval engine · {data!.approval_engine_actions.length} action
            {data!.approval_engine_actions.length === 1 ? '' : 's'}
          </p>
          {data!.approval_engine_actions.map((action) => (
            <ApprovalActionRow key={action.id} action={action} />
          ))}
        </div>
      )}
    </div>
  );
}
