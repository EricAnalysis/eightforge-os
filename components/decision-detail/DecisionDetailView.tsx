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
        textClass: 'text-[var(--ef-critical)]',
        surfaceClass: 'bg-[var(--ef-critical-a12)]',
        borderClass: 'border-[var(--ef-critical-a30)]',
        accentClass: 'border-l-[var(--ef-critical)]',
      };
    case 'high':
      return {
        label: 'Needs review',
        textClass: 'text-[var(--ef-warning)]',
        surfaceClass: 'bg-[var(--ef-warning-bg)]',
        borderClass: 'border-[var(--ef-warning-a30)]',
        accentClass: 'border-l-[var(--ef-warning)]',
      };
    case 'medium':
      return {
        label: 'Review',
        textClass: 'text-[var(--ef-warning)]',
        surfaceClass: 'bg-[var(--ef-warning-bg)]',
        borderClass: 'border-[var(--ef-warning-a30)]',
        accentClass: 'border-l-[var(--ef-warning)]',
      };
    default:
      return {
        label: 'Low risk',
        textClass: 'text-[var(--ef-success)]',
        surfaceClass: 'bg-[var(--ef-success-bg)]',
        borderClass: 'border-[var(--ef-success-a30)]',
        accentClass: 'border-l-[var(--ef-success)]',
      };
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'open':
      return 'bg-[var(--ef-warning-bg)] text-[var(--ef-warning)] border border-[var(--ef-warning-a30)]';
    case 'in_review':
      return 'bg-[var(--ef-purple-primary-a12)] text-[var(--ef-purple-primary)] border border-[var(--ef-purple-primary-a30)]';
    case 'resolved':
      return 'bg-[var(--ef-success-bg)] text-[var(--ef-success)] border border-[var(--ef-success-a30)]';
    case 'suppressed':
      return 'bg-[var(--ef-surface-hover)] text-[var(--ef-text-muted)] border border-[var(--ef-border-subtle)]';
    default:
      return 'bg-[var(--ef-surface-hover)] text-[var(--ef-text-muted)] border border-[var(--ef-border-subtle)]';
  }
}

function taskPriorityClass(priority: string): string {
  switch (priority) {
    case 'critical':
      return 'bg-[var(--ef-critical-a12)] text-[var(--ef-critical)] border border-[var(--ef-critical-a30)]';
    case 'high':
      return 'bg-[var(--ef-warning-bg)] text-[var(--ef-warning)] border border-[var(--ef-warning-a30)]';
    case 'medium':
      return 'bg-[var(--ef-purple-primary-a12)] text-[var(--ef-purple-primary)] border border-[var(--ef-purple-primary-a30)]';
    default:
      return 'bg-[var(--ef-surface-hover)] text-[var(--ef-text-muted)] border border-[var(--ef-border-subtle)]';
  }
}

function toneClass(tone: DecisionTone): string {
  switch (tone) {
    case 'brand':
      return 'text-[var(--ef-purple-primary)]';
    case 'success':
      return 'text-[var(--ef-success)]';
    case 'warning':
      return 'text-[var(--ef-warning)]';
    case 'danger':
      return 'text-[var(--ef-critical)]';
    default:
      return 'text-[var(--ef-text-muted)]';
  }
}

