'use client';

import Link from 'next/link';
import { ActivityTimeline } from '@/components/ActivityTimeline';
import { DecisionContextPanel } from '@/components/decision-detail/DecisionContextPanel';
import { DecisionWorkflowOutcomePanel } from '@/components/decision-detail/DecisionWorkflowOutcomePanel';
import type {
  DecisionProjectValidationContext,
  DecisionQueueFindingActionContext,
  DecisionWorkflowExecutionStatus,
} from '@/lib/decisionContext';
import { dueDateInputValue, dueDateToISO, formatDueDate } from '@/lib/dateUtils';
import {
  type DecisionDetailDocumentRef,
  type DecisionDetailFeedback,
  type DecisionDetailTask,
  type DecisionEvidencePayload,
  type DecisionExecutiveSummary,
  type DecisionMetricCard,
  type DecisionProcessState,
  type DecisionTone,
} from '@/lib/decisionDetail';
import { isVagueDecisionActionDescription } from '@/lib/decisionActions';
import { isDecisionOverdue, isTaskOverdue, OverdueBadge } from '@/lib/overdue';
import type {
  DecisionAction,
  ReviewErrorType,
} from '@/lib/types/documentIntelligence';
import { memberDisplayName, type OrgMember } from '@/lib/useOrgMembers';

type DecisionRecord = {
  id: string;
  document_id: string | null;
  project_id: string | null;
  decision_type: string;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  confidence: number | null;
  source: string;
  created_at: string;
  first_detected_at: string | null;
  last_detected_at: string | null;
  resolved_at: string | null;
  due_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
  details: Record<string, unknown> | null;
};

type DecisionDetailViewProps = {
  decision: DecisionRecord;
  documentRef: DecisionDetailDocumentRef;
  documentLabel: string;
  documentHref: string | null;
  projectContextLabel: string | null;
  reason: string;
  primaryAction: DecisionAction | null;
  suggestedActions: DecisionAction[];
  summary: DecisionExecutiveSummary;
  evidence: DecisionEvidencePayload;
  projectValidation: DecisionProjectValidationContext;
  queueFindingAction: DecisionQueueFindingActionContext | null;
  executionStatus: DecisionWorkflowExecutionStatus | null;
  processState: DecisionProcessState;
  metrics: DecisionMetricCard[];
  relatedTasks: DecisionDetailTask[];
  feedback: DecisionDetailFeedback[];
  members: OrgMember[];
  organizationId: string | null;
  activityRefreshKey: number;
  statusControl: {
    options: readonly string[];
    updating: boolean;
    saved: boolean;
    error: boolean;
    onChange: (status: string) => void;
  };
  assignmentControl: {
    saving: boolean;
    saved: boolean;
    error: boolean;
    onChange: (assignedTo: string | null) => void;
  };
  dueDateControl: {
    saving: boolean;
    saved: boolean;
    error: boolean;
    onChange: (dueAt: string | null) => void;
  };
  feedbackControl: {
    saving: boolean;
    saved: boolean;
    error: string | null;
    onSubmit: (isCorrect: boolean, reviewErrorType?: ReviewErrorType) => void;
  };
};

function titleize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function severityConfig(severity: string): {
  label: string;
  textClass: string;
  surfaceClass: string;
  borderClass: string;
  accentClass: string;
} {
  switch (severity) {
    case 'critical':
      return {
        label: 'Risk detected',
        textClass: 'text-[#EF4444]',
        surfaceClass: 'bg-[#EF4444]/12',
        borderClass: 'border-[#EF4444]/30',
        accentClass: 'border-l-[#EF4444]',
      };
    case 'high':
      return {
        label: 'Needs review',
        textClass: 'text-[#F59E0B]',
        surfaceClass: 'bg-[#F59E0B]/12',
        borderClass: 'border-[#F59E0B]/30',
        accentClass: 'border-l-[#F59E0B]',
      };
    case 'medium':
      return {
        label: 'Review',
        textClass: 'text-[#F59E0B]',
        surfaceClass: 'bg-[#F59E0B]/12',
        borderClass: 'border-[#F59E0B]/30',
        accentClass: 'border-l-[#F59E0B]',
      };
    default:
      return {
        label: 'Low risk',
        textClass: 'text-[#22C55E]',
        surfaceClass: 'bg-[#22C55E]/12',
        borderClass: 'border-[#22C55E]/30',
        accentClass: 'border-l-[#22C55E]',
      };
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'open':
      return 'bg-[#F59E0B]/12 text-[#F59E0B] border border-[#F59E0B]/30';
    case 'in_review':
      return 'bg-[#3B82F6]/12 text-[#3B82F6] border border-[#3B82F6]/30';
    case 'resolved':
      return 'bg-[#22C55E]/12 text-[#22C55E] border border-[#22C55E]/30';
    case 'suppressed':
      return 'bg-[#243044] text-[#94A3B8] border border-[#2F3B52]';
    default:
      return 'bg-[#243044] text-[#94A3B8] border border-[#2F3B52]';
  }
}

