'use client';

import Link from 'next/link';
import type { ProjectOverviewModel, ProjectDecisionRow, ProjectTaskRow } from '@/lib/projectOverview';
import type { ForgeStageCounts } from '@/lib/forgeStageCounts';
import { ApprovalActionTimeline } from '@/components/approval/ApprovalActionTimeline';
import {
  approvalGateImpact,
  approvalNextAction,
  operatorApprovalLabel,
  type TruthValidationState,
} from '@/lib/truthToAction';

type SummaryTabProps = {
  model: ProjectOverviewModel;
  stageCounts: ForgeStageCounts;
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  projectId: string;
  onGoToWork: () => void;
};

function toneClass(tone: string): string {
  switch (tone) {
    case 'danger':
      return 'text-[#F87171]';
    case 'warning':
      return 'text-[#FBBF24]';
    case 'success':
      return 'text-[#34D399]';
    case 'info':
      return 'text-[#60A5FA]';
    default:
      return 'text-[#94A3B8]';
  }
}

function validationTone(validation: TruthValidationState): string {
  if (validation === 'Verified') return 'text-[#34D399]';
  if (validation === 'Needs Review') return 'text-[#FBBF24]';
  if (validation === 'Requires Verification' || validation === 'Missing') {
    return 'text-[#F87171]';
  }
  return 'text-[#94A3B8]';
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function SummarySignalCard(props: {
  title: string;
  value: string;
  source: string;
  validation: TruthValidationState;
  gateImpact: string;
  nextAction: string;
}) {
  const { title, value, source, validation, gateImpact, nextAction } = props;

  return (
    <section className="rounded-lg border border-[#2F3B52]/60 bg-[#0D1526]/80">
      <div className="border-b border-[#2F3B52]/50 px-4 py-2">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#64748B]">
          {title}
        </h2>
      </div>
      <div className="space-y-2 px-4 py-3 text-[10px] uppercase tracking-[0.14em]">
        <p className="text-[#64748B]">
          Value: <span className="font-semibold text-[#E5EDF7]">{value}</span>
        </p>
        <p className="text-[#64748B]">
          Source: <span className="font-semibold text-[#94A3B8]">{source}</span>
        </p>
        <p className="text-[#64748B]">
          Validation:{' '}
          <span className={`font-semibold ${validationTone(validation)}`}>{validation}</span>
        </p>
        <p className="text-[#64748B]">
          Gate impact: <span className="font-semibold text-[#C7D2E3]">{gateImpact}</span>
        </p>
        <p className="text-[#64748B]">
          Next action: <span className="font-semibold text-[#E5EDF7]">{nextAction}</span>
        </p>
      </div>
    </section>
  );
}

export function SummaryTab({
  model,
  stageCounts,
  decisions,
  tasks,
  projectId,
  onGoToWork,
}: SummaryTabProps) {
  const processedCount = model.documents.length;
  const needsReviewCount = decisions.filter(
    (decision) => ['open', 'in_review', 'needs_review'].includes(decision.status),
  ).length;
  const openActionsCount = tasks.filter(
    (task) => ['open', 'in_progress', 'blocked', 'pending'].includes(task.status),
  ).length;
  const blockedCount = tasks.filter((task) => task.status === 'blocked').length +
    decisions.filter((decision) => decision.status === 'open' && decision.severity === 'critical').length;

  const topIssues = model.decisions.slice(0, 3);
  const validatorSummary = model.validator_summary;
  const exposure = model.exposure;
  const approvalLabel = operatorApprovalLabel(
    validatorSummary.validator_readiness ?? validatorSummary.status,
  );
  const requiresVerificationAmount = validatorSummary.requires_verification_amount;
  const atRiskAmount = validatorSummary.total_at_risk;

  const approvalValidation: TruthValidationState =
    validatorSummary.status === 'VALIDATED'
      ? 'Verified'
      : requiresVerificationAmount != null && requiresVerificationAmount > 0
        ? 'Requires Verification'
        : approvalLabel === 'Requires Verification'
        ? 'Requires Verification'
        : approvalLabel === 'Needs Review'
          ? 'Needs Review'
          : 'Unknown';

  const exposureValidation: TruthValidationState =
    validatorSummary.total_billed == null
      ? 'Unknown'
      : atRiskAmount != null && atRiskAmount > 0
        ? 'Needs Review'
        : 'Verified';

  const workValidation: TruthValidationState =
    blockedCount > 0
      ? 'Requires Verification'
      : openActionsCount > 0 || needsReviewCount > 0
        ? 'Needs Review'
        : 'Verified';

  const inputValidation: TruthValidationState =
    processedCount > 0 ? 'Verified' : stageCounts.intake > 0 || stageCounts.extract > 0 ? 'Needs Review' : 'Missing';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#2F3B52]/60 bg-[#0D1526]/80 px-4 py-2.5">
        {[
          { label: 'Processed', value: processedCount, tone: 'neutral' },
          { label: 'Needs Review', value: needsReviewCount, tone: needsReviewCount > 0 ? 'warning' : 'success' },
          { label: 'Open Actions', value: openActionsCount, tone: openActionsCount > 0 ? 'info' : 'success' },
          { label: 'Blocked', value: blockedCount, tone: blockedCount > 0 ? 'danger' : 'success' },
        ].map((stat) => (
          <div key={stat.label} className="flex items-baseline gap-1.5">
            <span className={`font-mono text-[16px] font-bold tabular-nums ${toneClass(stat.tone)}`}>
              {stat.value}
            </span>
            <span className="text-[10px] uppercase tracking-[0.14em] text-[#475569]">{stat.label}</span>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SummarySignalCard
          title="Input coverage"
          value={`${processedCount} processed signal${processedCount === 1 ? '' : 's'}`}
          source={`Project document graph (${stageCounts.intake} intake / ${stageCounts.extract} extracting / ${stageCounts.structure} structured)`}
          validation={inputValidation}
          gateImpact={processedCount > 0 ? 'Supplies project truth for approval review' : 'Approval truth is incomplete until source documents are processed'}
          nextAction={processedCount > 0 ? 'Keep linked documents current as project truth changes.' : 'Upload and process the governing contract and invoice support.'}
        />

        <SummarySignalCard
          title="Approval truth"
          value={approvalLabel}
          source="Validator summary, linked invoices, and contract ceiling"
          validation={approvalValidation}
          gateImpact={
            requiresVerificationAmount != null && requiresVerificationAmount > 0
              ? `Blocks approval on ${formatMoney(requiresVerificationAmount)} requiring verification.`
              : approvalGateImpact(approvalLabel)
          }
          nextAction={
            requiresVerificationAmount != null && requiresVerificationAmount > 0
              ? 'Open Validator to resolve approval-gated findings.'
              : approvalNextAction(approvalLabel)
          }
        />

        <SummarySignalCard
          title="Exposure truth"
          value={
            validatorSummary.total_billed != null
              ? `${formatMoney(validatorSummary.total_billed)} billed`
              : 'Awaiting cumulative billing truth'
          }
          source="Exposure analysis across linked invoice claims"
          validation={exposureValidation}
          gateImpact={
            atRiskAmount != null && atRiskAmount > 0
              ? `Shows ${formatMoney(atRiskAmount)} of at-risk variance awaiting confirmation.`
              : exposure.detail || 'Context only'
          }
          nextAction={
            atRiskAmount != null && atRiskAmount > 0
              ? 'Review the exposure variance and confirm supporting records.'
              : 'Monitor billed-to-limit utilization.'
          }
        />

        <SummarySignalCard
          title="Work queue truth"
          value={`${openActionsCount} open action${openActionsCount === 1 ? '' : 's'}`}
          source={`${decisions.length} decision record${decisions.length === 1 ? '' : 's'} and ${tasks.length} workflow task${tasks.length === 1 ? '' : 's'}`}
          validation={workValidation}
          gateImpact={
            blockedCount > 0
              ? 'Blocks approval until the queue clears.'
              : openActionsCount > 0 || needsReviewCount > 0
                ? 'Holds approval for operator review.'
                : 'Context only'
          }
          nextAction={
            openActionsCount > 0 || needsReviewCount > 0
              ? 'Open Work to clear the next operator item.'
              : 'No queue action is currently required.'
          }
        />
      </div>

      {topIssues.length > 0 ? (
        <section className="rounded-lg border border-[#2F3B52]/60 bg-[#0D1526]/80">
          <div className="flex items-center justify-between border-b border-[#2F3B52]/50 px-4 py-2">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#64748B]">
              Next review items
            </h2>
            <button
              type="button"
              onClick={onGoToWork}
              className="text-[10px] text-[#3B82F6] transition hover:text-[#60A5FA] hover:underline"
            >
              Open Work →
            </button>
          </div>
          <ul className="divide-y divide-[#1E2B3D]/60">
            {topIssues.map((issue) => {
              const issueValidation: TruthValidationState =
                issue.border_tone === 'danger' ? 'Requires Verification' : 'Needs Review';
              const issueGate =
                issue.border_tone === 'danger'
                  ? 'Blocks approval until reviewed'
                  : 'Holds approval for operator review';
              const issueAction =
                issue.primary_action ?? 'Open the work queue and confirm the next operator step.';

              return (
                <li key={issue.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold leading-snug text-[#C7D2E3]">
                      {issue.title}
                    </p>
                    <p className="mt-0.5 text-[10px] text-[#475569]">{issue.freshness_label}</p>
                    {issue.reason ? (
                      <p className="mt-1 text-[11px] text-[#64748B]">{issue.reason}</p>
                    ) : null}
                    <div className="mt-2 grid gap-1 text-[10px] uppercase tracking-[0.12em]">
                      <p className="text-[#475569]">
                        Source: <span className="font-semibold text-[#94A3B8]">Linked decision record</span>
                      </p>
                      <p className="text-[#475569]">
                        Validation:{' '}
                        <span className={`font-semibold ${validationTone(issueValidation)}`}>
                          {issueValidation}
                        </span>
                      </p>
                      <p className="text-[#475569]">
                        Gate impact: <span className="font-semibold text-[#C7D2E3]">{issueGate}</span>
                      </p>
                      <p className="text-[#475569]">
                        Next action: <span className="font-semibold text-[#E5EDF7]">{issueAction}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] ${
                        issueValidation === 'Requires Verification'
                          ? 'border border-[#EF4444]/30 bg-[#EF4444]/10 text-[#FCA5A5]'
                          : 'border border-[#F59E0B]/25 bg-[#F59E0B]/10 text-[#FCD34D]'
                      }`}
                    >
                      {issueValidation}
                    </span>
                    <button
                      type="button"
                      onClick={onGoToWork}
                      className="rounded border border-[#3B82F6]/40 bg-[#3B82F6]/10 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#93C5FD] transition hover:bg-[#3B82F6]/20"
                    >
                      Go to Work
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <div className="flex flex-col items-center justify-center py-8">
          <p className="text-[12px] text-[#475569]">No open items currently need operator review.</p>
          <button
            type="button"
            onClick={onGoToWork}
            className="mt-3 rounded-lg border border-[#3B82F6]/40 bg-[#3B82F6]/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#93C5FD] transition hover:bg-[#3B82F6]/20"
          >
            Open Work Queue
          </button>
        </div>
      )}

      {exposure.help_href ? (
        <div className="px-1">
          <Link
            href={exposure.help_href}
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#60A5FA] hover:underline"
          >
            {exposure.help_label ?? 'Open supporting detail'}
          </Link>
        </div>
      ) : null}

      <ApprovalActionTimeline projectId={projectId} />
    </div>
  );
}
