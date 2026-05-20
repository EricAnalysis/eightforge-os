'use client';

import {
  findingApprovalLabel,
  findingGateImpact,
  findingNextAction,
  findingProblem,
  type OperatorApprovalLabel,
} from '@/lib/truthToAction';
import type {
  FindingStatus,
  ValidationCategory,
  ValidationFinding,
  ValidationSeverity,
} from '@/types/validator';

export type ValidatorFindingFilters = {
  severity: 'all' | ValidationSeverity;
  category: 'all' | ValidationCategory;
  status: 'all' | FindingStatus;
};

type ValidatorFindingsTableProps = {
  findings: ValidationFinding[];
  filters: ValidatorFindingFilters;
  selectedFindingId: string | null;
  onFiltersChange: (filters: ValidatorFindingFilters) => void;
  onSelectFinding: (finding: ValidationFinding) => void;
};

const CATEGORY_LABELS: Record<ValidationCategory, string> = {
  required_sources: 'Required Sources',
  identity_consistency: 'Identity Consistency',
  financial_integrity: 'Financial Integrity',
  ticket_integrity: 'Ticket Integrity',
};

const STATUS_LABELS: Record<FindingStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  muted: 'Muted',
};

const SEVERITY_LABELS: Record<ValidationSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

function statusClassName(status: FindingStatus): string {
  switch (status) {
    case 'resolved':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'dismissed':
      return 'border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)]';
    case 'muted':
      return 'border-[var(--ef-purple-accent-a30)] bg-[var(--ef-purple-primary-a12)] text-[var(--ef-purple-glow)]';
    case 'open':
    default:
      return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]';
  }
}

function approvalClassName(label: OperatorApprovalLabel): string {
  switch (label) {
    case 'Requires Verification':
      return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]';
    case 'Needs Review':
    case 'Approved with Notes':
      return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'Approved':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'Not Evaluated':
    case 'Unknown':
    default:
      return 'border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)]';
  }
}

function formatSubject(finding: ValidationFinding): string {
  return `${finding.subject_type}:${finding.subject_id}`;
}

function formatVariance(finding: ValidationFinding): string {
  if (finding.variance == null) {
    return 'N/A';
  }

  return finding.variance_unit
    ? `${finding.variance} ${finding.variance_unit}`
    : String(finding.variance);
}

function findingValue(finding: ValidationFinding): string {
  return findingProblem(finding);
}

function filterOptionClassName(): string {
  return 'rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs text-[var(--ef-text-primary)] outline-none transition-colors focus:border-[var(--ef-purple-primary)]';
}

