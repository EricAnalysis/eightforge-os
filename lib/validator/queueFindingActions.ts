import { findingApprovalLabel } from '@/lib/truthToAction';
import { getEvidenceDocumentUrl } from '@/lib/validator/evidenceNavigation';
import type { ProjectOverviewActionItem } from '@/lib/projectOverview';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

type QueueFinding = Pick<
  ValidationFinding,
  | 'id'
  | 'project_id'
  | 'rule_id'
  | 'severity'
  | 'status'
  | 'subject_type'
  | 'subject_id'
  | 'field'
  | 'expected'
  | 'actual'
  | 'variance'
  | 'variance_unit'
  | 'blocked_reason'
  | 'decision_eligible'
  | 'action_eligible'
>;

type QueueEvidence = Pick<
  ValidationEvidence,
  | 'finding_id'
  | 'evidence_type'
  | 'source_document_id'
  | 'source_page'
  | 'fact_id'
  | 'record_id'
  | 'field_name'
  | 'field_value'
  | 'note'
>;

const PROJECT_VALIDATOR_FALLBACK_ANCHOR = '#project-validator';

export const QUEUE_FINDING_RULE_IDS = [
  'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE',
  'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
  'TRANSACTION_QUANTITY_MATCHES_INVOICE',
  'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE',
  'INVOICE_DUPLICATE_BILLED_LINE',
  'INVOICE_LINE_REQUIRES_BILLING_KEY',
] as const;

const QUEUE_FINDING_RULE_ID_SET = new Set<string>(QUEUE_FINDING_RULE_IDS);

const EVIDENCE_PRIORITY: Record<string, number> = {
  invoice_line: 0,
  invoice: 1,
  transaction_row: 2,
  rate_schedule: 3,
  fact: 4,
  transaction_group: 5,
  grouping_key: 6,
};

const EVIDENCE_FIELD_PRIORITY: Record<string, number> = {
  rate_code: 0,
  unit_price: 1,
  quantity: 2,
  line_total: 3,
  billing_rate_key: 4,
  invoice_rate_key: 5,
  invoice_number: 6,
};

const MONEY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
});

function isQueueFindingRuleId(ruleId: string): boolean {
  return QUEUE_FINDING_RULE_ID_SET.has(ruleId);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[$,]/g, '').trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: number): string {
  return MONEY_FORMATTER.format(value);
}

function formatNumericValue(value: string | null, unit: string | null): string | null {
  const parsed = parseNumber(value);
  if (parsed == null) return value;

  if (unit === 'USD') {
    return formatMoney(parsed);
  }

  const formatted = NUMBER_FORMATTER.format(parsed);
  if (unit === 'QTY') {
    return `${formatted} qty`;
  }

  return formatted;
}

function formatSignedVariance(value: number, unit: string | null): string {
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  const absolute = Math.abs(value);

  if (unit === 'USD') {
    return `${prefix}${formatMoney(absolute)}`;
  }

  const formatted = NUMBER_FORMATTER.format(absolute);
  if (unit === 'QTY') {
    return `${prefix}${formatted} qty`;
  }

  return `${prefix}${formatted}`;
}

function bestEvidence(
  evidence: readonly QueueEvidence[],
): QueueEvidence | null {
  const candidates = evidence.filter((entry) => entry.source_document_id != null);
  if (candidates.length === 0) return null;

  return [...candidates].sort((left, right) => {
    const leftRank = EVIDENCE_PRIORITY[left.evidence_type] ?? 99;
    const rightRank = EVIDENCE_PRIORITY[right.evidence_type] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;

    const leftFieldRank = EVIDENCE_FIELD_PRIORITY[left.field_name ?? ''] ?? 99;
    const rightFieldRank = EVIDENCE_FIELD_PRIORITY[right.field_name ?? ''] ?? 99;
    if (leftFieldRank !== rightFieldRank) return leftFieldRank - rightFieldRank;

    const leftPage = left.source_page ?? Number.MAX_SAFE_INTEGER;
    const rightPage = right.source_page ?? Number.MAX_SAFE_INTEGER;
    return leftPage - rightPage;
  })[0] ?? null;
}

function evidenceValue(
  evidence: readonly QueueEvidence[],
  fieldNames: readonly string[],
): string | null {
  for (const fieldName of fieldNames) {
    const match = evidence.find((entry) => entry.field_name === fieldName);
    const value = asNonEmptyString(match?.field_value);
    if (value) return value;
  }

  return null;
}

