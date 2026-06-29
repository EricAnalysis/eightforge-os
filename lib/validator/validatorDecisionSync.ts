import type { SupabaseClient } from '@supabase/supabase-js';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { evaluateApprovalGate } from '@/lib/validator/approvalGate';
import {
  isBlockingFinding,
  isReviewFinding,
  normalizeValidationFinding,
} from '@/lib/validator/findingSemantics';
import type {
  InvoiceApprovalDecision,
  ProjectApprovalDecision,
} from '@/types/approval';
import type {
  InvoiceExposureSummary,
  ValidationEvidence,
  ValidationExposureType,
  ValidationFinding,
  ValidatorResult,
} from '@/types/validator';

type PersistableValidationFinding = ValidationFinding & {
  evidence?: ValidationEvidence[];
};

type ExistingValidatorDecisionRow = {
  id: string;
  organization_id?: string | null;
  project_id?: string | null;
  decision_type: string;
  document_id: string | null;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  assigned_to: string | null;
  assigned_at: string | null;
  due_at: string | null;
  details: Record<string, unknown> | null;
};

type PersistedDecisionSeverity = 'low' | 'medium' | 'high' | 'critical';
type PersistedDecisionStatus = 'open' | 'in_review' | 'resolved';
type PrimaryApprovalStatus = 'approved' | 'blocked' | 'requires_review';

export type ValidatorDecisionRecord = {
  identity_key: string;
  decision_type: 'validator_project_approval' | 'validator_invoice_approval';
  title: string;
  summary: string;
  severity: PersistedDecisionSeverity;
  status: PersistedDecisionStatus;
  document_id: string | null;
  finding_ids: string[];
  link_finding_ids: string[];
  details: Record<string, unknown>;
};

export type SyncValidatorDecisionsResult = {
  created: number;
  updated: number;
  suppressed: number;
  decisionIdsByIdentityKey: Map<string, string>;
};

function getIdentityKey(details: Record<string, unknown> | null | undefined): string | null {
  const identityKey = details?.identity_key;
  return typeof identityKey === 'string' && identityKey.trim().length > 0
    ? identityKey.trim()
    : null;
}

function isMissingColumnError(
  error: unknown,
  columnName: string,
): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: string | null; message?: string | null };
  const message = (record.message ?? '').toLowerCase();
  const normalizedColumnName = columnName.toLowerCase();
  return (
    record.code === '42703'
    || record.code === 'PGRST204'
    || message.includes(normalizedColumnName)
  );
}

function withProjectContextDetails(params: {
  details: Record<string, unknown>;
  projectContext?: { label: string; project_id: string; project_code: string | null } | null;
}): Record<string, unknown> {
  const { details, projectContext } = params;
  if (!projectContext) return details;
  return {
    ...details,
    project_context: {
      label: projectContext.label,
      project_id: projectContext.project_id,
      project_code: projectContext.project_code,
    },
  };
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function reasonLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function simplifyApprovalStatus(
  status: 'approved' | 'approved_with_exceptions' | 'needs_review' | 'blocked',
): PrimaryApprovalStatus {
  switch (status) {
    case 'blocked':
      return 'blocked';
    case 'needs_review':
    case 'approved_with_exceptions':
      return 'requires_review';
    case 'approved':
    default:
      return 'approved';
  }
}

function approvalImpactLabelForPrimaryStatus(
  status: PrimaryApprovalStatus,
): string {
  switch (status) {
    case 'blocked':
      return 'Cannot approve payment until the blocking validator issues are resolved.';
    case 'requires_review':
      return 'Operator review is still required before payment approval can proceed.';
    case 'approved':
    default:
      return 'Current validator truth supports approval.';
  }
}

function decisionSeverityForPrimaryStatus(
  status: PrimaryApprovalStatus,
): PersistedDecisionSeverity {
  switch (status) {
    case 'blocked':
      return 'critical';
    case 'requires_review':
      return 'high';
    default:
      return 'low';
  }
}

function decisionStatusForPrimaryApproval(
  status: PrimaryApprovalStatus,
): PersistedDecisionStatus {
  switch (status) {
    case 'blocked':
      return 'open';
    case 'requires_review':
      return 'in_review';
    case 'approved':
    default:
      return 'resolved';
  }
}

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    results.push(trimmed);
  }
  return results;
}

function buildEvidenceRefFromEvidence(evidence: ValidationEvidence): string | null {
  if (evidence.fact_id) return `fact:${evidence.fact_id}`;
  if (evidence.record_id) return `record:${evidence.record_id}`;
  if (evidence.source_document_id && evidence.source_page != null) {
    return `document:${evidence.source_document_id}:page:${evidence.source_page}`;
  }
  if (evidence.source_document_id) return `document:${evidence.source_document_id}`;
  if (evidence.field_name && evidence.field_value) {
    return `field:${evidence.field_name}=${evidence.field_value}`;
  }
  if (evidence.field_name) return `field:${evidence.field_name}`;
  return null;
}

function findingEvidenceRefs(finding: PersistableValidationFinding): string[] {
  const normalized = normalizeValidationFinding(finding);
  const fromFinding = Array.isArray(normalized.evidence_refs)
    ? normalized.evidence_refs
    : [];
  const fromEvidence = (finding.evidence ?? [])
    .map(buildEvidenceRefFromEvidence)
    .filter((value): value is string => typeof value === 'string');
  return uniqueStrings([...fromFinding, ...fromEvidence]);
}

