'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ForgeMetricCard } from '@/components/forge/ForgeMetricCard';
import { ForgeSectionCard } from '@/components/forge/ForgeSectionCard';
import { ValidatorEvidenceDrawer } from '@/components/validator/ValidatorEvidenceDrawer';
import {
  executionItemProjectHref,
  type ProjectExecutionItemRow,
} from '@/lib/executionItems';
import {
  resolveCanonicalProjectValidatorWorkspace,
  resolveValidationSummaryFromProjectFacts,
  type CanonicalProjectTransactionDatasetInput,
  type CanonicalProjectTruthDocumentInput,
  type CanonicalProjectTruthState,
  type CanonicalProjectValidatorCoverageItem,
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
  validationEvidence?: readonly ValidationEvidence[];
  executionItems?: readonly ProjectExecutionItemRow[];
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

type GateTone = 'critical' | 'warning' | 'success';

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

const COVERAGE_ITEM_CONFIG: Record<
  string,
  {
    label: string;
    order: number;
  }
> = {
  missing_supporting_data: {
    label: 'Support Coverage',
    order: 0,
  },
  incomplete_evidence: {
    label: 'Evidence Completeness',
    order: 1,
  },
  unresolved_required_fields: {
    label: 'Required Fields / Missing Data',
    order: 2,
  },
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
    info_count: findings.filter(
      (finding) => normalizeValidationFinding(finding).finding_disposition === 'info',
    ).length,
    blocker_count: findings.filter((finding) => isBlockingFinding(finding)).length,
    requires_review_count: findings.filter(
      (finding) => normalizeValidationFinding(finding).finding_disposition === 'requires_review',
    ).length,
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

    const leftSeverity = normalizeValidationFinding(left).business_severity;
    const rightSeverity = normalizeValidationFinding(right).business_severity;
    const severityDelta =
      (leftSeverity === 'critical' ? 0 : leftSeverity === 'high' ? 1 : leftSeverity === 'medium' ? 2 : 3)
      - (rightSeverity === 'critical' ? 0 : rightSeverity === 'high' ? 1 : rightSeverity === 'medium' ? 2 : 3);
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

function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Not available';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

function isRunInProgress(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'running';
}

function truthStateBadgeClass(state: CanonicalProjectTruthState): string {
  switch (state) {
    case 'resolved':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'derived':
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
    case 'conflicted':
    case 'requires_review':
      return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'unresolved':
    case 'missing':
    default:
      return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]';
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
      return 'text-[var(--ef-text-primary)]';
    case 'derived':
      return 'text-[var(--ef-text-primary)]';
    case 'conflicted':
    case 'requires_review':
      return 'text-[var(--ef-warning-soft)]';
    case 'unresolved':
    case 'missing':
    default:
      return 'text-[var(--ef-critical-soft)]';
  }
}

function findingSeverityClass(severity: ValidationFinding['severity']): string {
  switch (severity) {
    case 'critical':
      return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]';
    case 'warning':
      return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'info':
    default:
      return 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)] text-[var(--ef-text-secondary)]';
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

type InvoiceLineFindingContext = {
  invoiceNumber: string | null;
  invoiceDocumentTitle: string | null;
  rateCode: string | null;
  description: string | null;
  quantity: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
  rawIdentity: string;
  sourceLabel: string;
};

function evidenceFieldValue(
  evidence: readonly ValidationEvidence[],
  fieldNames: readonly string[],
): string | null {
  for (const fieldName of fieldNames) {
    const match = evidence.find((entry) => entry.field_name === fieldName);
    if (typeof match?.field_value === 'string' && match.field_value.trim().length > 0) {
      return match.field_value.trim();
    }
  }
  return null;
}

function parseEvidenceNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatContextNumber(value: string | null): string | null {
  const parsed = parseEvidenceNumber(value);
  if (parsed == null) return value;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(parsed);
}

function formatContextCurrency(value: string | null): string | null {
  const parsed = parseEvidenceNumber(value);
  if (parsed == null) return value;
  return formatCurrency(parsed);
}

