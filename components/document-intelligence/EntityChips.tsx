'use client';

// components/document-intelligence/EntityChips.tsx
// Horizontal row of small entity chips: key-value pairs extracted from the document.
// Each chip optionally carries a status color (ok/warning/critical/neutral).

import type { DetectedEntity } from '@/lib/types/documentIntelligence';

const STATUS_CLASSES: Record<string, string> = {
  ok:       'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
  warning:  'bg-amber-500/15 border-amber-500/30 text-amber-300',
  critical: 'bg-red-500/15 border-red-500/30 text-red-300',
  neutral:  'bg-white/5 border-white/10 text-[#C5CAD4]',
};

interface EntityChipsProps {
  entities: DetectedEntity[];
}

export function EntityChips({ entities }: EntityChipsProps) {
  if (entities.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {entities.map(entity => {
        const cls = STATUS_CLASSES[entity.status ?? 'neutral'];
        return (
          <div
            key={entity.key}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${cls}`}
            title={entity.tooltip}
          >
            <span className="text-[#8B94A3] font-medium">{entity.label}</span>
            <span className="font-semibold">{entity.value}</span>
          </div>
        );
      })}
    </div>
  );
}