function findingExposureTypes(
  findings: readonly PersistableValidationFinding[],
): ValidationExposureType[] {
  const seen = new Set<ValidationExposureType>();
  const results: ValidationExposureType[] = [];
  for (const finding of findings) {
    const exposureType = normalizeValidationFinding(finding).exposure_type;
    if (!exposureType || seen.has(exposureType)) continue;
    seen.add(exposureType);
    results.push(exposureType);
  }
  return results;
}

function findingApprovalGateEffects(
  findings: readonly PersistableValidationFinding[],
): string[] {
  return uniqueStrings(
    findings.map((finding) => normalizeValidationFinding(finding).approval_gate_effect),
  );
}

function findingSourceDocumentIds(finding: PersistableValidationFinding): string[] {
  return uniqueStrings(
    (finding.evidence ?? []).map((evidence) => evidence.source_document_id),
  );
}

function evidenceValue(
  evidence: readonly ValidationEvidence[] | undefined,
  fieldNames: readonly string[],
): string | null {
  if (!evidence) return null;
  for (const fieldName of fieldNames) {
    const match = evidence.find((entry) => entry.field_name === fieldName);
    if (typeof match?.field_value === 'string' && match.field_value.trim().length > 0) {
      return match.field_value.trim();
    }
  }
  return null;
}

function invoiceLineContexts(
  findings: readonly PersistableValidationFinding[],
): Array<Record<string, unknown>> {
  return findings
    .filter((finding) => finding.subject_type === 'invoice_line')
    .map((finding) => {
      const normalized = normalizeValidationFinding(finding);
      const evidence = finding.evidence ?? [];
      const recordId =
        evidence.find((entry) => entry.evidence_type === 'invoice_line' && entry.record_id)?.record_id
        ?? finding.subject_id;
      const rateCode = evidenceValue(evidence, ['rate_code', 'line_code', 'item_code']);

      return {
        finding_id: finding.id,
        rule_id: finding.rule_id,
        record_id: recordId,
        subject_id: finding.subject_id,
        invoice_document_id: evidence.find((entry) => entry.evidence_type === 'invoice_line' && entry.source_document_id)?.source_document_id ?? null,
        invoice_number: evidenceValue(evidence, ['invoice_number', 'invoice_no', 'number']),
        rate_code: rateCode,
        line_description: evidenceValue(evidence, ['description', 'line_description', 'rate_description']),
        quantity: evidenceValue(evidence, ['quantity', 'qty', 'billed_quantity']),
        unit_price: evidenceValue(evidence, ['unit_price', 'billed_rate', 'invoice_rate', 'rate']),
        line_total: evidenceValue(evidence, ['line_total', 'extended_amount', 'extended_cost', 'line_amount']),
        expected: normalized.expected,
        actual: normalized.actual,
      };
    })
    .filter((context) => (
      context.invoice_number != null
      || context.rate_code != null
      || context.line_description != null
      || context.quantity != null
      || context.unit_price != null
      || context.line_total != null
    ));
}

function primaryComparisonContext(
  finding: PersistableValidationFinding | null,
): Record<string, unknown> {
  if (!finding) return {};

  const normalized = normalizeValidationFinding(finding);
  const actualSource = evidenceValue(finding.evidence, [
    'contractor_name_source',
    'vendor_name_source',
    'actual_source',
  ]);

  return {
    rule_id: normalized.rule_id,
    field_key: normalized.field,
    expected_value: normalized.expected,
    actual_value: normalized.actual,
    actual_value_source: actualSource,
  };
}

function primarySourceDocumentId(findings: readonly PersistableValidationFinding[]): string | null {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    for (const documentId of findingSourceDocumentIds(finding)) {
      counts.set(documentId, (counts.get(documentId) ?? 0) + 1);
    }
  }

  let selected: string | null = null;
  let selectedCount = -1;
  for (const [documentId, count] of counts.entries()) {
    if (count > selectedCount) {
      selected = documentId;
      selectedCount = count;
    }
  }

  return selected;
}

function dominantSourceFamily(findings: readonly PersistableValidationFinding[]): string | null {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const family = normalizeValidationFinding(finding).source_family;
    if (!family) continue;
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }

  let selected: string | null = null;
  let selectedCount = -1;
  for (const [family, count] of counts.entries()) {
    if (count > selectedCount) {
      selected = family;
      selectedCount = count;
    }
  }

  return selected;
}

function totalAffectedAmount(findings: readonly PersistableValidationFinding[]): number | null {
  const total = findings.reduce((sum, finding) => {
    const normalized = normalizeValidationFinding(finding);
    return sum + (normalized.affected_amount ?? 0);
  }, 0);

  return total > 0 ? total : null;
}

function findingPriorityScore(finding: PersistableValidationFinding): number {
  const normalized = normalizeValidationFinding(finding);
  if (isBlockingFinding(normalized)) return 400;
  if (isReviewFinding(normalized)) return 300;
  if (normalized.finding_disposition === 'requires_review') return 250;
  if (normalized.finding_disposition === 'warning') return 200;
  return normalized.affected_amount ?? 0;
}