function invoiceNumberForFinding(
  finding: QueueFinding,
  evidence: readonly QueueEvidence[],
): string | null {
  const explicit = evidenceValue(evidence, ['invoice_number', 'invoice_no', 'number']);
  if (explicit) return explicit;

  const invoiceRateKey = evidenceValue(evidence, ['invoice_rate_key']);
  if (invoiceRateKey?.includes('::')) {
    return invoiceRateKey.split('::')[0] ?? null;
  }

  if (finding.subject_id.includes('::')) {
    return finding.subject_id.split('::')[0] ?? null;
  }

  return null;
}

function rateKeyForFinding(
  finding: QueueFinding,
  evidence: readonly QueueEvidence[],
): string | null {
  const explicit = evidenceValue(evidence, [
    'rate_code',
    'billing_rate_key',
    'invoice_rate_key',
  ]);
  if (explicit) {
    const normalizedInvoiceKey = explicit.includes('::')
      ? explicit.split('::')[1] ?? explicit
      : explicit;
    return normalizedInvoiceKey;
  }

  if (finding.subject_id.includes('::')) {
    return finding.subject_id.split('::')[1] ?? finding.subject_id;
  }

  return null;
}

function lineIdentifierForFinding(
  finding: QueueFinding,
  evidence: readonly QueueEvidence[],
): string {
  return (
    evidence.find((entry) => typeof entry.record_id === 'string' && entry.record_id.trim().length > 0)
      ?.record_id
    ?? finding.subject_id
  );
}

function sourceReferenceForEvidence(
  evidence: readonly QueueEvidence[],
): string {
  const evidenceTypes = new Set(evidence.map((entry) => entry.evidence_type));

  if (evidenceTypes.has('rate_schedule') && (evidenceTypes.has('invoice_line') || evidenceTypes.has('invoice'))) {
    return 'Contract document + Invoice extraction';
  }

  if (
    (evidenceTypes.has('transaction_row') || evidenceTypes.has('transaction_group'))
    && (evidenceTypes.has('invoice_line') || evidenceTypes.has('invoice'))
  ) {
    return 'Invoice extraction + Validator finding';
  }

  if (evidenceTypes.has('invoice_line') || evidenceTypes.has('invoice')) {
    return 'Invoice extraction';
  }

  if (evidenceTypes.has('rate_schedule') || evidenceTypes.has('fact')) {
    return 'Contract document';
  }

  if (evidenceTypes.has('grouping_key')) {
    return 'Derived';
  }

  return 'Validator finding';
}

function fallbackProjectHref(projectId: string): string {
  return `/platform/projects/${projectId}${PROJECT_VALIDATOR_FALLBACK_ANCHOR}`;
}

function hrefForFinding(
  finding: QueueFinding,
  evidence: readonly QueueEvidence[],
): string {
  const primaryEvidence = bestEvidence(evidence);
  if (!primaryEvidence) {
    return fallbackProjectHref(finding.project_id);
  }

  return (
    getEvidenceDocumentUrl({
      projectId: finding.project_id,
      evidence: primaryEvidence as ValidationEvidence,
    })
    ?? fallbackProjectHref(finding.project_id)
  );
}

function varianceAmountForFinding(
  finding: QueueFinding,
): number | null {
  if (finding.variance_unit === 'USD' && finding.variance != null) {
    return Math.abs(finding.variance);
  }

  return null;
}

function lineExposureAmountForFinding(
  evidence: readonly QueueEvidence[],
): number | null {
  const lineTotal = parseNumber(evidenceValue(evidence, ['line_total', 'line_amount', 'extended_amount']));
  if (lineTotal != null) return Math.abs(lineTotal);

  return null;
}

function impactedAmountForFinding(
  finding: QueueFinding,
  evidence: readonly QueueEvidence[],
): number | null {
  return lineExposureAmountForFinding(evidence) ?? varianceAmountForFinding(finding);
}

function atRiskAmountForFinding(
  finding: QueueFinding,
  evidence: readonly QueueEvidence[],
): number | null {
  const varianceAmount = varianceAmountForFinding(finding);
  if (varianceAmount == null) return null;

  const lineExposureAmount = lineExposureAmountForFinding(evidence);
  if (lineExposureAmount == null) return null;
  if (Math.abs(lineExposureAmount - varianceAmount) <= 0.01) return null;

  return varianceAmount;
}

function requiresVerificationAmountForFinding(
  finding: QueueFinding,
  evidence: readonly QueueEvidence[],
): number | null {
  return lineExposureAmountForFinding(evidence) ?? varianceAmountForFinding(finding);
}

