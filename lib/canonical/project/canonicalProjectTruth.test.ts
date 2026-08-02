import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { adaptAssembledPricingRow } from '@/lib/canonical/contract/pricingAdapter';
import { resolveCanonicalPricingRow } from '@/lib/canonical/contract/pricingResolution';
import { adaptCurrentInvoiceRows, adaptInvoiceExtraction } from '@/lib/canonical/invoice/invoiceAdapter';
import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';
import { representCanonicalPricingMatch } from '@/lib/canonical/reconciliation/pricingMatch';
import { adaptProjectTransactionRow, translateTransactionEligibility } from '@/lib/canonical/transaction/transactionAdapter';
import { mapValidationFindingToCanonicalFacts } from '@/lib/canonical/validation/factImpact';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { InvoiceExtraction } from '@/lib/types/extractionSchemas';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

const invoiceSource: InvoiceExtraction = {
  schema_type: 'invoice',
  invoice_number: 'INV-7',
  invoice_status: null,
  invoice_date: '2026-07-01',
  period_start: '2026-06-01',
  period_end: '2026-06-30',
  period_through: null,
  vendor_name: 'Source Vendor LLC',
  client_name: null,
  line_items: [{
    line_code: 'A1', line_description: 'Haul vegetative debris', quantity: 10,
    unit: 'CY', unit_price: 5, line_total: 50, billing_rate_key: 'A1',
    description_match_key: 'HAUL VEGETATIVE DEBRIS', evidence_refs: ['invoice:row:7'],
    raw_text: 'A1 | Haul vegetative debris | 10 | CY | 5 | 50',
  }],
  line_item_count: 1,
  subtotal_amount: 50,
  total_amount: 50,
  payment_terms: null,
  po_number: null,
};

function pricingRow(authoredValueCorrection = false): ContractPricingAssemblyRow {
  return {
    id: 'rate-row-1', category: 'Vegetative', description: 'Haul vegetative debris',
    route: 'ROW to DMS', distanceBand: '0 to 15 Miles', unit: 'CY', rate: 5,
    page: 8, sourceAnchor: 'contract:row:1', confidence: 'high',
    sourceKind: 'exhibit_a_table', sourceQuality: 'clean', authoredValueCorrection,
    rawText: 'Vegetative | Haul vegetative debris | CY | 5',
  };
}

function finding(): ValidationFinding {
  return {
    id: 'finding-1', run_id: 'run-1', project_id: 'project-1',
    rule_id: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS', check_key: 'invoice:INV-7:A1',
    category: 'financial_integrity', severity: 'critical', status: 'open',
    subject_type: 'invoice_line', subject_id: 'invoice-line-1', field: 'billed_rate',
    expected: 'governing contract rate', actual: '5', variance: null, variance_unit: null,
    blocked_reason: 'governing rate requires review', finding_disposition: 'blocker',
    business_severity: 'critical', problem: 'No approval-eligible governing rate.',
    impact: 'Billed line remains unsupported.', required_action: 'Review governing rate.',
    evidence_refs: ['invoice:row:7'], source_family: 'cross_document', affected_amount: 50,
    approval_gate_effect: 'blocks_approval', exposure_type: 'missing_governing_contract',
    decision_eligible: true, action_eligible: true, linked_decision_id: null,
    linked_action_id: null, resolved_by_user_id: null, resolved_at: null,
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  };
}

function evidence(): ValidationEvidence {
  return {
    id: 'evidence-1', finding_id: 'finding-1', evidence_type: 'invoice_line',
    source_document_id: 'invoice-doc', source_page: 1, fact_id: null,
    record_id: 'invoice:row:7', field_name: 'line_total', field_value: '50',
    note: null, created_at: '2026-08-01T00:00:00Z',
  };
}

