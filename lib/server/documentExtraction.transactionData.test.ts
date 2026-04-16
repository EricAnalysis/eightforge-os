import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { utils, write } from 'xlsx';

import { extractDocument } from '@/lib/server/documentExtraction';

function workbookBytes(rows: unknown[][]): ArrayBuffer {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), 'ticket_query');
  const buffer = write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('extractDocument transaction_data routing', () => {
  it('routes explicit transaction_data uploads through the dedicated spreadsheet normalization path', async () => {
    const payload = await extractDocument(
      {
        id: 'doc-transaction-data',
        title: 'Ticket Query Export',
        name: 'ticket_query.xlsx',
        document_type: 'transaction_data',
        storage_path: 'org/doc-transaction-data/ticket_query.xlsx',
      },
      workbookBytes([
        ['Ticket Query Export'],
        ['Transaction #', 'Invoice #', 'Invoice Date', 'Rate Code', 'Quantity', 'Unit Rate', 'Line Total', 'Project Name'],
        ['TX-1001', 'INV-100', '01/05/2026', 'RC-01', 10, 10.05, 100.5, 'Williamson County'],
        ['TX-1002', 'INV-101', '01/06/2026', 'RC-02', 9, 25, 225, 'Williamson County'],
      ]),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ticket_query.xlsx',
    );

    const extraction = payload.extraction.content_layers_v1 as {
      spreadsheet?: {
        normalized_ticket_export?: unknown;
        normalized_transaction_data?: {
          row_count?: number;
          summary?: {
            row_count?: number;
            total_tickets?: number;
            distinct_invoice_count?: number;
            total_invoiced_amount?: number;
            inferred_date_range_start?: string | null;
            inferred_date_range_end?: string | null;
            project_operations_overview?: {
              total_tickets?: number;
              distinct_invoice_count?: number;
            };
            invoice_readiness_summary?: {
              status?: string;
              outlier_row_count?: number;
            };
          };
          rollups?: {
            total_extended_cost?: number;
            total_tickets?: number;
            distinct_invoice_count?: number;
            total_invoiced_amount?: number;
            distinct_invoice_numbers?: string[];
            grouped_by_rate_code?: Array<{
              billing_rate_key: string | null;
              rate_code: string | null;
              rate_description_sample: string | null;
              row_count: number;
              total_transaction_quantity: number;
              total_extended_cost: number;
              distinct_invoice_numbers: string[];
              distinct_materials: string[];
              distinct_service_items: string[];
            }>;
            grouped_by_invoice?: Array<{
              invoice_number: string | null;
              row_count: number;
              total_transaction_quantity: number;
              total_extended_cost: number;
              distinct_rate_codes: string[];
              distinct_materials: string[];
              distinct_service_items: string[];
            }>;
            grouped_by_site_material?: Array<{
              site_material_key: string | null;
              disposal_site: string | null;
              disposal_site_type: string | null;
              material: string | null;
              row_count: number;
              total_transaction_quantity: number;
              total_extended_cost: number;
              distinct_rate_codes: string[];
              distinct_invoice_numbers: string[];
            }>;
            grouped_by_service_item?: Array<{
              service_item: string | null;
              row_count: number;
              total_transaction_quantity: number;
              total_extended_cost: number;
            }>;
            rows_with_missing_invoice_number?: number;
            rows_with_zero_cost?: number;
            rows_with_extreme_unit_rate?: number;
            outlier_rows?: Array<unknown>;
          };
        } | null;
      };
    };
    const evidenceV1 = payload.extraction.evidence_v1 as {
      structured_fields?: Record<string, unknown>;
    };

    assert.equal(payload.fields.detected_document_type, 'transaction_data');
    assert.equal(payload.extraction.detected_document_type, 'transaction_data');
    assert.equal(
      payload.extraction.ai_assist_v1?.classification.family,
      'spreadsheet',
    );
    assert.equal(extraction.spreadsheet?.normalized_ticket_export ?? null, null);
    assert.equal(extraction.spreadsheet?.normalized_transaction_data?.row_count, 2);
    assert.equal(extraction.spreadsheet?.normalized_transaction_data?.summary?.row_count, 2);
    assert.equal(extraction.spreadsheet?.normalized_transaction_data?.summary?.total_tickets, 2);
    assert.equal(extraction.spreadsheet?.normalized_transaction_data?.summary?.distinct_invoice_count, 2);
    assert.equal(extraction.spreadsheet?.normalized_transaction_data?.summary?.total_invoiced_amount, 325.5);
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.summary?.inferred_date_range_start,
      '2026-01-05',
    );
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.summary?.inferred_date_range_end,
      '2026-01-06',
    );
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.total_extended_cost,
      325.5,
    );
    assert.equal(extraction.spreadsheet?.normalized_transaction_data?.rollups?.total_tickets, 2);
    assert.equal(extraction.spreadsheet?.normalized_transaction_data?.rollups?.distinct_invoice_count, 2);
    assert.equal(extraction.spreadsheet?.normalized_transaction_data?.rollups?.total_invoiced_amount, 325.5);
    assert.deepEqual(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.distinct_invoice_numbers,
      ['INV-100', 'INV-101'],
    );
    assert.deepEqual(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.grouped_by_rate_code,
      [
        {
          billing_rate_key: 'RC01',
          rate_code: 'RC01',
          rate_description_sample: null,
          row_count: 1,
          total_transaction_quantity: 10,
          total_extended_cost: 100.5,
          distinct_invoice_numbers: ['INV-100'],
          distinct_materials: [],
          distinct_service_items: [],
        },
        {
          billing_rate_key: 'RC02',
          rate_code: 'RC02',
          rate_description_sample: null,
          row_count: 1,
          total_transaction_quantity: 9,
          total_extended_cost: 225,
          distinct_invoice_numbers: ['INV-101'],
          distinct_materials: [],
          distinct_service_items: [],
        },
      ],
    );
    assert.deepEqual(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.grouped_by_invoice,
      [
        {
          invoice_number: 'INV100',
          row_count: 1,
          total_transaction_quantity: 10,
          total_extended_cost: 100.5,
          distinct_rate_codes: ['RC01'],
          distinct_materials: [],
          distinct_service_items: [],
        },
        {
          invoice_number: 'INV101',
          row_count: 1,
          total_transaction_quantity: 9,
          total_extended_cost: 225,
          distinct_rate_codes: ['RC02'],
          distinct_materials: [],
          distinct_service_items: [],
        },
      ],
    );
    assert.deepEqual(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.grouped_by_site_material,
      [
        {
          site_material_key: null,
          disposal_site: null,
          disposal_site_type: null,
          material: null,
          row_count: 2,
          total_transaction_quantity: 19,
          total_extended_cost: 325.5,
          distinct_rate_codes: ['RC01', 'RC02'],
          distinct_invoice_numbers: ['INV-100', 'INV-101'],
        },
      ],
    );
    assert.deepEqual(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.grouped_by_service_item,
      [
        {
          service_item: null,
          row_count: 2,
          total_transaction_quantity: 19,
          total_extended_cost: 325.5,
          total_cyd: 0,
          distinct_rate_codes: ['RC01', 'RC02'],
          distinct_invoice_numbers: ['INV-100', 'INV-101'],
          uninvoiced_line_count: 0,
          invoiced_ticket_count: 2,
          record_ids: [
            'transaction:ticket_query:3',
            'transaction:ticket_query:4',
          ],
          evidence_refs: [
            'sheet:ticket_query:row:3',
            'sheet:ticket_query:row:4',
          ],
        },
      ],
    );
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.rows_with_missing_invoice_number,
      0,
    );
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.rows_with_zero_cost,
      0,
    );
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.rows_with_extreme_unit_rate,
      0,
    );
    assert.deepEqual(
      extraction.spreadsheet?.normalized_transaction_data?.rollups?.outlier_rows,
      [],
    );
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.summary?.project_operations_overview?.total_tickets,
      2,
    );
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.summary?.project_operations_overview?.distinct_invoice_count,
      2,
    );
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.summary?.invoice_readiness_summary?.status,
      'ready',
    );
    assert.equal(
      extraction.spreadsheet?.normalized_transaction_data?.summary?.invoice_readiness_summary?.outlier_row_count,
      0,
    );
    assert.equal(evidenceV1.structured_fields?.source_type, 'transaction_data');
    assert.equal(evidenceV1.structured_fields?.row_count, 2);
    assert.equal(evidenceV1.structured_fields?.total_tickets, 2);
    assert.equal(evidenceV1.structured_fields?.distinct_invoice_count, 2);
    assert.equal(evidenceV1.structured_fields?.total_invoiced_amount, 325.5);
    assert.equal(evidenceV1.structured_fields?.transaction_data_summary != null, true);
    assert.equal(Array.isArray(evidenceV1.structured_fields?.grouped_by_rate_code), true);
    assert.equal(Array.isArray(evidenceV1.structured_fields?.grouped_by_invoice), true);
    assert.equal(Array.isArray(evidenceV1.structured_fields?.grouped_by_site_material), true);
    assert.equal(Array.isArray(evidenceV1.structured_fields?.grouped_by_service_item), true);
    assert.equal(Array.isArray(evidenceV1.structured_fields?.outlier_rows), true);
    assert.equal(
      (evidenceV1.structured_fields?.invoice_readiness_summary as { status?: string })?.status,
      'ready',
    );
    assert.equal(evidenceV1.structured_fields?.rows_with_zero_cost, 0);
    assert.equal(evidenceV1.structured_fields?.inferred_date_range_start, '2026-01-05');
    assert.equal(evidenceV1.structured_fields?.inferred_date_range_end, '2026-01-06');
    assert.equal(payload.summary, 'Workbook parsed with transaction-data normalization.');
  });
});
