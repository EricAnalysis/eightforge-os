import type {
  ValidationApprovalGateEffect,
  ValidationBusinessSeverity,
  ValidationExposureType,
  ValidationFinding,
  ValidationFindingDisposition,
  ValidationSeverity,
  ValidationSourceFamily,
} from '@/types/validator';

type RuleSemanticOverride = {
  business_severity?: ValidationBusinessSeverity;
  source_family?: ValidationSourceFamily;
  approval_gate_effect?: ValidationApprovalGateEffect;
  problem?: string | ((finding: ValidationFinding) => string);
  impact?: string | ((finding: ValidationFinding) => string);
  required_action?: string | ((finding: ValidationFinding) => string);
};

const RULE_SEMANTIC_OVERRIDES: Readonly<Record<string, RuleSemanticOverride>> = {
  SOURCES_NO_CONTRACT: {
    source_family: 'contract',
    required_action:
      'Link the governing contract to the project before approving any invoice tied to this work.',
  },
  SOURCES_NO_RATE_SCHEDULE: {
    source_family: 'contract',
    required_action:
      'Extract or attach the governing rate schedule so billed lines can be compared to contract pricing.',
  },
  SOURCES_NO_INVOICE_DATA: {
    source_family: 'invoice',
    required_action:
      'Attach or extract the invoice documents required for the current project phase before approving billed work.',
  },
  SOURCES_NO_TICKET_DATA: {
    source_family: 'transaction',
    required_action:
      'Load the canonical ticket or transaction dataset for this project before approving billed work.',
  },
  FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED: {
    source_family: 'contract',
    required_action:
      'Attach or extract the contract rate schedule before reviewing billed rates.',
  },
  FINANCIAL_RATE_BASED_ROWS_REQUIRED: {
    source_family: 'contract',
    required_action:
      'Confirm the schedule exhibit and re-run extraction so enough rate rows are available for pricing validation.',
  },
  FINANCIAL_RATE_BASED_PAGES_REQUIRED: {
    business_severity: 'medium',
    source_family: 'contract',
    approval_gate_effect: 'requires_operator_review',
    required_action:
      'Confirm which contract pages govern pricing and capture those schedule pages in canonical contract truth.',
  },
  FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR: {
    business_severity: 'high',
    source_family: 'contract',
    approval_gate_effect: 'requires_operator_review',
    problem:
      'The contract has pricing language, but the governing pricing basis for the billed work is still unresolved.',
    impact:
      'Approval should pause for operator review until the governing pricing clause for the billed work is confirmed.',
    required_action:
      'Confirm whether the contract rate schedule applies to the billed work categories or document the clause that governs pricing.',
  },
  FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED: {
    business_severity: 'medium',
    source_family: 'contract',
    approval_gate_effect: 'requires_operator_review',
    problem:
      'The contract includes activation language, but it is still unclear whether a separate authorization document is required for approval.',
    impact:
      'Activation language is present, but this does not block payment by itself unless a separate authorization artifact is required and missing.',
    required_action:
      'Confirm whether the contract requires a separate notice to proceed or activation document. If not, record the basis. If it does, attach the authorizing record.',
  },
  FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE: {
    business_severity: 'medium',
    source_family: 'contract',
    required_action:
      'Confirm the missing unit coverage in the rate schedule before relying on the contract for full billing support.',
  },
  FINANCIAL_RATE_CODE_MISSING: {
    business_severity: 'medium',
    source_family: 'invoice',
    required_action:
      'Populate the invoice line billing code or confirm the description-based billing key used for validation.',
  },
  FINANCIAL_UNIT_TYPE_MISMATCH: {
    source_family: 'invoice',
    required_action:
      'Review the billed unit against the contract unit and correct the invoice or contract mapping before approval.',
  },
  FINANCIAL_NTE_FACT_MISSING: {
    business_severity: 'low',
    source_family: 'contract',
    approval_gate_effect: 'informational',
    impact:
      'The contract ceiling is not yet resolved in canonical truth, which limits monitoring but does not block approval by itself.',
    required_action:
      'Confirm whether the contract has an NTE or ceiling and capture it in canonical contract truth.',
  },
  FINANCIAL_NTE_EXCEEDED: {
    source_family: 'contract',
    required_action:
      'Hold payment and confirm an approved amendment or authorization for the billed amount above the contract ceiling.',
  },
  FINANCIAL_NTE_APPROACHING: {
    business_severity: 'low',
    source_family: 'contract',
    approval_gate_effect: 'informational',
    required_action:
      'Monitor billed total against the contract ceiling before the next approval.',
  },
  FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR: {
    source_family: 'invoice',
    required_action:
      'Confirm the contractor on the invoice matches the governing contract contractor before payment is released.',
  },
  FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON: {
    business_severity: 'medium',
    source_family: 'invoice',
    required_action:
      'Capture the invoice recipient or owner from the invoice header so contract comparison can complete.',
  },
  FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT: {
    source_family: 'invoice',
    required_action:
      'Confirm the billed client or owner matches the governing contract entity and correct the invoice truth if needed.',
  },
  FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING: {
    business_severity: 'medium',
    source_family: 'invoice',
    required_action:
      'Capture the invoice service period so contract term validation can complete.',
  },
  FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM: {
    source_family: 'invoice',
    required_action:
      'Confirm the service dates or attach the amendment or authorization that places the work inside the approved term.',
  },
  FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS: {
    source_family: 'invoice',
    required_action:
      'Reconcile the invoice header total against the billed line items and correct the invoice total before approval.',
  },
  FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT: {
    source_family: 'invoice',
    problem:
      'Invoice line is missing a confirmed contract rate match.',
    impact:
      'The governing contract can exist while this billed line still lacks a confident match to a specific contract schedule row.',
    required_action:
      'Verify the contract rate schedule row, correct the line mapping, or override with a reason.',
  },
  FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE: {
    source_family: 'invoice',
    required_action:
      'Compare the billed unit price to the governing contract rate and correct the invoice or approved pricing basis.',
  },
  INVOICE_LINE_REQUIRES_BILLING_KEY: {
    source_family: 'invoice',
    required_action:
      'Assign the billing key for this invoice line so it can reconcile to contract and transaction truth.',
  },
  INVOICE_DUPLICATE_BILLED_LINE: {
    source_family: 'invoice',
    required_action:
      'Confirm whether the repeated line is double billed and remove or explain the duplicate before approval.',
  },
  TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE: {
    source_family: 'transaction',
    required_action:
      'Attach or load matching transaction support for this billed line group before approval.',
  },
  TRANSACTION_TOTAL_MATCHES_INVOICE_LINE: {
    source_family: 'transaction',
    required_action:
      'Reconcile the billed line total against transaction totals and correct the unsupported billed amount.',
  },
  TRANSACTION_QUANTITY_MATCHES_INVOICE: {
    source_family: 'transaction',
    required_action:
      'Confirm billed quantity against transaction quantity and correct the invoice or support record.',
  },
  TRANSACTION_RATE_OUTLIERS: {
    business_severity: 'medium',
    source_family: 'transaction',
    required_action:
      'Review the transaction rate outlier and confirm whether the transaction record or pricing basis is wrong.',
  },
  TRANSACTION_MISSING_INVOICE_LINK: {
    business_severity: 'medium',
    source_family: 'transaction',
    required_action:
      'Link the transaction row to the correct invoice or exclude it from approval support.',
  },
  SITE_MATERIAL_ANOMALIES: {
    business_severity: 'medium',
    source_family: 'transaction',
    required_action:
      'Review the grouped site and material records and correct the inconsistent site-type classification.',
  },
  CROSS_DOCUMENT_RATE_MATCHES_CONTRACT: {
    source_family: 'cross_document',
    required_action:
      'Compare the billed rate to the governed contract rate and correct the unsupported billed line.',
  },
  CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS: {
    source_family: 'cross_document',
    required_action:
      'Resolve the canonical work category so contract, invoice, and support rows describe the same work.',
  },
  CROSS_DOCUMENT_CONTRACT_RATE_EXISTS: {
    source_family: 'contract',
    problem:
      'Invoice line is missing a confirmed contract rate match.',
    impact:
      'This invoice line has a billed rate or category, but EightForge could not confirm the matching governing contract schedule row.',
    required_action:
      'Verify the contract rate schedule row, correct the line mapping, or override with a reason.',
  },
  CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS: {
    business_severity: 'medium',
    source_family: 'support',
    required_action:
      'Attach or identify ticket or transaction support for this billed category.',
  },
  CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED: {
    source_family: 'support',
    required_action:
      'Hold the unsupported billed line until matching contract rate and support evidence are attached.',
  },
  CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW: {
    business_severity: 'medium',
    source_family: 'cross_document',
    required_action:
      'Confirm the canonical work category for this billed line so automated comparison can proceed.',
  },
  PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED: {
    business_severity: 'critical',
    source_family: 'support',
    approval_gate_effect: 'blocks_approval',
    required_action:
      'Resolve the unsupported billed amount by attaching contract and transaction support or reducing the billed total.',
  },
  PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO: {
    business_severity: 'critical',
    source_family: 'support',
    approval_gate_effect: 'blocks_approval',
    required_action:
      'Review the billed dollars tied to open findings and resolve the at-risk amount before approval.',
  },
  INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED: {
    business_severity: 'critical',
    source_family: 'support',
    approval_gate_effect: 'blocks_approval',
    required_action:
      'Resolve the unsupported billed amount on this invoice before payment approval proceeds.',
  },
  INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO: {
    business_severity: 'critical',
    source_family: 'support',
    approval_gate_effect: 'blocks_approval',
    required_action:
      'Review the billed dollars tied to open findings on this invoice and clear the at-risk amount before approval.',
  },
  INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE: {
    business_severity: 'medium',
    source_family: 'invoice',
    required_action:
      'Confirm the billed total on the invoice header so exposure can rely on invoice truth instead of a fallback.',
  },
  IDENTITY_PROJECT_CODE_MISMATCH: {
    source_family: 'transaction',
    required_action:
      'Confirm the project code on the support records and correct any rows attributed to the wrong project.',
  },
  IDENTITY_PARTY_NAME_INCONSISTENCY: {
    business_severity: 'medium',
    source_family: 'support',
    required_action:
      'Confirm the contractor or vendor name on support records and correct inconsistent entries.',
  },
  IDENTITY_DUPLICATE_TICKET: {
    source_family: 'support',
    required_action:
      'Confirm whether duplicate ticket IDs represent duplicate billing and resolve the duplicate before approval.',
  },
  TICKET_QTY_CYD_MISMATCH: {
    source_family: 'support',
    required_action:
      'Reconcile the mobile ticket CYD quantity against linked load tickets and correct the source record before approval.',
  },
  TICKET_QTY_TONNAGE_MISMATCH: {
    source_family: 'support',
    required_action:
      'Reconcile the mobile ticket tonnage against linked load tickets and correct the source record before approval.',
  },
  TICKET_MATERIAL_MISMATCH: {
    business_severity: 'medium',
    source_family: 'support',
    required_action:
      'Confirm the material classification across linked tickets and correct the inconsistent record.',
  },
  TICKET_DISPOSAL_SITE_MISMATCH: {
    business_severity: 'medium',
    source_family: 'support',
    required_action:
      'Confirm the disposal site across linked tickets and correct the inconsistent record.',
  },
  TICKET_ORPHANED_LOAD: {
    business_severity: 'medium',
    source_family: 'support',
    required_action:
      'Link the load ticket to the correct mobile ticket or remove it from approval support.',
  },
};

