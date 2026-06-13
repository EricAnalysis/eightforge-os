export type ValidationStatus = 'NOT_READY' | 'BLOCKED' | 'VALIDATED' | 'FINDINGS_OPEN';

export type ValidationSeverity = 'critical' | 'warning' | 'info';

export type ValidatorStatus = 'READY' | 'BLOCKED' | 'NEEDS_REVIEW';

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
  open_count: number;
  blocked_reasons: string[];
  trigger_source: ValidationTriggerSource | null;
  validator_status: ValidatorStatus;
  validator_open_items: ValidatorSummaryItem[];
  validator_blockers: ValidatorSummaryItem[];
  contract_invoice_reconciliation?: ContractInvoiceReconciliationSummary | null;
  invoice_transaction_reconciliation?: InvoiceTransactionReconciliationSummary | null;
  reconciliation?: ProjectReconciliationSummary | null;
  exposure?: ProjectExposureSummary | null;
  /**
   * Denormalized for workspace overview (contract NTE / ceiling fact).
   * Prefer {@link ProjectExposureSummary.total_billed_amount} for billed dollars when exposure ran.
   */
  nte_amount?: number | null;
  total_billed?: number | null;
  requires_verification_amount?: number | null;
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
  exposure?: ProjectExposureSummary | null;
};
