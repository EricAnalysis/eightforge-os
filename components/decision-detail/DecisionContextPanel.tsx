'use client';

import Link from 'next/link';
import {
  buildDecisionCausalChain,
  buildDecisionContextRows,
  buildDecisionInvoiceStrip,
  type DecisionCausalChainStepState,
  type DecisionProjectValidationContext,
  type DecisionQueueFindingActionContext,
  type DecisionWorkflowExecutionStatus,
} from '@/lib/decisionContext';
import { validationToneKey, type TruthValidationState } from '@/lib/truthToAction';
import type { DecisionEvidencePayload } from '@/lib/decisionDetail';
import type { DecisionAction } from '@/lib/types/documentIntelligence';

function validationTone(validation: TruthValidationState): string {
  const tone = validationToneKey(validation);
  if (tone === 'success') return 'text-[var(--ef-success-soft)]';
  if (tone === 'warning') return 'text-[var(--ef-warning-soft)]';
  if (tone === 'danger') return 'text-[var(--ef-critical-soft)]';
  return 'text-[var(--ef-text-muted)]';
}

function gateTone(gateImpact: string): string {
  const normalized = gateImpact.toLowerCase();
  if (normalized.includes('blocks approval')) return 'text-[var(--ef-critical-soft)]';
  if (
    normalized.includes('holds approval')
    || normalized.includes('operator review')
    || normalized.includes('not established')
  ) {
    return 'text-[var(--ef-warning-soft)]';
  }
  if (
    normalized.includes('approval limit')
    || normalized.includes('exposure')
    || normalized.includes('capacity')
    || normalized.includes('clears the approval gate')
  ) {
    return 'text-[var(--ef-purple-glow)]';
  }
  return 'text-[var(--ef-text-muted)]';
}

function actionTone(nextAction: string): string {
  const normalized = nextAction.toLowerCase();
  if (
    normalized.includes('resolve')
    || normalized.includes('review')
    || normalized.includes('confirm')
    || normalized.includes('escalate')
  ) {
    return 'text-[var(--ef-text-primary)]';
  }
  return 'text-[var(--ef-text-secondary)]';
}

function reviewStateLabel(decisionStatus: string): string {
  if (decisionStatus === 'resolved') return 'Approved';
  if (decisionStatus === 'suppressed') return 'Not Evaluated';
  return 'Needs Review';
}

function causalChainSurfaceClass(state: DecisionCausalChainStepState): string {
  switch (state) {
    case 'complete':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-a08)] hover:border-[var(--ef-success-a40)]';
    case 'current':
      return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] hover:border-[var(--ef-purple-glow)]';
    case 'attention':
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] hover:border-[var(--ef-warning-soft)]';
    default:
      return 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] hover:border-[var(--ef-purple-primary-a20)]';
  }
}

function causalChainDotClass(state: DecisionCausalChainStepState): string {
  switch (state) {
    case 'complete':
      return 'bg-[var(--ef-success)]';
    case 'current':
      return 'bg-[var(--ef-purple-primary)]';
    case 'attention':
      return 'bg-[var(--ef-warning)]';
    default:
      return 'bg-[var(--ef-text-faint)]';
  }
}

function causalChainLabelClass(state: DecisionCausalChainStepState): string {
  switch (state) {
    case 'complete':
      return 'text-[var(--ef-success-soft)]';
    case 'current':
      return 'text-[var(--ef-purple-glow)]';
    case 'attention':
      return 'text-[var(--ef-warning-soft)]';
    default:
      return 'text-[var(--ef-text-muted)]';
  }
}

function stripSurfaceClass(validation: TruthValidationState): string {
  const tone = validationToneKey(validation);
  if (tone === 'success') return 'border-[var(--ef-success-a20)] bg-[var(--ef-success-a06)]';
  if (tone === 'warning') return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-a08)]';
  if (tone === 'danger') return 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a08)]';
  return 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)]';
}

