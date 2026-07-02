import type {
  ContractInvoiceReconciliationSummary,
  CrossDocumentRateVerificationSummary,
  FirstDocumentToInspect,
  InvoiceExceptionEligibility,
  InvoiceExposureSummary,
  InvoiceTransactionReconciliationSummary,
  ProjectValidationPhase,
  ProjectExposureSummary,
  ProjectReconciliationSummary,
  ReviewedDocumentWithWarnings,
  ValidationFinding,
  ValidationStatus,
  ValidationSummary,
  ValidationTriggerSource,
  ValidatorStatus,
  ValidatorSummaryItem,
} from '@/types/validator';
import type {
  ContractAnalysisResult,
  ContractFieldAnalysis,
} from '@/lib/contracts/types';
import {
  canonicalizeRelationshipType,
  resolveDocumentPrecedence,
  resolveDocumentTruthCategoryIds,
  type DocumentRelationshipRecord,
  type GoverningDocumentFamily,
  type ResolvedDocumentPrecedenceFamily,
  type ResolvedDocumentPrecedenceRecord,
} from '@/lib/documentPrecedence';
import {
  blockerFindingCount,
  infoFindingCount,
  isBlockingFinding,
  normalizeValidationFinding,
  requiresReviewFindingCount,
  warningFindingCount,
} from '@/lib/validator/findingSemantics';
import {
  primaryApprovalStatusToValidationStatus,
  primaryApprovalStatusToValidatorStatus,
  resolveInvoicePrimaryApprovalDecisions,
  resolveProjectPrimaryApprovalDecision,
  type PrimaryApprovalDecisionInput,
} from '@/lib/validator/primaryApprovalDecision';
import {
  PROJECT_TERM_AT_RISK_AMOUNT,
  PROJECT_TERM_INVOICE_BILLED_AMOUNT,
  PROJECT_TERM_TOTAL_TRANSACTION_ROWS,
  PROJECT_TERM_UNIQUE_TICKET_NUMBERS,
  PROJECT_TERM_UNSUPPORTED_AMOUNT,
  PROJECT_TERM_WORKBOOK_INVOICED_AMOUNT,
} from '@/lib/projectTerminology';
import {
  buildDisposalSiteGroups,
  buildInvoiceGroups,
  buildMaterialGroups,
  buildRateCodeGroups,
  buildSiteTypeGroups,
  buildTicketGrainQuantityFacts,
  effectiveMaterial,
  hasInvoiceLink,
  normalizeEligibility,
  roundNumber,
  ticketGrainKey,
  uniqueStrings,
  type NormalizedTransactionDataRecord,
} from '@/lib/extraction/xlsx/normalizeTransactionData';
import { normalizeInvoiceNumber } from '@/lib/validator/billingKeys';

/**
 * Consumer-facing normalized project truth snapshot.
 *
 * Upstream truth still comes from the validator input assembly path in
 * `lib/validator/projectValidator.ts`, which resolves document precedence,
 * human overrides, human reviews, canonical persisted truth, normalized
 * extraction rows, and legacy extraction blobs into the persisted project
 * validation summary. Project-facing consumers should read that resolved layer
 * rather than reparsing mixed truth independently.
 */
export type CanonicalProjectFacts = {
  status: ValidationStatus;
  validation_phase: ProjectValidationPhase;
  last_run_at: string | null;
  critical_count: number;
  warning_count: number;
  info_count: number;
  blocker_count: number;
  requires_review_count: number;
  open_count: number;
  blocked_reasons: string[];
  trigger_source: ValidationTriggerSource | null;
  validator_status: ValidatorStatus | null;
  readiness: ValidationStatus | ValidatorStatus | 'NOT_READY' | null;
  validator_open_items: ValidatorSummaryItem[];
  validator_blockers: ValidatorSummaryItem[];
  contract_invoice_reconciliation: ContractInvoiceReconciliationSummary | null;
  invoice_transaction_reconciliation: InvoiceTransactionReconciliationSummary | null;
  cross_document_rate_verification: CrossDocumentRateVerificationSummary | null;
  reconciliation: ProjectReconciliationSummary | null;
  exposure: ProjectExposureSummary | null;
  nte_amount: number | null;
  total_billed: number | null;
  exposure_total_billed: number | null;
  blocked_amount: number | null;
  total_at_risk: number | null;
  requires_verification_amount: number | null;
  requires_verification: boolean | null;
  unsupported_amount: number | null;
  reconciliation_overall: string | null;
  invoice_exception_eligibility: InvoiceExceptionEligibility | null;
  reviewed_documents_with_warnings: ReviewedDocumentWithWarnings[];
  first_document_to_inspect: FirstDocumentToInspect | null;
  contract_document_id: string | null;
};

export type CanonicalProjectInvoiceApprovalStatus =
  | 'approved'
  | 'approved_with_exceptions'
  | 'needs_review'
  | 'blocked';

export type CanonicalProjectInvoiceSummary = {
  invoice_number: string | null;
  approval_status: CanonicalProjectInvoiceApprovalStatus;
  billed_amount: number | null;
  billed_amount_source: InvoiceExposureSummary['billed_amount_source'];
  supported_amount: number | null;
  at_risk_amount: number | null;
  requires_verification_amount: number | null;
  reconciliation_status: InvoiceExposureSummary['reconciliation_status'];
};

export type CanonicalProjectValidationSnapshot = {
  facts: CanonicalProjectFacts;
  invoice_summaries: CanonicalProjectInvoiceSummary[];
  blocked_amount: number | null;
};

export type CanonicalProjectTruthState =
  | 'resolved'
  | 'missing'
  | 'conflicted'
  | 'derived'
  | 'unresolved'
  | 'requires_review';

export type CanonicalProjectTruthRow = {
  key: string;
  label: string;
  value: string;
  source_label: string;
  state: CanonicalProjectTruthState;
};

export type CanonicalProjectTruthSection = {
  key: 'contract' | 'invoice' | 'transaction' | 'validation';
  title: string;
  rows: CanonicalProjectTruthRow[];
};

export type CanonicalProjectOverviewSummaryItem = {
  key:
    | 'validation_status'
    | 'readiness'
    | 'blockers'
    | 'warnings'
    | 'at_risk_amount'
    | 'required_reviews';
  label: string;
  value: string;
  state: CanonicalProjectTruthState;
};

export type CanonicalProjectOverviewSignal = {
  key:
    | 'approval_blockers'
    | 'missing_support'
    | 'unresolved_invoice_truth'
    | 'contract_risk';
  title: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
  gate_impact: string;
  next_action: string;
};

export type CanonicalProjectOverviewBriefing = {
  summary_items: CanonicalProjectOverviewSummaryItem[];
  critical_signals: CanonicalProjectOverviewSignal[];
  snapshot_sections: Array<{
    key: 'contract' | 'invoice' | 'transaction';
    title: string;
    rows: CanonicalProjectTruthRow[];
  }>;
};

export type CanonicalProjectTruthDocumentInput = {
  id: string;
  title: string | null;
  name: string;
  project_id?: string | null;
  document_type?: string | null;
  document_role?: string | null;
  document_subtype?: string | null;
  authority_status?: string | null;
  effective_date?: string | null;
  precedence_rank?: number | null;
  operator_override_precedence?: boolean | null;
  created_at?: string | null;
  intelligence_trace?: unknown;
};

export type CanonicalProjectDocumentRelationshipInput = {
  id?: string;
  project_id?: string | null;
  source_document_id: string;
  target_document_id: string;
  relationship_type: string;
  created_by?: string | null;
  created_at?: string | null;
};

export type CanonicalProjectDecisionInput = PrimaryApprovalDecisionInput;

export type CanonicalProjectTransactionDatasetInput = {
  document_id: string;
  row_count: number | null;
  date_range_start: string | null;
  date_range_end: string | null;
  summary_json: Record<string, unknown> | null;
  created_at: string | null;
  rows?: readonly CanonicalProjectTransactionRowInput[];
};

export type CanonicalProjectTransactionRowInput = {
  id?: string | null;
  document_id?: string | null;
  project_id?: string | null;
  invoice_number?: string | null;
  transaction_number?: string | null;
  rate_code?: string | null;
  billing_rate_key?: string | null;
  description_match_key?: string | null;
  site_material_key?: string | null;
  invoice_rate_key?: string | null;
  transaction_quantity?: number | null;
  extended_cost?: number | null;
  invoice_date?: string | null;
  source_sheet_name?: string | null;
  source_row_number?: number | null;
  record_json?: Record<string, unknown> | null;
  raw_row_json?: Record<string, unknown> | null;
  created_at?: string | null;
};

export type CanonicalProjectValidatorStatusItem = {
  key:
    | 'approval_status'
    | 'readiness'
    | 'blockers'
    | 'warnings'
    | 'at_risk_amount'
    | 'unsupported_amount';
  label: string;
  value: string;
  source_label: string;
  state: CanonicalProjectTruthState;
};

export type CanonicalProjectValidatorMismatch = {
  key: string;
  label: string;
  expected_value: string;
  actual_value: string;
  impact: string;
  severity: 'critical' | 'warning' | 'info';
};

export type CanonicalProjectValidatorRelationshipBlock = {
  key: 'contract_invoice' | 'invoice_transaction' | 'invoice_support' | 'cross_document_rate';
  title: string;
  description: string;
  source_label: string;
  mismatches: CanonicalProjectValidatorMismatch[];
};

export type CanonicalProjectValidatorCoverageItem = {
  key: 'missing_supporting_data' | 'incomplete_evidence' | 'unresolved_required_fields';
  label: string;
  value: string;
  detail: string;
  impact: string;
  source_label: string;
  state: CanonicalProjectTruthState;
};

export type CanonicalProjectValidatorWorkspace = {
  status_items: CanonicalProjectValidatorStatusItem[];
  relationship_blocks: CanonicalProjectValidatorRelationshipBlock[];
  coverage_items: CanonicalProjectValidatorCoverageItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
}

function readInvoiceExceptionEligibility(value: unknown): InvoiceExceptionEligibility | null {
  if (!isRecord(value)) return null;
  const open_ticket_count = readNumber(value.open_ticket_count);
  const approval_gate_basis = readString(value.approval_gate_basis);
  const exception_type = readString(value.exception_type);
  const required_approval_condition = readString(value.required_approval_condition);

  if (
    open_ticket_count == null
    || !approval_gate_basis
    || !exception_type
    || !required_approval_condition
  ) {
    return null;
  }

  return {
    open_ticket_count,
    approval_gate_basis,
    exception_type,
    required_approval_condition,
  };
}

function readReviewedDocumentsWithWarnings(value: unknown): ReviewedDocumentWithWarnings[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const document_id = readString(entry.document_id);
    const warning_count = readNumber(entry.warning_count);
    const review_event_source = readString(entry.review_event_source);
    if (!document_id || warning_count == null || !review_event_source) return [];

    return [{
      document_id,
      warning_count,
      review_event_source,
    }];
  });
}

function readFirstDocumentToInspect(value: unknown): FirstDocumentToInspect | null {
  if (!isRecord(value)) return null;
  const document_id = readString(value.document_id);
  const risk_reason = readString(value.risk_reason);
  const priority_source = readString(value.priority_source);
  if (!document_id || !risk_reason || !priority_source) return null;

  return {
    document_id,
    risk_reason,
    linked_action_id: readString(value.linked_action_id),
    priority_source,
  };
}

function isValidationStatus(value: unknown): value is ValidationStatus {
  return (
    value === 'NOT_READY'
    || value === 'BLOCKED'
    || value === 'VALIDATED'
    || value === 'FINDINGS_OPEN'
  );
}

function isValidationTriggerSource(value: unknown): value is ValidationTriggerSource {
  return (
    value === 'document_processed'
    || value === 'fact_override'
    || value === 'review_confirmed'
    || value === 'review_flagged'
    || value === 'review_corrected'
    || value === 'override_applied'
    || value === 'relationship_change'
    || value === 'manual'
  );
}

function isValidatorStatus(value: unknown): value is ValidatorStatus {
  return value === 'READY' || value === 'BLOCKED' || value === 'NEEDS_REVIEW';
}

function isProjectValidationPhase(value: unknown): value is ProjectValidationPhase {
  return (
    value === 'contract_setup'
    || value === 'execution'
    || value === 'billing_review'
    || value === 'closeout'
  );
}

function readSummaryItems(value: unknown): ValidatorSummaryItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];

    const rule_id = readString(entry.rule_id);
    const severity =
      entry.severity === 'critical' || entry.severity === 'warning' || entry.severity === 'info'
        ? entry.severity
        : null;
    const subject_type = readString(entry.subject_type);
    const subject_id = readString(entry.subject_id);
    const field = entry.field == null ? null : readString(entry.field);
    const message = readString(entry.message);
    const fact_keys = readStringArray(entry.fact_keys);
    const finding_disposition =
      entry.finding_disposition === 'blocker'
      || entry.finding_disposition === 'warning'
      || entry.finding_disposition === 'info'
      || entry.finding_disposition === 'requires_review'
        ? entry.finding_disposition
        : null;
    const business_severity =
      entry.business_severity === 'critical'
      || entry.business_severity === 'high'
      || entry.business_severity === 'medium'
      || entry.business_severity === 'low'
        ? entry.business_severity
        : null;
    const source_family =
      entry.source_family === 'contract'
      || entry.source_family === 'invoice'
      || entry.source_family === 'transaction'
      || entry.source_family === 'support'
      || entry.source_family === 'project'
      || entry.source_family === 'cross_document'
      || entry.source_family === 'system'
        ? entry.source_family
        : null;
    const approval_gate_effect =
      entry.approval_gate_effect === 'blocks_approval'
      || entry.approval_gate_effect === 'requires_operator_review'
      || entry.approval_gate_effect === 'informational'
        ? entry.approval_gate_effect
        : null;
    const exposure_type =
      entry.exposure_type === 'unsupported_amount'
      || entry.exposure_type === 'rate_mismatch'
      || entry.exposure_type === 'missing_support'
      || entry.exposure_type === 'invoice_total_mismatch'
      || entry.exposure_type === 'missing_governing_contract'
      || entry.exposure_type === 'missing_transaction_support'
      || entry.exposure_type === 'other'
        ? entry.exposure_type
        : null;

    if (!rule_id || !severity || !subject_type || !subject_id || !message) {
      return [];
    }

    return [{
      rule_id,
      severity,
      subject_type,
      subject_id,
      field,
      fact_keys,
      message,
      finding_disposition,
      business_severity,
      problem: readString(entry.problem),
      impact: readString(entry.impact),
      required_action: readString(entry.required_action),
      evidence_refs: readStringArray(entry.evidence_refs),
      source_family,
      affected_amount:
        entry.affected_amount == null ? null : readNumber(entry.affected_amount),
      approval_gate_effect,
      exposure_type,
    }];
  });
}

function isContractInvoiceReconciliationStatus(
  value: unknown,
): value is ContractInvoiceReconciliationSummary['vendor_identity_status'] {
  return value === 'MATCH' || value === 'MISMATCH' || value === 'MISSING' || value === 'PARTIAL';
}

function readContractInvoiceReconciliationSummary(
  value: unknown,
): ContractInvoiceReconciliationSummary | null {
  if (!isRecord(value)) return null;

  const matched_invoice_lines = readNumber(value.matched_invoice_lines);
  const unmatched_invoice_lines = readNumber(value.unmatched_invoice_lines);
  const rate_mismatches = readNumber(value.rate_mismatches);
  const vendor_identity_status = value.vendor_identity_status;
  const client_identity_status = value.client_identity_status;
  const service_period_status = value.service_period_status;
  const invoice_total_status = value.invoice_total_status;

  if (
    matched_invoice_lines == null
    || unmatched_invoice_lines == null
    || rate_mismatches == null
    || !isContractInvoiceReconciliationStatus(vendor_identity_status)
    || !isContractInvoiceReconciliationStatus(client_identity_status)
    || !isContractInvoiceReconciliationStatus(service_period_status)
    || !isContractInvoiceReconciliationStatus(invoice_total_status)
  ) {
    return null;
  }

  return {
    matched_invoice_lines,
    unmatched_invoice_lines,
    rate_mismatches,
    vendor_identity_status,
    client_identity_status,
    service_period_status,
    invoice_total_status,
  };
}

function readInvoiceTransactionReconciliationSummary(
  value: unknown,
): InvoiceTransactionReconciliationSummary | null {
  if (!isRecord(value)) return null;

  const matched_groups = readNumber(value.matched_groups);
  const unmatched_groups = readNumber(value.unmatched_groups);
  const cost_mismatches = readNumber(value.cost_mismatches);
  const quantity_mismatches = readNumber(value.quantity_mismatches);
  const orphan_transactions = readNumber(value.orphan_transactions);
  const outlier_rows = readNumber(value.outlier_rows);

  if (
    matched_groups == null
    || unmatched_groups == null
    || cost_mismatches == null
    || quantity_mismatches == null
    || orphan_transactions == null
    || outlier_rows == null
  ) {
    return null;
  }

  return {
    matched_groups,
    unmatched_groups,
    cost_mismatches,
    quantity_mismatches,
    orphan_transactions,
    outlier_rows,
  };
}

function readProjectReconciliationSummary(
  value: unknown,
): ProjectReconciliationSummary | null {
  if (!isRecord(value)) return null;

  const contract_invoice_status = value.contract_invoice_status;
  const invoice_transaction_status = value.invoice_transaction_status;
  const overall_reconciliation_status = value.overall_reconciliation_status;
  const matched_billing_groups = readNumber(value.matched_billing_groups);
  const unmatched_billing_groups = readNumber(value.unmatched_billing_groups);
  const rate_mismatches = readNumber(value.rate_mismatches);
  const quantity_mismatches = readNumber(value.quantity_mismatches);
  const orphan_invoice_lines = readNumber(value.orphan_invoice_lines);
  const orphan_transactions = readNumber(value.orphan_transactions);

  if (
    !isContractInvoiceReconciliationStatus(contract_invoice_status)
    || !isContractInvoiceReconciliationStatus(invoice_transaction_status)
    || !isContractInvoiceReconciliationStatus(overall_reconciliation_status)
    || matched_billing_groups == null
    || unmatched_billing_groups == null
    || rate_mismatches == null
    || quantity_mismatches == null
    || orphan_invoice_lines == null
    || orphan_transactions == null
  ) {
    return null;
  }

  return {
    contract_invoice_status,
    invoice_transaction_status,
    overall_reconciliation_status,
    matched_billing_groups,
    unmatched_billing_groups,
    rate_mismatches,
    quantity_mismatches,
    orphan_invoice_lines,
    orphan_transactions,
  };
}

function isCrossDocumentRateComparisonStatus(
  value: unknown,
): value is CrossDocumentRateVerificationSummary['validation_units'][number]['comparison_status'] {
  return (
    value === 'match'
    || value === 'rate_mismatch'
    || value === 'category_mismatch'
    || value === 'missing_contract_rate'
    || value === 'missing_support'
    || value === 'unsupported_work'
    || value === 'needs_review'
  );
}

function isCrossDocumentRateCategoryBasis(
  value: unknown,
): value is CrossDocumentRateVerificationSummary['validation_units'][number]['category_basis'] {
  return (
    value === 'existing'
    || value === 'source_category'
    || value === 'descriptor'
    || value === 'combined'
    || value === 'unresolved'
  );
}

function isCrossDocumentRateSupportBasis(
  value: unknown,
): value is CrossDocumentRateVerificationSummary['validation_units'][number]['support_basis'] {
  return (
    value === 'invoice_linked'
    || value === 'project_level'
    || value === 'billing_key_fallback'
    || value === 'none'
  );
}

