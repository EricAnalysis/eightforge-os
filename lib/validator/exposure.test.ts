import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildCanonicalInvoiceRowsFromTypedFields } from '@/lib/invoices/invoiceParser';
import { evaluateApprovalGate } from '@/lib/validator/approvalGate';
import { deriveBillingKeysForTransactionRecord } from '@/lib/validator/billingKeys';
import { evaluateProjectExposure } from '@/lib/validator/exposure';
import { synthesizeInvoicesFromLegacyExtractions } from '@/lib/validator/projectValidator';
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
import type { ValidatorResult } from '@/types/validator';

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
    contractIdentityDocumentIds: [CONTRACT_DOCUMENT_ID],
    pricingContextDocumentIds: [],
    complianceContextDocumentIds: [],
    amendmentContextDocumentIds: [],
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
  it('keeps exposure and approval identical with persisted or synthesis-only invoice input', () => {
    const documentId = 'invoice-parity-doc';
    const typedFields = {
      schema_type: 'invoice',
      invoice_number: 'INV-PARITY-1',
      invoice_date: '2026-07-01',
      period_start: '2026-06-01',
      period_end: '2026-06-30',
      vendor_name: 'Parity Debris LLC',
      client_name: 'Parity County',
      subtotal_amount: 100.5,
      total_amount: 100.5,
      line_items: [{
        line_code: 'RC-01',
        description: 'Haul debris',
        material: 'vegetative debris',
        service_item: 'hauling',
        quantity: 10,
        unit: 'CYD',
        unit_price: 10.05,
        line_total: 100.5,
      }],
    };
    const canonical = buildCanonicalInvoiceRowsFromTypedFields({
      documentId,
      typedFields,
    });
    assert.ok(canonical.invoiceRow);
    assert.equal(canonical.invoiceLines.length, 1);

    const persistedInvoiceId = 'db-invoice-parity-1';
    const persistedInvoices = [{
      id: persistedInvoiceId,
      project_id: PROJECT_ID,
      source_document_id: documentId,
      document_id: documentId,
      invoice_number: canonical.invoiceRow.invoice_number,
      invoice_status: canonical.invoiceRow.invoice_status,
      invoice_date: canonical.invoiceRow.invoice_date,
      period_start: canonical.invoiceRow.period_start,
      period_end: canonical.invoiceRow.period_end,
      period_through: canonical.invoiceRow.period_through,
      vendor_name: canonical.invoiceRow.vendor_name,
      client_name: canonical.invoiceRow.client_name,
      subtotal_amount: canonical.invoiceRow.subtotal_amount,
      total_amount: canonical.invoiceRow.total_amount,
      billed_amount: canonical.invoiceRow.billed_amount,
      line_item_count: canonical.invoiceRow.line_item_count,
    }];
    const persistedInvoiceLines = canonical.invoiceLines.map((line) => ({
      project_id: PROJECT_ID,
      source_document_id: documentId,
      document_id: documentId,
      invoice_id: persistedInvoiceId,
      invoice_number: line.invoice_number,
      line_code: line.line_code,
      rate_code: line.rate_code,
      description: line.description,
      line_description: line.line_description,
      material: line.material,
      service_item: line.service_item,
      quantity: line.quantity,
      unit: line.unit,
      unit_price: line.unit_price,
      line_total: line.line_total,
      total_amount: line.total_amount,
      billing_rate_key: line.billing_rate_key,
      description_match_key: line.description_match_key,
      invoice_rate_key: line.invoice_rate_key,
      canonical_category: line.canonical_category,
      category_confidence: line.category_confidence,
    }));
    const legacyRowsByDocumentId = new Map([[
      documentId,
      {
        document_id: documentId,
        created_at: TEST_TIMESTAMP,
        data: { fields: { typed_fields: typedFields } },
      },
    ]]);

    const withProjectionSynthesis = synthesizeInvoicesFromLegacyExtractions({
      legacyRowsByDocumentId,
      invoiceDocumentIds: [documentId],
      existingInvoices: persistedInvoices,
      existingInvoiceLines: persistedInvoiceLines,
    });
    const withoutProjectionSynthesis = synthesizeInvoicesFromLegacyExtractions({
      legacyRowsByDocumentId,
      invoiceDocumentIds: [documentId],
      existingInvoices: [],
      existingInvoiceLines: [],
    });
    const withProjection = {
      invoices: [...persistedInvoices, ...withProjectionSynthesis.invoices],
      invoiceLines: [...persistedInvoiceLines, ...withProjectionSynthesis.invoiceLines],
    };
    const synthesisOnly = withoutProjectionSynthesis;

    assert.equal(withProjection.invoices.length, 1);
    assert.equal(withProjection.invoiceLines.length, 1);
    assert.equal(synthesisOnly.invoices.length, 1);
    assert.equal(synthesisOnly.invoiceLines.length, 1);
    assert.equal(withProjection.invoices[0]?.source_document_id, documentId);
    assert.equal(synthesisOnly.invoices[0]?.source_document_id, documentId);

    const projectedAssessment = evaluateProjectExposure(buildInput({
      invoiceRows: withProjection.invoices,
      invoiceLines: withProjection.invoiceLines,
    }), []);
    const synthesizedAssessment = evaluateProjectExposure(buildInput({
      invoiceRows: synthesisOnly.invoices,
      invoiceLines: synthesisOnly.invoiceLines,
    }), []);
    // Assert both summaries exist before comparing: without this the deepEqual below
    // would pass vacuously if both sides were null, and it also narrows the
    // possibly-null summary for the total_billed_amount read.
    assert.ok(projectedAssessment.summary);
    assert.ok(synthesizedAssessment.summary);
    assert.equal(projectedAssessment.summary.total_billed_amount, 100.5);
    assert.deepEqual(projectedAssessment.summary, synthesizedAssessment.summary);

    const approvalFor = (
      assessment: typeof projectedAssessment,
    ) => evaluateApprovalGate({
      status: 'FINDINGS_OPEN',
      blocked_reasons: [],
      findings: assessment.findings,
      summary: buildValidationSummary(assessment.findings, 'FINDINGS_OPEN', {
        exposure: assessment.summary,
      }),
      rulesApplied: [],
      validator_status: 'NEEDS_REVIEW',
      validator_open_items: [],
      validator_blockers: [],
      exposure: assessment.summary,
      reconciliation: null,
    } satisfies ValidatorResult);
    assert.deepEqual(
      approvalFor(projectedAssessment),
      approvalFor(synthesizedAssessment),
    );
  });

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

  it('uses transaction quantities and contract rates to derive supported dollars across split transaction rows', () => {
    const input = buildInput({
      invoiceRows: [
        {
          id: 'invoice-row-300',
          source_document_id: 'invoice-doc-300',
          invoice_number: 'INV-300',
          total_amount: 500,
        },
      ],
      invoiceLines: [
        {
          id: 'line-300-1',
          source_document_id: 'invoice-doc-300',
          invoice_id: 'invoice-row-300',
          invoice_number: 'INV-300',
          rate_code: 'RC-03',
          quantity: 10,
          unit_price: 50,
          line_total: 500,
        },
      ],
      transactionRows: [
        makeTransactionRow({
          id: 'tx-300-1',
          invoiceNumber: 'INV-300',
          rateCode: 'RC-03',
          quantity: 4,
          cost: 200,
        }),
        makeTransactionRow({
          id: 'tx-300-2',
          invoiceNumber: 'INV-300',
          rateCode: 'RC-03',
          quantity: 6,
          cost: 300,
        }),
      ],
      rateScheduleItems: [
        makeRateItem('RC-03', 40),
      ],
    });

    const result = evaluateProjectExposure(input, []);

    assert.deepEqual(result.summary?.invoices, [
      {
        invoice_number: 'INV-300',
        billed_amount: 500,
        billed_amount_source: 'invoice_total',
        contract_supported_amount: 400,
        transaction_supported_amount: 400,
        fully_reconciled_amount: 400,
        supported_amount: 400,
        unreconciled_amount: 100,
        at_risk_amount: 100,
        requires_verification_amount: 100,
        reconciliation_status: 'MISMATCH',
      },
    ]);
    assert.equal(result.summary?.total_contract_supported_amount, 400);
    assert.equal(result.summary?.total_transaction_supported_amount, 400);
    assert.equal(result.summary?.total_fully_reconciled_amount, 400);
    assert.equal(result.summary?.total_unreconciled_amount, 100);
    assert.equal(result.summary?.total_at_risk_amount, 100);
  });

  it('does not put fully supported invoice dollars at risk solely because warning findings exist', () => {
    const input = buildInput({
      invoiceRows: [
        {
          id: 'invoice-row-400',
          source_document_id: 'invoice-doc-400',
          invoice_number: 'INV-400',
          total_amount: 250,
        },
      ],
      invoiceLines: [
        {
          id: 'line-400-1',
          source_document_id: 'invoice-doc-400',
          invoice_id: 'invoice-row-400',
          invoice_number: 'INV-400',
          rate_code: 'RC-04',
          quantity: 10,
          unit_price: 25,
          line_total: 250,
        },
      ],
      transactionRows: [
        makeTransactionRow({
          id: 'tx-400-1',
          invoiceNumber: 'INV-400',
          rateCode: 'RC-04',
          quantity: 10,
          cost: 250,
        }),
      ],
      rateScheduleItems: [
        makeRateItem('RC-04', 25),
      ],
    });

    const warningFindings = [
      makeFinding({
        projectId: PROJECT_ID,
        ruleId: 'FINANCIAL_RATE_CODE_MISSING',
        category: 'financial_integrity',
        severity: 'warning',
        subjectType: 'invoice_line',
        subjectId: 'line-400-1',
        field: 'rate_code',
        expected: 'billing code',
        actual: 'description-derived key',
      }),
      makeFinding({
        projectId: PROJECT_ID,
        ruleId: 'TRANSACTION_MISSING_INVOICE_LINK',
        category: 'financial_integrity',
        severity: 'warning',
        subjectType: 'transaction_group',
        subjectId: 'missing_invoice_number',
        field: 'invoice_number',
        expected: 'linked invoice number',
        actual: '2 rows missing invoice number; total_extended_cost=0',
      }),
    ];

    const result = evaluateProjectExposure(input, warningFindings);

    assert.equal(result.summary?.invoices[0]?.supported_amount, 250);
    assert.equal(result.summary?.invoices[0]?.unreconciled_amount, 0);
    assert.equal(result.summary?.invoices[0]?.at_risk_amount, 0);
    assert.equal(result.summary?.total_at_risk_amount, 0);
    assert.equal(
      result.findings.some((finding) => finding.rule_id === 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO'),
      false,
    );
    assert.equal(
      result.findings.some((finding) => finding.rule_id === 'PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO'),
      false,
    );
  });

  it('treats a manual-link line as contract-supported even when quantity and unit-price are absent', () => {
    // Mirrors invoice 2026-002 line 6 in the Golden Project:
    //   - Line A: normal rate-matched line with explicit qty/unit_price
    //   - Line B: lump-sum line with only a line_total, no qty, no unit_price —
    //             operator manually linked it to a contract rate item
    // Before the Path 3 fix, Line B contributed 0 to contract_supported_amount
    // because Path 1 (needs quantity) and Path 2 (needs contractSupported, which
    // requires unitPrice) both failed despite the manual link being in the map.
    const input = buildInput({
      invoiceRows: [
        {
          id: 'invoice-row-500',
          source_document_id: 'invoice-doc-500',
          invoice_number: 'INV-500',
          total_amount: 534757.1,
        },
      ],
      invoiceLines: [
        {
          id: 'line-500-a',
          source_document_id: 'invoice-doc-500',
          invoice_id: 'invoice-row-500',
          invoice_number: 'INV-500',
          rate_code: 'RC-05',
          quantity: 100,
          unit_price: 4552.371,
          line_total: 455237.1,
        },
        {
          id: 'line-500-b',
          source_document_id: 'invoice-doc-500',
          invoice_id: 'invoice-row-500',
          invoice_number: 'INV-500',
          // No rate_code, no quantity, no unit_price — lump-sum line
          description: 'Mobilization',
          line_total: 79520,
        },
      ],
      transactionRows: [
        makeTransactionRow({
          id: 'tx-500-a',
          invoiceNumber: 'INV-500',
          rateCode: 'RC-05',
          quantity: 100,
          cost: 455237.1,
        }),
        makeTransactionRow({
          id: 'tx-500-b',
          invoiceNumber: 'INV-500',
          rateCode: 'MOBILIZATION',
          cost: 79520,
        }),
      ],
      rateScheduleItems: [makeRateItem('RC-05', 4552.371)],
    });

    // Inject the manual-link override for line-500-b directly into the map —
    // this mirrors what buildManualRateLinkOverrides produces at runtime.
    const manualLinkItem: RateScheduleItem = {
      source_document_id: CONTRACT_DOCUMENT_ID,
      record_id: 'contract-rate-mob-1',
      rate_code: null,
      unit_type: 'lump sum',
      rate_amount: 79520,
      material_type: null,
      description: 'Mobilization',
      raw_value: { source: 'invoice_line_rate_links', link_id: 'link-mob-1' },
      match_source_kind: 'manual_link',
      manual_link_resolution: 'operator_supplied',
      manual_rate_link_id: 'link-mob-1',
      manual_rate_link_invoice_line_subject_id: 'line-500-b',
      manual_rate_link_contract_rate_row_id: 'contract-rate-mob-1',
      manual_rate_link_reason: 'Operator confirmed mobilization line',
      manual_rate_link_created_at: TEST_TIMESTAMP,
    };
    input.invoiceLineToRateMap.set('line-500-b', manualLinkItem);

    const result = evaluateProjectExposure(input, []);

    // Line A: contract-supported via Path 1 (rate_amount * quantity). Capped at 455237.1.
    // Line B: contract-supported via Path 3 (manual_link fallback). Returns line_total = 79520.
    // Combined contract_supported_amount = 534757.1 = full billed amount.
    assert.equal(result.summary?.invoices[0]?.contract_supported_amount, 534757.1);
    assert.equal(result.summary?.invoices[0]?.at_risk_amount, 0);
    assert.equal(result.summary?.invoices[0]?.reconciliation_status, 'MATCH');
    assert.equal(result.summary?.total_at_risk_amount, 0);
    assert.equal(
      result.findings.some((finding) => finding.rule_id === 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO'),
      false,
    );
  });
});
