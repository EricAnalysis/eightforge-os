import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { deriveBillingKeysForRateScheduleItem } from '@/lib/validator/billingKeys';
import { evaluateCrossDocumentRateVerification } from '@/lib/validator/rulePacks/crossDocumentRateVerification';
import {
  type ProjectTotals,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type ValidatorDocumentIdsByFamily,
  type ValidatorFactLookups,
  type ValidatorProjectRow,
} from '@/lib/validator/shared';

const CONTRACT_DOCUMENT_ID = 'contract-doc';
const INVOICE_DOCUMENT_ID = 'invoice-doc';
const SUPPORT_DOCUMENT_ID = 'support-doc';

function makeRateItem(params: {
  recordId: string;
  description: string;
  rate: number;
  sourceCategory?: string | null;
  rateCode?: string | null;
}): RateScheduleItem {
  const keys = deriveBillingKeysForRateScheduleItem({
    rate_code: params.rateCode ?? null,
    description: params.description,
    material_type: params.sourceCategory ?? null,
    unit_type: 'CYD',
  });

  return {
    source_document_id: CONTRACT_DOCUMENT_ID,
    record_id: params.recordId,
    rate_code: params.rateCode ?? null,
    unit_type: 'CYD',
    rate_amount: params.rate,
    material_type: params.sourceCategory ?? null,
    source_category: params.sourceCategory ?? null,
    description: params.description,
    raw_value: {
      description: params.description,
      source_category: params.sourceCategory ?? null,
      rate_amount: params.rate,
      unit_type: 'CYD',
    },
    ...keys,
  };
}

function buildInput(params: {
  rateScheduleItems: RateScheduleItem[];
  invoiceLines: Array<Record<string, unknown>>;
  mobileTickets?: Array<Record<string, unknown>>;
  loadTickets?: Array<Record<string, unknown>>;
}): ProjectValidatorInput {
  const project: ValidatorProjectRow = {
    id: 'project-1',
    organization_id: 'org-1',
    name: 'Golden Project',
    code: 'GOLDEN',
  };
  const familyDocumentIds: ValidatorDocumentIdsByFamily = {
    contract: [CONTRACT_DOCUMENT_ID],
    rate_sheet: [],
    permit: [],
    invoice: [INVOICE_DOCUMENT_ID],
    ticket_support: [SUPPORT_DOCUMENT_ID],
  };
  const factLookups: ValidatorFactLookups = {
    contractProjectCodeFacts: [],
    invoiceProjectCodeFacts: [],
    contractPartyNameFacts: [],
    contractIdentityDocumentIds: [CONTRACT_DOCUMENT_ID],
    pricingContextDocumentIds: [],
    complianceContextDocumentIds: [],
    amendmentContextDocumentIds: [],
    nteFact: null,
    contractDocumentId: CONTRACT_DOCUMENT_ID,
    contractCeilingTypeFact: null,
    contractCeilingType: 'rate_based',
    rateSchedulePresentFact: null,
    rateSchedulePresent: true,
    rateRowCountFact: null,
    rateRowCount: params.rateScheduleItems.length,
    rateSchedulePagesFact: null,
    rateSchedulePagesDisplay: 'page 1',
    rateUnitsDetectedFact: null,
    rateUnitsDetected: ['CYD'],
    timeAndMaterialsPresentFact: null,
    timeAndMaterialsPresent: false,
    rateScheduleFacts: [],
    rateScheduleItems: params.rateScheduleItems,
    hasRateScheduleFacts: params.rateScheduleItems.length > 0,
  };
  const projectTotals: ProjectTotals = {
    billed_total: params.invoiceLines.reduce((sum, row) => sum + (Number(row.line_total ?? 0) || 0), 0),
    invoice_count: 1,
    invoice_line_count: params.invoiceLines.length,
    mobile_ticket_count: params.mobileTickets?.length ?? 0,
    load_ticket_count: params.loadTickets?.length ?? 0,
  };

  return {
    project,
    validationPhase: 'billing_review',
    documents: [],
    documentRelationships: [],
    precedenceFamilies: [],
    familyDocumentIds,
    governingDocumentIds: familyDocumentIds,
    truthCategoryDocumentIds: {
      contract_identity: [CONTRACT_DOCUMENT_ID],
      pricing: [CONTRACT_DOCUMENT_ID],
      compliance: [],
      amendments: [],
    },
    ruleStateByRuleId: new Map(),
    factsByDocumentId: new Map(),
    allFacts: [],
    mobileTickets: params.mobileTickets ?? [],
    loadTickets: params.loadTickets ?? [],
    invoices: [],
    invoiceLines: params.invoiceLines,
    mobileToLoadsMap: new Map(),
    invoiceLineToRateMap: new Map(),
    projectTotals,
    factLookups,
    contractValidationContext: null,
  };
}