function taskPriorityClass(priority: string): string {
  switch (priority) {
    case 'critical':
      return 'bg-[#EF4444]/12 text-[#EF4444] border border-[#EF4444]/30';
    case 'high':
      return 'bg-[#F59E0B]/12 text-[#F59E0B] border border-[#F59E0B]/30';
    case 'medium':
      return 'bg-[#3B82F6]/12 text-[#3B82F6] border border-[#3B82F6]/30';
    default:
      return 'bg-[#243044] text-[#94A3B8] border border-[#2F3B52]';
  }
}

function toneClass(tone: DecisionTone): string {
  switch (tone) {
    case 'brand':
      return 'text-[#3B82F6]';
    case 'success':
      return 'text-[#22C55E]';
    case 'warning':
      return 'text-[#F59E0B]';
    case 'danger':
      return 'text-[#EF4444]';
    default:
      return 'text-[#94A3B8]';
  }
}

function metricBarClass(tone: DecisionTone): string {
  switch (tone) {
    case 'brand':
      return 'bg-[#3B82F6]';
    case 'success':
      return 'bg-[#22C55E]';
    case 'warning':
      return 'bg-[#F59E0B]';
    case 'danger':
      return 'bg-[#EF4444]';
    default:
      return 'bg-[#94A3B8]';
  }
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not recorded';
}

function decisionReference(details: Record<string, unknown> | null, decisionType: string, id: string): string {
  const candidates = [
    typeof details?.rule_id === 'string' ? details.rule_id : null,
    typeof details?.identity_key === 'string' ? details.identity_key : null,
    decisionType,
    id,
  ];

  return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0) ?? id;
}

function headerCta(status: string): {
  label: string;
  nextStatus: string;
  className: string;
} {
  if (status === 'open') {
    return {
      label: 'Start remediation',
      nextStatus: 'in_review',
      className: 'bg-gradient-to-br from-[#3B82F6] to-[#2563EB] text-white hover:brightness-110',
    };
  }
  if (status === 'in_review') {
    return {
      label: 'Mark resolved',
      nextStatus: 'resolved',
      className: 'bg-gradient-to-br from-[#22C55E] to-[#16A34A] text-white hover:brightness-110',
    };
  }
  return {
    label: 'Re-open decision',
    nextStatus: 'open',
    className: 'bg-gradient-to-br from-[#3B82F6] to-[#2563EB] text-white hover:brightness-110',
  };
}

function feedbackLabel(row: DecisionDetailFeedback): string {
  if (row.is_correct === true) return 'Marked correct';
  if (row.review_error_type) return `Marked incorrect: ${titleize(row.review_error_type)}`;
  if (row.feedback_type) return titleize(row.feedback_type);
  if (row.disposition) return titleize(row.disposition);
  return 'Review event';
}

function feedbackTone(row: DecisionDetailFeedback): string {
  if (row.is_correct === true) return 'text-[#22C55E]';
  if (row.is_correct === false) return 'text-[#EF4444]';
  if (row.disposition === 'accept') return 'text-[#22C55E]';
  if (row.disposition === 'reject' || row.disposition === 'suppress') return 'text-[#EF4444]';
  if (row.disposition === 'escalate') return 'text-[#F59E0B]';
  return 'text-[#C7D2E3]';
}

function sortTasks(tasks: DecisionDetailTask[]): DecisionDetailTask[] {
  const statusRank: Record<string, number> = {
    open: 0,
    in_progress: 1,
    blocked: 2,
    resolved: 3,
    cancelled: 4,
  };
  const priorityRank: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return [...tasks].sort((left, right) => {
    const statusDelta = (statusRank[left.status] ?? 10) - (statusRank[right.status] ?? 10);
    if (statusDelta !== 0) return statusDelta;
    const priorityDelta = (priorityRank[left.priority] ?? 10) - (priorityRank[right.priority] ?? 10);
    if (priorityDelta !== 0) return priorityDelta;
    return left.title.localeCompare(right.title);
  });
}

