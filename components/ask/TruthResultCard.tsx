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
        badge: 'border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)]',
        dot: 'bg-[var(--ef-critical)]',
      };
    case 'Needs Review':
      return {
        badge: 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]',
        dot: 'bg-[var(--ef-warning)]',
      };
    case 'Approved with Notes':
      return {
        badge: 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]',
        dot: 'bg-[var(--ef-purple-primary)]',
      };
    case 'Approved':
      return {
        badge: 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]',
        dot: 'bg-[var(--ef-success)]',
      };
    default:
      return {
        badge: 'border-[var(--ef-border-subtle-a60)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-faint)]',
        dot: 'bg-[var(--ef-border-subtle)]',
      };
  }
}

function validationStateColor(state: string): string {
  if (state === 'Approved') return 'text-[var(--ef-success-soft)]';
  if (state === 'Needs Review') return 'text-[var(--ef-warning-soft)]';
  if (state === 'Requires Verification') return 'text-[var(--ef-critical-soft)]';
  if (state === 'Approved with Notes') return 'text-[var(--ef-purple-glow)]';
  return 'text-[var(--ef-text-faint)]';
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
  if (kind === 'finding')  return 'text-[var(--ef-warning-soft)]';
  if (kind === 'decision') return 'text-[var(--ef-purple-glow)]';
  return 'text-[var(--ef-text-muted)]';
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
    <div className="overflow-hidden rounded-lg border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)]">
      {/* Header row: query label + approval badge + dismiss */}
      <div className="flex items-center justify-between gap-3 border-b border-[var(--ef-border-subtle-a50)] px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${colors.dot}`} />
          <span className="truncate text-[11px] font-semibold text-[var(--ef-text-muted)]">
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
              className="text-[var(--ef-border-subtle)] transition hover:text-[var(--ef-text-faint)]"
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
          <span className="text-[var(--ef-text-faint)]">Value</span>
          <span className="font-semibold text-[var(--ef-text-primary)]">{result.value}</span>
        </div>

        {/* Validation state */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[var(--ef-text-faint)]">Validation</span>
          <span className={`font-semibold ${validationStateColor(validationDisplay)}`}>
            {validationDisplay}
          </span>
        </div>

        {/* Gate impact */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="shrink-0 text-[var(--ef-text-faint)]">Gate impact</span>
          <span className="font-semibold text-[var(--ef-text-secondary)]">{result.gateImpact}</span>
        </div>

        {/* Next action */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="shrink-0 text-[var(--ef-text-faint)]">Next action</span>
          <span className="font-semibold text-[var(--ef-text-primary)]">{result.nextAction}</span>
        </div>

        {/* Validator deep link */}
        {validatorHref ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[var(--ef-text-faint)]">Source</span>
            <Link
              href={validatorHref}
              className="font-semibold text-[var(--ef-purple-glow)] hover:underline"
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
            className="mt-1 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-purple-primary)] transition hover:text-[var(--ef-purple-glow)]"
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
        <div className="border-t border-[var(--ef-border-subtle-a40)] px-4 py-2 space-y-1.5">
          {result.evidence.map((item, i) => (
            <div key={i} className="flex items-start gap-2">
              <span
                className={`mt-0.5 shrink-0 text-[9px] font-bold uppercase tracking-[0.12em] ${evidenceCategoryColor(item.kind)}`}
              >
                {evidenceCategoryLabel(item.kind, result.queryType)}
              </span>
              <span className="text-[11px] leading-4 text-[var(--ef-text-faint)]">{item.detail}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
