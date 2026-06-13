import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { evaluateContractInvoiceReconciliation } from '@/lib/validator/rulePacks/contractInvoiceReconciliation';
import {
  buildValidationSummary,
  type ProjectTotals,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type ValidatorDocumentIdsByFamily,
  type ValidatorFactLookups,
  type ValidatorFactRecord,
  type ValidatorProjectRow,
} from '@/lib/validator/shared';

const TEST_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const CONTRACT_DOCUMENT_ID = 'contract-1';
const INVOICE_DOCUMENT_IDS = ['invoice-2026-002', 'invoice-2026-003'] as const;

function makeFactRecord(
  documentId: string,
  key: string,
  value: unknown,
): ValidatorFactRecord {
  return {
    id: `${documentId}:${key}`,
    document_id: documentId,
    key,
    value,
    source: 'normalized_row',
    field_type: null,
    evidence: [{
      id: `fact:${documentId}:${key}`,
      finding_id: `fact:${documentId}:${key}`,
      evidence_type: 'fact',
      source_document_id: documentId,
      source_page: key === 'rate_table' ? 8 : key === 'owner_name' ? 1 : 2,
      fact_id: `${documentId}:${key}`,
      record_id: `${documentId}:${key}`,
      field_name: key,
      field_value:
        typeof value === 'string'
          ? value
          : JSON.stringify(value) ?? null,
      note: `Test fact for ${key}.`,
      created_at: TEST_TIMESTAMP,
    }],
  };
}

function makeRateItem(rateCode: string, rate: number): RateScheduleItem {
  return {
    source_document_id: CONTRACT_DOCUMENT_ID,
    record_id: `schedule:${rateCode}`,
    rate_code: rateCode,
    unit_type: 'cubic yard',
    rate_amount: rate,
    material_type: 'vegetative debris',
    description: `Schedule line ${rateCode}`,
    raw_value: {
      rate_code: rateCode,
      rate_amount: rate,
      description: `Schedule line ${rateCode}`,
      source_page: 8,
    },
  };
}