describe('canonical invoice adapters', () => {
  it('adapts a complete invoice and preserves line evidence', () => {
    const { invoice, lines } = adaptInvoiceExtraction(invoiceSource, {
      projectId: 'project-1', documentId: 'invoice-doc', invoiceId: 'invoice-1',
      supportedTotal: 50, atRiskTotal: 0,
    });
    assert.equal(invoice.invoiceNumber.value, 'INV-7');
    assert.equal(invoice.contractorVendor.value, 'Source Vendor LLC');
    assert.equal(lines[0]?.lineId, 'invoice-1:line:invoice-row-7');
    assert.equal(lines[0]?.evidence[0]?.sourceAnchor, 'invoice:row:7');
    assert.equal(lines[0]?.matchingKeys.descriptionMatchKey, 'HAUL VEGETATIVE DEBRIS');
  });

  it('retains an incomplete invoice without manufacturing values', () => {
    const { invoice, lines } = adaptInvoiceExtraction({
      ...invoiceSource,
      vendor_name: null,
      total_amount: null,
      line_items: [{ ...invoiceSource.line_items[0]!, line_code: null, unit: null }],
    }, { projectId: null, documentId: 'invoice-doc' });
    assert.equal(invoice.contractorVendor.state, 'absent_from_source');
    assert.equal(invoice.governingProjectId.state, 'requires_review');
    assert.equal(invoice.billedTotal.value, null);
    assert.equal(lines[0]?.rateCode, undefined);
    assert.equal(lines[0]?.unit, undefined);
    assert.ok(lines[0]?.absentFields.includes('rateCode'));
  });

  it('never collapses two billed lines that share one evidence anchor', () => {
    const shared = invoiceSource.line_items[0]!;
    const { lines } = adaptInvoiceExtraction({
      ...invoiceSource,
      line_items: [
        { ...shared, line_description: 'Haul vegetative debris', line_total: 50 },
        { ...shared, line_description: 'Haul C&D debris', line_total: 75 },
      ],
    }, { projectId: 'project-1', documentId: 'invoice-doc', invoiceId: 'invoice-1' });

    assert.equal(new Set(lines.map((line) => line.lineId)).size, 2);
    assert.ok(lines.every((line) => line.identityKind === 'deterministic_fallback'));
    assert.ok(lines.every((line) => line.identityWarning === 'line_id_collision_disambiguated_by_ordinal'));
    assert.deepEqual(lines.map((line) => line.extendedAmount.value), [50, 75]);
  });

  it('never collapses two billed lines with identical description and amount', () => {
    const duplicate = { ...invoiceSource.line_items[0]!, evidence_refs: [] };
    const { lines } = adaptInvoiceExtraction({
      ...invoiceSource,
      line_items: [duplicate, { ...duplicate }],
    }, { projectId: 'project-1', documentId: 'invoice-doc', invoiceId: 'invoice-1' });

    assert.equal(new Set(lines.map((line) => line.lineId)).size, 2);
    assert.ok(lines.every((line) => line.identityWarning === 'line_id_collision_disambiguated_by_ordinal'));
  });

  it('preserves current-row source coordinates and all four existing matching keys', () => {
    const { lines } = adaptCurrentInvoiceRows({
      invoiceRow: { id: 'invoice-1', invoice_number: 'INV-7', vendor_name: 'Source Vendor LLC' },
      invoiceLines: [{
        id: 'line-1', line_description: 'Haul vegetative debris', quantity: 10,
        unit_price: 5, line_total: 50, source_row_number: 42, source_sheet_name: 'Invoice Lines',
        source_page: 3, billing_rate_key: 'A1', description_match_key: 'HAUL VEGETATIVE DEBRIS',
        site_material_key: 'DMS-1|VEGETATIVE', invoice_rate_key: 'INV-7|A1',
      }],
      context: { projectId: 'project-1', documentId: 'invoice-doc', invoiceId: 'invoice-1' },
    });

    const line = lines[0]!;
    assert.equal(line.sourceRow, 42);
    assert.equal(line.sourceSheet, 'Invoice Lines');
    assert.equal(line.sourcePage, 3);
    assert.deepEqual(line.matchingKeys, {
      billingRateKey: 'A1',
      descriptionMatchKey: 'HAUL VEGETATIVE DEBRIS',
      siteMaterialKey: 'DMS-1|VEGETATIVE',
      invoiceRateKey: 'INV-7|A1',
    });
  });

  it('serializes sparse optional fields without empty envelope placeholders', () => {
    const { lines } = adaptInvoiceExtraction({
      ...invoiceSource,
      line_items: [{ ...invoiceSource.line_items[0]!, line_code: null, unit: null, material: null }],
    }, { projectId: 'project-1', documentId: 'invoice-doc' });
    const serialized = JSON.parse(JSON.stringify(lines[0])) as Record<string, unknown>;
    assert.equal('rateCode' in serialized, false);
    assert.equal('unit' in serialized, false);
    assert.equal('materialType' in serialized, false);
  });
});

