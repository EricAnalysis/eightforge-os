'use client';

import type { ProjectOverviewModel } from '@/lib/projectOverview';
import { FORGE_STAGE_KEYS, FORGE_STAGE_LABELS, type ForgeStageCounts } from '@/lib/forgeStageCounts';

type ProjectOverviewBandProps = {
  model: ProjectOverviewModel;
  stageCounts: ForgeStageCounts;
};

function toneClass(tone: string): string {
  switch (tone) {
    case 'danger':
      return 'border-[#EF4444]/35 bg-[#EF4444]/10 text-[#FCA5A5]';
    case 'warning':
      return 'border-[#F59E0B]/35 bg-[#F59E0B]/10 text-[#FCD34D]';
    case 'success':
      return 'border-[#22C55E]/30 bg-[#22C55E]/10 text-[#86EFAC]';
    case 'info':
      return 'border-[#3B82F6]/35 bg-[#3B82F6]/10 text-[#BFDBFE]';
    default:
      return 'border-[#2F3B52]/80 bg-[#111827] text-[#C7D2E3]';
  }
}

export function ProjectOverviewBand({ model, stageCounts }: ProjectOverviewBandProps) {
  const criticalLabel = model.status.is_clear ? 'Clear' : model.status.label;
  const needsReviewMetric = model.metrics.find((m) => m.key === 'needs-review');
  const anomaliesMetric = model.metrics.find((m) => m.key === 'anomalies');

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        title={model.status.detail}
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneClass(model.status.tone)}`}
      >
        <span className="text-[#94A3B8]">Status</span>
        <span>{criticalLabel}</span>
      </span>

      {FORGE_STAGE_KEYS.map((key) => (
        <span
          key={key}
          className="inline-flex items-center gap-2 rounded-full border border-[#2F3B52]/80 bg-[#111827] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#C7D2E3]"
        >
          <span className="text-[#64748B]">{FORGE_STAGE_LABELS[key]}</span>
          <span className="font-mono tabular-nums text-[#E5EDF7]">{stageCounts[key]}</span>
        </span>
      ))}

      {needsReviewMetric ? (
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneClass(needsReviewMetric.tone)}`}
        >
          <span className="text-[#94A3B8]">{needsReviewMetric.label}</span>
          <span>{needsReviewMetric.value}</span>
        </span>
      ) : null}

      {anomaliesMetric ? (
        <span
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${toneClass(anomaliesMetric.tone)}`}
        >
          <span className="text-[#94A3B8]">{anomaliesMetric.label}</span>
          <span>{anomaliesMetric.value}</span>
        </span>
      ) : null}
    </div>
  );
}
