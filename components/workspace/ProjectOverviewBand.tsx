'use client';

import type { ProjectOverviewModel } from '@/lib/projectOverview';
import { FORGE_STAGE_KEYS, FORGE_STAGE_LABELS, type ForgeStageCounts } from '@/lib/forgeStageCounts';

type ProjectOverviewBandProps = {
  model: ProjectOverviewModel;
  stageCounts: ForgeStageCounts;
};

export function ProjectOverviewBand({ model, stageCounts }: ProjectOverviewBandProps) {
  const criticalLabel = model.status.is_clear ? 'Clear' : model.status.label;
  const needsReviewMetric = model.metrics.find((m) => m.key === 'needs-review');
  const anomaliesMetric = model.metrics.find((m) => m.key === 'anomalies');

  return (
    <div className="border-b border-[#2F3B52]/80 bg-[#111827]/80 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">Status</p>
          <p className="truncate text-[12px] font-semibold text-[#E5EDF7]">{criticalLabel}</p>
          {!model.status.is_clear ? (
            <p className="truncate text-[11px] text-[#94A3B8]">{model.status.detail}</p>
          ) : null}
        </div>

        <div className="hidden h-8 w-px bg-[#2F3B52]/80 sm:block" aria-hidden />

        <div className="flex flex-wrap gap-3">
          {FORGE_STAGE_KEYS.map((key) => (
            <div key={key} className="flex items-baseline gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                {FORGE_STAGE_LABELS[key]}
              </span>
              <span className="text-[12px] font-bold tabular-nums text-[#C7D2E3]">{stageCounts[key]}</span>
            </div>
          ))}
        </div>

        <div className="hidden h-8 w-px bg-[#2F3B52]/80 md:block" aria-hidden />

        <div className="flex flex-wrap gap-4 text-[11px] text-[#94A3B8]">
          <span>
            Active decisions{' '}
            <strong className="font-semibold text-[#E5EDF7]">{stageCounts.decide}</strong>
          </span>
          <span>
            Open actions{' '}
            <strong className="font-semibold text-[#E5EDF7]">{stageCounts.act}</strong>
          </span>
          {needsReviewMetric ? (
            <span className={needsReviewMetric.tone === 'warning' ? 'text-[#FBBF24]' : undefined}>
              {needsReviewMetric.label}{' '}
              <strong className="font-semibold text-[#E5EDF7]">{needsReviewMetric.value}</strong>
            </span>
          ) : null}
          {anomaliesMetric && anomaliesMetric.tone === 'danger' ? (
            <span className="text-[#F87171]">
              {anomaliesMetric.label}{' '}
              <strong className="font-semibold text-[#E5EDF7]">{anomaliesMetric.value}</strong>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
