import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { DocumentFactReviewRow } from '@/lib/documentFactReviews';
import {
  applyEffectiveInvoiceFacts,
  buildFactsByDocumentId,
  buildInvoiceLineToRateMap,
} from '@/lib/validator/projectValidator';
import { runFinancialIntegrityRules } from '@/lib/validator/rulePacks/financialIntegrity';
import type {
  InvoiceLineRow,
  ProjectValidatorInput,
  ValidatorDocumentRow,
  ValidatorLegacyExtractionRow,
} from '@/lib/validator/shared';

const DOCUMENT_ID = 'invoice-doc-2026-002';

function makeDocument(): ValidatorDocumentRow {
  return {
    id: DOCUMENT_ID,
    project_id: 'project-1',
    organization_id: 'org-1',
    title: 'Williamson invoice 2026-002',
    name: 'williamson-2026-002.pdf',
    document_type: 'invoice',
    created_at: '2026-04-04T00:00:00.000Z',
  };
}

function makeLegacyRows(lines: Array<Record<string, unknown>>): Map<string, ValidatorLegacyExtractionRow> {
  return new Map([[DOCUMENT_ID, {
    document_id: DOCUMENT_ID,
    created_at: '2026-05-26T17:20:37.494682Z',
    data: {
      fields: {
        typed_fields: {
          schema_type: 'invoice',
          invoice_number: '2026-002',
          line_items: lines,
        },
      },
    },
  }]]);
}

function makeReview(overrides: Partial<DocumentFactReviewRow>): DocumentFactReviewRow {
  return {
    id: 'review-1',
    organization_id: 'org-1',
    document_id: DOCUMENT_ID,
    field_key: 'line_items',
    review_status: 'confirmed',
    reviewed_value_json: null,
    reviewed_by: 'operator-1',
    reviewed_at: '2026-07-20T22:45:44.5932Z',
    notes: null,
    ...overrides,
  };
}

function effectiveLines(params: {
  legacyLines: Array<Record<string, unknown>>;
  reviewRows: DocumentFactReviewRow[];
}) {
  const facts = buildFactsByDocumentId({
    documents: [makeDocument()],
    factRows: [],
    legacyRowsByDocumentId: makeLegacyRows(params.legacyLines),
    overrideRows: [],
    reviewRows: params.reviewRows,
  });
  const result = applyEffectiveInvoiceFacts({
    invoices: [{
      id: 'invoice-row-2026-002',
      source_document_id: DOCUMENT_ID,
      invoice_number: '2026-002',
    }],
    invoiceLines: [{
      id: 'typed:invoice-doc-2026-002:invoice:line:1',
      source_document_id: DOCUMENT_ID,
      invoice_number: '2026-002',
      rate_code: 'STALE-SYNTHETIC',
    }],
    factsByDocumentId: facts.factsByDocumentId,
    invoiceDocumentIds: [DOCUMENT_ID],
  });

  return { facts, lines: result.invoiceLines };
}

