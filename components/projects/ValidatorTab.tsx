'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ValidatorEvidenceDrawer } from '@/components/validator/ValidatorEvidenceDrawer';
import { ValidatorStatusChip } from '@/components/validator/ValidatorStatusChip';
import {
  resolveCanonicalProjectValidatorWorkspace,
  resolveValidationSummaryFromProjectFacts,
  type CanonicalProjectTransactionDatasetInput,
  type CanonicalProjectTruthDocumentInput,
  type CanonicalProjectTruthState,
  type CanonicalProjectValidatorCoverageItem,
  type CanonicalProjectValidatorRelationshipBlock,
  type CanonicalProjectValidatorStatusItem,
} from '@/lib/projectFacts';
import { supabase } from '@/lib/supabaseClient';
import {
  findingGateImpact,
  findingNextAction,
  findingProblem,
  humanizeTruthToken,
} from '@/lib/truthToAction';
import {
  isBlockingFinding,
  normalizeValidationFinding,
} from '@/lib/validator/findingSemantics';
import type {
  ValidationEvidence,
  ValidationFinding,
  ValidationRun,
  ValidationStatus,
  ValidationSummary,
  ValidationTriggerSource,
} from '@/types/validator';

type ValidatorTabProps = {
  projectId: string;
  documents?: readonly CanonicalProjectTruthDocumentInput[];
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[];
  onProjectRefresh?: (() => void) | (() => Promise<void>);
};

type ValidatorProjectRow = {
  validation_status: ValidationStatus | null;
  validation_summary_json: unknown;
};

type ValidatorRunRow = Pick<
  ValidationRun,
  'id' | 'run_at' | 'completed_at' | 'triggered_by' | 'rules_applied' | 'status'
>;

const EMPTY_SUMMARY: ValidationSummary = {
  status: 'NOT_READY',
  last_run_at: null,
  critical_count: 0,
  warning_count: 0,
  info_count: 0,
  open_count: 0,
  blocked_reasons: [],
  trigger_source: null,
  validator_status: 'NEEDS_REVIEW',
  validator_open_items: [],
  validator_blockers: [],
  contract_invoice_reconciliation: null,
  invoice_transaction_reconciliation: null,
  cross_document_rate_verification: null,
  reconciliation: null,
  exposure: null,
};

const TRIGGER_SOURCE_LABELS: Record<ValidationTriggerSource, string> = {
  document_processed: 'Document Processed',
  fact_override: 'Fact Override',
  review_confirmed: 'Review Confirmed',
  review_flagged: 'Review Flagged',
  review_corrected: 'Review Corrected',
  override_applied: 'Override Applied',
  relationship_change: 'Relationship Change',
  manual: 'Manual',
};

function isValidationStatus(value: unknown): value is ValidationStatus {
  return (
    value === 'NOT_READY'
    || value === 'BLOCKED'
    || value === 'VALIDATED'
    || value === 'FINDINGS_OPEN'
  );
}

function blockedReasonsFromFindings(findings: ValidationFinding[]): string[] {
  return Array.from(
    new Set(
      findings
        .filter((finding) => isBlockingFinding(finding))
        .map((finding) => normalizeValidationFinding(finding).problem)
        .filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        ),
    ),
  );
}

function readNumericDatasetValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function canonicalTransactionSummaryRecord(
  dataset: CanonicalProjectTransactionDatasetInput,
): Record<string, unknown> | null {
  if (!dataset.summary_json || typeof dataset.summary_json !== 'object' || Array.isArray(dataset.summary_json)) {
    return null;
  }

  const summary = dataset.summary_json as Record<string, unknown>;
  const overview = summary.project_operations_overview;
  return overview && typeof overview === 'object' && !Array.isArray(overview)
    ? overview as Record<string, unknown>
    : summary;
}

function hasCanonicalTransactionDatasetData(
  datasets: readonly CanonicalProjectTransactionDatasetInput[],
): boolean {
  return datasets.some((dataset) => {
    if ((dataset.row_count ?? 0) > 0) return true;

    const summary = canonicalTransactionSummaryRecord(dataset);
    const totalTickets = readNumericDatasetValue(summary?.total_tickets);
    const totalInvoicedAmount = readNumericDatasetValue(summary?.total_invoiced_amount);

    return (totalTickets ?? 0) > 0 || (totalInvoicedAmount ?? 0) > 0;
  });
}