function buildInput(params?: {
  invoiceRows?: Array<Record<string, unknown>>;
  invoiceLines?: Array<Record<string, unknown>>;
  rateScheduleItems?: RateScheduleItem[];
}): ProjectValidatorInput {
  const project: ValidatorProjectRow = {
    id: 'project-1',
    organization_id: 'org-1',
    name: 'Williamson project',
    code: 'WIL-1',
  };

  const invoiceRows = (params?.invoiceRows ?? []) as Array<Record<string, unknown>>;
  const invoiceLines = (params?.invoiceLines ?? []) as Array<Record<string, unknown>>;
  const derivedInvoiceDocumentIds = Array.from(new Set([
    ...invoiceRows
      .map((row) => String(row.source_document_id ?? row.document_id ?? ''))
      .filter((value) => value.length > 0),
    ...invoiceLines
      .map((row) => String(row.source_document_id ?? row.document_id ?? ''))
      .filter((value) => value.length > 0),
  ]));
  const invoiceDocumentIds = derivedInvoiceDocumentIds.length > 0
    ? derivedInvoiceDocumentIds
    : [...INVOICE_DOCUMENT_IDS];

  const familyDocumentIds: ValidatorDocumentIdsByFamily = {
    contract: [CONTRACT_DOCUMENT_ID],
    rate_sheet: [],
    permit: [],
    invoice: invoiceDocumentIds,
    ticket_support: [],
  };

  const contractFacts = [
    makeFactRecord(CONTRACT_DOCUMENT_ID, 'contractor_name', 'Aftermath Disaster Recovery, Inc.'),
    makeFactRecord(CONTRACT_DOCUMENT_ID, 'owner_name', 'Williamson County, Tennessee'),
    makeFactRecord(CONTRACT_DOCUMENT_ID, 'effective_date', '2026-02-09'),
    makeFactRecord(CONTRACT_DOCUMENT_ID, 'expiration_date', '2026-05-10'),
    makeFactRecord(CONTRACT_DOCUMENT_ID, 'contract_ceiling_type', 'rate_based'),
    makeFactRecord(CONTRACT_DOCUMENT_ID, 'rate_schedule_present', true),
    makeFactRecord(CONTRACT_DOCUMENT_ID, 'rate_row_count', 46),
    makeFactRecord(CONTRACT_DOCUMENT_ID, 'rate_schedule_pages', 'pages 8-11'),
    makeFactRecord(
      CONTRACT_DOCUMENT_ID,
      'rate_table',
      (params?.rateScheduleItems ?? []).map((item) => item.raw_value),
    ),
  ];

  const rateScheduleItems = params?.rateScheduleItems ?? [];
  const factsByDocumentId = new Map<string, ValidatorFactRecord[]>([
    [CONTRACT_DOCUMENT_ID, contractFacts],
  ]);
  for (const documentId of invoiceDocumentIds) {
    const invoiceNumber = invoiceRows.find((row) => row.source_document_id === documentId)?.invoice_number
      ?? invoiceLines.find((row) => row.source_document_id === documentId)?.invoice_number
      ?? documentId;
    factsByDocumentId.set(documentId, [
      makeFactRecord(documentId, 'invoice_number', invoiceNumber),
      makeFactRecord(documentId, 'contractor_name', 'Aftermath Disaster Recovery, Inc.'),
    ]);
  }

  const billedTotal = invoiceLines.reduce((sum, row) => sum + (Number(row.line_total ?? 0) || 0), 0);

  const factLookups: ValidatorFactLookups = {
    contractProjectCodeFacts: [],
    invoiceProjectCodeFacts: [],
    contractPartyNameFacts: [contractFacts[0]!],
    nteFact: null,
    contractDocumentId: CONTRACT_DOCUMENT_ID,
    contractCeilingTypeFact: contractFacts[4] ?? null,
    contractCeilingType: 'rate_based',
    rateSchedulePresentFact: contractFacts[5] ?? null,
    rateSchedulePresent: true,
    rateRowCountFact: contractFacts[6] ?? null,
    rateRowCount: 46,
    rateSchedulePagesFact: contractFacts[7] ?? null,
    rateSchedulePagesDisplay: 'pages 8-11',
    rateUnitsDetectedFact: null,
    rateUnitsDetected: [],
    timeAndMaterialsPresentFact: null,
    timeAndMaterialsPresent: false,
    rateScheduleFacts: [contractFacts[8]!],
    rateScheduleItems,
    hasRateScheduleFacts: true,
  };

  const projectTotals: ProjectTotals = {
    billed_total: billedTotal,
    invoice_count: invoiceRows.length,
    invoice_line_count: invoiceLines.length,
    mobile_ticket_count: 0,
    load_ticket_count: 0,
  };

  const invoiceLineToRateMap = new Map<string, RateScheduleItem | null>();
  for (const line of invoiceLines) {
    const lineId = String(line.id ?? line.invoice_line_id ?? line.line_id);
    const rateCode = String(line.rate_code ?? line.contract_rate_code ?? '').trim().toUpperCase();
    invoiceLineToRateMap.set(
      lineId,
      rateScheduleItems.find((item) => item.rate_code === rateCode) ?? null,
    );
  }

  return {
    project,
    documents: [],
    documentRelationships: [],
    precedenceFamilies: [],
    familyDocumentIds,
    governingDocumentIds: familyDocumentIds,
    ruleStateByRuleId: new Map(),
    factsByDocumentId,
    allFacts: [...factsByDocumentId.values()].flat(),
    mobileTickets: [],
    loadTickets: [],
    invoices: invoiceRows,
    invoiceLines,
    mobileToLoadsMap: new Map(),
    invoiceLineToRateMap,
    projectTotals,
    factLookups,
    contractValidationContext: null,
  };
}

