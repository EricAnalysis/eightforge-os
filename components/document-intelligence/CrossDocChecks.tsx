'use client';

// components/document-intelligence/CrossDocChecks.tsx
// Renders the cross-document comparison table.
// Each row shows a check label, left side, right side, status, and explanation.

import type { ComparisonResult } from '@/lib/types/documentIntelligence';

const STATUS_STYLES: Record<ComparisonResult['status'], {
  dot: string;
  label: string;
  text: string;
}> = {
  match:   { dot: 'bg-[var(--ef-success)]', label: 'Match',   text: 'text-[var(--ef-success)]' },
  warning: { dot: 'bg-[var(--ef-warning)]',   label: 'Review',  text: 'text-[var(--ef-warning)]' },
  mismatch:{ dot: 'bg-[var(--ef-critical)]',     label: 'Mismatch',text: 'text-[var(--ef-critical)]' },
  missing: { dot: 'bg-[var(--ef-text-faint)]',   label: 'Missing', text: 'text-[var(--ef-text-muted)]' },
};

function formatValue(v: string | number | null): string {
  if (v === null || v === undefined) return '—';
  return String(v);
}

function ComparisonRow({ row }: { row: ComparisonResult }) {
  const style = STATUS_STYLES[row.status];

  return (
    <div className="py-3 border-b border-white/5 last:border-0">
      {/* Check label + status badge */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-medium text-[var(--ef-text-secondary)]">{row.check}</span>
        <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold ${style.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
          {style.label}
        </span>
      </div>

      {/* Left / Right values */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-white/3 px-3 py-2">
          <p className="text-[10px] text-[var(--ef-text-faint)] mb-0.5">{row.leftLabel}</p>
          <p className="text-xs font-medium text-white truncate">
            {formatValue(row.leftValue)}
          </p>
        </div>
        <div className="rounded-lg bg-white/3 px-3 py-2">
          <p className="text-[10px] text-[var(--ef-text-faint)] mb-0.5">{row.rightLabel}</p>
          <p className="text-xs font-medium text-white truncate">
            {formatValue(row.rightValue)}
          </p>
        </div>
      </div>

      {/* Explanation */}
      {row.explanation && (
        <p className="mt-1.5 text-xs text-[var(--ef-text-muted)] leading-relaxed">
          {row.explanation}
        </p>
      )}
    </div>
  );
}

interface CrossDocChecksProps {
  comparisons: ComparisonResult[];
}

export function CrossDocChecks({ comparisons }: CrossDocChecksProps) {
  if (comparisons.length === 0) return null;

  const hasIssues = comparisons.some(c => c.status === 'mismatch' || c.status === 'warning');

  return (
    <div className="rounded-xl bg-[var(--ef-background-primary)] border border-[var(--ef-border-white-10)]">
      <div className="border-b border-white/8 px-5 py-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
          Cross-Document Checks
        </h3>
        {hasIssues && (
          <span className="inline-flex items-center rounded-full bg-[var(--ef-warning-a20)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ef-warning)]">
            Issues found
          </span>
        )}
      </div>
      <div className="px-5">
        {comparisons.map(row => (
          <ComparisonRow key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}