function primaryFinding(
  findings: readonly PersistableValidationFinding[],
): PersistableValidationFinding | null {
  const sorted = [...findings].sort((left, right) => {
    const priorityDelta = findingPriorityScore(right) - findingPriorityScore(left);
    if (priorityDelta !== 0) return priorityDelta;
    const leftAmount = normalizeValidationFinding(left).affected_amount ?? 0;
    const rightAmount = normalizeValidationFinding(right).affected_amount ?? 0;
    return rightAmount - leftAmount;
  });

  return sorted[0] ?? null;
}

function invoiceLabel(invoiceNumber: string | null): string {
  return invoiceNumber ? `Invoice ${invoiceNumber}` : 'Invoice';
}

function pickRequiredAction(
  findings: readonly PersistableValidationFinding[],
  fallback: string,
): string {
  const explicit = uniqueStrings(
    findings.map((finding) => normalizeValidationFinding(finding).required_action),
  );
  return explicit[0] ?? fallback;
}

function pickProblem(
  findings: readonly PersistableValidationFinding[],
  fallback: string,
): string {
  const explicit = uniqueStrings(
    findings.map((finding) => normalizeValidationFinding(finding).problem),
  );
  return explicit[0] ?? fallback;
}

function pickImpact(
  findings: readonly PersistableValidationFinding[],
  fallback: string,
): string {
  const explicit = uniqueStrings(
    findings.map((finding) => normalizeValidationFinding(finding).impact),
  );
  return explicit[0] ?? fallback;
}

function defaultProjectRequiredAction(
  reasons: readonly string[],
  status: PrimaryApprovalStatus,
): string {
  if (reasons.includes('missing_contract_support')) {
    return 'Attach the governing contract support or rate schedule before approval continues.';
  }
  if (reasons.includes('missing_transaction_support')) {
    return 'Load or link the missing ticket and transaction support before approval continues.';
  }
  if (reasons.includes('rate_mismatch')) {
    return 'Resolve the contract, invoice, or transaction rate mismatch before approving payment.';
  }
  if (reasons.includes('quantity_mismatch')) {
    return 'Resolve the quantity mismatch between billed work and support before approving payment.';
  }
  if (status === 'blocked') {
    return 'Resolve the blocking validator findings before approving payment.';
  }
  if (status === 'approved') {
    return 'No corrective action is required. Approval can proceed on current validator truth.';
  }
  return 'Review the validator findings and confirm the approval basis before proceeding.';
}

function defaultProjectProblem(
  reasons: readonly string[],
  status: PrimaryApprovalStatus,
): string {
  if (
    reasons.includes('missing_contract_support')
    || reasons.includes('pricing_applicability_unresolved')
    || reasons.includes('activation_unresolved')
  ) {
    return 'Contract support for billing is still incomplete or unresolved.';
  }
  if (reasons.includes('rate_mismatch')) {
    return 'Project billing does not reconcile cleanly to the governing rates.';
  }
  if (reasons.includes('missing_transaction_support')) {
    return 'Project billing is missing ticket or transaction support.';
  }
  if (status === 'blocked') {
    return 'Validator found issues that block project approval.';
  }
  if (status === 'approved') {
    return 'Current validator truth supports project approval.';
  }
  return 'Validator found issues that require project-level review.';
}

function defaultProjectImpact(
  params: {
    approvalStatus: PrimaryApprovalStatus;
    blockedAmount: number | null;
    atRiskAmount: number | null;
  },
): string {
  if ((params.blockedAmount ?? 0) > 0) {
    return `${formatCurrency(params.blockedAmount ?? 0)} is currently blocked from approval.`;
  }
  if ((params.atRiskAmount ?? 0) > 0) {
    return `${formatCurrency(params.atRiskAmount ?? 0)} remains at risk until project-level validator issues are resolved.`;
  }
  return approvalImpactLabelForPrimaryStatus(params.approvalStatus);
}

function defaultInvoiceRequiredAction(
  invoice: InvoiceApprovalDecision,
): string {
  if (invoice.approval_status === 'approved') {
    return `No corrective action is required. ${invoiceLabel(invoice.invoice_number)} can proceed on current validator truth.`;
  }
  if (invoice.reasons.includes('rate_mismatch')) {
    return `Reconcile billed rates on ${invoiceLabel(invoice.invoice_number)} against contract and support before approval.`;
  }
  if (invoice.reasons.includes('quantity_mismatch')) {
    return `Reconcile billed quantities on ${invoiceLabel(invoice.invoice_number)} against transaction support before approval.`;
  }
  if (invoice.reasons.includes('missing_transaction_support')) {
    return `Attach the missing ticket or transaction support for ${invoiceLabel(invoice.invoice_number)} before approval.`;
  }
  if (invoice.reasons.includes('missing_contract_support')) {
    return `Attach the governing contract support for ${invoiceLabel(invoice.invoice_number)} or remove the unsupported billed amount from approval.`;
  }
  return `Review ${invoiceLabel(invoice.invoice_number)} and resolve the validator findings before approval.`;
}

