'use client';

import type { TriggeredWorkflowTask, TaskPriority } from '@/lib/types/documentIntelligence';

const PRIORITY_BADGE: Record<TaskPriority, string> = {
  P1: 'bg-red-500/20 text-red-400 border-red-500/30',
  P2: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  P3: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
};

const STATUS_COLOR: Record<string, string> = {
  open: 'text-[#B794FF]',
  in_progress: 'text-amber-400',
  resolved: 'text-emerald-400',
  auto_completed: 'text-[#5B6578]',
};

function priorityRank(priority: TriggeredWorkflowTask['priority']): number {
  if (priority === 'P1') return 0;
  if (priority === 'P2') return 1;
  return 2;
}

function flowTypeRank(task: TriggeredWorkflowTask): number {
  if (task.flow_type === 'escalation' && task.priority === 'P1') return -1;
  if (task.flow_type === 'validation') return 0;
  if (task.flow_type === 'correction') return 1;
  if (task.flow_type === 'documentation') return 2;
  if (task.flow_type === 'escalation') return 3;
  return 4;
}

interface FlowSectionProps {
  tasks: TriggeredWorkflowTask[];
  unavailableMessage?: string;
}

export function FlowSection({ tasks, unavailableMessage }: FlowSectionProps) {
  const sortedTasks = [...tasks].sort((a, b) =>
    priorityRank(a.priority) - priorityRank(b.priority) ||
    flowTypeRank(a) - flowTypeRank(b) ||
    a.title.localeCompare(b.title),
  );

  return (
    <div className="rounded-xl border border-white/10 bg-[#0F1117]">
      <div className="border-b border-white/8 px-5 py-3 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#8B94A3]">
          Next Actions
        </h3>
        {sortedTasks.length > 0 && (
          <span className="ml-auto inline-flex items-center rounded-full bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-400">
            {sortedTasks.length}
          </span>
        )}
      </div>

      {unavailableMessage ? (
        <div className="px-5 py-4">
          <p className="text-sm italic text-amber-200">{unavailableMessage}</p>
        </div>
      ) : sortedTasks.length === 0 ? (
        <div className="px-5 py-4">
          <p className="text-sm italic text-[#8B94A3]">No actions required.</p>
        </div>
      ) : (
        <div className="px-5">
          {sortedTasks.map((task) => (
            <div
              key={task.id}
              className={`flex items-start gap-3 py-3 border-b border-white/5 last:border-0 ${
                task.priority === 'P1' ? 'bg-red-500/5 -mx-5 px-5' : ''
              }`}
            >
              <span
                className={`mt-0.5 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold flex-shrink-0 ${PRIORITY_BADGE[task.priority]}`}
              >
                {task.priority}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${task.priority === 'P1' ? 'text-white' : 'text-[#C5CAD4]'}`}>
                  {task.title}
                </p>
                <p className="mt-0.5 text-xs text-[#8B94A3]">
                  {task.reason}
                  {task.suggestedOwner && (
                    <span className="ml-2 text-[#5B6578]">· {task.suggestedOwner}</span>
                  )}
                </p>
              </div>
              <span className={`shrink-0 text-[10px] ${STATUS_COLOR[task.status] ?? 'text-[#8B94A3]'}`}>
                {task.status.replace(/_/g, ' ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
