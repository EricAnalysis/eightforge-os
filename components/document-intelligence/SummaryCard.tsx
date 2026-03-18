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
      <p className="text-sm font-medium text-white leading-relaxed">
        {summary.headline}
      </p>
      {summary.nextAction && (
        <p className="mt-1.5 text-xs text-[#8B94A3]">
          {summary.nextAction}
        </p>
      )}
    </div>
  );
}
