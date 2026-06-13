import type { OperationalProjectRollupItem } from '@/lib/server/operationalQueue';
import type { OperationsQueueType, OperationsRoutingAction } from '@/lib/operationsQuery/types';

export type { AskOperationsCoverageGapPayload } from '@/lib/operationsQuery/logCoverageGap';
export { logCoverageGap } from '@/lib/operationsQuery/logCoverageGap';

/** Routing action discriminator for filtered Command Center / queue views. */
export const OPEN_QUEUE = 'OPEN_QUEUE' as const;

/**
 * Filtered workspace targets (existing routes only — no new pages).
 * Aligns with /platform/reviews sections and /platform/decisions query filters.
 */
const QUEUE_TARGETS: Record<
  OperationsQueueType,
  { href: string; label: string }
> = {
  blocked_projects: {
    href: '/platform/reviews#blocked',
    label: 'Open blocked projects queue',
  },
  high_risk_projects: {
    href: '/platform/decisions?severity=high',
    label: 'Open high risk projects queue',
  },
  approaching_nte: {
    href: '/platform/portfolio',
    label: 'Open nearing NTE queue',
  },
  approval_blockers: {
    href: '/platform/decisions?type=approval_blocker',
    label: 'Open approval blockers queue',
  },
  pending_invoices: {
    href: '/platform/decisions?status=in_review',
    label: 'Open pending invoices queue',
  },
  projects_needing_review: {
    href: '/platform/reviews#needs-review',
    label: 'Open projects needing review queue',
  },
};

export function openQueueRoutingAction(queueType: OperationsQueueType): OperationsRoutingAction {
  const t = QUEUE_TARGETS[queueType];
  return {
    label: t.label,
    href: t.href,
    routingKind: OPEN_QUEUE,
    queueType,
  };
}

/** Short project deep links for secondary routing (Command Center project surfaces). */
export function openProjectLinks(
  rollups: OperationalProjectRollupItem[],
  projectIds: string[],
  max = 3,
): OperationsRoutingAction[] {
  return projectIds.slice(0, max).map((projectId) => {
    const r = rollups.find((x) => x.project.id === projectId);
    const name = r?.project.name ?? 'Project';
    return {
      label: `Open ${name}`,
      href: r?.href ?? `/platform/projects/${projectId}`,
    };
  });
}

export function queuePrimaryNextAction(queueType: OperationsQueueType): string {
  return QUEUE_TARGETS[queueType].label;
}