function financialInput(invoiceLines: InvoiceLineRow[]): ProjectValidatorInput {
  const families = {
    contract: ['contract-doc'],
    rate_sheet: [],
    permit: [],
    invoice: [DOCUMENT_ID],
    ticket_support: [],
  };
  return {
    project: { id: 'project-1', organization_id: 'org-1', name: 'Golden Project', code: 'GOLDEN' },
    validationPhase: 'billing_review',
    documents: [],
    documentRelationships: [],
    precedenceFamilies: [],
    familyDocumentIds: families,
    governingDocumentIds: families,
    truthCategoryDocumentIds: {
      contract_identity: ['contract-doc'],
      pricing: ['contract-doc'],
      compliance: [],
      amendments: [],
    },
    ruleStateByRuleId: new Map(),
    factsByDocumentId: new Map(),
    allFacts: [],
    mobileTickets: [],
    loadTickets: [],
    invoices: [{
      id: 'invoice-row-2026-002',
      source_document_id: DOCUMENT_ID,
      invoice_number: '2026-002',
    }],
    invoiceLines,
    mobileToLoadsMap: new Map(),
    invoiceLineToRateMap: new Map(),
    projectTotals: {
      billed_total: 534_757.1,
      invoice_count: 1,
      invoice_line_count: invoiceLines.length,
      mobile_ticket_count: 0,
      load_ticket_count: 0,
    },
    factLookups: {
      contractProjectCodeFacts: [],
      invoiceProjectCodeFacts: [],
      contractPartyNameFacts: [],
      contractIdentityDocumentIds: ['contract-doc'],
      pricingContextDocumentIds: ['contract-doc'],
      complianceContextDocumentIds: [],
      amendmentContextDocumentIds: [],
      nteFact: null,
      contractDocumentId: 'contract-doc',
      contractCeilingTypeFact: null,
      contractCeilingType: 'rate_based',
      rateSchedulePresentFact: null,
      rateSchedulePresent: true,
      rateRowCountFact: null,
      rateRowCount: 105,
      rateSchedulePagesFact: null,
      rateSchedulePagesDisplay: 'pages 8-10',
      rateUnitsDetectedFact: null,
      rateUnitsDetected: ['cubic yard', 'tree'],
      timeAndMaterialsPresentFact: null,
      timeAndMaterialsPresent: false,
      rateScheduleFacts: [],
      rateScheduleItems: [],
      hasRateScheduleFacts: true,
    },
    contractValidationContext: null,
  };
}