function readCrossDocumentRateVerificationSummary(
  value: unknown,
): CrossDocumentRateVerificationSummary | null {
  if (!isRecord(value)) return null;

  const comparable_units = readNumber(value.comparable_units);
  const matched_units = readNumber(value.matched_units);
  const rate_mismatch_units = readNumber(value.rate_mismatch_units);
  const category_mismatch_units = readNumber(value.category_mismatch_units);
  const missing_contract_rate_units = readNumber(value.missing_contract_rate_units);
  const missing_support_units = readNumber(value.missing_support_units);
  const unsupported_work_units = readNumber(value.unsupported_work_units);
  const needs_review_units = readNumber(value.needs_review_units);

  if (
    comparable_units == null
    || matched_units == null
    || rate_mismatch_units == null
    || category_mismatch_units == null
    || missing_contract_rate_units == null
    || missing_support_units == null
    || unsupported_work_units == null
    || needs_review_units == null
  ) {
    return null;
  }

  const validation_units = Array.isArray(value.validation_units)
    ? value.validation_units.flatMap((entry) => {
        if (!isRecord(entry)) return [];

        const validation_unit_id = readString(entry.validation_unit_id);
        const invoice_line_id = readString(entry.invoice_line_id);
        const category_basis = entry.category_basis;
        const support_basis = entry.support_basis;
        const comparison_status = entry.comparison_status;
        const source_documents = isRecord(entry.source_documents) ? entry.source_documents : {};
        const source_rows = isRecord(entry.source_rows) ? entry.source_rows : {};
        const invoice_record_id = readString(source_rows.invoice_record_id);

        if (
          !validation_unit_id
          || !invoice_line_id
          || !isCrossDocumentRateCategoryBasis(category_basis)
          || !isCrossDocumentRateSupportBasis(support_basis)
          || !isCrossDocumentRateComparisonStatus(comparison_status)
          || !invoice_record_id
        ) {
          return [];
        }

        return [{
          validation_unit_id,
          invoice_line_id,
          invoice_number: readString(entry.invoice_number),
          billing_rate_key: readString(entry.billing_rate_key),
          canonical_category: readString(entry.canonical_category),
          category_confidence: entry.category_confidence == null ? null : readNumber(entry.category_confidence),
          category_basis,
          invoice_source_descriptor: readString(entry.invoice_source_descriptor),
          invoice_rate: entry.invoice_rate == null ? null : readNumber(entry.invoice_rate),
          contract_rate_found: entry.contract_rate_found === true,
          contract_rate: entry.contract_rate == null ? null : readNumber(entry.contract_rate),
          contract_source_category: readString(entry.contract_source_category),
          contract_source_descriptor: readString(entry.contract_source_descriptor),
          supported_quantity: entry.supported_quantity == null ? null : readNumber(entry.supported_quantity),
          support_row_count: readNumber(entry.support_row_count) ?? 0,
          support_basis,
          support_families: readStringArray(entry.support_families),
          support_observed_categories: readStringArray(entry.support_observed_categories),
          comparison_status,
          reason: readString(entry.reason) ?? '',
          source_documents: {
            invoice_document_id: readString(source_documents.invoice_document_id),
            contract_document_ids: readStringArray(source_documents.contract_document_ids),
            support_document_ids: readStringArray(source_documents.support_document_ids),
          },
          source_rows: {
            invoice_record_id,
            contract_record_ids: readStringArray(source_rows.contract_record_ids),
            support_record_ids: readStringArray(source_rows.support_record_ids),
          },
        }];
      })
    : [];

  return {
    comparable_units,
    matched_units,
    rate_mismatch_units,
    category_mismatch_units,
    missing_contract_rate_units,
    missing_support_units,
    unsupported_work_units,
    needs_review_units,
    validation_units,
  };
}

function readInvoiceExposureSummaries(
  value: unknown,
): ProjectExposureSummary['invoices'] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];

    const invoice_number = readString(entry.invoice_number);
    const billed_amount = entry.billed_amount == null ? null : readNumber(entry.billed_amount);
    const billed_amount_source =
      entry.billed_amount_source === 'invoice_total'
      || entry.billed_amount_source === 'line_total_fallback'
      || entry.billed_amount_source === 'missing'
        ? entry.billed_amount_source
        : null;
    const contract_supported_amount = readNumber(entry.contract_supported_amount);
    const transaction_supported_amount = readNumber(entry.transaction_supported_amount);
    const fully_reconciled_amount = readNumber(entry.fully_reconciled_amount);
    const supported_amount = readNumber(entry.supported_amount);
    const unreconciled_amount =
      entry.unreconciled_amount == null ? null : readNumber(entry.unreconciled_amount);
    const at_risk_amount = readNumber(entry.at_risk_amount);
    const requires_verification_amount =
      entry.requires_verification_amount == null
        ? null
        : readNumber(entry.requires_verification_amount);
    const reconciliation_status = entry.reconciliation_status;

    if (
      !billed_amount_source
      || contract_supported_amount == null
      || transaction_supported_amount == null
      || fully_reconciled_amount == null
      || supported_amount == null
      || at_risk_amount == null
      || requires_verification_amount == null
      || !isContractInvoiceReconciliationStatus(reconciliation_status)
    ) {
      return [];
    }

    return [{
      invoice_number,
      billed_amount,
      billed_amount_source,
      contract_supported_amount,
      transaction_supported_amount,
      fully_reconciled_amount,
      supported_amount,
      unreconciled_amount,
      at_risk_amount,
      requires_verification_amount,
      reconciliation_status,
    }];
  });
}

function fallbackValidationSummary(
  status: ValidationStatus,
  fallback?: Partial<ValidationSummary> | null,
): ValidationSummary {
  return {
    status,
    last_run_at: fallback?.last_run_at ?? null,
    critical_count: fallback?.critical_count ?? 0,
    warning_count: fallback?.warning_count ?? 0,
    info_count: fallback?.info_count ?? 0,
    blocker_count: fallback?.blocker_count ?? fallback?.critical_count ?? 0,
    requires_review_count: fallback?.requires_review_count ?? 0,
    open_count: fallback?.open_count ?? 0,
    blocked_reasons: fallback?.blocked_reasons ?? [],
    trigger_source: fallback?.trigger_source ?? null,
    validator_status: fallback?.validator_status ?? 'NEEDS_REVIEW',
    readiness: fallback?.readiness ?? status,
    validator_open_items: fallback?.validator_open_items ?? [],
    validator_blockers: fallback?.validator_blockers ?? [],
    contract_invoice_reconciliation: fallback?.contract_invoice_reconciliation ?? null,
    invoice_transaction_reconciliation: fallback?.invoice_transaction_reconciliation ?? null,
    cross_document_rate_verification: fallback?.cross_document_rate_verification ?? null,
    reconciliation: fallback?.reconciliation ?? null,
    exposure: fallback?.exposure ?? null,
    nte_amount: fallback?.nte_amount ?? null,
    total_billed: fallback?.total_billed ?? null,
    requires_verification_amount: fallback?.requires_verification_amount ?? null,
    requires_verification: fallback?.requires_verification ?? null,
    at_risk_amount: fallback?.at_risk_amount ?? null,
    unsupported_amount: fallback?.unsupported_amount ?? null,
  };
}

function validatorSummaryMessageForFinding(
  finding: ValidationFinding,
): string {
  const normalized = normalizeValidationFinding(finding);
  return normalized.problem
    ?? normalized.impact
    ?? finding.blocked_reason
    ?? finding.actual
    ?? finding.expected
    ?? finding.check_key;
}

function toCanonicalValidatorSummaryItem(
  finding: ValidationFinding,
): ValidatorSummaryItem {
  const normalized = normalizeValidationFinding(finding);

  return {
    rule_id: finding.rule_id,
    severity: finding.severity,
    subject_type: finding.subject_type,
    subject_id: finding.subject_id,
    field: finding.field,
    fact_keys: [],
    message: validatorSummaryMessageForFinding(finding),
    finding_disposition: normalized.finding_disposition ?? null,
    business_severity: normalized.business_severity ?? null,
    problem: normalized.problem ?? null,
    impact: normalized.impact ?? null,
    required_action: normalized.required_action ?? null,
    evidence_refs: normalized.evidence_refs ?? [],
    source_family: normalized.source_family ?? null,
    affected_amount: normalized.affected_amount ?? null,
    approval_gate_effect: normalized.approval_gate_effect ?? null,
  };
}

function deriveValidationStatusFromFindings(
  fallbackStatus: ValidationStatus,
  findings: readonly ValidationFinding[],
): ValidationStatus {
  const openFindings = findings.filter((finding) => finding.status === 'open');
  if (openFindings.some((finding) => isBlockingFinding(finding))) {
    return 'BLOCKED';
  }
  if (openFindings.length > 0) {
    return 'FINDINGS_OPEN';
  }
  return fallbackStatus === 'NOT_READY' && findings.length === 0
    ? 'NOT_READY'
    : 'VALIDATED';
}

function deriveValidatorStatusFromFindings(
  fallbackStatus: ValidationStatus,
  findings: readonly ValidationFinding[],
): ValidatorStatus | null {
  const openFindings = findings.filter((finding) => finding.status === 'open');
  if (openFindings.some((finding) => isBlockingFinding(finding))) {
    return 'BLOCKED';
  }
  if (openFindings.length > 0) {
    return 'NEEDS_REVIEW';
  }
  return fallbackStatus === 'NOT_READY' && findings.length === 0
    ? null
    : 'READY';
}

function canonicalTransactionSummaryRecord(
  dataset: CanonicalProjectTransactionDatasetInput,
): Record<string, unknown> | null {
  const summary = dataset.summary_json;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return null;
  }

  const overview = summary.project_operations_overview;
  return isRecord(overview) ? overview : summary;
}

function hasCanonicalTransactionDatasetData(
  datasets?: readonly CanonicalProjectTransactionDatasetInput[] | null,
): boolean {
  return (datasets ?? []).some((dataset) => {
    if ((dataset.row_count ?? 0) > 0) return true;

    const summary = canonicalTransactionSummaryRecord(dataset);
    const totalTickets = readNumber(summary?.total_tickets);
    const totalInvoicedAmount = readNumber(summary?.total_invoiced_amount);

    return (totalTickets ?? 0) > 0 || (totalInvoicedAmount ?? 0) > 0;
  });
}

function validationFindingsForCanonicalProjectFacts(params: {
  validationFindings: readonly ValidationFinding[];
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[] | null;
}): readonly ValidationFinding[] {
  if (!hasCanonicalTransactionDatasetData(params.transactionDatasets)) {
    return params.validationFindings;
  }

  return params.validationFindings.filter((finding) => finding.rule_id !== 'SOURCES_NO_TICKET_DATA');
}

function overlayCanonicalProjectFactsWithValidationFindings(
  facts: CanonicalProjectFacts,
  validationFindings?: readonly ValidationFinding[] | null,
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[] | null,
): CanonicalProjectFacts {
  if (!Array.isArray(validationFindings)) {
    return facts;
  }

  const canonicalFindings = validationFindingsForCanonicalProjectFacts({
    validationFindings,
    transactionDatasets,
  });
  const openFindings = canonicalFindings.filter((finding) => finding.status === 'open');
  const validatorOpenItems = openFindings.map(toCanonicalValidatorSummaryItem);
  const validatorBlockers = openFindings
    .filter((finding) => isBlockingFinding(finding))
    .map(toCanonicalValidatorSummaryItem);
  const derivedStatus = deriveValidationStatusFromFindings(facts.status, canonicalFindings);
  const derivedValidatorStatus = deriveValidatorStatusFromFindings(facts.status, canonicalFindings);
  const blockedReasons = uniqueDefinedValues(
    validatorBlockers.map((item) => item.problem ?? item.message ?? null),
  );
  const blockerCount = blockerFindingCount(openFindings);

  return {
    ...facts,
    status: derivedStatus,
    critical_count: blockerCount,
    warning_count: warningFindingCount(openFindings),
    info_count: infoFindingCount(openFindings),
    blocker_count: blockerCount,
    requires_review_count: requiresReviewFindingCount(openFindings),
    open_count: openFindings.length,
    blocked_reasons: blockedReasons,
    validator_status: derivedValidatorStatus,
    readiness: derivedStatus === 'NOT_READY' ? 'NOT_READY' : derivedValidatorStatus,
    validator_open_items: validatorOpenItems,
    validator_blockers: validatorBlockers,
  };
}

function overlayCanonicalProjectFactsWithPrimaryApprovalDecision(
  facts: CanonicalProjectFacts,
  decisions?: readonly CanonicalProjectDecisionInput[] | null,
): CanonicalProjectFacts {
  const projectPrimaryDecision = resolveProjectPrimaryApprovalDecision(decisions);
  if (!projectPrimaryDecision) {
    return facts;
  }

  const blockedReasons =
    projectPrimaryDecision.blocking_reasons.length > 0
      ? projectPrimaryDecision.blocking_reasons
      : projectPrimaryDecision.problem
        ? [projectPrimaryDecision.problem]
        : facts.blocked_reasons;
  const requiresVerificationAmount =
    projectPrimaryDecision.requires_verification_amount
    ?? facts.requires_verification_amount;

  return {
    ...facts,
    status: primaryApprovalStatusToValidationStatus(projectPrimaryDecision.approval_status),
    validator_status: primaryApprovalStatusToValidatorStatus(projectPrimaryDecision.approval_status),
    readiness: primaryApprovalStatusToValidatorStatus(projectPrimaryDecision.approval_status),
    open_count: Math.max(facts.open_count, projectPrimaryDecision.required_reviews),
    blocked_reasons: blockedReasons,
    total_billed: projectPrimaryDecision.total_billed_amount ?? facts.total_billed,
    exposure_total_billed:
      projectPrimaryDecision.total_billed_amount
      ?? facts.exposure_total_billed,
    blocked_amount: projectPrimaryDecision.blocked_amount ?? facts.blocked_amount,
    total_at_risk: projectPrimaryDecision.at_risk_amount ?? facts.total_at_risk,
    requires_verification_amount: requiresVerificationAmount,
    requires_verification:
      requiresVerificationAmount == null
        ? facts.requires_verification
        : requiresVerificationAmount > 0,
    unsupported_amount:
      projectPrimaryDecision.unsupported_amount
      ?? facts.unsupported_amount,
  };
}

function readProjectExposureSummary(
  value: unknown,
): ProjectExposureSummary | null {
  if (!isRecord(value)) return null;

  const total_billed_amount = readNumber(value.total_billed_amount);
  const total_contract_supported_amount = readNumber(value.total_contract_supported_amount);
  const total_transaction_supported_amount = readNumber(value.total_transaction_supported_amount);
  const total_fully_reconciled_amount = readNumber(value.total_fully_reconciled_amount);
  const total_unreconciled_amount = readNumber(value.total_unreconciled_amount);
  const total_at_risk_amount = readNumber(value.total_at_risk_amount);
  const total_requires_verification_amount = readNumber(value.total_requires_verification_amount);
  const support_gap_tolerance_amount = readNumber(value.support_gap_tolerance_amount);
  const at_risk_tolerance_amount = readNumber(value.at_risk_tolerance_amount);
  const moderate_severity = value.moderate_severity === 'warning' ? 'warning' : null;

  if (
    total_billed_amount == null
    || total_contract_supported_amount == null
    || total_transaction_supported_amount == null
    || total_fully_reconciled_amount == null
    || total_unreconciled_amount == null
    || total_at_risk_amount == null
    || total_requires_verification_amount == null
    || support_gap_tolerance_amount == null
    || at_risk_tolerance_amount == null
    || !moderate_severity
  ) {
    return null;
  }

  return {
    total_billed_amount,
    total_contract_supported_amount,
    total_transaction_supported_amount,
    total_fully_reconciled_amount,
    total_unreconciled_amount,
    total_at_risk_amount,
    total_requires_verification_amount,
    support_gap_tolerance_amount,
    at_risk_tolerance_amount,
    moderate_severity,
    invoices: readInvoiceExposureSummaries(value.invoices),
  };
}

export function resolveCanonicalProjectFacts(params: {
  validationStatus?: string | null;
  validationSummary?: unknown;
  validationFindings?: readonly ValidationFinding[] | null;
  decisions?: readonly CanonicalProjectDecisionInput[] | null;
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[] | null;
}): CanonicalProjectFacts {
  const raw = isRecord(params.validationSummary) ? params.validationSummary : null;
  const rawExposure =
    raw?.exposure && isRecord(raw.exposure)
      ? raw.exposure
      : null;
  const status = isValidationStatus(params.validationStatus)
    ? params.validationStatus
    : raw && isValidationStatus(raw.status)
      ? raw.status
      : 'NOT_READY';
  const exposure = readProjectExposureSummary(rawExposure);
  const reconciliation =
    raw?.reconciliation && isRecord(raw.reconciliation)
      ? raw.reconciliation
      : null;
  const contractContext =
    raw?.contractValidationContext && isRecord(raw.contractValidationContext)
      ? raw.contractValidationContext
      : raw?.contract_validation_context && isRecord(raw.contract_validation_context)
        ? raw.contract_validation_context
        : null;

  const resolvedFacts: CanonicalProjectFacts = {
    status,
    validation_phase: isProjectValidationPhase(raw?.validation_phase)
      ? raw.validation_phase
      : 'contract_setup',
    last_run_at: readString(raw?.last_run_at),
    critical_count: readNumber(raw?.critical_count) ?? 0,
    warning_count: readNumber(raw?.warning_count) ?? 0,
    info_count: readNumber(raw?.info_count) ?? 0,
    blocker_count:
      readNumber(raw?.blocker_count)
      ?? readNumber(raw?.critical_count)
      ?? 0,
    requires_review_count: readNumber(raw?.requires_review_count) ?? 0,
    open_count: readNumber(raw?.open_count) ?? 0,
    blocked_reasons: readStringArray(raw?.blocked_reasons),
    trigger_source: isValidationTriggerSource(raw?.trigger_source)
      ? raw.trigger_source
      : null,
    validator_status: isValidatorStatus(raw?.validator_status)
      ? raw.validator_status
      : isValidatorStatus(raw?.validator_readiness)
        ? raw.validator_readiness
        : isValidatorStatus(raw?.readiness)
          ? raw.readiness
          : null,
    readiness:
      isValidationStatus(raw?.readiness)
        ? raw.readiness
        : isValidatorStatus(raw?.readiness)
          ? raw.readiness
          : null,
    validator_open_items: readSummaryItems(raw?.validator_open_items),
    validator_blockers: readSummaryItems(raw?.validator_blockers),
    contract_invoice_reconciliation: readContractInvoiceReconciliationSummary(
      raw?.contract_invoice_reconciliation,
    ),
    invoice_transaction_reconciliation: readInvoiceTransactionReconciliationSummary(
      raw?.invoice_transaction_reconciliation,
    ),
    cross_document_rate_verification: readCrossDocumentRateVerificationSummary(
      raw?.cross_document_rate_verification,
    ),
    reconciliation: readProjectReconciliationSummary(raw?.reconciliation),
    exposure,
    nte_amount: readNumber(raw?.nte_amount ?? raw?.nteAmount) ?? null,
    total_billed:
      readNumber(raw?.total_billed ?? raw?.totalBilled)
      ?? readNumber(rawExposure?.total_billed_amount)
      ?? null,
    exposure_total_billed:
      readNumber(rawExposure?.total_billed_amount)
      ?? exposure?.total_billed_amount
      ?? null,
    blocked_amount: readNumber(raw?.blocked_amount) ?? null,
    total_at_risk:
      readNumber(raw?.at_risk_amount)
      ?? readNumber(raw?.total_at_risk_amount ?? raw?.totalAtRiskAmount)
      ?? readNumber(rawExposure?.total_at_risk_amount)
      ?? exposure?.total_at_risk_amount
      ?? null,
    requires_verification:
      typeof raw?.requires_verification === 'boolean'
        ? raw.requires_verification
        : (
          readNumber(raw?.requires_verification_amount ?? raw?.requiresVerificationAmount)
          ?? readNumber(rawExposure?.total_requires_verification_amount)
          ?? exposure?.total_requires_verification_amount
          ?? null
        ) != null
          ? (
            (readNumber(raw?.requires_verification_amount ?? raw?.requiresVerificationAmount)
            ?? readNumber(rawExposure?.total_requires_verification_amount)
            ?? exposure?.total_requires_verification_amount
            ?? 0) > 0
          )
          : null,
    unsupported_amount:
      readNumber(raw?.unsupported_amount)
      ?? (
        exposure
          ? Math.max(0, exposure.total_billed_amount - exposure.total_fully_reconciled_amount)
          : null
      ),
    requires_verification_amount:
      readNumber(raw?.requires_verification_amount ?? raw?.requiresVerificationAmount)
      ?? readNumber(rawExposure?.total_requires_verification_amount)
      ?? readNumber(rawExposure?.total_at_risk_amount)
      ?? exposure?.total_requires_verification_amount
      ?? exposure?.total_at_risk_amount
      ?? null,
    reconciliation_overall: readString(reconciliation?.overall_reconciliation_status),
    invoice_exception_eligibility: readInvoiceExceptionEligibility(
      raw?.invoice_exception_eligibility,
    ),
    reviewed_documents_with_warnings: readReviewedDocumentsWithWarnings(
      raw?.reviewed_documents_with_warnings,
    ),
    first_document_to_inspect: readFirstDocumentToInspect(raw?.first_document_to_inspect),
    contract_document_id:
      readString(raw?.contract_document_id)
      ?? readString(raw?.contractDocumentId)
      ?? readString(contractContext?.document_id)
      ?? readString(contractContext?.documentId)
      ?? null,
  };

  return overlayCanonicalProjectFactsWithPrimaryApprovalDecision(
    overlayCanonicalProjectFactsWithValidationFindings(
      resolvedFacts,
      params.validationFindings,
      params.transactionDatasets,
    ),
    params.decisions,
  );
}

export function deriveCanonicalProjectInvoiceApprovalStatus(
  reconciliationStatus: InvoiceExposureSummary['reconciliation_status'],
  requiresVerificationAmount: number | null,
): CanonicalProjectInvoiceApprovalStatus {
  if (reconciliationStatus === 'MISMATCH' || reconciliationStatus === 'MISSING') {
    return 'blocked';
  }
  if (reconciliationStatus === 'PARTIAL') {
    return (requiresVerificationAmount ?? 0) > 0
      ? 'needs_review'
      : 'approved_with_exceptions';
  }
  return 'approved';
}

