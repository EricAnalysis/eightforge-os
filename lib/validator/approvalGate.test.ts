import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { evaluateApprovalGate } from '@/lib/validator/approvalGate';
import type {
  ContractInvoiceReconciliationStatus,
  InvoiceExposureSummary,
  ProjectExposureSummary,
  ProjectReconciliationSummary,
  ValidationFinding,
  ValidatorResult,
} from '@/types/validator';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'project-1';
const RUN_ID = 'run-1';
const TS = '2024-01-01T00:00:00.000Z';

function makeReconciliation(
  overrides: Partial<ProjectReconciliationSummary> = {},
): ProjectReconciliationSummary {
  return {
    contract_invoice_status: 'MATCH',
    invoice_transaction_status: 'MATCH',
    overall_reconciliation_status: 'MATCH',
    matched_billing_groups: 3,
    unmatched_billing_groups: 0,
    rate_mismatches: 0,
    quantity_mismatches: 0,
    orphan_invoice_lines: 0,
    orphan_transactions: 0,
    ...overrides,
  };
}

function makeInvoiceExposure(
  invoiceNumber: string,
  overrides: Partial<InvoiceExposureSummary> = {},
): InvoiceExposureSummary {
  return {
    invoice_number: invoiceNumber,
    billed_amount: 10000,
    billed_amount_source: 'invoice_total',
    contract_supported_amount: 10000,
    transaction_supported_amount: 10000,
    fully_reconciled_amount: 10000,
    supported_amount: 10000,
    unreconciled_amount: 0,
    at_risk_amount: 0,
    reconciliation_status: 'MATCH',
    ...overrides,
  };
}

function makeExposure(
  invoices: InvoiceExposureSummary[],
  overrides: Partial<ProjectExposureSummary> = {},
): ProjectExposureSummary {
  const totalBilled = invoices.reduce((s, i) => s + (i.billed_amount ?? 0), 0);
  const totalSupported = invoices.reduce((s, i) => s + i.supported_amount, 0);
  const totalAtRisk = invoices.reduce((s, i) => s + i.at_risk_amount, 0);
  const totalUnreconciled = invoices.reduce(
    (s, i) => s + (i.unreconciled_amount ?? 0),
    0,
  );
  return {
    total_billed_amount: totalBilled,
    total_contract_supported_amount: totalSupported,
    total_transaction_supported_amount: totalSupported,
    total_fully_reconciled_amount: totalSupported,
    total_unreconciled_amount: totalUnreconciled,
    total_at_risk_amount: totalAtRisk,
    support_gap_tolerance_amount: 0,
    at_risk_tolerance_amount: 0,
    moderate_severity: 'warning',
    invoices,
    ...overrides,
  };
}

function makeFinding(
  id: string,
  ruleId: string,
  opts: {
    severity?: 'critical' | 'warning' | 'info';
    status?: 'open' | 'resolved' | 'dismissed' | 'muted';
    subjectType?: string;
    subjectId?: string;
    checkKey?: string;
  } = {},
): ValidationFinding {
  return {
    id,
    run_id: RUN_ID,
    project_id: PROJECT_ID,
    rule_id: ruleId,
    check_key: opts.checkKey ?? `${ruleId}:check`,
    category: 'financial_integrity',
    severity: opts.severity ?? 'warning',
    status: opts.status ?? 'open',
    subject_type: opts.subjectType ?? 'project',
    subject_id: opts.subjectId ?? PROJECT_ID,
    field: null,
    expected: null,
    actual: null,
    variance: null,
    variance_unit: null,
    blocked_reason: null,
    decision_eligible: true,
    action_eligible: false,
    linked_decision_id: null,
    linked_action_id: null,
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: TS,
    updated_at: TS,
  };
}