function defaultInvoiceProblem(
  invoice: InvoiceApprovalDecision,
  unsupportedAmount: number | null,
): string {
  if (invoice.approval_status === 'approved') {
    return `${invoiceLabel(invoice.invoice_number)} is supported by the current validator truth.`;
  }
  if (unsupportedAmount != null && unsupportedAmount > 0) {
    return `${invoiceLabel(invoice.invoice_number)} contains billed dollars that are not fully supported by current validator truth.`;
  }
  if (invoice.reasons.includes('rate_mismatch')) {
    return `${invoiceLabel(invoice.invoice_number)} does not reconcile to the governing rates.`;
  }
  if (invoice.reasons.includes('quantity_mismatch')) {
    return `${invoiceLabel(invoice.invoice_number)} does not reconcile to the supported billed quantity.`;
  }
  if (invoice.reasons.includes('missing_transaction_support')) {
    return `${invoiceLabel(invoice.invoice_number)} is missing linked ticket or transaction support.`;
  }
  if (invoice.reasons.includes('missing_contract_support')) {
    return `${invoiceLabel(invoice.invoice_number)} is missing contract support for one or more billed lines.`;
  }
  return `${invoiceLabel(invoice.invoice_number)} cannot be approved from current validator output.`;
}

function defaultInvoiceImpact(
  approvalStatus: PrimaryApprovalStatus,
  invoiceLabelValue: string,
  affectedAmount: number | null,
): string {
  if (affectedAmount != null && affectedAmount > 0) {
    const suffix =
      approvalStatus === 'blocked'
        ? 'is blocking approval'
        : 'requires operator review before approval';
    return `${formatCurrency(affectedAmount)} on ${invoiceLabelValue} ${suffix}.`;
  }
  return approvalImpactLabelForPrimaryStatus(approvalStatus);
}

function invoiceDecisionTitle(invoiceNumber: string | null): string {
  return invoiceNumber ? `Invoice ${invoiceNumber} approval status` : 'Invoice approval status';
}

function projectDecisionTitle(): string {
  return 'Project approval status';
}

function invoiceUnsupportedAmount(
  billedAmount: number | null,
  supportedAmount: number,
  atRiskAmount: number,
  requiresVerificationAmount: number | null,
): number | null {
  if (requiresVerificationAmount != null && requiresVerificationAmount > 0) {
    return requiresVerificationAmount;
  }
  if (billedAmount != null && billedAmount > supportedAmount) {
    return billedAmount - supportedAmount;
  }
  if (atRiskAmount > 0) return atRiskAmount;
  return null;
}

function buildDecisionSummary(problem: string, impact: string): string {
  return `${problem} ${impact}`.trim();
}

