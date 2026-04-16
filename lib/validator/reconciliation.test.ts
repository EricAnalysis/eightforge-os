import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { deriveBillingKeysForTransactionRecord } from '@/lib/validator/billingKeys';
import {
  buildProjectReconciliationSummary,
  buildValidatorReconciliationContext,
} from '@/lib/validator/reconciliation';
import {
  buildValidationSummary,
  type RateScheduleItem,
  type ValidatorDocumentIdsByFamily,
  type ValidatorFactLookups,
  type ValidatorProjectTransactionData,
  type ValidatorTransactionDataRow,
} from '@/lib/validator/shared';

const TEST_TIMESTAMP = '1970-01-01T00:00:00.000Z';
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
  invoiceNumber: string | null;
  rateCode: string | null;
  quantity: number | null;
  cost: number | null;
  material?: string | null;
  serviceItem?: string | null;
  siteType?: string | null;
}): ValidatorTransactionDataRow {
  const keys = deriveBillingKeysForTransactionRecord({
    invoice_number: params.invoiceNumber,
    rate_code: params.rateCode,
    rate_description: null,
    service_item: params.serviceItem ?? null,
    material: params.material ?? null,
    site_type: params.siteType ?? null,
  });

  return {
    id: params.id,
    document_id: 'transaction-doc-1',
    project_id: 'project-1',
    invoice_number: params.invoiceNumber,
    transaction_number: params.id,
    rate_code: params.rateCode,
    billing_rate_key: keys.billing_rate_key,
    site_material_key: keys.site_material_key,
    transaction_quantity: params.quantity,
    extended_cost: params.cost,
    invoice_date: '2026-03-15',
    source_sheet_name: 'Transactions',
    source_row_number: 2,
    record_json: {
      id: params.id,
      invoice_number: params.invoiceNumber,
      transaction_number: params.id,
      rate_code: params.rateCode,
      transaction_quantity: params.quantity,
      extended_cost: params.cost,
      material: params.material ?? null,
      service_item: params.serviceItem ?? null,
      billing_rate_key: keys.billing_rate_key,
      invoice_rate_key: keys.invoice_rate_key,
      site_material_key: keys.site_material_key,
    },
    raw_row_json: params.siteType ? { 'Site Type': params.siteType } : {},
    created_at: TEST_TIMESTAMP,
  };
}