const CONTRACT_RATE_MATCH_RULE_IDS = new Set([
  'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
  'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
]);
const INVOICE_CONTRACTOR_MATCH_RULE_ID = 'FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR';

function isContractRateMatchFinding(finding: ValidationFinding): boolean {
  return CONTRACT_RATE_MATCH_RULE_IDS.has(finding.rule_id);
}

function semanticExpectedValue(finding: ValidationFinding): string | null {
  if (isContractRateMatchFinding(finding)) {
    return 'Confirmed contract schedule row for this billed line';
  }

  return finding.expected;
}

function semanticActualValue(finding: ValidationFinding): string | null {
  if (isContractRateMatchFinding(finding)) {
    return 'No confident contract rate-row match found';
  }

  return finding.actual;
}

function semanticFieldName(finding: ValidationFinding): string | null {
  if (finding.rule_id === INVOICE_CONTRACTOR_MATCH_RULE_ID && finding.field === 'vendor_name') {
    return 'contractor_name';
  }

  return finding.field;
}

function humanizeToken(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function asTrimmedString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseNumericText(value: string | null | undefined): number | null {
  const text = asTrimmedString(value);
  if (!text) return null;
  const normalized = text.replace(/[$,%(),\s]/g, '').replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveAffectedAmount(finding: ValidationFinding): number | null {
  if (typeof finding.affected_amount === 'number' && Number.isFinite(finding.affected_amount)) {
    return Math.abs(finding.affected_amount);
  }

  if (finding.variance_unit === 'USD' && typeof finding.variance === 'number' && Number.isFinite(finding.variance)) {
    return Math.abs(finding.variance);
  }

  if (
    finding.field === 'at_risk_amount'
    || finding.field === 'total_at_risk_amount'
    || finding.field === 'supported_amount'
    || finding.field === 'total_fully_reconciled_amount'
    || finding.field === 'billed_total'
    || finding.field === 'billed_amount'
  ) {
    return parseNumericText(finding.actual) ?? parseNumericText(finding.expected);
  }

  return null;
}

function defaultBusinessSeverity(finding: ValidationFinding): ValidationBusinessSeverity {
  const override = RULE_SEMANTIC_OVERRIDES[finding.rule_id]?.business_severity;
  if (override) return override;

  switch (finding.severity) {
    case 'critical':
      return 'critical';
    case 'warning':
      return 'medium';
    case 'info':
    default:
      return 'low';
  }
}

function findingDispositionForSeverity(
  businessSeverity: ValidationBusinessSeverity,
): ValidationFindingDisposition {
  switch (businessSeverity) {
    case 'critical':
      return 'blocker';
    case 'high':
      return 'requires_review';
    case 'medium':
      return 'warning';
    case 'low':
    default:
      return 'info';
  }
}

function approvalGateEffectForSeverity(
  businessSeverity: ValidationBusinessSeverity,
): ValidationApprovalGateEffect {
  switch (businessSeverity) {
    case 'critical':
      return 'blocks_approval';
    case 'high':
    case 'medium':
      return 'requires_operator_review';
    case 'low':
    default:
      return 'informational';
  }
}

function inferExposureType(
  finding: ValidationFinding,
): ValidationExposureType {
  switch (finding.rule_id) {
    case 'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED':
    case 'INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED':
      return 'unsupported_amount';
    case 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE':
    case 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE':
    case 'TRANSACTION_RATE_OUTLIERS':
    case 'CROSS_DOCUMENT_RATE_MATCHES_CONTRACT':
      return 'rate_mismatch';
    case 'FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS':
    case 'INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE':
      return 'invoice_total_mismatch';
    case 'SOURCES_NO_CONTRACT':
    case 'SOURCES_NO_RATE_SCHEDULE':
    case 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED':
    case 'FINANCIAL_RATE_BASED_ROWS_REQUIRED':
    case 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS':
    case 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT':
      return 'rate_mismatch';
    case 'SOURCES_NO_INVOICE_DATA':
      return 'missing_support';
    case 'SOURCES_NO_TICKET_DATA':
    case 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE':
      return 'missing_transaction_support';
    case 'PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO':
    case 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO':
    case 'CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS':
    case 'CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED':
      return 'missing_support';
    default:
      break;
  }

  const sourceFamily = finding.source_family ?? inferSourceFamily(finding);
  if (sourceFamily === 'contract') return 'missing_governing_contract';
  if (sourceFamily === 'transaction') return 'missing_transaction_support';
  if (sourceFamily === 'support') return 'missing_support';

  const field = (finding.field ?? '').toLowerCase();
  if (field.includes('rate') || field.includes('price')) return 'rate_mismatch';
  if (field.includes('support')) return 'missing_support';
  if (field.includes('invoice_total') || field.includes('billed_total')) {
    return 'invoice_total_mismatch';
  }

  return 'other';
}

function inferSourceFamily(finding: ValidationFinding): ValidationSourceFamily {
  const override = RULE_SEMANTIC_OVERRIDES[finding.rule_id]?.source_family;
  if (override) return override;

  if (finding.rule_id.startsWith('CROSS_DOCUMENT_')) return 'cross_document';
  if (
    finding.rule_id.startsWith('TRANSACTION_')
    || finding.subject_type.startsWith('transaction')
  ) {
    return 'transaction';
  }
  if (
    finding.rule_id.startsWith('TICKET_')
    || finding.subject_type.includes('ticket')
  ) {
    return 'support';
  }
  if (
    finding.rule_id.startsWith('FINANCIAL_RATE_BASED_')
    || finding.rule_id === 'SOURCES_NO_CONTRACT'
    || finding.rule_id === 'SOURCES_NO_RATE_SCHEDULE'
  ) {
    return 'contract';
  }
  if (finding.rule_id === 'SOURCES_NO_INVOICE_DATA') {
    return 'invoice';
  }
  if (
    finding.rule_id.startsWith('FINANCIAL_INVOICE_')
    || finding.rule_id.startsWith('INVOICE_')
    || finding.subject_type.includes('invoice')
  ) {
    return 'invoice';
  }
  if (finding.rule_id.startsWith('PROJECT_') || finding.subject_type === 'project') {
    return 'project';
  }

  return 'system';
}

function defaultProblem(finding: ValidationFinding): string {
  const override = RULE_SEMANTIC_OVERRIDES[finding.rule_id]?.problem;
  if (typeof override === 'function') return override(finding);
  if (typeof override === 'string') return override;

  if (finding.expected && finding.actual) {
    return `${humanizeToken(finding.field ?? finding.rule_id)} does not match the expected project truth.`;
  }
  if (finding.actual) {
    return `${humanizeToken(finding.field ?? finding.rule_id)} requires review.`;
  }
  if (finding.blocked_reason) {
    return finding.blocked_reason;
  }
  return humanizeToken(finding.rule_id);
}

function defaultImpact(
  finding: ValidationFinding,
  approvalGateEffect: ValidationApprovalGateEffect,
  affectedAmount: number | null,
): string {
  const override = RULE_SEMANTIC_OVERRIDES[finding.rule_id]?.impact;
  if (typeof override === 'function') return override(finding);
  if (typeof override === 'string') return override;

  if (approvalGateEffect === 'blocks_approval') {
    if (affectedAmount != null) {
      return `${formatCurrency(affectedAmount)} is directly affected, so approval should not proceed until this is resolved.`;
    }
    return 'Approval should not proceed until this issue is resolved.';
  }

  if (approvalGateEffect === 'requires_operator_review') {
    if (affectedAmount != null) {
      return `${formatCurrency(affectedAmount)} may require operator review before approval can proceed confidently.`;
    }
    return 'Operator review is required before approval can proceed confidently.';
  }

  return 'This is informational context for the approval record and does not block payment by itself.';
}

function defaultRequiredAction(finding: ValidationFinding): string {
  const override = RULE_SEMANTIC_OVERRIDES[finding.rule_id]?.required_action;
  if (typeof override === 'function') return override(finding);
  if (typeof override === 'string') return override;

  if (finding.field?.includes('rate') || finding.field?.includes('price')) {
    return 'Review the billed rate against the governing contract rate and correct the unsupported value.';
  }
  if (finding.field?.includes('service_period')) {
    return 'Confirm the service dates and correct the invoice or term context used for approval.';
  }
  if (finding.field?.includes('contractor') || finding.field?.includes('vendor') || finding.field?.includes('client')) {
    return 'Confirm the party identity on the invoice and correct the canonical record used for approval.';
  }
  if (finding.field?.includes('ticket') || finding.subject_type.includes('ticket')) {
    return 'Review the linked ticket evidence and correct the inconsistent support record.';
  }
  if (finding.field?.includes('invoice')) {
    return 'Review the invoice evidence and correct the billed value used for approval.';
  }
  if (finding.field?.includes('transaction') || finding.subject_type.includes('transaction')) {
    return 'Review the transaction evidence and correct the support record used for approval.';
  }

  return 'Review the linked evidence and resolve the inconsistency before approval.';
}

function buildEvidenceRefs(finding: ValidationFinding): string[] {
  if (Array.isArray(finding.evidence_refs) && finding.evidence_refs.length > 0) {
    return finding.evidence_refs.filter((value): value is string => typeof value === 'string');
  }

  return [];
}

export function normalizeValidationFinding(
  finding: ValidationFinding,
): ValidationFinding {
  const semanticField = semanticFieldName(finding);
  const semanticFinding = semanticField === finding.field
    ? finding
    : { ...finding, field: semanticField };
  const businessSeverity = semanticFinding.business_severity ?? defaultBusinessSeverity(semanticFinding);
  const approvalGateEffect =
    semanticFinding.approval_gate_effect
    ?? RULE_SEMANTIC_OVERRIDES[semanticFinding.rule_id]?.approval_gate_effect
    ?? approvalGateEffectForSeverity(businessSeverity);
  const affectedAmount = deriveAffectedAmount(semanticFinding);

  return {
    ...semanticFinding,
    expected: semanticExpectedValue(semanticFinding),
    actual: semanticActualValue(semanticFinding),
    finding_disposition:
      semanticFinding.finding_disposition ?? findingDispositionForSeverity(businessSeverity),
    business_severity: businessSeverity,
    problem: semanticFinding.problem ?? defaultProblem(semanticFinding),
    impact: semanticFinding.impact ?? defaultImpact(semanticFinding, approvalGateEffect, affectedAmount),
    required_action: semanticFinding.required_action ?? defaultRequiredAction(semanticFinding),
    evidence_refs: buildEvidenceRefs(semanticFinding),
    source_family: semanticFinding.source_family ?? inferSourceFamily(semanticFinding),
    affected_amount: affectedAmount,
    approval_gate_effect: approvalGateEffect,
    exposure_type: semanticFinding.exposure_type ?? inferExposureType(semanticFinding),
  };
}

export function isBlockingFinding(finding: ValidationFinding): boolean {
  return normalizeValidationFinding(finding).approval_gate_effect === 'blocks_approval';
}

export function isReviewFinding(finding: ValidationFinding): boolean {
  const normalized = normalizeValidationFinding(finding);
  return (
    normalized.approval_gate_effect === 'requires_operator_review'
    || normalized.finding_disposition === 'warning'
    || normalized.finding_disposition === 'requires_review'
  );
}

export function blockerFindingCount(findings: readonly ValidationFinding[]): number {
  return findings.filter((finding) => normalizeValidationFinding(finding).finding_disposition === 'blocker').length;
}

export function warningFindingCount(findings: readonly ValidationFinding[]): number {
  return findings.filter((finding) => normalizeValidationFinding(finding).finding_disposition === 'warning').length;
}

export function requiresReviewFindingCount(findings: readonly ValidationFinding[]): number {
  return findings.filter((finding) => normalizeValidationFinding(finding).finding_disposition === 'requires_review').length;
}

export function infoFindingCount(findings: readonly ValidationFinding[]): number {
  return findings.filter((finding) => normalizeValidationFinding(finding).finding_disposition === 'info').length;
}

export function severityRankForFinding(
  finding: ValidationFinding,
): number {
  const severity: ValidationBusinessSeverity = normalizeValidationFinding(finding).business_severity ?? 'low';
  const rank: Record<ValidationBusinessSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  return rank[severity];
}

export function legacySeverityForFinding(
  finding: ValidationFinding,
): ValidationSeverity {
  const severity = normalizeValidationFinding(finding).business_severity ?? 'low';
  switch (severity) {
    case 'critical':
      return 'critical';
    case 'high':
    case 'medium':
      return 'warning';
    case 'low':
    default:
      return 'info';
  }
}