describe('canonical transaction adapters', () => {
  it('preserves persisted row identity, sheet, row, raw evidence, and typed values', () => {
    const transaction = adaptProjectTransactionRow({
      id: 'tx-row-1', document_id: 'workbook-doc', invoice_number: 'INV-7',
      transaction_number: 'T-1', rate_code: 'A1', transaction_quantity: 10,
      extended_cost: 50, invoice_date: '2026-06-15', source_sheet_name: 'Tickets',
      source_row_number: 42, billing_rate_key: 'A1', description_match_key: 'HAUL',
      record_json: { material: 'Vegetative', transaction_rate: 5, unit: 'CY' },
      raw_row_json: { Ticket: 'T-1', Quantity: 10, Rate: 5 },
    }, { documentId: null, sourceWorkbook: 'tickets.xlsx' });
    assert.equal(transaction.transactionId, 'tx-row-1');
    assert.equal(transaction.sourceDocumentId, 'workbook-doc');
    assert.equal(transaction.sourceSheet, 'Tickets');
    assert.equal(transaction.sourceRow, 42);
    assert.equal(transaction.rawRowEvidence.Ticket, 'T-1');
    assert.equal(transaction.material?.value, 'Vegetative');
    assert.equal(transaction.unit?.value, 'CY');
  });

  it('does not guess missing optional values or eligibility', () => {
    const transaction = adaptProjectTransactionRow({
      id: 'tx-row-2', source_sheet_name: 'unknown', source_row_number: 0,
    }, {
      documentId: 'workbook-doc', sourceWorkbook: 'tickets.xlsx',
    });
    assert.equal(transaction.rateCode, undefined);
    assert.equal(transaction.route, undefined);
    assert.equal(transaction.distanceBand, undefined);
    assert.equal(transaction.sourceSheet, null);
    assert.equal(transaction.sourceRow, null);
    assert.equal(transaction.supportState, 'unknown');
    assert.equal(translateTransactionEligibility('unrecognized status'), 'unknown');
  });
});