export function resolveCanonicalProjectValidationSnapshot(params: {
  validationStatus?: string | null;
  validationSummary?: unknown;
  validationFindings?: readonly ValidationFinding[] | null;
  decisions?: readonly CanonicalProjectDecisionInput[] | null;
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[] | null;
}): CanonicalProjectValidationSnapshot {
  const facts = resolveCanonicalProjectFacts(params);
  const baseInvoiceSummaries = (facts.exposure?.invoices ?? []).map((invoice) => {
    const at_risk_amount = invoice.unreconciled_amount ?? invoice.at_risk_amount ?? null;
    const requires_verification_amount =
      invoice.requires_verification_amount
      ?? invoice.at_risk_amount
      ?? null;

    return {
      invoice_number: invoice.invoice_number ?? null,
      approval_status: deriveCanonicalProjectInvoiceApprovalStatus(
        invoice.reconciliation_status,
        requires_verification_amount,
      ),
      billed_amount: invoice.billed_amount ?? null,
      billed_amount_source: invoice.billed_amount_source,
      supported_amount: invoice.supported_amount ?? null,
      at_risk_amount,
      requires_verification_amount,
      reconciliation_status: invoice.reconciliation_status,
    };
  });
  const invoiceDecisionByNumber = new Map(
    resolveInvoicePrimaryApprovalDecisions(params.decisions)
      .map((decision) => [decision.invoice_number ?? '', decision] as const),
  );
  const invoice_summaries = baseInvoiceSummaries.map((invoice) => {
    const invoiceDecision = invoiceDecisionByNumber.get(invoice.invoice_number ?? '');
    if (!invoiceDecision) return invoice;
    const approval_status: CanonicalProjectInvoiceApprovalStatus =
      invoiceDecision.approval_status === 'requires_review'
        ? 'needs_review'
        : invoiceDecision.approval_status;

    return {
      invoice_number: invoiceDecision.invoice_number ?? invoice.invoice_number,
      approval_status,
      billed_amount: invoiceDecision.total_billed_amount ?? invoice.billed_amount,
      billed_amount_source: invoice.billed_amount_source,
      supported_amount: invoiceDecision.supported_amount ?? invoice.supported_amount,
      at_risk_amount: invoiceDecision.at_risk_amount ?? invoice.at_risk_amount,
      requires_verification_amount:
        invoiceDecision.requires_verification_amount
        ?? invoice.requires_verification_amount,
      reconciliation_status:
        invoiceDecision.gate_approval_status === 'needs_review'
          ? 'PARTIAL'
          : invoiceDecision.gate_approval_status === 'approved_with_exceptions'
            ? 'PARTIAL'
            : invoiceDecision.gate_approval_status === 'blocked'
              ? 'MISMATCH'
              : invoice.reconciliation_status,
    };
  });
  const blocked_total = invoice_summaries
    .filter((invoice) => invoice.approval_status === 'blocked')
    .reduce((sum, invoice) => sum + (invoice.billed_amount ?? 0), 0);

  return {
    facts,
    invoice_summaries,
    blocked_amount:
      facts.blocked_amount
      ?? (blocked_total > 0 ? blocked_total : null),
  };
}

export function resolveValidationSummaryFromProjectFacts(params: {
  validationStatus?: string | null;
  validationSummary?: unknown;
  validationFindings?: readonly ValidationFinding[] | null;
  decisions?: readonly CanonicalProjectDecisionInput[] | null;
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[] | null;
  fallback?: Partial<ValidationSummary> | null;
}): ValidationSummary {
  const fallbackStatus = isValidationStatus(params.validationStatus)
    ? params.validationStatus
    : isValidationStatus(params.fallback?.status)
      ? params.fallback.status
      : 'NOT_READY';
  const fallback = fallbackValidationSummary(fallbackStatus, params.fallback);
  const { facts } = resolveCanonicalProjectValidationSnapshot({
    validationStatus: fallbackStatus,
    validationSummary: params.validationSummary,
    validationFindings: params.validationFindings,
    decisions: params.decisions,
    transactionDatasets: params.transactionDatasets,
  });
  const hasLiveValidationFindings = Array.isArray(params.validationFindings);

  return {
    status: facts.status,
    validation_phase: facts.validation_phase,
    last_run_at: facts.last_run_at ?? fallback.last_run_at,
    critical_count: facts.critical_count,
    warning_count: facts.warning_count,
    info_count: facts.info_count,
    blocker_count: facts.blocker_count,
    requires_review_count: facts.requires_review_count,
    open_count: facts.open_count,
    blocked_reasons:
      hasLiveValidationFindings
        ? facts.blocked_reasons
        : facts.blocked_reasons.length > 0
          ? facts.blocked_reasons
          : fallback.blocked_reasons,
    trigger_source: facts.trigger_source ?? fallback.trigger_source,
    validator_status: facts.validator_status ?? fallback.validator_status,
    readiness: facts.readiness ?? fallback.readiness ?? facts.status,
    validator_open_items:
      hasLiveValidationFindings
        ? facts.validator_open_items
        : facts.validator_open_items.length > 0
          ? facts.validator_open_items
          : fallback.validator_open_items,
    validator_blockers:
      hasLiveValidationFindings
        ? facts.validator_blockers
        : facts.validator_blockers.length > 0
          ? facts.validator_blockers
          : fallback.validator_blockers,
    contract_invoice_reconciliation:
      facts.contract_invoice_reconciliation ?? fallback.contract_invoice_reconciliation ?? null,
    invoice_transaction_reconciliation:
      facts.invoice_transaction_reconciliation
      ?? fallback.invoice_transaction_reconciliation
      ?? null,
    cross_document_rate_verification:
      facts.cross_document_rate_verification
      ?? fallback.cross_document_rate_verification
      ?? null,
    reconciliation: facts.reconciliation ?? fallback.reconciliation ?? null,
    exposure: facts.exposure ?? fallback.exposure ?? null,
    nte_amount: facts.nte_amount ?? fallback.nte_amount ?? null,
    total_billed: facts.total_billed ?? fallback.total_billed ?? null,
    requires_verification_amount:
      facts.requires_verification_amount
      ?? fallback.requires_verification_amount
      ?? null,
    requires_verification:
      facts.requires_verification
      ?? fallback.requires_verification
      ?? null,
    at_risk_amount:
      facts.total_at_risk
      ?? fallback.at_risk_amount
      ?? null,
    unsupported_amount:
      facts.unsupported_amount
      ?? fallback.unsupported_amount
      ?? null,
  };
}

export function approvalStatusLabelForProjectFacts(
  facts: Pick<CanonicalProjectFacts, 'status' | 'validator_status'>,
): 'Approved' | 'Blocked' | 'Needs Review' | 'Not Evaluated' {
  if (facts.validator_status === 'READY' || facts.status === 'VALIDATED') {
    return 'Approved';
  }
  if (facts.validator_status === 'BLOCKED' || facts.status === 'BLOCKED') {
    return 'Blocked';
  }
  if (facts.validator_status === 'NEEDS_REVIEW' || facts.status === 'FINDINGS_OPEN') {
    return 'Needs Review';
  }
  return 'Not Evaluated';
}

export function approvalBlockerCountForProjectFacts(
  facts: Pick<
    CanonicalProjectFacts,
    'critical_count' | 'blocker_count' | 'exposure' | 'validator_blockers' | 'open_count' | 'validator_status'
  >,
): number {
  const validatorBlockerCount = facts.validator_blockers.length;
  const blockedInvoiceCount = facts.exposure?.invoices.filter(
    (invoice) => invoice.reconciliation_status === 'MISMATCH' || invoice.reconciliation_status === 'MISSING',
  ).length ?? 0;
  const hasExplicitNonBlockingFindingState =
    facts.open_count > 0
    || facts.validator_status === 'READY'
    || facts.validator_status === 'NEEDS_REVIEW';
  if (validatorBlockerCount > 0) return validatorBlockerCount;
  if ((facts.blocker_count ?? 0) > 0) return facts.blocker_count ?? 0;
  if (hasExplicitNonBlockingFindingState) return facts.critical_count;
  return blockedInvoiceCount > 0 ? blockedInvoiceCount : facts.critical_count;
}

function formatReconciliationStatus(
  value: ContractInvoiceReconciliationSummary['vendor_identity_status'] | null,
): string {
  switch (value) {
    case 'MATCH':
      return 'Aligned';
    case 'PARTIAL':
      return 'Partial';
    case 'MISMATCH':
      return 'Mismatch';
    case 'MISSING':
      return 'Missing';
    default:
      return 'Unavailable';
  }
}

function sumSupportedAmount(
  exposure: ProjectExposureSummary | null,
): number | null {
  if (!exposure) return null;

  const invoiceSupportedAmount = exposure.invoices.reduce((sum, invoice) => {
    return sum + (invoice.supported_amount ?? 0);
  }, 0);

  if (invoiceSupportedAmount > 0 || exposure.invoices.length > 0) {
    return invoiceSupportedAmount;
  }

  return Math.min(
    exposure.total_contract_supported_amount,
    exposure.total_transaction_supported_amount,
  );
}

function unsupportedAmountForFacts(
  facts: Pick<CanonicalProjectFacts, 'exposure' | 'total_billed' | 'unsupported_amount'>,
): number | null {
  if (facts.unsupported_amount != null) return facts.unsupported_amount;

  const billedAmount = facts.exposure?.total_billed_amount ?? facts.total_billed ?? null;
  const supportedAmount = sumSupportedAmount(facts.exposure ?? null);

  if (billedAmount == null || supportedAmount == null) return null;
  return Math.max(0, billedAmount - supportedAmount);
}

export function blockedAmountForProjectFacts(
  facts: Pick<CanonicalProjectFacts, 'blocked_amount'>,
  snapshotBlockedAmount?: number | null,
): number | null {
  if (facts.blocked_amount != null) return facts.blocked_amount;
  return snapshotBlockedAmount ?? null;
}

function truthStateForAmount(
  value: number | null,
): CanonicalProjectTruthState {
  if (value == null) return 'missing';
  return value > 0 ? 'requires_review' : 'resolved';
}

function validatorStateForReadiness(
  status: ValidationStatus,
): CanonicalProjectTruthState {
  if (status === 'VALIDATED') return 'resolved';
  if (status === 'NOT_READY') return 'unresolved';
  return 'requires_review';
}

function pushMismatch(
  mismatches: CanonicalProjectValidatorMismatch[],
  mismatch: CanonicalProjectValidatorMismatch | null,
) {
  if (mismatch) mismatches.push(mismatch);
}

export function spreadsheetReviewReadinessStatusForProjectFacts(params: {
  facts: Pick<CanonicalProjectFacts, 'status' | 'validator_status'>;
  fallback?: 'ready' | 'needs_review' | 'partial' | null;
}): 'ready' | 'needs_review' | 'partial' | null {
  switch (approvalStatusLabelForProjectFacts(params.facts)) {
    case 'Approved':
      return 'ready';
    case 'Blocked':
    case 'Needs Review':
      return 'needs_review';
    case 'Not Evaluated':
    default:
      return params.fallback ?? 'partial';
  }
}

function formatCurrency(value: number | null): string {
  if (value == null || Number.isNaN(value)) return 'Unavailable';
  const hasCents = Math.abs(value - Math.round(value)) >= 0.005;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(value);
}

function formatCount(value: number | null): string {
  if (value == null || Number.isNaN(value)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function formatOperatorLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function formatDate(value: string | null): string {
  if (!value) return 'Unavailable';
  const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function truthRow(params: {
  key: string;
  label: string;
  value: string;
  source_label: string;
  state: CanonicalProjectTruthState;
}): CanonicalProjectTruthRow {
  return {
    key: params.key,
    label: params.label,
    value: params.value,
    source_label: params.source_label,
    state: params.state,
  };
}

function unavailableTruthRow(
  key: string,
  label: string,
  sourceLabel: string,
): CanonicalProjectTruthRow {
  return truthRow({
    key,
    label,
    value: 'Unavailable',
    source_label: sourceLabel,
    state: 'missing',
  });
}

function documentDisplayLabel(document: CanonicalProjectTruthDocumentInput): string {
  return document.title?.trim() || document.name;
}

function documentSourceLabel(
  document: CanonicalProjectTruthDocumentInput | null,
  fallback: string,
): string {
  return document ? documentDisplayLabel(document) : fallback;
}

function readDocumentTrace(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): Record<string, unknown> | null {
  return asRecord(document?.intelligence_trace);
}

function readDocumentFacts(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): Record<string, unknown> | null {
  return asRecord(readDocumentTrace(document)?.facts);
}

function readDocumentExtracted(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): Record<string, unknown> | null {
  return asRecord(readDocumentTrace(document)?.extracted);
}

function readDocumentContractAnalysis(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): ContractAnalysisResult | null {
  const analysis = asRecord(readDocumentTrace(document)?.contract_analysis);
  return analysis ? (analysis as unknown as ContractAnalysisResult) : null;
}

function readDocumentClassificationFamily(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): string | null {
  return readString(asRecord(readDocumentTrace(document)?.classification)?.family);
}

function readFirstStringFromRecords(
  records: ReadonlyArray<Record<string, unknown> | null | undefined>,
  keys: readonly string[],
): string | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) return value;
    }
  }
  return null;
}

function readFirstNumberFromRecords(
  records: ReadonlyArray<Record<string, unknown> | null | undefined>,
  keys: readonly string[],
): number | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = readNumber(record[key]);
      if (value != null) return value;
    }
  }
  return null;
}

function readFirstBooleanFromRecords(
  records: ReadonlyArray<Record<string, unknown> | null | undefined>,
  keys: readonly string[],
): boolean | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      if (typeof record[key] === 'boolean') {
        return record[key] as boolean;
      }
    }
  }
  return null;
}

function normalizeTruthIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return normalized.length > 0 ? normalized : null;
}

function parseTruthDateTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readContractContext(summary: unknown): Record<string, unknown> | null {
  const raw = asRecord(summary);
  if (!raw) return null;
  return asRecord(raw.contractValidationContext) ?? asRecord(raw.contract_validation_context);
}

function readContractAnalysis(summary: unknown): ContractAnalysisResult | null {
  const context = readContractContext(summary);
  const analysis = asRecord(context?.analysis);
  return analysis ? (analysis as unknown as ContractAnalysisResult) : null;
}

function isContractTruthDocument(document: CanonicalProjectTruthDocumentInput): boolean {
  return (
    document.document_type === 'contract'
    || document.document_role === 'base_contract'
    || document.document_role === 'contract_amendment'
    || readDocumentClassificationFamily(document) === 'contract'
    || readDocumentContractAnalysis(document) != null
  );
}

function isInvoiceTruthDocument(document: CanonicalProjectTruthDocumentInput): boolean {
  return (
    document.document_type === 'invoice'
    || document.document_role === 'invoice'
    || document.document_role === 'invoice_revision'
    || readDocumentClassificationFamily(document) === 'invoice'
  );
}

type ProjectDocumentPrecedenceContext = {
  familiesByKey: Map<GoverningDocumentFamily, ResolvedDocumentPrecedenceFamily>;
  resolvedById: Map<string, ResolvedDocumentPrecedenceRecord>;
  documentsById: Map<string, CanonicalProjectTruthDocumentInput>;
  relationships: DocumentRelationshipRecord[];
};

function readDocumentProjectId(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): string | null {
  return readString(document?.project_id);
}

function toDocumentRelationshipRecord(
  relationship: CanonicalProjectDocumentRelationshipInput,
  projectId: string,
): DocumentRelationshipRecord | null {
  const sourceDocumentId = readString(relationship.source_document_id);
  const targetDocumentId = readString(relationship.target_document_id);
  const relationshipType = readString(relationship.relationship_type);

  if (!sourceDocumentId || !targetDocumentId || !relationshipType) {
    return null;
  }

  return {
    id: relationship.id,
    project_id: readString(relationship.project_id) ?? projectId,
    source_document_id: sourceDocumentId,
    target_document_id: targetDocumentId,
    relationship_type: relationshipType,
    created_by: readString(relationship.created_by),
    created_at: readString(relationship.created_at),
  };
}

function resolveProjectDocumentPrecedenceContext(params: {
  documents: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
}): ProjectDocumentPrecedenceContext {
  const documentsById = new Map(
    params.documents.map((document) => [document.id, document] as const),
  );
  const fallbackProjectId =
    params.documents
      .map((document) => readDocumentProjectId(document))
      .find((value): value is string => value != null)
    ?? params.documentRelationships
      ?.map((relationship) => readString(relationship.project_id))
      .find((value): value is string => value != null)
    ?? 'project-truth';

  const precedenceDocuments = params.documents.map((document) => ({
    id: document.id,
    project_id: readDocumentProjectId(document) ?? fallbackProjectId,
    title: document.title,
    name: document.name,
    document_type: document.document_type ?? null,
    document_subtype: document.document_subtype ?? null,
    created_at: document.created_at ?? '1970-01-01T00:00:00.000Z',
    document_role: document.document_role ?? null,
    authority_status: document.authority_status ?? null,
    effective_date: document.effective_date ?? null,
    precedence_rank: document.precedence_rank ?? null,
    operator_override_precedence: document.operator_override_precedence ?? null,
  }));
  const relationships = (params.documentRelationships ?? [])
    .map((relationship) => toDocumentRelationshipRecord(relationship, fallbackProjectId))
    .filter((relationship): relationship is DocumentRelationshipRecord => relationship != null);
  const families = resolveDocumentPrecedence({
    documents: precedenceDocuments,
    relationships,
  });
  const familiesByKey = new Map(
    families.map((family) => [family.family, family] as const),
  );
  const resolvedById = new Map<string, ResolvedDocumentPrecedenceRecord>();

  for (const family of families) {
    for (const document of family.documents) {
      resolvedById.set(document.id, document);
    }
  }

  return {
    familiesByKey,
    resolvedById,
    documentsById,
    relationships,
  };
}

function isInactiveForPrimaryTruth(
  authorityStatus: string | null | undefined,
): boolean {
  return authorityStatus === 'superseded' || authorityStatus === 'archived';
}

function selectedFamilyDocuments(
  context: ProjectDocumentPrecedenceContext,
  family: GoverningDocumentFamily,
): CanonicalProjectTruthDocumentInput[] {
  const resolvedFamily = context.familiesByKey.get(family);
  if (!resolvedFamily) return [];

  const preferredDocuments = resolvedFamily.documents.filter(
    (document) => !isInactiveForPrimaryTruth(document.authority_status ?? null),
  );
  const sourceDocuments = preferredDocuments.length > 0
    ? preferredDocuments
    : resolvedFamily.documents;

  return sourceDocuments
    .map((document) => context.documentsById.get(document.id) ?? null)
    .filter((document): document is CanonicalProjectTruthDocumentInput => document != null);
}

function governingFamilyDocument(
  context: ProjectDocumentPrecedenceContext,
  family: GoverningDocumentFamily,
): CanonicalProjectTruthDocumentInput | null {
  const resolvedFamily = context.familiesByKey.get(family);
  const documentId = resolvedFamily?.governing_document_id ?? null;
  return documentId ? context.documentsById.get(documentId) ?? null : null;
}

type ContractRelationshipContextDocuments = {
  pricing: CanonicalProjectTruthDocumentInput[];
  compliance: CanonicalProjectTruthDocumentInput[];
  amendments: CanonicalProjectTruthDocumentInput[];
};

function resolveContractRelationshipContextDocuments(
  context: ProjectDocumentPrecedenceContext,
): ContractRelationshipContextDocuments {
  const truthCategoryDocumentIds = resolveDocumentTruthCategoryIds({
    families: [...context.familiesByKey.values()],
    relationships: context.relationships,
  });
  const contractIdentitySet = new Set(truthCategoryDocumentIds.contract_identity);
  const resolveDocumentsForRelationshipType = (
    relationshipType: 'attached_to' | 'supplements' | 'amends',
  ): CanonicalProjectTruthDocumentInput[] =>
    context.relationships
      .flatMap((relationship) => {
        if (canonicalizeRelationshipType(relationship.relationship_type) !== relationshipType) {
          return [];
        }

        const sourceIsContractIdentity = contractIdentitySet.has(relationship.source_document_id);
        const targetIsContractIdentity = contractIdentitySet.has(relationship.target_document_id);
        if (!sourceIsContractIdentity && !targetIsContractIdentity) {
          return [];
        }

        return [
          targetIsContractIdentity ? relationship.source_document_id : null,
          sourceIsContractIdentity ? relationship.target_document_id : null,
        ].filter((documentId): documentId is string => documentId != null && !contractIdentitySet.has(documentId));
      })
      .map((documentId) => context.documentsById.get(documentId) ?? null)
      .filter((document): document is CanonicalProjectTruthDocumentInput => document != null)
      .filter((document, index, documents) =>
        documents.findIndex((candidate) => candidate.id === document.id) === index,
      );

  return {
    pricing: resolveDocumentsForRelationshipType('attached_to'),
    compliance: resolveDocumentsForRelationshipType('supplements'),
    amendments: resolveDocumentsForRelationshipType('amends'),
  };
}

function readContractField(
  analysis: ContractAnalysisResult | null,
  family: 'contract_identity' | 'term_model' | 'pricing_model',
  fieldId: string,
): ContractFieldAnalysis | null {
  const familyMap = analysis?.[family];
  if (!familyMap) return null;
  const candidate = familyMap[fieldId as keyof typeof familyMap];
  return candidate ?? null;
}

function truthStateFromContractField(field: ContractFieldAnalysis | null): CanonicalProjectTruthState {
  const state = field?.state ?? null;
  switch (state) {
    case 'explicit':
      return 'resolved';
    case 'derived':
      return 'derived';
    case 'conditional':
      return 'requires_review';
    case 'conflicted':
      return 'conflicted';
    case 'missing_critical':
    default:
      return 'missing';
  }
}

function readContractString(field: ContractFieldAnalysis | null): string | null {
  return typeof field?.value === 'string' && field.value.trim().length > 0
    ? field.value.trim()
    : null;
}

