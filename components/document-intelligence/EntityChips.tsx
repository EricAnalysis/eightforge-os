'use client';

// components/document-intelligence/EntityChips.tsx
// Horizontal row of small entity chips: key-value pairs extracted from the document.
// Each chip optionally carries a status color (ok/warning/critical/neutral).

import type { DetectedEntity } from '@/lib/types/documentIntelligence';

const STATUS_CLASSES: Record<string, string> = {
  ok:       'bg-[var(--ef-success-a18)] border-[var(--ef-success-a30)] text-[var(--ef-success-soft)]',
  warning:  'bg-[var(--ef-warning-a18)] border-[var(--ef-warning-a30)] text-[var(--ef-warning-soft)]',
  critical: 'bg-[var(--ef-critical-a15)] border-[var(--ef-critical-a30)] text-[var(--ef-critical-soft)]',
  neutral:  'bg-white/5 border-[var(--ef-border-white-10)] text-[var(--ef-text-secondary)]',
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
            <span className="text-[var(--ef-text-muted)] font-medium">{entity.label}</span>
            <span className="font-semibold">{entity.value}</span>
          </div>
        );
      })}
    </div>
  );
}
