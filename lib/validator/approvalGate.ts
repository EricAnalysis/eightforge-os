/**
 * Deterministic approval gate.
 *
 * Converts validator outputs — reconciliation summary, exposure math, and
 * open findings — into structured project and invoice approval decisions.
 *
 * No workflow tasks are created here.  This is pure decision logic.
 *
 * Decision precedence (highest wins):
 *   blocked > needs_review > approved_with_exceptions > approved
 *
 * BLOCKED when any of:
 *   - open critical finding
 *   - overall reconciliation status is MISMATCH
 *   - total_at_risk_amount > at_risk_tolerance
 *   - total_unreconciled_amount > support_gap_tolerance
 *
 * NEEDS_REVIEW when any of:
 *   - open warning finding
 *   - overall reconciliation status is PARTIAL or MISSING
 *
 * APPROVED_WITH_EXCEPTIONS when:
 *   - fully reconciled (MATCH) but non-zero at-risk or unreconciled within tolerance
 *
 * APPROVED when:
 *   - MATCH reconciliation, zero at-risk, no open findings
 */

import type {
  InvoiceExposureSummary,
  ValidationFinding,
  ValidatorResult,
} from '@/types/validator';
import type {
  ApprovalGateResult,
  GateReason,
  InvoiceApprovalDecision,
  InvoiceApprovalStatus,
  ProjectApprovalDecision,
  ProjectApprovalStatus,
} from '@/types/approval';

// ---------------------------------------------------------------------------
// Rule-ID → GateReason mapping
// ---------------------------------------------------------------------------