function readContractNumber(field: ContractFieldAnalysis | null): number | null {
  return typeof field?.value === 'number' && Number.isFinite(field.value)
    ? field.value
    : null;
}

function readContractBoolean(field: ContractFieldAnalysis | null): boolean | null {
  return typeof field?.value === 'boolean' ? field.value : null;
}

function contractSourceLabel(
  field: ContractFieldAnalysis | null,
  document: CanonicalProjectTruthDocumentInput | null,
): string {
  const sourceFactIds = field?.source_fact_ids ?? [];
  if (sourceFactIds.length > 0) return documentSourceLabel(document, 'Project truth');
  return documentSourceLabel(document, 'Validator-backed project facts');
}

function relationshipContextValue(
  documents: readonly CanonicalProjectTruthDocumentInput[],
): string | null {
  if (documents.length === 0) return null;
  return documents.map((document) => documentDisplayLabel(document)).join(', ');
}

function resolvePricingContextTruth(
  documents: readonly CanonicalProjectTruthDocumentInput[],
): {
  present: boolean | null;
  pages: number | null;
  applicability: string | null;
  sourceDocument: CanonicalProjectTruthDocumentInput | null;
} {
  let fallback = {
    present: null as boolean | null,
    pages: null as number | null,
    applicability: null as string | null,
    sourceDocument: null as CanonicalProjectTruthDocumentInput | null,
  };

  for (const document of documents) {
    const analysis = readDocumentContractAnalysis(document);
    const facts = readDocumentFacts(document);
    const extracted = readDocumentExtracted(document);
    const presentFromAnalysis = readContractBoolean(
      readContractField(analysis, 'pricing_model', 'rate_schedule_present'),
    );
    const pagesFromAnalysis = readContractNumber(
      readContractField(analysis, 'pricing_model', 'rate_schedule_pages'),
    );
    const applicabilityFromAnalysis = readContractString(
      readContractField(analysis, 'pricing_model', 'pricing_applicability'),
    );
    const presentFromFacts = readFirstBooleanFromRecords(
      [facts, extracted],
      ['rate_schedule_present', 'rate_section_present', 'unit_price_structure_present'],
    );
    const rowCount = readFirstNumberFromRecords(
      [facts, extracted],
      ['rate_row_count', 'rate_items_detected'],
    );
    const pagesFromFacts = readFirstNumberFromRecords(
      [facts, extracted],
      ['rate_schedule_pages', 'rate_section_pages'],
    );
    const applicabilityFromFacts = readFirstStringFromRecords(
      [facts, extracted],
      ['pricing_applicability'],
    );
    const present =
      presentFromAnalysis
      ?? presentFromFacts
      ?? ((rowCount ?? 0) > 0 || (pagesFromAnalysis ?? pagesFromFacts ?? 0) > 0 ? true : null);
    const candidate = {
      present,
      pages: pagesFromAnalysis ?? pagesFromFacts,
      applicability: applicabilityFromAnalysis ?? applicabilityFromFacts,
      sourceDocument: document,
    };

    if (present === true) {
      return candidate;
    }

    if (
      fallback.sourceDocument == null
      && (
        candidate.present != null
        || candidate.pages != null
        || candidate.applicability != null
      )
    ) {
      fallback = candidate;
    }
  }

  return fallback;
}

function documentLabelById(
  documentId: string | null,
  documents: readonly CanonicalProjectTruthDocumentInput[],
): string | null {
  if (!documentId) return null;
  const document = documents.find((candidate) => candidate.id === documentId);
  if (!document) return null;
  return document.title?.trim() || document.name;
}