function invoiceLineFindingContext(
  finding: ValidationFinding,
  evidence: readonly ValidationEvidence[],
  documentTitleById: Map<string, string>,
): InvoiceLineFindingContext | null {
  if (finding.subject_type !== 'invoice_line') return null;

  const invoiceEvidence = evidence.find((entry) => entry.evidence_type === 'invoice_line');
  const invoiceNumber = evidenceFieldValue(evidence, ['invoice_number', 'invoice_no', 'number']);
  const invoiceDocumentTitle = invoiceEvidence?.source_document_id
    ? documentTitleById.get(invoiceEvidence.source_document_id) ?? null
    : null;
  const rateCode = evidenceFieldValue(evidence, ['rate_code', 'line_code', 'item_code']);
  const rawIdentity = findingSourceReference(finding);
  const sourceLabel = [
    invoiceNumber ? `Invoice ${invoiceNumber}` : 'Invoice line',
    rateCode ? `Line ${rateCode}` : null,
    finding.rule_id === 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS'
    || finding.rule_id === 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT'
      ? 'Contract rate match'
      : null,
  ].filter(Boolean).join(' · ');

  return {
    invoiceNumber,
    invoiceDocumentTitle,
    rateCode,
    description: evidenceFieldValue(evidence, ['description', 'line_description', 'rate_description']),
    quantity: formatContextNumber(evidenceFieldValue(evidence, ['quantity', 'qty', 'billed_quantity'])),
    unitPrice: formatContextCurrency(evidenceFieldValue(evidence, ['unit_price', 'billed_rate', 'invoice_rate', 'rate'])),
    lineTotal: formatContextCurrency(evidenceFieldValue(evidence, ['line_total', 'extended_amount', 'extended_cost', 'line_amount'])),
    rawIdentity,
    sourceLabel,
  };
}

function findingDescription(finding: ValidationFinding): string {
  return findingProblem(finding);
}

function findingCategoryLabel(finding: ValidationFinding): string {
  const subject = finding.subject_type.toLowerCase();
  const sourceFamily = finding.source_family?.toLowerCase() ?? '';

  if (sourceFamily === 'contract' || subject.includes('contract') || finding.rule_id.includes('CONTRACT')) {
    return 'Contract';
  }
  if (sourceFamily === 'invoice' || subject.includes('invoice')) {
    return 'Invoice';
  }
  if (
    sourceFamily === 'transaction'
    || subject.includes('ticket')
    || subject.includes('transaction')
    || subject.includes('work')
  ) {
    return 'Transaction';
  }
  if (sourceFamily === 'support' || finding.category === 'required_sources') {
    return 'Support';
  }
  if (finding.category === 'financial_integrity') {
    return 'Financial';
  }

  return humanizeTruthToken(finding.category);
}

function approvalGateLabel(status: ValidationStatus): string {
  switch (status) {
    case 'BLOCKED':
      return 'Blocked';
    case 'VALIDATED':
      return 'Clear';
    case 'FINDINGS_OPEN':
    case 'NOT_READY':
    default:
      return 'Requires Verification';
  }
}

function approvalGateTone(status: ValidationStatus): GateTone {
  switch (status) {
    case 'BLOCKED':
      return 'critical';
    case 'VALIDATED':
      return 'success';
    case 'FINDINGS_OPEN':
    case 'NOT_READY':
    default:
      return 'warning';
  }
}

function metricToneForGate(tone: GateTone): 'critical' | 'warning' | 'success' {
  switch (tone) {
    case 'critical':
      return 'critical';
    case 'success':
      return 'success';
    case 'warning':
    default:
      return 'warning';
  }
}

function approvalGatePanelClassName(tone: GateTone): string {
  switch (tone) {
    case 'critical':
      return 'border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)]';
    case 'success':
      return 'border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)]';
    case 'warning':
    default:
      return 'border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)]';
  }
}

