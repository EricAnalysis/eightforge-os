import { resolveCanonicalProjectFacts } from '@/lib/projectFacts';
import type { ProjectExecutionSummary } from '@/lib/execution/executionSummary';

export type PortfolioProjectStatusAggregateInput = {
  project_id: string;
  project_name: string;
  validation_status?: string | null;
  validation_summary?: unknown;
  execution_summary?: ProjectExecutionSummary | null;
  validation_snapshot_stale?: boolean;
};

export type PortfolioProjectStatusAggregateProject = {
  project_id: string;
  project_name: string;
  readiness_state: string;
};

export type PortfolioProjectStatusAggregate = {
  blocked_projects: PortfolioProjectStatusAggregateProject[];
  blocked_project_count: number;
  approval_ready_projects: PortfolioProjectStatusAggregateProject[];
  approval_ready_project_count: number;
  stale_validation_projects: PortfolioProjectStatusAggregateProject[];
  stale_validation_project_count: number;
};

function isBlockedReadiness(readiness: string | null | undefined, status: string): boolean {
  return readiness === 'BLOCKED' || status === 'BLOCKED';
}

function isApprovalReadyReadiness(readiness: string | null | undefined, status: string): boolean {
  return (readiness === 'READY' || status === 'VALIDATED') && readiness !== 'BLOCKED';
}

export function buildPortfolioProjectStatusAggregate(
  projects: readonly PortfolioProjectStatusAggregateInput[],
): PortfolioProjectStatusAggregate {
  const blocked_projects: PortfolioProjectStatusAggregateProject[] = [];
  const approval_ready_projects: PortfolioProjectStatusAggregateProject[] = [];
  const stale_validation_projects: PortfolioProjectStatusAggregateProject[] = [];

  for (const project of projects) {
    const facts = resolveCanonicalProjectFacts({
      validationStatus: project.validation_status,
      validationSummary: project.validation_summary,
    });
    const readinessState = facts.readiness ?? facts.validator_status ?? facts.status;
    const aggregateProject = {
      project_id: project.project_id,
      project_name: project.project_name,
      readiness_state: readinessState,
    };
    const hasExecutionPaymentBlocker =
      (project.execution_summary?.payment_release_blockers.length ?? 0) > 0;

    if (isBlockedReadiness(readinessState, facts.status) || hasExecutionPaymentBlocker) {
      blocked_projects.push(aggregateProject);
    }

    if (
      isApprovalReadyReadiness(readinessState, facts.status)
      && !hasExecutionPaymentBlocker
      && !project.validation_snapshot_stale
    ) {
      approval_ready_projects.push(aggregateProject);
    }

    if (project.validation_snapshot_stale) {
      stale_validation_projects.push(aggregateProject);
    }
  }

  return {
    blocked_projects,
    blocked_project_count: blocked_projects.length,
    approval_ready_projects,
    approval_ready_project_count: approval_ready_projects.length,
    stale_validation_projects,
    stale_validation_project_count: stale_validation_projects.length,
  };
}