function filterFindingsAgainstCanonicalTruth(
  findings: ValidationFinding[],
  transactionDatasets: readonly CanonicalProjectTransactionDatasetInput[],
): ValidationFinding[] {
  if (!hasCanonicalTransactionDatasetData(transactionDatasets)) {
    return findings;
  }

  return findings.filter((finding) => finding.rule_id !== 'SOURCES_NO_TICKET_DATA');
}

function deriveStatusFromFindings(
  fallbackStatus: ValidationStatus,
  findings: ValidationFinding[],
): ValidationStatus {
  const hasOpenCritical = findings.some(
    (finding) => finding.status === 'open' && isBlockingFinding(finding),
  );
  if (hasOpenCritical) return 'BLOCKED';

  const hasOpenFindings = findings.some((finding) => finding.status === 'open');
  if (hasOpenFindings) return 'FINDINGS_OPEN';

  return fallbackStatus === 'NOT_READY' && findings.length === 0
    ? 'NOT_READY'
    : 'VALIDATED';
}

function buildFallbackSummary(
  status: ValidationStatus,
  findings: ValidationFinding[],
): ValidationSummary {
  return {
    status: deriveStatusFromFindings(status, findings),
    last_run_at: null,
    critical_count: findings.filter((finding) => isBlockingFinding(finding)).length,
    warning_count: findings.filter(
      (finding) => normalizeValidationFinding(finding).finding_disposition === 'warning',
    ).length,
    info_count: findings.filter((finding) => normalizeValidationFinding(finding).finding_disposition === 'info').length,
    blocker_count: findings.filter((finding) => isBlockingFinding(finding)).length,
    requires_review_count: findings.filter((finding) => normalizeValidationFinding(finding).finding_disposition === 'requires_review').length,
    open_count: findings.filter((finding) => finding.status === 'open').length,
    blocked_reasons: blockedReasonsFromFindings(findings),
    trigger_source: null,
    validator_status:
      findings.some((finding) => finding.status === 'open' && isBlockingFinding(finding))
        ? 'BLOCKED'
        : findings.some((finding) => finding.status === 'open')
          ? 'NEEDS_REVIEW'
          : 'READY',
    readiness: deriveStatusFromFindings(status, findings),
    validator_open_items: [],
    validator_blockers: [],
    contract_invoice_reconciliation: null,
    invoice_transaction_reconciliation: null,
    cross_document_rate_verification: null,
    reconciliation: null,
    exposure: null,
  };
}

function parseSummary(
  raw: unknown,
  fallbackStatus: ValidationStatus,
  findings: ValidationFinding[],
): ValidationSummary {
  return resolveValidationSummaryFromProjectFacts({
    validationStatus: fallbackStatus,
    validationSummary: raw,
    fallback: buildFallbackSummary(fallbackStatus, findings),
  });
}

