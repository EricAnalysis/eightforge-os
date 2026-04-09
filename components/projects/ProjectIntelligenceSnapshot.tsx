'use client';

import Link from 'next/link';
import type { ProjectDocumentRow, ProjectOverviewModel } from '@/lib/projectOverview';
import {
  approvalGateImpact,
  approvalNextAction,
  operatorApprovalLabel,
  validationToneKey,
  type TruthValidationState,
} from '@/lib/truthToAction';

type SnapshotItem = {
  label: string;
  value: string;
  sourceLabel: string;
  sourceHref?: string | null;
  validation: TruthValidationState;
  gateImpact: string;
  nextAction: string;
};

function fmtCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Not available';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function findGoverningContract(documents: ProjectDocumentRow[]): ProjectDocumentRow | null {
  return (
    documents.find(
      (document) =>
        document.document_type?.toLowerCase().includes('contract') ||
        document.title?.toLowerCase().includes('contract') ||
        document.name.toLowerCase().includes('contract'),
    ) ??
    documents[0] ??
    null
  );
}

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
  if (normalized.includes('holds approval') || normalized.includes('operator review')) {
    return 'text-[#FBBF24]';
  }
  if (
    normalized.includes('approval limit') ||
    normalized.includes('exposure baseline') ||
    normalized.includes('clears the approval gate')
  ) {
    return 'text-[#60A5FA]';
  }
  return 'text-[#94A3B8]';
}

function actionTone(nextAction: string): string {
  const normalized = nextAction.toLowerCase();
  if (normalized.includes('resolve') || normalized.includes('review')) {
    return 'text-[#E5EDF7]';
  }
  return 'text-[#C7D2E3]';
}

