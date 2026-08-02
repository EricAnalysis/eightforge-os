import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { adaptAssembledPricingRow } from '@/lib/canonical/contract/pricingAdapter';
import { buildCanonicalPricingSchedule, resolveCanonicalPricingRow } from '@/lib/canonical/contract/pricingResolution';
import { adaptCurrentInvoiceRows } from '@/lib/canonical/invoice/invoiceAdapter';
import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';
import { representCanonicalPricingMatch } from '@/lib/canonical/reconciliation/pricingMatch';
import { adaptProjectTransactionRow } from '@/lib/canonical/transaction/transactionAdapter';
import { mapValidationFindingToCanonicalFacts } from '@/lib/canonical/validation/factImpact';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { ParsedPricingDimensions } from '@/lib/contracts/pricingDimensions';
import goldenTransportArtifact from '@/lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

const GOLDEN = {
  projectId: 'golden-project-fixture',
  contractDocumentId: 'golden-contract-fixture',
  invoiceDocumentId: 'golden-invoice-2026-002-fixture',
  transactionDocumentId: 'golden-ticket-workbook-fixture',
  pricingRowId: 'exhibit_a_table:pdf:table:p8:t26:r2:v1',
  invoiceId: 'golden:invoice:2026-002',
  invoiceLineId: 'invoice-line-2026-002-1A',
  findingId: 'golden-current-finding-row-dms',
  category: 'Vegetative Collect, Remove & Haul',
  description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
  unit: 'Cubic Yard',
  rate: 6.9,
  route: 'ROW to DMS',
  distanceBand: '0 to 15 Miles',
  invoiceNumber: '2026-002',
  rateCode: '1A',
  quantity: 43_894,
  affectedAmount: 302_868.6,
} as const;

function contractRow(): ContractPricingAssemblyRow {
  const artifact = goldenTransportArtifact.rows[0]!;
  return {
    id: artifact.id, category: artifact.category, description: artifact.description,
    unit: artifact.unit, rate: artifact.rate, route: artifact.route,
    distanceBand: artifact.distanceBand,
    pricingDimensions: artifact.pricingDimensions as ParsedPricingDimensions,
    pricingDimensionSources: artifact.pricingDimensionSources as NonNullable<ContractPricingAssemblyRow['pricingDimensionSources']>,
    page: artifact.page, sourceAnchor: artifact.sourceAnchor,
    confidence: artifact.confidence as ContractPricingAssemblyRow['confidence'],
    sourceKind: artifact.sourceKind as ContractPricingAssemblyRow['sourceKind'],
    sourceQuality: artifact.sourceQuality as ContractPricingAssemblyRow['sourceQuality'],
    authoredValueCorrection: artifact.authoredValueCorrection,
    rawText: artifact.rawText,
  };
}

