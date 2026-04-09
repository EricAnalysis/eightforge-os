import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { utils, write } from 'xlsx';

import { extractNode } from '@/lib/pipeline/nodes/extractNode';
import { normalizeNode } from '@/lib/pipeline/nodes/normalizeNode';
import { extractDocument } from '@/lib/server/documentExtraction';

function workbookBytes(rows: unknown[][]): ArrayBuffer {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), 'ticket_query');
  const buffer = write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('normalizeNode transaction_data', () => {
  it('emits canonical transaction facts, row records, and rollups for spreadsheet transaction data', async () => {
    const extractionData = await extractDocument(
      {
        id: 'doc-transaction-normalize',
        title: 'Ticket Query Export',
        name: 'ticket_query.xlsx',
        document_type: 'transaction_data',
        storage_path: 'org/doc-transaction-normalize/ticket_query.xlsx',
      },
      workbookBytes([
        ['Ticket Query Export'],
        ['Transaction #', 'Invoice #', 'Invoice Date', 'Rate Code', 'Quantity', 'Unit Rate', 'Line Total', 'Service Item', 'Material', 'Project Name'],
        ['TX-1001', 'INV-100', '01/05/2026', 'RC-01', 10, 10.05, 100.5, 'Hauling', 'Vegetative', 'Williamson County'],
        ['TX-1002', 'INV-101', '01/06/2026', '', null, null, null, 'Disposal', 'C&D', 'Williamson County'],
      ]),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ticket_query.xlsx',
    );

    const extracted = extractNode({
      documentId: 'doc-transaction-normalize',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      projectName: 'Williamson County',
      extractionData: extractionData as unknown as Record<string, unknown>,
      relatedDocs: [],
    });
    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(normalized.primaryDocument.family, 'spreadsheet');
    assert.equal(facts.source_type?.value, 'transaction_data');
    assert.equal(facts.row_count?.value, 2);
    assert.equal(facts.total_tickets?.value, 2);
    assert.equal(facts.total_cyd?.value, 0);
    assert.equal(facts.total_extended_cost?.value, 100.5);
    assert.equal(facts.invoiced_ticket_count?.value, 2);
    assert.equal(facts.distinct_invoice_count?.value, 2);
    assert.equal(facts.total_invoiced_amount?.value, 100.5);
    assert.equal(facts.uninvoiced_line_count?.value, 0);
    assert.equal(facts.unknown_eligibility_count?.value, 2);
    assert.equal(facts.rows_with_missing_rate_code?.value, 1);
    assert.equal(facts.rows_with_missing_invoice_number?.value, 0);
    assert.equal(facts.rows_with_missing_quantity?.value, 1);
    assert.equal(facts.rows_with_missing_extended_cost?.value, 1);
    assert.equal(facts.rows_with_zero_cost?.value, 0);
    assert.equal(facts.rows_with_extreme_unit_rate?.value, 0);
    assert.deepEqual(facts.distinct_invoice_numbers?.value, ['INV-100', 'INV-101']);
    assert.deepEqual(facts.grouped_by_rate_code?.value, [
      {
        billing_rate_key: 'RC01',
        rate_code: 'RC01',
        rate_description_sample: null,
        row_count: 1,
        total_transaction_quantity: 10,
        total_extended_cost: 100.5,
        distinct_invoice_numbers: ['INV-100'],
        distinct_materials: ['Vegetative'],
        distinct_service_items: ['Hauling'],
      },
      {
        billing_rate_key: 'sm:disposal|c d',
        rate_code: null,
        rate_description_sample: null,
        row_count: 1,
        total_transaction_quantity: 0,
        total_extended_cost: 0,
        distinct_invoice_numbers: ['INV-101'],
        distinct_materials: ['C&D'],
        distinct_service_items: ['Disposal'],
      },
    ]);
    assert.deepEqual(facts.grouped_by_invoice?.value, [
      {
        invoice_number: 'INV100',
        row_count: 1,
        total_transaction_quantity: 10,
        total_extended_cost: 100.5,
        distinct_rate_codes: ['RC01'],
        distinct_materials: ['Vegetative'],
        distinct_service_items: ['Hauling'],
      },
      {
        invoice_number: 'INV101',
        row_count: 1,
        total_transaction_quantity: 0,
        total_extended_cost: 0,
        distinct_rate_codes: [],
        distinct_materials: ['C&D'],
        distinct_service_items: ['Disposal'],
      },
    ]);
    assert.deepEqual(facts.grouped_by_site_material?.value, [
      {
        site_material_key: 'm:c d',
        disposal_site: null,
        disposal_site_type: null,
        material: 'C&D',
        row_count: 1,
        total_transaction_quantity: 0,
        total_extended_cost: 0,
        distinct_rate_codes: [],
        distinct_invoice_numbers: ['INV-101'],
      },
      {
        site_material_key: 'm:vegetative',
        disposal_site: null,
        disposal_site_type: null,
        material: 'Vegetative',
        row_count: 1,
        total_transaction_quantity: 10,
        total_extended_cost: 100.5,
        distinct_rate_codes: ['RC01'],
        distinct_invoice_numbers: ['INV-100'],
      },
    ]);
    assert.deepEqual(facts.grouped_by_service_item?.value, [
      {
        service_item: 'Disposal',
        row_count: 1,
        total_transaction_quantity: 0,
        total_extended_cost: 0,
        total_cyd: 0,
        distinct_rate_codes: [],
        distinct_invoice_numbers: ['INV-101'],
        uninvoiced_line_count: 0,
        invoiced_ticket_count: 1,
        record_ids: ['transaction:ticket_query:4'],
        evidence_refs: ['sheet:ticket_query:row:4'],
      },
      {
        service_item: 'Hauling',
        row_count: 1,
        total_transaction_quantity: 10,
        total_extended_cost: 100.5,
        total_cyd: 0,
        distinct_rate_codes: ['RC01'],
        distinct_invoice_numbers: ['INV-100'],
        uninvoiced_line_count: 0,
        invoiced_ticket_count: 1,
        record_ids: ['transaction:ticket_query:3'],
        evidence_refs: ['sheet:ticket_query:row:3'],
      },
    ]);
    assert.deepEqual(facts.grouped_by_material?.value, [
      {
        material: 'C&D',
        row_count: 1,
        total_transaction_quantity: 0,
        total_extended_cost: 0,
        total_cyd: 0,
        distinct_rate_codes: [],
        distinct_invoice_numbers: ['INV-101'],
        site_types: [],
        disposal_sites: [],
        uninvoiced_line_count: 0,
        invoiced_ticket_count: 1,
        record_ids: ['transaction:ticket_query:4'],
        evidence_refs: ['sheet:ticket_query:row:4'],
      },
      {
        material: 'Vegetative',
        row_count: 1,
        total_transaction_quantity: 10,
        total_extended_cost: 100.5,
        total_cyd: 0,
        distinct_rate_codes: ['RC01'],
        distinct_invoice_numbers: ['INV-100'],
        site_types: [],
        disposal_sites: [],
        uninvoiced_line_count: 0,
        invoiced_ticket_count: 1,
        record_ids: ['transaction:ticket_query:3'],
        evidence_refs: ['sheet:ticket_query:row:3'],
      },
    ]);
    assert.equal(
      (facts.project_operations_overview?.value as { total_tickets?: number }).total_tickets,
      2,
    );
    assert.equal(
      (facts.invoice_readiness_summary?.value as { status?: string }).status,
      'partial',
    );
    const outlierRows = facts.outlier_rows?.value as Array<{
      record_id: string;
      source_row_number: number;
      reasons: string[];
      metrics: { extended_cost: number | null; transaction_quantity: number | null };
    }>;
    assert.equal(outlierRows.length, 2);
    assert.equal(outlierRows[0]?.record_id, 'transaction:ticket_query:3');
    assert.equal(outlierRows[0]?.source_row_number, 3);
    assert.deepEqual(outlierRows[0]?.reasons, ['Debris class at disposal site review']);
    assert.equal(outlierRows[0]?.metrics.extended_cost, 100.5);
    assert.equal(outlierRows[1]?.record_id, 'transaction:ticket_query:4');
    assert.equal(outlierRows[1]?.source_row_number, 4);
    assert.deepEqual(outlierRows[1]?.reasons, [
      'Debris class at disposal site review',
      'missing extended cost',
      'missing quantity',
      'missing rate code',
    ]);
    assert.equal(outlierRows[1]?.metrics.extended_cost, null);
    assert.ok(Array.isArray(facts.transaction_data_records?.value));
    assert.equal((facts.transaction_data_records?.value as Array<unknown>).length, 2);
    assert.deepEqual(normalized.extracted.sheetNames, ['ticket_query']);
    assert.equal(normalized.extracted.inferredProjectName, 'Williamson County');
    assert.equal(normalized.extracted.summary.row_count, 2);
    assert.equal(normalized.extracted.summary.total_tickets, 2);
    assert.equal(normalized.extracted.summary.distinct_invoice_count, 2);
    assert.equal(normalized.extracted.summary.total_invoiced_amount, 100.5);
    assert.equal(normalized.extracted.summary.inferred_date_range_start, '2026-01-05');
    assert.equal(normalized.extracted.summary.inferred_date_range_end, '2026-01-06');
    assert.equal(normalized.extracted.rollups.totalExtendedCost, 100.5);
    assert.equal(normalized.extracted.rollups.totalTickets, 2);
    assert.equal(normalized.extracted.rollups.totalCyd, 0);
    assert.equal(normalized.extracted.rollups.distinctInvoiceCount, 2);
    assert.equal(normalized.extracted.rollups.totalInvoicedAmount, 100.5);
    assert.equal(normalized.extracted.rollups.rowsWithMissingRateCode, 1);
    assert.equal(normalized.extracted.rollups.rowsWithMissingInvoiceNumber, 0);
    assert.equal(normalized.extracted.rollups.rowsWithZeroCost, 0);
    assert.equal(normalized.extracted.rollups.rowsWithExtremeUnitRate, 0);
    assert.deepEqual(normalized.extracted.rollups.groupedByRateCode, facts.grouped_by_rate_code?.value);
    assert.deepEqual(normalized.extracted.rollups.groupedByInvoice, facts.grouped_by_invoice?.value);
    assert.deepEqual(
      normalized.extracted.rollups.groupedBySiteMaterial,
      facts.grouped_by_site_material?.value,
    );
    assert.deepEqual(
      normalized.extracted.rollups.groupedByServiceItem,
      facts.grouped_by_service_item?.value,
    );
    assert.deepEqual(
      normalized.extracted.rollups.groupedByMaterial,
      facts.grouped_by_material?.value,
    );
    assert.deepEqual(normalized.extracted.projectOperationsOverview, facts.project_operations_overview?.value);
    assert.deepEqual(normalized.extracted.invoiceReadinessSummary, facts.invoice_readiness_summary?.value);
    assert.deepEqual(normalized.extracted.outlierRows, facts.outlier_rows?.value);
  });
});