function buildInvoiceDecisionRecord(params: {
  projectId: string;
  runId: string;
  invoiceIndex: number;
  invoice: InvoiceApprovalDecision;
  exposureInvoice: InvoiceExposureSummary | null;
  findings: PersistableValidationFinding[];
}): ValidatorDecisionRecord {
  const { projectId, runId, invoiceIndex, invoice, exposureInvoice, findings } = params;
  const relatedFindings = findings.filter((finding) => invoice.finding_ids.includes(finding.id));
  const primaryApprovalStatus = simplifyApprovalStatus(invoice.approval_status);
  const invoiceLabelValue = invoiceLabel(invoice.invoice_number);
  const unsupportedAmount = invoiceUnsupportedAmount(
    exposureInvoice?.billed_amount ?? invoice.billed_amount,
    exposureInvoice?.supported_amount ?? invoice.supported_amount,
    exposureInvoice?.at_risk_amount ?? invoice.at_risk_amount,
    exposureInvoice?.requires_verification_amount ?? null,
  );
  const affectedAmount =
    unsupportedAmount
    ?? (exposureInvoice?.at_risk_amount ?? invoice.at_risk_amount)
    ?? exposureInvoice?.billed_amount
    ?? invoice.billed_amount
    ?? totalAffectedAmount(relatedFindings);
  const fallbackProblem = defaultInvoiceProblem(invoice, unsupportedAmount);
  const fallbackImpact = defaultInvoiceImpact(primaryApprovalStatus, invoiceLabelValue, affectedAmount);
  const title = invoiceDecisionTitle(invoice.invoice_number);
  const problem = pickProblem(relatedFindings, fallbackProblem);
  const impact = pickImpact(relatedFindings, fallbackImpact);
  const requiredAction = pickRequiredAction(
    relatedFindings,
    defaultInvoiceRequiredAction(invoice),
  );
  const evidenceRefs = uniqueStrings(
    relatedFindings.flatMap((finding) => findingEvidenceRefs(finding)),
  );
  const sourceDocumentIds = uniqueStrings(
    relatedFindings.flatMap((finding) => findingSourceDocumentIds(finding)),
  );
  const lineContexts = invoiceLineContexts(relatedFindings);
  const sourceFamily = dominantSourceFamily(relatedFindings);
  const summary = buildDecisionSummary(problem, impact);
  const primary = primaryFinding(relatedFindings);
  const identityKey = `validator:${projectId}:invoice:${invoice.invoice_number ?? `unknown-${invoiceIndex}`}`;
  const billedAmount = exposureInvoice?.billed_amount ?? invoice.billed_amount ?? null;
  const atRiskAmount = exposureInvoice?.at_risk_amount ?? invoice.at_risk_amount ?? null;
  const requiresVerificationAmount =
    exposureInvoice?.requires_verification_amount
    ?? unsupportedAmount
    ?? atRiskAmount
    ?? null;
  const supportedAmount = exposureInvoice?.supported_amount ?? invoice.supported_amount ?? null;
  const blockingReasonCodes = invoice.reasons.map((reason) => reason);
  const blockingReasons = invoice.reasons.map(reasonLabel);
  const requiredReviews = Math.max(
    relatedFindings.length,
    primaryApprovalStatus === 'approved' ? 0 : 1,
  );

  return {
    identity_key: identityKey,
    decision_type: 'validator_invoice_approval',
    title,
    summary,
    severity: decisionSeverityForPrimaryStatus(primaryApprovalStatus),
    status: decisionStatusForPrimaryApproval(primaryApprovalStatus),
    document_id: primarySourceDocumentId(relatedFindings),
    finding_ids: [...invoice.finding_ids],
    link_finding_ids: [...invoice.finding_ids],
    details: {
      origin: 'project_validator',
      source_label: 'Validator output',
      identity_key: identityKey,
      primary_approval_decision: true,
      approval_context: 'invoice',
      approval_context_key: identityKey,
      validator_decision_kind: 'invoice_approval',
      approval_status: primaryApprovalStatus,
      gate_approval_status: invoice.approval_status,
      approval_impact: approvalImpactLabelForPrimaryStatus(primaryApprovalStatus),
      validator_finding_ids: [...invoice.finding_ids],
      source_finding_ids: [...invoice.finding_ids],
      evidence_refs: evidenceRefs,
      source_document_ids: sourceDocumentIds,
      invoice_line_contexts: lineContexts,
      source_family: sourceFamily,
      invoice_number: invoice.invoice_number,
      total_billed_amount: billedAmount,
      affected_amount: affectedAmount,
      blocked_amount: primaryApprovalStatus === 'blocked' ? billedAmount : null,
      unsupported_amount: unsupportedAmount,
      at_risk_amount: atRiskAmount,
      requires_verification_amount: requiresVerificationAmount,
      billed_amount: billedAmount,
      supported_amount: supportedAmount,
      required_reviews: requiredReviews,
      blocking_reason_codes: blockingReasonCodes,
      blocking_reasons: blockingReasons,
      gate_reasons: blockingReasons,
      approval_gate_effects: findingApprovalGateEffects(relatedFindings),
      exposure_types: findingExposureTypes(relatedFindings),
      source_validator_run_id: runId,
      problem,
      impact,
      required_action: requiredAction,
      primary_rule_id: primary?.rule_id ?? null,
      primary_subject_id: primary?.subject_id ?? null,
      ...primaryComparisonContext(primary),
    },
  };
}

function buildProjectDecisionRecord(params: {
  projectId: string;
  runId: string;
  gate: ProjectApprovalDecision;
  findings: PersistableValidationFinding[];
  sourceFindingIds: string[];
  linkFindingIds: string[];
  totalRequiresVerificationAmount: number | null;
  unsupportedAmount: number | null;
  totalBilledAmount: number | null;
  supportedAmount: number | null;
}): ValidatorDecisionRecord {
  const {
    projectId,
    runId,
    gate,
    findings,
    sourceFindingIds,
    linkFindingIds,
    totalRequiresVerificationAmount,
    unsupportedAmount,
    totalBilledAmount,
    supportedAmount,
  } = params;
  const primaryApprovalStatus = simplifyApprovalStatus(gate.approval_status);
  const blockedAmount = gate.blocked_amount > 0 ? gate.blocked_amount : null;
  const atRiskAmount = gate.at_risk_amount > 0 ? gate.at_risk_amount : null;
  const requiredReviews = Math.max(
    sourceFindingIds.length,
    primaryApprovalStatus === 'approved' ? 0 : 1,
  );
  const blockingReasonCodes = gate.reasons.map((reason) => reason);
  const blockingReasons = gate.reasons.map(reasonLabel);
  const problem = pickProblem(findings, defaultProjectProblem(gate.reasons, primaryApprovalStatus));
  const impact = pickImpact(findings, defaultProjectImpact({
    approvalStatus: primaryApprovalStatus,
    blockedAmount,
    atRiskAmount,
  }));
  const requiredAction = pickRequiredAction(
    findings,
    defaultProjectRequiredAction(gate.reasons, primaryApprovalStatus),
  );
  const evidenceRefs = uniqueStrings(
    findings.flatMap((finding) => findingEvidenceRefs(finding)),
  );
  const sourceDocumentIds = uniqueStrings(
    findings.flatMap((finding) => findingSourceDocumentIds(finding)),
  );
  const sourceFamily = dominantSourceFamily(findings);
  const affectedAmount =
    totalRequiresVerificationAmount
    ?? unsupportedAmount
    ?? blockedAmount
    ?? atRiskAmount
    ?? totalAffectedAmount(findings);
  const summary = buildDecisionSummary(problem, impact);
  const primary = primaryFinding(findings);
  const identityKey = `validator:${projectId}:project:approval`;

  return {
    identity_key: identityKey,
    decision_type: 'validator_project_approval',
    title: projectDecisionTitle(),
    summary,
    severity: decisionSeverityForPrimaryStatus(primaryApprovalStatus),
    status: decisionStatusForPrimaryApproval(primaryApprovalStatus),
    document_id: primarySourceDocumentId(findings),
    finding_ids: [...sourceFindingIds],
    link_finding_ids: [...linkFindingIds],
    details: {
      origin: 'project_validator',
      source_label: 'Validator output',
      identity_key: identityKey,
      primary_approval_decision: true,
      approval_context: 'project',
      approval_context_key: identityKey,
      validator_decision_kind: 'project_approval',
      approval_status: primaryApprovalStatus,
      gate_approval_status: gate.approval_status,
      approval_impact: approvalImpactLabelForPrimaryStatus(primaryApprovalStatus),
      validator_finding_ids: [...sourceFindingIds],
      source_finding_ids: [...sourceFindingIds],
      evidence_refs: evidenceRefs,
      source_document_ids: sourceDocumentIds,
      source_family: sourceFamily,
      total_billed_amount: totalBilledAmount,
      affected_amount: affectedAmount,
      blocked_amount: blockedAmount,
      at_risk_amount: atRiskAmount,
      unsupported_amount: unsupportedAmount,
      requires_verification_amount: totalRequiresVerificationAmount,
      supported_amount: supportedAmount,
      required_reviews: requiredReviews,
      gate_reasons: blockingReasons,
      blocking_reason_codes: blockingReasonCodes,
      blocking_reasons: blockingReasons,
      approval_gate_effects: findingApprovalGateEffects(findings),
      exposure_types: findingExposureTypes(findings),
      source_validator_run_id: runId,
      problem,
      impact,
      required_action: requiredAction,
      primary_rule_id: primary?.rule_id ?? null,
      primary_subject_id: primary?.subject_id ?? null,
    },
  };
}