function currentFinding(): ValidationFinding {
  return {
    id: GOLDEN.findingId,
    run_id: 'golden-run-fixture',
    project_id: GOLDEN.projectId,
    rule_id: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
    check_key: `invoice:${GOLDEN.invoiceNumber}:${GOLDEN.rateCode}`,
    category: 'financial_integrity',
    severity: 'critical',
    status: 'open',
    lifecycle_state: 'blocked',
    subject_type: 'invoice_line',
    subject_id: GOLDEN.invoiceLineId,
    field: 'billed_rate',
    expected: 'approval-eligible governing contract rate',
    actual: 'no current governing rate match',
    variance: null,
    variance_unit: null,
    blocked_reason: 'No approval-eligible contract rate matched the invoice line.',
    finding_disposition: 'blocker',
    business_severity: 'critical',
    problem: 'The invoice line is unmatched under the current matcher.',
    impact: 'The billed amount remains at risk.',
    required_action: 'Review the governing contract rate and existing match.',
    evidence_refs: ['invoice:2026-002:line:1A', 'pdf:table:p8:t26:r2'],
    source_family: 'cross_document',
    affected_amount: GOLDEN.affectedAmount,
    approval_gate_effect: 'blocks_approval',
    exposure_type: 'missing_governing_contract',
    decision_eligible: true,
    action_eligible: true,
    linked_decision_id: null,
    linked_action_id: null,
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

function findingEvidence(): readonly ValidationEvidence[] {
  return [{
    id: 'golden-evidence-invoice-line', finding_id: GOLDEN.findingId,
    evidence_type: 'invoice_line', source_document_id: GOLDEN.invoiceDocumentId,
    source_page: 1, fact_id: null, record_id: GOLDEN.invoiceLineId,
    field_name: 'line_total', field_value: String(GOLDEN.affectedAmount), note: null,
    created_at: '2026-08-01T00:00:00Z',
  }, {
    id: 'golden-evidence-contract-row', finding_id: GOLDEN.findingId,
    evidence_type: 'rate_schedule', source_document_id: GOLDEN.contractDocumentId,
    source_page: 8, fact_id: null, record_id: GOLDEN.pricingRowId,
    field_name: 'rate', field_value: String(GOLDEN.rate), note: null,
    created_at: '2026-08-01T00:00:00Z',
  }];
}

describe('Golden canonical project truth shadow chain', () => {
  it('represents ROW-to-DMS 0-15 end to end without changing the current finding', () => {
    const pricing = resolveCanonicalPricingRow(adaptAssembledPricingRow(contractRow(), 0, {
      documentId: GOLDEN.contractDocumentId,
      governingDocument: {
        documentId: GOLDEN.contractDocumentId,
        family: 'contract',
        title: 'Golden governing contract fixture',
      },
      rateSchedule: { scheduleId: 'golden-schedule', scheduleName: 'Exhibit A' },
    }));
    assert.equal(pricing.description.value, GOLDEN.description);
    assert.equal(pricing.unit.value, GOLDEN.unit);
    assert.equal(pricing.rate.value, GOLDEN.rate);
    assert.equal(pricing.route.value, GOLDEN.route);
    assert.equal(pricing.route.state, 'derived');
    assert.equal(pricing.routeKind.value, 'row_to_dms');
    assert.equal(pricing.distanceBand.value, GOLDEN.distanceBand);
    assert.equal(pricing.distanceBand.state, 'derived');
    assert.equal(pricing.distanceInterval.value?.minMiles, 0);
    assert.equal(pricing.distanceInterval.value?.maxMiles, 15);
    assert.ok(pricing.rate.supportingEvidence.length > 0);
    assert.equal(pricing.resolution.displayGroup, 'needs_review');
    assert.equal(pricing.resolution.approval.eligible, false);
    assert.ok(pricing.resolution.approval.blockers.includes('authored_value_correction'));

    const adaptedInvoice = adaptCurrentInvoiceRows({
      invoiceRow: {
        id: GOLDEN.invoiceId, invoice_number: GOLDEN.invoiceNumber,
        source_document_id: GOLDEN.invoiceDocumentId, vendor_name: 'Golden source vendor fixture',
        total_amount: 534_757.1,
      },
      invoiceLines: [{
        id: GOLDEN.invoiceLineId, invoice_number: GOLDEN.invoiceNumber,
        line_code: GOLDEN.rateCode,
        line_description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
        canonical_category: GOLDEN.category, quantity: GOLDEN.quantity,
        unit: GOLDEN.unit, unit_price: GOLDEN.rate, line_total: GOLDEN.affectedAmount,
        billing_rate_key: GOLDEN.rateCode, description_match_key: 'VEGETATIVE ROW TO DMS 0 15',
        evidence_refs: ['invoice:2026-002:line:1A'],
      }],
      context: {
        projectId: GOLDEN.projectId, documentId: GOLDEN.invoiceDocumentId,
        invoiceId: GOLDEN.invoiceId, supportedTotal: 0, atRiskTotal: GOLDEN.affectedAmount,
      },
    });
    const invoiceLine = adaptedInvoice.lines[0]!;
    assert.equal(invoiceLine.lineId, GOLDEN.invoiceLineId);
    assert.equal(invoiceLine.billedRate.value, GOLDEN.rate);
    assert.equal(invoiceLine.extendedAmount.value, GOLDEN.affectedAmount);

    const transactions = [
      adaptProjectTransactionRow({
        id: 'golden-ticket-row-100', document_id: GOLDEN.transactionDocumentId,
        invoice_number: GOLDEN.invoiceNumber, transaction_number: 'TICKET-100', rate_code: GOLDEN.rateCode,
        transaction_quantity: 20_000, extended_cost: 138_000, source_sheet_name: 'Ticket Query',
        source_row_number: 100, record_json: { material: 'Vegetative', transaction_rate: GOLDEN.rate },
        raw_row_json: { Ticket: 'TICKET-100', Invoice: GOLDEN.invoiceNumber, Quantity: 20_000 },
      }, { documentId: GOLDEN.transactionDocumentId, sourceWorkbook: 'ticket_query_20260404_191302.xlsx' }),
      adaptProjectTransactionRow({
        id: 'golden-ticket-row-101', document_id: GOLDEN.transactionDocumentId,
        invoice_number: GOLDEN.invoiceNumber, transaction_number: 'TICKET-101', rate_code: GOLDEN.rateCode,
        transaction_quantity: 23_894, extended_cost: 164_868.6, source_sheet_name: 'Ticket Query',
        source_row_number: 101, record_json: { material: 'Vegetative', transaction_rate: GOLDEN.rate },
        raw_row_json: { Ticket: 'TICKET-101', Invoice: GOLDEN.invoiceNumber, Quantity: 23_894 },
      }, { documentId: GOLDEN.transactionDocumentId, sourceWorkbook: 'ticket_query_20260404_191302.xlsx' }),
    ];
    assert.equal(transactions.reduce((sum, row) => sum + (row.quantity.value ?? 0), 0), GOLDEN.quantity);
    assert.ok(transactions.every((row) => row.sourceSheet === 'Ticket Query' && row.sourceRow != null));

    const match = representCanonicalPricingMatch({
      matchId: 'golden-current-match-row-dms', invoiceLine,
      candidatePricingRows: [pricing], selectedPricingRow: null, transactions,
      status: 'governing_rate_requires_review',
      matching: {
        keysUsed: ['current_billing_keys'], normalizedDescriptionKey: 'VEGETATIVE ROW TO DMS 0 15',
        descriptionSimilarity: null, rateCodeMatch: null, categoryMatch: true, unitMatch: true,
        originDestinationMatch: null, distanceBandMatch: null, materialMatch: true,
      },
      expectedRate: GOLDEN.rate, variance: 0, affectedAmount: GOLDEN.affectedAmount,
      evidence: [...pricing.rate.supportingEvidence, ...invoiceLine.evidence, ...transactions.flatMap((row) => row.evidence)],
      unresolvedReasons: ['authored_value_correction', 'current_match_unresolved'],
      approvalImpact: 'blocks_approval', sourceMatcher: 'current_validator_matcher',
      sourceMatchStatus: 'unmatched',
      selectionStatus: 'candidate_only',
      selectionUnresolvedReason: 'authored correction requires review',
    });
    assert.equal(match.selectedPricingRowId, null);
    assert.equal(match.sourceMatchStatus, 'unmatched');
    assert.deepEqual(match.governingSelection, {
      candidatePresent: true,
      candidateCount: 1,
      selectedGoverningRowId: null,
      selectionStatus: 'candidate_only',
      selectedRowApprovalEligible: false,
      expectedRateAvailable: false,
      unresolvedReason: 'authored correction requires review',
    });

    const finding = currentFinding();
    const findingBefore = structuredClone(finding);
    const impact = mapValidationFindingToCanonicalFacts({
      finding, evidence: findingEvidence(), affectedFacts: [
        { objectId: pricing.rowId, fieldPath: 'rate' },
        { objectId: invoiceLine.lineId, fieldPath: 'billedRate' },
        { objectId: invoiceLine.lineId, fieldPath: 'extendedAmount' },
      ],
    });

    const invoiceTransactionReconciliation = {
      reconciliationId: 'golden-invoice-transaction-row-dms',
      invoiceId: adaptedInvoice.invoice.invoiceId,
      invoiceLineIds: [invoiceLine.lineId],
      transactionIds: transactions.map((row) => row.transactionId),
      facts: {
        invoiceBilledQuantity: GOLDEN.quantity, transactionSupportedQuantity: GOLDEN.quantity,
        quantityVariance: 0, invoiceBilledAmount: GOLDEN.affectedAmount,
        transactionExtendedCost: GOLDEN.affectedAmount, amountVariance: 0, supportCompleteness: 1,
      },
      conclusion: { state: 'reconciled' as const, reasons: [] },
      evidence: transactions.flatMap((row) => row.evidence),
      sourceStatus: 'MATCH',
    };

    const registry = buildCanonicalProjectTruth({
      projectId: GOLDEN.projectId,
      governingDocuments: [{
        documentId: GOLDEN.contractDocumentId, family: 'contract', relationship: 'governs',
        effectiveAt: null, evidence: pricing.rate.supportingEvidence,
      }],
      contractTermReferences: [],
      contractPricing: [buildCanonicalPricingSchedule({
        scheduleId: 'golden-schedule', scheduleName: 'Exhibit A', rows: [pricing],
      })],
      invoices: [adaptedInvoice.invoice], invoiceLines: adaptedInvoice.lines, transactions,
      derived: {
        pricingMatches: [match], contractInvoiceReconciliations: [],
        invoiceTransactionReconciliations: [invoiceTransactionReconciliation],
        projectReconciliation: null, validationImpacts: [impact],
        exposureReadinessReferences: [{
          referenceId: 'golden-exposure-row-dms', sourceKind: 'exposure_summary',
          amount: GOLDEN.affectedAmount, state: 'at_risk', evidence: invoiceLine.evidence,
        }],
      },
      sourceSnapshotId: 'golden-fast-fixture-2026-08-01',
    });

    assert.deepEqual(finding, findingBefore, 'shadow construction must not mutate current finding');
    assert.equal(registry.derived.validationImpacts[0]?.findingStatus, 'open');
    assert.equal(registry.derived.validationImpacts[0]?.exposureAmount, GOLDEN.affectedAmount);
    assert.equal(registry.derived.pricingMatches[0]?.status, 'governing_rate_requires_review');
    assert.equal(registry.contractPricing[0]?.rows[0]?.resolution.approval.eligible, false);
    assert.equal(registry.construction.mode, 'shadow_only');
  });
});
