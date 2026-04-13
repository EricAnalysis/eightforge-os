import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  deriveBillingKeysForTransactionRecord,
  normalizeRateCode,
} from '@/lib/validator/billingKeys';
import { evaluateInvoiceTransactionReconciliation } from '@/lib/validator/rulePacks/invoiceTransactionReconciliation';
import {
  buildValidationSummary,
  type ProjectTotals,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type ValidatorDocumentIdsByFamily,
  type ValidatorFactLookups,
  type ValidatorProjectRow,
  type ValidatorTransactionDataRow,
  type ValidatorTransactionRollups,
} from '@/lib/validator/shared';

const TEST_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const PROJECT_ID = 'project-1';
const CONTRACT_DOCUMENT_ID = 'contract-1';

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

function makeTransactionRow(params: {
  id: string;
  invoiceNumber?: string | null;
  transactionNumber?: string | null;
  rateCode?: string | null;
  quantity?: number | null;
  rate?: number | null;
  cost?: number | null;
  material?: string | null;
  serviceItem?: string | null;
  siteType?: string | null;
  sourceRowNumber: number;
}): ValidatorTransactionDataRow {
  const keys = deriveBillingKeysForTransactionRecord({
    invoice_number: params.invoiceNumber ?? null,
    rate_code: params.rateCode ?? null,
    rate_description: null,
    service_item: params.serviceItem ?? null,
    material: params.material ?? null,
    site_type: params.siteType ?? null,
  });

  const record_json = {
    id: params.id,
    invoice_number: params.invoiceNumber ?? null,
    transaction_number: params.transactionNumber ?? params.id,
    rate_code: params.rateCode ?? null,
    transaction_quantity: params.quantity ?? null,
    transaction_rate: params.rate ?? null,
    extended_cost: params.cost ?? null,
    material: params.material ?? null,
    service_item: params.serviceItem ?? null,
    billing_rate_key: keys.billing_rate_key,
    invoice_rate_key: keys.invoice_rate_key,
    site_material_key: keys.site_material_key,
  };

  return {
    id: params.id,
    document_id: 'transaction-doc-1',
    project_id: PROJECT_ID,
    invoice_number: params.invoiceNumber ?? null,
    transaction_number: params.transactionNumber ?? params.id,
    rate_code: params.rateCode ?? null,
    billing_rate_key: keys.billing_rate_key,
    site_material_key: keys.site_material_key,
    transaction_quantity: params.quantity ?? null,
    extended_cost: params.cost ?? null,
    invoice_date: '2026-03-15',
    source_sheet_name: 'Transactions',
    source_row_number: params.sourceRowNumber,
    record_json,
    raw_row_json: params.siteType ? { 'Site Type': params.siteType } : {},
    created_at: TEST_TIMESTAMP,
  };
}