function makeFactLookups(rateScheduleItems: RateScheduleItem[]): ValidatorFactLookups {
  return {
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
}

describe('validator reconciliation context', () => {
  it('builds source-aware billing groups and a unified project reconciliation summary', () => {
    const rateScheduleItems = [makeRateItem('RC-01', 25)];
    const invoiceLines = [
      {
        id: 'line-1',
        source_document_id: 'invoice-doc-1',
        invoice_number: 'INV-100',
        rate_code: 'RC-01',
        service_item: 'Haul',
        material: 'Vegetative',
        unit_price: 25,
        quantity: 10,
        line_total: 250,
      },
      {
        id: 'line-2',
        source_document_id: 'invoice-doc-1',
        invoice_number: 'INV-100',
        rate_code: 'RC-02',
        service_item: 'Haul',
        material: 'Vegetative',
        unit_price: 30,
        quantity: 2,
        line_total: 60,
      },
    ];
    const transactionRows = [
      makeTransactionRow({
        id: 'tx-1',
        invoiceNumber: 'INV-100',
        rateCode: 'RC-01',
        quantity: 10,
        cost: 250,
        material: 'Vegetative',
        serviceItem: 'Haul',
        siteType: 'Landfill',
      }),
    ];
    const transactionData: ValidatorProjectTransactionData = {
      datasets: [{
        id: 'dataset-1',
        document_id: 'transaction-doc-1',
        project_id: 'project-1',
        row_count: 1,
        total_extended_cost: 250,
        total_transaction_quantity: 10,
        date_range_start: '2026-03-15',
        date_range_end: '2026-03-15',
        summary_json: {
          grouped_by_rate_code: [{
            billing_rate_key: 'RC01',
            rate_code: 'RC01',
            rate_description_sample: null,
            row_count: 1,
            total_transaction_quantity: 10,
            total_extended_cost: 250,
            distinct_invoice_numbers: ['INV-100'],
            distinct_materials: ['Vegetative'],
            distinct_service_items: ['Haul'],
          }],
          grouped_by_invoice: [{
            invoice_number: 'INV-100',
            row_count: 1,
            total_transaction_quantity: 10,
            total_extended_cost: 250,
            distinct_rate_codes: ['RC01'],
            distinct_materials: ['Vegetative'],
            distinct_service_items: ['Haul'],
          }],
          grouped_by_site_material: [{
            site_material_key: 's:landfill|m:vegetative',
            disposal_site: null,
            disposal_site_type: 'Landfill',
            material: 'Vegetative',
            row_count: 1,
            total_transaction_quantity: 10,
            total_extended_cost: 250,
            distinct_rate_codes: ['RC01'],
            distinct_invoice_numbers: ['INV-100'],
          }],
        },
        created_at: TEST_TIMESTAMP,
      }],
      rows: transactionRows,
      rollups: {
        grouped_by_rate_code: [{
          billing_rate_key: 'RC01',
          rate_code: 'RC01',
          rate_description_sample: null,
          row_count: 1,
          total_transaction_quantity: 10,
          total_extended_cost: 250,
          distinct_invoice_numbers: ['INV-100'],
          distinct_materials: ['Vegetative'],
          distinct_service_items: ['Haul'],
        }],
        grouped_by_invoice: [{
          invoice_number: 'INV-100',
          row_count: 1,
          total_transaction_quantity: 10,
          total_extended_cost: 250,
          distinct_rate_codes: ['RC01'],
          distinct_materials: ['Vegetative'],
          distinct_service_items: ['Haul'],
        }],
        grouped_by_site_material: [{
          site_material_key: 's:landfill|m:vegetative',
          disposal_site: null,
          disposal_site_type: 'Landfill',
          material: 'Vegetative',
          row_count: 1,
          total_transaction_quantity: 10,
          total_extended_cost: 250,
          distinct_rate_codes: ['RC01'],
          distinct_invoice_numbers: ['INV-100'],
        }],
      },
    };
    const governingDocumentIds: ValidatorDocumentIdsByFamily = {
      contract: [CONTRACT_DOCUMENT_ID],
      rate_sheet: [],
      permit: [],
      invoice: ['invoice-doc-1'],
      ticket_support: [],
    };

    const context = buildValidatorReconciliationContext({
      governingDocumentIds,
      contractValidationContext: null,
      factLookups: makeFactLookups(rateScheduleItems),
      invoices: [{
        id: 'invoice-row-1',
        source_document_id: 'invoice-doc-1',
        invoice_number: 'INV-100',
      }],
      invoiceLines,
      transactionData,
    });

    assert.equal(context.transaction.rollups.grouped_by_rate_code.length, 1);
    assert.equal(context.billing_groups.length, 2);

    const matchedGroup = context.billing_groups.find((group) => group.billing_rate_key === 'RC01');
    assert.equal(matchedGroup?.contract_rate_schedule_items.length, 1);
    assert.equal(matchedGroup?.invoice_lines.length, 1);
    assert.equal(matchedGroup?.transaction_rows.length, 1);
    assert.equal(matchedGroup?.transaction_rate_groups.length, 1);
    assert.equal(matchedGroup?.transaction_invoice_groups.length, 1);

    const summary = buildProjectReconciliationSummary({
      reconciliationContext: context,
      contractInvoiceReconciliation: {
        matched_invoice_lines: 1,
        unmatched_invoice_lines: 1,
        rate_mismatches: 0,
        vendor_identity_status: 'MATCH',
        client_identity_status: 'MATCH',
        service_period_status: 'MATCH',
        invoice_total_status: 'MATCH',
      },
      invoiceTransactionReconciliation: {
        matched_groups: 1,
        unmatched_groups: 1,
        cost_mismatches: 0,
        quantity_mismatches: 0,
        orphan_transactions: 0,
        outlier_rows: 0,
      },
    });

    assert.deepEqual(summary, {
      contract_invoice_status: 'MISMATCH',
      invoice_transaction_status: 'PARTIAL',
      overall_reconciliation_status: 'MISMATCH',
      matched_billing_groups: 1,
      unmatched_billing_groups: 1,
      rate_mismatches: 0,
      quantity_mismatches: 0,
      orphan_invoice_lines: 1,
      orphan_transactions: 0,
    });

    const validationSummary = buildValidationSummary([], 'VALIDATED', {
      reconciliation: summary,
    });
    assert.equal(validationSummary.reconciliation?.matched_billing_groups, 1);
    assert.equal(validationSummary.reconciliation?.invoice_transaction_status, 'PARTIAL');
  });
});
