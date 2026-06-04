import type { OperationalQueueModel } from '@/lib/server/operationalQueue';

export type PortfolioStalenessState = {
  projectId: string;
  isStale: boolean;
  label: 'Current' | 'Stale' | 'Potentially stale or incomplete';
  reason: string | null;
};

export function checkPortfolioStaleness(operations: OperationalQueueModel): Map<string, PortfolioStalenessState> {
  const globalWarning = operations.warnings[0] ?? null;
  const states = new Map<string, PortfolioStalenessState>();

  for (const item of operations.project_rollups) {
    const validationSummary = item.project.validation_summary_json;
    const isMissingValidation = validationSummary == null;
    const isStale = Boolean(globalWarning) || isMissingValidation;
    states.set(item.project.id, {
      projectId: item.project.id,
      isStale,
      label: isStale
        ? globalWarning
          ? 'Potentially stale or incomplete'
          : 'Stale'
        : 'Current',
      reason: globalWarning ?? (isMissingValidation ? 'No validation snapshot is available.' : null),
    });
  }

  return states;
}