describe('effective invoice-line fact boundary', () => {
  it('treats a null-value confirmation as attestation and completes without blanking or reordering', () => {
    const evidenceOne = ['invoice:p1:line:1'];
    const evidenceTwo = ['invoice:p1:line:2'];
    const { facts, lines } = effectiveLines({
      legacyLines: [
        {
          line_code: '1A',
          line_description: 'Vegetative debris haul 0 to 15 miles',
          billing_rate_key: '1A',
          description_match_key: 'vegetative debris haul 0 to 15 miles',
          evidence_refs: evidenceOne,
          raw_text: '1A exact first row',
        },
        {
          line_code: '1B',
          line_description: 'Vegetative debris haul 16 to 30 miles',
          billing_rate_key: '1B',
          description_match_key: 'vegetative debris haul 16 to 30 miles',
          evidence_refs: evidenceTwo,
          raw_text: '1B exact second row',
        },
      ],
      reviewRows: [makeReview({})],
    });
    const lineFact = facts.factsByDocumentId.get(DOCUMENT_ID)?.find(
      (fact) => fact.key === 'invoice_line_items',
    );

    assert.equal(lineFact?.source, 'legacy_typed_field');
    assert.deepEqual(lines.map((line) => line.id), [
      `fact:${DOCUMENT_ID}:line:1`,
      `fact:${DOCUMENT_ID}:line:2`,
    ]);
    assert.deepEqual(lines.map((line) => line.rate_code), ['1A', '1B']);
    assert.deepEqual(lines.map((line) => line.raw_text), [
      '1A exact first row',
      '1B exact second row',
    ]);
    assert.strictEqual(lines[0]?.evidence_refs, evidenceOne);
    assert.strictEqual(lines[1]?.evidence_refs, evidenceTwo);
    assert.equal(lines[0]?.invoice_id, 'invoice-row-2026-002');
    assert.equal(lines[1]?.invoice_number, '2026-002');
    assert.equal(lines[1]?.source_document_id, DOCUMENT_ID);
  });

  it('keeps a corrected review payload higher priority and preserves all operator values', () => {
    const operatorEvidence = ['operator:confirmed:line:1'];
    const correctedPayload = [{
      invoice_id: 'operator-invoice-row',
      source_document_id: DOCUMENT_ID,
      line_code: '1A',
      rate_code: '1A',
      billing_rate_key: 'OPERATOR-BILLING-1A',
      description_match_key: 'operator description key',
      canonical_category: 'operator_category',
      category_confidence: 0.731,
      line_description: 'Vegetative debris haul',
      evidence_refs: operatorEvidence,
      raw_text: 'operator exact raw text',
    }];
    const { facts, lines } = effectiveLines({
      legacyLines: [{
        line_code: '1A',
        line_description: 'Vegetative debris haul',
      }],
      reviewRows: [makeReview({
        review_status: 'corrected',
        reviewed_value_json: correctedPayload,
      })],
    });
    const lineFact = facts.factsByDocumentId.get(DOCUMENT_ID)?.find(
      (fact) => fact.key === 'invoice_line_items',
    );
    const line = lines[0];
    const resolution = line?.line_code_resolution as Record<string, unknown>;

    assert.equal(lineFact?.source, 'human_review');
    assert.equal(lines.length, 1);
    assert.equal(line?.id, `fact:${DOCUMENT_ID}:line:1`);
    assert.equal(line?.invoice_id, 'operator-invoice-row');
    assert.equal(line?.invoice_number, '2026-002');
    assert.equal(line?.rate_code, '1A');
    assert.equal(line?.billing_rate_key, 'OPERATOR-BILLING-1A');
    assert.equal(line?.description_match_key, 'operator description key');
    assert.equal(line?.canonical_category, 'operator_category');
    assert.equal(line?.category_confidence, 0.731);
    assert.equal(line?.raw_text, 'operator exact raw text');
    assert.strictEqual(line?.evidence_refs, operatorEvidence);
    assert.equal(resolution.rate_code_origin, 'operator_asserted');
    assert.equal(resolution.effective_fact_source, 'human_review');
  });

  it('removes all six Williamson 2026-002 missing-rate-code false positives at the boundary', () => {
    const { lines } = effectiveLines({
      legacyLines: [
        ['1A', 'Vegetative debris haul 0 to 15 miles'],
        ['1B', 'Vegetative debris haul 16 to 30 miles'],
        ['1E', 'Rural vegetative debris haul 0 to 15 miles'],
        ['1F', 'Rural vegetative debris haul 16 to 30 miles'],
        ['5A', 'Hazardous tree removal 6 to 12 inches'],
        ['6A', 'Hazardous hanging limb removal over 2 inches'],
      ].map(([lineCode, description]) => ({
        line_code: lineCode,
        line_description: description,
        billing_rate_key: lineCode,
        description_match_key: description.toLowerCase(),
      })),
      reviewRows: [makeReview({})],
    });

    assert.equal(
      runFinancialIntegrityRules(financialInput(lines)).filter(
        (finding) => finding.rule_id === 'FINANCIAL_RATE_CODE_MISSING',
      ).length,
      0,
    );
  });

  it('keeps the legitimate 2026-003 null contract rate-code row matched and unchanged', () => {
    const rawLine = {
      id: 'fact:invoice-doc-2026-003:line:4',
      source_document_id: 'invoice-doc-2026-003',
      invoice_number: '2026-003',
      line_code: '3C',
      line_description: 'Final Disposal Mulch DMS to FDS 31-60 miles',
      unit_price: 4.25,
      quantity: 1977,
      line_total: 8402.25,
    };
    const completedLine = {
      ...rawLine,
      rate_code: '3C',
      billing_rate_key: '3C',
      description_match_key: 'final disposal mulch dms to fds 31 60 miles',
    };
    const contractRate = {
      source_document_id: 'contract-doc',
      record_id: 'exhibit_a_table:pdf:table:p8:t31:r3',
      rate_code: null,
      unit_type: 'Cubic Yard',
      rate_amount: 4.25,
      material_type: 'Final Disposal',
      description: 'DMS to Final Disposal 31 to 60 Miles',
      source_category: 'Final Disposal',
      canonical_category: 'final_disposal',
      category_confidence: 0.95,
      raw_value: {},
    };

    const before = buildInvoiceLineToRateMap([rawLine], [contractRate]);
    const after = buildInvoiceLineToRateMap([completedLine], [contractRate]);

    assert.equal(before.get(rawLine.id)?.record_id, contractRate.record_id);
    assert.equal(after.get(rawLine.id)?.record_id, contractRate.record_id);
    assert.equal(after.get(rawLine.id)?.rate_code, null);
  });
});
