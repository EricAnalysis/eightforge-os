'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { TruthResultPayload } from '@/lib/truthQuery';

// ---------------------------------------------------------------------------
// Tone helpers
// ---------------------------------------------------------------------------

function approvalColors(label: string): { badge: string; dot: string } {
  switch (label) {
    case 'Requires Verification':
      return {
        badge: 'border-[#EF4444]/30 bg-[#EF4444]/10 text-[#F87171]',
        dot: 'bg-[#EF4444]',
      };
    case 'Needs Review':
      return {
        badge: 'border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[#FBBF24]',
        dot: 'bg-[#F59E0B]',
      };
    case 'Approved with Notes':
      return {
        badge: 'border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[#93C5FD]',
        dot: 'bg-[#3B82F6]',
      };
    case 'Approved':
      return {
        badge: 'border-[#22C55E]/30 bg-[#22C55E]/10 text-[#4ADE80]',
        dot: 'bg-[#22C55E]',
      };
    default:
      return {
        badge: 'border-[#2F3B52]/60 bg-[#1A2333] text-[#64748B]',
        dot: 'bg-[#2F3B52]',
      };
  }
}

function validationStateColor(state: string): string {
  if (state === 'Approved') return 'text-[#34D399]';
  if (state === 'Needs Review') return 'text-[#FBBF24]';
  if (state === 'Requires Verification') return 'text-[#F87171]';
  if (state === 'Approved with Notes') return 'text-[#60A5FA]';
  return 'text-[#64748B]';
}

/** Maps internal TruthValidationState to operator-friendly display terms. */
function displayValidationState(state: string): string {
  switch (state) {
    case 'Verified':   return 'Approved';
    case 'Missing':    return 'Not Evaluated';
    case 'Unknown':    return 'Not Evaluated';
    default:           return state; // 'Needs Review', 'Requires Verification' pass through
  }
}

/** Maps evidence kind + queryType to an operator-friendly category label. */
function evidenceCategoryLabel(
  kind: 'finding' | 'decision' | 'snapshot',
  queryType: string,
): string {
  if (kind === 'finding')  return 'Validator';
  if (kind === 'decision') return 'Approval';
  // snapshot — use queryType to pick the right category
  if (queryType === 'contract') return 'Contract';
  if (queryType === 'invoice')  return 'Invoice';
  return 'Approval';
}

function evidenceCategoryColor(kind: 'finding' | 'decision' | 'snapshot'): string {
  if (kind === 'finding')  return 'text-[#FBBF24]';
  if (kind === 'decision') return 'text-[#60A5FA]';
  return 'text-[#94A3B8]';
}

/** Appends a tab-specific anchor to the validator href based on queryType. */
function resolveValidatorHref(result: TruthResultPayload): string | null {
  if (!result.sourceHref) return null;
  const anchors: Partial<Record<string, string>> = {
    invoice:   '#invoice',
    rate_code: '#rate',
    contract:  '#contract',
  };
  const anchor = anchors[result.queryType] ?? '';
  return result.sourceHref + anchor;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type TruthResultCardProps = {
  result: TruthResultPayload;
  onDismiss?: () => void;
};

export function TruthResultCard({ result, onDismiss }: TruthResultCardProps) {
  const [showEvidence, setShowEvidence] = useState(false);
  const colors = approvalColors(result.approvalLabel);
  const hasEvidence = result.evidence.length > 0;
  const validatorHref = resolveValidatorHref(result);
  const validationDisplay = displayValidationState(result.validationState);

  return (
    <div className="overflow-hidden rounded-lg border border-[#2F3B52]/70 bg-[#0A0F1C]">
      {/* Header row: query label + approval badge + dismiss */}
      <div className="flex items-center justify-between gap-3 border-b border-[#2F3B52]/50 px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${colors.dot}`} />
          <span className="truncate text-[11px] font-semibold text-[#94A3B8]">
            {result.queryLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`shrink-0 rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${colors.badge}`}
          >
            {result.approvalLabel}
          </span>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="text-[#2F3B52] transition hover:text-[#64748B]"
              aria-label="Dismiss"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div className="space-y-2.5 px-4 py-3 text-[10px] uppercase tracking-[0.14em]">
        {/* Value */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[#475569]">Value</span>
          <span className="font-semibold text-[#E5EDF7]">{result.value}</span>
        </div>

        {/* Validation state */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[#475569]">Validation</span>
          <span className={`font-semibold ${validationStateColor(validationDisplay)}`}>
            {validationDisplay}
          </span>
        </div>

        {/* Gate impact */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="shrink-0 text-[#475569]">Gate impact</span>
          <span className="font-semibold text-[#C7D2E3]">{result.gateImpact}</span>
        </div>

        {/* Next action */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="shrink-0 text-[#475569]">Next action</span>
          <span className="font-semibold text-[#E5EDF7]">{result.nextAction}</span>
        </div>

        {/* Validator deep link */}
        {validatorHref ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[#475569]">Source</span>
            <Link
              href={validatorHref}
              className="font-semibold text-[#60A5FA] hover:underline"
            >
              View in Validator
            </Link>
          </div>
        ) : null}

        {/* Evidence toggle */}
        {hasEvidence ? (
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="mt-1 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[#3B82F6] transition hover:text-[#60A5FA]"
          >
            <svg
              className={`h-2.5 w-2.5 transition-transform ${showEvidence ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
            {showEvidence ? 'Hide evidence' : `Show ${result.evidence.length} evidence item${result.evidence.length === 1 ? '' : 's'}`}
          </button>
        ) : null}
      </div>

      {/* Evidence list — collapsed by default */}
      {showEvidence && hasEvidence ? (
        <div className="border-t border-[#2F3B52]/40 px-4 py-2 space-y-1.5">
          {result.evidence.map((item, i) => (
            <div key={i} className="flex items-start gap-2">
              <span
                className={`mt-0.5 shrink-0 text-[9px] font-bold uppercase tracking-[0.12em] ${evidenceCategoryColor(item.kind)}`}
              >
                {evidenceCategoryLabel(item.kind, result.queryType)}
              </span>
              <span className="text-[11px] leading-4 text-[#64748B]">{item.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
