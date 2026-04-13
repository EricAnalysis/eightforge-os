/**
 * Approval gate types — deterministic project and invoice payment decisions.
 *
 * The approval gate converts validator outputs (reconciliation findings,
 * exposure math, billing groups) into actionable pass/block decisions.
 */

/** Four-state project-level approval status. */
export type ProjectApprovalStatus =
  | 'approved'
  | 'approved_with_exceptions'
  | 'needs_review'
  | 'blocked';

/** Four-state invoice-level approval status. */
export type InvoiceApprovalStatus =
  | 'approved'
  | 'approved_with_exceptions'
  | 'needs_review'
  | 'blocked';

/**
 * Structured reasons for a non-approved status.
 * Each reason maps to a specific validator finding category or
 * reconciliation anomaly detected by the gate.
 */
export type GateReason =
  | 'missing_contract_support'
  | 'missing_transaction_support'
  | 'rate_mismatch'
  | 'quantity_mismatch'
  | 'duplicate_billing'
  | 'orphan_invoice_lines'
  | 'orphan_transactions'
  | 'pricing_applicability_unresolved'
  | 'activation_unresolved';

/**
 * Decision for a single invoice.
 * Amounts are in the same currency unit as the source documents.
 */
export type InvoiceApprovalDecision = {
  /** Invoice number from the source document, or null when not extractable. */
  invoice_number: string | null;
  approval_status: InvoiceApprovalStatus;
  /** Total dollars billed on this invoice (null when billed amount is missing). */
  billed_amount: number | null;
  /** Dollars that are reconciled against both contract and transaction data. */
  supported_amount: number;
  /** Dollars billed but not supported by transaction evidence. */
  at_risk_amount: number;
  /** Ordered, deduplicated list of reasons driving a non-approved status. */
  reasons: GateReason[];
  /** IDs of open ValidationFinding rows that contributed to this decision. */
  finding_ids: string[];
  /** Billing group IDs involved in this invoice's reconciliation. */
  billing_group_ids: string[];
};

/**
 * Top-level project decision — rollup of all invoice decisions plus
 * project-wide findings and exposure math.
 */
export type ProjectApprovalDecision = {
  approval_status: ProjectApprovalStatus;
  /** Ordered, deduplicated list of reasons driving a non-approved status. */
  reasons: GateReason[];
  /** Sum of billed amounts for all BLOCKED invoices. */
  blocked_amount: number;
  /** Total dollars at risk across all invoices. */
  at_risk_amount: number;
  /** IDs of open ValidationFinding rows that contributed to this decision. */
  finding_ids: string[];
  /** Billing group IDs involved in the project's reconciliation. */
  billing_group_ids: string[];
  /** Per-invoice decisions, one entry per invoice in the exposure summary. */
  invoices: InvoiceApprovalDecision[];
};

/** Top-level result returned by evaluateApprovalGate(). */
export type ApprovalGateResult = {
  project: ProjectApprovalDecision;
  /** Convenience alias — same array as project.invoices. */
  invoices: InvoiceApprovalDecision[];
};
