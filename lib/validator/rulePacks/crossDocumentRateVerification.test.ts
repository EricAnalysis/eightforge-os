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
  sourceDocumentId?: string;
}): RateScheduleItem {
  const keys = deriveBillingKeysForRateScheduleItem({
    rate_code: params.rateCode ?? null,
    description: params.description,
    material_type: params.sourceCategory ?? null,
    unit_type: 'CYD',
  });

  return {
    source_document_id: params.sourceDocumentId ?? CONTRACT_DOCUMENT_ID,
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
  transactionRows?: Array<Record<string, unknown>>;
  hasRateScheduleFacts?: boolean;
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
    rateRowCount: params.hasRateScheduleFacts ? Math.max(params.rateScheduleItems.length, 1) : params.rateScheduleItems.length,
    rateSchedulePagesFact: null,
    rateSchedulePagesDisplay: 'page 1',
    rateUnitsDetectedFact: null,
    rateUnitsDetected: ['CYD'],
    timeAndMaterialsPresentFact: null,
    timeAndMaterialsPresent: false,
    rateScheduleFacts: [],
    rateScheduleItems: params.rateScheduleItems,
    hasRateScheduleFacts: params.hasRateScheduleFacts ?? params.rateScheduleItems.length > 0,
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
    transactionData: params.transactionRows
      ? {
        datasets: [],
        rows: params.transactionRows.map((row, index) => ({
          id: String(row.id ?? `txn-${index + 1}`),
          document_id: String(row.document_id ?? SUPPORT_DOCUMENT_ID),
          project_id: 'project-1',
          invoice_number: row.invoice_number != null ? String(row.invoice_number) : null,
          transaction_number: row.transaction_number != null ? String(row.transaction_number) : null,
          rate_code: row.rate_code != null ? String(row.rate_code) : null,
          billing_rate_key: row.billing_rate_key != null ? String(row.billing_rate_key) : null,
          description_match_key: row.description_match_key != null ? String(row.description_match_key) : null,
          site_material_key: row.site_material_key != null ? String(row.site_material_key) : null,
          invoice_rate_key: row.invoice_rate_key != null ? String(row.invoice_rate_key) : null,
          transaction_quantity: Number(row.transaction_quantity ?? 0),
          extended_cost: Number(row.extended_cost ?? 0),
          invoice_date: row.invoice_date != null ? String(row.invoice_date) : null,
          source_sheet_name: row.source_sheet_name != null ? String(row.source_sheet_name) : 'ticket_query',
          source_row_number: Number(row.source_row_number ?? index + 2),
          record_json: (row.record_json as Record<string, unknown> | undefined) ?? {
            material: row.material ?? null,
            service_item: row.service_item ?? null,
          },
          raw_row_json: (row.raw_row_json as Record<string, unknown> | undefined) ?? {},
          created_at: String(row.created_at ?? '2026-04-01T00:00:00.000Z'),
        })),
      }
      : undefined,
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
    assert.equal(result.summary.validation_units[0]?.canonical_category, 'management_reduction');
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

  it('uses operational fallback when the contract row lacks the invoice monitoring rate code', () => {
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:veg-row-dms-0-15',
          description:
            'Cubic Yard | Vegetative Collect, Remove & Haul | 0-15 Miles from ROW to DMS | from Unincorporated Neighborhoods',
          sourceCategory: 'Vegetative',
          rate: 6.9,
        }),
      ],
      invoiceLines: [{
        id: 'invoice-line-2026-002-1A',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: '2026-002',
        rate_code: '1A',
        description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
        unit_price: 6.9,
        quantity: 43894,
        line_total: 302868.6,
      }],
      mobileTickets: [ {
        id: 'mobile:2026-002-1A',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: '2026-002',
        rate_code: '1A',
        material: 'Vegetative',
        quantity_cyd: 43894,
      }],
    });

    const result = evaluateCrossDocumentRateVerification(input);

    assert.equal(result.findings.length, 0);
    assert.equal(result.summary.matched_units, 1);
    assert.equal(result.summary.missing_contract_rate_units, 0);
    assert.equal(result.summary.validation_units[0]?.contract_rate_found, true);
    assert.equal(result.summary.validation_units[0]?.contract_rate, 6.9);
    assert.equal(result.summary.validation_units[0]?.comparison_status, 'match');
  });

  it('keeps same-rate unrelated contract rows from clearing missing contract rate blockers', () => {
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:unrelated',
          description: 'Temporary road repair crew standby',
          sourceCategory: 'Road Repair',
          rate: 6.9,
        }),
      ],
      invoiceLines: [{
        id: 'invoice-line-2026-002-1A',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: '2026-002',
        rate_code: '1A',
        description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
        unit_price: 6.9,
        quantity: 43894,
        line_total: 302868.6,
      }],
      mobileTickets: [{
        id: 'mobile:2026-002-1A',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: '2026-002',
        rate_code: '1A',
        material: 'Vegetative',
        quantity_cyd: 43894,
      }],
    });

    const result = evaluateCrossDocumentRateVerification(input);

    assert.equal(result.summary.missing_contract_rate_units, 1);
    assert.equal(result.findings[0]?.rule_id, 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS');
  });

  it('does not use an operational fallback row when the invoice rate differs from contract truth', () => {
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:veg-row-dms-0-15',
          description:
            'Cubic Yard | Vegetative Collect, Remove & Haul | 0-15 Miles from ROW to DMS | from Unincorporated Neighborhoods',
          sourceCategory: 'Vegetative',
          rate: 6.9,
        }),
      ],
      invoiceLines: [{
        id: 'invoice-line-2026-002-1A',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: '2026-002',
        rate_code: '1A',
        description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
        unit_price: 7.25,
        quantity: 43894,
        line_total: 318231.5,
      }],
      mobileTickets: [{
        id: 'mobile:2026-002-1A',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: '2026-002',
        rate_code: '1A',
        material: 'Vegetative',
        quantity_cyd: 43894,
      }],
    });

    const result = evaluateCrossDocumentRateVerification(input);

    assert.equal(result.summary.rate_mismatch_units, 0);
    assert.equal(result.summary.missing_contract_rate_units, 1);
    assert.equal(result.findings[0]?.rule_id, 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS');
  });

  it('does not clear contract-rate existence when the invoice rate differs from a same-description row', () => {
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

    assert.equal(result.summary.rate_mismatch_units, 0);
    assert.equal(result.summary.missing_contract_rate_units, 1);
    assert.equal(result.summary.validation_units[0]?.support_families[0], 'mobile_unit_ticket');
    assert.equal(result.findings[0]?.rule_id, 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS');
  });

  it('does not create category mismatch when support confirms line category and contract rate aligns', () => {
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:2b',
          rateCode: '2B',
          description: 'Grinding and Chipping Vegetative Debris',
          sourceCategory: 'Management & Reduction',
          rate: 2.25,
        }),
      ],
      invoiceLines: [{
        id: 'line:2b',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: '2026-003',
        rate_code: '2B',
        description: 'Management Reduction Grinding Chipping Vegetative Debris',
        unit_price: 2.25,
        quantity: 100,
        line_total: 225,
      }],
      transactionRows: [{
        id: 'txn:veg-2b',
        document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: '2026-003',
        rate_code: '2B',
        billing_rate_key: '2B',
        invoice_rate_key: '2026003::2B',
        material: 'Vegetative',
        transaction_quantity: 10,
        extended_cost: 100,
      }],
    });

    const result = evaluateCrossDocumentRateVerification(input);

    assert.equal(result.summary.category_mismatch_units, 0);
    assert.equal(result.findings.some((finding) => finding.rule_id === 'CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS'), false);
    assert.equal(result.summary.matched_units, 1);
  });

  it('does not allow a vegetative ticket from this project to support another project contract lifecycle row', () => {
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:project-b-2b',
          rateCode: '2B',
          description: 'Grinding and Chipping Vegetative Debris',
          sourceCategory: 'Management & Reduction',
          sourceDocumentId: 'project-b-contract',
          rate: 2.25,
        }),
      ],
      invoiceLines: [{
        id: 'line:project-a-2b',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: '2026-003',
        rate_code: '2B',
        description: 'Management Reduction Grinding Chipping Vegetative Debris',
        unit_price: 2.25,
        quantity: 100,
        line_total: 225,
      }],
      transactionRows: [{
        id: 'txn:project-a-veg-2b',
        document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: '2026-003',
        rate_code: '2B',
        billing_rate_key: '2B',
        invoice_rate_key: '2026003::2B',
        material: 'Vegetative',
        transaction_quantity: 10,
        extended_cost: 100,
      }],
    });

    const result = evaluateCrossDocumentRateVerification(input);

    assert.equal(result.summary.matched_units, 0);
    assert.equal(result.summary.category_mismatch_units, 1);
  });

  it('detects category mismatch when invoice category and ticket support category differ', () => {
    const input = buildInput({
      rateScheduleItems: [
        makeRateItem({
          recordId: 'rate:veg-haul',
          rateCode: '1A',
          description: 'Vegetative haul line',
          sourceCategory: 'Vegetative',
          rate: 6.9,
        }),
      ],
      invoiceLines: [{
        id: 'line:veg-haul',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: 'INV-003',
        rate_code: '1A',
        description: 'Vegetative haul line',
        unit_price: 6.9,
        quantity: 2,
        line_total: 13.8,
      }],
      mobileTickets: [{
        id: 'mobile:cd',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: 'INV-003',
        rate_code: '1A',
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


  it('preserves pending rate evidence messaging when rate rows exist but require review', () => {
    const result = evaluateCrossDocumentRateVerification(buildInput({
      rateScheduleItems: [],
      hasRateScheduleFacts: true,
      invoiceLines: [{
        id: 'line:pending-rate-review',
        source_document_id: INVOICE_DOCUMENT_ID,
        invoice_number: 'INV-006',
        description: 'Loading Hauling Vegetative Debris',
        unit_price: 27,
        quantity: 4,
        line_total: 108,
      }],
      mobileTickets: [{
        id: 'mobile:veg-pending',
        source_document_id: SUPPORT_DOCUMENT_ID,
        invoice_number: 'INV-006',
        material: 'Vegetative',
        quantity_cyd: 4,
      }],
    }));

    assert.equal(result.summary.missing_contract_rate_units, 1);
    assert.equal(result.findings[0]?.rule_id, 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS');
    assert.equal(result.findings[0]?.actual, 'Rate schedule exists but requires review before approval');
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
