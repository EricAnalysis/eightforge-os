'use client';

import { getIssueDisplayLabel } from '@/lib/issueDisplayFormatter';
import { getIssueLifecycleColor, getIssueLifecycleLabel, type IssueObject } from '@/lib/issueObjects';
import { humanizeTruthToken } from '@/lib/truthToAction';

type ValidatorFindingsPanelProps = {
  issues: readonly IssueObject[];
  selectedIssueId: string | null;
  onSelect: (issueId: string) => void;
  emptyState: string;
};

function pillClassName(lifecycle: IssueObject['lifecycleState']): string {
  switch (getIssueLifecycleColor(lifecycle)) {
    case 'critical':
    case 'danger':
      return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]';
    case 'warning':
      return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'success':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'info':
      return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]';
    case 'muted':
    default:
      return 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] text-[var(--ef-text-secondary)]';
  }
}

function findingSourceContext(issue: IssueObject): string {
  const documentLabel = issue.evidenceTargets.find((target) => target.sourceName)?.sourceName;
  const subjectLabel = humanizeTruthToken(issue.finding.subject_type);
  return documentLabel ? `${subjectLabel} · ${documentLabel}` : subjectLabel;
}

export function ValidatorFindingsPanel({
  issues,
  selectedIssueId,
  onSelect,
  emptyState,
}: ValidatorFindingsPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--ef-border-subtle-a70)] px-4 py-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
          Findings
        </p>
        <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
          Sorted by state and priority. Read only &mdash; select a finding to review evidence and act.
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {issues.length === 0 ? (
          <div className="rounded-sm border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] px-4 py-5 text-sm text-[var(--ef-text-secondary)]">
            {emptyState}
          </div>
        ) : (
          issues.map((issue) => {
            const display = getIssueDisplayLabel(issue.issueType, issue.title);
            const selected = issue.issueId === selectedIssueId;

            return (
              <button
                key={issue.issueId}
                type="button"
                onClick={() => onSelect(issue.issueId)}
                className={`w-full rounded-sm border px-3 py-3 text-left transition-colors ${
                  selected
                    ? 'border-[var(--ef-purple-primary-a45)] bg-[var(--ef-surface-elevated)]'
                    : 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] hover:border-[var(--ef-purple-primary-a20)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-semibold text-[var(--ef-text-primary)]">
                    {display.title}
                  </p>
                  <span className={`shrink-0 rounded-sm border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${pillClassName(issue.lifecycleState)}`}>
                    {getIssueLifecycleLabel(issue.lifecycleState)}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--ef-text-muted)]">
                  {findingSourceContext(issue)}
                </p>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
