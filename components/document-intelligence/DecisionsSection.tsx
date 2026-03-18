'use client';

// components/document-intelligence/DecisionsSection.tsx
// Renders the list of generated decisions (status icons + explanation) and
// workflow tasks triggered from those decisions.

import type {
  GeneratedDecision,
  TriggeredWorkflowTask,
  IntelligenceStatus,
  TaskPriority,
} from '@/lib/types/documentIntelligence';

// ─── Status icon / badge helpers ─────────────────────────────────────────────

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

const PRIORITY_BADGE: Record<TaskPriority, string> = {
  P1: 'bg-red-500/20 text-red-400 border-red-500/30',
  P2: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  P3: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function DecisionRow({ decision }: { decision: GeneratedDecision }) {
  const colors = STATUS_COLORS[decision.status];
  const icon = STATUS_ICON[decision.status];

  return (
    <div className="flex items-start gap-3 py-3 border-b border-white/5 last:border-0">
      <span
        className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-xs font-bold ${colors}`}
        aria-label={decision.status}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{decision.title}</p>
        <p className="mt-0.5 text-xs text-[#8B94A3] leading-relaxed">
          {decision.explanation}
        </p>
      </div>
    </div>
  );
}

function TaskRow({ task }: { task: TriggeredWorkflowTask }) {
  const badgeCls = PRIORITY_BADGE[task.priority];

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-white/5 last:border-0">
      <span
        className={`mt-0.5 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold ${badgeCls}`}
      >
        {task.priority}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white">{task.title}</p>
        <p className="mt-0.5 text-xs text-[#8B94A3]">
          {task.reason}
          {task.suggestedOwner && (
            <span className="ml-1 text-[#5B6578]">· {task.suggestedOwner}</span>
          )}
        </p>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface DecisionsSectionProps {
  decisions: GeneratedDecision[];
  tasks: TriggeredWorkflowTask[];
}

export function DecisionsSection({ decisions, tasks }: DecisionsSectionProps) {
  if (decisions.length === 0 && tasks.length === 0) return null;

  return (
    <div className="space-y-3">
      {decisions.length > 0 && (
        <div className="rounded-xl bg-[#0F1117] border border-white/10">
          <div className="border-b border-white/8 px-5 py-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8B94A3]">
              Decisions
            </h3>
          </div>
          <div className="px-5">
            {decisions.map(d => (
              <DecisionRow key={d.id} decision={d} />
            ))}
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="rounded-xl bg-[#0F1117] border border-white/10">
          <div className="border-b border-white/8 px-5 py-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8B94A3]">
              Action Items
              <span className="ml-2 inline-flex items-center rounded-full bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-400">
                {tasks.length}
              </span>
            </h3>
          </div>
          <div className="px-5">
            {tasks.map(t => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
