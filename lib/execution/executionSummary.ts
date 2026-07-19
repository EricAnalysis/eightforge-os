import {
  executionItemBlocksApproval,
  type ProjectExecutionItemRow,
} from '@/lib/executionItems';

export type RecommendedNextAction = {
  source_item_id: string;
  priority_reason: string;
};

export type OpenExecutionItemSummary = {
  id: string;
  status: ProjectExecutionItemRow['status'];
  required_action: string;
  blocker_flag: boolean;
};

export type PaymentReleaseBlocker = {
  action_id: string;
  blocker_basis: string;
  payment_gate_impact: string;
};

export type ProjectExecutionSummary = {
  recommended_next_action: RecommendedNextAction | null;
  open_execution_items: OpenExecutionItemSummary[];
  payment_release_blockers: PaymentReleaseBlocker[];
};

function severityRank(item: ProjectExecutionItemRow): number {
  switch (item.severity) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    case 'low':
    default:
      return 3;
  }
}

function statusRank(item: ProjectExecutionItemRow): number {
  if (item.status === 'open') return 0;
  if (item.status === 'resolvable') return 1;
  return 2;
}

function executionItemBlockerFlag(item: ProjectExecutionItemRow): boolean {
  return executionItemBlocksApproval(item) || item.severity === 'critical';
}

function paymentGateImpact(item: ProjectExecutionItemRow): string {
  return executionItemBlockerFlag(item)
    ? 'Payment release remains blocked until this execution item is resolved or overridden with audit basis.'
    : 'Payment release requires operator review before final approval.';
}

export function buildProjectExecutionSummary(
  items: readonly ProjectExecutionItemRow[],
): ProjectExecutionSummary {
  const unresolved = [...items]
    .filter((item) => item.status !== 'resolved' && item.status !== 'superseded')
    .sort((left, right) => {
      const statusDelta = statusRank(left) - statusRank(right);
      if (statusDelta !== 0) return statusDelta;
      const severityDelta = severityRank(left) - severityRank(right);
      if (severityDelta !== 0) return severityDelta;
      return left.created_at.localeCompare(right.created_at, 'en-US');
    });
  const top = unresolved[0] ?? null;

  return {
    recommended_next_action: top
      ? {
          source_item_id: top.id,
          priority_reason: `${top.title}: ${top.impact}`,
        }
      : null,
    open_execution_items: unresolved.map((item) => ({
      id: item.id,
      status: item.status,
      required_action: item.required_action,
      blocker_flag: executionItemBlockerFlag(item),
    })),
    payment_release_blockers: unresolved
      .filter(executionItemBlockerFlag)
      .map((item) => ({
        action_id: item.id,
        blocker_basis: `${item.problem}; required action ${item.required_action}`,
        payment_gate_impact: paymentGateImpact(item),
      })),
  };
}