export function DecisionContextPanel(props: {
  decisionId: string;
  decisionDetails: Record<string, unknown> | null;
  decisionStatus: string;
  documentId: string | null;
  documentLabel: string;
  documentHref: string | null;
  evidence: DecisionEvidencePayload;
  primaryAction: DecisionAction | null;
  projectId: string | null;
  projectValidation: DecisionProjectValidationContext;
  queueFindingAction: DecisionQueueFindingActionContext | null;
  relatedTasks: Array<{
    id: string;
    status: string;
    title?: string | null;
  }>;
  executionStatus: DecisionWorkflowExecutionStatus | null;
}) {
  const {
    decisionId,
    decisionDetails,
    decisionStatus,
    documentId,
    documentHref,
    evidence,
    executionStatus,
    primaryAction,
    projectId,
    projectValidation,
    queueFindingAction,
    relatedTasks,
  } = props;

  const rows = buildDecisionContextRows({
    decisionDetails,
    documentHref,
    executionStatus,
    projectId,
    primaryAction,
    projectValidation,
    queueFindingAction,
    relatedTasks,
  });
  const invoiceStrip = buildDecisionInvoiceStrip({
    decisionDetails,
    primaryAction,
    projectValidation,
  });
  const causalChain = buildDecisionCausalChain({
    decisionId,
    decisionStatus,
    decisionDetails,
    documentId,
    hasStructuredEvidence: evidence.hasStructuredEvidence,
    primaryAction,
    projectId,
    projectValidation,
    relatedTasks,
  });

  return (
    <section
      id="decision-context"
      className="mb-8 overflow-hidden rounded-2xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)]"
    >
      <div className="border-l-4 border-[var(--ef-purple-primary)] p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--ef-purple-primary)]">
              Decision context
            </h2>
            <p className="mt-2 text-sm text-[var(--ef-text-muted)]">
              Decision-level truth, gate posture, and operator action for invoice approval.
            </p>
          </div>
          <span className="rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Review state: {reviewStateLabel(decisionStatus)}
          </span>
        </div>

        <div className="mt-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Causal chain
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {causalChain.map((step, index) => {
              const content = (
                <div
                  className={`min-w-[148px] rounded-xl border px-3 py-3 transition-colors ${causalChainSurfaceClass(step.state)}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                      {step.label}
                    </span>
                    <span className={`h-2.5 w-2.5 rounded-full ${causalChainDotClass(step.state)}`} />
                  </div>
                  <p className={`mt-1 text-sm font-semibold ${causalChainLabelClass(step.state)}`}>
                    {step.stateLabel}
                  </p>
                  <p className="mt-1 text-[11px] leading-5 text-[var(--ef-text-muted)]">
                    {step.detail}
                  </p>
                </div>
              );

              return (
                <div key={step.id} className="flex items-center gap-2">
                  {step.href ? (
                    <Link href={step.href} aria-current={step.state === 'current' ? 'step' : undefined}>
                      {content}
                    </Link>
                  ) : (
                    content
                  )}
                  {index < causalChain.length - 1 && (
                    <span className="text-xs text-[var(--ef-border-strong)]">{'->'}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {invoiceStrip ? (
          <div className="mt-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
              Invoice decision
            </p>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
              {invoiceStrip.map((item) => (
                <div
                  key={item.label}
                  className={`rounded-xl border px-3 py-3 ${stripSurfaceClass(item.validation)}`}
                >
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                    {item.label}
                  </p>
                  <p className={`mt-2 text-sm font-semibold ${validationTone(item.validation)}`}>
                    {item.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-5 rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                Evidence routing
              </p>
              <p className="mt-2 text-sm text-[var(--ef-text-secondary)]">
                Inspect evidence from decision context first, then open the exact source document, fact, or spreadsheet row for review and correction.
              </p>
            </div>
            <span className="rounded border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
              {evidence.targets.length} target{evidence.targets.length === 1 ? '' : 's'}
            </span>
          </div>

          {evidence.targets.length > 0 ? (
            <div className="mt-4 space-y-3">
              {evidence.targets.map((target) => (
                <div
                  key={target.id}
                  className="rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--ef-text-primary)]">{target.label}</p>
                      <p className="mt-1 text-[12px] text-[var(--ef-text-muted)]">{target.detail}</p>
                    </div>
                    {target.href ? (
                      <Link
                        href={target.href}
                        className="rounded-md border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-[11px] font-medium text-[var(--ef-purple-glow)] transition-colors hover:bg-[var(--ef-purple-primary-a15)]"
                      >
                        {target.exactTarget ? 'Open exact evidence' : 'Open source document'}
                      </Link>
                    ) : null}
                  </div>
                  {target.missingReason ? (
                    <p className="mt-3 rounded-lg border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-[12px] text-[var(--ef-warning-soft)]">
                      {target.missingReason}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-4 py-3 text-sm text-[var(--ef-warning-soft)]">
              {evidence.missingEvidenceMessage ?? 'No validator-backed evidence target is attached to this decision yet.'}
            </div>
          )}
        </div>

        <ul className="mt-5 divide-y divide-[var(--ef-surface-hover-a60)]">
          {rows.map((row) => (
            <li key={row.label} className="py-3">
              <p className="text-[12px] font-semibold text-[var(--ef-text-secondary)]">
                {row.label}:{' '}
                <span className="font-bold text-[var(--ef-text-primary)]">{row.value}</span>
              </p>
              <div className="mt-2 grid gap-1.5 text-[10px] uppercase tracking-[0.14em]">
                <p className="text-[var(--ef-text-faint)]">
                  Source:{' '}
                  {row.sourceHref ? (
                    <Link href={row.sourceHref} className="text-[var(--ef-purple-glow)] hover:underline">
                      {row.sourceLabel}
                    </Link>
                  ) : (
                    <span className="text-[var(--ef-text-muted)]">{row.sourceLabel}</span>
                  )}
                </p>
                <p className="text-[var(--ef-text-faint)]">
                  Validation:{' '}
                  <span className={`font-semibold ${validationTone(row.validation)}`}>
                    {row.validation}
                  </span>
                </p>
                <p className="text-[var(--ef-text-faint)]">
                  Gate impact:{' '}
                  <span className={`font-semibold ${gateTone(row.gateImpact)}`}>
                    {row.gateImpact}
                  </span>
                </p>
                <p className="text-[var(--ef-text-faint)]">
                  Next action:{' '}
                  <span className={`font-semibold ${actionTone(row.nextAction)}`}>
                    {row.nextAction}
                  </span>
                </p>
                <p className="text-[var(--ef-text-faint)]">
                  Action impact:{' '}
                  <span className="font-semibold text-[var(--ef-text-secondary)]">
                    {row.actionImpact}
                  </span>
                </p>
                {row.executionStatus ? (
                  <p className="text-[var(--ef-text-faint)]">
                    Execution status:{' '}
                    <span className="font-semibold text-[var(--ef-text-secondary)]">
                      {row.executionStatus}
                    </span>
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
