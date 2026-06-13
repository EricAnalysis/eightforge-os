import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { deriveBillingKeysForTransactionRecord } from '@/lib/validator/billingKeys';
import { evaluateProjectExposure } from '@/lib/validator/exposure';
import {
  buildValidationSummary,
  makeFinding,
  type ProjectTotals,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type ValidatorDocumentIdsByFamily,
  type ValidatorFactLookups,
  type ValidatorProjectRow,
  type ValidatorTransactionDataRow,
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
  rateCode?: string | null;
  quantity?: number | null;
  cost?: number | null;
  material?: string | null;
  serviceItem?: string | null;
}): ValidatorTransactionDataRow {
  const keys = deriveBillingKeysForTransactionRecord({
    invoice_number: params.invoiceNumber ?? null,
    rate_code: params.rateCode ?? null,
    rate_description: null,
    service_item: params.serviceItem ?? null,
    material: params.material ?? null,
    site_type: null,
  });

  return {
    id: params.id,
    document_id: 'transaction-doc-1',
    project_id: PROJECT_ID,
    invoice_number: params.invoiceNumber ?? null,
    transaction_number: params.id,
    rate_code: params.rateCode ?? null,
    billing_rate_key: keys.billing_rate_key,
    site_material_key: keys.site_material_key,
    transaction_quantity: params.quantity ?? null,
    extended_cost: params.cost ?? null,
    invoice_date: '2026-03-15',
    source_sheet_name: 'Transactions',
    source_row_number: 2,
    record_json: {
      id: params.id,
      invoice_number: params.invoiceNumber ?? null,
      transaction_number: params.id,
      rate_code: params.rateCode ?? null,
      transaction_quantity: params.quantity ?? null,
      extended_cost: params.cost ?? null,
      material: params.material ?? null,
      service_item: params.serviceItem ?? null,
      billing_rate_key: keys.billing_rate_key,
      invoice_rate_key: keys.invoice_rate_key,
      site_material_key: keys.site_material_key,
    },
    raw_row_json: {},
    created_at: TEST_TIMESTAMP,
  };
}

function buildInput(params?: {
  invoiceRows?: Array<Record<string, unknown>>;
  invoiceLines?: Array<Record<string, unknown>>;
  transactionRows?: ValidatorTransactionDataRow[];
  rateScheduleItems?: RateScheduleItem[];
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
      rollups: {
        grouped_by_rate_code: [],
        grouped_by_invoice: [],
        grouped_by_site_material: [],
      },
    },
    reconciliationContext: null,
  };
}

describe('project exposure math', () => {
  it('computes project and invoice exposure totals and emits exposure findings', () => {
    const input = buildInput({
      invoiceRows: [
        {
          id: 'invoice-row-100',
          source_document_id: 'invoice-doc-100',
          invoice_number: 'INV-100',
          total_amount: 250,
        },
        {
          id: 'invoice-row-200',
          source_document_id: 'invoice-doc-200',
          invoice_number: 'INV-200',
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
          id: 'line-200-1',
          source_document_id: 'invoice-doc-200',
          invoice_id: 'invoice-row-200',
          invoice_number: 'INV-200',
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
          rateCode: 'RC-01',
          quantity: 10,
          cost: 250,
        }),
      ],
      rateScheduleItems: [
        makeRateItem('RC-01', 25),
      ],
    });

    const priorFindings = [
      makeFinding({
        projectId: PROJECT_ID,
        ruleId: 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
        category: 'financial_integrity',
        severity: 'critical',
        subjectType: 'invoice_line',
        subjectId: 'line-200-1',
        field: 'rate_code',
        expected: 'governing contract schedule code',
        actual: 'RC-02',
      }),
    ];

    const result = evaluateProjectExposure(input, priorFindings);
    assert.deepEqual(result.summary, {
      total_billed_amount: 450,
      total_contract_supported_amount: 250,
      total_transaction_supported_amount: 250,
      total_fully_reconciled_amount: 250,
      total_unreconciled_amount: 200,
      total_at_risk_amount: 200,
      total_requires_verification_amount: 200,
      support_gap_tolerance_amount: 0.01,
      at_risk_tolerance_amount: 0.01,
      moderate_severity: 'warning',
      invoices: [
        {
          invoice_number: 'INV-100',
          billed_amount: 250,
          billed_amount_source: 'invoice_total',
          contract_supported_amount: 250,
          transaction_supported_amount: 250,
          fully_reconciled_amount: 250,
          supported_amount: 250,
          unreconciled_amount: 0,
          at_risk_amount: 0,
          requires_verification_amount: 0,
          reconciliation_status: 'MATCH',
        },
        {
          invoice_number: 'INV-200',
          billed_amount: 200,
          billed_amount_source: 'line_total_fallback',
          contract_supported_amount: 0,
          transaction_supported_amount: 0,
          fully_reconciled_amount: 0,
          supported_amount: 0,
          unreconciled_amount: 200,
          at_risk_amount: 200,
          requires_verification_amount: 200,
          reconciliation_status: 'MISMATCH',
        },
      ],
    });

    const ruleIds = result.findings.map((finding) => finding.rule_id);
    assert.ok(ruleIds.includes('INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE'));
    assert.ok(ruleIds.includes('INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED'));
    assert.ok(ruleIds.includes('INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO'));
    assert.ok(ruleIds.includes('PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED'));
    assert.ok(ruleIds.includes('PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO'));

    const summary = buildValidationSummary(priorFindings, 'FINDINGS_OPEN', {
      exposure: result.summary,
    });
    assert.equal(summary.exposure?.total_fully_reconciled_amount, 250);
    assert.equal(summary.exposure?.invoices[1]?.at_risk_amount, 200);
    assert.equal(summary.exposure?.total_requires_verification_amount, 200);
  });
});
