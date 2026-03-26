'use client';

import type { DocumentIntelligenceStripItem } from '@/lib/documentIntelligenceViewModel';

function toneClass(tone: DocumentIntelligenceStripItem['tone']): string {
  switch (tone) {
    case 'good':
      return 'border-emerald-400/20 bg-emerald-400/8 text-emerald-100';
    case 'warning':
      return 'border-amber-400/20 bg-amber-400/8 text-amber-100';
    case 'danger':
      return 'border-red-400/20 bg-red-400/8 text-red-100';
    case 'accent':
      return 'border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[#E5EDF7]';
    default:
      return 'border-white/10 bg-white/[0.03] text-[#E5EDF7]';
  }
}

export function DocumentIntelligenceStrip({
  items,
}: {
  items: DocumentIntelligenceStripItem[];
}) {
  if (items.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-2xl border border-[#2A3550] bg-[#0B1220]">
      <div className="border-b border-white/8 px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
              Operational Intelligence
            </p>
            <p className="mt-1 text-[12px] text-[#8FA1BC]">
              Extraction health, schema coverage, and review pressure at a glance.
            </p>
          </div>
        </div>
      </div>
      <div className="grid gap-px bg-white/6 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        {items.map((item) => (
          <div key={item.key} className={`min-h-[96px] border px-4 py-3 ${toneClass(item.tone)}`}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8FA1BC]">
              {item.label}
            </p>
            <p className="mt-3 text-sm font-semibold text-current">{item.value}</p>
            {item.detail ? (
              <p className="mt-2 text-[11px] leading-relaxed text-[#9FB0CA]">{item.detail}</p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