export function buildValidatorDecisionRecords(params: {
  projectId: string;
  runId: string;
  result: ValidatorResult;
  findings: PersistableValidationFinding[];
}): ValidatorDecisionRecord[] {
  const normalizedOpenFindings = params.findings
    .filter((finding) => finding.status === 'open')
    .map((finding) => normalizeValidationFinding(finding) as PersistableValidationFinding);

  const actionableFindings = normalizedOpenFindings.filter(
    (finding) =>
      finding.action_eligible === true
      && (isBlockingFinding(finding) || isReviewFinding(finding) || finding.decision_eligible),
  );

  const hasApprovalContext =
    params.result.status !== 'NOT_READY'
    || params.result.exposure != null
    || params.result.reconciliation != null
    || params.result.contract_invoice_reconciliation != null
    || params.result.invoice_transaction_reconciliation != null;

  if (!hasApprovalContext && actionableFindings.length === 0) {
    return [];
  }

  const gate = evaluateApprovalGate({
    ...params.result,
    findings: actionableFindings,
  });
  const exposureInvoices = params.result.exposure?.invoices ?? [];
  const invoiceRecords = gate.invoices.map((invoice, invoiceIndex) => {
    const exposureInvoice = exposureInvoices.find((candidate) => (
      candidate.invoice_number === invoice.invoice_number
      || (candidate.invoice_number == null && invoice.invoice_number == null)
    )) ?? null;

    return buildInvoiceDecisionRecord({
      projectId: params.projectId,
      runId: params.runId,
      invoiceIndex,
      invoice,
      exposureInvoice,
      findings: actionableFindings,
    });
  });

  const invoiceFindingIdSet = new Set(
    invoiceRecords.flatMap((record) => record.finding_ids),
  );
  const projectScopedFindings = actionableFindings.filter(
    (finding) => !invoiceFindingIdSet.has(finding.id),
  );
  const totalRequiresVerificationAmount =
    params.result.summary.requires_verification_amount
    ?? params.result.exposure?.total_requires_verification_amount
    ?? null;
  const unsupportedAmount =
    params.result.summary.unsupported_amount
    ?? params.result.exposure?.total_unreconciled_amount
    ?? null;
  const totalAtRiskAmount =
    params.result.summary.at_risk_amount
    ?? params.result.exposure?.total_at_risk_amount
    ?? null;
  const hasOperatorDecisionWork =
    actionableFindings.length > 0
    || (totalRequiresVerificationAmount ?? 0) > 0
    || (unsupportedAmount ?? 0) > 0
    || (totalAtRiskAmount ?? 0) > 0;
  const projectGate = hasOperatorDecisionWork
    ? gate.project
    : {
        ...gate.project,
        approval_status: 'approved' as const,
        reasons: [],
        finding_ids: [],
        blocked_amount: 0,
        at_risk_amount: 0,
      };
  const projectFindingsForDetails =
    projectScopedFindings.length > 0
      ? projectScopedFindings
      : actionableFindings;
  const projectRecord = hasApprovalContext
    ? buildProjectDecisionRecord({
        projectId: params.projectId,
        runId: params.runId,
        gate: projectGate,
        findings: projectFindingsForDetails,
        sourceFindingIds: actionableFindings.map((finding) => finding.id),
        linkFindingIds: projectScopedFindings.map((finding) => finding.id),
        totalRequiresVerificationAmount,
        unsupportedAmount,
        totalBilledAmount:
          params.result.summary.total_billed
          ?? params.result.exposure?.total_billed_amount
          ?? null,
        supportedAmount:
          params.result.exposure?.total_fully_reconciled_amount
          ?? null,
      })
    : null;

  const records = projectRecord ? [projectRecord, ...invoiceRecords] : invoiceRecords;
  return records;
}