export function ValidatorFindingsTable({
  findings,
  filters,
  selectedFindingId,
  onFiltersChange,
  onSelectFinding,
}: ValidatorFindingsTableProps) {
  const filteredFindings = findings.filter((finding) => {
    if (filters.severity !== 'all' && finding.severity !== filters.severity) {
      return false;
    }
    if (filters.category !== 'all' && finding.category !== filters.category) {
      return false;
    }
    if (filters.status !== 'all' && finding.status !== filters.status) {
      return false;
    }
    return true;
  });

  const updateFilters = <Key extends keyof ValidatorFindingFilters,>(
    key: Key,
    value: ValidatorFindingFilters[Key],
  ) => {
    onFiltersChange({
      ...filters,
      [key]: value,
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Severity
          </span>
          <select
            value={filters.severity}
            onChange={(event) => updateFilters('severity', event.target.value as ValidatorFindingFilters['severity'])}
            className={filterOptionClassName()}
          >
            <option value="all">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Category
          </span>
          <select
            value={filters.category}
            onChange={(event) => updateFilters('category', event.target.value as ValidatorFindingFilters['category'])}
            className={filterOptionClassName()}
          >
            <option value="all">All categories</option>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Record state
          </span>
          <select
            value={filters.status}
            onChange={(event) => updateFilters('status', event.target.value as ValidatorFindingFilters['status'])}
            className={filterOptionClassName()}
          >
            <option value="all">All record states</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-hidden rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)]">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-[var(--ef-border-subtle-a70)] text-left">
            <thead className="bg-[var(--ef-background-secondary)]">
              <tr className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
                <th className="px-4 py-3">Value</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Validation</th>
                <th className="px-4 py-3">Gate impact</th>
                <th className="px-4 py-3">Next action</th>
                <th className="px-4 py-3 text-right">Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ef-border-subtle-a50)] text-sm text-[var(--ef-text-primary)]">
              {filteredFindings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-[var(--ef-text-muted)]">
                    {findings.length === 0
                      ? 'No approval findings are currently open for this project.'
                      : 'No findings match the active filters.'}
                  </td>
                </tr>
              ) : (
                filteredFindings.map((finding) => {
                  const isSelected = finding.id === selectedFindingId;
                  const approvalLabel = findingApprovalLabel(finding);
                  const gateImpact = findingGateImpact(finding);
                  const nextAction = findingNextAction(finding);

                  return (
                    <tr
                      key={finding.id}
                      tabIndex={0}
                      onClick={() => onSelectFinding(finding)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelectFinding(finding);
                        }
                      }}
                      className={`cursor-pointer align-top transition-colors ${
                        isSelected
                          ? 'bg-[var(--ef-purple-primary-a10)]'
                          : 'hover:bg-[var(--ef-surface-elevated)]'
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="max-w-[20rem]">
                          <p className="font-semibold leading-snug text-[var(--ef-text-primary)]">
                            {findingValue(finding)}
                          </p>
                          <div className="mt-2 space-y-1 text-xs text-[var(--ef-text-muted)]">
                            {finding.expected ? (
                              <p>
                                Truth: <span className="text-[var(--ef-text-secondary)]">{finding.expected}</span>
                              </p>
                            ) : null}
                            {finding.actual ? (
                              <p>
                                Observed: <span className="text-[var(--ef-text-secondary)]">{finding.actual}</span>
                              </p>
                            ) : null}
                            {finding.variance != null ? (
                              <p>
                                Variance: <span className="text-[var(--ef-text-secondary)]">{formatVariance(finding)}</span>
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-[18rem]">
                          <p className="font-semibold text-[var(--ef-text-primary)]">
                            {CATEGORY_LABELS[finding.category]}
                          </p>
                          <div className="mt-2 space-y-1 text-xs text-[var(--ef-text-muted)]">
                            <p>
                              Rule: <span className="text-[var(--ef-text-secondary)]">{finding.rule_id}</span>
                            </p>
                            <p>
                              Record: <span className="text-[var(--ef-text-secondary)]">{formatSubject(finding)}</span>
                            </p>
                            {finding.field ? (
                              <p>
                                Field: <span className="text-[var(--ef-text-secondary)]">{finding.field}</span>
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-[14rem]">
                          <span className={`inline-flex rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${approvalClassName(approvalLabel)}`}>
                            {approvalLabel}
                          </span>
                          <div className="mt-2 space-y-1 text-xs text-[var(--ef-text-muted)]">
                            <p>
                              Severity: <span className="text-[var(--ef-text-secondary)]">{SEVERITY_LABELS[finding.severity]}</span>
                            </p>
                            <p>
                              Record state:{' '}
                              <span className={`inline-flex rounded-sm border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] ${statusClassName(finding.status)}`}>
                                {STATUS_LABELS[finding.status]}
                              </span>
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[var(--ef-text-secondary)]">
                        <div className="max-w-[16rem] leading-relaxed">
                          {gateImpact}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-[18rem] space-y-2">
                          <p className="leading-relaxed text-[var(--ef-text-primary)]">
                            {nextAction}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            {finding.decision_eligible ? (
                              <span className="rounded-sm bg-[var(--ef-purple-primary-a10)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-purple-glow)]">
                                Decision eligible
                              </span>
                            ) : null}
                            {finding.action_eligible ? (
                              <span className="rounded-sm bg-[var(--ef-warning-bg)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-warning-soft)]">
                                Action eligible
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelectFinding(finding);
                            }}
                            className="rounded-sm border border-[var(--ef-border-subtle)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-purple-primary)] hover:text-[var(--ef-purple-primary)]"
                          >
                            Open
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