describe('contract invoice reconciliation validator', () => {
  it('reconciles Williamson invoices 2026-002 and 2026-003 against the governing contract schedule', () => {
    const rateScheduleItems = [
      makeRateItem('1A', 6.9),
      makeRateItem('1B', 7.9),
      makeRateItem('1E', 13.5),
      makeRateItem('1F', 14.5),
      makeRateItem('5A', 95),
      makeRateItem('6A', 80),
      makeRateItem('2A', 1.5),
      makeRateItem('2B', 2.25),
      makeRateItem('3B', 3.75),
      makeRateItem('3C', 4.25),
    ];

    const invoiceRows = [
      {
        id: 'invoice-row-002',
        source_document_id: INVOICE_DOCUMENT_IDS[0],
        invoice_number: '2026-002',
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
        client_name: 'Williamson County, Tennessee',
        period_start: '2026-02-23',
        period_end: '2026-03-18',
        total_amount: 534_757.1,
      },
      {
        id: 'invoice-row-003',
        source_document_id: INVOICE_DOCUMENT_IDS[1],
        invoice_number: '2026-003',
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
        client_name: 'Williamson County, Tennessee',
        period_start: '2026-02-23',
        period_end: '2026-03-22',
        total_amount: 280_802.25,
      },
    ];

    const invoiceLines = [
      { id: 'line-002-1A', source_document_id: INVOICE_DOCUMENT_IDS[0], invoice_id: 'invoice-row-002', invoice_number: '2026-002', rate_code: '1A', unit_price: 6.9, line_total: 302_868.6 },
      { id: 'line-002-1B', source_document_id: INVOICE_DOCUMENT_IDS[0], invoice_id: 'invoice-row-002', invoice_number: '2026-002', rate_code: '1B', unit_price: 7.9, line_total: 96_775 },
      { id: 'line-002-1E', source_document_id: INVOICE_DOCUMENT_IDS[0], invoice_id: 'invoice-row-002', invoice_number: '2026-002', rate_code: '1E', unit_price: 13.5, line_total: 41_836.5 },
      { id: 'line-002-1F', source_document_id: INVOICE_DOCUMENT_IDS[0], invoice_id: 'invoice-row-002', invoice_number: '2026-002', rate_code: '1F', unit_price: 14.5, line_total: 13_282 },
      { id: 'line-002-5A', source_document_id: INVOICE_DOCUMENT_IDS[0], invoice_id: 'invoice-row-002', invoice_number: '2026-002', rate_code: '5A', unit_price: 95, line_total: 475 },
      { id: 'line-002-6A', source_document_id: INVOICE_DOCUMENT_IDS[0], invoice_id: 'invoice-row-002', invoice_number: '2026-002', rate_code: '6A', unit_price: 80, line_total: 79_520 },
      { id: 'line-003-2A', source_document_id: INVOICE_DOCUMENT_IDS[1], invoice_id: 'invoice-row-003', invoice_number: '2026-003', rate_code: '2A', unit_price: 1.5, line_total: 105_744 },
      { id: 'line-003-2B', source_document_id: INVOICE_DOCUMENT_IDS[1], invoice_id: 'invoice-row-003', invoice_number: '2026-003', rate_code: '2B', unit_price: 2.25, line_total: 158_616 },
      { id: 'line-003-3B', source_document_id: INVOICE_DOCUMENT_IDS[1], invoice_id: 'invoice-row-003', invoice_number: '2026-003', rate_code: '3B', unit_price: 3.75, line_total: 8_040 },
      { id: 'line-003-3C', source_document_id: INVOICE_DOCUMENT_IDS[1], invoice_id: 'invoice-row-003', invoice_number: '2026-003', rate_code: '3C', unit_price: 4.25, line_total: 8_402.25 },
    ];

    const input = buildInput({
      rateScheduleItems,
      invoiceRows,
      invoiceLines,
    });

    const result = evaluateContractInvoiceReconciliation(input);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.summary, {
      matched_invoice_lines: 10,
      unmatched_invoice_lines: 0,
      rate_mismatches: 0,
      vendor_identity_status: 'MATCH',
      client_identity_status: 'MATCH',
      service_period_status: 'MATCH',
      invoice_total_status: 'MATCH',
    });

    const summary = buildValidationSummary([], 'VALIDATED', {
      contractInvoiceReconciliation: result.summary,
    });
    assert.equal(summary.validator_status, 'READY');
    assert.equal(summary.contract_invoice_reconciliation?.matched_invoice_lines, 10);
  });

  it('flags invoice line codes that are not found in the governing contract schedule', () => {
    const input = buildInput({
      rateScheduleItems: [makeRateItem('1A', 125)],
      invoiceRows: [{
        id: 'invoice-row-002',
        source_document_id: INVOICE_DOCUMENT_IDS[0],
        invoice_number: '2026-002',
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
        client_name: 'Williamson County, Tennessee',
        period_start: '2026-03-01',
        period_end: '2026-03-07',
        total_amount: 125,
      }],
      invoiceLines: [{
        id: 'line-002-9Z',
        source_document_id: INVOICE_DOCUMENT_IDS[0],
        invoice_id: 'invoice-row-002',
        invoice_number: '2026-002',
        rate_code: '9Z',
        unit_price: 125,
        line_total: 125,
      }],
    });

    const result = evaluateContractInvoiceReconciliation(input);
    assert.equal(result.summary.matched_invoice_lines, 0);
    assert.equal(result.summary.unmatched_invoice_lines, 1);
    assert.equal(result.findings[0]?.rule_id, 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT');
    assert.equal(
      result.findings[0]?.evidence.some((evidence) => evidence.evidence_type === 'rate_schedule'),
      true,
    );
  });

  it('flags invoice unit prices that do not match the governing contract rate', () => {
    const input = buildInput({
      rateScheduleItems: [makeRateItem('1A', 125)],
      invoiceRows: [{
        id: 'invoice-row-002',
        source_document_id: INVOICE_DOCUMENT_IDS[0],
        invoice_number: '2026-002',
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
        client_name: 'Williamson County, Tennessee',
        period_start: '2026-03-01',
        period_end: '2026-03-07',
        total_amount: 130,
      }],
      invoiceLines: [{
        id: 'line-002-1A',
        source_document_id: INVOICE_DOCUMENT_IDS[0],
        invoice_id: 'invoice-row-002',
        invoice_number: '2026-002',
        rate_code: '1A',
        unit_price: 130,
        line_total: 130,
      }],
    });

    const result = evaluateContractInvoiceReconciliation(input);
    assert.equal(result.summary.matched_invoice_lines, 1);
    assert.equal(result.summary.rate_mismatches, 1);
    assert.equal(
      result.findings.some((finding) => finding.rule_id === 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE'),
      true,
    );
  });

  it('flags invoice-level vendor, client, service period, and total reconciliation issues deterministically', () => {
    const input = buildInput({
      rateScheduleItems: [makeRateItem('1A', 125)],
      invoiceRows: [{
        id: 'invoice-row-002',
        source_document_id: INVOICE_DOCUMENT_IDS[0],
        invoice_number: '2026-002',
        vendor_name: 'Other Debris LLC',
        period_start: '2026-06-01',
        period_end: '2026-06-05',
        total_amount: 200,
      }],
      invoiceLines: [{
        id: 'line-002-1A',
        source_document_id: INVOICE_DOCUMENT_IDS[0],
        invoice_id: 'invoice-row-002',
        invoice_number: '2026-002',
        rate_code: '1A',
        unit_price: 125,
        line_total: 125,
      }],
    });

    const result = evaluateContractInvoiceReconciliation(input);
    const ruleIds = result.findings.map((finding) => finding.rule_id);

    assert.deepEqual(ruleIds, [
      'FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR',
      'FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON',
      'FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM',
      'FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS',
    ]);
    assert.deepEqual(result.summary, {
      matched_invoice_lines: 1,
      unmatched_invoice_lines: 0,
      rate_mismatches: 0,
      vendor_identity_status: 'MISMATCH',
      client_identity_status: 'MISSING',
      service_period_status: 'MISMATCH',
      invoice_total_status: 'MISMATCH',
    });
  });
});