const RULE_GATE_REASON: Readonly<Record<string, GateReason>> = {
  // Required sources
  SOURCES_NO_CONTRACT: 'missing_contract_support',
  SOURCES_NO_RATE_SCHEDULE: 'missing_contract_support',
  SOURCES_NO_TICKET_DATA: 'missing_transaction_support',

  // Contract / invoice reconciliation
  FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT: 'missing_contract_support',
  FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE: 'rate_mismatch',
  FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS: 'rate_mismatch',

  // Invoice / transaction reconciliation
  TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE: 'missing_transaction_support',
  TRANSACTION_TOTAL_MATCHES_INVOICE_LINE: 'rate_mismatch',
  TRANSACTION_QUANTITY_MATCHES_INVOICE: 'quantity_mismatch',
  TRANSACTION_RATE_OUTLIERS: 'rate_mismatch',
  TRANSACTION_MISSING_INVOICE_LINK: 'orphan_transactions',

  // Identity
  IDENTITY_DUPLICATE_TICKET: 'duplicate_billing',

  // Rate-based contract validation
  FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR: 'pricing_applicability_unresolved',
  FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED: 'activation_unresolved',

  // Exposure
  PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED: 'missing_contract_support',
  PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO: 'missing_transaction_support',
  INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED: 'missing_contract_support',
  INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO: 'missing_transaction_support',
  INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE: 'missing_contract_support',
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type ApprovalGateOptions = {
  /**
   * Dollar threshold above which unreconciled amount triggers BLOCKED.
   * Defaults to exposure.support_gap_tolerance_amount (0 when absent).
   */
  unreconciled_threshold?: number;
  /**
   * Dollar threshold above which at-risk amount triggers BLOCKED.
   * Defaults to exposure.at_risk_tolerance_amount (0 when absent).
   */
  at_risk_threshold?: number;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function uniqueReasons(reasons: GateReason[]): GateReason[] {
  return [...new Set(reasons)].sort() as GateReason[];
}

function reasonFromFinding(finding: ValidationFinding): GateReason | null {
  return RULE_GATE_REASON[finding.rule_id] ?? null;
}

const INVOICE_APPROVAL_PRIORITY: Record<InvoiceApprovalStatus, number> = {
  blocked: 3,
  needs_review: 2,
  approved_with_exceptions: 1,
  approved: 0,
};

function worstStatus(statuses: InvoiceApprovalStatus[]): InvoiceApprovalStatus {
  return statuses.reduce<InvoiceApprovalStatus>(
    (worst, s) =>
      INVOICE_APPROVAL_PRIORITY[s] > INVOICE_APPROVAL_PRIORITY[worst] ? s : worst,
    'approved',
  );
}

/**
 * Returns true when a finding belongs to a specific invoice.
 * Matches on subject_type === 'invoice' with subject_id equal to the invoice
 * number, or when check_key contains the invoice number as a substring (used
 * by reconciliation rules that embed the invoice number in check_key).
 */
function findingBelongsToInvoice(
  finding: ValidationFinding,
  invoiceNumber: string | null,
): boolean {
  if (invoiceNumber == null) return false;
  if (finding.subject_type === 'invoice' && finding.subject_id === invoiceNumber) return true;
  if (finding.check_key.includes(invoiceNumber)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Invoice-level evaluation
// ---------------------------------------------------------------------------

function evaluateInvoice(
  invoice: InvoiceExposureSummary,
  openFindings: readonly ValidationFinding[],
  supportGapTolerance: number,
  atRiskTolerance: number,
): InvoiceApprovalDecision {
  const reasons: GateReason[] = [];
  const findingIds: string[] = [];

  const invoiceNum = invoice.invoice_number;
  const billedAmount = invoice.billed_amount;
  const supportedAmount = invoice.supported_amount;
  const atRiskAmount = invoice.at_risk_amount;
  // unreconciled_amount can be null when billed amount is missing
  const unreconciledAmount = invoice.unreconciled_amount ?? 0;
  const reconStatus = invoice.reconciliation_status;

  // Collect open findings that belong to this invoice
  const invoiceFindings = openFindings.filter((f) =>
    findingBelongsToInvoice(f, invoiceNum),
  );
  for (const f of invoiceFindings) {
    findingIds.push(f.id);
    const r = reasonFromFinding(f);
    if (r) reasons.push(r);
  }

  // Structural reasons from reconciliation status
  if (reconStatus === 'MISMATCH') {
    // More specific reasons come from findings; fall back to rate_mismatch
    if (!reasons.some((r) => r === 'rate_mismatch' || r === 'quantity_mismatch')) {
      reasons.push('rate_mismatch');
    }
  }
  if (reconStatus === 'MISSING' || invoice.billed_amount_source === 'missing') {
    reasons.push('missing_contract_support');
  }
  if (atRiskAmount > 0) {
    reasons.push('missing_transaction_support');
  }

  // Gate conditions (evaluated in precedence order)
  const hasCritical = invoiceFindings.some(
    (f) => f.severity === 'critical' && f.status === 'open',
  );
  const hasWarning = invoiceFindings.some(
    (f) => f.severity === 'warning' && f.status === 'open',
  );
  const isAtRiskBlocked = atRiskAmount > atRiskTolerance;
  // Support-gap blocking only applies when reconciliation is otherwise clean (MATCH).
  // PARTIAL / MISSING invoices already route to needs_review; the gap there is expected.
  const isSupportGapBlocked =
    reconStatus !== 'PARTIAL'
    && reconStatus !== 'MISSING'
    && unreconciledAmount > supportGapTolerance;

  if (isSupportGapBlocked && !reasons.includes('missing_contract_support')) {
    reasons.push('missing_contract_support');
  }

  let status: InvoiceApprovalStatus;

  if (reconStatus === 'MISMATCH' || isAtRiskBlocked || isSupportGapBlocked || hasCritical) {
    status = 'blocked';
  } else if (
    reconStatus === 'PARTIAL'
    || reconStatus === 'MISSING'
    || invoice.billed_amount_source === 'missing'
    || hasWarning
  ) {
    status = 'needs_review';
  } else if (reconStatus === 'MATCH' && (atRiskAmount > 0 || unreconciledAmount > 0)) {
    // Fully reconciled but non-zero residuals that fall within tolerance
    status = 'approved_with_exceptions';
  } else {
    // MATCH, zero residuals, no open findings
    status = 'approved';
  }

  return {
    invoice_number: invoiceNum,
    approval_status: status,
    billed_amount: billedAmount,
    supported_amount: supportedAmount,
    at_risk_amount: atRiskAmount,
    reasons: uniqueReasons(reasons),
    finding_ids: [...new Set(findingIds)],
    billing_group_ids: [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate the deterministic approval gate for a project.
 *
 * @param result   Output from validateProject() or equivalent.
 * @param options  Optional threshold overrides.
 * @returns        Structured approval decision for the project and each invoice.
 */
export function evaluateApprovalGate(
  result: ValidatorResult,
  options?: ApprovalGateOptions,
): ApprovalGateResult {
  const exposure = result.exposure ?? null;
  const reconciliation = result.reconciliation ?? null;
  const openFindings = result.findings.filter((f) => f.status === 'open');

  const supportGapTolerance =
    options?.unreconciled_threshold ?? exposure?.support_gap_tolerance_amount ?? 0;
  const atRiskTolerance =
    options?.at_risk_threshold ?? exposure?.at_risk_tolerance_amount ?? 0;

  // --- Per-invoice decisions ---
  const invoiceDecisions: InvoiceApprovalDecision[] = (exposure?.invoices ?? []).map((inv) =>
    evaluateInvoice(inv, openFindings, supportGapTolerance, atRiskTolerance),
  );

  // --- Project-level gate ---
  const projectReasons: GateReason[] = [];
  const projectFindingIds: string[] = [];

  // Project/document-scoped findings
  const projectFindings = openFindings.filter(
    (f) => f.subject_type === 'project' || f.subject_type === 'document',
  );
  for (const f of projectFindings) {
    projectFindingIds.push(f.id);
    const r = reasonFromFinding(f);
    if (r) projectReasons.push(r);
  }

  // Structural reasons from reconciliation summary
  if (reconciliation) {
    if (reconciliation.rate_mismatches > 0) projectReasons.push('rate_mismatch');
    if (reconciliation.quantity_mismatches > 0) projectReasons.push('quantity_mismatch');
    if (reconciliation.orphan_invoice_lines > 0) projectReasons.push('orphan_invoice_lines');
    if (reconciliation.orphan_transactions > 0) projectReasons.push('orphan_transactions');
    if (reconciliation.contract_invoice_status === 'MISSING') {
      projectReasons.push('missing_contract_support');
    }
    if (reconciliation.invoice_transaction_status === 'MISSING') {
      projectReasons.push('missing_transaction_support');
    }
  }

  // Merge invoice reasons and finding IDs into project
  for (const inv of invoiceDecisions) {
    projectReasons.push(...inv.reasons);
    projectFindingIds.push(...inv.finding_ids);
  }

  // Aggregate exposure metrics
  const totalAtRisk = exposure?.total_at_risk_amount ?? 0;
  const totalUnreconciled = exposure?.total_unreconciled_amount ?? 0;
  const overallRecStatus = reconciliation?.overall_reconciliation_status ?? 'MISSING';

  // Scalar flags for gate conditions
  const hasCriticalFinding = openFindings.some((f) => f.severity === 'critical');
  const hasWarningFinding = openFindings.some((f) => f.severity === 'warning');
  const worstInvoice = worstStatus(invoiceDecisions.map((inv) => inv.approval_status));

  // Precedence: blocked > needs_review > approved_with_exceptions > approved
  // Same PARTIAL/MISSING guard as invoice level: don't escalate a partial
  // reconciliation to blocked solely because of the support gap amount.
  const projectSupportGapBlocked =
    overallRecStatus !== 'PARTIAL'
    && overallRecStatus !== 'MISSING'
    && totalUnreconciled > supportGapTolerance;

  const isBlocked =
    hasCriticalFinding
    || overallRecStatus === 'MISMATCH'
    || totalAtRisk > atRiskTolerance
    || projectSupportGapBlocked
    || worstInvoice === 'blocked';

  const needsReview =
    !isBlocked
    && (hasWarningFinding
      || overallRecStatus === 'PARTIAL'
      || overallRecStatus === 'MISSING'
      || worstInvoice === 'needs_review');

  const hasExceptions =
    !isBlocked
    && !needsReview
    && (worstInvoice === 'approved_with_exceptions'
      || (totalAtRisk > 0 && totalAtRisk <= atRiskTolerance)
      || (totalUnreconciled > 0 && totalUnreconciled <= supportGapTolerance));

  let projectStatus: ProjectApprovalStatus;
  if (isBlocked) {
    projectStatus = 'blocked';
  } else if (needsReview) {
    projectStatus = 'needs_review';
  } else if (hasExceptions) {
    projectStatus = 'approved_with_exceptions';
  } else {
    projectStatus = 'approved';
  }

  // blocked_amount = sum of billed amounts for blocked invoices
  const blockedAmount = invoiceDecisions
    .filter((inv) => inv.approval_status === 'blocked')
    .reduce((sum, inv) => sum + (inv.billed_amount ?? 0), 0);

  const project: ProjectApprovalDecision = {
    approval_status: projectStatus,
    reasons: uniqueReasons(projectReasons),
    blocked_amount: blockedAmount,
    at_risk_amount: totalAtRisk,
    finding_ids: [...new Set(projectFindingIds)],
    billing_group_ids: [],
    invoices: invoiceDecisions,
  };

  return { project, invoices: invoiceDecisions };
}