function buildInput(params?: {
  invoiceRows?: Array<Record<string, unknown>>;
  invoiceLines?: Array<Record<string, unknown>>;
  transactionRows?: ValidatorTransactionDataRow[];
  rateScheduleItems?: RateScheduleItem[];
  transactionRollups?: ValidatorTransactionRollups;
}): ProjectValidatorInput {
  const project: ValidatorProjectRow = {
    id: PROJECT_ID,
    organization_id: 'org-1',
    name: 'Williamson project',
    code: 'WIL-1',
  };

  const invoiceRows = (params?.invoiceRows ?? []) as Array<Record<string, unknown>>;
  const invoiceLines = (params?.invoiceLines ?? []) as Array<Record<string, unknown>>;
  const rateScheduleItems = params?.rateScheduleItems ?? [];
  const transactionRows = params?.transactionRows ?? [];

  const familyDocumentIds: ValidatorDocumentIdsByFamily = {
    contract: [CONTRACT_DOCUMENT_ID],
    rate_sheet: [],
    permit: [],
    invoice: Array.from(new Set(
      invoiceRows
        .map((row) => String(row.source_document_id ?? row.document_id ?? ''))
        .filter((value) => value.length > 0),
    )),
    ticket_support: [],
  };

  const factLookups: ValidatorFactLookups = {
    contractProjectCodeFacts: [],
    invoiceProjectCodeFacts: [],
    contractPartyNameFacts: [],
    nteFact: null,
    contractDocumentId: CONTRACT_DOCUMENT_ID,
    contractCeilingTypeFact: null,
    contractCeilingType: 'rate_based',
    rateSchedulePresentFact: null,
    rateSchedulePresent: rateScheduleItems.length > 0,
    rateRowCountFact: null,
    rateRowCount: rateScheduleItems.length,
    rateSchedulePagesFact: null,
    rateSchedulePagesDisplay: 'pages 8-11',
    rateUnitsDetectedFact: null,
    rateUnitsDetected: ['cubic yard'],
    timeAndMaterialsPresentFact: null,
    timeAndMaterialsPresent: false,
    rateScheduleFacts: [],
    rateScheduleItems,
    hasRateScheduleFacts: rateScheduleItems.length > 0,
  };

  const projectTotals: ProjectTotals = {
    billed_total: invoiceLines.reduce((sum, row) => sum + (Number(row.line_total ?? 0) || 0), 0),
    invoice_count: invoiceRows.length,
    invoice_line_count: invoiceLines.length,
    mobile_ticket_count: 0,
    load_ticket_count: 0,
  };

  const invoiceLineToRateMap = new Map<string, RateScheduleItem | null>();
  for (const line of invoiceLines) {
    const lineId = String(line.id ?? line.invoice_line_id ?? line.line_id ?? '');
    const rateCode = normalizeRateCode(String(line.rate_code ?? line.contract_rate_code ?? ''));
    invoiceLineToRateMap.set(
      lineId,
      rateScheduleItems.find((item) => normalizeRateCode(item.rate_code) === rateCode) ?? null,
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
    factsByDocumentId: new Map(),
    allFacts: [],
    mobileTickets: [],
    loadTickets: [],
    invoices: invoiceRows,
    invoiceLines,
    mobileToLoadsMap: new Map(),
    invoiceLineToRateMap,
    projectTotals,
    factLookups,
    contractValidationContext: null,
    transactionData: {
      datasets: [],
      rows: transactionRows,
      rollups: params?.transactionRollups ?? {
        grouped_by_rate_code: [],
        grouped_by_invoice: [],
        grouped_by_site_material: [],
      },
    },
  };
}

describe('invoice transaction reconciliation validator', () => {
  it('reconciles grouped invoice lines against persisted transaction rows', () => {
    const input = buildInput({
      invoiceRows: [
        {
          id: 'invoice-row-100',
          source_document_id: 'invoice-doc-100',
          invoice_number: 'INV-100',
        },
      ],
      invoiceLines: [
        {
          id: 'line-100-1',
          source_document_id: 'invoice-doc-100',
          invoice_id: 'invoice-row-100',
          invoice_number: 'INV-100',
          rate_code: 'RC-01',
          quantity: 10,
          unit_price: 25,
          line_total: 250,
        },
        {
          id: 'line-100-2',
          source_document_id: 'invoice-doc-100',
          invoice_id: 'invoice-row-100',
          invoice_number: 'INV-100',
          rate_code: 'RC-02',
          quantity: 5,
          unit_price: 40,
          line_total: 200,
        },
      ],
      transactionRows: [
        makeTransactionRow({
          id: 'tx-1',
          invoiceNumber: 'INV-100',
          transactionNumber: 'TX-1',
          rateCode: 'RC-01',
          quantity: 4,
          rate: 25,
          cost: 100,
          material: 'Vegetative',
          siteType: 'Landfill',
          sourceRowNumber: 2,
        }),
        makeTransactionRow({
          id: 'tx-2',
          invoiceNumber: 'INV-100',
          transactionNumber: 'TX-2',
          rateCode: 'RC-01',
          quantity: 6,
          rate: 25,
          cost: 150,
          material: 'Vegetative',
          siteType: 'Landfill',
          sourceRowNumber: 3,
        }),
        makeTransactionRow({
          id: 'tx-3',
          invoiceNumber: 'INV-100',
          transactionNumber: 'TX-3',
          rateCode: 'RC-02',
          quantity: 5,
          rate: 40,
          cost: 200,
          material: 'Vegetative',
          siteType: 'Landfill',
          sourceRowNumber: 4,
        }),
      ],
      rateScheduleItems: [
        makeRateItem('RC-01', 25),
        makeRateItem('RC-02', 40),
      ],
      transactionRollups: {
        grouped_by_rate_code: [
          {
            billing_rate_key: 'RC01',
            rate_code: 'RC01',
            rate_description_sample: null,
            row_count: 2,
            total_transaction_quantity: 10,
            total_extended_cost: 250,
            distinct_invoice_numbers: ['INV-100'],
            distinct_materials: ['Vegetative'],
            distinct_service_items: [],
          },
          {
            billing_rate_key: 'RC02',
            rate_code: 'RC02',
            rate_description_sample: null,
            row_count: 1,
            total_transaction_quantity: 5,
            total_extended_cost: 200,
            distinct_invoice_numbers: ['INV-100'],
            distinct_materials: ['Vegetative'],
            distinct_service_items: [],
          },
        ],
        grouped_by_invoice: [
          {
            invoice_number: 'INV-100',
            row_count: 3,
            total_transaction_quantity: 15,
            total_extended_cost: 450,
            distinct_rate_codes: ['RC01', 'RC02'],
            distinct_materials: ['Vegetative'],
            distinct_service_items: [],
          },
        ],
        grouped_by_site_material: [
          {
            site_material_key: 's:landfill|m:vegetative',
            disposal_site: null,
            disposal_site_type: 'Landfill',
            material: 'Vegetative',
            row_count: 3,
            total_transaction_quantity: 15,
            total_extended_cost: 450,
            distinct_rate_codes: ['RC01', 'RC02'],
            distinct_invoice_numbers: ['INV-100'],
          },
        ],
      },
    });

    const result = evaluateInvoiceTransactionReconciliation(input);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.summary, {
      matched_groups: 2,
      unmatched_groups: 0,
      cost_mismatches: 0,
      quantity_mismatches: 0,
      orphan_transactions: 0,
      outlier_rows: 0,
    });

    const summary = buildValidationSummary([], 'VALIDATED', {
      invoiceTransactionReconciliation: result.summary,
    });
    assert.equal(summary.invoice_transaction_reconciliation?.matched_groups, 2);
  });

  it('flags missing groups, mismatches, outliers, missing invoice links, and site/material anomalies with invoice and transaction evidence', () => {
    const input = buildInput({
      invoiceRows: [
        {
          id: 'invoice-row-100',
          source_document_id: 'invoice-doc-100',
          invoice_number: 'INV-100',
        },
      ],
      invoiceLines: [
        {
          id: 'line-100-1',
          source_document_id: 'invoice-doc-100',
          invoice_id: 'invoice-row-100',
          invoice_number: 'INV-100',
          rate_code: 'RC-01',
          quantity: 10,
          unit_price: 25,
          line_total: 250,
        },
        {
          id: 'line-100-2',
          source_document_id: 'invoice-doc-100',
          invoice_id: 'invoice-row-100',
          invoice_number: 'INV-100',
          rate_code: 'RC-02',
          quantity: 4,
          unit_price: 50,
          line_total: 200,
        },
      ],
      transactionRows: [
        makeTransactionRow({
          id: 'tx-1',
          invoiceNumber: 'INV-100',
          transactionNumber: 'TX-1',
          rateCode: 'RC-01',
          quantity: 4,
          rate: 40,
          cost: 100,
          material: 'Vegetative',
          siteType: 'Landfill',
          sourceRowNumber: 2,
        }),
        makeTransactionRow({
          id: 'tx-2',
          invoiceNumber: 'INV-100',
          transactionNumber: 'TX-2',
          rateCode: 'RC-01',
          quantity: 5,
          rate: 20,
          cost: 140,
          material: 'Vegetative',
          siteType: 'Staging',
          sourceRowNumber: 3,
        }),
        makeTransactionRow({
          id: 'tx-3',
          invoiceNumber: null,
          transactionNumber: 'TX-3',
          rateCode: 'RC-03',
          quantity: 3,
          rate: 30,
          cost: 90,
          material: 'Vegetative',
          siteType: 'Landfill',
          sourceRowNumber: 4,
        }),
      ],
      rateScheduleItems: [
        makeRateItem('RC-01', 25),
        makeRateItem('RC-02', 50),
      ],
      transactionRollups: {
        grouped_by_rate_code: [
          {
            billing_rate_key: 'RC01',
            rate_code: 'RC01',
            rate_description_sample: null,
            row_count: 2,
            total_transaction_quantity: 9,
            total_extended_cost: 240,
            distinct_invoice_numbers: ['INV-100'],
            distinct_materials: ['Vegetative'],
            distinct_service_items: [],
          },
        ],
        grouped_by_invoice: [
          {
            invoice_number: 'INV-100',
            row_count: 2,
            total_transaction_quantity: 9,
            total_extended_cost: 240,
            distinct_rate_codes: ['RC01'],
            distinct_materials: ['Vegetative'],
            distinct_service_items: [],
          },
        ],
        grouped_by_site_material: [
          {
            site_material_key: 's:landfill|m:vegetative',
            disposal_site: null,
            disposal_site_type: 'Landfill',
            material: 'Vegetative',
            row_count: 2,
            total_transaction_quantity: 7,
            total_extended_cost: 190,
            distinct_rate_codes: ['RC01'],
            distinct_invoice_numbers: ['INV-100'],
          },
          {
            site_material_key: 's:staging|m:vegetative',
            disposal_site: null,
            disposal_site_type: 'Staging',
            material: 'Vegetative',
            row_count: 1,
            total_transaction_quantity: 5,
            total_extended_cost: 140,
            distinct_rate_codes: ['RC01'],
            distinct_invoice_numbers: ['INV-100'],
          },
        ],
      },
    });

    const result = evaluateInvoiceTransactionReconciliation(input);
    assert.deepEqual(result.summary, {
      matched_groups: 1,
      unmatched_groups: 1,
      cost_mismatches: 1,
      quantity_mismatches: 1,
      orphan_transactions: 1,
      outlier_rows: 2,
    });

    const findingIds = result.findings.map((finding) => finding.rule_id);
    assert.ok(findingIds.includes('TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE'));
    assert.ok(findingIds.includes('TRANSACTION_TOTAL_MATCHES_INVOICE_LINE'));
    assert.ok(findingIds.includes('TRANSACTION_QUANTITY_MATCHES_INVOICE'));
    assert.ok(findingIds.includes('TRANSACTION_RATE_OUTLIERS'));
    assert.ok(findingIds.includes('TRANSACTION_MISSING_INVOICE_LINK'));
    assert.ok(findingIds.includes('SITE_MATERIAL_ANOMALIES'));

    for (const finding of result.findings) {
      assert.equal(
        finding.evidence.some((evidence) => evidence.evidence_type === 'invoice_line'),
        true,
        `finding ${finding.rule_id} should include invoice evidence`,
      );
      assert.equal(
        finding.evidence.some((evidence) => evidence.evidence_type === 'transaction_row'),
        true,
        `finding ${finding.rule_id} should include transaction row references`,
      );
      assert.equal(
        finding.evidence.some((evidence) => evidence.evidence_type === 'grouping_key'),
        true,
        `finding ${finding.rule_id} should include grouping key evidence`,
      );
    }

    const costMismatchFinding = result.findings.find(
      (finding) => finding.rule_id === 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE',
    );
    assert.equal(
      costMismatchFinding?.evidence.some((evidence) => evidence.evidence_type === 'rate_schedule'),
      true,
    );
    assert.equal(
      costMismatchFinding?.evidence.some((evidence) => evidence.evidence_type === 'transaction_group'),
      true,
    );
  });

  it('flags invoice lines that cannot derive a billing key', () => {
    const input = buildInput({
      invoiceRows: [
        {
          id: 'invoice-row-200',
          source_document_id: 'invoice-doc-200',
          invoice_number: 'INV-200',
        },
      ],
      invoiceLines: [
        {
          id: 'line-200-1',
          source_document_id: 'invoice-doc-200',
          invoice_id: 'invoice-row-200',
          invoice_number: 'INV-200',
          description: '',
          unit_price: 125,
          line_total: 250,
        },
      ],
      transactionRows: [],
      rateScheduleItems: [],
    });

    const result = evaluateInvoiceTransactionReconciliation(input);
    const finding = result.findings.find((entry) => entry.rule_id === 'INVOICE_LINE_REQUIRES_BILLING_KEY');

    assert.ok(finding, 'missing billing key finding should be emitted');
    assert.equal(finding?.severity, 'critical');
    assert.equal(finding?.expected, 'resolved billing key');
    assert.equal(finding?.actual, 'missing');
    assert.equal(finding?.variance, 250);
  });

  it('flags duplicate billed lines when the same line repeats on an invoice', () => {
    const input = buildInput({
      invoiceRows: [
        {
          id: 'invoice-row-300',
          source_document_id: 'invoice-doc-300',
          invoice_number: 'INV-300',
        },
      ],
      invoiceLines: [
        {
          id: 'line-300-1',
          source_document_id: 'invoice-doc-300',
          invoice_id: 'invoice-row-300',
          invoice_number: 'INV-300',
          rate_code: '6A',
          description: 'Load and haul debris',
          quantity: 2,
          unit_price: 80,
          line_total: 160,
        },
        {
          id: 'line-300-2',
          source_document_id: 'invoice-doc-300',
          invoice_id: 'invoice-row-300',
          invoice_number: 'INV-300',
          rate_code: '6A',
          description: 'Load and haul debris',
          quantity: 2,
          unit_price: 80,
          line_total: 160,
        },
      ],
      transactionRows: [],
      rateScheduleItems: [makeRateItem('6A', 80)],
    });

    const result = evaluateInvoiceTransactionReconciliation(input);
    const finding = result.findings.find((entry) => entry.rule_id === 'INVOICE_DUPLICATE_BILLED_LINE');

    assert.ok(finding, 'duplicate billed line finding should be emitted');
    assert.equal(finding?.severity, 'critical');
    assert.equal(finding?.expected, '1 billed line');
    assert.equal(finding?.actual, '2 billed lines');
    assert.equal(finding?.variance, 160);
  });
});