export function ProjectIntelligenceSnapshot({
  model,
  documents,
}: {
  model: ProjectOverviewModel;
  documents: ProjectDocumentRow[];
}) {
  const validator = model.validator_summary;
  const governingContract = findGoverningContract(documents);
  const approvalLabel = operatorApprovalLabel(
    validator.validator_readiness ?? validator.status,
  );

  const nteValue = fmtCurrency(validator.nte_amount);
  const billedValue = fmtCurrency(validator.total_billed);
  const atRiskValue = fmtCurrency(validator.total_at_risk);
  const blockedValue = fmtCurrency(validator.blocked_amount);

  const hasNte =
    validator.nte_amount != null &&
    Number.isFinite(validator.nte_amount) &&
    validator.nte_amount > 0;
  const hasBilled = validator.total_billed != null && Number.isFinite(validator.total_billed);
  const hasAtRisk =
    validator.total_at_risk != null &&
    Number.isFinite(validator.total_at_risk) &&
    validator.total_at_risk > 0;
  const hasBlocked =
    validator.blocked_amount != null &&
    Number.isFinite(validator.blocked_amount) &&
    validator.blocked_amount > 0;

  const items: SnapshotItem[] = [
    {
      label: 'Approval state',
      value: approvalLabel,
      sourceLabel: 'Validator summary readiness',
      sourceHref: null,
      validation:
        validator.validator_readiness == null
          ? 'Unknown'
          : approvalLabel === 'Requires Verification'
            ? 'Requires Verification'
            : approvalLabel === 'Needs Review'
              ? 'Needs Review'
              : 'Verified',
      gateImpact: approvalGateImpact(approvalLabel),
      nextAction:
        hasBlocked
          ? 'Review validator blockers before approving payment.'
          : hasAtRisk
            ? 'Review at-risk dollars before approving payment.'
            : approvalNextAction(approvalLabel),
    },
    {
      label: 'Contract ceiling',
      value: hasNte ? nteValue : 'Not linked',
      sourceLabel: governingContract
        ? `Contract: ${governingContract.title || governingContract.name}`
        : 'Contract document not found',
      sourceHref: governingContract ? `/platform/documents/${governingContract.id}` : null,
      validation: hasNte ? 'Verified' : 'Missing',
      gateImpact: 'Sets approval limit',
      nextAction: hasNte
        ? 'Use the contract ceiling as the approval limit.'
        : 'Link the governing contract or record the contract ceiling.',
    },
    {
      label: 'Billed total',
      value: billedValue,
      sourceLabel: 'Validator exposure math (invoice totals)',
      sourceHref: null,
      validation: hasBilled ? 'Verified' : 'Unknown',
      gateImpact: 'Sets exposure baseline',
      nextAction: hasBilled
        ? 'Compare billed dollars against support and remaining ceiling.'
        : 'Process invoice totals so billed exposure can be validated.',
    },
    {
      label: 'Requires verification',
      value: hasAtRisk ? atRiskValue : fmtCurrency(0),
      sourceLabel: 'Validator exposure math (unreconciled / unsupported)',
      sourceHref: null,
      validation:
        validator.total_at_risk == null
          ? 'Unknown'
          : hasAtRisk
            ? 'Needs Review'
            : 'Verified',
      gateImpact: hasAtRisk ? 'Holds approval for operator review' : 'Context only',
      nextAction: hasAtRisk
        ? 'Review unsupported or unreconciled dollars and confirm support.'
        : 'No verification follow-up is currently required.',
    },
    {
      label: 'At risk amount',
      value: atRiskValue,
      sourceLabel: 'Validator exposure math (at-risk dollars)',
      sourceHref: null,
      validation:
        validator.total_at_risk == null
          ? 'Unknown'
          : hasAtRisk
            ? 'Needs Review'
            : 'Verified',
      gateImpact: hasAtRisk ? 'Holds approval for operator review' : 'Context only',
      nextAction: hasAtRisk
        ? 'Review the at-risk invoices and reduce the unsupported amount.'
        : 'Maintain current support coverage.',
    },
    {
      label: 'Blocked amount',
      value: blockedValue,
      sourceLabel: 'Validator exposure math (blocked invoices)',
      sourceHref: null,
      validation:
        validator.blocked_amount == null
          ? 'Unknown'
          : hasBlocked
            ? 'Requires Verification'
            : 'Verified',
      gateImpact: hasBlocked ? 'Blocks approval until verified' : 'Context only',
      nextAction: hasBlocked
        ? 'Resolve blocking mismatches before approving payment.'
        : 'No blocking approval action is currently open.',
    },
  ];

  const missingSignals: SnapshotItem[] = (
    [
      !hasNte
        ? {
            label: 'Missing critical data',
            value: 'Contract ceiling not linked',
            sourceLabel: governingContract
              ? `Contract: ${governingContract.title || governingContract.name}`
              : 'Contract document not found',
            sourceHref: governingContract ? `/platform/documents/${governingContract.id}` : null,
            validation: 'Missing' as const,
            gateImpact: 'Sets approval limit',
            nextAction: 'Link the governing contract or record the contract ceiling.',
          }
        : null,
      !hasBilled
        ? {
            label: 'Missing critical data',
            value: 'No billed total available yet',
            sourceLabel: 'No processed invoice exposure rows',
            sourceHref: null,
            validation: 'Missing' as const,
            gateImpact: 'Sets exposure baseline',
            nextAction: 'Process invoice totals so billed exposure can be validated.',
          }
        : null,
    ] satisfies (SnapshotItem | null)[]
  ).flatMap((item) => (item ? [item] : []));

  const rows = [...items, ...missingSignals];
  if (rows.length === 0) return null;

  return (
    <section className="mt-3 rounded-lg border border-[#2F3B52]/60 bg-[#0D1526]/80">
      <div className="flex items-center justify-between gap-3 border-b border-[#2F3B52]/50 px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#64748B]">
            Project intelligence snapshot
          </p>
          <p className="mt-1 text-[11px] text-[#475569]">
            Input to truth to gate to action for the highest-signal approval drivers.
          </p>
        </div>
      </div>

      <ul className="divide-y divide-[#1E2B3D]/60">
        {rows.map((item) => (
          <li key={`${item.label}:${item.value}:${item.sourceLabel}`} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[12px] font-semibold text-[#C7D2E3]">
                {item.label}:{' '}
                <span className="font-bold text-[#E5EDF7]">{item.value}</span>
              </p>
            </div>
            <div className="mt-2 grid gap-1.5 text-[10px] uppercase tracking-[0.14em]">
              <p className="text-[#64748B]">
                Source:{' '}
                {item.sourceHref ? (
                  <Link href={item.sourceHref} className="text-[#60A5FA] hover:underline">
                    {item.sourceLabel}
                  </Link>
                ) : (
                  <span className="text-[#94A3B8]">{item.sourceLabel}</span>
                )}
              </p>
              <p className="text-[#64748B]">
                Validation:{' '}
                <span className={`font-semibold ${validationTone(item.validation)}`}>
                  {item.validation}
                </span>
              </p>
              <p className="text-[#64748B]">
                Gate impact:{' '}
                <span className={`font-semibold ${gateTone(item.gateImpact)}`}>
                  {item.gateImpact}
                </span>
              </p>
              <p className="text-[#64748B]">
                Next action:{' '}
                <span className={`font-semibold ${actionTone(item.nextAction)}`}>
                  {item.nextAction}
                </span>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