function metricBarClass(tone: DecisionTone): string {
  switch (tone) {
    case 'brand':
      return 'bg-[var(--ef-purple-primary)]';
    case 'success':
      return 'bg-[var(--ef-success)]';
    case 'warning':
      return 'bg-[var(--ef-warning)]';
    case 'danger':
      return 'bg-[var(--ef-critical)]';
    default:
      return 'bg-[var(--ef-text-muted)]';
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
      className: 'bg-gradient-to-br from-[var(--ef-purple-primary)] to-[var(--ef-purple-glow)] text-white hover:brightness-110',
    };
  }
  if (status === 'in_review') {
    return {
      label: 'Mark resolved',
      nextStatus: 'resolved',
      className: 'bg-gradient-to-br from-[var(--ef-success)] to-[var(--ef-success-soft)] text-white hover:brightness-110',
    };
  }
  return {
    label: 'Re-open decision',
    nextStatus: 'open',
    className: 'bg-gradient-to-br from-[var(--ef-purple-primary)] to-[var(--ef-purple-glow)] text-white hover:brightness-110',
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
  if (row.is_correct === true) return 'text-[var(--ef-success)]';
  if (row.is_correct === false) return 'text-[var(--ef-critical)]';
  if (row.disposition === 'accept') return 'text-[var(--ef-success)]';
  if (row.disposition === 'reject' || row.disposition === 'suppress') return 'text-[var(--ef-critical)]';
  if (row.disposition === 'escalate') return 'text-[var(--ef-warning)]';
  return 'text-[var(--ef-text-secondary)]';
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
      className="mb-8 rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-6 shadow-[0_24px_64px_var(--ef-shadow-medium)]"
    >
      <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span className="rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-purple-primary)]">
              Decision
            </span>
            <span className="text-sm text-[var(--ef-text-muted)]">
              Source document: <span className="font-medium text-[var(--ef-text-primary)]">{documentLabel}</span>
            </span>
          </div>

          <h1 className="text-3xl font-semibold tracking-tight text-[var(--ef-text-primary)]">
            {decision.title}
          </h1>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-[var(--ef-text-muted)]">
            {projectContextLabel && (
              <span>
                Project: <span className="font-medium text-[var(--ef-text-primary)]">{projectContextLabel}</span>
              </span>
            )}
            <span className="hidden h-3 w-px bg-[var(--ef-border-subtle)] sm:block" />
            <span>Type: <span className="font-medium text-[var(--ef-text-primary)]">{titleize(decision.decision_type)}</span></span>
            <span className="hidden h-3 w-px bg-[var(--ef-border-subtle)] sm:block" />
            <span>Source: <span className="font-medium text-[var(--ef-text-primary)]">{titleize(decision.source)}</span></span>
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
                className="inline-flex items-center justify-center rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] px-4 py-2.5 text-sm font-medium text-[var(--ef-text-primary)] transition-colors hover:bg-[var(--ef-surface-hover)]"
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

          <div className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] p-4">
            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                Owner
                <select
                  aria-label="Assign decision"
                  value={decision.assigned_to ?? ''}
                  onChange={(event) => assignmentControl.onChange(event.target.value || null)}
                  disabled={assignmentControl.saving}
                  className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-sm font-medium normal-case tracking-normal text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)] disabled:opacity-60"
                >
                  <option value="">Unassigned</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.display_name ?? member.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                Due date
                <input
                  type="date"
                  value={decision.due_at ? dueDateInputValue(decision.due_at) : ''}
                  onChange={(event) => dueDateControl.onChange(dueDateToISO(event.target.value))}
                  disabled={dueDateControl.saving}
                  className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-sm font-medium normal-case tracking-normal text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)] disabled:opacity-60"
                />
              </label>

              <div className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                Queue state
                <div className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-[0.65rem] text-sm font-medium normal-case tracking-normal text-[var(--ef-text-primary)]">
                  {decision.due_at ? formatDueDate(decision.due_at) : memberDisplayName(members, decision.assigned_to)}
                  {overdue && <span className="ml-2 align-middle"><OverdueBadge /></span>}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--ef-text-muted)]">
              {assignmentControl.saved && <span className="text-[var(--ef-success)]">Owner saved.</span>}
              {assignmentControl.error && <span className="text-[var(--ef-critical)]">Owner update failed.</span>}
              {dueDateControl.saved && <span className="text-[var(--ef-success)]">Due date saved.</span>}
              {dueDateControl.error && <span className="text-[var(--ef-critical)]">Due date update failed.</span>}
              {decision.due_at && (
                <button
                  type="button"
                  onClick={() => dueDateControl.onChange(null)}
                  disabled={dueDateControl.saving}
                  className="text-[var(--ef-text-secondary)] transition-colors hover:text-[var(--ef-text-primary)] disabled:opacity-60"
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
    <section className="mb-8 overflow-hidden rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)]">
      <div className="border-l-4 border-[var(--ef-purple-primary)] p-6">
        <h2 className="mb-5 text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ef-purple-primary)]">
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
                className="rounded border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-warning)]"
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
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
        {label}
      </p>
      <p className="text-sm leading-6 text-[var(--ef-text-primary)]">
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
          <h2 className="text-xl font-semibold tracking-tight text-[var(--ef-text-primary)]">
            Critical Decision Nodes
          </h2>
          <p className="text-sm text-[var(--ef-text-muted)]">
            The decision itself stays primary. Supporting actions stay attached to the same operator review thread.
          </p>
        </div>
        <span className="rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
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
    <article className="overflow-hidden rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] shadow-[0_20px_40px_var(--ef-shadow-soft)]">
      <div className={`border-l-4 ${severity.accentClass} p-6`}>
        <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${severity.borderClass} ${severity.surfaceClass}`}>
              <span className={`text-sm font-bold ${severity.textClass}`}>!</span>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold text-[var(--ef-text-primary)]">
                  {decision.title}
                </h3>
                <span className={`inline-flex rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${severity.surfaceClass} ${severity.textClass} ${severity.borderClass} border`}>
                  {severity.label}
                </span>
                <span className={`inline-flex rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${statusBadgeClass(decision.status)}`}>
                  {decision.status.replace(/_/g, ' ')}
                </span>
              </div>
              <p className="mt-1 text-xs uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                Ref: {reference}
              </p>
            </div>
          </div>
          {typeof decision.confidence === 'number' && (
            <span className="text-sm font-medium text-[var(--ef-text-secondary)]">
              {Math.round(decision.confidence * 100)}% confidence
            </span>
          )}
        </div>

        <p className="text-sm leading-7 text-[var(--ef-text-secondary)]">
          {reason || decision.summary || 'This decision does not include a structured rationale yet.'}
        </p>

        <div className="mt-6 flex flex-col gap-4">
          {primaryAction ? (
            <div className={`rounded-xl border p-4 ${vagueAction ? 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)]' : 'border-[var(--ef-purple-primary-a25)] bg-[var(--ef-background-secondary)]'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-purple-primary)]">
                  Primary action
                </span>
                <span className={`rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${primaryAction.resolvable ? 'bg-[var(--ef-success-bg)] text-[var(--ef-success)]' : 'bg-[var(--ef-surface-hover)] text-[var(--ef-text-secondary)]'}`}>
                  {primaryAction.resolvable ? 'In product' : 'Manual step'}
                </span>
                {vagueAction && (
                  <span className="rounded bg-[var(--ef-warning-bg)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-warning)]">
                    Vague action
                  </span>
                )}
              </div>
              <p className="mt-3 text-sm font-medium text-[var(--ef-text-primary)]">
                {primaryAction.description}
              </p>
              <p className="mt-2 text-sm text-[var(--ef-text-muted)]">
                {primaryAction.expected_outcome}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-critical)]">
                Missing primary action
              </p>
              <p className="mt-2 text-sm text-[var(--ef-text-primary)]">
                This decision payload does not include a concrete next step for the operator. Treat this as a product defect, not a resolved decision.
              </p>
            </div>
          )}

          {suggestedActions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestedActions.map((action) => (
                <span
                  key={action.id}
                  className="rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs font-medium text-[var(--ef-text-secondary)]"
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
      className="rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-6"
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-[var(--ef-text-primary)]">
            Remediation and Resolution
          </h2>
          <p className="text-sm text-[var(--ef-text-muted)]">
            Status control, review feedback, and workflow tasks stay attached to the live decision.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-5">
          <div className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-purple-primary)]">
              Next operator move
            </p>
            <p className="mt-3 text-sm text-[var(--ef-text-primary)]">
              {primaryAction?.description ?? 'No primary action emitted for this decision yet.'}
            </p>
            <p className="mt-2 text-sm text-[var(--ef-text-muted)]">
              {primaryAction?.expected_outcome ?? 'Escalate the missing action payload so the decision engine can emit a reviewable next step.'}
            </p>
            {vagueAction && (
              <p className="mt-3 rounded border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-sm text-[var(--ef-warning)]">
                The current primary action is too vague for operator trust. It should be tightened in the decision output.
              </p>
            )}
          </div>

          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
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
                        ? 'bg-[var(--ef-purple-primary)] text-white'
                        : 'border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-secondary)] hover:bg-[var(--ef-surface-hover)]'
                    }`}
                  >
                    {status.replace(/_/g, ' ')}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--ef-text-muted)]">
              {statusControl.updating && <span>Saving status...</span>}
              {statusControl.saved && <span className="text-[var(--ef-success)]">Status saved.</span>}
              {statusControl.error && <span className="text-[var(--ef-critical)]">Status update failed.</span>}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
              Operator feedback
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => feedbackControl.onSubmit(true)}
                disabled={feedbackControl.saving}
                className="rounded-md border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ef-success)] transition-colors hover:bg-[var(--ef-success-a18)] disabled:opacity-60"
              >
                Mark correct
              </button>
              <button
                type="button"
                onClick={() => feedbackControl.onSubmit(false, 'extraction_error')}
                disabled={feedbackControl.saving}
                className="rounded-md border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a12)] px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ef-critical)] transition-colors hover:bg-[var(--ef-critical-a18)] disabled:opacity-60"
              >
                Extraction error
              </button>
              <button
                type="button"
                onClick={() => feedbackControl.onSubmit(false, 'rule_error')}
                disabled={feedbackControl.saving}
                className="rounded-md border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ef-warning)] transition-colors hover:bg-[var(--ef-warning-a18)] disabled:opacity-60"
              >
                Rule error
              </button>
              <button
                type="button"
                onClick={() => feedbackControl.onSubmit(false, 'edge_case')}
                disabled={feedbackControl.saving}
                className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] px-3 py-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ef-text-secondary)] transition-colors hover:bg-[var(--ef-surface-hover)] disabled:opacity-60"
              >
                Edge case
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--ef-text-muted)]">
              {feedbackControl.saving && <span>Saving feedback...</span>}
              {feedbackControl.saved && <span className="text-[var(--ef-success)]">Feedback saved.</span>}
              {feedbackControl.error && <span className="text-[var(--ef-critical)]">{feedbackControl.error}</span>}
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
              Workflow tasks
            </p>
            {sortedTasks.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--ef-text-secondary)]">
                No persisted workflow tasks were found for this decision yet.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {sortedTasks.map((task) => (
                  <div
                    key={task.id}
                    className="block rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-[var(--ef-text-primary)]">{task.title}</p>
                          <span className={`rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${taskPriorityClass(task.priority)}`}>
                            {task.priority}
                          </span>
                          <span className={`rounded px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${statusBadgeClass(task.status)}`}>
                            {task.status.replace(/_/g, ' ')}
                          </span>
                        </div>
                        {task.description && (
                          <p className="mt-2 text-sm text-[var(--ef-text-muted)]">{task.description}</p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--ef-text-muted)]">
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

          <div className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
              Review log
            </p>
            {recentFeedback.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--ef-text-secondary)]">
                No operator feedback has been recorded yet.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {recentFeedback.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className={`text-sm font-medium ${feedbackTone(row)}`}>
                        {feedbackLabel(row)}
                      </p>
                      <span className="text-xs text-[var(--ef-text-muted)]">
                        {formatDateTime(row.created_at)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--ef-text-muted)]">
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
    <section className="rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] p-6">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ef-purple-primary)]">
        Evidence engine
      </h2>

      {!evidence.hasStructuredEvidence && (
        <div className="mt-4 rounded-xl border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] p-4 text-sm text-[var(--ef-warning)]">
          No structured evidence payload was emitted for this decision. What you see below is the thinnest reliable fallback we could derive from the persisted record.
        </div>
      )}

      {leadMetric && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--ef-text-muted)]">{leadMetric.label}</span>
            <span className={`text-sm font-semibold ${toneClass(leadMetric.tone)}`}>
              {leadMetric.value}
            </span>
          </div>
          {typeof leadMetric.progress === 'number' && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--ef-background-primary)]">
              <div
                className={`h-full ${metricBarClass(leadMetric.tone)}`}
                style={{ width: `${leadMetric.progress}%` }}
              />
            </div>
          )}
          {leadMetric.detail && (
            <p className="mt-3 text-sm text-[var(--ef-text-secondary)]">{leadMetric.detail}</p>
          )}
        </div>
      )}

      {trailingMetrics.length > 0 && (
        <div className="mt-5 space-y-3">
          {trailingMetrics.map((metric) => (
            <div key={metric.id} className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-[var(--ef-text-muted)]">{metric.label}</span>
                <span className={`text-sm font-semibold ${toneClass(metric.tone)}`}>
                  {metric.value}
                </span>
              </div>
              {metric.detail && (
                <p className="mt-2 text-sm text-[var(--ef-text-secondary)]">{metric.detail}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {evidence.references.length > 0 && (
        <div className="mt-5 space-y-3">
          {evidence.references.map((reference) => (
            <div key={reference.id} className="flex gap-3 rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-4">
              <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--ef-purple-primary)]" />
              <div>
                <p className="text-sm font-medium text-[var(--ef-text-primary)]">{reference.label}</p>
                <p className="mt-1 text-xs text-[var(--ef-text-muted)]">{reference.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {evidence.notes.length > 0 && (
        <div className="mt-5 space-y-3">
          {evidence.notes.map((note) => (
            <div key={note.id} className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-purple-primary)]">
                {note.label}
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--ef-text-secondary)]">
                {note.body}
              </p>
            </div>
          ))}
        </div>
      )}

      {hasRawDetails && (
        <details className="mt-5 rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-4">
          <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Raw payload
          </summary>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--ef-background-primary)] p-3 text-[11px] text-[var(--ef-text-secondary)]">
            {JSON.stringify(details, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}

function ProcessPositionPanel({ processState }: { processState: DecisionProcessState }) {
  return (
    <section className="rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] p-6">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ef-purple-primary)]">
        Process position
      </h2>
      <p className="mt-4 text-base font-semibold text-[var(--ef-text-primary)]">
        {processState.headline}
      </p>
      <p className="mt-2 text-sm text-[var(--ef-text-muted)]">
        {processState.detail}
      </p>

      <div className="relative mt-6 space-y-6 pl-7">
        <div className="absolute left-[0.78rem] top-1 bottom-1 w-px bg-[var(--ef-border-subtle)]" />
        {processState.steps.map((step) => (
          <div key={step.id} className="relative">
            <div className={`absolute -left-[1.05rem] top-1.5 h-3.5 w-3.5 rounded-full ${processStepDot(step.state)}`} />
            <p className={`text-sm font-medium ${processStepText(step.state)}`}>
              {step.label}
            </p>
            {step.detail && (
              <p className="mt-1 text-xs text-[var(--ef-text-muted)]">{step.detail}</p>
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
      return 'bg-[var(--ef-success)] shadow-[0_0_10px_var(--ef-success-a40)]';
    case 'current':
      return 'bg-[var(--ef-purple-primary)] ring-4 ring-[var(--ef-purple-primary-a20)]';
    case 'attention':
      return 'bg-[var(--ef-critical)] shadow-[0_0_10px_var(--ef-critical-a40)]';
    default:
      return 'bg-[var(--ef-border-subtle)]';
  }
}

function processStepText(state: DecisionProcessState['steps'][number]['state']): string {
  switch (state) {
    case 'complete':
      return 'text-[var(--ef-text-primary)]';
    case 'current':
      return 'text-[var(--ef-purple-primary)]';
    case 'attention':
      return 'text-[var(--ef-critical)]';
    default:
      return 'text-[var(--ef-text-muted)]';
  }
}

function DecisionMetricsPanel({ metrics }: { metrics: DecisionMetricCard[] }) {
  if (metrics.length === 0) return null;

  return (
    <section className="rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] p-6">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ef-purple-primary)]">
        Decision metrics
      </h2>
      <div className="mt-5 grid grid-cols-2 gap-4">
        {metrics.map((metric) => (
          <div key={metric.id} className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-4 text-center">
            <span className="block text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
              {metric.label}
            </span>
            <span className={`mt-2 block text-2xl font-semibold tracking-tight ${toneClass(metric.tone)}`}>
              {metric.value}
            </span>
            {metric.detail && (
              <span className="mt-1 block text-xs text-[var(--ef-text-muted)]">{metric.detail}</span>
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
    <div className="min-h-full bg-[var(--ef-background-primary)]">
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

        <section className="mt-8 rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-6">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ef-purple-primary)]">
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
    <div className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
        {label}
      </p>
      <p className="mt-2 text-sm text-[var(--ef-text-primary)]">{value}</p>
    </div>
  );
}
