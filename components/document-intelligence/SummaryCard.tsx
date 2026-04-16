'use client';

// components/document-intelligence/SummaryCard.tsx
// Displays the headline summary and next-action prompt at the top of the intelligence section.

import type { DocumentSummary } from '@/lib/types/documentIntelligence';

interface SummaryCardProps {
  summary: DocumentSummary;
}

export function SummaryCard({ summary }: SummaryCardProps) {
  return (
    <div className="rounded-xl bg-[#0F1117] border border-white/10 px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-sm font-medium leading-relaxed text-white">
          {summary.headline}
        </p>
        {typeof summary.confidence === 'number' && (
          <span className="rounded border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#93C5FD]">
            {Math.round(summary.confidence * 100)}% confidence
          </span>
        )}
      </div>
      {summary.nextAction && (
        <p className="mt-1.5 text-xs text-[#8B94A3]">
          {summary.nextAction}
        </p>
      )}
      {summary.traceHint && (
        <p className="mt-1 text-[10px] text-[#5B6578]">
          {summary.traceHint}
        </p>
      )}
    </div>
  );
}
