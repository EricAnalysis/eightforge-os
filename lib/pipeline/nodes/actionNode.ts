import type { ActionNodeOutput, DecisionNodeOutput } from '@/lib/pipeline/types';
import type { FlowTask } from '@/lib/types/documentIntelligence';

function dedupeTasks(tasks: FlowTask[]): FlowTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

export function actionNode(input: DecisionNodeOutput): ActionNodeOutput {
  const actions = dedupeTasks(input.actions);
  const decisionTaskIds = new Map<string, string[]>();
  for (const action of actions) {
    for (const decisionId of action.source_decision_ids) {
      const current = decisionTaskIds.get(decisionId) ?? [];
      current.push(action.id);
      decisionTaskIds.set(decisionId, current);
    }
  }

  return {
    ...input,
    actions,
    decision_task_ids: decisionTaskIds,
  };
}