function sortFindings(findings: ValidationFinding[]): ValidationFinding[] {
  const categoryRank: Record<ValidationFinding['category'], number> = {
    required_sources: 0,
    identity_consistency: 1,
    financial_integrity: 2,
    ticket_integrity: 3,
  };
  return [...findings].sort((left, right) => {
    const categoryDelta = categoryRank[left.category] - categoryRank[right.category];
    if (categoryDelta !== 0) {
      return categoryDelta;
    }

    const severityDelta =
      (normalizeValidationFinding(left).business_severity === 'critical' ? 0
        : normalizeValidationFinding(left).business_severity === 'high' ? 1
          : normalizeValidationFinding(left).business_severity === 'medium' ? 2 : 3)
      - (normalizeValidationFinding(right).business_severity === 'critical' ? 0
        : normalizeValidationFinding(right).business_severity === 'high' ? 1
          : normalizeValidationFinding(right).business_severity === 'medium' ? 2 : 3);
    if (severityDelta !== 0) {
      return severityDelta;
    }

    const ruleDelta = left.rule_id.localeCompare(right.rule_id, 'en-US');
    if (ruleDelta !== 0) {
      return ruleDelta;
    }

    return left.subject_id.localeCompare(right.subject_id, 'en-US');
  });
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Not available';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Not available';
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function formatTriggerSource(source: ValidationTriggerSource | null): string {
  if (!source) {
    return 'Automatic';
  }

  return TRIGGER_SOURCE_LABELS[source];
}

function statusPanelClassName(status: ValidationStatus): string {
  return status === 'BLOCKED'
    ? 'border-[#EF4444]/35 bg-[#2A1016]'
    : 'border-[#2F3B52]/70 bg-[#111827]';
}

function isRunInProgress(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'running';
}

function truthStateBadgeClass(state: CanonicalProjectTruthState): string {
  switch (state) {
    case 'resolved':
      return 'border-[#22C55E]/30 bg-[#0F2417] text-[#86EFAC]';
    case 'derived':
      return 'border-[#38BDF8]/30 bg-[#10283A] text-[#7DD3FC]';
    case 'conflicted':
    case 'requires_review':
      return 'border-[#F59E0B]/35 bg-[#31230F] text-[#FCD34D]';
    case 'unresolved':
    case 'missing':
    default:
      return 'border-[#EF4444]/35 bg-[#45141B] text-[#FCA5A5]';
  }
}

function truthStateLabel(state: CanonicalProjectTruthState): string {
  switch (state) {
    case 'resolved':
      return 'Resolved';
    case 'derived':
      return 'Derived';
    case 'conflicted':
      return 'Conflicted';
    case 'requires_review':
      return 'Requires Review';
    case 'unresolved':
      return 'Unresolved';
    case 'missing':
    default:
      return 'Missing';
  }
}

function statusItemValueClass(state: CanonicalProjectTruthState): string {
  switch (state) {
    case 'resolved':
      return 'text-[#E5EDF7]';
    case 'derived':
      return 'text-[#BFDBFE]';
    case 'conflicted':
    case 'requires_review':
      return 'text-[#FCD34D]';
    case 'unresolved':
    case 'missing':
    default:
      return 'text-[#FCA5A5]';
  }
}

function mismatchSeverityClass(severity: 'critical' | 'warning' | 'info'): string {
  switch (severity) {
    case 'critical':
      return 'border-[#EF4444]/35 bg-[#45141B] text-[#FCA5A5]';
    case 'warning':
      return 'border-[#F59E0B]/35 bg-[#31230F] text-[#FCD34D]';
    case 'info':
    default:
      return 'border-[#38BDF8]/30 bg-[#10283A] text-[#7DD3FC]';
  }
}

function findingSeverityClass(severity: ValidationFinding['severity']): string {
  switch (severity) {
    case 'critical':
      return 'border-[#EF4444]/35 bg-[#45141B] text-[#FCA5A5]';
    case 'warning':
      return 'border-[#F59E0B]/35 bg-[#31230F] text-[#FCD34D]';
    case 'info':
    default:
      return 'border-[#38BDF8]/30 bg-[#10283A] text-[#7DD3FC]';
  }
}

function findingSourceReference(finding: ValidationFinding): string {
  return [
    finding.rule_id,
    `${finding.subject_type}:${finding.subject_id}`,
    finding.field,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' | ');
}

function findingDescription(finding: ValidationFinding): string {
  return findingProblem(finding);
}

function findingRelationshipLabel(finding: ValidationFinding): string {
  const subject = finding.subject_type.toLowerCase();

  if (finding.category === 'required_sources') {
    return 'Invoice ↔ Support Docs';
  }
  if (
    finding.category === 'ticket_integrity'
    || subject.includes('ticket')
    || subject.includes('transaction')
    || subject.includes('work')
  ) {
    return 'Invoice ↔ Transaction';
  }
  if (
    finding.category === 'identity_consistency'
    || subject.includes('contract')
    || subject.includes('invoice')
  ) {
    return 'Contract ↔ Invoice';
  }

  return `${humanizeTruthToken(finding.subject_type)} ↔ Project Truth`;
}

function isCriticalIssueFinding(finding: ValidationFinding): boolean {
  if (finding.status !== 'open') return false;
  const normalized = normalizeValidationFinding(finding);
  return normalized.approval_gate_effect === 'blocks_approval'
    || normalized.business_severity === 'high';
}

function sortCriticalIssues(findings: ValidationFinding[]): ValidationFinding[] {
  return [...findings].sort((left, right) => {
    const leftBlocked = isBlockingFinding(left) ? 0 : 1;
    const rightBlocked = isBlockingFinding(right) ? 0 : 1;
    if (leftBlocked !== rightBlocked) return leftBlocked - rightBlocked;

    const leftSeverity = normalizeValidationFinding(left).business_severity;
    const rightSeverity = normalizeValidationFinding(right).business_severity;
    const severityDelta =
      (leftSeverity === 'critical' ? 0 : leftSeverity === 'high' ? 1 : leftSeverity === 'medium' ? 2 : 3)
      - (rightSeverity === 'critical' ? 0 : rightSeverity === 'high' ? 1 : rightSeverity === 'medium' ? 2 : 3);
    if (severityDelta !== 0) return severityDelta;

    return left.rule_id.localeCompare(right.rule_id, 'en-US');
  });
}

function StatusItemCard({ item }: { item: CanonicalProjectValidatorStatusItem }) {
  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
          {item.label}
        </p>
        <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${truthStateBadgeClass(item.state)}`}>
          {truthStateLabel(item.state)}
        </span>
      </div>
      <p className={`mt-3 text-lg font-bold tracking-tight ${statusItemValueClass(item.state)}`}>
        {item.value}
      </p>
      <p className="mt-2 text-[11px] text-[#64748B]">
        {item.source_label}
      </p>
    </div>
  );
}

function RelationshipBlockCard({ block }: { block: CanonicalProjectValidatorRelationshipBlock }) {
  return (
    <section className="overflow-hidden rounded-sm border border-[#2F3B52]/70 bg-[#111827]">
      <div className="border-b border-[#2F3B52]/70 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              {block.title}
            </p>
            <p className="mt-2 text-sm text-[#C7D2E3]">
              {block.description}
            </p>
          </div>
          <span className="rounded-sm border border-[#2F3B52] bg-[#0F172A] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7]">
            {block.mismatches.length} inconsistency{block.mismatches.length === 1 ? '' : 'ies'}
          </span>
        </div>
      </div>
      <div className="divide-y divide-[#2F3B52]/70">
        {block.mismatches.map((mismatch) => (
          <div key={`${block.key}:${mismatch.key}`} className="px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-[#E5EDF7]">
                {mismatch.label}
              </h4>
              <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${mismatchSeverityClass(mismatch.severity)}`}>
                {mismatch.severity}
              </span>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
                  Expected
                </p>
                <p className="mt-2 text-[12px] text-[#E5EDF7]">
                  {mismatch.expected_value}
                </p>
              </div>
              <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
                  Actual
                </p>
                <p className="mt-2 text-[12px] text-[#E5EDF7]">
                  {mismatch.actual_value}
                </p>
              </div>
            </div>
            <div className="mt-3 rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
                Impact
              </p>
              <p className="mt-2 text-[12px] text-[#C7D2E3]">
                {mismatch.impact}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CoverageItemCard({ item }: { item: CanonicalProjectValidatorCoverageItem }) {
  return (
    <section className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
          {item.label}
        </p>
        <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${truthStateBadgeClass(item.state)}`}>
          {truthStateLabel(item.state)}
        </span>
      </div>
      <p className={`mt-3 text-lg font-bold ${statusItemValueClass(item.state)}`}>
        {item.value}
      </p>
      <p className="mt-3 text-sm leading-6 text-[#C7D2E3]">
        {item.detail}
      </p>
      <div className="mt-4 rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
          Impact
        </p>
        <p className="mt-2 text-[12px] text-[#C7D2E3]">
          {item.impact}
        </p>
      </div>
      <p className="mt-3 text-[11px] text-[#64748B]">
        {item.source_label}
      </p>
    </section>
  );
}

function CriticalIssueCard({
  finding,
  selected,
  onSelect,
}: {
  finding: ValidationFinding;
  selected: boolean;
  onSelect: (finding: ValidationFinding) => void;
}) {
  return (
    <div
      className={`rounded-sm border p-4 transition-colors ${
        selected
          ? 'border-[#3B82F6]/45 bg-[#15233A]'
          : 'border-[#2F3B52]/70 bg-[#111827] hover:border-[#3B82F6]/30'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${findingSeverityClass(finding.severity)}`}>
              {finding.severity}
            </span>
            <span className="rounded-sm border border-[#2F3B52] bg-[#0F172A] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[#C7D2E3]">
              {findingRelationshipLabel(finding)}
            </span>
          </div>
          <h3 className="text-sm font-semibold text-[#E5EDF7]">
            {findingDescription(finding)}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => onSelect(finding)}
          className="rounded-sm border border-[#3B82F6]/35 bg-[#15233A] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#BFDBFE] transition-colors hover:border-[#60A5FA] hover:text-white"
        >
          Inspect Evidence
        </button>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Expected
          </p>
          <p className="mt-2 text-[12px] text-[#E5EDF7]">
            {finding.expected ?? 'Not provided'}
          </p>
        </div>
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Actual
          </p>
          <p className="mt-2 text-[12px] text-[#E5EDF7]">
            {finding.actual ?? 'Not provided'}
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Impact
          </p>
          <p className="mt-2 text-[12px] text-[#C7D2E3]">
            {findingGateImpact(finding)}
          </p>
        </div>
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Resolution Path
          </p>
          <p className="mt-2 text-[12px] text-[#C7D2E3]">
            {findingNextAction(finding)}
          </p>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-[#64748B]">
        {findingSourceReference(finding)}
      </p>
    </div>
  );
}

export function ValidatorTab({
  projectId,
  documents = [],
  transactionDatasets = [],
  onProjectRefresh,
}: ValidatorTabProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ValidationSummary>(EMPTY_SUMMARY);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [latestRun, setLatestRun] = useState<ValidatorRunRow | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [evidenceByFindingId, setEvidenceByFindingId] = useState<
    Record<string, ValidationEvidence[]>
  >({});
  const [evidenceLoadingId, setEvidenceLoadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revalidateLoading, setRevalidateLoading] = useState(false);

  const loadValidatorState = useCallback(
    async (showLoading = true) => {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);

      const [projectResult, findingsResult, runResult] = await Promise.all([
        supabase
          .from('projects')
          .select('validation_status, validation_summary_json')
          .eq('id', projectId)
          .maybeSingle(),
        supabase
          .from('project_validation_findings')
          .select('*')
          .eq('project_id', projectId)
          .eq('status', 'open'),
        supabase
          .from('project_validation_runs')
          .select('id, run_at, completed_at, triggered_by, rules_applied, status')
          .eq('project_id', projectId)
          .order('run_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (projectResult.error) {
        throw new Error(projectResult.error.message);
      }
      if (findingsResult.error) {
        throw new Error(findingsResult.error.message);
      }
      if (runResult.error) {
        throw new Error(runResult.error.message);
      }

      const validatorProject = (projectResult.data ?? {
        validation_status: 'NOT_READY',
        validation_summary_json: null,
      }) as ValidatorProjectRow;
      const loadedFindings = sortFindings(
        filterFindingsAgainstCanonicalTruth(
          (findingsResult.data ?? []) as ValidationFinding[],
          transactionDatasets,
        ),
      );
      const status = isValidationStatus(validatorProject.validation_status)
        ? validatorProject.validation_status
        : 'NOT_READY';
      const nextSummary = parseSummary(
        validatorProject.validation_summary_json,
        status,
        loadedFindings,
      );
      const runtimeSummary = buildFallbackSummary(status, loadedFindings);
      const prioritizedIssueId = sortCriticalIssues(
        loadedFindings.filter(isCriticalIssueFinding),
      )[0]?.id ?? null;

      setSummary({
        ...nextSummary,
        status: runtimeSummary.status,
        critical_count: runtimeSummary.critical_count,
        warning_count: runtimeSummary.warning_count,
        info_count: runtimeSummary.info_count,
        open_count: runtimeSummary.open_count,
        blocked_reasons: runtimeSummary.blocked_reasons,
        validator_status: runtimeSummary.validator_status,
      });
      setFindings(loadedFindings);
      setLatestRun((runResult.data ?? null) as ValidatorRunRow | null);
      setSelectedFindingId((current) => {
        if (current && loadedFindings.some((finding) => finding.id === current)) {
          return current;
        }

        return prioritizedIssueId;
      });
      setLoading(false);
    },
    [projectId, transactionDatasets],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        await loadValidatorState(true);
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Failed to load validator data.',
        );
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [loadValidatorState]);

  const validationInProgress = isRunInProgress(latestRun?.status);
  const allowManualRevalidate = !validationInProgress && !revalidateLoading;

  const triggerManualRevalidate = useCallback(async () => {
    if (!allowManualRevalidate) return;
    setRevalidateLoading(true);
    setNotice(null);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/revalidate`, { method: 'POST' });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; result?: unknown } | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? 'Failed to trigger revalidation.');
      }

      setNotice('Revalidation requested. Validator decisions will refresh when the run completes.');
      await loadValidatorState(false);
      await onProjectRefresh?.();
    } catch (revalidateError) {
      setError(revalidateError instanceof Error ? revalidateError.message : 'Failed to trigger revalidation.');
    } finally {
      setRevalidateLoading(false);
    }
  }, [allowManualRevalidate, loadValidatorState, onProjectRefresh, projectId]);

  useEffect(() => {
    if (!validationInProgress) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void loadValidatorState(false).catch((pollError) => {
        if (cancelled) {
          return;
        }

        setError(
          pollError instanceof Error
            ? pollError.message
            : 'Failed to refresh validator data.',
        );
      });
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loadValidatorState, validationInProgress]);

  useEffect(() => {
    if (!selectedFindingId || evidenceByFindingId[selectedFindingId]) {
      return;
    }

    let cancelled = false;

    const loadEvidence = async () => {
      setEvidenceLoadingId(selectedFindingId);

      try {
        const { data, error: evidenceError } = await supabase
          .from('project_validation_evidence')
          .select('*')
          .eq('finding_id', selectedFindingId);

        if (cancelled) {
          return;
        }
        if (evidenceError) {
          setNotice('Evidence could not be loaded for the selected issue.');
          setEvidenceLoadingId(null);
          return;
        }

        setEvidenceByFindingId((current) => ({
          ...current,
          [selectedFindingId]: (data ?? []) as ValidationEvidence[],
        }));
        setEvidenceLoadingId(null);
      } catch {
        if (cancelled) {
          return;
        }

        setNotice('Evidence could not be loaded for the selected issue.');
        setEvidenceLoadingId(null);
      }
    };

    void loadEvidence();

    return () => {
      cancelled = true;
    };
  }, [evidenceByFindingId, selectedFindingId]);

  const status = summary.status;
  const selectedFinding = useMemo(
    () => findings.find((finding) => finding.id === selectedFindingId) ?? null,
    [findings, selectedFindingId],
  );
  const selectedEvidence = selectedFindingId
    ? evidenceByFindingId[selectedFindingId] ?? []
    : [];
  const lastRunAt = summary.last_run_at ?? latestRun?.completed_at ?? latestRun?.run_at ?? null;
  const triggerSource = summary.trigger_source ?? latestRun?.triggered_by ?? null;
  const rulesAppliedCount = Array.isArray(latestRun?.rules_applied)
    ? latestRun.rules_applied.length
    : 0;
  const criticalIssues = useMemo(
    () => sortCriticalIssues(findings.filter(isCriticalIssueFinding)),
    [findings],
  );
  const validatorWorkspace = useMemo(
    () => resolveCanonicalProjectValidatorWorkspace({
      validationStatus: summary.status,
      validationSummary: summary,
      documents,
      transactionDatasets,
    }),
    [documents, summary, transactionDatasets],
  );

  return (
    <div className="space-y-6">
      <section className={`rounded-sm border p-5 ${statusPanelClassName(status)}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
              Approval Gate
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-[#E5EDF7]">
              Cross-document truth verification
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-[#C7D2E3]">
              Validator checks that contract, invoice, transaction, and support truths agree before approval can clear. Use it to find inconsistencies, understand gate impact, and jump into document-level correction.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <ValidatorStatusChip
              status={status}
              criticalCount={summary.critical_count}
              warningCount={summary.warning_count + (summary.requires_review_count ?? 0)}
            />
            <button
              type="button"
              onClick={triggerManualRevalidate}
              disabled={!allowManualRevalidate}
              className={`rounded-sm border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors ${
                allowManualRevalidate
                  ? 'border-[#3B82F6]/35 bg-[#15233A] text-[#BFDBFE] hover:border-[#60A5FA] hover:text-white'
                  : 'cursor-not-allowed border-[#2F3B52]/70 bg-[#0B1020] text-[#5A7090]'
              }`}
            >
              {revalidateLoading ? 'Revalidating…' : 'Revalidate Project'}
            </button>
            {validationInProgress ? (
              <div className="rounded-sm border border-[#38BDF8]/30 bg-[#10283A] px-3 py-2 text-xs text-[#7DD3FC]">
                Validation in progress...
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {validatorWorkspace.status_items.map((item) => (
            <StatusItemCard key={item.key} item={item} />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{formatTimestamp(lastRunAt)}</span> last run
          </div>
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
            <span className="font-bold text-[#E5EDF7]">{formatTriggerSource(triggerSource)}</span> trigger
          </div>
          {rulesAppliedCount > 0 ? (
            <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-xs text-[#C7D2E3]">
              <span className="font-bold text-[#E5EDF7]">{rulesAppliedCount}</span> rules applied
            </div>
          ) : null}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
            Cross-Document Truth
          </p>
          <h3 className="mt-2 text-lg font-bold text-[#E5EDF7]">
            Inconsistencies across project sources
          </h3>
          <p className="mt-2 text-sm text-[#94A3B8]">
            Each block compares canonical truths between source families and only shows disagreements that still need operator attention.
          </p>
        </div>

        {validatorWorkspace.relationship_blocks.length === 0 ? (
          <div className="rounded-sm border border-[#22C55E]/30 bg-[#0F2417] px-4 py-5 text-sm text-[#C7D2E3]">
            No active cross-document mismatches are currently resolved into the canonical validator facts.
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-3">
            {validatorWorkspace.relationship_blocks.map((block) => (
              <RelationshipBlockCard key={block.key} block={block} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
            Coverage &amp; Completeness
          </p>
          <h3 className="mt-2 text-lg font-bold text-[#E5EDF7]">
            Missing support, incomplete evidence, and unresolved truth
          </h3>
          <p className="mt-2 text-sm text-[#94A3B8]">
            Coverage tracks what is still missing from the canonical project truth before approval can fully settle.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          {validatorWorkspace.coverage_items.map((item) => (
            <CoverageItemCard key={item.key} item={item} />
          ))}
        </div>
      </section>

      {notice ? (
        <div className="rounded-sm border border-[#3B82F6]/30 bg-[#15233A] px-4 py-3 text-sm text-[#BFDBFE]">
          {notice}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-sm border border-[#EF4444]/30 bg-[#45141B] px-4 py-3 text-sm text-[#FCA5A5]">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] px-4 py-5 text-sm text-[#94A3B8]">
          Loading validator findings...
        </div>
      ) : criticalIssues.length === 0 ? (
        <section className="rounded-sm border border-[#22C55E]/30 bg-[#0F2417] p-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#86EFAC]">
            Critical Issues
          </p>
          <h3 className="mt-2 text-xl font-bold text-[#E5EDF7]">
            No blocker-level inconsistencies are open.
          </h3>
          <p className="mt-2 text-sm text-[#C7D2E3]">
            Canonical validator findings are not currently showing any open blockers or high-risk cross-document mismatches.
          </p>
        </section>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.95fr)]">
          <div className="space-y-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
                Critical Issues
              </p>
              <h3 className="mt-2 text-lg font-bold text-[#E5EDF7]">
                Blockers and high-risk mismatches
              </h3>
              <p className="mt-2 text-sm text-[#94A3B8]">
                Select an issue to inspect the evidence, open the source document, and resolve the truth through review or override.
              </p>
            </div>

            <div className="space-y-3">
              {criticalIssues.map((finding) => (
                <CriticalIssueCard
                  key={finding.id}
                  finding={finding}
                  selected={finding.id === selectedFindingId}
                  onSelect={(nextFinding) => setSelectedFindingId(nextFinding.id)}
                />
              ))}
            </div>
          </div>

          <ValidatorEvidenceDrawer
            finding={selectedFinding}
            evidence={selectedEvidence}
            loading={evidenceLoadingId === selectedFindingId}
            onClose={() => setSelectedFindingId(null)}
            onFindingActionComplete={() => loadValidatorState(false)}
          />
        </div>
      )}
    </div>
  );
}
