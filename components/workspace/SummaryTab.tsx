'use client';

import Link from 'next/link';
import type { ProjectOverviewModel, ProjectDecisionRow, ProjectTaskRow } from '@/lib/projectOverview';
import type { ForgeStageCounts } from '@/lib/forgeStageCounts';

type SummaryTabProps = {
  model: ProjectOverviewModel;
  stageCounts: ForgeStageCounts;
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  onGoToWork: () => void;
};

function toneClass(tone: string): string {
  switch (tone) {
    case 'danger': return 'text-[#F87171]';
    case 'warning': return 'text-[#FBBF24]';
    case 'success': return 'text-[#34D399]';
    case 'info': return 'text-[#60A5FA]';
    default: return 'text-[#94A3B8]';
  }
}

function toneBgClass(tone: string): string {
  switch (tone) {
    case 'danger': return 'bg-[#EF4444]/10 border-[#EF4444]/30 text-[#F87171]';
    case 'warning': return 'bg-[#F59E0B]/10 border-[#F59E0B]/25 text-[#FBBF24]';
    case 'success': return 'bg-[#22C55E]/10 border-[#22C55E]/25 text-[#34D399]';
    case 'info': return 'bg-[#3B82F6]/10 border-[#3B82F6]/25 text-[#60A5FA]';
    default: return 'bg-[#111827] border-[#2F3B52]/70 text-[#94A3B8]';
  }
}

