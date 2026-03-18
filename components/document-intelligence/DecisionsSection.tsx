'use client';

// components/document-intelligence/DecisionsSection.tsx
// Groups decisions by status, sorts by confidence, shows icon + title + explanation + confidence + task count.

import type { GeneratedDecision, IntelligenceStatus } from '@/lib/types/documentIntelligence';

// ─── Config ───────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<IntelligenceStatus, string> = {
  passed:   '✓',
  missing:  '○',
  risky:    '⚠',
  mismatch: '✕',
  info:     'ℹ',
};

const STATUS_COLORS: Record<IntelligenceStatus, string> = {
  passed:   'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  missing:  'text-[#8B94A3] bg-white/5 border-white/10',
  risky:    'text-amber-400 bg-amber-500/10 border-amber-500/20',
  mismatch: 'text-red-400 bg-red-500/10 border-red-500/20',
  info:     'text-sky-400 bg-sky-500/10 border-sky-500/20',
};

const STATUS_LABEL: Record<IntelligenceStatus, string> = {
  mismatch: 'Mismatch',
  risky:    'Risky',
  missing:  'Missing',
  info:     'Info',
  passed:   'Passed',
};

// Show in this order: most severe first, passed last
const GROUP_ORDER: IntelligenceStatus[] = ['mismatch', 'risky', 'missing', 'info', 'passed'];

// ─── Decision row ─────────────────────────────────────────────────────────────

function DecisionRow({ decision }: { decision: GeneratedDecision }) {
  const colors = STATUS_COLORS[decision.status];
  const icon   = STATUS_ICON[decision.status];
  const taskCount = decision.relatedTaskIds?.length ?? 0;

  return (
    <div className="flex items-start gap-3 py-3 border-b border-white/5 last:border-0">
      <span
        className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-xs font-bold ${colors}`}
        aria-label={decision.status}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-white">{decision.title}</p>
          {typeof decision.confidence === 'number' && (
            <span className="text-[10px] text-[#5B6578]">
              {Math.round(decision.confidence * 100)}%
            </span>
          )}
          {taskCount > 0 && (
            <span className="inline-flex items-center rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
              {taskCount} task{taskCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-[#8B94A3] leading-relaxed">
          {decision.explanation}
        </p>
      </div>
    </div>
  );
}

// ─── Group header ─────────────────────────────────────────────────────────────

function GroupHeader({ status, count }: { status: IntelligenceStatus; count: number }) {
  const textColor = STATUS_COLORS[status].split(' ')[0]; // just the text-* class
  return (
    <div className="px-5 pt-3 pb-0.5 flex items-center gap-1.5">
      <span className={`text-[10px] font-semibold uppercase tracking-wider ${textColor}`}>
        {STATUS_ICON[status]} {STATUS_LABEL[status]}
      </span>
      <span className="text-[10px] text-[#5B6578]">({count})</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface DecisionsSectionProps {
  decisions: GeneratedDecision[];
}

export function DecisionsSection({ decisions }: DecisionsSectionProps) {
  // Empty state
  if (decisions.length === 0) {
    return (
      <div className="rounded-xl bg-[#0F1117] border border-white/10">
        <div className="border-b border-white/8 px-5 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8B94A3]">
            Decisions
          </h3>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-[#8B94A3] italic">
            No issues detected. Document looks complete.
          </p>
        </div>
      </div>
    );
  }

  // Group and sort: within each group, sort by confidence descending
  const groups = GROUP_ORDER
    .map((status) => ({
      status,
      items: decisions
        .filter((d) => d.status === status)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)),
    }))
    .filter(({ items }) => items.length > 0);

  return (
    <div className="rounded-xl bg-[#0F1117] border border-white/10">
      <div className="border-b border-white/8 px-5 py-3 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8B94A3]">
          Decisions
        </h3>
        <span className="ml-auto text-[10px] text-[#5B6578]">{decisions.length} total</span>
      </div>
      <div className="divide-y divide-white/5">
        {groups.map(({ status, items }) => (
          <div key={status}>
            <GroupHeader status={status} count={items.length} />
            <div className="px-5">
              {items.map((d) => (
                <DecisionRow key={d.id} decision={d} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