function DecisionDetailHeader(props: {
  decision: DecisionRecord;
  documentLabel: string;
  documentHref: string | null;
  projectContextLabel: string | null;
  members: OrgMember[];
  statusControl: DecisionDetailViewProps['statusControl'];
  assignmentControl: DecisionDetailViewProps['assignmentControl'];
  dueDateControl: DecisionDetailViewProps['dueDateControl'];
}) {
  const {
    decision,
    documentLabel,
    documentHref,
    projectContextLabel,
    members,
    statusControl,
    assignmentControl,
    dueDateControl,
  } = props;
  const severity = severityConfig(decision.severity);
  const cta = headerCta(decision.status);
  const overdue = isDecisionOverdue(decision.due_at, decision.status);

  return (
    <section
      id="decision-header"
      className="mb-8 rounded-2xl border border-[#2F3B52] bg-[#111827] p-6 shadow-[0_24px_64px_rgba(8,13,29,0.35)]"
    >
      <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span className="rounded border border-[#2F3B52] bg-[#1A2333] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#3B82F6]">
              Decision
            </span>
            <span className="text-sm text-[#94A3B8]">
              Source document: <span className="font-medium text-[#E5EDF7]">{documentLabel}</span>
            </span>
          </div>

          <h1 className="text-3xl font-semibold tracking-tight text-[#E5EDF7]">
            {decision.title}
          </h1>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-[#94A3B8]">
            {projectContextLabel && (
              <span>
                Project: <span className="font-medium text-[#E5EDF7]">{projectContextLabel}</span>
              </span>
            )}
            <span className="hidden h-3 w-px bg-[#2F3B52] sm:block" />
            <span>Type: <span className="font-medium text-[#E5EDF7]">{titleize(decision.decision_type)}</span></span>
            <span className="hidden h-3 w-px bg-[#2F3B52] sm:block" />
            <span>Source: <span className="font-medium text-[#E5EDF7]">{titleize(decision.source)}</span></span>
            <span className={`inline-flex items-center gap-2 rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${severity.surfaceClass} ${severity.textClass} ${severity.borderClass} border`}>
              <span className={`h-2 w-2 rounded-full ${severity.textClass.replace('text', 'bg')}`} />
              {severity.label}
            </span>
            <span className={`inline-flex rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${statusBadgeClass(decision.status)}`}>
              {decision.status.replace(/_/g, ' ')}
            </span>
          </div>
        </div>

        <div className="flex w-full flex-col gap-4 xl:max-w-[420px]">
          <div className="flex flex-wrap gap-3">
            {documentHref && (
              <Link
                href={documentHref}
                className="inline-flex items-center justify-center rounded-md border border-[#2F3B52] bg-[#1A2333] px-4 py-2.5 text-sm font-medium text-[#E5EDF7] transition-colors hover:bg-[#243044]"
              >
                Open source document
              </Link>
            )}
            <button
              type="button"
              onClick={() => statusControl.onChange(cta.nextStatus)}
              disabled={statusControl.updating}
              className={`inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-60 ${cta.className}`}
            >
              {cta.label}
            </button>
          </div>

          <div className="rounded-xl border border-[#2F3B52] bg-[#0B1020] p-4">
            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.16em] text-[#94A3B8]">
                Owner
                <select
                  aria-label="Assign decision"
                  value={decision.assigned_to ?? ''}
                  onChange={(event) => assignmentControl.onChange(event.target.value || null)}
                  disabled={assignmentControl.saving}
                  className="rounded-md border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm font-medium normal-case tracking-normal text-[#E5EDF7] outline-none focus:border-[#3B82F6] disabled:opacity-60"
                >
                  <option value="">Unassigned</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.display_name ?? member.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.16em] text-[#94A3B8]">
                Due date
                <input
                  type="date"
                  value={decision.due_at ? dueDateInputValue(decision.due_at) : ''}
                  onChange={(event) => dueDateControl.onChange(dueDateToISO(event.target.value))}
                  disabled={dueDateControl.saving}
                  className="rounded-md border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm font-medium normal-case tracking-normal text-[#E5EDF7] outline-none focus:border-[#3B82F6] disabled:opacity-60"
                />
              </label>

              <div className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.16em] text-[#94A3B8]">
                Queue state
                <div className="rounded-md border border-[#2F3B52] bg-[#111827] px-3 py-[0.65rem] text-sm font-medium normal-case tracking-normal text-[#E5EDF7]">
                  {decision.due_at ? formatDueDate(decision.due_at) : memberDisplayName(members, decision.assigned_to)}
                  {overdue && <span className="ml-2 align-middle"><OverdueBadge /></span>}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[#94A3B8]">
              {assignmentControl.saved && <span className="text-[#22C55E]">Owner saved.</span>}
              {assignmentControl.error && <span className="text-[#EF4444]">Owner update failed.</span>}
              {dueDateControl.saved && <span className="text-[#22C55E]">Due date saved.</span>}
              {dueDateControl.error && <span className="text-[#EF4444]">Due date update failed.</span>}
              {decision.due_at && (
                <button
                  type="button"
                  onClick={() => dueDateControl.onChange(null)}
                  disabled={dueDateControl.saving}
                  className="text-[#C7D2E3] transition-colors hover:text-[#E5EDF7] disabled:opacity-60"
                >
                  Clear due date
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ExecutiveSummaryPanel({ summary }: { summary: DecisionExecutiveSummary }) {
  return (
    <section className="mb-8 overflow-hidden rounded-2xl border border-[#2F3B52] bg-[#111827]">
      <div className="border-l-4 border-[#3B82F6] p-6">
        <h2 className="mb-5 text-[11px] font-bold uppercase tracking-[0.22em] text-[#3B82F6]">
          Executive summary
        </h2>
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-4">
          <SummaryRow label="Input" value={summary.input} />
          <SummaryRow label="Truth" value={summary.truth} />
          <SummaryRow label="Gate" value={summary.gate} />
          <SummaryRow label="Action" value={summary.action} />
        </div>
        {summary.sparseSignals.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2">
            {summary.sparseSignals.map((signal) => (
              <span
                key={signal}
                className="rounded border border-[#F59E0B]/30 bg-[#F59E0B]/12 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#F59E0B]"
              >
                {signal}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        {label}
      </p>
      <p className="text-sm leading-6 text-[#E5EDF7]">
        {value}
      </p>
    </div>
  );
}

function CriticalDecisionNodesSection(props: {
  decision: DecisionRecord;
  reason: string;
  primaryAction: DecisionAction | null;
  suggestedActions: DecisionAction[];
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[#E5EDF7]">
            Critical Decision Nodes
          </h2>
          <p className="text-sm text-[#94A3B8]">
            The decision itself stays primary. Supporting actions stay attached to the same operator review thread.
          </p>
        </div>
        <span className="rounded border border-[#2F3B52] bg-[#111827] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
          1 primary node
        </span>
      </div>
      <DecisionNodeCard
        decision={props.decision}
        reason={props.reason}
        primaryAction={props.primaryAction}
        suggestedActions={props.suggestedActions}
      />
    </section>
  );
}

function DecisionNodeCard(props: {
  decision: DecisionRecord;
  reason: string;
  primaryAction: DecisionAction | null;
  suggestedActions: DecisionAction[];
}) {
  const { decision, reason, primaryAction, suggestedActions } = props;
  const severity = severityConfig(decision.severity);
  const reference = decisionReference(decision.details, decision.decision_type, decision.id);
  const vagueAction = primaryAction
    ? isVagueDecisionActionDescription(primaryAction.description)
    : false;

  return (
    <article className="overflow-hidden rounded-2xl border border-[#2F3B52] bg-[#1A2333] shadow-[0_20px_40px_rgba(8,13,29,0.28)]">
      <div className={`border-l-4 ${severity.accentClass} p-6`}>
        <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${severity.borderClass} ${severity.surfaceClass}`}>
              <span className={`text-sm font-bold ${severity.textClass}`}>!</span>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold text-[#E5EDF7]">
                  {decision.title}
                </h3>
                <span className={`inline-flex rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${severity.surfaceClass} ${severity.textClass} ${severity.borderClass} border`}>
                  {severity.label}
                </span>
                <span className={`inline-flex rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${statusBadgeClass(decision.status)}`}>
                  {decision.status.replace(/_/g, ' ')}
                </span>
              </div>
              <p className="mt-1 text-xs uppercase tracking-[0.16em] text-[#94A3B8]">
                Ref: {reference}
              </p>
            </div>
          </div>
          {typeof decision.confidence === 'number' && (
            <span className="text-sm font-medium text-[#C7D2E3]">
              {Math.round(decision.confidence * 100)}% confidence
            </span>
          )}
        </div>

        <p className="text-sm leading-7 text-[#C7D2E3]">
          {reason || decision.summary || 'This decision does not include a structured rationale yet.'}
        </p>

        <div className="mt-6 flex flex-col gap-4">
          {primaryAction ? (
            <div className={`rounded-xl border p-4 ${vagueAction ? 'border-[#F59E0B]/30 bg-[#F59E0B]/10' : 'border-[#3B82F6]/25 bg-[#111827]'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#3B82F6]">
                  Primary action
                </span>
                <span className={`rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${primaryAction.resolvable ? 'bg-[#22C55E]/12 text-[#22C55E]' : 'bg-[#243044] text-[#C7D2E3]'}`}>
                  {primaryAction.resolvable ? 'In product' : 'Manual step'}
                </span>
                {vagueAction && (
                  <span className="rounded bg-[#F59E0B]/12 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#F59E0B]">
                    Vague action
                  </span>
                )}
              </div>
              <p className="mt-3 text-sm font-medium text-[#E5EDF7]">
                {primaryAction.description}
              </p>
              <p className="mt-2 text-sm text-[#94A3B8]">
                {primaryAction.expected_outcome}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-[#EF4444]/30 bg-[#EF4444]/10 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#EF4444]">
                Missing primary action
              </p>
              <p className="mt-2 text-sm text-[#E5EDF7]">
                This decision payload does not include a concrete next step for the operator. Treat this as a product defect, not a resolved decision.
              </p>
            </div>
          )}

          {suggestedActions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestedActions.map((action) => (
                <span
                  key={action.id}
                  className="rounded border border-[#2F3B52] bg-[#111827] px-3 py-2 text-xs font-medium text-[#C7D2E3]"
                >
                  {action.description}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function ActionResolutionPanel(props: {
  decision: DecisionRecord;
  primaryAction: DecisionAction | null;
  relatedTasks: DecisionDetailTask[];
  feedback: DecisionDetailFeedback[];
  members: OrgMember[];
  statusControl: DecisionDetailViewProps['statusControl'];
  feedbackControl: DecisionDetailViewProps['feedbackControl'];
}) {
  const {
    decision,
    primaryAction,
    relatedTasks,
    feedback,
    members,
    statusControl,
    feedbackControl,
  } = props;
  const decisionId = decision.id;
  const sortedTasks = sortTasks(relatedTasks);
  const recentFeedback = [...feedback]
    .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
    .slice(0, 4);
  const vagueAction = primaryAction
    ? isVagueDecisionActionDescription(primaryAction.description)
    : false;

  return (
    <section
      id="decision-workflow"
      className="rounded-2xl border border-[#2F3B52] bg-[#111827] p-6"
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[#E5EDF7]">
            Remediation and Resolution
          </h2>
          <p className="text-sm text-[#94A3B8]">
            Status control, review feedback, and workflow tasks stay attached to the live decision.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-5">
          <div className="rounded-xl border border-[#2F3B52] bg-[#0B1020] p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#3B82F6]">
              Next operator move
            </p>
            <p className="mt-3 text-sm text-[#E5EDF7]">
              {primaryAction?.description ?? 'No primary action emitted for this decision yet.'}
            </p>
            <p className="mt-2 text-sm text-[#94A3B8]">
              {primaryAction?.expected_outcome ?? 'Escalate the missing action payload so the decision engine can emit a reviewable next step.'}
            </p>
            {vagueAction && (
              <p className="mt-3 rounded border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-3 py-2 text-sm text-[#F59E0B]">
                The current primary action is too vague for operator trust. It should be tightened in the decision output.
              </p>
            )}
          </div>

          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              Decision status
            </p>
            <div className="flex flex-wrap gap-2">
              {statusControl.options.map((status) => {
                const isActive = status === decision.status;
                return (
                  <button
                    key={status}
                    type="button"
                    onClick={() => statusControl.onChange(status)}
                    disabled={statusControl.updating}
                    className={`rounded-md px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] transition-colors disabled:opacity-60 ${
                      isActive
                        ? 'bg-[#3B82F6] text-white'
                        : 'border border-[#2F3B52] bg-[#1A2333] text-[#C7D2E3] hover:bg-[#243044]'
                    }`}
                  >
                    {status.replace(/_/g, ' ')}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-[#94A3B8]">
              {statusControl.updating && <span>Saving status...</span>}
              {statusControl.saved && <span className="text-[#22C55E]">Status saved.</span>}
              {statusControl.error && <span className="text-[#EF4444]">Status update failed.</span>}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              Operator feedback
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => feedbackControl.onSubmit(true)}
                disabled={feedbackControl.saving}
                className="rounded-md border border-[#22C55E]/30 bg-[#22C55E]/12 px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-[#22C55E] transition-colors hover:bg-[#22C55E]/18 disabled:opacity-60"
              >
                Mark correct
              </button>
              <button
                type="button"
                onClick={() => feedbackControl.onSubmit(false, 'extraction_error')}
                disabled={feedbackControl.saving}
                className="rounded-md border border-[#EF4444]/30 bg-[#EF4444]/12 px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-[#EF4444] transition-colors hover:bg-[#EF4444]/18 disabled:opacity-60"
              >
                Extraction error
              </button>
              <button
                type="button"
                onClick={() => feedbackControl.onSubmit(false, 'rule_error')}
                disabled={feedbackControl.saving}
                className="rounded-md border border-[#F59E0B]/30 bg-[#F59E0B]/12 px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-[#F59E0B] transition-colors hover:bg-[#F59E0B]/18 disabled:opacity-60"
              >
                Rule error
              </button>
              <button
                type="button"
                onClick={() => feedbackControl.onSubmit(false, 'edge_case')}
                disabled={feedbackControl.saving}
                className="rounded-md border border-[#2F3B52] bg-[#1A2333] px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-[#C7D2E3] transition-colors hover:bg-[#243044] disabled:opacity-60"
              >
                Edge case
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-[#94A3B8]">
              {feedbackControl.saving && <span>Saving feedback...</span>}
              {feedbackControl.saved && <span className="text-[#22C55E]">Feedback saved.</span>}
              {feedbackControl.error && <span className="text-[#EF4444]">{feedbackControl.error}</span>}
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-xl border border-[#2F3B52] bg-[#0B1020] p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              Workflow tasks
            </p>
            {sortedTasks.length === 0 ? (
              <p className="mt-3 text-sm text-[#C7D2E3]">
                No persisted workflow tasks were found for this decision yet.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {sortedTasks.map((task) => (
                  <div
                    key={task.id}
                    className="block rounded-xl border border-[#2F3B52] bg-[#111827] p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-[#E5EDF7]">{task.title}</p>
                          <span className={`rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${taskPriorityClass(task.priority)}`}>
                            {task.priority}
                          </span>
                          <span className={`rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${statusBadgeClass(task.status)}`}>
                            {task.status.replace(/_/g, ' ')}
                          </span>
                        </div>
                        {task.description && (
                          <p className="mt-2 text-sm text-[#94A3B8]">{task.description}</p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-3 text-xs text-[#94A3B8]">
                          <span>Type: {titleize(task.task_type)}</span>
                          <span>Owner: {memberDisplayName(members, task.assigned_to)}</span>
                          {task.due_at && (
                            <span>
                              Due: {formatDueDate(task.due_at)}
                              {isTaskOverdue(task.due_at, task.status) && <span className="ml-2 align-middle"><OverdueBadge /></span>}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DecisionWorkflowOutcomePanel decisionId={decisionId} />

          <div className="rounded-xl border border-[#2F3B52] bg-[#0B1020] p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              Review log
            </p>
            {recentFeedback.length === 0 ? (
              <p className="mt-3 text-sm text-[#C7D2E3]">
                No operator feedback has been recorded yet.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {recentFeedback.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-xl border border-[#2F3B52] bg-[#111827] p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className={`text-sm font-medium ${feedbackTone(row)}`}>
                        {feedbackLabel(row)}
                      </p>
                      <span className="text-xs text-[#94A3B8]">
                        {formatDateTime(row.created_at)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-[#94A3B8]">
                      {row.feedback_type && <span>Type: {titleize(row.feedback_type)}</span>}
                      {row.disposition && <span>Disposition: {titleize(row.disposition)}</span>}
                      {row.decision_status_at_feedback && (
                        <span>Status at review: {titleize(row.decision_status_at_feedback)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function EvidenceEnginePanel(props: {
  evidence: DecisionEvidencePayload;
  details: Record<string, unknown> | null;
}) {
  const { evidence, details } = props;
  const leadMetric = evidence.metrics[0];
  const trailingMetrics = evidence.metrics.slice(1);
  const hasRawDetails = details != null && Object.keys(details).length > 0;

  return (
    <section className="rounded-2xl border border-[#2F3B52] bg-[#1A2333] p-6">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#3B82F6]">
        Evidence engine
      </h2>

      {!evidence.hasStructuredEvidence && (
        <div className="mt-4 rounded-xl border border-[#F59E0B]/30 bg-[#F59E0B]/10 p-4 text-sm text-[#F59E0B]">
          No structured evidence payload was emitted for this decision. What you see below is the thinnest reliable fallback we could derive from the persisted record.
        </div>
      )}

      {leadMetric && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm text-[#94A3B8]">{leadMetric.label}</span>
            <span className={`text-sm font-semibold ${toneClass(leadMetric.tone)}`}>
              {leadMetric.value}
            </span>
          </div>
          {typeof leadMetric.progress === 'number' && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-[#0B1020]">
              <div
                className={`h-full ${metricBarClass(leadMetric.tone)}`}
                style={{ width: `${leadMetric.progress}%` }}
              />
            </div>
          )}
          {leadMetric.detail && (
            <p className="mt-3 text-sm text-[#C7D2E3]">{leadMetric.detail}</p>
          )}
        </div>
      )}

      {trailingMetrics.length > 0 && (
        <div className="mt-5 space-y-3">
          {trailingMetrics.map((metric) => (
            <div key={metric.id} className="rounded-xl border border-[#2F3B52] bg-[#111827] p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-[#94A3B8]">{metric.label}</span>
                <span className={`text-sm font-semibold ${toneClass(metric.tone)}`}>
                  {metric.value}
                </span>
              </div>
              {metric.detail && (
                <p className="mt-2 text-sm text-[#C7D2E3]">{metric.detail}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {evidence.references.length > 0 && (
        <div className="mt-5 space-y-3">
          {evidence.references.map((reference) => (
            <div key={reference.id} className="flex gap-3 rounded-xl border border-[#2F3B52] bg-[#111827] p-4">
              <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[#3B82F6]" />
              <div>
                <p className="text-sm font-medium text-[#E5EDF7]">{reference.label}</p>
                <p className="mt-1 text-xs text-[#94A3B8]">{reference.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {evidence.notes.length > 0 && (
        <div className="mt-5 space-y-3">
          {evidence.notes.map((note) => (
            <div key={note.id} className="rounded-xl border border-[#2F3B52] bg-[#111827] p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#3B82F6]">
                {note.label}
              </p>
              <p className="mt-2 text-sm leading-6 text-[#C7D2E3]">
                {note.body}
              </p>
            </div>
          ))}
        </div>
      )}

      {hasRawDetails && (
        <details className="mt-5 rounded-xl border border-[#2F3B52] bg-[#111827] p-4">
          <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Raw payload
          </summary>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[#0B1020] p-3 text-[11px] text-[#C7D2E3]">
            {JSON.stringify(details, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}

function ProcessPositionPanel({ processState }: { processState: DecisionProcessState }) {
  return (
    <section className="rounded-2xl border border-[#2F3B52] bg-[#1A2333] p-6">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#3B82F6]">
        Process position
      </h2>
      <p className="mt-4 text-base font-semibold text-[#E5EDF7]">
        {processState.headline}
      </p>
      <p className="mt-2 text-sm text-[#94A3B8]">
        {processState.detail}
      </p>

      <div className="relative mt-6 space-y-6 pl-7">
        <div className="absolute left-[0.78rem] top-1 bottom-1 w-px bg-[#2F3B52]" />
        {processState.steps.map((step) => (
          <div key={step.id} className="relative">
            <div className={`absolute -left-[1.05rem] top-1.5 h-3.5 w-3.5 rounded-full ${processStepDot(step.state)}`} />
            <p className={`text-sm font-medium ${processStepText(step.state)}`}>
              {step.label}
            </p>
            {step.detail && (
              <p className="mt-1 text-xs text-[#94A3B8]">{step.detail}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function processStepDot(state: DecisionProcessState['steps'][number]['state']): string {
  switch (state) {
    case 'complete':
      return 'bg-[#22C55E] shadow-[0_0_10px_rgba(34,197,94,0.4)]';
    case 'current':
      return 'bg-[#3B82F6] ring-4 ring-[#3B82F6]/20';
    case 'attention':
      return 'bg-[#EF4444] shadow-[0_0_10px_rgba(239,68,68,0.4)]';
    default:
      return 'bg-[#2F3B52]';
  }
}

function processStepText(state: DecisionProcessState['steps'][number]['state']): string {
  switch (state) {
    case 'complete':
      return 'text-[#E5EDF7]';
    case 'current':
      return 'text-[#3B82F6]';
    case 'attention':
      return 'text-[#EF4444]';
    default:
      return 'text-[#94A3B8]';
  }
}

function DecisionMetricsPanel({ metrics }: { metrics: DecisionMetricCard[] }) {
  if (metrics.length === 0) return null;

  return (
    <section className="rounded-2xl border border-[#2F3B52] bg-[#1A2333] p-6">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#3B82F6]">
        Decision metrics
      </h2>
      <div className="mt-5 grid grid-cols-2 gap-4">
        {metrics.map((metric) => (
          <div key={metric.id} className="rounded-xl border border-[#2F3B52] bg-[#111827] p-4 text-center">
            <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              {metric.label}
            </span>
            <span className={`mt-2 block text-2xl font-semibold tracking-tight ${toneClass(metric.tone)}`}>
              {metric.value}
            </span>
            {metric.detail && (
              <span className="mt-1 block text-xs text-[#94A3B8]">{metric.detail}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function DecisionDetailView(props: DecisionDetailViewProps) {
  const {
    decision,
    documentRef,
    documentLabel,
    documentHref,
    projectContextLabel,
    reason,
    primaryAction,
    suggestedActions,
    summary,
    evidence,
    projectValidation,
    queueFindingAction,
    executionStatus,
    processState,
    metrics,
    relatedTasks,
    feedback,
    members,
    organizationId,
    activityRefreshKey,
    statusControl,
    assignmentControl,
    dueDateControl,
    feedbackControl,
  } = props;

  return (
    <div className="min-h-full bg-[#0B1020]">
      <div className="mx-auto max-w-[1600px] px-6 py-8 lg:px-8">
        <DecisionDetailHeader
          decision={decision}
          documentLabel={documentLabel}
          documentHref={documentHref}
          projectContextLabel={projectContextLabel}
          members={members}
          statusControl={statusControl}
          assignmentControl={assignmentControl}
          dueDateControl={dueDateControl}
        />

        <ExecutiveSummaryPanel summary={summary} />

        <DecisionContextPanel
          decisionId={decision.id}
          decisionDetails={decision.details}
          decisionStatus={decision.status}
          documentId={decision.document_id}
          documentLabel={documentLabel}
          documentHref={documentHref}
          evidence={evidence}
          primaryAction={primaryAction}
          projectId={decision.project_id}
          projectValidation={projectValidation}
          queueFindingAction={queueFindingAction}
          relatedTasks={relatedTasks.map((task) => ({
            id: task.id,
            status: task.status,
            title: task.title,
          }))}
          executionStatus={executionStatus}
        />

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-8">
            <CriticalDecisionNodesSection
              decision={decision}
              reason={reason}
              primaryAction={primaryAction}
              suggestedActions={suggestedActions}
            />

            <ActionResolutionPanel
              decision={decision}
              primaryAction={primaryAction}
              relatedTasks={relatedTasks}
              feedback={feedback}
              members={members}
              statusControl={statusControl}
              feedbackControl={feedbackControl}
            />
          </div>

          <div className="space-y-6">
            <EvidenceEnginePanel evidence={evidence} details={decision.details} />
            <ProcessPositionPanel processState={processState} />
            <DecisionMetricsPanel metrics={metrics} />
          </div>
        </div>

        <section id="decision-activity" className="mt-8">
          <ActivityTimeline
            organizationId={organizationId}
            entityType="decision"
            entityId={decision.id}
            refreshKey={activityRefreshKey}
          />
        </section>

        <section className="mt-8 rounded-2xl border border-[#2F3B52] bg-[#111827] p-6">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#3B82F6]">
            Decision metadata
          </h2>
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetaCell label="Decision type" value={titleize(decision.decision_type)} />
            <MetaCell label="Created" value={formatDateTime(decision.created_at)} />
            <MetaCell label="Last detected" value={formatDateTime(decision.last_detected_at ?? decision.created_at)} />
            <MetaCell label="Assigned at" value={formatDateTime(decision.assigned_at)} />
            <MetaCell label="Resolved at" value={formatDateTime(decision.resolved_at)} />
            <MetaCell label="Source document" value={documentLabel} />
            <MetaCell label="Document processing" value={documentRef?.processing_status ? titleize(documentRef.processing_status) : 'Not available'} />
            <MetaCell label="Current owner" value={memberDisplayName(members, decision.assigned_to)} />
          </div>
        </section>
      </div>
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#2F3B52] bg-[#0B1020] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        {label}
      </p>
      <p className="mt-2 text-sm text-[#E5EDF7]">{value}</p>
    </div>
  );
}
