'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import {
  countForgeQueueBlockedDecisions,
  type ProjectDecisionRow,
  type ProjectOverviewModel,
} from '@/lib/projectOverview';
import type { TruthValidationState } from '@/lib/truthToAction';

function fmtCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

const VALIDATION_CLASS: Record<TruthValidationState, string> = {
  Verified: 'text-[#34D399] ring-[#22C55E]/30',
  'Needs Review': 'text-[#FBBF24] ring-[#F59E0B]/35',
  'Requires Verification': 'text-[#FCA5A5] ring-[#EF4444]/40',
  Missing: 'text-[#F87171] ring-[#EF4444]/40',
  Unknown: 'text-[#94A3B8] ring-[#475569]/30',
};

type TruthCell = {
  label: string;
  value: string;
  hint: string;
  validation: TruthValidationState;
};

export function ProjectTruthSnapshot({
  projectId,
  model,
  decisions,
}: {
  projectId: string;
  model: ProjectOverviewModel;
  decisions: ProjectDecisionRow[];
}) {
  const validator = model.validator_summary;

  const cells = useMemo<TruthCell[]>(() => {
    const nte = validator.nte_amount;
    const billed = validator.total_billed;
    const requiresVerification = validator.requires_verification_amount;
    const hasNte = nte != null && Number.isFinite(nte) && nte > 0;
    const hasBilled = billed != null && Number.isFinite(billed);
    const blockedDecisions = countForgeQueueBlockedDecisions(decisions);

    let remaining: TruthCell;
    if (!hasNte && !hasBilled) {
      remaining = {
        label: 'Remaining ceiling',
        value: '—',
        hint: 'NTE − billed when both exist in validator summary',
        validation: 'Missing',
      };
    } else if (!hasNte) {
      remaining = {
        label: 'Remaining ceiling',
        value: '—',
        hint: 'Link contract NTE in validator payload',
        validation: 'Missing',
      };
    } else if (!hasBilled) {
      remaining = {
        label: 'Remaining ceiling',
        value: 'Awaiting cumulative billing truth',
        hint: 'Derived after contract ceiling and cumulative billed truth are both available',
        validation: 'Unknown',
      };
    } else {
      const headroom = (nte as number) - (billed as number);
      if (headroom < 0) {
        remaining = {
          label: 'Remaining ceiling',
          value: `Over by ${fmtCurrency(Math.abs(headroom))}`,
          hint: 'Derived: NTE − total billed (validator rollup)',
          validation: 'Requires Verification',
        };
      } else if (headroom === 0) {
        remaining = {
          label: 'Remaining ceiling',
          value: fmtCurrency(0),
          hint: 'Derived: NTE − total billed (validator rollup)',
          validation: 'Needs Review',
        };
      } else {
        remaining = {
          label: 'Remaining ceiling',
          value: fmtCurrency(headroom),
          hint: 'Derived: NTE − total billed (validator rollup)',
          validation: 'Verified',
        };
      }
    }

    const billedToDate: TruthCell =
      billed == null || !Number.isFinite(billed)
        ? {
            label: 'Billed to date',
            value: 'Awaiting cumulative billing truth',
            hint: 'Project rollup billed total prior to the current approval decision',
            validation: 'Unknown',
          }
        : {
            label: 'Billed to date',
            value: fmtCurrency(billed),
            hint: 'Validator/project rollup',
            validation: 'Verified',
          };

    const requiresVerificationCell: TruthCell =
      requiresVerification == null || !Number.isFinite(requiresVerification)
        ? {
            label: 'Requires Verification',
            value: '—',
            hint: 'Queue and validator findings determine approval-gated dollars',
            validation: blockedDecisions > 0 ? 'Requires Verification' : 'Unknown',
          }
        : requiresVerification > 0
          ? {
              label: 'Requires Verification',
              value: fmtCurrency(requiresVerification),
              hint: 'Blocked or needs-review findings with gate impact',
              validation: 'Requires Verification',
            }
          : {
              label: 'Requires Verification',
              value: fmtCurrency(0),
              hint: 'No approval-gated verification dollars are open',
              validation: 'Verified',
            };

    const atRiskRaw = validator.total_at_risk;
    const atRisk: TruthCell =
      atRiskRaw == null || !Number.isFinite(atRiskRaw)
        ? {
            label: 'At risk',
            value: '—',
            hint: 'Exposure variance awaiting confirmation',
            validation: 'Unknown',
          }
        : atRiskRaw > 0
          ? {
              label: 'At risk',
              value: fmtCurrency(atRiskRaw),
              hint: 'Exposure variance that is not yet confirmed',
              validation: 'Needs Review',
            }
          : {
              label: 'At risk',
              value: fmtCurrency(0),
              hint: 'No at-risk exposure variance is open',
              validation: 'Verified',
            };

    return [remaining, billedToDate, requiresVerificationCell, atRisk];
  }, [validator, decisions]);

  const hasContractTruth =
    validator.nte_amount != null &&
    Number.isFinite(validator.nte_amount) &&
    validator.nte_amount > 0;
  const hasInvoiceTruth =
    validator.invoice_summaries.length > 0 ||
    (validator.total_billed != null && Number.isFinite(validator.total_billed));
  const awaitingFinancialTruth = !hasContractTruth && !hasInvoiceTruth;

  return (
    <section className="mb-3 shrink-0 rounded-lg border border-[#2F3B52]/70 bg-[#0D1526]/85">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2F3B52]/50 px-3 py-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#64748B]">Project truth</p>
        <Link
          href={`/platform/projects/${projectId}#project-validator`}
          className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[#64748B] underline-offset-2 hover:text-[#94A3B8] hover:underline"
        >
          Validator rollup
        </Link>
      </div>

      {awaitingFinancialTruth ? (
        <p className="border-b border-[#1E2B3D]/60 px-3 py-2 text-[11px] leading-snug text-[#64748B]">
          Contract ceiling and cumulative billing truth are not established yet. Upload and validate to populate
          project financial truth before relying on remaining capacity.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-px bg-[#1E2B3D]/50 lg:grid-cols-4">
        {cells.map((cell) => (
          <div key={cell.label} className="bg-[#0B1020]/90 px-3 py-2.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-[#64748B]">{cell.label}</p>
            <p className="mt-1 font-mono text-[13px] font-semibold tabular-nums text-[#E5EDF7]">
              {cell.value}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span
                className={`rounded px-1 py-0.5 text-[8px] font-bold uppercase tracking-[0.1em] ring-1 ${VALIDATION_CLASS[cell.validation]}`}
              >
                {cell.validation}
              </span>
            </div>
            <p className="mt-1 text-[9px] leading-snug text-[#475569]">{cell.hint}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
