export type ValidationStatus = 'NOT_READY' | 'BLOCKED' | 'VALIDATED' | 'FINDINGS_OPEN';

export type ValidationSeverity = 'critical' | 'warning' | 'info';

export type ValidatorStatus = 'READY' | 'BLOCKED' | 'NEEDS_REVIEW';

export const PROJECT_VALIDATION_PHASE_VALUES = [
  'contract_setup',
  'execution',
  'billing_review',
  'closeout',
] as const;

export type ProjectValidationPhase = (typeof PROJECT_VALIDATION_PHASE_VALUES)[number];

export type ValidationFindingDisposition =
  | 'blocker'
  | 'warning'
  | 'info'
  | 'requires_review';

export type ValidationBusinessSeverity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low';

export type ValidationSourceFamily =
  | 'contract'
  | 'invoice'
  | 'transaction'
  | 'support'
  | 'project'
  | 'cross_document'
  | 'system';

export type ValidationApprovalGateEffect =
  | 'blocks_approval'
  | 'requires_operator_review'
  | 'informational';

export type ValidationExposureType =
  | 'unsupported_amount'
  | 'rate_mismatch'
  | 'missing_support'
  | 'invoice_total_mismatch'
  | 'missing_governing_contract'
  | 'missing_transaction_support'
  | 'other';

export type ContractInvoiceReconciliationStatus =
  | 'MATCH'
  | 'MISMATCH'
  | 'MISSING'
  | 'PARTIAL';

export type ValidationCategory =
  | 'required_sources'
  | 'identity_consistency'
  | 'financial_integrity'
  | 'ticket_integrity';

export type ValidationTriggerSource =
  | 'document_processed'
  | 'fact_override'
  | 'review_confirmed'
  | 'review_flagged'
  | 'review_corrected'
  | 'override_applied'
  | 'relationship_change'
  | 'manual';

export type FindingStatus = 'open' | 'resolved' | 'dismissed' | 'muted';