export function SummaryTab({
  model,
  stageCounts,
  decisions,
  tasks,
  onGoToWork,
}: SummaryTabProps) {
  const processedCount = model.documents.length;
  const needsReviewCount = decisions.filter(
    (d) => ['open', 'in_review', 'needs_review'].includes(d.status),
  ).length;
  const openActionsCount = tasks.filter(
    (t) => ['open', 'in_progress', 'blocked', 'pending'].includes(t.status),
  ).length;
  const blockedCount = tasks.filter((t) => t.status === 'blocked').length
    + decisions.filter((d) => d.status === 'open' && d.severity === 'critical').length;

  // Top 3 issues from decision cards in model
  const topIssues = model.decisions.slice(0, 3);

  const validatorSummary = model.validator_summary;
  const exposure = model.exposure;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4 gap-4">
      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[#2F3B52]/60 bg-[#0D1526]/80 px-4 py-2.5">
        {[
          { label: 'Processed', value: processedCount, tone: 'neutral' },
          { label: 'Needs Review', value: needsReviewCount, tone: needsReviewCount > 0 ? 'warning' : 'success' },
          { label: 'Open Actions', value: openActionsCount, tone: openActionsCount > 0 ? 'info' : 'success' },
          { label: 'Blocked', value: blockedCount, tone: blockedCount > 0 ? 'danger' : 'success' },
        ].map((stat) => (
          <div key={stat.label} className="flex items-baseline gap-1.5">
            <span className={`font-mono text-[16px] font-bold tabular-nums ${toneClass(stat.tone)}`}>
              {stat.value}
            </span>
            <span className="text-[10px] uppercase tracking-[0.14em] text-[#475569]">{stat.label}</span>
          </div>
        ))}
      </div>

      {/* Safety panel — 2 columns */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Validator summary */}
        <section className="rounded-lg border border-[#2F3B52]/60 bg-[#0D1526]/80">
          <div className="border-b border-[#2F3B52]/50 px-4 py-2">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#64748B]">Validator Summary</h2>
          </div>
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#64748B]">Status</span>
              <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ring-1 ${
                validatorSummary.status === 'VALIDATED'
                  ? 'text-[#34D399] ring-[#22C55E]/30'
                  : validatorSummary.status === 'BLOCKED'
                    ? 'text-[#F87171] ring-[#EF4444]/35'
                    : 'text-[#FBBF24] ring-[#F59E0B]/30'
              }`}>
                {validatorSummary.status.replace(/_/g, ' ')}
              </span>
            </div>
            {validatorSummary.critical_count > 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#64748B]">Critical findings</span>
                <span className="font-mono text-[13px] font-bold text-[#F87171]">
                  {validatorSummary.critical_count}
                </span>
              </div>
            ) : null}
            {validatorSummary.warning_count > 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#64748B]">Warnings</span>
                <span className="font-mono text-[13px] font-bold text-[#FBBF24]">
                  {validatorSummary.warning_count}
                </span>
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#64748B]">Open items</span>
              <span className="font-mono text-[13px] tabular-nums text-[#94A3B8]">
                {validatorSummary.open_count}
              </span>
            </div>
          </div>
        </section>

        {/* Contract exposure */}
        <section className="rounded-lg border border-[#2F3B52]/60 bg-[#0D1526]/80">
          <div className="border-b border-[#2F3B52]/50 px-4 py-2">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#64748B]">Contract Exposure</h2>
          </div>
          <div className="px-4 py-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#64748B]">Billed vs limit</span>
              <span className={`font-mono text-[13px] font-bold tabular-nums ${toneClass(exposure.tone)}`}>
                {exposure.percent_label}
              </span>
            </div>
            {/* Progress bar */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1E2B3D]">
              <div
                className={`h-full rounded-full transition-all ${
                  exposure.tone === 'danger'
                    ? 'bg-[#EF4444]'
                    : exposure.tone === 'warning'
                      ? 'bg-[#F59E0B]'
                      : 'bg-[#3B82F6]'
                }`}
                style={{ width: `${Math.min(100, exposure.bar_percent)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-[#475569]">
              <span>{exposure.actual_label}</span>
              <span>{exposure.limit_label}</span>
            </div>
            {exposure.detail ? (
              <p className="text-[10px] leading-relaxed text-[#475569]">{exposure.detail}</p>
            ) : null}
          </div>
        </section>
      </div>

      {/* Top 3 issues */}
      {topIssues.length > 0 ? (
        <section className="rounded-lg border border-[#2F3B52]/60 bg-[#0D1526]/80">
          <div className="flex items-center justify-between border-b border-[#2F3B52]/50 px-4 py-2">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#64748B]">
              Top Issues
            </h2>
            <button
              type="button"
              onClick={onGoToWork}
              className="text-[10px] text-[#3B82F6] transition hover:text-[#60A5FA] hover:underline"
            >
              View all in Work →
            </button>
          </div>
          <ul className="divide-y divide-[#1E2B3D]/60">
            {topIssues.map((issue) => (
              <li key={issue.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold leading-snug text-[#C7D2E3]">
                    {issue.title}
                  </p>
                  <p className="mt-0.5 text-[10px] text-[#475569]">{issue.freshness_label}</p>
                  {issue.reason ? (
                    <p className="mt-1 line-clamp-1 text-[11px] text-[#64748B]">{issue.reason}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] ring-1 ${toneBgClass(issue.border_tone)}`}
                  >
                    {Math.round(
                      typeof issue.metadata[0] === 'string' && issue.metadata[0].includes('%')
                        ? parseFloat(issue.metadata[0])
                        : 0
                    )}%
                  </span>
                  <button
                    type="button"
                    onClick={onGoToWork}
                    className="rounded border border-[#3B82F6]/40 bg-[#3B82F6]/10 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#93C5FD] transition hover:bg-[#3B82F6]/20"
                  >
                    Go to Work
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="flex flex-col items-center justify-center py-8">
          <p className="text-[12px] text-[#475569]">No active issues. Project looks clear.</p>
          <button
            type="button"
            onClick={onGoToWork}
            className="mt-3 rounded-lg border border-[#3B82F6]/40 bg-[#3B82F6]/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#93C5FD] transition hover:bg-[#3B82F6]/20"
          >
            Open Work Queue
          </button>
        </div>
      )}
    </div>
  );
}