function approvalGateLabelClassName(tone: GateTone): string {
  switch (tone) {
    case 'critical':
      return 'text-[var(--ef-critical-soft)]';
    case 'success':
      return 'text-[var(--ef-success-soft)]';
    case 'warning':
    default:
      return 'text-[var(--ef-warning-soft)]';
  }
}

function approvalGateExplanation(params: {
  status: ValidationStatus;
  summary: ValidationSummary;
  criticalCount: number;
}): string {
  const blockedReason = params.summary.blocked_reasons.find(
    (reason) => typeof reason === 'string' && reason.trim().length > 0,
  );
  if (blockedReason) {
    return blockedReason;
  }

  switch (params.status) {
    case 'BLOCKED':
      return params.criticalCount === 1
        ? 'One approval blocker still prevents this project from moving forward.'
        : `${params.criticalCount} approval blockers still prevent this project from moving forward.`;
    case 'VALIDATED':
      return 'Validator is not showing any active blocker-level mismatches right now.';
    case 'FINDINGS_OPEN':
      return 'Approval is waiting on operator review before the project can move forward.';
    case 'NOT_READY':
    default:
      return 'Validation has not produced a clear approval signal yet.';
  }
}

function approvalGateAmount(summary: ValidationSummary): number | null {
  return (
    summary.exposure?.total_billed_amount
    ?? summary.total_billed
    ?? summary.exposure?.invoices.find(
      (invoice) => typeof invoice.billed_amount === 'number' && Number.isFinite(invoice.billed_amount),
    )?.billed_amount
    ?? null
  );
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

function ReadinessGapCard(props: {
  item: CanonicalProjectValidatorCoverageItem;
  label: string;
}) {
  const { item, label } = props;

  return (
    <ForgeSectionCard as="section" surface="secondary" radius="sm" padding="md">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
          {label}
        </p>
        <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${truthStateBadgeClass(item.state)}`}>
          {truthStateLabel(item.state)}
        </span>
      </div>
      <p className={`mt-3 text-base font-semibold tracking-tight ${statusItemValueClass(item.state)}`}>
        {item.value}
      </p>
      <p className="mt-2 text-sm leading-6 text-[var(--ef-text-secondary)]">
        {item.impact}
      </p>
    </ForgeSectionCard>
  );
}

function CriticalIssueCard(props: {
  projectId: string;
  finding: ValidationFinding;
  evidence: readonly ValidationEvidence[];
  documentTitleById: Map<string, string>;
  executionHref: string;
  selected: boolean;
  onSelect: (finding: ValidationFinding) => void;
}) {
  const { projectId, finding, evidence, documentTitleById, executionHref, selected, onSelect } = props;
  const normalizedFinding = normalizeValidationFinding(finding);
  const impact = findingGateImpact(finding);
  const nextAction = findingNextAction(finding);
  const invoiceLineContext = invoiceLineFindingContext(finding, evidence, documentTitleById);

  return (
    <article
      className={`rounded-sm border p-5 transition-colors ${
        selected
          ? 'border-[var(--ef-purple-primary-a45)] bg-[var(--ef-surface-elevated)]'
          : 'border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] hover:border-[var(--ef-purple-primary-a30)]'
      }`}
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${findingSeverityClass(finding.severity)}`}>
              {finding.severity}
            </span>
            <span className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)]">
              {findingCategoryLabel(finding)}
            </span>
            {finding.affected_amount != null ? (
              <span className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                At Risk {formatCurrency(finding.affected_amount)}
              </span>
            ) : null}
          </div>

          <h3 className="mt-3 text-base font-semibold tracking-tight text-[var(--ef-text-primary)]">
            {findingDescription(finding)}
          </h3>
          <p className="mt-2 text-sm leading-6 text-[var(--ef-text-secondary)]">
            {normalizedFinding.problem ?? 'Validator found a blocking mismatch that needs operator review.'}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {finding.linked_decision_id ? (
            <Link
              href={`/platform/projects/${projectId}?activeTab=decisions&selectedIssue=${finding.id}#project-decisions`}
              className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-purple-glow)] transition-colors hover:border-[var(--ef-purple-primary-a60)]"
            >
              Open Decision Frame
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => onSelect(finding)}
            className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-purple-primary-a60)]"
          >
            Inspect Evidence
          </button>
          <Link
            href={executionHref}
            className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white"
          >
            Open Execution
          </Link>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Expected
          </p>
          <p className="mt-2 text-[13px] leading-6 text-[var(--ef-text-primary)]">
            {normalizedFinding.expected ?? 'Not provided'}
          </p>
        </div>
        <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Actual
          </p>
          <p className="mt-2 text-[13px] leading-6 text-[var(--ef-text-primary)]">
            {normalizedFinding.actual ?? 'Not provided'}
          </p>
        </div>
      </div>

      {invoiceLineContext ? (
        <div className="mt-3 rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Invoice Line Context
          </p>
          <div className="mt-2 grid gap-2 text-[12px] leading-5 text-[var(--ef-text-secondary)] sm:grid-cols-2">
            {invoiceLineContext.invoiceNumber ? <p>Invoice: {invoiceLineContext.invoiceNumber}</p> : null}
            {invoiceLineContext.invoiceDocumentTitle ? <p>Document: {invoiceLineContext.invoiceDocumentTitle}</p> : null}
            {invoiceLineContext.rateCode || invoiceLineContext.description ? (
              <p className="sm:col-span-2">
                Line: {[invoiceLineContext.rateCode, invoiceLineContext.description].filter(Boolean).join(' - ')}
              </p>
            ) : null}
            {invoiceLineContext.quantity ? <p>Quantity: {invoiceLineContext.quantity}</p> : null}
            {invoiceLineContext.unitPrice ? <p>Invoice unit price: {invoiceLineContext.unitPrice}</p> : null}
            {invoiceLineContext.lineTotal ? <p>Line total: {invoiceLineContext.lineTotal}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Impact
          </p>
          <p className="mt-2 text-[12px] leading-6 text-[var(--ef-text-secondary)]">
            {impact}
          </p>
        </div>
        <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Next Action
          </p>
          <p className="mt-2 text-[12px] leading-6 text-[var(--ef-text-secondary)]">
            {nextAction}
          </p>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-[var(--ef-text-faint)]">
        {invoiceLineContext?.sourceLabel ?? findingSourceReference(finding)}
        {invoiceLineContext ? (
          <span className="block pt-1 text-[10px]">Raw key: {invoiceLineContext.rawIdentity}</span>
        ) : null}
      </p>
    </article>
  );
}

export function ValidatorTab({
  projectId,
  documents = [],
  transactionDatasets = [],
  validationEvidence = [],
  executionItems = [],
  onProjectRefresh,
}: ValidatorTabProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ValidationSummary>(EMPTY_SUMMARY);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [latestRun, setLatestRun] = useState<ValidatorRunRow | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [evidenceByFindingId, setEvidenceByFindingId] = useState<Record<string, ValidationEvidence[]>>(() =>
    validationEvidence.reduce<Record<string, ValidationEvidence[]>>((accumulator, evidence) => {
      const current = accumulator[evidence.finding_id] ?? [];
      current.push(evidence);
      accumulator[evidence.finding_id] = current;
      return accumulator;
    }, {}),
  );
  const [evidenceLoadingId, setEvidenceLoadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revalidateLoading, setRevalidateLoading] = useState(false);

  useEffect(() => {
    setEvidenceByFindingId(
      validationEvidence.reduce<Record<string, ValidationEvidence[]>>((accumulator, evidence) => {
        const current = accumulator[evidence.finding_id] ?? [];
        current.push(evidence);
        accumulator[evidence.finding_id] = current;
        return accumulator;
      }, {}),
    );
  }, [validationEvidence]);

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
      const loadedFindingIds = loadedFindings.map((finding) => finding.id);
      const evidenceByLoadedFindingId: Record<string, ValidationEvidence[]> = {};
      if (loadedFindingIds.length > 0) {
        const evidenceResult = await supabase
          .from('project_validation_evidence')
          .select('*')
          .in('finding_id', loadedFindingIds);

        if (!evidenceResult.error) {
          for (const row of (evidenceResult.data ?? []) as ValidationEvidence[]) {
            const current = evidenceByLoadedFindingId[row.finding_id] ?? [];
            current.push(row);
            evidenceByLoadedFindingId[row.finding_id] = current;
          }
        }
      }

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
      setEvidenceByFindingId((current) => ({
        ...current,
        ...evidenceByLoadedFindingId,
      }));
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
  const documentTitleById = useMemo(() => {
    const entries = new Map<string, string>();
    for (const document of documents) {
      entries.set(document.id, document.title?.trim() || document.name);
    }
    return entries;
  }, [documents]);
  const executionItemIdByFindingId = useMemo(() => {
    const entries = new Map<string, string>();
    for (const item of executionItems) {
      if (item.source_type === 'validator_finding') {
        entries.set(item.source_id, item.id);
      }
    }
    return entries;
  }, [executionItems]);
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
  const readinessGaps = useMemo(
    () => [...validatorWorkspace.coverage_items]
      .filter((item) => COVERAGE_ITEM_CONFIG[item.key] != null)
      .sort((left, right) => COVERAGE_ITEM_CONFIG[left.key]!.order - COVERAGE_ITEM_CONFIG[right.key]!.order)
      .slice(0, 3),
    [validatorWorkspace.coverage_items],
  );
  const gateTone = approvalGateTone(status);
  const gateAmount = approvalGateAmount(summary);
  const gateExplanation = approvalGateExplanation({
    status,
    summary,
    criticalCount: criticalIssues.length,
  });

  return (
    <div className="space-y-6">
      <section className={`rounded-sm border p-5 ${approvalGatePanelClassName(gateTone)}`}>
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
              Approval Gate
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <h2 className={`text-3xl font-bold tracking-tight ${approvalGateLabelClassName(gateTone)}`}>
                {approvalGateLabel(status)}
              </h2>
              {validationInProgress ? (
                <span className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ef-text-primary)]">
                  Validation in progress
                </span>
              ) : null}
            </div>
            <p className="mt-3 text-sm leading-6 text-[var(--ef-text-secondary)]">
              {gateExplanation}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="#approval-blockers"
              className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-background-secondary)] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-purple-primary-a60)]"
            >
              Review Blockers
            </Link>
            <Link
              href="#project-decisions"
              className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:border-[var(--ef-text-primary)] hover:text-white"
            >
              View Execution
            </Link>
            <button
              type="button"
              onClick={triggerManualRevalidate}
              disabled={!allowManualRevalidate}
              className={`rounded-sm border px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors ${
                allowManualRevalidate
                  ? 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-secondary)] hover:border-[var(--ef-text-primary)] hover:text-white'
                  : 'cursor-not-allowed border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] text-[var(--ef-text-soft)]'
              }`}
            >
              {revalidateLoading ? 'Revalidating...' : 'Revalidate Project'}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <ForgeMetricCard
            label="Total Amount"
            value={formatCurrency(gateAmount)}
            supporting="Invoice billed amount currently in the approval path."
            tone={metricToneForGate(gateTone)}
            radius="sm"
            valueSize="lg"
            labelWeight="bold"
          />
          <ForgeMetricCard
            label="Critical Mismatches"
            value={String(criticalIssues.length)}
            supporting={
              criticalIssues.length === 1
                ? 'One blocker is still open.'
                : `${criticalIssues.length} blockers are still open.`
            }
            tone={metricToneForGate(criticalIssues.length > 0 ? 'critical' : gateTone)}
            radius="sm"
            valueSize="lg"
            labelWeight="bold"
          />
          <ForgeMetricCard
            label="Approval State"
            value={approvalGateLabel(status)}
            supporting={
              status === 'VALIDATED'
                ? 'Validator currently clears the project for approval.'
                : status === 'BLOCKED'
                  ? 'Approval cannot move forward until blockers are resolved.'
                  : 'Operator review is still required before approval can clear.'
            }
            tone={metricToneForGate(gateTone)}
            radius="sm"
            valueSize="lg"
            labelWeight="bold"
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs text-[var(--ef-text-secondary)]">
            <span className="font-bold text-[var(--ef-text-primary)]">{formatTimestamp(lastRunAt)}</span> last run
          </div>
          <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs text-[var(--ef-text-secondary)]">
            <span className="font-bold text-[var(--ef-text-primary)]">{formatTriggerSource(triggerSource)}</span> trigger
          </div>
          {rulesAppliedCount > 0 ? (
            <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs text-[var(--ef-text-secondary)]">
              <span className="font-bold text-[var(--ef-text-primary)]">{rulesAppliedCount}</span> rules applied
            </div>
          ) : null}
        </div>
      </section>

      {notice ? (
        <div className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-surface-elevated)] px-4 py-3 text-sm text-[var(--ef-text-primary)]">
          {notice}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-sm border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-bg)] px-4 py-3 text-sm text-[var(--ef-critical-soft)]">
          {error}
        </div>
      ) : null}

      <section className="space-y-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
            Approval Readiness Gaps
          </p>
          <h3 className="mt-2 text-lg font-bold text-[var(--ef-text-primary)]">
            What still needs coverage before approval can settle
          </h3>
        </div>

        {readinessGaps.length === 0 ? (
          <div className="rounded-sm border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] px-4 py-5 text-sm text-[var(--ef-text-secondary)]">
            Validator is not showing a support, evidence, or missing-field readiness gap right now.
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-3">
            {readinessGaps.map((item) => (
              <ReadinessGapCard
                key={item.key}
                item={item}
                label={COVERAGE_ITEM_CONFIG[item.key]?.label ?? item.label}
              />
            ))}
          </div>
        )}
      </section>

      <section
        id="approval-blockers"
        className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.95fr)]"
      >
        <div className="space-y-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
              Approval Blockers
            </p>
            <h3 className="mt-2 text-lg font-bold text-[var(--ef-text-primary)]">
              Blocking issues and high-impact mismatches
            </h3>
            <p className="mt-2 text-sm text-[var(--ef-text-muted)]">
              Each blocker explains why approval is held, what the system expected to be true, and where to go next.
            </p>
          </div>

          {loading ? (
            <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-4 py-5 text-sm text-[var(--ef-text-muted)]">
              Loading validator findings...
            </div>
          ) : criticalIssues.length === 0 ? (
            <section className="rounded-sm border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] p-6">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-success-soft)]">
                Approval Blockers
              </p>
              <h3 className="mt-2 text-xl font-bold text-[var(--ef-text-primary)]">
                No blocker-level inconsistencies are open.
              </h3>
              <p className="mt-2 text-sm leading-6 text-[var(--ef-text-secondary)]">
                Validator is not currently surfacing a blocking mismatch or high-risk inconsistency for this project.
              </p>
            </section>
          ) : (
            <div className="space-y-3">
              {criticalIssues.map((finding) => (
                <CriticalIssueCard
                  key={finding.id}
                  projectId={projectId}
                  finding={finding}
                  evidence={evidenceByFindingId[finding.id] ?? []}
                  documentTitleById={documentTitleById}
                  executionHref={executionItemProjectHref(
                    projectId,
                    executionItemIdByFindingId.get(finding.id) ?? finding.linked_action_id ?? null,
                  )}
                  selected={finding.id === selectedFindingId}
                  onSelect={(nextFinding) => setSelectedFindingId(nextFinding.id)}
                />
              ))}
            </div>
          )}
        </div>

        <ValidatorEvidenceDrawer
          finding={selectedFinding}
          evidence={selectedEvidence}
          executionItemId={
            selectedFinding
              ? executionItemIdByFindingId.get(selectedFinding.id) ?? selectedFinding.linked_action_id ?? null
              : null
          }
          loading={evidenceLoadingId === selectedFindingId}
          onClose={() => setSelectedFindingId(null)}
          onFindingActionComplete={() => loadValidatorState(false)}
        />
      </section>
    </div>
  );
}