function gateImpactLabelForApprovalStatus(
  approvalStatus: ProjectOverviewActionItem['approval_status'],
): string {
  return approvalStatus === 'blocked' ? 'Requires Verification' : 'Needs Review';
}

function gateImpactToneForApprovalStatus(
  approvalStatus: ProjectOverviewActionItem['approval_status'],
): ProjectOverviewActionItem['due_tone'] {
  return approvalStatus === 'blocked' ? 'danger' : 'warning';
}

function statusLabelForApprovalStatus(
  approvalStatus: ProjectOverviewActionItem['approval_status'],
): string {
  return approvalStatus === 'blocked' ? 'Blocked' : 'Needs Review';
}

function buildTitle(
  finding: QueueFinding,
  rateKey: string | null,
  lineIdentifier: string,
  expectedNumeric: number | null,
  actualNumeric: number | null,
): string {
  switch (finding.rule_id) {
    case 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE':
      if (rateKey && expectedNumeric != null && actualNumeric != null) {
        return actualNumeric > expectedNumeric
          ? `Rate ${rateKey} exceeds contract rate`
          : `Rate ${rateKey} is below contract rate`;
      }
      return rateKey
        ? `Rate ${rateKey} does not match contract rate`
        : `Invoice line rate does not match contract rate`;
    case 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT':
      return rateKey
        ? `Rate ${rateKey} has no contract rate match`
        : `Invoice line has no contract rate match`;
    case 'TRANSACTION_QUANTITY_MATCHES_INVOICE':
      return rateKey
        ? `Quantity for ${rateKey} lacks validated support`
        : `Invoice quantity lacks validated support`;
    case 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE':
      return rateKey
        ? `Billing key ${rateKey} has no validated match`
        : `Invoice line has no validated billing match`;
    case 'INVOICE_DUPLICATE_BILLED_LINE':
      return rateKey
        ? `Duplicate billed line detected for ${rateKey}`
        : `Duplicate billed line detected`;
    case 'INVOICE_LINE_REQUIRES_BILLING_KEY':
      return `Line ${lineIdentifier} is missing a billing key`;
    default:
      return finding.blocked_reason ?? finding.rule_id;
  }
}

function buildNextStep(
  finding: QueueFinding,
  rateKey: string | null,
): string {
  switch (finding.rule_id) {
    case 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE':
      return 'Review contract rate schedule';
    case 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT':
      return rateKey
        ? `Review contract rate schedule for ${rateKey}`
        : 'Review contract rate schedule';
    case 'TRANSACTION_QUANTITY_MATCHES_INVOICE':
      return 'Review quantity support against validated billing basis';
    case 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE':
      return 'Resolve the invoice billing match';
    case 'INVOICE_DUPLICATE_BILLED_LINE':
      return 'Review duplicate billed lines and confirm one billable entry';
    case 'INVOICE_LINE_REQUIRES_BILLING_KEY':
      return 'Review the invoice line description and assign the correct billing key';
    default:
      return 'Open the evidence and review the finding';
  }
}

function buildVarianceLabel(
  finding: QueueFinding,
  expectedNumeric: number | null,
  actualNumeric: number | null,
  impactedAmount: number | null,
): string | null {
  if (expectedNumeric != null && actualNumeric != null) {
    const signed = actualNumeric - expectedNumeric;
    if (Math.abs(signed) <= 0.000001) return null;
    return formatSignedVariance(signed, finding.variance_unit);
  }

  if (finding.variance != null) {
    return formatSignedVariance(finding.variance, finding.variance_unit);
  }

  if (finding.rule_id === 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE') {
    return 'Unresolved support';
  }

  if (
    (finding.rule_id === 'INVOICE_DUPLICATE_BILLED_LINE'
      || finding.rule_id === 'INVOICE_LINE_REQUIRES_BILLING_KEY')
    && impactedAmount != null
  ) {
    return formatMoney(impactedAmount);
  }

  return null;
}

function buildExpectedActualValues(
  finding: QueueFinding,
): {
  expectedValue: string | null;
  actualValue: string | null;
  expectedNumeric: number | null;
  actualNumeric: number | null;
} {
  const expectedNumeric = parseNumber(finding.expected);
  const actualNumeric = parseNumber(finding.actual);

  return {
    expectedValue: formatNumericValue(finding.expected, finding.variance_unit),
    actualValue: formatNumericValue(finding.actual, finding.variance_unit),
    expectedNumeric,
    actualNumeric,
  };
}

function approvalStatusForFinding(
  finding: QueueFinding,
): ProjectOverviewActionItem['approval_status'] {
  return findingApprovalLabel(finding) === 'Requires Verification'
    ? 'blocked'
    : 'needs_review';
}