function selectContractTruthDocument(params: {
  facts: CanonicalProjectFacts;
  documents: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
}): CanonicalProjectTruthDocumentInput | null {
  if (params.facts.contract_document_id) {
    const linkedDocument = params.documents.find(
      (candidate) => candidate.id === params.facts.contract_document_id,
    ) ?? null;
    if (linkedDocument) return linkedDocument;
  }

  const precedenceContext = resolveProjectDocumentPrecedenceContext({
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const governingDocument = governingFamilyDocument(precedenceContext, 'contract');
  if (governingDocument) return governingDocument;

  const contractDocuments = params.documents.filter(isContractTruthDocument);
  return contractDocuments.length === 1 ? contractDocuments[0] ?? null : null;
}

function invoiceApprovalState(
  approvalStatus: CanonicalProjectInvoiceApprovalStatus,
): CanonicalProjectTruthState {
  switch (approvalStatus) {
    case 'approved':
      return 'resolved';
    case 'approved_with_exceptions':
      return 'derived';
    case 'needs_review':
      return 'requires_review';
    case 'blocked':
      return 'conflicted';
    default:
      return 'missing';
  }
}

function invoiceSourceLabel(source: InvoiceExposureSummary['billed_amount_source'] | null): string {
  if (source === 'invoice_total') return 'Validator-backed project facts';
  if (source === 'line_total_fallback') return 'Project truth';
  return 'Validator-backed project facts';
}

function invoiceApprovalLabel(
  approvalStatus: CanonicalProjectInvoiceApprovalStatus,
): string {
  switch (approvalStatus) {
    case 'approved':
      return 'approved';
    case 'approved_with_exceptions':
      return 'approved with exceptions';
    case 'needs_review':
      return 'needs review';
    case 'blocked':
      return 'blocked';
    default:
      return 'unresolved';
  }
}

type InvoiceApprovalSupportCoverage = {
  supported_amount: number | null;
  at_risk_amount: number | null;
  requires_verification_amount: number | null;
};

function sumNullableInvoiceAmount(
  invoices: readonly CanonicalProjectInvoiceSummary[],
  readAmount: (invoice: CanonicalProjectInvoiceSummary) => number | null,
): number | null {
  let hasValue = false;
  let total = 0;

  for (const invoice of invoices) {
    const amount = readAmount(invoice);
    if (amount == null || Number.isNaN(amount)) continue;
    hasValue = true;
    total += amount;
  }

  return hasValue ? total : null;
}

function aggregateInvoiceApprovalSupportCoverage(
  invoices: readonly CanonicalProjectInvoiceSummary[],
): InvoiceApprovalSupportCoverage {
  return {
    supported_amount: sumNullableInvoiceAmount(invoices, (invoice) => invoice.supported_amount),
    at_risk_amount: sumNullableInvoiceAmount(invoices, (invoice) => invoice.at_risk_amount),
    requires_verification_amount: sumNullableInvoiceAmount(
      invoices,
      (invoice) => invoice.requires_verification_amount,
    ),
  };
}

function isApprovedCleanApprovalContext(params: {
  facts: Pick<
    CanonicalProjectFacts,
    | 'status'
    | 'validator_status'
    | 'blocker_count'
    | 'critical_count'
    | 'open_count'
    | 'validator_blockers'
    | 'exposure'
    | 'total_billed'
    | 'unsupported_amount'
    | 'total_at_risk'
    | 'requires_verification_amount'
  >;
  invoices?: readonly CanonicalProjectInvoiceSummary[];
}): boolean {
  const facts = params.facts;
  const unsupportedAmount = unsupportedAmountForFacts(facts);
  const blockerCount = approvalBlockerCountForProjectFacts(facts);
  const invoices = params.invoices ?? facts.exposure?.invoices ?? [];
  const allInvoicesReconcile =
    invoices.length === 0
    || invoices.every((invoice) => {
      const status = 'reconciliation_status' in invoice ? invoice.reconciliation_status : null;
      return status == null || status === 'MATCH';
    });
  return (
    approvalStatusLabelForProjectFacts(facts) === 'Approved'
    && blockerCount === 0
    && (facts.total_at_risk == null || facts.total_at_risk <= 0)
    && (facts.requires_verification_amount == null || facts.requires_verification_amount <= 0)
    && (unsupportedAmount == null || unsupportedAmount <= 0)
    && allInvoicesReconcile
  );
}

function invoiceApprovalContextState(
  invoices: readonly CanonicalProjectInvoiceSummary[],
): CanonicalProjectTruthState {
  if (invoices.some((invoice) => invoice.approval_status === 'blocked')) return 'conflicted';
  if (invoices.some((invoice) => invoice.approval_status === 'needs_review')) return 'requires_review';
  if (invoices.some((invoice) => invoice.approval_status === 'approved_with_exceptions')) return 'derived';
  return invoices.length > 0 ? 'resolved' : 'missing';
}

function formatInvoiceApprovalContextValue(
  invoices: readonly CanonicalProjectInvoiceSummary[],
): string {
  const invoiceDetails = invoices
    .map((invoice, index) => {
      const invoiceNumber = invoice.invoice_number ?? `Invoice ${index + 1}`;
      const sequenceLabel = index === 0 ? 'Original' : 'Subsequent';
      const billedAmount = invoice.billed_amount == null
        ? null
        : `billed ${formatCurrency(invoice.billed_amount)}`;
      const supportedAmount = invoice.supported_amount == null
        ? null
        : `supported ${formatCurrency(invoice.supported_amount)}`;
      const atRiskAmount = invoice.at_risk_amount == null
        ? null
        : `at risk ${formatCurrency(invoice.at_risk_amount)}`;
      const reconciliationStatus = invoice.reconciliation_status
        ? String(invoice.reconciliation_status)
        : null;
      const details = [
        formatOperatorLabel(invoiceApprovalLabel(invoice.approval_status)),
        sequenceLabel,
        billedAmount,
        supportedAmount,
        atRiskAmount,
        reconciliationStatus,
      ].filter((value): value is string => value != null && value.length > 0);

      return `${invoiceNumber}: ${details.join(', ')}`;
    })
    .join('; ');

  if (invoices.length <= 1) return invoiceDetails;

  const combinedBilled = sumNullableInvoiceAmount(invoices, (invoice) => invoice.billed_amount);
  const combinedSupported = sumNullableInvoiceAmount(invoices, (invoice) => invoice.supported_amount);
  const combinedAtRisk = sumNullableInvoiceAmount(invoices, (invoice) => invoice.at_risk_amount);
  const combinedDetails = [
    combinedBilled == null ? null : `billed ${formatCurrency(combinedBilled)}`,
    combinedSupported == null ? null : `supported ${formatCurrency(combinedSupported)}`,
    combinedAtRisk == null ? null : `at risk ${formatCurrency(combinedAtRisk)}`,
  ].filter((value): value is string => value != null);

  return combinedDetails.length > 0
    ? `${invoiceDetails}; Combined: ${combinedDetails.join(', ')}`
    : invoiceDetails;
}

function readInvoiceDocumentNumber(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): string | null {
  return readFirstStringFromRecords(
    [readDocumentFacts(document), readDocumentExtracted(document)],
    ['invoice_number_normalized', 'invoice_number', 'invoiceNumber', 'invoice_number_raw'],
  );
}

function readInvoiceDocumentBilledAmount(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): number | null {
  return readFirstNumberFromRecords(
    [readDocumentFacts(document), readDocumentExtracted(document)],
    [
      'billed_amount',
      'billedAmount',
      'total_amount',
      'totalAmount',
      'invoice_total',
      'invoiceTotal',
      'current_amount_due',
      'currentAmountDue',
      'subtotal_amount',
      'subtotalAmount',
    ],
  );
}

function readInvoiceDocumentPeriodValue(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): { value: string; state: CanonicalProjectTruthState } | null {
  const facts = readDocumentFacts(document);
  const extracted = readDocumentExtracted(document);
  const billingPeriod = readFirstStringFromRecords(
    [facts, extracted],
    ['billing_period', 'billingPeriod'],
  );
  if (billingPeriod) {
    return { value: billingPeriod, state: 'resolved' };
  }

  const periodFrom = readFirstStringFromRecords(
    [facts, extracted],
    ['service_period_start', 'period_start', 'period_from', 'periodFrom'],
  );
  const periodTo = readFirstStringFromRecords(
    [facts, extracted],
    ['service_period_end', 'period_end', 'period_to', 'periodTo'],
  );
  const periodThrough = readFirstStringFromRecords(
    [facts, extracted],
    ['period_through', 'periodThrough'],
  );
  if (periodFrom && (periodTo || periodThrough)) {
    return {
      value: `${formatDate(periodFrom)} -> ${formatDate(periodTo ?? periodThrough)}`,
      state: 'resolved',
    };
  }
  if (periodThrough) {
    return {
      value: `Through ${formatDate(periodThrough)}`,
      state: 'derived',
    };
  }

  const invoiceDate = readFirstStringFromRecords([facts, extracted], ['invoice_date', 'invoiceDate']);
  if (invoiceDate) {
    return {
      value: formatDate(invoiceDate),
      state: 'derived',
    };
  }

  return null;
}

type InvoiceTruthDocumentDetails = {
  document: CanonicalProjectTruthDocumentInput;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  billed_amount: number | null;
  billing_period: { value: string; state: CanonicalProjectTruthState } | null;
  sequence_timestamp: number | null;
  created_at_timestamp: number | null;
  authority_status: string | null;
  resolved_order: number | null;
  is_governing: boolean;
};

function readInvoiceDocumentSequenceTimestamp(
  document: CanonicalProjectTruthDocumentInput | null | undefined,
): number | null {
  const facts = readDocumentFacts(document);
  const extracted = readDocumentExtracted(document);
  const datedValue = readFirstStringFromRecords(
    [facts, extracted],
    [
      'service_period_end',
      'period_end',
      'period_to',
      'periodTo',
      'period_through',
      'periodThrough',
      'invoice_date',
      'invoiceDate',
      'service_period_start',
      'period_start',
      'period_from',
      'periodFrom',
    ],
  );

  return parseTruthDateTimestamp(datedValue) ?? parseTruthDateTimestamp(document?.created_at ?? null);
}

function readInvoiceTruthDocumentDetails(
  document: CanonicalProjectTruthDocumentInput,
  precedenceContext?: ProjectDocumentPrecedenceContext,
): InvoiceTruthDocumentDetails {
  const invoiceNumber = readInvoiceDocumentNumber(document);
  const resolvedDocument = precedenceContext?.resolvedById.get(document.id) ?? null;
  return {
    document,
    invoice_number: invoiceNumber,
    normalized_invoice_number: normalizeTruthIdentifier(invoiceNumber),
    billed_amount: readInvoiceDocumentBilledAmount(document),
    billing_period: readInvoiceDocumentPeriodValue(document),
    sequence_timestamp: readInvoiceDocumentSequenceTimestamp(document),
    created_at_timestamp: parseTruthDateTimestamp(document.created_at ?? null),
    authority_status: resolvedDocument?.authority_status ?? document.authority_status ?? null,
    resolved_order: resolvedDocument?.resolved_order ?? null,
    is_governing: resolvedDocument?.is_governing === true,
  };
}

function compareInvoiceDocumentChronology(
  left: InvoiceTruthDocumentDetails,
  right: InvoiceTruthDocumentDetails,
): number {
  const leftTimestamp =
    left.sequence_timestamp
    ?? left.created_at_timestamp
    ?? Number.NEGATIVE_INFINITY;
  const rightTimestamp =
    right.sequence_timestamp
    ?? right.created_at_timestamp
    ?? Number.NEGATIVE_INFINITY;

  if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
  return (left.created_at_timestamp ?? Number.NEGATIVE_INFINITY)
    - (right.created_at_timestamp ?? Number.NEGATIVE_INFINITY);
}

function latestInvoiceTruthDocument(
  documents: readonly InvoiceTruthDocumentDetails[],
): InvoiceTruthDocumentDetails | null {
  return [...documents].sort(compareInvoiceDocumentChronology).at(-1) ?? null;
}

function aggregateInvoiceDocumentBilledAmount(params: {
  documents: readonly InvoiceTruthDocumentDetails[];
}): { value: number | null; state: CanonicalProjectTruthState } {
  const docsWithAmounts = params.documents.filter((document) => document.billed_amount != null);
  if (docsWithAmounts.length === 0) {
    return { value: null, state: 'missing' };
  }

  const total = docsWithAmounts.reduce((sum, document) => sum + (document.billed_amount ?? 0), 0);
  const state =
    docsWithAmounts.length === params.documents.length
      ? 'resolved'
      : 'derived';

  return { value: total, state };
}

function aggregateInvoiceDocumentBillingPeriod(params: {
  documents: readonly InvoiceTruthDocumentDetails[];
}): { value: string; state: CanonicalProjectTruthState } | null {
  if (params.documents.length === 0) return null;
  if (params.documents.length === 1) {
    return params.documents[0]?.billing_period ?? null;
  }

  const startTimestamps = params.documents
    .map((document) =>
      parseTruthDateTimestamp(
        readFirstStringFromRecords(
          [readDocumentFacts(document.document), readDocumentExtracted(document.document)],
          ['service_period_start', 'period_start', 'period_from', 'periodFrom', 'invoice_date', 'invoiceDate'],
        ),
      ))
    .filter((value): value is number => value != null);
  const endTimestamps = params.documents
    .map((document) =>
      parseTruthDateTimestamp(
        readFirstStringFromRecords(
          [readDocumentFacts(document.document), readDocumentExtracted(document.document)],
          ['service_period_end', 'period_end', 'period_to', 'periodTo', 'period_through', 'periodThrough', 'invoice_date', 'invoiceDate'],
        ),
      ))
    .filter((value): value is number => value != null);

  if (startTimestamps.length === 0 || endTimestamps.length === 0) return null;

  const earliestStart = new Date(Math.min(...startTimestamps)).toISOString().slice(0, 10);
  const latestEnd = new Date(Math.max(...endTimestamps)).toISOString().slice(0, 10);

  return {
    value: `${formatDate(earliestStart)} -> ${formatDate(latestEnd)}`,
    state:
      startTimestamps.length === params.documents.length && endTimestamps.length === params.documents.length
        ? 'resolved'
        : 'derived',
  };
}

function aggregateInvoiceDocumentPeriodTimestamps(params: {
  documents: readonly InvoiceTruthDocumentDetails[];
}): { start: number | null; end: number | null; complete: boolean } {
  const startTimestamps = params.documents
    .map((document) =>
      parseTruthDateTimestamp(
        readFirstStringFromRecords(
          [readDocumentFacts(document.document), readDocumentExtracted(document.document)],
          ['service_period_start', 'period_start', 'period_from', 'periodFrom', 'invoice_date', 'invoiceDate'],
        ),
      ))
    .filter((value): value is number => value != null);
  const endTimestamps = params.documents
    .map((document) =>
      parseTruthDateTimestamp(
        readFirstStringFromRecords(
          [readDocumentFacts(document.document), readDocumentExtracted(document.document)],
          ['service_period_end', 'period_end', 'period_to', 'periodTo', 'period_through', 'periodThrough', 'invoice_date', 'invoiceDate'],
        ),
      ))
    .filter((value): value is number => value != null);

  return {
    start: startTimestamps.length > 0 ? Math.min(...startTimestamps) : null,
    end: endTimestamps.length > 0 ? Math.max(...endTimestamps) : null,
    complete:
      params.documents.length > 0
      && startTimestamps.length === params.documents.length
      && endTimestamps.length === params.documents.length,
  };
}

function invoiceAmountsMatch(left: number | null, right: number | null): boolean {
  return left != null && right != null && Math.abs(left - right) < 0.005;
}

function sortInvoiceTruthDocumentCandidates(
  candidates: readonly InvoiceTruthDocumentDetails[],
  activeInvoice: CanonicalProjectInvoiceSummary | null,
): InvoiceTruthDocumentDetails[] {
  return [...candidates].sort((left, right) => {
    const rightGoverning = right.is_governing ? 1 : 0;
    const leftGoverning = left.is_governing ? 1 : 0;
    if (rightGoverning !== leftGoverning) return rightGoverning - leftGoverning;

    const rightActive = isInactiveForPrimaryTruth(right.authority_status) ? 0 : 1;
    const leftActive = isInactiveForPrimaryTruth(left.authority_status) ? 0 : 1;
    if (rightActive !== leftActive) return rightActive - leftActive;

    const leftResolvedOrder = left.resolved_order ?? Number.POSITIVE_INFINITY;
    const rightResolvedOrder = right.resolved_order ?? Number.POSITIVE_INFINITY;
    if (leftResolvedOrder !== rightResolvedOrder) return leftResolvedOrder - rightResolvedOrder;

    const rightAmountMatch = invoiceAmountsMatch(right.billed_amount, activeInvoice?.billed_amount ?? null) ? 1 : 0;
    const leftAmountMatch = invoiceAmountsMatch(left.billed_amount, activeInvoice?.billed_amount ?? null) ? 1 : 0;
    if (rightAmountMatch !== leftAmountMatch) return rightAmountMatch - leftAmountMatch;

    const rightPeriod = right.billing_period ? 1 : 0;
    const leftPeriod = left.billing_period ? 1 : 0;
    if (rightPeriod !== leftPeriod) return rightPeriod - leftPeriod;

    const rightAmountPresent = right.billed_amount != null ? 1 : 0;
    const leftAmountPresent = left.billed_amount != null ? 1 : 0;
    if (rightAmountPresent !== leftAmountPresent) return rightAmountPresent - leftAmountPresent;

    const rightTimestamp =
      right.sequence_timestamp
      ?? right.created_at_timestamp
      ?? Number.NEGATIVE_INFINITY;
    const leftTimestamp =
      left.sequence_timestamp
      ?? left.created_at_timestamp
      ?? Number.NEGATIVE_INFINITY;
    if (rightTimestamp !== leftTimestamp) return rightTimestamp - leftTimestamp;

    const rightCreatedAt = right.created_at_timestamp ?? Number.NEGATIVE_INFINITY;
    const leftCreatedAt = left.created_at_timestamp ?? Number.NEGATIVE_INFINITY;
    if (rightCreatedAt !== leftCreatedAt) return rightCreatedAt - leftCreatedAt;

    return 0;
  });
}

function representativeInvoiceDocumentsByNumber(
  documents: readonly InvoiceTruthDocumentDetails[],
): InvoiceTruthDocumentDetails[] {
  const byNumber = new Map<string, InvoiceTruthDocumentDetails[]>();

  for (const document of documents) {
    const key = document.normalized_invoice_number;
    if (!key) continue;
    const current = byNumber.get(key) ?? [];
    current.push(document);
    byNumber.set(key, current);
  }

  return Array.from(byNumber.values())
    .map((group) => sortInvoiceTruthDocumentCandidates(group, null)[0] ?? null)
    .filter((entry): entry is InvoiceTruthDocumentDetails => entry != null);
}

function deriveInvoiceSequenceLabel(params: {
  activeInvoice: CanonicalProjectInvoiceSummary | null;
  activeDocument: InvoiceTruthDocumentDetails | null;
  matchingDocuments: readonly InvoiceTruthDocumentDetails[];
  invoiceDocuments: readonly InvoiceTruthDocumentDetails[];
}): 'Original' | 'Revision' | 'Subsequent' | null {
  if (!params.activeInvoice || !params.activeDocument) return null;

  if (params.matchingDocuments.length > 1) {
    const chronological = [...params.matchingDocuments]
      .filter((document) => document.sequence_timestamp != null || document.created_at_timestamp != null)
      .sort((left, right) => {
        const leftTimestamp = left.sequence_timestamp ?? left.created_at_timestamp ?? Number.NEGATIVE_INFINITY;
        const rightTimestamp = right.sequence_timestamp ?? right.created_at_timestamp ?? Number.NEGATIVE_INFINITY;
        if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
        return (left.created_at_timestamp ?? Number.NEGATIVE_INFINITY)
          - (right.created_at_timestamp ?? Number.NEGATIVE_INFINITY);
      });

    if (chronological.length > 1) {
      const activeIndex = chronological.findIndex((document) => document.document.id === params.activeDocument?.document.id);
      if (activeIndex === 0) return 'Original';
      if (activeIndex > 0) return 'Revision';
    }

    return 'Revision';
  }

  const activeInvoiceNumber = params.activeDocument.normalized_invoice_number;
  if (!activeInvoiceNumber) return null;

  const representatives = representativeInvoiceDocumentsByNumber(params.invoiceDocuments)
    .filter((document) => document.sequence_timestamp != null || document.created_at_timestamp != null)
    .sort((left, right) => {
      const leftTimestamp = left.sequence_timestamp ?? left.created_at_timestamp ?? Number.NEGATIVE_INFINITY;
      const rightTimestamp = right.sequence_timestamp ?? right.created_at_timestamp ?? Number.NEGATIVE_INFINITY;
      if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
      return (left.created_at_timestamp ?? Number.NEGATIVE_INFINITY)
        - (right.created_at_timestamp ?? Number.NEGATIVE_INFINITY);
    });

  if (representatives.length <= 1) return null;

  const activeIndex = representatives.findIndex((document) => document.normalized_invoice_number === activeInvoiceNumber);
  if (activeIndex === -1) return null;
  if (activeIndex === 0) return 'Original';
  return 'Subsequent';
}

function formatActiveInvoiceValue(params: {
  activeInvoice: CanonicalProjectInvoiceSummary;
  activeDocument: InvoiceTruthDocumentDetails | null;
  sequenceLabel: 'Original' | 'Revision' | 'Subsequent' | null;
}): string {
  const baseValue =
    params.activeInvoice.invoice_number
    ?? params.activeDocument?.invoice_number
    ?? (params.activeDocument ? documentDisplayLabel(params.activeDocument.document) : 'Unnamed invoice');

  return params.sequenceLabel ? `${baseValue} (${params.sequenceLabel})` : baseValue;
}

function resolveInvoiceDocumentContext(params: {
  activeInvoice: CanonicalProjectInvoiceSummary | null;
  documents: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
}): {
  invoice_documents: InvoiceTruthDocumentDetails[];
  active_invoice_documents: InvoiceTruthDocumentDetails[];
  matching_documents: InvoiceTruthDocumentDetails[];
  active_document: InvoiceTruthDocumentDetails | null;
  sequence_label: 'Original' | 'Revision' | 'Subsequent' | null;
} {
  const precedenceContext = resolveProjectDocumentPrecedenceContext({
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const precedenceInvoiceDocuments = selectedFamilyDocuments(precedenceContext, 'invoice');
  const activeInvoiceSourceDocuments = precedenceInvoiceDocuments.length > 0
    ? precedenceInvoiceDocuments
    : params.documents.filter(isInvoiceTruthDocument);
  const allInvoiceDocuments = params.documents
    .filter(isInvoiceTruthDocument)
    .map((document) =>
      readInvoiceTruthDocumentDetails(document, precedenceContext),
    );
  const selectedInvoiceDocumentIds = new Set(activeInvoiceSourceDocuments.map((document) => document.id));
  const activeInvoiceDocuments = allInvoiceDocuments.filter((document) =>
    selectedInvoiceDocumentIds.has(document.document.id),
  );

  if (!params.activeInvoice) {
    return {
      invoice_documents: allInvoiceDocuments,
      active_invoice_documents: activeInvoiceDocuments,
      matching_documents: [],
      active_document: null,
      sequence_label: null,
    };
  }

  const activeInvoiceNumber = normalizeTruthIdentifier(params.activeInvoice.invoice_number);
  const matchingDocuments = activeInvoiceNumber
    ? allInvoiceDocuments.filter((document) => document.normalized_invoice_number === activeInvoiceNumber)
    : [];
  const activeMatchingDocuments = matchingDocuments.filter((document) =>
    selectedInvoiceDocumentIds.has(document.document.id),
  );
  const candidateDocuments =
    activeMatchingDocuments.length > 0
      ? activeMatchingDocuments
      : matchingDocuments.length > 0
        ? matchingDocuments
        : activeInvoiceDocuments.length === 1
          ? activeInvoiceDocuments
          : [];
  const activeDocument = sortInvoiceTruthDocumentCandidates(candidateDocuments, params.activeInvoice)[0] ?? null;

  return {
    invoice_documents: allInvoiceDocuments,
    active_invoice_documents: activeInvoiceDocuments,
    matching_documents: matchingDocuments,
    active_document: activeDocument,
    sequence_label: deriveInvoiceSequenceLabel({
      activeInvoice: params.activeInvoice,
      activeDocument,
      matchingDocuments,
      invoiceDocuments: allInvoiceDocuments,
    }),
  };
}

function selectActiveInvoice(
  invoices: readonly CanonicalProjectInvoiceSummary[],
): CanonicalProjectInvoiceSummary | null {
  const rank: Record<CanonicalProjectInvoiceApprovalStatus, number> = {
    blocked: 0,
    needs_review: 1,
    approved_with_exceptions: 2,
    approved: 3,
  };

  return [...invoices].sort((left, right) => {
    const approvalDelta = rank[left.approval_status] - rank[right.approval_status];
    if (approvalDelta !== 0) return approvalDelta;
    const verificationDelta =
      (right.requires_verification_amount ?? 0) - (left.requires_verification_amount ?? 0);
    if (verificationDelta !== 0) return verificationDelta;
    const riskDelta = (right.at_risk_amount ?? 0) - (left.at_risk_amount ?? 0);
    if (riskDelta !== 0) return riskDelta;
    return (right.billed_amount ?? 0) - (left.billed_amount ?? 0);
  })[0] ?? null;
}

export function deriveCanonicalProjectInvoiceFallbackSummary(params: {
  documents: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
}): {
  invoice_summaries: CanonicalProjectInvoiceSummary[];
  total_billed: number | null;
} {
  const precedenceContext = resolveProjectDocumentPrecedenceContext({
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const precedenceInvoiceDocuments = selectedFamilyDocuments(precedenceContext, 'invoice');
  const representativeInvoices = representativeInvoiceDocumentsByNumber(
    (precedenceInvoiceDocuments.length > 0
      ? precedenceInvoiceDocuments
      : params.documents.filter(isInvoiceTruthDocument))
      .map((document) => readInvoiceTruthDocumentDetails(document, precedenceContext)),
  );
  const docsWithAmounts = representativeInvoices.filter((document) => document.billed_amount != null);
  const total_billed = docsWithAmounts.length > 0
    ? docsWithAmounts.reduce((sum, document) => sum + (document.billed_amount ?? 0), 0)
    : null;

  return {
    invoice_summaries: representativeInvoices.map((document) => ({
      invoice_number: document.invoice_number ?? null,
      approval_status: 'needs_review',
      billed_amount: document.billed_amount ?? null,
      billed_amount_source: document.billed_amount != null ? 'invoice_total' : 'missing',
      supported_amount: null,
      at_risk_amount: null,
      requires_verification_amount: null,
      reconciliation_status: 'MISSING',
    })),
    total_billed,
  };
}

type SupportAttachmentContext = {
  linked_invoice_support_documents: CanonicalProjectTruthDocumentInput[];
  linked_project_support_documents: CanonicalProjectTruthDocumentInput[];
};

function resolveSupportAttachmentContext(params: {
  documents: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
  activeInvoiceDocumentId?: string | null;
  contractDocumentId?: string | null;
}): SupportAttachmentContext {
  const precedenceContext = resolveProjectDocumentPrecedenceContext({
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const supportDocuments = [
    ...selectedFamilyDocuments(precedenceContext, 'ticket_support'),
    ...selectedFamilyDocuments(precedenceContext, 'permit'),
  ];
  const supportDocumentById = new Map(
    supportDocuments.map((document) => [document.id, document] as const),
  );

  if (supportDocumentById.size === 0 || precedenceContext.relationships.length === 0) {
    return {
      linked_invoice_support_documents: [],
      linked_project_support_documents: [],
    };
  }

  const linkedInvoiceSupportDocumentIds = new Set<string>();
  const linkedProjectSupportDocumentIds = new Set<string>();

  for (const relationship of precedenceContext.relationships) {
    const relationshipType = canonicalizeRelationshipType(relationship.relationship_type);
    if (relationshipType !== 'attached_to' && relationshipType !== 'supplements') continue;

    const sourceSupportDocument = supportDocumentById.get(relationship.source_document_id) ?? null;
    const targetSupportDocument = supportDocumentById.get(relationship.target_document_id) ?? null;

    if (params.activeInvoiceDocumentId) {
      if (sourceSupportDocument && relationship.target_document_id === params.activeInvoiceDocumentId) {
        linkedInvoiceSupportDocumentIds.add(sourceSupportDocument.id);
      }
      if (targetSupportDocument && relationship.source_document_id === params.activeInvoiceDocumentId) {
        linkedInvoiceSupportDocumentIds.add(targetSupportDocument.id);
      }
    }

    if (params.contractDocumentId) {
      if (sourceSupportDocument && relationship.target_document_id === params.contractDocumentId) {
        linkedProjectSupportDocumentIds.add(sourceSupportDocument.id);
      }
      if (targetSupportDocument && relationship.source_document_id === params.contractDocumentId) {
        linkedProjectSupportDocumentIds.add(targetSupportDocument.id);
      }
    }
  }

  return {
    linked_invoice_support_documents: [...linkedInvoiceSupportDocumentIds]
      .map((documentId) => supportDocumentById.get(documentId) ?? null)
      .filter((document): document is CanonicalProjectTruthDocumentInput => document != null),
    linked_project_support_documents: [...linkedProjectSupportDocumentIds]
      .map((documentId) => supportDocumentById.get(documentId) ?? null)
      .filter((document): document is CanonicalProjectTruthDocumentInput => document != null),
  };
}

function uniqueDefinedValues<T>(
  values: readonly (T | null | undefined)[],
): T[] {
  const seen = new Set<string>();
  const resolved: T[] = [];

  for (const value of values) {
    if (value == null) continue;
    const key =
      typeof value === 'object'
        ? JSON.stringify(value)
        : `${typeof value}:${String(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(value);
  }

  return resolved;
}

function readTransactionOverview(
  dataset: CanonicalProjectTransactionDatasetInput,
): Record<string, unknown> | null {
  const summary = readRowBackedTransactionSummary(dataset) ?? dataset.summary_json ?? null;
  return asRecord(summary?.project_operations_overview) ?? summary;
}

function rowString(row: CanonicalProjectTransactionRowInput, record: Record<string, unknown>, key: keyof CanonicalProjectTransactionRowInput): string | null {
  return readString(record[key as string]) ?? readString(row[key]);
}

function rowNumber(row: CanonicalProjectTransactionRowInput, record: Record<string, unknown>, key: keyof CanonicalProjectTransactionRowInput): number | null {
  return readNumber(record[key as string]) ?? readNumber(row[key]);
}

function rowInteger(row: CanonicalProjectTransactionRowInput, record: Record<string, unknown>, key: keyof CanonicalProjectTransactionRowInput): number | null {
  const value = rowNumber(row, record, key);
  return value != null ? Math.trunc(value) : null;
}

function normalizeTransactionProjectionRow(
  row: CanonicalProjectTransactionRowInput,
): NormalizedTransactionDataRecord {
  const record = asRecord(row.record_json) ?? {};
  const rawRow = asRecord(record.raw_row) ?? asRecord(row.raw_row_json) ?? {};
  const id =
    readString(record.id)
    ?? readString(row.id)
    ?? [
      rowString(row, record, 'document_id') ?? 'transaction-data',
      rowString(row, record, 'source_sheet_name') ?? 'sheet',
      String(rowInteger(row, record, 'source_row_number') ?? 0),
    ].join(':');

  return {
    ...record,
    id,
    evidence_ref:
      readString(record.evidence_ref)
      ?? readString(record.evidenceRef)
      ?? `transaction_data_rows:${id}`,
    column_headers: asRecord(record.column_headers) as NormalizedTransactionDataRecord['column_headers'] ?? {},
    field_evidence_ids: asRecord(record.field_evidence_ids) as NormalizedTransactionDataRecord['field_evidence_ids'] ?? {},
    missing_fields: readStringArray(record.missing_fields),
    confidence: readNumber(record.confidence) ?? 1,
    transaction_number: rowString(row, record, 'transaction_number'),
    invoice_number: rowString(row, record, 'invoice_number'),
    invoice_date: rowString(row, record, 'invoice_date'),
    rate_code: rowString(row, record, 'rate_code'),
    rate_description: readString(record.rate_description),
    transaction_quantity: rowNumber(row, record, 'transaction_quantity'),
    transaction_rate: readNumber(record.transaction_rate),
    extended_cost: rowNumber(row, record, 'extended_cost'),
    net_quantity: readNumber(record.net_quantity),
    mileage: readNumber(record.mileage),
    cyd: readNumber(record.cyd),
    net_tonnage: readNumber(record.net_tonnage),
    diameter: readNumber(record.diameter),
    material: readString(record.material),
    service_item: readString(record.service_item),
    ticket_notes: readString(record.ticket_notes),
    eligibility: readString(record.eligibility),
    eligibility_internal_comments: readString(record.eligibility_internal_comments),
    eligibility_external_comments: readString(record.eligibility_external_comments),
    load_latitude: readNumber(record.load_latitude),
    load_longitude: readNumber(record.load_longitude),
    disposal_latitude: readNumber(record.disposal_latitude),
    disposal_longitude: readNumber(record.disposal_longitude),
    project_name: readString(record.project_name),
    billing_rate_key: rowString(row, record, 'billing_rate_key'),
    description_match_key: rowString(row, record, 'description_match_key'),
    site_material_key: rowString(row, record, 'site_material_key'),
    invoice_rate_key: rowString(row, record, 'invoice_rate_key'),
    source_sheet_name: rowString(row, record, 'source_sheet_name') ?? 'unknown',
    source_row_number: rowInteger(row, record, 'source_row_number') ?? 0,
    raw_row: rawRow,
  } as NormalizedTransactionDataRecord;
}

export function buildCanonicalTransactionSummaryFromRows(
  rows: readonly CanonicalProjectTransactionRowInput[],
): Record<string, unknown> {
  const records = rows.map(normalizeTransactionProjectionRow);
  const normalizedTransactionNumberSet = new Set<string>();
  const normalizedInvoicedTransactionNumberSet = new Set<string>();

  for (const record of records) {
    const transactionNumber = ticketGrainKey(record);
    if (!transactionNumber) continue;
    normalizedTransactionNumberSet.add(transactionNumber);
    if (hasInvoiceLink(record)) {
      normalizedInvoicedTransactionNumberSet.add(transactionNumber);
    }
  }

  const totalExtendedCost = roundNumber(
    records.reduce((sum, record) => sum + (record.extended_cost ?? 0), 0),
    2,
  );
  const totalTransactionQuantity = roundNumber(
    records.reduce((sum, record) => sum + (record.transaction_quantity ?? 0), 0),
    3,
  );
  const ticketGrainQuantityFacts = buildTicketGrainQuantityFacts(records);
  const totalCyd = ticketGrainQuantityFacts.total_cyd_ticket_grain;
  const totalInvoicedAmount = roundNumber(
    records.reduce((sum, record) => sum + (hasInvoiceLink(record) ? (record.extended_cost ?? 0) : 0), 0),
    2,
  );
  const distinctInvoiceCount = new Set(
    records
      .map((record) => normalizeInvoiceNumber(record.invoice_number))
      .filter((value): value is string => value != null),
  ).size;
  const distinctServiceItems = uniqueStrings(records.map((record) => record.service_item));
  const distinctMaterials = uniqueStrings(records.map((record) => effectiveMaterial(record)));
  const eligibilityCounts = records.reduce((accumulator, record) => {
    const status = normalizeEligibility(record.eligibility);
    if (status === 'eligible') accumulator.eligible += 1;
    else accumulator.ineligible += 1;
    return accumulator;
  }, { eligible: 0, ineligible: 0 });
  const groupedByRateCode = buildRateCodeGroups(records);
  const groupedByInvoice = buildInvoiceGroups(records);
  const groupedByMaterial = buildMaterialGroups(records);
  const groupedBySiteType = buildSiteTypeGroups(records);
  const groupedByDisposalSite = buildDisposalSiteGroups(records);
  const reviewedSheetNames = uniqueStrings(records.map((record) => record.source_sheet_name));
  const recordIds = records.map((record) => record.id);
  const evidenceRefs = uniqueStrings(records.map((record) => record.evidence_ref));

  const summary: Record<string, unknown> = {
    row_count: records.length,
    distinct_invoice_numbers: uniqueStrings(records.map((record) => record.invoice_number)),
    distinct_rate_codes: uniqueStrings(records.map((record) => record.rate_code)),
    distinct_service_items: distinctServiceItems,
    distinct_materials: distinctMaterials,
    total_extended_cost: totalExtendedCost,
    total_transaction_quantity: totalTransactionQuantity,
    total_tickets: normalizedTransactionNumberSet.size,
    total_cyd: totalCyd,
    ...ticketGrainQuantityFacts,
    invoiced_ticket_count: normalizedInvoicedTransactionNumberSet.size,
    distinct_invoice_count: distinctInvoiceCount,
    total_invoiced_amount: totalInvoicedAmount,
    uninvoiced_line_count: records.filter((record) => !hasInvoiceLink(record)).length,
    eligible_count: eligibilityCounts.eligible,
    ineligible_count: eligibilityCounts.ineligible,
    rows_with_missing_rate_code: records.filter((record) => record.rate_code == null).length,
    rows_with_missing_invoice_number: records.filter((record) => record.invoice_number == null).length,
    rows_with_missing_quantity: records.filter((record) => record.transaction_quantity == null).length,
    rows_with_missing_extended_cost: records.filter((record) => record.extended_cost == null).length,
    rows_with_zero_cost: records.filter((record) => record.extended_cost === 0).length,
    grouped_by_rate_code: groupedByRateCode,
    grouped_by_invoice: groupedByInvoice,
    grouped_by_material: groupedByMaterial,
    grouped_by_site_type: groupedBySiteType,
    grouped_by_disposal_site: groupedByDisposalSite,
  };

  summary.project_operations_overview = {
    project_name: null,
    total_tickets: summary.total_tickets,
    total_transaction_quantity: totalTransactionQuantity,
    total_cyd: totalCyd,
    total_cyd_ticket_grain: ticketGrainQuantityFacts.total_cyd_ticket_grain,
    total_cyd_ticket_grain_full: ticketGrainQuantityFacts.total_cyd_ticket_grain_full,
    total_mileage_ticket_grain: ticketGrainQuantityFacts.total_mileage_ticket_grain,
    total_mileage_ticket_grain_full: ticketGrainQuantityFacts.total_mileage_ticket_grain_full,
    total_diameter: ticketGrainQuantityFacts.total_diameter,
    total_diameter_full: ticketGrainQuantityFacts.total_diameter_full,
    total_net_tonnage: ticketGrainQuantityFacts.total_net_tonnage,
    total_net_tonnage_full: ticketGrainQuantityFacts.total_net_tonnage_full,
    total_invoiced_amount: totalInvoicedAmount,
    distinct_invoice_count: distinctInvoiceCount,
    invoiced_ticket_count: summary.invoiced_ticket_count,
    uninvoiced_line_count: summary.uninvoiced_line_count,
    eligible_count: eligibilityCounts.eligible,
    ineligible_count: eligibilityCounts.ineligible,
    distinct_service_item_count: distinctServiceItems.length,
    distinct_material_count: distinctMaterials.length,
    distinct_site_type_count: groupedBySiteType.filter((g) => g.site_type != null).length,
    distinct_disposal_site_count: groupedByDisposalSite.filter((g) => g.disposal_site != null).length,
    reviewed_sheet_names: reviewedSheetNames,
    record_ids: recordIds,
    evidence_refs: evidenceRefs,
  };

  return summary;
}

function readRowBackedTransactionSummary(
  dataset: CanonicalProjectTransactionDatasetInput,
): Record<string, unknown> | null {
  return dataset.rows && dataset.rows.length > 0
    ? buildCanonicalTransactionSummaryFromRows(dataset.rows)
    : null;
}

function readProjectRowBackedTransactionSummary(
  datasets: readonly CanonicalProjectTransactionDatasetInput[],
): Record<string, unknown> | null {
  const rows = datasets.flatMap((dataset) => [...(dataset.rows ?? [])]);
  return rows.length > 0
    ? buildCanonicalTransactionSummaryFromRows(rows)
    : null;
}

function findTruthSection(
  sections: readonly CanonicalProjectTruthSection[],
  key: CanonicalProjectTruthSection['key'],
): CanonicalProjectTruthSection | null {
  return sections.find((section) => section.key === key) ?? null;
}

function findTruthRow(
  sections: readonly CanonicalProjectTruthSection[],
  sectionKey: CanonicalProjectTruthSection['key'],
  rowKey: string,
): CanonicalProjectTruthRow | null {
  const section = findTruthSection(sections, sectionKey);
  return section?.rows.find((row) => row.key === rowKey) ?? null;
}

function isUnsettledTruthState(state: CanonicalProjectTruthState): boolean {
  return state === 'missing' || state === 'conflicted' || state === 'requires_review' || state === 'unresolved';
}

function resolveCanonicalTransactionMetric<T>(params: {
  datasets: readonly CanonicalProjectTransactionDatasetInput[];
  readValue: (dataset: CanonicalProjectTransactionDatasetInput) => T | null | undefined;
  sourceLabel?: string;
}): { value: T | null; state: CanonicalProjectTruthState; source_label: string } {
  const values = uniqueDefinedValues(params.datasets.map(params.readValue));
  const sourceLabel = params.sourceLabel ?? 'Canonical transaction data';

  if (values.length === 0) {
    return { value: null, state: 'missing', source_label: sourceLabel };
  }
  if (values.length > 1) {
    return {
      value: null,
      state: 'conflicted',
      source_label:
        params.datasets.length > 1
          ? `Canonical transaction data (${params.datasets.length} datasets)`
          : sourceLabel,
    };
  }

  return {
    value: values[0] ?? null,
    state: 'resolved',
    source_label: sourceLabel,
  };
}

function resolveContractTruthRows(params: {
  facts: CanonicalProjectFacts;
  snapshot: CanonicalProjectValidationSnapshot;
  validationSummary?: unknown;
  documents: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
}): CanonicalProjectTruthRow[] {
  const precedenceContext = resolveProjectDocumentPrecedenceContext({
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const contractDocument = selectContractTruthDocument({
    facts: params.facts,
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const relationshipContextDocuments = resolveContractRelationshipContextDocuments(
    precedenceContext,
  );
  const pricingContextTruth = resolvePricingContextTruth(
    relationshipContextDocuments.pricing,
  );
  const analysis = readContractAnalysis(params.validationSummary) ?? readDocumentContractAnalysis(contractDocument);
  const ceilingTypeField = readContractField(analysis, 'pricing_model', 'contract_ceiling_type');
  const rateScheduleField = readContractField(analysis, 'pricing_model', 'rate_schedule_present');
  const pricingApplicabilityField = readContractField(analysis, 'pricing_model', 'pricing_applicability');
  const effectiveDateField = readContractField(analysis, 'contract_identity', 'effective_date');
  const expirationDateField = readContractField(analysis, 'term_model', 'expiration_date');
  const invoiceDocumentContext = resolveInvoiceDocumentContext({
    activeInvoice: selectActiveInvoice(params.snapshot.invoice_summaries),
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const invoicePeriodTimestamps = aggregateInvoiceDocumentPeriodTimestamps({
    documents:
      invoiceDocumentContext.active_invoice_documents.length > 0
        ? representativeInvoiceDocumentsByNumber(invoiceDocumentContext.active_invoice_documents)
        : representativeInvoiceDocumentsByNumber(invoiceDocumentContext.invoice_documents),
  });

  const governingContractValue =
    documentLabelById(params.facts.contract_document_id, params.documents)
    ?? contractDocument?.title?.trim()
    ?? contractDocument?.name
    ?? (params.facts.contract_document_id ? 'Linked governing contract' : null);
  const contractFacts = readDocumentFacts(contractDocument);
  const contractExtracted = readDocumentExtracted(contractDocument);
  const contractCeilingFallback = readFirstNumberFromRecords(
    [contractFacts, contractExtracted],
    ['contract_ceiling', 'contractCeiling', 'nte_amount', 'nteAmount'],
  );
  const ceilingType = readContractString(ceilingTypeField);
  const rateSchedulePresentFromContract = readContractBoolean(rateScheduleField);
  const rateSchedulePresent =
    rateSchedulePresentFromContract === true
      ? true
      : pricingContextTruth.present === true
        ? true
        : rateSchedulePresentFromContract;
  const approvalContextReady = isApprovedCleanApprovalContext({
    facts: params.facts,
    invoices: params.snapshot.invoice_summaries,
  });
  const effectiveDate = readContractString(effectiveDateField);
  const expirationDate = readContractString(expirationDateField);
  const pricingContextValue = relationshipContextValue(relationshipContextDocuments.pricing);
  const requirementsContextValue = relationshipContextValue(relationshipContextDocuments.compliance);
  const amendmentContextValue = relationshipContextValue(relationshipContextDocuments.amendments);

  const rows: CanonicalProjectTruthRow[] = [
    governingContractValue
      ? truthRow({
          key: 'governing_contract',
          label: 'Governing Contract',
          value: governingContractValue,
          source_label:
            params.facts.contract_document_id
              ? 'Validator-backed project facts'
              : documentSourceLabel(contractDocument, 'Project truth'),
          state: params.facts.contract_document_id ? 'resolved' : 'derived',
        })
      : unavailableTruthRow('governing_contract', 'Governing Contract', 'Project truth'),
    params.facts.nte_amount != null
      ? truthRow({
          key: 'contract_ceiling',
          label: 'Contract Ceiling',
          value: formatCurrency(params.facts.nte_amount),
          source_label: 'Validator-backed project facts',
          state: 'resolved',
        })
      : contractCeilingFallback != null
        ? truthRow({
            key: 'contract_ceiling',
            label: 'Contract Ceiling',
            value: formatCurrency(contractCeilingFallback),
            source_label: documentSourceLabel(contractDocument, 'Project truth'),
            state: 'resolved',
          })
      : ceilingType === 'rate_based'
        ? truthRow({
            key: 'contract_ceiling',
            label: 'Contract Ceiling',
            value: 'Rate-based pricing / no fixed ceiling',
            source_label: contractSourceLabel(ceilingTypeField, contractDocument),
            state: truthStateFromContractField(ceilingTypeField) === 'missing'
              ? 'derived'
              : truthStateFromContractField(ceilingTypeField),
          })
        : ceilingType === 'none'
          ? truthRow({
            key: 'contract_ceiling',
            label: 'Contract Ceiling',
            value: 'No fixed ceiling',
            source_label: contractSourceLabel(ceilingTypeField, contractDocument),
            state: truthStateFromContractField(ceilingTypeField) === 'missing'
              ? 'derived'
              : truthStateFromContractField(ceilingTypeField),
            })
          : unavailableTruthRow('contract_ceiling', 'Contract Ceiling', 'Project truth'),
    rateSchedulePresent != null
      ? truthRow({
          key: 'rate_schedule',
          label: 'Rate Schedule',
          value:
            rateSchedulePresent
              ? (
                approvalContextReady
                  ? 'Rate schedule present. Pricing basis confirmed for current invoice review.'
                  : 'Rate schedule present. Activation or eligibility language may require operator review.'
              )
              : 'Missing',
          source_label:
            rateSchedulePresentFromContract === true || rateSchedulePresent === false
              ? contractSourceLabel(rateScheduleField ?? pricingApplicabilityField, contractDocument)
              : documentSourceLabel(pricingContextTruth.sourceDocument, 'Document relationships'),
          state:
            rateSchedulePresent
              ? (
                rateSchedulePresentFromContract === true
                  ? truthStateFromContractField(rateScheduleField ?? pricingApplicabilityField)
                  : 'derived'
              )
              : 'requires_review',
        })
      : unavailableTruthRow('rate_schedule', 'Rate Schedule', 'Project truth'),
  ];

  if (pricingContextValue) {
    rows.push(
      truthRow({
        key: 'pricing_context',
        label: 'Pricing Context',
        value: pricingContextValue,
        source_label: 'Document relationships',
        state: 'derived',
      }),
    );
  }

  if (requirementsContextValue) {
    rows.push(
      truthRow({
        key: 'requirements_context',
        label: 'Requirements Context',
        value: requirementsContextValue,
        source_label: 'Document relationships',
        state: 'derived',
      }),
    );
  }

  if (amendmentContextValue) {
    rows.push(
      truthRow({
        key: 'amendment_context',
        label: 'Amendment Context',
        value: amendmentContextValue,
        source_label: 'Document relationships',
        state: 'derived',
      }),
    );
  }

  if (effectiveDate || expirationDate) {
    rows.push(
      truthRow({
        key: 'contract_period',
        label: 'Contract Period',
        value:
          effectiveDate && expirationDate
            ? `${formatDate(effectiveDate)} -> ${formatDate(expirationDate)}`
            : effectiveDate
              ? `${formatDate(effectiveDate)} -> Unavailable`
              : `Unavailable -> ${formatDate(expirationDate)}`,
        source_label: documentSourceLabel(contractDocument, 'Project truth'),
        state:
          effectiveDate && expirationDate
            ? (
              truthStateFromContractField(expirationDateField) === 'derived'
                || truthStateFromContractField(effectiveDateField) === 'derived'
            )
              ? 'derived'
              : 'resolved'
            : 'requires_review',
      }),
    );
  } else {
    rows.push(unavailableTruthRow('contract_period', 'Contract Period', 'Project truth'));
  }

  if (expirationDate) {
    const expirationTimestamp = new Date(expirationDate).getTime();
    const expired = Number.isFinite(expirationTimestamp) && expirationTimestamp < Date.now();
    const invoicePeriodEndTimestamp = invoicePeriodTimestamps.end;
    const expiredAfterInvoicePeriod =
      expired
      && invoicePeriodEndTimestamp != null
      && invoicePeriodEndTimestamp <= expirationTimestamp;
    rows.push(
      truthRow({
        key: 'expiration_status',
        label: 'Expiration Status',
        value:
          expiredAfterInvoicePeriod
            ? `Expired ${formatDate(expirationDate)} after current invoice period.`
            : expired
              ? `Expired ${formatDate(expirationDate)}`
              : `Active through ${formatDate(expirationDate)}`,
        source_label: contractSourceLabel(expirationDateField, contractDocument),
        state:
          expiredAfterInvoicePeriod
            ? 'derived'
            : expired
            ? 'requires_review'
            : truthStateFromContractField(expirationDateField),
      }),
    );
  } else {
    rows.push(unavailableTruthRow('expiration_status', 'Expiration Status', 'Project truth'));
  }

  return rows;
}

function resolveInvoiceTruthRows(params: {
  snapshot: CanonicalProjectValidationSnapshot;
  documents: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
}): CanonicalProjectTruthRow[] {
  const snapshot = params.snapshot;
  const activeInvoice = selectActiveInvoice(snapshot.invoice_summaries);
  const documentFallback = deriveCanonicalProjectInvoiceFallbackSummary({
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const invoiceDocumentContext = resolveInvoiceDocumentContext({
    activeInvoice,
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const activeInvoiceDocumentsForTruth =
    invoiceDocumentContext.active_invoice_documents.length > 0
      ? invoiceDocumentContext.active_invoice_documents
      : invoiceDocumentContext.invoice_documents;
  const representativeInvoiceDocuments = representativeInvoiceDocumentsByNumber(
    activeInvoiceDocumentsForTruth,
  );
  const fallbackActiveDocument =
    invoiceDocumentContext.active_document
    ?? latestInvoiceTruthDocument(
      representativeInvoiceDocuments.length > 0
        ? representativeInvoiceDocuments
        : activeInvoiceDocumentsForTruth,
    );
  const activeInvoiceDocument =
    invoiceDocumentContext.active_document?.document
    ?? fallbackActiveDocument?.document
    ?? null;
  const invoiceDocuments = activeInvoiceDocumentsForTruth.map((document) => document.document);
  const invoiceCount = Math.max(
    snapshot.invoice_summaries.length,
    representativeInvoiceDocuments.length,
    invoiceDocuments.length,
  );
  const matchingInvoiceDocuments =
    invoiceDocumentContext.matching_documents.length > 0
      ? invoiceDocumentContext.matching_documents
      : invoiceDocumentContext.active_document
        ? [invoiceDocumentContext.active_document]
        : [];
  const matchingDocumentAmounts = uniqueDefinedValues(
    matchingInvoiceDocuments.map((document) => document.billed_amount),
  );
  const matchingDocumentAmount =
    matchingDocumentAmounts.length === 1 ? matchingDocumentAmounts[0] ?? null : null;
  const fallbackBilledAmount = aggregateInvoiceDocumentBilledAmount({
    documents: representativeInvoiceDocuments,
  });
  const aggregateSupportCoverage = aggregateInvoiceApprovalSupportCoverage(snapshot.invoice_summaries);
  const aggregateBilledAmount =
    snapshot.facts.total_billed
    ?? documentFallback.total_billed
    ?? fallbackBilledAmount.value;
  const useAggregateBilledAmount = invoiceCount > 1 && aggregateBilledAmount != null;
  const billedAmountValue =
    (useAggregateBilledAmount ? aggregateBilledAmount : null)
    ?? activeInvoice?.billed_amount
    ?? invoiceDocumentContext.active_document?.billed_amount
    ?? matchingDocumentAmount
    ?? (snapshot.invoice_summaries.length === 0 ? documentFallback.total_billed : null);
  const fallbackBillingPeriodValue = aggregateInvoiceDocumentBillingPeriod({
    documents: representativeInvoiceDocuments,
  });
  const billingPeriodValue =
    invoiceDocumentContext.active_document?.billing_period
    ?? readInvoiceDocumentPeriodValue(activeInvoiceDocument)
    ?? (snapshot.invoice_summaries.length === 0 ? fallbackBillingPeriodValue : null);
  const fallbackSequenceLabel =
    invoiceDocumentContext.sequence_label
    ?? (
      fallbackActiveDocument == null
        ? null
        : invoiceDocumentContext.invoice_documents.filter(
          (document) => document.normalized_invoice_number === fallbackActiveDocument.normalized_invoice_number,
        ).length > 1
          ? 'Revision'
          : representativeInvoiceDocuments.length > 1
            ? 'Subsequent'
            : null
    );
  const activeInvoiceValue = activeInvoice
    ? formatActiveInvoiceValue({
        activeInvoice,
        activeDocument: invoiceDocumentContext.active_document,
        sequenceLabel: invoiceDocumentContext.sequence_label,
      })
    : fallbackActiveDocument != null
      ? (
        fallbackSequenceLabel
          ? `${fallbackActiveDocument.invoice_number ?? documentDisplayLabel(fallbackActiveDocument.document)} (${fallbackSequenceLabel})`
          : (fallbackActiveDocument.invoice_number ?? documentDisplayLabel(fallbackActiveDocument.document))
      )
      : 'Unnamed invoice';
  const activeInvoiceStatusLabel =
    activeInvoice != null
      ? invoiceApprovalLabel(activeInvoice.approval_status)
      : fallbackActiveDocument != null
        ? 'needs review'
        : 'unresolved';
  const sequenceContext =
    (invoiceDocumentContext.sequence_label ?? fallbackSequenceLabel) === 'Revision'
      ? `revision sequence detected for ${activeInvoice?.invoice_number ?? 'the active invoice'}`
      : (invoiceDocumentContext.sequence_label ?? fallbackSequenceLabel) === 'Original'
        ? `original record in the known invoice sequence`
        : (invoiceDocumentContext.sequence_label ?? fallbackSequenceLabel) === 'Subsequent'
          ? `subsequent billing record in the known invoice sequence`
          : null;
  const billedAmountState =
    useAggregateBilledAmount
      ? (
        snapshot.facts.total_billed != null
          ? 'resolved'
          : fallbackBilledAmount.state
      )
      : activeInvoice?.billed_amount != null
      ? matchingDocumentAmounts.length > 1
        ? 'conflicted'
        : matchingDocumentAmount != null && !invoiceAmountsMatch(matchingDocumentAmount, activeInvoice.billed_amount)
          ? 'conflicted'
          : activeInvoice.billed_amount_source === 'invoice_total'
            ? 'resolved'
            : activeInvoice.billed_amount_source === 'line_total_fallback'
              ? 'derived'
              : 'requires_review'
      : snapshot.invoice_summaries.length === 0 && fallbackBilledAmount.value != null
        ? fallbackBilledAmount.state
      : matchingDocumentAmounts.length > 1
        ? invoiceDocumentContext.sequence_label != null
          ? 'derived'
          : 'conflicted'
        : billedAmountValue != null
          ? invoiceDocumentContext.sequence_label === 'Revision'
            || invoiceDocumentContext.sequence_label === 'Subsequent'
            ? 'derived'
            : 'resolved'
          : 'missing';
  const governingContractDocument = selectContractTruthDocument({
    facts: snapshot.facts,
    documents: params.documents,
    documentRelationships: params.documentRelationships,
  });
  const supportAttachmentContext = resolveSupportAttachmentContext({
    documents: params.documents,
    documentRelationships: params.documentRelationships,
    activeInvoiceDocumentId: activeInvoiceDocument?.id ?? null,
    contractDocumentId: governingContractDocument?.id ?? null,
  });
  const invoiceLinkedSupportCount = supportAttachmentContext.linked_invoice_support_documents.length;
  const projectLinkedSupportCount = supportAttachmentContext.linked_project_support_documents.length;

  const rows: CanonicalProjectTruthRow[] = [
    snapshot.invoice_summaries.length > 1
      ? truthRow({
          key: 'active_invoice',
          label: 'Invoice Approval Context',
          value: formatInvoiceApprovalContextValue(snapshot.invoice_summaries),
          source_label: 'Validator-backed project facts',
          state: invoiceApprovalContextState(snapshot.invoice_summaries),
        })
    : activeInvoice
      ? truthRow({
          key: 'active_invoice',
          label: 'Active Invoice',
          value: activeInvoiceValue,
          source_label:
            activeInvoiceDocument != null
              ? documentSourceLabel(activeInvoiceDocument, invoiceSourceLabel(activeInvoice.billed_amount_source))
              : invoiceSourceLabel(activeInvoice.billed_amount_source),
          state: invoiceApprovalState(activeInvoice.approval_status),
        })
      : fallbackActiveDocument != null
        ? truthRow({
            key: 'active_invoice',
            label: 'Active Invoice',
            value: activeInvoiceValue,
            source_label: documentSourceLabel(fallbackActiveDocument.document, 'Project truth'),
            state: fallbackSequenceLabel != null ? 'derived' : 'resolved',
          })
      : unavailableTruthRow('active_invoice', 'Active Invoice', 'Validator-backed project facts'),
    invoiceCount > 0
      ? truthRow({
          key: 'invoice_context',
          label: 'Invoice Context',
          value:
            snapshot.invoice_summaries.length > 0
              ? (
                `${formatCount(invoiceCount)} invoice${invoiceCount === 1 ? '' : 's'} in approval context; `
                + `active invoice ${activeInvoiceStatusLabel}`
                + (sequenceContext ? `; ${sequenceContext}` : '')
              )
              : (
                `${formatCount(invoiceCount)} invoice${invoiceCount === 1 ? '' : 's'} detected from project truth`
                + (fallbackActiveDocument?.invoice_number ? `; latest invoice ${fallbackActiveDocument.invoice_number}` : '')
                + (sequenceContext ? `; ${sequenceContext}` : '')
              ),
          source_label: snapshot.invoice_summaries.length > 0 ? 'Validator-backed project facts' : 'Project truth',
          state:
            (invoiceDocumentContext.sequence_label ?? fallbackSequenceLabel) != null
              ? 'derived'
              : invoiceCount > 1 && activeInvoiceDocument == null && invoiceDocuments.length > 1
                ? 'requires_review'
                : invoiceCount > 1
                  ? 'derived'
                  : 'resolved',
        })
      : invoiceDocuments.length > 0
        ? truthRow({
            key: 'invoice_context',
            label: 'Invoice Context',
            value: 'Invoice documents are present, but approval context is not yet resolved',
            source_label: 'Project truth',
            state: 'unresolved',
          })
        : unavailableTruthRow('invoice_context', 'Invoice Context', 'Validator-backed project facts'),
    billedAmountValue != null
      ? truthRow({
          key: 'billed_amount',
          label: PROJECT_TERM_INVOICE_BILLED_AMOUNT,
          value: formatCurrency(billedAmountValue),
          source_label:
            useAggregateBilledAmount
              ? (
                snapshot.facts.total_billed != null
                  ? 'Validator-backed project facts'
                  : 'Project truth'
              )
              : activeInvoice?.billed_amount != null
              ? invoiceSourceLabel(activeInvoice.billed_amount_source)
              : documentSourceLabel(activeInvoiceDocument, 'Project truth'),
          state: billedAmountState,
        })
      : unavailableTruthRow('billed_amount', PROJECT_TERM_INVOICE_BILLED_AMOUNT, 'Validator-backed project facts'),
  ];

  if (activeInvoice) {
    const billedAmount = billedAmountValue;
    const supportedAmount =
      aggregateSupportCoverage.supported_amount
      ?? activeInvoice.supported_amount
      ?? null;
    const atRiskAmount = aggregateSupportCoverage.at_risk_amount ?? activeInvoice.at_risk_amount ?? null;
    const requiresVerificationAmount =
      aggregateSupportCoverage.requires_verification_amount
      ?? activeInvoice.requires_verification_amount
      ?? null;
    const isCompleteCoverage =
      supportedAmount != null
      && billedAmount != null
      && supportedAmount >= billedAmount
      && (atRiskAmount == null || atRiskAmount <= 0)
      && (requiresVerificationAmount == null || requiresVerificationAmount <= 0);
    rows.push(
      supportedAmount == null || billedAmount == null
        ? invoiceLinkedSupportCount > 0
          ? truthRow({
              key: 'support_coverage',
              label: 'Support Coverage',
              value:
                invoiceLinkedSupportCount === 1
                  ? 'Linked support document'
                  : `Linked support documents (${formatCount(invoiceLinkedSupportCount)})`,
              source_label: 'Document relationships',
              state: 'derived',
            })
          : unavailableTruthRow('support_coverage', 'Support Coverage', 'Validator-backed project facts')
        : truthRow({
            key: 'support_coverage',
            label: 'Support Coverage',
            value:
              supportedAmount <= 0
                ? 'Missing'
                : isCompleteCoverage
                  ? `Complete (${formatCurrency(supportedAmount)} of ${formatCurrency(billedAmount)} supported)`
                  : `Partial (${formatCurrency(supportedAmount)} of ${formatCurrency(billedAmount)} supported)`,
            source_label: 'Validator-backed project facts',
            state:
              supportedAmount <= 0
                ? 'requires_review'
                : isCompleteCoverage
                  ? billedAmountState === 'resolved' ? 'resolved' : 'derived'
                  : 'requires_review',
          }),
    );
  } else {
    rows.push(
      invoiceLinkedSupportCount > 0
        ? truthRow({
            key: 'support_coverage',
            label: 'Support Coverage',
            value:
              invoiceLinkedSupportCount === 1
                ? 'Linked support document'
                : `Linked support documents (${formatCount(invoiceLinkedSupportCount)})`,
            source_label: 'Document relationships',
            state: 'derived',
          })
      : invoiceDocuments.length > 0
        ? truthRow({
            key: 'support_coverage',
            label: 'Support Coverage',
            value:
              projectLinkedSupportCount > 0
                ? projectLinkedSupportCount === 1
                  ? 'Project-level support linked'
                  : `Project-level support linked (${formatCount(projectLinkedSupportCount)})`
                : 'Awaiting approval-context support assessment',
            source_label:
              projectLinkedSupportCount > 0
                ? 'Document relationships'
                : 'Validator-backed project facts',
            state: projectLinkedSupportCount > 0 ? 'derived' : 'unresolved',
          })
        : unavailableTruthRow('support_coverage', 'Support Coverage', 'Validator-backed project facts'),
    );
  }

  rows.push(
    billingPeriodValue
      ? truthRow({
          key: 'billing_period',
          label: 'Billing Period / Date',
          value: billingPeriodValue.value,
          source_label: documentSourceLabel(activeInvoiceDocument, 'Project truth'),
          state: billingPeriodValue.state,
        })
      : unavailableTruthRow('billing_period', 'Billing Period / Date', 'Project truth'),
  );

  return rows;
}

function resolveTransactionTruthRows(
  datasets: readonly CanonicalProjectTransactionDatasetInput[],
): CanonicalProjectTruthRow[] {
  const sourceLabel = 'Canonical transaction data';
  const rowBackedSummary = readProjectRowBackedTransactionSummary(datasets);
  const metricDatasets =
    rowBackedSummary != null
      ? [{
          document_id: 'project-union',
          row_count: readNumber(rowBackedSummary.row_count),
          date_range_start: null,
          date_range_end: null,
          summary_json: rowBackedSummary,
          created_at: null,
        }]
      : datasets;
  const ticketRecords = resolveCanonicalTransactionMetric({
    datasets: metricDatasets,
    readValue: (dataset) => dataset.row_count,
    sourceLabel,
  });
  const uniqueTickets = resolveCanonicalTransactionMetric({
    datasets: metricDatasets,
    readValue: (dataset) => readNumber(readTransactionOverview(dataset)?.total_tickets),
    sourceLabel,
  });
  const totalCyd = resolveCanonicalTransactionMetric({
    datasets: metricDatasets,
    readValue: (dataset) => {
      const overview = readTransactionOverview(dataset);
      return (
        readNumber(overview?.total_cyd_ticket_grain)
        ?? readNumber(overview?.total_cyd)
      );
    },
    sourceLabel,
  });
  const eligibility = resolveCanonicalTransactionMetric({
    datasets: metricDatasets,
    readValue: (dataset) => {
      const overview = readTransactionOverview(dataset);
      const eligible = readNumber(overview?.eligible_count);
      const ineligible = readNumber(overview?.ineligible_count);
      return eligible != null || ineligible != null
        ? `${formatCount(eligible ?? 0)} eligible / ${formatCount(ineligible ?? 0)} ineligible`
        : null;
    },
    sourceLabel,
  });
  const totalInvoicedAmount = resolveCanonicalTransactionMetric({
    datasets: metricDatasets,
    readValue: (dataset) => readNumber(readTransactionOverview(dataset)?.total_invoiced_amount),
    sourceLabel,
  });

  const transactionConflictLabel =
    metricDatasets.length > 1
      ? `Canonical transaction data (${metricDatasets.length} datasets)`
      : sourceLabel;

  return [
    ticketRecords.value != null
      ? truthRow({
          key: 'ticket_records',
          label: PROJECT_TERM_TOTAL_TRANSACTION_ROWS,
          value: formatCount(ticketRecords.value),
          source_label: ticketRecords.source_label,
          state: ticketRecords.state,
        })
      : unavailableTruthRow('ticket_records', PROJECT_TERM_TOTAL_TRANSACTION_ROWS, transactionConflictLabel),
    uniqueTickets.value != null
      ? truthRow({
          key: 'unique_tickets',
          label: PROJECT_TERM_UNIQUE_TICKET_NUMBERS,
          value: formatCount(uniqueTickets.value),
          source_label: uniqueTickets.source_label,
          state: uniqueTickets.state,
        })
      : unavailableTruthRow('unique_tickets', PROJECT_TERM_UNIQUE_TICKET_NUMBERS, transactionConflictLabel),
    totalCyd.value != null
      ? truthRow({
          key: 'volume',
          label: 'Resolved Volume',
          value: `${formatCount(totalCyd.value)} CYD`,
          source_label: totalCyd.source_label,
          state: totalCyd.state,
        })
      : unavailableTruthRow('volume', 'Resolved Volume', transactionConflictLabel),
    eligibility.value != null
      ? truthRow({
          key: 'eligibility',
          label: 'Eligibility',
          value: eligibility.value,
          source_label: eligibility.source_label,
          state: eligibility.state,
        })
      : unavailableTruthRow('eligibility', 'Eligibility', transactionConflictLabel),
    totalInvoicedAmount.value != null
      ? truthRow({
          key: 'total_invoiced_amount',
          label: PROJECT_TERM_WORKBOOK_INVOICED_AMOUNT,
          value: formatCurrency(totalInvoicedAmount.value),
          source_label: totalInvoicedAmount.source_label,
          state: totalInvoicedAmount.state,
        })
      : unavailableTruthRow('total_invoiced_amount', PROJECT_TERM_WORKBOOK_INVOICED_AMOUNT, transactionConflictLabel),
  ];
}

function formatValidationStatus(value: ValidationStatus): string {
  switch (value) {
    case 'VALIDATED':
      return 'Validated';
    case 'FINDINGS_OPEN':
      return 'Findings Open';
    case 'BLOCKED':
      return 'Blocked';
    case 'NOT_READY':
    default:
      return 'Not Ready';
  }
}

export function resolveCanonicalProjectTruthSections(params: {
  validationStatus?: string | null;
  validationSummary?: unknown;
  validationFindings?: readonly ValidationFinding[] | null;
  decisions?: readonly CanonicalProjectDecisionInput[] | null;
  documents?: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[];
}): CanonicalProjectTruthSection[] {
  const documents = params.documents ?? [];
  const datasets = params.transactionDatasets ?? [];
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.validationStatus,
    validationSummary: params.validationSummary,
    validationFindings: params.validationFindings,
    decisions: params.decisions,
    transactionDatasets: params.transactionDatasets,
  });
  const facts = snapshot.facts;
  const approvalStatus = approvalStatusLabelForProjectFacts(facts);
  const blockerCount = approvalBlockerCountForProjectFacts(facts);
  const verificationFindingCount = blockerCount + facts.warning_count + facts.requires_review_count;
  const unsupportedAmount = unsupportedAmountForFacts(facts);

  return [
    {
      key: 'contract',
      title: 'Contract Truth',
      rows: resolveContractTruthRows({
        facts,
        snapshot,
        validationSummary: params.validationSummary,
        documents,
        documentRelationships: params.documentRelationships,
      }),
    },
    {
      key: 'invoice',
      title: 'Invoice Truth',
      rows: resolveInvoiceTruthRows({
        snapshot,
        documents,
        documentRelationships: params.documentRelationships,
      }),
    },
    {
      key: 'transaction',
      title: 'Transaction Truth',
      rows: resolveTransactionTruthRows(datasets),
    },
    {
      key: 'validation',
      title: 'Validation Truth',
      rows: [
        truthRow({
          key: 'validation_status',
          label: 'Validation Status',
          value: formatValidationStatus(facts.status),
          source_label: 'Validator-backed project facts',
          state:
            facts.status === 'VALIDATED'
              ? 'resolved'
              : facts.status === 'NOT_READY'
                ? 'unresolved'
                : 'requires_review',
        }),
        truthRow({
          key: 'approval_readiness',
          label: 'Readiness',
          value: approvalStatus,
          source_label: 'Validator-backed project facts',
          state:
            approvalStatus === 'Approved'
              ? 'resolved'
              : approvalStatus === 'Not Evaluated'
                ? 'unresolved'
                : 'requires_review',
        }),
        truthRow({
          key: 'blockers',
          label: 'Blockers',
          value: formatCount(blockerCount),
          source_label: 'Validator-backed project facts',
          state: blockerCount > 0 ? 'requires_review' : 'resolved',
        }),
        truthRow({
          key: 'warnings',
          label: 'Warnings',
          value: formatCount(facts.warning_count + facts.requires_review_count),
          source_label: 'Validator-backed project facts',
          state: (facts.warning_count + facts.requires_review_count) > 0 ? 'requires_review' : 'resolved',
        }),
        approvalStatus !== 'Not Evaluated'
          ? truthRow({
              key: 'blocked_amount',
              label: 'Blocked Amount',
              value: formatCurrency(snapshot.blocked_amount ?? 0),
              source_label: 'Approval gate truth',
              state:
                (snapshot.blocked_amount ?? 0) > 0
                  ? 'requires_review'
                  : 'resolved',
            })
          : unavailableTruthRow('blocked_amount', 'Blocked Amount', 'Primary approval decision'),
        facts.total_at_risk != null
          ? truthRow({
              key: 'at_risk_amount',
              label: PROJECT_TERM_AT_RISK_AMOUNT,
              value: formatCurrency(facts.total_at_risk),
              source_label: 'Validator-backed project facts',
              state: facts.total_at_risk > 0 ? 'requires_review' : 'resolved',
            })
          : unavailableTruthRow('at_risk_amount', PROJECT_TERM_AT_RISK_AMOUNT, 'Validator-backed project facts'),
        unsupportedAmount != null
          ? truthRow({
              key: 'unsupported_amount',
              label: PROJECT_TERM_UNSUPPORTED_AMOUNT,
              value: formatCurrency(unsupportedAmount),
              source_label: 'Approval gate truth',
              state: unsupportedAmount > 0 ? 'requires_review' : 'resolved',
            })
          : unavailableTruthRow('unsupported_amount', PROJECT_TERM_UNSUPPORTED_AMOUNT, 'Approval gate truth'),
        facts.requires_verification_amount != null
          ? truthRow({
              key: 'requires_verification_amount',
              label: 'Requires Verification',
              value: formatCurrency(facts.requires_verification_amount),
              source_label: 'Validator-backed project facts',
              state: facts.requires_verification_amount > 0 ? 'requires_review' : 'resolved',
            })
          : verificationFindingCount > 0
            ? truthRow({
                key: 'requires_verification_amount',
                label: 'Requires Verification',
                value: `${formatCount(verificationFindingCount)} finding${verificationFindingCount === 1 ? '' : 's'}`,
                source_label: 'Validator-backed project facts',
                state: 'requires_review',
              })
            : unavailableTruthRow('requires_verification_amount', 'Requires Verification', 'Validator-backed project facts'),
      ],
    },
  ];
}

export function resolveCanonicalProjectOverviewBriefing(params: {
  validationStatus?: string | null;
  validationSummary?: unknown;
  validationFindings?: readonly ValidationFinding[] | null;
  decisions?: readonly CanonicalProjectDecisionInput[] | null;
  documents?: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[];
  requiredReviewCount?: number | null;
}): CanonicalProjectOverviewBriefing {
  const truthSections = resolveCanonicalProjectTruthSections(params);
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.validationStatus,
    validationSummary: params.validationSummary,
    validationFindings: params.validationFindings,
    decisions: params.decisions,
    transactionDatasets: params.transactionDatasets,
  });
  const facts = snapshot.facts;
  const approvalStatus = approvalStatusLabelForProjectFacts(facts);
  const blockerCount = approvalBlockerCountForProjectFacts(facts);
  const warningCount = facts.warning_count + facts.requires_review_count;
  const projectPrimaryDecision = resolveProjectPrimaryApprovalDecision(params.decisions);
  const effectiveRequiredReviewCount = Math.max(
    0,
    (params.requiredReviewCount != null && params.requiredReviewCount > 0)
      ? params.requiredReviewCount
      : facts.open_count > 0
        ? facts.open_count
        : blockerCount + warningCount,
  );
  const decisionNextAction =
    effectiveRequiredReviewCount > 0
      ? (
        projectPrimaryDecision?.required_action
        ?? 'Open Decisions and resolve the highest-priority review first.'
      )
      : 'Review the Validator tab to confirm the blocking findings and next operator step.';

  const governingContract = findTruthRow(truthSections, 'contract', 'governing_contract');
  const contractCeiling = findTruthRow(truthSections, 'contract', 'contract_ceiling');
  const contractExpiration = findTruthRow(truthSections, 'contract', 'expiration_status');
  const activeInvoice = findTruthRow(truthSections, 'invoice', 'active_invoice');
  const invoiceContext = findTruthRow(truthSections, 'invoice', 'invoice_context');
  const supportCoverage = findTruthRow(truthSections, 'invoice', 'support_coverage');
  const cleanApprovedContext = isApprovedCleanApprovalContext({
    facts,
    invoices: snapshot.invoice_summaries,
  });

  const criticalSignals: CanonicalProjectOverviewSignal[] = [];

  if (blockerCount > 0 || approvalStatus !== 'Approved') {
    criticalSignals.push({
      key: 'approval_blockers',
      title:
        blockerCount > 0
          ? `${formatCount(blockerCount)} approval blocker${blockerCount === 1 ? '' : 's'} open`
          : `Project readiness is ${approvalStatus.toLowerCase()}`,
      description:
        facts.blocked_reasons[0]
        ?? (
          approvalStatus === 'Blocked'
            ? 'Critical validation findings are preventing approval.'
            : approvalStatus === 'Needs Review'
              ? 'Validation is open and operator review is still required.'
              : 'Approval readiness has not been established yet.'
        ),
      severity:
        blockerCount > 0 || approvalStatus === 'Blocked'
          ? 'critical'
          : approvalStatus === 'Needs Review'
            ? 'warning'
            : 'info',
      gate_impact:
        approvalStatus === 'Blocked'
          ? 'Approval cannot proceed until the blocking findings are resolved.'
          : approvalStatus === 'Needs Review'
            ? 'Approval remains open and requires operator verification.'
            : 'The project is not yet ready to move into clean approval flow.',
      next_action:
        decisionNextAction,
    });
  }

  if (
    supportCoverage
    && (supportCoverage.value === 'Missing' || supportCoverage.value.startsWith('Partial') || supportCoverage.state === 'unresolved')
  ) {
    criticalSignals.push({
      key: 'missing_support',
      title: 'Invoice support is incomplete',
      description:
        supportCoverage.state === 'unresolved'
          ? 'Invoice documents are present, but support coverage has not been resolved yet.'
          : `Support coverage is currently ${supportCoverage.value.toLowerCase()}.`,
      severity: supportCoverage.value === 'Missing' ? 'critical' : 'warning',
      gate_impact: 'Invoice approval cannot clear until support is attached or verified.',
      next_action:
        effectiveRequiredReviewCount > 0
          ? decisionNextAction
          : 'Open Documents to confirm support files, governing priority, and superseded records.',
    });
  }

  if (
    (activeInvoice && isUnsettledTruthState(activeInvoice.state))
    || (invoiceContext && isUnsettledTruthState(invoiceContext.state))
  ) {
    criticalSignals.push({
      key: 'unresolved_invoice_truth',
      title: 'Invoice truth is not fully resolved',
      description:
        activeInvoice?.state === 'unresolved' || invoiceContext?.state === 'unresolved'
          ? 'Invoice documents are present, but the active approval context is not settled.'
          : activeInvoice?.state === 'conflicted' || invoiceContext?.state === 'conflicted'
            ? 'Invoice records disagree on the active approval context.'
            : 'The current invoice context still needs operator confirmation.',
      severity:
        activeInvoice?.state === 'conflicted' || invoiceContext?.state === 'conflicted'
          ? 'critical'
          : 'warning',
      gate_impact: 'Operators cannot confidently advance the invoice until the approval context is clear.',
      next_action:
        effectiveRequiredReviewCount > 0
          ? decisionNextAction
          : 'Review the Facts and Validator tabs to confirm the active invoice and billing context.',
    });
  }

  if (
    (governingContract && isUnsettledTruthState(governingContract.state))
    || (contractCeiling && isUnsettledTruthState(contractCeiling.state))
    || (
      contractExpiration
      && isUnsettledTruthState(contractExpiration.state)
      && !cleanApprovedContext
    )
  ) {
    criticalSignals.push({
      key: 'contract_risk',
      title: 'Contract truth has open risk',
      description:
        governingContract?.state === 'missing'
          ? 'No governing contract is resolved for the project.'
          : contractCeiling?.state === 'missing'
            ? 'Contract ceiling is not resolved yet.'
            : contractExpiration?.state === 'requires_review'
              ? `Contract term needs attention: ${contractExpiration.value}.`
              : 'Contract truth still has open risk that needs confirmation.',
      severity:
        governingContract?.state === 'missing' || contractCeiling?.state === 'missing'
          ? 'critical'
          : 'warning',
      gate_impact: 'Contract uncertainty weakens approval confidence and can block clean payment decisions.',
      next_action:
        effectiveRequiredReviewCount > 0
          ? decisionNextAction
          : 'Use Facts and Documents to confirm the governing contract, ceiling, and current term status.',
    });
  }

  return {
    summary_items: [
      {
        key: 'validation_status',
        label: 'Validation Status',
        value: formatValidationStatus(facts.status),
        state:
          facts.status === 'VALIDATED'
            ? 'resolved'
            : facts.status === 'NOT_READY'
              ? 'unresolved'
              : 'requires_review',
      },
      {
        key: 'readiness',
        label: 'Readiness',
        value: approvalStatus,
        state:
          approvalStatus === 'Approved'
            ? 'resolved'
            : approvalStatus === 'Not Evaluated'
              ? 'unresolved'
              : 'requires_review',
      },
      {
        key: 'blockers',
        label: 'Blockers',
        value: formatCount(blockerCount),
        state: blockerCount > 0 ? 'requires_review' : 'resolved',
      },
      {
        key: 'warnings',
        label: 'Warnings',
        value: formatCount(warningCount),
        state: warningCount > 0 ? 'requires_review' : 'resolved',
      },
      {
        key: 'at_risk_amount',
        label: PROJECT_TERM_AT_RISK_AMOUNT,
        value: facts.total_at_risk != null ? formatCurrency(facts.total_at_risk) : 'Unavailable',
        state:
          facts.total_at_risk == null
            ? 'missing'
            : facts.total_at_risk > 0
              ? 'requires_review'
              : 'resolved',
      },
      {
        key: 'required_reviews',
        label: 'Required Reviews',
        value: formatCount(effectiveRequiredReviewCount),
        state:
          effectiveRequiredReviewCount > 0
            ? 'requires_review'
            : approvalStatus === 'Not Evaluated'
              ? 'unresolved'
              : 'resolved',
      },
    ],
    critical_signals: criticalSignals,
    snapshot_sections: [
      {
        key: 'contract',
        title: 'Contract',
        rows: [
          findTruthRow(truthSections, 'contract', 'governing_contract'),
          findTruthRow(truthSections, 'contract', 'contract_ceiling'),
          findTruthRow(truthSections, 'contract', 'expiration_status'),
        ].filter((row): row is CanonicalProjectTruthRow => row != null),
      },
      {
        key: 'invoice',
        title: 'Invoice',
        rows: [
          findTruthRow(truthSections, 'invoice', 'active_invoice'),
          findTruthRow(truthSections, 'invoice', 'billed_amount'),
          findTruthRow(truthSections, 'invoice', 'support_coverage'),
        ].filter((row): row is CanonicalProjectTruthRow => row != null),
      },
      {
        key: 'transaction',
        title: 'Transaction',
        rows: [
          findTruthRow(truthSections, 'transaction', 'unique_tickets'),
          findTruthRow(truthSections, 'transaction', 'volume'),
          findTruthRow(truthSections, 'transaction', 'total_invoiced_amount'),
        ].filter((row): row is CanonicalProjectTruthRow => row != null),
      },
    ],
  };
}

function contractInvoiceRelationshipBlock(
  facts: CanonicalProjectFacts,
): CanonicalProjectValidatorRelationshipBlock | null {
  const reconciliation = facts.contract_invoice_reconciliation;
  if (!reconciliation) return null;

  const mismatches: CanonicalProjectValidatorMismatch[] = [];

  pushMismatch(
    mismatches,
    reconciliation.vendor_identity_status !== 'MATCH'
      ? {
          key: 'vendor_identity',
          label: 'Contractor identity',
          expected_value: 'Contract and invoice identify the same counterparty.',
          actual_value: formatReconciliationStatus(reconciliation.vendor_identity_status),
          impact: 'Identity mismatches weaken confidence in who is being billed and paid.',
          severity:
            reconciliation.vendor_identity_status === 'MISMATCH' || reconciliation.vendor_identity_status === 'MISSING'
              ? 'critical'
              : 'warning',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    reconciliation.client_identity_status !== 'MATCH'
      ? {
          key: 'client_identity',
          label: 'Client identity',
          expected_value: 'Contract and invoice identify the same client or project owner.',
          actual_value: formatReconciliationStatus(reconciliation.client_identity_status),
          impact: 'Client identity drift can invalidate approval confidence.',
          severity:
            reconciliation.client_identity_status === 'MISMATCH' || reconciliation.client_identity_status === 'MISSING'
              ? 'critical'
              : 'warning',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    reconciliation.service_period_status !== 'MATCH'
      ? {
          key: 'service_period',
          label: 'Service period alignment',
          expected_value: 'Invoice service dates align with the governing contract term.',
          actual_value: formatReconciliationStatus(reconciliation.service_period_status),
          impact: 'Out-of-term or unresolved service periods can block approval.',
          severity:
            reconciliation.service_period_status === 'MISMATCH' || reconciliation.service_period_status === 'MISSING'
              ? 'critical'
              : 'warning',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    reconciliation.invoice_total_status !== 'MATCH'
      ? {
          key: 'invoice_totals',
          label: 'Invoice totals',
          expected_value: 'Invoice totals reconcile to the governing contract truth.',
          actual_value: formatReconciliationStatus(reconciliation.invoice_total_status),
          impact: 'Unsettled invoice totals keep billing truth open for review.',
          severity:
            reconciliation.invoice_total_status === 'MISMATCH' || reconciliation.invoice_total_status === 'MISSING'
              ? 'critical'
              : 'warning',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    reconciliation.rate_mismatches > 0
      ? {
          key: 'rate_mismatches',
          label: 'Pricing alignment',
          expected_value: 'Billed rates match contract pricing.',
          actual_value: `${formatCount(reconciliation.rate_mismatches)} rate mismatch${reconciliation.rate_mismatches === 1 ? '' : 'es'}`,
          impact: 'Rate mismatches create unsupported invoice amounts.',
          severity: 'critical',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    reconciliation.unmatched_invoice_lines > 0
      ? {
          key: 'unmatched_invoice_lines',
          label: 'Invoice line support',
          expected_value: 'Every invoice line maps to contract-supported truth.',
          actual_value: `${formatCount(reconciliation.unmatched_invoice_lines)} unmatched invoice line${reconciliation.unmatched_invoice_lines === 1 ? '' : 's'}`,
          impact: 'Unmatched lines require operator verification before approval can clear.',
          severity: 'warning',
        }
      : null,
  );

  if (mismatches.length === 0) return null;

  return {
    key: 'contract_invoice',
    title: 'Contract ↔ Invoice',
    description: 'Verifies that billed invoice truth aligns with governing contract identity, term, pricing, and totals.',
    source_label: 'Validator-backed project facts',
    mismatches,
  };
}

function invoiceTransactionRelationshipBlock(
  facts: CanonicalProjectFacts,
): CanonicalProjectValidatorRelationshipBlock | null {
  const reconciliation = facts.invoice_transaction_reconciliation;
  const exposure = facts.exposure;
  const mismatches: CanonicalProjectValidatorMismatch[] = [];

  if (reconciliation) {
    pushMismatch(
      mismatches,
      reconciliation.unmatched_groups > 0
        ? {
            key: 'unmatched_groups',
            label: 'Billed groups',
            expected_value: 'Every billed group maps to transaction-backed work.',
            actual_value: `${formatCount(reconciliation.unmatched_groups)} unmatched billing group${reconciliation.unmatched_groups === 1 ? '' : 's'}`,
            impact: 'Approval cannot rely on billed group totals until work records align.',
            severity: 'critical',
          }
        : null,
    );
    pushMismatch(
      mismatches,
      reconciliation.cost_mismatches > 0
        ? {
            key: 'cost_mismatches',
            label: 'Cost alignment',
            expected_value: 'Invoice costs reconcile to transaction-backed work totals.',
            actual_value: `${formatCount(reconciliation.cost_mismatches)} cost mismatch${reconciliation.cost_mismatches === 1 ? '' : 'es'}`,
            impact: 'Cost mismatches keep billed amounts at risk.',
            severity: 'critical',
          }
        : null,
    );
    pushMismatch(
      mismatches,
      reconciliation.quantity_mismatches > 0
        ? {
            key: 'quantity_mismatches',
            label: 'Quantity alignment',
            expected_value: 'Billed quantities match transaction-backed work quantities.',
            actual_value: `${formatCount(reconciliation.quantity_mismatches)} quantity mismatch${reconciliation.quantity_mismatches === 1 ? '' : 'es'}`,
            impact: 'Quantity gaps weaken confidence in the billed work record.',
            severity: 'warning',
          }
        : null,
    );
    pushMismatch(
      mismatches,
      reconciliation.orphan_transactions > 0
        ? {
            key: 'orphan_transactions',
            label: 'Transaction linkage',
            expected_value: 'All relevant work records tie back to billed invoice groups.',
            actual_value: `${formatCount(reconciliation.orphan_transactions)} orphan transaction${reconciliation.orphan_transactions === 1 ? '' : 's'}`,
            impact: 'Unlinked work records leave invoice coverage incomplete.',
            severity: 'warning',
          }
        : null,
    );
    pushMismatch(
      mismatches,
      reconciliation.outlier_rows > 0
        ? {
            key: 'outlier_rows',
            label: 'Outlier work records',
            expected_value: 'Transaction rows fall within expected billing patterns.',
            actual_value: `${formatCount(reconciliation.outlier_rows)} outlier row${reconciliation.outlier_rows === 1 ? '' : 's'}`,
            impact: 'Outlier work records require human review before approval can clear.',
            severity: 'warning',
          }
        : null,
    );
  } else if (
    exposure
    && exposure.total_billed_amount > 0
    && exposure.total_transaction_supported_amount < exposure.total_billed_amount
  ) {
    mismatches.push({
      key: 'transaction_support_gap',
      label: 'Transaction-backed support',
      expected_value: 'Invoice totals are fully covered by canonical transaction data.',
      actual_value: `${formatCurrency(exposure.total_transaction_supported_amount)} supported against ${formatCurrency(exposure.total_billed_amount)} billed`,
      impact: 'Missing transaction coverage keeps billed work partially unsupported.',
      severity: 'warning',
    });
  }

  if (mismatches.length === 0) return null;

  return {
    key: 'invoice_transaction',
    title: 'Invoice ↔ Transaction',
    description: 'Verifies that billed invoice truth matches transaction-backed work, quantities, and totals.',
    source_label: 'Canonical project facts',
    mismatches,
  };
}

function invoiceSupportRelationshipBlock(
  facts: CanonicalProjectFacts,
  snapshot: CanonicalProjectValidationSnapshot,
): CanonicalProjectValidatorRelationshipBlock | null {
  const unsupportedAmount = unsupportedAmountForFacts(facts);
  const requiresVerificationAmount = facts.requires_verification_amount ?? null;
  const invoicesMissingSupport = snapshot.invoice_summaries.filter(
    (invoice) => invoice.approval_status === 'blocked' || invoice.approval_status === 'needs_review',
  ).length;
  const partialInvoices = snapshot.invoice_summaries.filter(
    (invoice) => invoice.approval_status === 'approved_with_exceptions',
  ).length;
  const mismatches: CanonicalProjectValidatorMismatch[] = [];

  pushMismatch(
    mismatches,
    unsupportedAmount != null && unsupportedAmount > 0
      ? {
          key: 'unsupported_amount',
          label: 'Support coverage',
          expected_value: 'Linked support documents fully cover billed invoice amounts.',
          actual_value: `${formatCurrency(unsupportedAmount)} unsupported`,
          impact: 'Unsupported billing cannot move cleanly through the approval gate.',
          severity: invoicesMissingSupport > 0 ? 'critical' : 'warning',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    requiresVerificationAmount != null && requiresVerificationAmount > 0
      ? {
          key: 'requires_verification',
          label: 'Verification completeness',
          expected_value: 'Support evidence is complete enough to approve without manual verification.',
          actual_value: `${formatCurrency(requiresVerificationAmount)} still requires verification`,
          impact: 'Operator review is still required before payment can proceed.',
          severity: 'warning',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    invoicesMissingSupport > 0
      ? {
          key: 'missing_supporting_docs',
          label: 'Required support documents',
          expected_value: 'Each active invoice has linked supporting documents.',
          actual_value: `${formatCount(invoicesMissingSupport)} invoice${invoicesMissingSupport === 1 ? '' : 's'} still missing verified support`,
          impact: 'Missing support creates approval blockers and open truth gaps.',
          severity: 'critical',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    partialInvoices > 0
      ? {
          key: 'partial_support',
          label: 'Partial support coverage',
          expected_value: 'Invoices are fully supported without exceptions.',
          actual_value: `${formatCount(partialInvoices)} invoice${partialInvoices === 1 ? '' : 's'} only partially supported`,
          impact: 'Partial support keeps invoice truth open for operator review.',
          severity: 'warning',
        }
      : null,
  );

  if (mismatches.length === 0) return null;

  return {
    key: 'invoice_support',
    title: 'Invoice ↔ Support Docs',
    description: 'Verifies that linked support documents fully cover billed invoice amounts and approval evidence.',
    source_label: 'Validator-backed project facts',
    mismatches,
  };
}

function crossDocumentRateRelationshipBlock(
  facts: CanonicalProjectFacts,
): CanonicalProjectValidatorRelationshipBlock | null {
  const verification = facts.cross_document_rate_verification;
  if (!verification || verification.comparable_units === 0) return null;

  const mismatches: CanonicalProjectValidatorMismatch[] = [];

  pushMismatch(
    mismatches,
    verification.rate_mismatch_units > 0
      ? {
          key: 'canonical_rate_mismatches',
          label: 'Contract vs invoice rates',
          expected_value: 'Invoice rates match the governing contract rate for the canonical category.',
          actual_value: `${formatCount(verification.rate_mismatch_units)} rate mismatch${verification.rate_mismatch_units === 1 ? '' : 'es'}`,
          impact: 'Rate mismatches make the billed amount unsupported until resolved.',
          severity: 'critical',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    verification.category_mismatch_units > 0
      ? {
          key: 'canonical_category_mismatches',
          label: 'Canonical category alignment',
          expected_value: 'Contract, invoice, and support rows resolve to the same canonical work category.',
          actual_value: `${formatCount(verification.category_mismatch_units)} category mismatch${verification.category_mismatch_units === 1 ? '' : 'es'}`,
          impact: 'Category mismatches indicate the invoice may be billing work different from the supported tickets.',
          severity: 'critical',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    verification.missing_contract_rate_units > 0
      ? {
          key: 'missing_contract_rates',
          label: 'Missing contract rates',
          expected_value: 'Every billed canonical category has a governing contract rate row.',
          actual_value: `${formatCount(verification.missing_contract_rate_units)} missing contract rate${verification.missing_contract_rate_units === 1 ? '' : 's'}`,
          impact: 'Unsupported rate truth blocks clean approval for the affected invoice lines.',
          severity: 'critical',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    verification.missing_support_units > 0 || verification.unsupported_work_units > 0
      ? {
          key: 'missing_canonical_support',
          label: 'Missing work support',
          expected_value: 'Every billed canonical category has ticket or transaction support.',
          actual_value: `${formatCount(verification.missing_support_units + verification.unsupported_work_units)} unsupported line${verification.missing_support_units + verification.unsupported_work_units === 1 ? '' : 's'}`,
          impact: 'Missing support keeps billed work open for verification.',
          severity: verification.unsupported_work_units > 0 ? 'critical' : 'warning',
        }
      : null,
  );
  pushMismatch(
    mismatches,
    verification.needs_review_units > 0
      ? {
          key: 'canonical_category_needs_review',
          label: 'Category confidence',
          expected_value: 'Canonical category mapping is confident enough for automated comparison.',
          actual_value: `${formatCount(verification.needs_review_units)} line${verification.needs_review_units === 1 ? '' : 's'} need review`,
          impact: 'Uncertain category mapping is held for operator review rather than forced into a false match.',
          severity: 'warning',
        }
      : null,
  );

  if (mismatches.length === 0) return null;

  return {
    key: 'cross_document_rate',
    title: 'Contract > Invoice > Support',
    description: 'Verifies contract rates, invoice rates, and ticket support through shared canonical work categories.',
    source_label: 'Canonical cross-document rate verification',
    mismatches,
  };
}

export function resolveCanonicalProjectValidatorWorkspace(params: {
  validationStatus?: string | null;
  validationSummary?: unknown;
  validationFindings?: readonly ValidationFinding[] | null;
  decisions?: readonly CanonicalProjectDecisionInput[] | null;
  documents?: readonly CanonicalProjectTruthDocumentInput[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
  transactionDatasets?: readonly CanonicalProjectTransactionDatasetInput[];
}): CanonicalProjectValidatorWorkspace {
  const truthSections = resolveCanonicalProjectTruthSections(params);
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: params.validationStatus,
    validationSummary: params.validationSummary,
    validationFindings: params.validationFindings,
    decisions: params.decisions,
    transactionDatasets: params.transactionDatasets,
  });
  const facts = snapshot.facts;
  const approvalStatus = approvalStatusLabelForProjectFacts(facts);
  const blockerCount = approvalBlockerCountForProjectFacts(facts);
  const unsupportedAmount = unsupportedAmountForFacts(facts);
  const warningCount = facts.warning_count + facts.requires_review_count;
  const supportDataExpected =
    facts.validation_phase === 'execution'
    || facts.validation_phase === 'billing_review'
    || facts.validation_phase === 'closeout';
  const supportCoverageLabel =
    facts.validation_phase === 'contract_setup'
      ? 'Not Expected For Current Phase'
      : 'Supporting Data';
  const supportCoverageDetail =
    facts.validation_phase === 'contract_setup'
      ? 'Ticket, transaction, and invoice support are not expected yet during contract setup.'
      : facts.validation_phase === 'execution'
        ? 'Ticket or transaction support is expected during execution; invoice support is usually required later during billing review.'
        : unsupportedAmount == null
          ? 'Support coverage is not yet resolved in the canonical approval context.'
          : unsupportedAmount > 0
            ? 'Linked support documents do not yet cover all billed invoice amounts.'
            : 'Linked support documents fully cover the billed invoice truth.';
  const supportCoverageImpact =
    facts.validation_phase === 'contract_setup'
      ? 'Supporting data becomes required later during execution and billing review.'
      : facts.validation_phase === 'execution'
        ? 'Execution support gaps can block downstream billing review if they remain unresolved.'
        : 'Support gaps keep invoice truth open and can block approval.';
  const unsettledRows = truthSections
    .filter((section) => section.key !== 'validation')
    .flatMap((section) => section.rows)
    .filter((row) => isUnsettledTruthState(row.state));

  const relationship_blocks = [
    contractInvoiceRelationshipBlock(facts),
    invoiceTransactionRelationshipBlock(facts),
    crossDocumentRateRelationshipBlock(facts),
    invoiceSupportRelationshipBlock(facts, snapshot),
  ].filter((block): block is CanonicalProjectValidatorRelationshipBlock => block != null);

  const coverage_items: CanonicalProjectValidatorCoverageItem[] = [
    {
      key: 'missing_supporting_data',
      label: supportCoverageLabel,
      value:
        !supportDataExpected
          ? 'Not expected yet'
          : unsupportedAmount == null
            ? 'Unavailable'
            : unsupportedAmount > 0
              ? formatCurrency(unsupportedAmount)
              : 'Clear',
      detail: supportCoverageDetail,
      impact: supportCoverageImpact,
      source_label: 'Validator-backed project facts',
      state:
        !supportDataExpected
          ? 'derived'
          : unsupportedAmount == null
            ? 'unresolved'
            : truthStateForAmount(unsupportedAmount),
    },
    {
      key: 'incomplete_evidence',
      label: 'Incomplete Evidence',
      value:
        facts.requires_verification_amount == null
          ? 'Unavailable'
          : facts.requires_verification_amount > 0
            ? formatCurrency(facts.requires_verification_amount)
            : 'Clear',
      detail:
        facts.requires_verification_amount == null
          ? 'The validator has not resolved how much evidence still needs verification.'
          : facts.requires_verification_amount > 0
            ? 'Some billed dollars still require manual verification before approval can clear.'
            : 'The current approval context does not show an evidence verification hold.',
      impact: 'Incomplete evidence keeps the approval gate in review or blocked status.',
      source_label: 'Validator-backed project facts',
      state:
        facts.requires_verification_amount == null
          ? 'unresolved'
          : truthStateForAmount(facts.requires_verification_amount),
    },
    {
      key: 'unresolved_required_fields',
      label: 'Unresolved Required Fields',
      value:
        unsettledRows.length > 0
          ? `${formatCount(unsettledRows.length)} open`
          : 'Resolved',
      detail:
        unsettledRows.length > 0
          ? unsettledRows.slice(0, 3).map((row) => row.label).join(' • ')
          : 'Required contract, invoice, and transaction truths are currently resolved.',
      impact: 'Open truth gaps still need review, correction, or override before the project is fully settled.',
      source_label: 'Canonical project facts',
      state: unsettledRows.length > 0 ? 'requires_review' : 'resolved',
    },
  ];

  return {
    status_items: [
      {
        key: 'approval_status',
        label: 'Approval Status',
        value: approvalStatus,
        source_label: 'Validator-backed project facts',
        state:
          approvalStatus === 'Approved'
            ? 'resolved'
            : approvalStatus === 'Not Evaluated'
              ? 'unresolved'
              : 'requires_review',
      },
      {
        key: 'readiness',
        label: 'Readiness',
        value: formatValidationStatus(facts.status),
        source_label: 'Validator-backed project facts',
        state: validatorStateForReadiness(facts.status),
      },
      {
        key: 'blockers',
        label: 'Blockers',
        value: formatCount(blockerCount),
        source_label: 'Validator-backed project facts',
        state: blockerCount > 0 ? 'requires_review' : 'resolved',
      },
      {
        key: 'warnings',
        label: 'Warnings',
        value: formatCount(warningCount),
        source_label: 'Validator-backed project facts',
        state: warningCount > 0 ? 'requires_review' : 'resolved',
      },
      {
        key: 'at_risk_amount',
        label: PROJECT_TERM_AT_RISK_AMOUNT,
        value: facts.total_at_risk != null ? formatCurrency(facts.total_at_risk) : 'Unavailable',
        source_label: 'Validator-backed project facts',
        state:
          facts.total_at_risk == null
            ? 'missing'
            : facts.total_at_risk > 0
              ? 'requires_review'
              : 'resolved',
      },
      {
        key: 'unsupported_amount',
        label: PROJECT_TERM_UNSUPPORTED_AMOUNT,
        value: unsupportedAmount != null ? formatCurrency(unsupportedAmount) : 'Unavailable',
        source_label: 'Validator-backed project facts',
        state:
          unsupportedAmount == null
            ? 'missing'
            : unsupportedAmount > 0
              ? 'requires_review'
              : 'resolved',
      },
    ],
    relationship_blocks,
    coverage_items,
  };
}