export type ValidationRun = {
  id: string;
  project_id: string;
  triggered_by: ValidationTriggerSource;
  triggered_by_user_id: string | null;
  rules_applied: string[];
  rule_version: string;
  status: string;
  findings_count: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  inputs_snapshot_hash: string | null;
  run_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ValidationFinding = {
  id: string;
  run_id: string;
  project_id: string;
  rule_id: string;
  check_key: string;
  category: ValidationCategory;
  severity: ValidationSeverity;
  status: FindingStatus;
  subject_type: string;
  subject_id: string;
  field: string | null;
  expected: string | null;
  actual: string | null;
  variance: number | null;
  variance_unit: string | null;
  blocked_reason: string | null;
  finding_disposition?: ValidationFindingDisposition | null;
  business_severity?: ValidationBusinessSeverity | null;
  problem?: string | null;
  impact?: string | null;
  required_action?: string | null;
  evidence_refs?: string[] | null;
  source_family?: ValidationSourceFamily | null;
  affected_amount?: number | null;
  approval_gate_effect?: ValidationApprovalGateEffect | null;
  exposure_type?: ValidationExposureType | null;
  decision_eligible: boolean;
  action_eligible: boolean;
  linked_decision_id: string | null;
  linked_action_id: string | null;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ValidationEvidence = {
  id: string;
  finding_id: string;
  evidence_type: string;
  source_document_id: string | null;
  source_page: number | null;
  fact_id: string | null;
  record_id: string | null;
  field_name: string | null;
  field_value: string | null;
  note: string | null;
  created_at: string;
};

export type ValidationRuleState = {
  id: string;
  project_id: string;
  rule_id: string;
  enabled: boolean;
  tolerance_override: unknown | null;
  muted_until: string | null;
  created_at: string;
  updated_at: string;
};

export type ValidatorSummaryItem = {
  rule_id: string;
  severity: ValidationSeverity;
  subject_type: string;
  subject_id: string;
  field: string | null;
  fact_keys: string[];
  message: string;
  finding_disposition?: ValidationFindingDisposition | null;
  business_severity?: ValidationBusinessSeverity | null;
  problem?: string | null;
  impact?: string | null;
  required_action?: string | null;
  evidence_refs?: string[];
  source_family?: ValidationSourceFamily | null;
  affected_amount?: number | null;
  approval_gate_effect?: ValidationApprovalGateEffect | null;
  exposure_type?: ValidationExposureType | null;
};

export type ContractInvoiceReconciliationSummary = {
  matched_invoice_lines: number;
  unmatched_invoice_lines: number;
  rate_mismatches: number;
  vendor_identity_status: ContractInvoiceReconciliationStatus;
  client_identity_status: ContractInvoiceReconciliationStatus;
  service_period_status: ContractInvoiceReconciliationStatus;
  invoice_total_status: ContractInvoiceReconciliationStatus;
};

export type InvoiceTransactionReconciliationSummary = {
  matched_groups: number;
  unmatched_groups: number;
  cost_mismatches: number;
  quantity_mismatches: number;
  orphan_transactions: number;
  outlier_rows: number;
};

export type ProjectReconciliationSummary = {
  contract_invoice_status: ContractInvoiceReconciliationStatus;
  invoice_transaction_status: ContractInvoiceReconciliationStatus;
  overall_reconciliation_status: ContractInvoiceReconciliationStatus;
  matched_billing_groups: number;
  unmatched_billing_groups: number;
  rate_mismatches: number;
  quantity_mismatches: number;
  orphan_invoice_lines: number;
  orphan_transactions: number;
};

export type CrossDocumentRateComparisonStatus =
  | 'match'
  | 'rate_mismatch'
  | 'category_mismatch'
  | 'missing_contract_rate'
  | 'missing_support'
  | 'unsupported_work'
  | 'needs_review';

export type CrossDocumentRateCategoryBasis =
  | 'existing'
  | 'source_category'
  | 'descriptor'
  | 'combined'
  | 'unresolved';

export type CrossDocumentRateSupportBasis =
  | 'invoice_linked'
  | 'project_level'
  | 'billing_key_fallback'
  | 'none';

export type CrossDocumentRateValidationUnit = {
  validation_unit_id: string;
  invoice_line_id: string;
  invoice_number: string | null;
  billing_rate_key: string | null;
  canonical_category: string | null;
  category_confidence: number | null;
  category_basis: CrossDocumentRateCategoryBasis;
  invoice_source_descriptor: string | null;
  invoice_rate: number | null;
  contract_rate_found: boolean;
  contract_rate: number | null;
  contract_source_category: string | null;
  contract_source_descriptor: string | null;
  supported_quantity: number | null;
  support_row_count: number;
  support_basis: CrossDocumentRateSupportBasis;
  support_families: string[];
  support_observed_categories: string[];
  comparison_status: CrossDocumentRateComparisonStatus;
  reason: string;
  source_documents: {
    invoice_document_id: string | null;
    contract_document_ids: string[];
    support_document_ids: string[];
  };
  source_rows: {
    invoice_record_id: string;
    contract_record_ids: string[];
    support_record_ids: string[];
  };
};

export type CrossDocumentRateVerificationSummary = {
  comparable_units: number;
  matched_units: number;
  rate_mismatch_units: number;
  category_mismatch_units: number;
  missing_contract_rate_units: number;
  missing_support_units: number;
  unsupported_work_units: number;
  needs_review_units: number;
  validation_units: CrossDocumentRateValidationUnit[];
};

export type InvoiceExposureSummary = {
  invoice_number: string | null;
  billed_amount: number | null;
  billed_amount_source: 'invoice_total' | 'line_total_fallback' | 'missing';
  contract_supported_amount: number;
  transaction_supported_amount: number;
  fully_reconciled_amount: number;
  supported_amount: number;
  unreconciled_amount: number | null;
  at_risk_amount: number;
  requires_verification_amount?: number;
  reconciliation_status: ContractInvoiceReconciliationStatus;
};

export type ProjectExposureSummary = {
  total_billed_amount: number;
  total_contract_supported_amount: number;
  total_transaction_supported_amount: number;
  total_fully_reconciled_amount: number;
  total_unreconciled_amount: number;
  total_at_risk_amount: number;
  total_requires_verification_amount?: number;
  support_gap_tolerance_amount: number;
  at_risk_tolerance_amount: number;
  moderate_severity: 'warning';
  invoices: InvoiceExposureSummary[];
};

export type ValidationSummary = {
  status: ValidationStatus;
  last_run_at: string | null;
  critical_count: number;
  warning_count: number;
  info_count: number;
  blocker_count?: number;
  requires_review_count?: number;
  open_count: number;
  blocked_reasons: string[];
  trigger_source: ValidationTriggerSource | null;
  validator_status: ValidatorStatus;
  readiness?: ValidationStatus | ValidatorStatus | 'NOT_READY';
  validation_phase?: ProjectValidationPhase | null;
  validator_open_items: ValidatorSummaryItem[];
  validator_blockers: ValidatorSummaryItem[];
  contract_invoice_reconciliation?: ContractInvoiceReconciliationSummary | null;
  invoice_transaction_reconciliation?: InvoiceTransactionReconciliationSummary | null;
  reconciliation?: ProjectReconciliationSummary | null;
  cross_document_rate_verification?: CrossDocumentRateVerificationSummary | null;
  exposure?: ProjectExposureSummary | null;
  /**
   * Denormalized for workspace overview (contract NTE / ceiling fact).
   * Prefer {@link ProjectExposureSummary.total_billed_amount} for billed dollars when exposure ran.
   */
  nte_amount?: number | null;
  total_billed?: number | null;
  requires_verification_amount?: number | null;
  requires_verification?: boolean | null;
  at_risk_amount?: number | null;
  unsupported_amount?: number | null;
  contract_document_id?: string | null;
  contract_validation_context?: unknown | null;
};

export type ValidatorResult = {
  status: ValidationStatus;
  blocked_reasons: string[];
  findings: ValidationFinding[];
  summary: ValidationSummary;
  rulesApplied: string[];
  validator_status: ValidatorStatus;
  validator_open_items: ValidatorSummaryItem[];
  validator_blockers: ValidatorSummaryItem[];
  contract_invoice_reconciliation?: ContractInvoiceReconciliationSummary | null;
  invoice_transaction_reconciliation?: InvoiceTransactionReconciliationSummary | null;
  reconciliation?: ProjectReconciliationSummary | null;
  cross_document_rate_verification?: CrossDocumentRateVerificationSummary | null;
  exposure?: ProjectExposureSummary | null;
};
