'use client';

import Link from 'next/link';
import {
  buildDecisionCausalChain,
  buildDecisionContextRows,
  buildDecisionInvoiceStrip,
  type DecisionCausalChainStepState,
  type DecisionProjectValidationContext,
} from '@/lib/decisionContext';
import { validationToneKey, type TruthValidationState } from '@/lib/truthToAction';
import type { DecisionEvidencePayload } from '@/lib/decisionDetail';
import type { DecisionAction } from '@/lib/types/documentIntelligence';

function validationTone(validation: TruthValidationState): string {
  const tone = validationToneKey(validation);
  if (tone === 'success') return 'text-[#34D399]';
  if (tone === 'warning') return 'text-[#FBBF24]';
  if (tone === 'danger') return 'text-[#F87171]';
  return 'text-[#94A3B8]';
}

function gateTone(gateImpact: string): string {
  const normalized = gateImpact.toLowerCase();
  if (normalized.includes('blocks approval')) return 'text-[#F87171]';
  if (
    normalized.includes('holds approval')
    || normalized.includes('operator review')
    || normalized.includes('not established')
  ) {
    return 'text-[#FBBF24]';
  }
  if (
    normalized.includes('approval limit')
    || normalized.includes('exposure')
    || normalized.includes('capacity')
    || normalized.includes('clears the approval gate')
  ) {
    return 'text-[#60A5FA]';
  }
  return 'text-[#94A3B8]';
}

function actionTone(nextAction: string): string {
  const normalized = nextAction.toLowerCase();
  if (
    normalized.includes('resolve')
    || normalized.includes('review')
    || normalized.includes('confirm')
    || normalized.includes('escalate')
  ) {
    return 'text-[#E5EDF7]';
  }
  return 'text-[#C7D2E3]';
}

function reviewStateLabel(decisionStatus: string): string {
  if (decisionStatus === 'resolved') return 'Approved';
  if (decisionStatus === 'suppressed') return 'Not Evaluated';
  return 'Needs Review';
}

function causalChainSurfaceClass(state: DecisionCausalChainStepState): string {
  switch (state) {
    case 'complete':
      return 'border-[#22C55E]/25 bg-[#22C55E]/8 hover:border-[#22C55E]/40';
    case 'current':
      return 'border-[#3B82F6]/30 bg-[#3B82F6]/10 hover:border-[#60A5FA]';
    case 'attention':
      return 'border-[#F59E0B]/30 bg-[#F59E0B]/10 hover:border-[#FBBF24]';
    default:
      return 'border-[#2F3B52] bg-[#0B1020] hover:border-[#3B82F6]/20';
  }
}

function causalChainDotClass(state: DecisionCausalChainStepState): string {
  switch (state) {
    case 'complete':
      return 'bg-[#22C55E]';
    case 'current':
      return 'bg-[#3B82F6]';
    case 'attention':
      return 'bg-[#F59E0B]';
    default:
      return 'bg-[#475569]';
  }
}

function causalChainLabelClass(state: DecisionCausalChainStepState): string {
  switch (state) {
    case 'complete':
      return 'text-[#86EFAC]';
    case 'current':
      return 'text-[#93C5FD]';
    case 'attention':
      return 'text-[#FCD34D]';
    default:
      return 'text-[#94A3B8]';
  }
}

function stripSurfaceClass(validation: TruthValidationState): string {
  const tone = validationToneKey(validation);
  if (tone === 'success') return 'border-[#22C55E]/20 bg-[#22C55E]/6';
  if (tone === 'warning') return 'border-[#F59E0B]/25 bg-[#F59E0B]/8';
  if (tone === 'danger') return 'border-[#EF4444]/25 bg-[#EF4444]/8';
  return 'border-[#2F3B52] bg-[#0B1020]';
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
  relatedTasks: Array<{
    id: string;
    status: string;
  }>;
}) {
  const {
    decisionId,
    decisionDetails,
    decisionStatus,
    documentId,
    documentHref,
    evidence,
    primaryAction,
    projectId,
    projectValidation,
    relatedTasks,
  } = props;

  const rows = buildDecisionContextRows({
    decisionDetails,
    documentHref,
    projectId,
    primaryAction,
    projectValidation,
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
    <section className="mb-8 overflow-hidden rounded-2xl border border-[#2F3B52] bg-[#111827]">
      <div className="border-l-4 border-[#3B82F6] p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#3B82F6]">
              Decision context
            </h2>
            <p className="mt-2 text-sm text-[#94A3B8]">
              Decision-level truth, gate posture, and operator action for invoice approval.
            </p>
          </div>
          <span className="rounded border border-[#2F3B52] bg-[#0B1020] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Review state: {reviewStateLabel(decisionStatus)}
          </span>
        </div>

        <div className="mt-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Causal chain
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {causalChain.map((step, index) => {
              const content = (
                <div
                  className={`min-w-[148px] rounded-xl border px-3 py-3 transition-colors ${causalChainSurfaceClass(step.state)}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
                      {step.label}
                    </span>
                    <span className={`h-2.5 w-2.5 rounded-full ${causalChainDotClass(step.state)}`} />
                  </div>
                  <p className={`mt-1 text-sm font-semibold ${causalChainLabelClass(step.state)}`}>
                    {step.stateLabel}
                  </p>
                  <p className="mt-1 text-[11px] leading-5 text-[#94A3B8]">
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
                    <span className="text-xs text-[#334155]">{'->'}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {invoiceStrip ? (
          <div className="mt-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              Invoice decision
            </p>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
              {invoiceStrip.map((item) => (
                <div
                  key={item.label}
                  className={`rounded-xl border px-3 py-3 ${stripSurfaceClass(item.validation)}`}
                >
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
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

        <ul className="mt-5 divide-y divide-[#1E2B3D]/60">
          {rows.map((row) => (
            <li key={row.label} className="py-3">
              <p className="text-[12px] font-semibold text-[#C7D2E3]">
                {row.label}:{' '}
                <span className="font-bold text-[#E5EDF7]">{row.value}</span>
              </p>
              <div className="mt-2 grid gap-1.5 text-[10px] uppercase tracking-[0.14em]">
                <p className="text-[#64748B]">
                  Source:{' '}
                  {row.sourceHref ? (
                    <Link href={row.sourceHref} className="text-[#60A5FA] hover:underline">
                      {row.sourceLabel}
                    </Link>
                  ) : (
                    <span className="text-[#94A3B8]">{row.sourceLabel}</span>
                  )}
                </p>
                <p className="text-[#64748B]">
                  Validation:{' '}
                  <span className={`font-semibold ${validationTone(row.validation)}`}>
                    {row.validation}
                  </span>
                </p>
                <p className="text-[#64748B]">
                  Gate impact:{' '}
                  <span className={`font-semibold ${gateTone(row.gateImpact)}`}>
                    {row.gateImpact}
                  </span>
                </p>
                <p className="text-[#64748B]">
                  Next action:{' '}
                  <span className={`font-semibold ${actionTone(row.nextAction)}`}>
                    {row.nextAction}
                  </span>
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
