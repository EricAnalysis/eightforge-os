'use client';

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

function severityClassName(severity: ValidationSeverity): string {
  switch (severity) {
    case 'critical':
      return 'border-[#EF4444]/40 bg-[#45141B] text-[#FCA5A5]';
    case 'warning':
      return 'border-[#F59E0B]/35 bg-[#31230F] text-[#FCD34D]';
    case 'info':
    default:
      return 'border-[#38BDF8]/30 bg-[#10283A] text-[#7DD3FC]';
  }
}

function statusClassName(status: FindingStatus): string {
  switch (status) {
    case 'resolved':
      return 'border-[#22C55E]/30 bg-[#0F2417] text-[#86EFAC]';
    case 'dismissed':
      return 'border-[#2F3B52] bg-[#182132] text-[#94A3B8]';
    case 'muted':
      return 'border-[#A855F7]/30 bg-[#261339] text-[#D8B4FE]';
    case 'open':
    default:
      return 'border-[#3B82F6]/30 bg-[#15233A] text-[#93C5FD]';
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

function filterOptionClassName(): string {
  return 'rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-xs text-[#E5EDF7] outline-none transition-colors focus:border-[#3B82F6]';
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
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
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
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
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
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Status
          </span>
          <select
            value={filters.status}
            onChange={(event) => updateFilters('status', event.target.value as ValidatorFindingFilters['status'])}
            className={filterOptionClassName()}
          >
            <option value="all">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-hidden rounded-sm border border-[#2F3B52]/70 bg-[#111827]">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-[#2F3B52]/70 text-left">
            <thead className="bg-[#0F172A]">
              <tr className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Rule</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Field</th>
                <th className="px-4 py-3">Expected</th>
                <th className="px-4 py-3">Actual</th>
                <th className="px-4 py-3">Variance</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2F3B52]/50 text-sm text-[#E5EDF7]">
              {filteredFindings.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-sm text-[#94A3B8]">
                    {findings.length === 0
                      ? 'No validator findings are currently open for this project.'
                      : 'No findings match the active filters.'}
                  </td>
                </tr>
              ) : (
                filteredFindings.map((finding) => {
                  const isSelected = finding.id === selectedFindingId;

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
                          ? 'bg-[#16233A]'
                          : 'hover:bg-[#182132]'
                      }`}
                    >
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${severityClassName(finding.severity)}`}>
                          {SEVERITY_LABELS[finding.severity]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[#C7D2E3]">
                        {CATEGORY_LABELS[finding.category]}
                      </td>
                      <td className="px-4 py-3 font-semibold">{finding.rule_id}</td>
                      <td className="px-4 py-3 text-[#C7D2E3]">{formatSubject(finding)}</td>
                      <td className="px-4 py-3 text-[#C7D2E3]">{finding.field ?? 'N/A'}</td>
                      <td className="max-w-[18rem] px-4 py-3 text-[#C7D2E3]">
                        <div className="truncate">{finding.expected ?? 'N/A'}</div>
                      </td>
                      <td className="max-w-[18rem] px-4 py-3 text-[#C7D2E3]">
                        <div className="truncate">{finding.actual ?? 'N/A'}</div>
                      </td>
                      <td className="px-4 py-3 text-[#C7D2E3]">{formatVariance(finding)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${statusClassName(finding.status)}`}>
                          {STATUS_LABELS[finding.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {finding.decision_eligible ? (
                            <span className="rounded-sm bg-[#15233A] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#93C5FD]">
                              Decision
                            </span>
                          ) : null}
                          {finding.action_eligible ? (
                            <span className="rounded-sm bg-[#31230F] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#FCD34D]">
                              Action
                            </span>
                          ) : null}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelectFinding(finding);
                            }}
                            className="rounded-sm border border-[#2F3B52] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:border-[#3B82F6] hover:text-[#3B82F6]"
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