describe('canonical matching, reconciliation, impact, and registry', () => {
  it('represents matched and ambiguous current matcher outcomes without inventing confidence', () => {
    const { lines } = adaptInvoiceExtraction(invoiceSource, {
      projectId: 'project-1', documentId: 'invoice-doc', invoiceId: 'invoice-1',
    });
    const row = resolveCanonicalPricingRow(adaptAssembledPricingRow(pricingRow(), 0, {}));
    const base = {
      matchId: 'match-1', invoiceLine: lines[0]!, candidatePricingRows: [row],
      selectedPricingRow: row, transactions: [], matching: {
        keysUsed: ['billing_rate_key'], normalizedDescriptionKey: 'HAUL',
        descriptionSimilarity: null, rateCodeMatch: true, categoryMatch: true,
        unitMatch: true, originDestinationMatch: null, distanceBandMatch: null,
        materialMatch: true,
      }, expectedRate: 5, variance: 0, affectedAmount: 50,
      evidence: lines[0]!.evidence, unresolvedReasons: [], approvalImpact: null,
      sourceMatcher: 'current_validator_matcher', sourceMatchStatus: 'matched',
    } as const;
    assert.equal(representCanonicalPricingMatch({ ...base, status: 'matched' }).status, 'matched');
    const ambiguous = representCanonicalPricingMatch({
      ...base, status: 'ambiguous', selectedPricingRow: null,
      unresolvedReasons: ['multiple_current_candidates'],
    });
    assert.equal(ambiguous.selectedPricingRowId, null);
    assert.equal(ambiguous.matching.descriptionSimilarity, null);
    assert.deepEqual(ambiguous.governingSelection, {
      candidatePresent: true,
      candidateCount: 1,
      selectedGoverningRowId: null,
      selectionStatus: 'ambiguous',
      selectedRowApprovalEligible: false,
      expectedRateAvailable: false,
      unresolvedReason: 'multiple_current_candidates',
    });
  });

  it('represents candidate presence separately from a selected approval-eligible rate', () => {
    const { lines } = adaptInvoiceExtraction(invoiceSource, {
      projectId: 'project-1', documentId: 'invoice-doc', invoiceId: 'invoice-1',
    });
    const candidate = resolveCanonicalPricingRow(adaptAssembledPricingRow(pricingRow(true), 0, {}));
    const match = representCanonicalPricingMatch({
      matchId: 'candidate-only', invoiceLine: lines[0]!, candidatePricingRows: [candidate],
      selectedPricingRow: null, transactions: [], status: 'governing_rate_requires_review',
      matching: {
        keysUsed: ['current_candidate_set'], normalizedDescriptionKey: null,
        descriptionSimilarity: null, rateCodeMatch: null, categoryMatch: true,
        unitMatch: true, originDestinationMatch: null, distanceBandMatch: null,
        materialMatch: null,
      },
      expectedRate: 5, variance: null, affectedAmount: 50, evidence: candidate.rate.supportingEvidence,
      unresolvedReasons: ['authored correction requires review'], approvalImpact: 'blocks_approval',
      sourceMatcher: 'current_validator_matcher', sourceMatchStatus: 'candidate_present_unselected',
      selectionStatus: 'candidate_only',
    });

    assert.equal(match.governingSelection.candidatePresent, true);
    assert.equal(match.governingSelection.candidateCount, 1);
    assert.equal(match.governingSelection.selectedGoverningRowId, null);
    assert.equal(match.governingSelection.selectedRowApprovalEligible, false);
    assert.equal(match.governingSelection.expectedRateAvailable, false);
    assert.equal(match.governingSelection.unresolvedReason, 'authored correction requires review');
  });

  it('keeps authored pricing review and approval ineligibility unchanged', () => {
    const row = resolveCanonicalPricingRow(adaptAssembledPricingRow(pricingRow(true), 0, {}));
    assert.equal(row.resolution.displayGroup, 'needs_review');
    assert.equal(row.resolution.approval.eligible, false);
    assert.ok(row.resolution.approval.blockers.includes('authored_value_correction'));
  });

  it('maps a finding to exact canonical fields without changing the finding', () => {
    const current = finding();
    const before = structuredClone(current);
    const impact = mapValidationFindingToCanonicalFacts({
      finding: current, evidence: [evidence()], affectedFacts: [
        { objectId: 'rate-row-1', fieldPath: 'rate' },
        { objectId: 'invoice-line-1', fieldPath: 'billedRate' },
      ],
    });
    assert.deepEqual(current, before);
    assert.equal(impact.exposureAmount, 50);
    assert.equal(impact.approvalGateEffect, 'blocks_approval');
    assert.equal(impact.affectedFacts.length, 2);
  });

  it('builds a deterministic shadow-only project registry with typed reconciliations', () => {
    const adapted = adaptInvoiceExtraction(invoiceSource, {
      projectId: 'project-1', documentId: 'invoice-doc', invoiceId: 'invoice-1',
    });
    const transaction = adaptProjectTransactionRow({ id: 'tx-2', transaction_number: 'T-2' }, {
      documentId: 'workbook-doc', sourceWorkbook: 'tickets.xlsx',
    });
    const transactionFirst = adaptProjectTransactionRow({ id: 'tx-1', transaction_number: 'T-1' }, {
      documentId: 'workbook-doc', sourceWorkbook: 'tickets.xlsx',
    });
    const registry = buildCanonicalProjectTruth({
      projectId: 'project-1', governingDocuments: [], contractTermReferences: [],
      contractPricing: [], invoices: [adapted.invoice], invoiceLines: adapted.lines,
      transactions: [transaction, transactionFirst],
      derived: {
        pricingMatches: [], contractInvoiceReconciliations: [],
        invoiceTransactionReconciliations: [{
          reconciliationId: 'it-1', invoiceId: 'invoice-1',
          invoiceLineIds: adapted.lines.map((line) => line.lineId), transactionIds: ['tx-1'],
          facts: { invoiceBilledQuantity: 10, transactionSupportedQuantity: 10, quantityVariance: 0,
            invoiceBilledAmount: 50, transactionExtendedCost: 50, amountVariance: 0, supportCompleteness: 1 },
          conclusion: { state: 'reconciled', reasons: [] }, evidence: [], sourceStatus: 'MATCH',
        }],
        projectReconciliation: null, validationImpacts: [], exposureReadinessReferences: [],
      },
    });
    assert.deepEqual(registry.transactions.map((row) => row.transactionId), ['tx-1', 'tx-2']);
    assert.equal(registry.construction.mode, 'shadow_only');
    assert.equal(registry.construction.persisted, false);
    assert.equal(registry.derived.invoiceTransactionReconciliations[0]?.facts.quantityVariance, 0);
  });
});

function productionCanonicalFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return productionCanonicalFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('canonical architecture guards', () => {
  it('contains no fixture-family branching, Golden vendor literal, or duplicate TruthState definition', () => {
    const files = productionCanonicalFiles(join(process.cwd(), 'lib', 'canonical'));
    const text = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    assert.doesNotMatch(text, /Aftermath Disaster Recovery/i);
    assert.doesNotMatch(text, /\b(?:TDOT|MDOT|Goodlettsville)\b/);
    assert.doesNotMatch(text, /(?:type|interface)\s+TruthState\b/);
    assert.doesNotMatch(text, /invoiceCanonicalNames|@\/lib\/projectFacts/);
  });
});