describe('cross document rate verification', () => {
  it('matches contract, invoice, and mobile ticket support through canonical category', () => {
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:veg-grind',
          description: 'Grinding Chipping Vegetative Debris',
          sourceCategory: 'Vegetative',
          rate: 2.25,
        }),
      ],
      invoiceLines: [{
        id: 'line:veg-grind',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: 'INV-001',
        description: 'Grinding Chipping Vegetative Debris',
        unit_price: 2.25,
        quantity: 10,
        line_total: 22.5,
      }],
      mobileTickets: [{
        id: 'mobile:1',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: 'INV-001',
        material: 'Vegetative',
        unit: 'CYD',
        quantity_cyd: 10,
      }],
    });

    const result = evaluateCrossDocumentRateVerification(input);

    assert.equal(result.findings.length, 0);
    assert.equal(result.summary.matched_units, 1);
    assert.equal(result.summary.validation_units[0]?.canonical_category, 'vegetative_removal');
    assert.equal(result.summary.validation_units[0]?.comparison_status, 'match');
  });

  it('matches invoice 2026-002 line 1F to the contract row by rate code and unit price without using quantity', () => {
    const description = 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30';
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:1F',
          rateCode: '1F',
          description,
          sourceCategory: 'Vegetative',
          rate: 14.5,
        }),
      ],
      invoiceLines: [{
        id: 'invoice-line-2026-002-1F',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: '2026-002',
        rate_code: '1F',
        description,
        unit_price: 14.5,
        quantity: 916,
        line_total: 13282,
      }],
      mobileTickets: [{
        id: 'mobile:2026-002-1F',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: '2026-002',
        material: 'Vegetative',
        quantity_cyd: 916,
      }],
    });

    const result = evaluateCrossDocumentRateVerification(input);

    assert.equal(result.findings.length, 0);
    assert.equal(result.summary.matched_units, 1);
    assert.equal(result.summary.missing_contract_rate_units, 0);
    assert.equal(result.summary.validation_units[0]?.invoice_number, '2026-002');
    assert.equal(result.summary.validation_units[0]?.invoice_rate, 14.5);
    assert.equal(result.summary.validation_units[0]?.contract_rate, 14.5);
    assert.equal(result.summary.validation_units[0]?.comparison_status, 'match');
  });

  it('detects invoice rate mismatches against contract truth while mobile unit support maps by service item', () => {
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:tree-25-36',
          description: 'Hazardous Tree 25 36 in',
          sourceCategory: 'Tree Operations',
          rate: 315,
        }),
      ],
      invoiceLines: [{
        id: 'line:tree-25-36',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: 'INV-002',
        description: 'Hazardous Tree 25 36 in',
        unit_price: 350,
        quantity: 1,
        line_total: 350,
      }],
      loadTickets: [{
        id: 'unit:1',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: 'INV-002',
        service_item: 'Hazardous Tree 25 36 in',
        unit: 'Each',
        quantity: 1,
      }],
    });

    const result = evaluateCrossDocumentRateVerification(input);

    assert.equal(result.summary.rate_mismatch_units, 1);
    assert.equal(result.summary.validation_units[0]?.support_families[0], 'mobile_unit_ticket');
    assert.equal(result.findings[0]?.rule_id, 'CROSS_DOCUMENT_RATE_MATCHES_CONTRACT');
  });

  it('detects category mismatch when invoice category and ticket support category differ', () => {
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:veg-haul',
          description: 'Vegetative haul line',
          sourceCategory: 'Vegetative',
          rate: 6.9,
        }),
      ],
      invoiceLines: [{
        id: 'line:veg-haul',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: 'INV-003',
        description: 'Vegetative haul line',
        unit_price: 6.9,
        quantity: 2,
        line_total: 13.8,
      }],
      mobileTickets: [{
        id: 'mobile:cd',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: 'INV-003',
        material: 'C&D',
        quantity_cyd: 2,
      }],
    });

    const result = evaluateCrossDocumentRateVerification(input);

    assert.equal(result.summary.category_mismatch_units, 1);
    assert.deepEqual(result.summary.validation_units[0]?.support_observed_categories, [
      'construction_demolition',
    ]);
    assert.equal(result.findings[0]?.rule_id, 'CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS');
  });

  it('separates missing contract rate from fully unsupported invoice work', () => {
    const missingContract = evaluateCrossDocumentRateVerification(buildInput({
      rateScheduleItems: [],
      invoiceLines: [{
        id: 'line:unknown-supported',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: 'INV-004',
        description: 'Grinding Chipping Vegetative Debris',
        unit_price: 2.25,
        quantity: 4,
        line_total: 9,
      }],
      mobileTickets: [{
        id: 'mobile:veg',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: 'INV-004',
        material: 'Vegetative',
        quantity_cyd: 4,
      }],
    }));

    const unsupported = evaluateCrossDocumentRateVerification(buildInput({
      rateScheduleItems: [],
      invoiceLines: [{
        id: 'line:unknown-unsupported',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: 'INV-005',
        description: 'Grinding Chipping Vegetative Debris',
        unit_price: 2.25,
        quantity: 4,
        line_total: 9,
      }],
      mobileTickets: [],
    }));

    assert.equal(missingContract.summary.missing_contract_rate_units, 1);
    assert.equal(missingContract.findings[0]?.rule_id, 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS');
    assert.equal(unsupported.summary.unsupported_work_units, 1);
    assert.equal(unsupported.findings[0]?.rule_id, 'CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED');
  });
});