function isOperatorManagedDecision(row: ExistingValidatorDecisionRow): boolean {
  return row.status !== 'open'
    && row.status !== 'in_review'
    || row.assigned_to != null
    || row.assigned_at != null
    || row.due_at != null;
}

async function loadExistingValidatorDecisions(
  admin: SupabaseClient,
  params: {
    projectId: string;
    organizationId: string;
  },
): Promise<ExistingValidatorDecisionRow[]> {
  const { data, error } = await admin
    .from('decisions')
    .select('id, decision_type, document_id, title, summary, severity, status, assigned_to, assigned_at, due_at, details')
    .eq('project_id', params.projectId)
    .eq('source', 'project_validator');

  if (!error) {
    return (data ?? []) as ExistingValidatorDecisionRow[];
  }

  // Back-compat: some deployments may not have `decisions.project_id` yet.
  // Fall back to org-scoped validator decisions and match via identity_key prefix.
  if (!isMissingColumnError(error, 'project_id')) {
    throw new Error(`Failed to load validator decisions for ${params.projectId}: ${error.message}`);
  }

  const fallback = await admin
    .from('decisions')
    .select('id, organization_id, decision_type, document_id, title, summary, severity, status, assigned_to, assigned_at, due_at, details')
    .eq('organization_id', params.organizationId)
    .eq('source', 'project_validator');

  if (fallback.error) {
    throw new Error(`Failed to load validator decisions for ${params.projectId}: ${fallback.error.message}`);
  }

  const prefix = `validator:${params.projectId}:`;
  return ((fallback.data ?? []) as ExistingValidatorDecisionRow[]).filter((row) => {
    const identityKey = getIdentityKey(row.details);
    return identityKey != null && identityKey.startsWith(prefix);
  });
}

function withSupersededDetails(
  details: Record<string, unknown> | null | undefined,
  supersededAt: string,
): Record<string, unknown> {
  return {
    ...(details ?? {}),
    superseded_at: supersededAt,
    active: false,
  };
}

async function updateFindingDecisionLinks(
  admin: SupabaseClient,
  runId: string,
  decisionIdsByIdentityKey: Map<string, string>,
  records: readonly ValidatorDecisionRecord[],
): Promise<void> {
  const allFindingIds = records.flatMap((record) => record.link_finding_ids);
  if (allFindingIds.length === 0) return;

  const { error: clearError } = await admin
    .from('project_validation_findings')
    .update({
      linked_decision_id: null,
    })
    .eq('run_id', runId);

  if (clearError) {
    throw new Error(`Failed to clear validator decision links for run ${runId}: ${clearError.message}`);
  }

  for (const record of records) {
    if (record.link_finding_ids.length === 0) continue;
    const decisionId = decisionIdsByIdentityKey.get(record.identity_key);
    if (!decisionId) continue;

    const { error } = await admin
      .from('project_validation_findings')
      .update({
        linked_decision_id: decisionId,
      })
      .in('id', record.link_finding_ids);

    if (error) {
      throw new Error(`Failed to link validator decision ${decisionId}: ${error.message}`);
    }
  }
}

function hasMeaningfulDecisionChange(
  existingRow: ExistingValidatorDecisionRow,
  record: ValidatorDecisionRecord,
): boolean {
  return (
    existingRow.document_id !== record.document_id
    || existingRow.decision_type !== record.decision_type
    || existingRow.title !== record.title
    || (existingRow.summary ?? null) !== record.summary
    || existingRow.severity !== record.severity
    || existingRow.status !== record.status
    || JSON.stringify(existingRow.details ?? null) !== JSON.stringify(record.details)
  );
}

async function logValidatorDecisionActivity(params: {
  organizationId: string;
  projectId: string;
  decisionId: string;
  eventType: 'created' | 'updated';
  previousRow?: ExistingValidatorDecisionRow | null;
  record: ValidatorDecisionRecord;
}): Promise<void> {
  const details = params.record.details;
  if (details.primary_approval_decision !== true) return;

  const result = await logActivityEvent({
    organization_id: params.organizationId,
    project_id: params.projectId,
    entity_type: 'decision',
    entity_id: params.decisionId,
    event_type: params.eventType,
    changed_by: null,
    old_value: params.previousRow
      ? {
          status: params.previousRow.status,
          decision_type: params.previousRow.decision_type,
          approval_status:
            typeof params.previousRow.details?.approval_status === 'string'
              ? params.previousRow.details.approval_status
              : null,
        }
      : null,
    new_value: {
      decision_type: params.record.decision_type,
      title: params.record.title,
      status: params.record.status,
      approval_context: details.approval_context ?? null,
      approval_status: details.approval_status ?? null,
      invoice_number: details.invoice_number ?? null,
      blocked_amount: details.blocked_amount ?? null,
      unsupported_amount: details.unsupported_amount ?? null,
      at_risk_amount: details.at_risk_amount ?? null,
      required_reviews: details.required_reviews ?? null,
      source_validator_run_id: details.source_validator_run_id ?? null,
    },
  });

  if (!result.ok) {
    console.error('[syncValidatorDecisions] failed to log validator decision activity', {
      projectId: params.projectId,
      decisionId: params.decisionId,
      eventType: params.eventType,
      error: result.error,
    });
  }
}

