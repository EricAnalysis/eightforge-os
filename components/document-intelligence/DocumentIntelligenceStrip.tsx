'use client';

import type { DocumentIntelligenceStripItem } from '@/lib/documentIntelligenceViewModel';

function toneClass(tone: DocumentIntelligenceStripItem['tone']): string {
  switch (tone) {
    case 'good':
      return 'border-[var(--ef-success-a20)] bg-[var(--ef-success-a08)] text-[var(--ef-success-soft)]';
    case 'warning':
      return 'border-[var(--ef-warning-a20)] bg-[var(--ef-warning-a08)] text-[var(--ef-warning-soft)]';
    case 'danger':
      return 'border-[var(--ef-critical-a20)] bg-[var(--ef-critical-a08)] text-[var(--ef-critical-soft)]';
    case 'accent':
      return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-text-primary)]';
    default:
      return 'border-[var(--ef-border-white-10)] bg-white/[0.03] text-[var(--ef-text-primary)]';
  }
}

export function DocumentIntelligenceStrip({
  items,
}: {
  items: DocumentIntelligenceStripItem[];
}) {
  if (items.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--ef-surface-hover)] bg-[var(--ef-background-primary)]">
      <div className="border-b border-white/8 px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
              Operational Intelligence
            </p>
            <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
              Extraction health, schema coverage, and review pressure at a glance.
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-px bg-white/6 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        {items.map((item) => (
          <div key={item.key} className={`min-h-[96px] border px-4 py-3 ${toneClass(item.tone)}`}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
              {item.label}
            </p>
            <p className="mt-3 text-sm font-semibold text-current">{item.value}</p>
            {item.detail ? (
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--ef-text-soft)]">{item.detail}</p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
