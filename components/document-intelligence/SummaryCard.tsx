'use client';

// components/document-intelligence/SummaryCard.tsx
// Displays the headline summary and next-action prompt at the top of the intelligence section.

import type { DocumentSummary } from '@/lib/types/documentIntelligence';

interface SummaryCardProps {
  summary: DocumentSummary;
}

export function SummaryCard({ summary }: SummaryCardProps) {
  return (
    <div className="rounded-xl bg-[var(--ef-background-primary)] border border-[var(--ef-border-white-10)] px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-sm font-medium leading-relaxed text-white">
          {summary.headline}
        </p>
        {typeof summary.confidence === 'number' && (
          <span className="rounded border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-purple-glow)]">
            {Math.round(summary.confidence * 100)}% confidence
          </span>
        )}
      </div>
      {summary.nextAction && (
        <p className="mt-1.5 text-xs text-[var(--ef-text-muted)]">
          {summary.nextAction}
        </p>
      )}
      {summary.traceHint && (
        <p className="mt-1 text-[10px] text-[var(--ef-text-faint)]">
          {summary.traceHint}
        </p>
      )}
    </div>
  );
}