function makeResult(
  overrides: {
    findings?: ValidationFinding[];
    reconciliation?: ProjectReconciliationSummary | null;
    exposure?: ProjectExposureSummary | null;
  } = {},
): ValidatorResult {
  return {
    status: 'VALIDATED',
    blocked_reasons: [],
    findings: overrides.findings ?? [],
    summary: {
      status: 'VALIDATED',
      last_run_at: TS,
      critical_count: 0,
      warning_count: 0,
      info_count: 0,
      open_count: 0,
      blocked_reasons: [],
      trigger_source: 'manual',
      validator_status: 'READY',
      validator_open_items: [],
      validator_blockers: [],
      reconciliation: overrides.reconciliation ?? null,
      exposure: overrides.exposure ?? null,
    },
    rulesApplied: [],
    validator_status: 'READY',
    validator_open_items: [],
    validator_blockers: [],
    reconciliation: overrides.reconciliation ?? null,
    exposure: overrides.exposure ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests — clean pass
// ---------------------------------------------------------------------------

describe('evaluateApprovalGate', () => {
  describe('APPROVED', () => {
    it('returns approved when reconciliation is MATCH and exposure is zero', () => {
      const inv = makeInvoiceExposure('INV-001');
      const result = makeResult({
        reconciliation: makeReconciliation(),
        exposure: makeExposure([inv]),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'approved');
      assert.deepEqual(gate.project.reasons, []);
      assert.equal(gate.project.blocked_amount, 0);
      assert.equal(gate.project.at_risk_amount, 0);
      assert.equal(gate.invoices[0]?.approval_status, 'approved');
    });

    it('returns approved with no exposure data and no findings', () => {
      const result = makeResult({
        reconciliation: makeReconciliation(),
        exposure: null,
      });
      const gate = evaluateApprovalGate(result);
      assert.equal(gate.project.approval_status, 'approved');
    });
  });

  // ---------------------------------------------------------------------------
  // BLOCKED scenarios
  // ---------------------------------------------------------------------------

  describe('BLOCKED', () => {
    it('blocks on critical finding', () => {
      const finding = makeFinding('f-1', 'SOURCES_NO_CONTRACT', {
        severity: 'critical',
        status: 'open',
        subjectType: 'project',
      });
      const result = makeResult({
        findings: [finding],
        reconciliation: makeReconciliation(),
        exposure: makeExposure([makeInvoiceExposure('INV-001')]),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'blocked');
      assert.ok(gate.project.reasons.includes('missing_contract_support'));
      assert.ok(gate.project.finding_ids.includes('f-1'));
    });

    it('blocks on overall MISMATCH reconciliation status', () => {
      const inv = makeInvoiceExposure('INV-001', { reconciliation_status: 'MISMATCH' });
      const result = makeResult({
        reconciliation: makeReconciliation({
          overall_reconciliation_status: 'MISMATCH',
          rate_mismatches: 2,
        }),
        exposure: makeExposure([inv]),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'blocked');
      assert.ok(gate.project.reasons.includes('rate_mismatch'));
    });

    it('blocks when at_risk_amount exceeds tolerance', () => {
      const inv = makeInvoiceExposure('INV-001', {
        at_risk_amount: 5000,
        supported_amount: 5000,
        unreconciled_amount: 0,
      });
      const result = makeResult({
        reconciliation: makeReconciliation(),
        exposure: makeExposure([inv], {
          total_at_risk_amount: 5000,
          at_risk_tolerance_amount: 0,
        }),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'blocked');
      assert.ok(gate.project.reasons.includes('missing_transaction_support'));
      assert.equal(gate.project.at_risk_amount, 5000);
    });

    it('blocks when unreconciled_amount exceeds tolerance', () => {
      const inv = makeInvoiceExposure('INV-001', {
        unreconciled_amount: 3000,
        supported_amount: 7000,
      });
      const result = makeResult({
        reconciliation: makeReconciliation(),
        exposure: makeExposure([inv], {
          total_unreconciled_amount: 3000,
          support_gap_tolerance_amount: 0,
        }),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'blocked');
      assert.ok(gate.project.reasons.includes('missing_contract_support'));
    });

    it('blocks when an invoice is BLOCKED even if project totals look fine', () => {
      const invOk = makeInvoiceExposure('INV-001');
      const invBad = makeInvoiceExposure('INV-002', {
        reconciliation_status: 'MISMATCH',
        at_risk_amount: 2000,
        billed_amount: 2000,
        supported_amount: 0,
      });
      const result = makeResult({
        reconciliation: makeReconciliation({
          overall_reconciliation_status: 'MISMATCH',
          rate_mismatches: 1,
        }),
        exposure: makeExposure([invOk, invBad]),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'blocked');
      assert.equal(gate.invoices[1]?.approval_status, 'blocked');
      assert.equal(gate.project.blocked_amount, 2000);
    });

    it('maps IDENTITY_DUPLICATE_TICKET to duplicate_billing', () => {
      const finding = makeFinding('f-dup', 'IDENTITY_DUPLICATE_TICKET', {
        severity: 'critical',
        status: 'open',
        subjectType: 'project',
      });
      const result = makeResult({ findings: [finding] });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'blocked');
      assert.ok(gate.project.reasons.includes('duplicate_billing'));
    });

    it('maps FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED to activation_unresolved', () => {
      const finding = makeFinding('f-act', 'FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED', {
        severity: 'critical',
        status: 'open',
        subjectType: 'project',
      });
      const result = makeResult({ findings: [finding] });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'blocked');
      assert.ok(gate.project.reasons.includes('activation_unresolved'));
    });

    it('maps FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR to pricing_applicability_unresolved', () => {
      const finding = makeFinding('f-price', 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR', {
        severity: 'critical',
        status: 'open',
        subjectType: 'project',
      });
      const result = makeResult({ findings: [finding] });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'blocked');
      assert.ok(gate.project.reasons.includes('pricing_applicability_unresolved'));
    });
  });

  // ---------------------------------------------------------------------------
  // NEEDS_REVIEW scenarios
  // ---------------------------------------------------------------------------

  describe('NEEDS_REVIEW', () => {
    it('returns needs_review on open warning finding', () => {
      const finding = makeFinding('f-warn', 'TRANSACTION_RATE_OUTLIERS', {
        severity: 'warning',
        status: 'open',
        subjectType: 'project',
      });
      const result = makeResult({
        findings: [finding],
        reconciliation: makeReconciliation(),
        exposure: makeExposure([makeInvoiceExposure('INV-001')]),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'needs_review');
      assert.ok(gate.project.reasons.includes('rate_mismatch'));
    });

    it('returns needs_review on PARTIAL reconciliation', () => {
      const inv = makeInvoiceExposure('INV-001', { reconciliation_status: 'PARTIAL' });
      const result = makeResult({
        reconciliation: makeReconciliation({
          overall_reconciliation_status: 'PARTIAL',
          matched_billing_groups: 2,
          unmatched_billing_groups: 1,
        }),
        exposure: makeExposure([inv]),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'needs_review');
      assert.equal(gate.invoices[0]?.approval_status, 'needs_review');
    });

    it('returns needs_review on MISSING contract_invoice_status', () => {
      const result = makeResult({
        reconciliation: makeReconciliation({
          contract_invoice_status: 'MISSING',
          overall_reconciliation_status: 'MISSING',
        }),
        exposure: null,
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'needs_review');
      assert.ok(gate.project.reasons.includes('missing_contract_support'));
    });

    it('returns needs_review on MISSING invoice_transaction_status', () => {
      const result = makeResult({
        reconciliation: makeReconciliation({
          invoice_transaction_status: 'MISSING',
          overall_reconciliation_status: 'PARTIAL',
        }),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'needs_review');
      assert.ok(gate.project.reasons.includes('missing_transaction_support'));
    });

    it('returns needs_review on orphan invoice lines', () => {
      const result = makeResult({
        reconciliation: makeReconciliation({
          orphan_invoice_lines: 3,
          overall_reconciliation_status: 'PARTIAL',
        }),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'needs_review');
      assert.ok(gate.project.reasons.includes('orphan_invoice_lines'));
    });

    it('ignores resolved/dismissed findings', () => {
      const findings = [
        makeFinding('f-res', 'SOURCES_NO_CONTRACT', {
          severity: 'critical',
          status: 'resolved',
        }),
        makeFinding('f-dis', 'TRANSACTION_RATE_OUTLIERS', {
          severity: 'warning',
          status: 'dismissed',
        }),
      ];
      const result = makeResult({
        findings,
        reconciliation: makeReconciliation(),
        exposure: makeExposure([makeInvoiceExposure('INV-001')]),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.approval_status, 'approved');
      assert.equal(gate.project.finding_ids.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // APPROVED_WITH_EXCEPTIONS scenarios
  // ---------------------------------------------------------------------------

  describe('APPROVED_WITH_EXCEPTIONS', () => {
    it('returns approved_with_exceptions when at-risk within tolerance', () => {
      const inv = makeInvoiceExposure('INV-001', {
        at_risk_amount: 200,
        reconciliation_status: 'MATCH',
        unreconciled_amount: 0,
      });
      const result = makeResult({
        reconciliation: makeReconciliation(),
        exposure: makeExposure([inv], {
          total_at_risk_amount: 200,
          at_risk_tolerance_amount: 500, // 200 < 500 → within tolerance
        }),
      });
      const gate = evaluateApprovalGate(result, { at_risk_threshold: 500 });

      assert.equal(gate.project.approval_status, 'approved_with_exceptions');
      assert.equal(gate.invoices[0]?.approval_status, 'approved_with_exceptions');
    });

    it('returns approved_with_exceptions when unreconciled within tolerance', () => {
      const inv = makeInvoiceExposure('INV-001', {
        unreconciled_amount: 150,
        supported_amount: 9850,
        reconciliation_status: 'MATCH',
        at_risk_amount: 0,
      });
      const result = makeResult({
        reconciliation: makeReconciliation(),
        exposure: makeExposure([inv], {
          total_unreconciled_amount: 150,
          support_gap_tolerance_amount: 500,
        }),
      });
      const gate = evaluateApprovalGate(result, { unreconciled_threshold: 500 });

      assert.equal(gate.project.approval_status, 'approved_with_exceptions');
    });
  });

  // ---------------------------------------------------------------------------
  // threshold override
  // ---------------------------------------------------------------------------

  describe('threshold overrides', () => {
    it('uses options.at_risk_threshold over exposure tolerance', () => {
      // exposure tolerance says 1000, caller override says 100
      const inv = makeInvoiceExposure('INV-001', {
        at_risk_amount: 500,
        reconciliation_status: 'MATCH',
        unreconciled_amount: 0,
      });
      const result = makeResult({
        reconciliation: makeReconciliation(),
        exposure: makeExposure([inv], {
          total_at_risk_amount: 500,
          at_risk_tolerance_amount: 1000, // exposure says ok
        }),
      });
      // caller tightens to 100 → 500 > 100 → BLOCKED
      const gate = evaluateApprovalGate(result, { at_risk_threshold: 100 });
      assert.equal(gate.project.approval_status, 'blocked');
    });
  });

  // ---------------------------------------------------------------------------
  // reason deduplication
  // ---------------------------------------------------------------------------

  describe('reason deduplication', () => {
    it('returns each gate reason at most once', () => {
      const inv1 = makeInvoiceExposure('INV-001', {
        reconciliation_status: 'MISMATCH',
        at_risk_amount: 1000,
      });
      const inv2 = makeInvoiceExposure('INV-002', {
        reconciliation_status: 'MISMATCH',
        at_risk_amount: 500,
      });
      const result = makeResult({
        reconciliation: makeReconciliation({
          overall_reconciliation_status: 'MISMATCH',
          rate_mismatches: 3,
          quantity_mismatches: 1,
        }),
        exposure: makeExposure([inv1, inv2]),
      });
      const gate = evaluateApprovalGate(result);

      const reasonCounts = gate.project.reasons.reduce<Record<string, number>>(
        (acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }),
        {},
      );
      for (const [reason, count] of Object.entries(reasonCounts)) {
        assert.equal(count, 1, `reason '${reason}' should appear exactly once`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // blocked_amount rollup
  // ---------------------------------------------------------------------------

  describe('blocked_amount rollup', () => {
    it('sums billed amounts for blocked invoices only', () => {
      const inv1 = makeInvoiceExposure('INV-001', {
        billed_amount: 10000,
        reconciliation_status: 'MATCH',
        at_risk_amount: 0,
        unreconciled_amount: 0,
      });
      const inv2 = makeInvoiceExposure('INV-002', {
        billed_amount: 6000,
        reconciliation_status: 'MISMATCH',
        at_risk_amount: 1000,
      });
      const inv3 = makeInvoiceExposure('INV-003', {
        billed_amount: 4000,
        reconciliation_status: 'MISMATCH',
        at_risk_amount: 500,
      });
      const result = makeResult({
        reconciliation: makeReconciliation({
          overall_reconciliation_status: 'MISMATCH',
          rate_mismatches: 2,
        }),
        exposure: makeExposure([inv1, inv2, inv3]),
      });
      const gate = evaluateApprovalGate(result);

      assert.equal(gate.project.blocked_amount, 10000); // 6000 + 4000
      assert.equal(gate.invoices[0]?.approval_status, 'approved');
      assert.equal(gate.invoices[1]?.approval_status, 'blocked');
      assert.equal(gate.invoices[2]?.approval_status, 'blocked');
    });
  });
});

// ---------------------------------------------------------------------------
// Williamson project — realistic multi-invoice example
// ---------------------------------------------------------------------------

describe('Williamson project example', () => {
  /**
   * Williamson Construction Services
   * FEMA DR-4609 debris removal — three invoices across two billing cycles.
   *
   * INV-W-001 ($82,450)   — Fully reconciled. Clean.
   * INV-W-002 ($44,200)   — Partially reconciled. Quantity mismatch on haul tickets.
   * INV-W-003 ($31,875)   — Rate mismatch. Unit price billed ($18.75/yd³) differs
   *                         from contract schedule ($16.50/yd³). AT-RISK.
   *
   * Contract: rate-based schedule, activation gate resolved, pricing applicability clear.
   * Transactions: 2 of 3 billing groups have matching haul ticket data.
   *
   * Expected gate:
   *   Project → BLOCKED (rate mismatch on INV-W-003 exceeds zero tolerance)
   *   INV-W-001 → approved
   *   INV-W-002 → needs_review  (partial)
   *   INV-W-003 → blocked       (rate mismatch + at_risk)
   */

  const INV_W001 = makeInvoiceExposure('INV-W-001', {
    billed_amount: 82450,
    contract_supported_amount: 82450,
    transaction_supported_amount: 82450,
    fully_reconciled_amount: 82450,
    supported_amount: 82450,
    unreconciled_amount: 0,
    at_risk_amount: 0,
    reconciliation_status: 'MATCH',
  });

  const INV_W002 = makeInvoiceExposure('INV-W-002', {
    billed_amount: 44200,
    contract_supported_amount: 44200,
    transaction_supported_amount: 38000,
    fully_reconciled_amount: 38000,
    supported_amount: 38000,
    unreconciled_amount: 6200,
    at_risk_amount: 0,
    reconciliation_status: 'PARTIAL',
  });

  const INV_W003 = makeInvoiceExposure('INV-W-003', {
    billed_amount: 31875,
    contract_supported_amount: 28512.50, // at correct $16.50 rate
    transaction_supported_amount: 28512.50,
    fully_reconciled_amount: 28512.50,
    supported_amount: 28512.50,
    unreconciled_amount: 3362.50, // $18.75 vs $16.50 = $2.25/yd³ × 1495 yd³
    at_risk_amount: 3362.50,
    reconciliation_status: 'MISMATCH',
  });

  const williamsonReconciliation = makeReconciliation({
    contract_invoice_status: 'MISMATCH',
    invoice_transaction_status: 'PARTIAL',
    overall_reconciliation_status: 'MISMATCH',
    matched_billing_groups: 2,
    unmatched_billing_groups: 1,
    rate_mismatches: 1,
    quantity_mismatches: 1,
    orphan_invoice_lines: 0,
    orphan_transactions: 0,
  });

  const williamsonExposure = makeExposure(
    [INV_W001, INV_W002, INV_W003],
    {
      total_billed_amount: 158525,
      total_contract_supported_amount: 154962.5,
      total_transaction_supported_amount: 148962.5,
      total_fully_reconciled_amount: 148962.5,
      total_unreconciled_amount: 9562.5,
      total_at_risk_amount: 3362.5,
      support_gap_tolerance_amount: 0,
      at_risk_tolerance_amount: 0,
    },
  );

  // Rate mismatch finding linked to INV-W-003
  const rateMismatchFinding = makeFinding(
    'f-rate-w003',
    'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE',
    {
      severity: 'critical',
      status: 'open',
      subjectType: 'invoice',
      subjectId: 'INV-W-003',
      checkKey: 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE:INV-W-003',
    },
  );

  // Quantity mismatch warning on INV-W-002
  const quantityWarning = makeFinding(
    'f-qty-w002',
    'TRANSACTION_QUANTITY_MATCHES_INVOICE',
    {
      severity: 'warning',
      status: 'open',
      subjectType: 'invoice',
      subjectId: 'INV-W-002',
      checkKey: 'TRANSACTION_QUANTITY_MATCHES_INVOICE:INV-W-002',
    },
  );

  const williamsonResult = makeResult({
    findings: [rateMismatchFinding, quantityWarning],
    reconciliation: williamsonReconciliation,
    exposure: williamsonExposure,
  });

  it('project is BLOCKED', () => {
    const gate = evaluateApprovalGate(williamsonResult);
    assert.equal(gate.project.approval_status, 'blocked');
  });

  it('project blocked_amount equals INV-W-003 billed amount', () => {
    const gate = evaluateApprovalGate(williamsonResult);
    assert.equal(gate.project.blocked_amount, 31875);
  });

  it('project at_risk_amount reflects rate variance on INV-W-003', () => {
    const gate = evaluateApprovalGate(williamsonResult);
    assert.equal(gate.project.at_risk_amount, 3362.5);
  });

  it('project reasons include rate_mismatch and quantity_mismatch', () => {
    const gate = evaluateApprovalGate(williamsonResult);
    assert.ok(gate.project.reasons.includes('rate_mismatch'));
    assert.ok(gate.project.reasons.includes('quantity_mismatch'));
  });

  it('INV-W-001 is approved', () => {
    const gate = evaluateApprovalGate(williamsonResult);
    const inv = gate.invoices.find((i) => i.invoice_number === 'INV-W-001');
    assert.ok(inv, 'INV-W-001 not found in gate output');
    assert.equal(inv.approval_status, 'approved');
    assert.equal(inv.at_risk_amount, 0);
    assert.deepEqual(inv.reasons, []);
  });

  it('INV-W-002 is needs_review with quantity_mismatch reason', () => {
    const gate = evaluateApprovalGate(williamsonResult);
    const inv = gate.invoices.find((i) => i.invoice_number === 'INV-W-002');
    assert.ok(inv, 'INV-W-002 not found in gate output');
    assert.equal(inv.approval_status, 'needs_review');
    assert.ok(inv.reasons.includes('quantity_mismatch'));
    assert.ok(inv.finding_ids.includes('f-qty-w002'));
  });

  it('INV-W-003 is blocked with rate_mismatch and missing_transaction_support', () => {
    const gate = evaluateApprovalGate(williamsonResult);
    const inv = gate.invoices.find((i) => i.invoice_number === 'INV-W-003');
    assert.ok(inv, 'INV-W-003 not found in gate output');
    assert.equal(inv.approval_status, 'blocked');
    assert.ok(inv.reasons.includes('rate_mismatch'));
    assert.ok(inv.reasons.includes('missing_transaction_support'));
    assert.equal(inv.at_risk_amount, 3362.5);
    assert.ok(inv.finding_ids.includes('f-rate-w003'));
  });

  it('project finding_ids include both finding IDs', () => {
    const gate = evaluateApprovalGate(williamsonResult);
    assert.ok(gate.project.finding_ids.includes('f-rate-w003'));
    assert.ok(gate.project.finding_ids.includes('f-qty-w002'));
  });

  it('no duplicate finding IDs in project', () => {
    const gate = evaluateApprovalGate(williamsonResult);
    const seen = new Set<string>();
    for (const id of gate.project.finding_ids) {
      assert.ok(!seen.has(id), `finding_id '${id}' is duplicated`);
      seen.add(id);
    }
  });

  it('output shape matches decision schema', () => {
    const gate = evaluateApprovalGate(williamsonResult);

    // Project decision shape
    assert.ok('approval_status' in gate.project);
    assert.ok('reasons' in gate.project);
    assert.ok('blocked_amount' in gate.project);
    assert.ok('at_risk_amount' in gate.project);
    assert.ok('finding_ids' in gate.project);
    assert.ok('billing_group_ids' in gate.project);
    assert.ok('invoices' in gate.project);

    // Invoice decision shape
    for (const inv of gate.invoices) {
      assert.ok('invoice_number' in inv);
      assert.ok('approval_status' in inv);
      assert.ok('billed_amount' in inv);
      assert.ok('supported_amount' in inv);
      assert.ok('at_risk_amount' in inv);
      assert.ok('reasons' in inv);
      assert.ok('finding_ids' in inv);
      assert.ok('billing_group_ids' in inv);
    }
  });
});