export async function syncValidatorDecisions(params: {
  admin: SupabaseClient;
  projectId: string;
  organizationId: string;
  projectContext?: { label: string; project_id: string; project_code: string | null } | null;
  runId: string;
  result: ValidatorResult;
  findings: PersistableValidationFinding[];
}): Promise<SyncValidatorDecisionsResult> {
  const { admin, projectId, organizationId, runId, result, findings, projectContext } = params;
  const records = buildValidatorDecisionRecords({
    projectId,
    runId,
    result,
    findings,
  }).map((record) => ({
    ...record,
    details: withProjectContextDetails({ details: record.details, projectContext }),
  }));
  const existing = await loadExistingValidatorDecisions(admin, { projectId, organizationId });
  const existingByIdentityKey = new Map(
    existing
      .map((row) => [getIdentityKey(row.details), row] as const)
      .filter((entry): entry is [string, ExistingValidatorDecisionRow] => entry[0] != null),
  );
  const matchedIds = new Set<string>();
  const decisionIdsByIdentityKey = new Map<string, string>();
  const now = new Date().toISOString();

  let created = 0;
  let updated = 0;

  for (const record of records) {
    const existingRow = existingByIdentityKey.get(record.identity_key);
    if (existingRow) {
      const { error } = await admin
        .from('decisions')
        .update({
          project_id: projectId,
          document_id: record.document_id,
          decision_type: record.decision_type,
          title: record.title,
          summary: record.summary,
          severity: record.severity,
          status: record.status,
          details: record.details,
          last_detected_at: now,
          updated_at: now,
        })
        .eq('id', existingRow.id);

      if (error) {
        throw new Error(`Failed to update validator decision ${existingRow.id}: ${error.message}`);
      }

      if (hasMeaningfulDecisionChange(existingRow, record)) {
        await logValidatorDecisionActivity({
          organizationId,
          projectId,
          decisionId: existingRow.id,
          eventType: 'updated',
          previousRow: existingRow,
          record,
        });
      }

      matchedIds.add(existingRow.id);
      decisionIdsByIdentityKey.set(record.identity_key, existingRow.id);
      updated += 1;
      continue;
    }

    const { data, error } = await admin
        .from('decisions')
        .insert({
          organization_id: organizationId,
          project_id: projectId,
          document_id: record.document_id,
        decision_type: record.decision_type,
        title: record.title,
        summary: record.summary,
        severity: record.severity,
        status: record.status,
        confidence: 1,
        details: record.details,
        source: 'project_validator',
        first_detected_at: now,
        last_detected_at: now,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (error || !data?.id) {
      // Back-compat: retry without project_id if column is missing.
      if (error && isMissingColumnError(error, 'project_id')) {
        const retry = await admin
          .from('decisions')
          .insert({
            organization_id: organizationId,
            document_id: record.document_id,
            decision_type: record.decision_type,
            title: record.title,
            summary: record.summary,
            severity: record.severity,
            status: record.status,
            confidence: 1,
            details: record.details,
            source: 'project_validator',
            first_detected_at: now,
            last_detected_at: now,
            created_at: now,
            updated_at: now,
          })
          .select('id')
          .single();

        if (retry.error || !retry.data?.id) {
          throw new Error(`Failed to insert validator decision ${record.identity_key}: ${retry.error?.message ?? 'unknown error'}`);
        }

        matchedIds.add(retry.data.id);
        decisionIdsByIdentityKey.set(record.identity_key, retry.data.id);
        await logValidatorDecisionActivity({
          organizationId,
          projectId,
          decisionId: retry.data.id,
          eventType: 'created',
          previousRow: null,
          record,
        });
        created += 1;
        continue;
      }

      throw new Error(`Failed to insert validator decision ${record.identity_key}: ${error?.message ?? 'unknown error'}`);
    }

    matchedIds.add(data.id);
    decisionIdsByIdentityKey.set(record.identity_key, data.id);
    await logValidatorDecisionActivity({
      organizationId,
      projectId,
      decisionId: data.id,
      eventType: 'created',
      previousRow: null,
      record,
    });
    created += 1;
  }

  let suppressed = 0;
  for (const row of existing) {
    if (matchedIds.has(row.id)) continue;
    if (isOperatorManagedDecision(row)) continue;

    const { error } = await admin
      .from('decisions')
      .update({
        status: 'dismissed',
        details: withSupersededDetails(row.details, now),
        updated_at: now,
      })
      .eq('id', row.id);

    if (error) {
      throw new Error(`Failed to suppress stale validator decision ${row.id}: ${error.message}`);
    }

    suppressed += 1;
  }

  await updateFindingDecisionLinks(admin, runId, decisionIdsByIdentityKey, records);

  return {
    created,
    updated,
    suppressed,
    decisionIdsByIdentityKey,
  };
}