function buildFindingAction(
  finding: QueueFinding,
  evidence: readonly QueueEvidence[],
): ProjectOverviewActionItem | null {
  if (!isQueueFindingRuleId(finding.rule_id)) return null;
  if (finding.status !== 'open') return null;
  if (finding.severity !== 'critical' && finding.severity !== 'warning') return null;

  const invoiceNumber = invoiceNumberForFinding(finding, evidence);
  const rateKey = rateKeyForFinding(finding, evidence);
  const lineIdentifier = lineIdentifierForFinding(finding, evidence);
  const sourceReference = sourceReferenceForEvidence(evidence);
  const href = hrefForFinding(finding, evidence);
  const impactedAmount = impactedAmountForFinding(finding, evidence);
  const atRiskAmount = atRiskAmountForFinding(finding, evidence);
  const requiresVerificationAmount = requiresVerificationAmountForFinding(finding, evidence);
  const { expectedValue, actualValue, expectedNumeric, actualNumeric } = buildExpectedActualValues(finding);
  const varianceLabel = buildVarianceLabel(
    finding,
    expectedNumeric,
    actualNumeric,
    impactedAmount,
  );
  const approvalStatus = approvalStatusForFinding(finding);

  return {
    id: `validator-finding:${finding.id}`,
    href,
    title: buildTitle(finding, rateKey, lineIdentifier, expectedNumeric, actualNumeric),
    due_label: gateImpactLabelForApprovalStatus(approvalStatus),
    due_tone: gateImpactToneForApprovalStatus(approvalStatus),
    assignee_label: 'Operator queue',
    priority_label: finding.severity === 'critical' ? 'Critical' : 'High',
    priority_tone: finding.severity === 'critical' ? 'danger' : 'warning',
    status_label: statusLabelForApprovalStatus(approvalStatus),
    source_document_title: sourceReference,
    source_document_type: null,
    invoice_number: invoiceNumber,
    approval_status: approvalStatus,
    impacted_amount: impactedAmount,
    at_risk_amount: atRiskAmount,
    requires_verification_amount: requiresVerificationAmount,
    blocked_amount: approvalStatus === 'blocked' ? requiresVerificationAmount : null,
    billing_group_ids: rateKey ? [rateKey] : null,
    next_step: buildNextStep(finding, rateKey),
    expected_value: expectedValue,
    actual_value: actualValue,
    variance_label: varianceLabel,
  };
}

function sortFindingActions(
  actions: readonly ProjectOverviewActionItem[],
): ProjectOverviewActionItem[] {
  return [...actions].sort((left, right) => {
    const leftBlocked = left.approval_status === 'blocked' ? 0 : 1;
    const rightBlocked = right.approval_status === 'blocked' ? 0 : 1;
    if (leftBlocked !== rightBlocked) {
      return leftBlocked - rightBlocked;
    }

    const leftAmount =
      left.blocked_amount
      ?? left.requires_verification_amount
      ?? left.at_risk_amount
      ?? left.impacted_amount
      ?? 0;
    const rightAmount =
      right.blocked_amount
      ?? right.requires_verification_amount
      ?? right.at_risk_amount
      ?? right.impacted_amount
      ?? 0;
    if (leftAmount !== rightAmount) {
      return rightAmount - leftAmount;
    }

    return left.title.localeCompare(right.title, 'en-US');
  });
}

export function buildValidatorFindingActionsByProjectId(params: {
  findings: readonly QueueFinding[];
  evidence: readonly QueueEvidence[];
}): Map<string, ProjectOverviewActionItem[]> {
  const evidenceByFindingId = new Map<string, QueueEvidence[]>();

  for (const row of params.evidence) {
    const existing = evidenceByFindingId.get(row.finding_id) ?? [];
    existing.push(row);
    evidenceByFindingId.set(row.finding_id, existing);
  }

  const actionsByProjectId = new Map<string, ProjectOverviewActionItem[]>();

  for (const finding of params.findings) {
    const action = buildFindingAction(
      finding,
      evidenceByFindingId.get(finding.id) ?? [],
    );
    if (!action) continue;

    const existing = actionsByProjectId.get(finding.project_id) ?? [];
    existing.push(action);
    actionsByProjectId.set(finding.project_id, existing);
  }

  for (const [projectId, actions] of actionsByProjectId.entries()) {
    actionsByProjectId.set(projectId, sortFindingActions(actions));
  }

  return actionsByProjectId;
}
