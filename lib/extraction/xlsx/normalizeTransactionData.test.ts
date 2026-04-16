import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { utils, write } from 'xlsx';

import { detectSheets } from '@/lib/extraction/xlsx/detectSheets';
import { normalizeTransactionData } from '@/lib/extraction/xlsx/normalizeTransactionData';
import { parseWorkbook } from '@/lib/extraction/xlsx/parseWorkbook';

function workbookBytes(sheets: Array<{ name: string; rows: unknown[][] }>): ArrayBuffer {
  const workbook = utils.book_new();

  for (const sheet of sheets) {
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(sheet.rows), sheet.name);
  }

  const buffer = write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('normalizeTransactionData', () => {
  it('normalizes ticket_query style exports into canonical rows and rollups', async () => {
    const workbook = await parseWorkbook(
      workbookBytes([
        {
          name: 'ticket_query',
          rows: [
            ['Williamson County Transaction Export'],
            [
              'Transaction #',
              'Invoice #',
              'Invoice Date',
              'Rate Code',
              'Rate Description',
              'Quantity',
              'Unit Rate',
              'Line Total',
              'Material',
              'Service Item',
              'Disposal Site',
              'Site Type',
              'Project Name',
              'Ticket Notes',
            ],
            [
              'TX-1001',
              'INV-100',
              '01/05/2026',
              'RC-01',
              'Debris Hauling',
              10,
              10,
              100,
              'Vegetative',
              'Hauling',
              'Alpha Landfill',
              null,
              'Williamson County',
              'Primary route',
            ],
            [
              'TX-1002',
              'INV-100',
              '01/05/2026',
              'RC-01',
              'Debris Hauling',
              5,
              10,
              50,
              'Vegetative',
              'Hauling',
              'Alpha Landfill',
              null,
              'Williamson County',
              'Secondary route',
            ],
            [
              'TX-1003',
              '',
              '01/06/2026',
              '',
              'Load Monitoring',
              2,
              5,
              0,
              'C&D',
              'Monitoring',
              '',
              'DMS',
              'Williamson County',
              'Zero cost check',
            ],
            [
              'TX-1004',
              'INV-101',
              '01/06/2026',
              'RC-01',
              'Debris Hauling',
              1,
              200,
              200,
              'Vegetative',
              'Hauling',
              'Alpha Landfill',
              null,
              'Williamson County',
              'Extreme rate',
            ],
          ],
        },
        {
          name: 'Summary',
          rows: [
            ['Summary', 'Value'],
            ['Total Extended Cost', 325.5],
          ],
        },
      ]),
    );

    const detectedSheets = detectSheets(workbook);
    const normalized = normalizeTransactionData({
      workbook,
      detectedSheets,
    });

    assert.equal(workbook.sheets[0]?.header_row_number, 2);
    assert.equal(normalized.source_type, 'transaction_data');
    assert.equal(normalized.row_count, 4);
    assert.deepEqual(normalized.processed_sheet_names, ['ticket_query']);
    assert.deepEqual(normalized.sheet_names, ['ticket_query', 'Summary']);
    assert.equal(normalized.header_map.transaction_number?.[0]?.column_name, 'Transaction #');
    assert.equal(normalized.header_map.transaction_number?.[0]?.header_row_number, 2);
    assert.equal(normalized.inferred_project_name, 'Williamson County');
    assert.deepEqual(normalized.inferred_invoice_numbers, ['INV-100', 'INV-101']);
    assert.deepEqual(normalized.inferred_date_range, {
      start: '2026-01-05',
      end: '2026-01-06',
    });
    assert.ok(normalized.detected_metric_columns.includes('Quantity'));
    assert.ok(normalized.detected_code_columns.includes('Transaction #'));
    assert.ok(normalized.detected_code_columns.includes('Rate Code'));
    assert.ok(normalized.detected_amount_columns.includes('Unit Rate'));
    assert.ok(normalized.detected_amount_columns.includes('Line Total'));
    assert.equal(normalized.records[0]?.transaction_number, 'TX-1001');
    assert.equal(normalized.records[0]?.invoice_date, '2026-01-05');
    assert.equal(normalized.records[0]?.source_sheet_name, 'ticket_query');
    assert.equal(normalized.records[0]?.source_row_number, 3);
    assert.equal(normalized.records[0]?.raw_row['Project Name'], 'Williamson County');
    assert.equal(normalized.records[0]?.billing_rate_key, 'RC01');
    assert.equal(normalized.records[0]?.description_match_key, 'debris hauling');
    assert.equal(normalized.records[0]?.site_material_key, 's:alpha landfill|m:vegetative');
    assert.equal(normalized.records[0]?.invoice_rate_key, 'INV100::RC01');
    assert.equal(normalized.records[2]?.billing_rate_key, 'LOADMONITORING');
    assert.equal(normalized.records[2]?.description_match_key, 'load monitoring');
    assert.equal(normalized.records[2]?.site_material_key, 's:dms|m:c d');
    assert.equal(normalized.records[2]?.invoice_rate_key, null);
    assert.equal(normalized.rollups.total_extended_cost, 350);
    assert.equal(normalized.rollups.total_transaction_quantity, 18);
    assert.equal(normalized.rollups.total_tickets, 4);
    assert.equal(normalized.rollups.total_cyd, 0);
    assert.equal(normalized.rollups.invoiced_ticket_count, 3);
    assert.equal(normalized.rollups.distinct_invoice_count, 2);
    assert.equal(normalized.rollups.total_invoiced_amount, 350);
    assert.equal(normalized.rollups.uninvoiced_line_count, 1);
    assert.equal(normalized.rollups.eligible_count, 0);
    assert.equal(normalized.rollups.ineligible_count, 0);
    assert.equal(normalized.rollups.unknown_eligibility_count, 4);
    assert.deepEqual(normalized.rollups.distinct_rate_codes, ['RC-01']);
    assert.deepEqual(normalized.rollups.distinct_invoice_numbers, ['INV-100', 'INV-101']);
    assert.deepEqual(normalized.rollups.distinct_service_items, ['Hauling', 'Monitoring']);
    assert.deepEqual(normalized.rollups.distinct_materials, ['Vegetative', 'C&D']);
    assert.equal(normalized.rollups.rows_with_missing_rate_code, 1);
    assert.equal(normalized.rollups.rows_with_missing_invoice_number, 1);
    assert.equal(normalized.rollups.rows_with_missing_quantity, 0);
    assert.equal(normalized.rollups.rows_with_missing_extended_cost, 0);
    assert.equal(normalized.rollups.rows_with_zero_cost, 1);
    assert.equal(normalized.rollups.rows_with_extreme_unit_rate, 1);
    assert.deepEqual(normalized.rollups.grouped_by_rate_code, [
      {
        billing_rate_key: 'LOADMONITORING',
        rate_code: null,
        rate_description_sample: 'Load Monitoring',
        row_count: 1,
        total_transaction_quantity: 2,
        total_extended_cost: 0,
        distinct_invoice_numbers: [],
        distinct_materials: ['C&D'],
        distinct_service_items: ['Monitoring'],
      },
      {
        billing_rate_key: 'RC01',
        rate_code: 'RC01',
        rate_description_sample: 'Debris Hauling',
        row_count: 3,
        total_transaction_quantity: 16,
        total_extended_cost: 350,
        distinct_invoice_numbers: ['INV-100', 'INV-101'],
        distinct_materials: ['Vegetative'],
        distinct_service_items: ['Hauling'],
      },
    ]);
    assert.deepEqual(normalized.rollups.grouped_by_invoice, [
      {
        invoice_number: 'INV100',
        row_count: 2,
        total_transaction_quantity: 15,
        total_extended_cost: 150,
        distinct_rate_codes: ['RC01'],
        distinct_materials: ['Vegetative'],
        distinct_service_items: ['Hauling'],
      },
      {
        invoice_number: 'INV101',
        row_count: 1,
        total_transaction_quantity: 1,
        total_extended_cost: 200,
        distinct_rate_codes: ['RC01'],
        distinct_materials: ['Vegetative'],
        distinct_service_items: ['Hauling'],
      },
      {
        invoice_number: null,
        row_count: 1,
        total_transaction_quantity: 2,
        total_extended_cost: 0,
        distinct_rate_codes: [],
        distinct_materials: ['C&D'],
        distinct_service_items: ['Monitoring'],
      },
    ]);
    assert.deepEqual(normalized.rollups.grouped_by_site_material, [
      {
        site_material_key: 's:alpha landfill|m:vegetative',
        disposal_site: 'Alpha Landfill',
        disposal_site_type: null,
        material: 'Vegetative',
        row_count: 3,
        total_transaction_quantity: 16,
        total_extended_cost: 350,
        distinct_rate_codes: ['RC01'],
        distinct_invoice_numbers: ['INV-100', 'INV-101'],
      },
      {
        site_material_key: 's:dms|m:c d',
        disposal_site: null,
        disposal_site_type: 'DMS',
        material: 'C&D',
        row_count: 1,
        total_transaction_quantity: 2,
        total_extended_cost: 0,
        distinct_rate_codes: [],
        distinct_invoice_numbers: [],
      },
    ]);
    assert.deepEqual(normalized.rollups.grouped_by_service_item, [
      {
        service_item: 'Hauling',
        row_count: 3,
        total_transaction_quantity: 16,
        total_extended_cost: 350,
        total_cyd: 0,
        distinct_rate_codes: ['RC01'],
        distinct_invoice_numbers: ['INV-100', 'INV-101'],
        uninvoiced_line_count: 0,
        invoiced_ticket_count: 3,
        record_ids: [
          'transaction:ticket_query:3',
          'transaction:ticket_query:4',
          'transaction:ticket_query:6',
        ],
        evidence_refs: [
          'sheet:ticket_query:row:3',
          'sheet:ticket_query:row:4',
          'sheet:ticket_query:row:6',
        ],
      },
      {
        service_item: 'Monitoring',
        row_count: 1,
        total_transaction_quantity: 2,
        total_extended_cost: 0,
        total_cyd: 0,
        distinct_rate_codes: [],
        distinct_invoice_numbers: [],
        uninvoiced_line_count: 1,
        invoiced_ticket_count: 0,
        record_ids: ['transaction:ticket_query:5'],
        evidence_refs: ['sheet:ticket_query:row:5'],
      },
    ]);
    assert.deepEqual(normalized.rollups.grouped_by_material, [
      {
        material: 'C&D',
        row_count: 1,
        total_transaction_quantity: 2,
        total_extended_cost: 0,
        total_cyd: 0,
        distinct_rate_codes: [],
        distinct_invoice_numbers: [],
        site_types: ['DMS'],
        disposal_sites: [],
        uninvoiced_line_count: 1,
        invoiced_ticket_count: 0,
        record_ids: ['transaction:ticket_query:5'],
        evidence_refs: ['sheet:ticket_query:row:5'],
      },
      {
        material: 'Vegetative',
        row_count: 3,
        total_transaction_quantity: 16,
        total_extended_cost: 350,
        total_cyd: 0,
        distinct_rate_codes: ['RC01'],
        distinct_invoice_numbers: ['INV-100', 'INV-101'],
        site_types: [],
        disposal_sites: ['Alpha Landfill'],
        uninvoiced_line_count: 0,
        invoiced_ticket_count: 3,
        record_ids: [
          'transaction:ticket_query:3',
          'transaction:ticket_query:4',
          'transaction:ticket_query:6',
        ],
        evidence_refs: [
          'sheet:ticket_query:row:3',
          'sheet:ticket_query:row:4',
          'sheet:ticket_query:row:6',
        ],
      },
    ]);
    assert.deepEqual(normalized.rollups.grouped_by_site_type, [
      {
        site_type: null,
        row_count: 3,
        total_transaction_quantity: 16,
        total_extended_cost: 350,
        total_cyd: 0,
        distinct_rate_codes: ['RC01'],
        distinct_invoice_numbers: ['INV-100', 'INV-101'],
        materials: ['Vegetative'],
        disposal_sites: ['Alpha Landfill'],
        uninvoiced_line_count: 0,
        invoiced_ticket_count: 3,
        record_ids: [
          'transaction:ticket_query:3',
          'transaction:ticket_query:4',
          'transaction:ticket_query:6',
        ],
        evidence_refs: [
          'sheet:ticket_query:row:3',
          'sheet:ticket_query:row:4',
          'sheet:ticket_query:row:6',
        ],
      },
      {
        site_type: 'DMS',
        row_count: 1,
        total_transaction_quantity: 2,
        total_extended_cost: 0,
        total_cyd: 0,
        distinct_rate_codes: [],
        distinct_invoice_numbers: [],
        materials: ['C&D'],
        disposal_sites: [],
        uninvoiced_line_count: 1,
        invoiced_ticket_count: 0,
        record_ids: ['transaction:ticket_query:5'],
        evidence_refs: ['sheet:ticket_query:row:5'],
      },
    ]);
    assert.deepEqual(normalized.rollups.grouped_by_disposal_site, [
      {
        disposal_site: null,
        row_count: 1,
        total_transaction_quantity: 2,
        total_extended_cost: 0,
        total_cyd: 0,
        distinct_rate_codes: [],
        distinct_invoice_numbers: [],
        site_types: ['DMS'],
        materials: ['C&D'],
        uninvoiced_line_count: 1,
        invoiced_ticket_count: 0,
        record_ids: ['transaction:ticket_query:5'],
        evidence_refs: ['sheet:ticket_query:row:5'],
      },
      {
        disposal_site: 'Alpha Landfill',
        row_count: 3,
        total_transaction_quantity: 16,
        total_extended_cost: 350,
        total_cyd: 0,
        distinct_rate_codes: ['RC01'],
        distinct_invoice_numbers: ['INV-100', 'INV-101'],
        site_types: [],
        materials: ['Vegetative'],
        uninvoiced_line_count: 0,
        invoiced_ticket_count: 3,
        record_ids: [
          'transaction:ticket_query:3',
          'transaction:ticket_query:4',
          'transaction:ticket_query:6',
        ],
        evidence_refs: [
          'sheet:ticket_query:row:3',
          'sheet:ticket_query:row:4',
          'sheet:ticket_query:row:6',
        ],
      },
    ]);

    assert.equal(normalized.summary.row_count, 4);
    assert.equal(normalized.summary.total_tickets, 4);
    assert.equal(normalized.summary.total_cyd, 0);
    assert.equal(normalized.summary.total_extended_cost, 350);
    assert.equal(normalized.summary.total_transaction_quantity, 18);
    assert.equal(normalized.summary.invoiced_ticket_count, 3);
    assert.equal(normalized.summary.distinct_invoice_count, 2);
    assert.equal(normalized.summary.total_invoiced_amount, 350);
    assert.equal(normalized.summary.uninvoiced_line_count, 1);
    assert.equal(normalized.summary.unknown_eligibility_count, 4);
    assert.deepEqual(normalized.summary.grouped_by_service_item, normalized.rollups.grouped_by_service_item);
    assert.deepEqual(normalized.summary.grouped_by_material, normalized.rollups.grouped_by_material);
    assert.deepEqual(normalized.summary.grouped_by_site_type, normalized.rollups.grouped_by_site_type);
    assert.deepEqual(normalized.summary.grouped_by_disposal_site, normalized.rollups.grouped_by_disposal_site);
    assert.deepEqual(normalized.summary.detected_header_map, normalized.header_map);
    assert.deepEqual(normalized.summary.detected_sheet_names, ['ticket_query', 'Summary']);
    assert.equal(normalized.summary.inferred_date_range_start, '2026-01-05');
    assert.equal(normalized.summary.inferred_date_range_end, '2026-01-06');

    assert.deepEqual(normalized.summary.project_operations_overview, {
      project_name: 'Williamson County',
      total_tickets: 4,
      total_transaction_quantity: 18,
      total_cyd: 0,
      distinct_invoice_count: 2,
      total_invoiced_amount: 350,
      invoiced_ticket_count: 3,
      uninvoiced_line_count: 1,
      distinct_service_item_count: 2,
      distinct_material_count: 2,
      distinct_site_type_count: 1,
      distinct_disposal_site_count: 1,
      eligible_count: 0,
      ineligible_count: 0,
      unknown_eligibility_count: 4,
      reviewed_sheet_names: ['ticket_query', 'Summary'],
      record_ids: [
        'transaction:ticket_query:3',
        'transaction:ticket_query:4',
        'transaction:ticket_query:5',
        'transaction:ticket_query:6',
      ],
      evidence_refs: [
        'sheet:ticket_query:row:3',
        'sheet:ticket_query:row:4',
        'sheet:ticket_query:row:5',
        'sheet:ticket_query:row:6',
      ],
    });
    assert.deepEqual(normalized.summary.invoice_readiness_summary, {
      status: 'partial',
      total_tickets: 4,
      invoiced_ticket_count: 3,
      distinct_invoice_count: 2,
      total_invoiced_amount: 350,
      uninvoiced_line_count: 1,
      rows_with_missing_rate_code: 1,
      rows_with_missing_quantity: 0,
      rows_with_missing_extended_cost: 0,
      rows_with_zero_cost: 1,
      rows_with_extreme_unit_rate: 1,
      outlier_row_count: 2,
      blocking_reasons: [
        'uninvoiced rows remain in the dataset',
        'rate code is missing on one or more rows',
        'zero-cost transaction rows require review',
        'rate outliers were detected',
      ],
      record_ids: [
        'transaction:ticket_query:3',
        'transaction:ticket_query:4',
        'transaction:ticket_query:5',
        'transaction:ticket_query:6',
      ],
      evidence_refs: [
        'sheet:ticket_query:row:3',
        'sheet:ticket_query:row:4',
        'sheet:ticket_query:row:5',
        'sheet:ticket_query:row:6',
      ],
    });
    assert.equal(normalized.summary.boundary_location_review.status, 'ok');
    assert.equal(normalized.summary.boundary_location_review.flagged_row_count, 0);
    assert.equal(normalized.summary.distance_from_feature_review.status, 'unavailable');
    assert.equal(normalized.summary.debris_class_at_disposal_site_review.status, 'ok');
    assert.equal(normalized.summary.mileage_review.status, 'unavailable');
    assert.equal(normalized.summary.load_call_review.status, 'unavailable');
    assert.equal(normalized.summary.linked_mobile_load_consistency_review.status, 'unavailable');
    assert.equal(normalized.summary.truck_trip_time_review.status, 'unavailable');
    assert.deepEqual(normalized.summary.dms_fds_lifecycle_summary, {
      dms_row_count: 1,
      fds_row_count: 0,
      other_row_count: 3,
      unknown_row_count: 0,
      mixed_material_flow_count: 0,
      lifecycle_groups: [
        {
          lifecycle_stage: 'DMS',
          row_count: 1,
          total_cyd: 0,
          total_extended_cost: 0,
          disposal_sites: [],
          materials: ['C&D'],
          record_ids: ['transaction:ticket_query:5'],
          evidence_refs: ['sheet:ticket_query:row:5'],
        },
        {
          lifecycle_stage: 'Landfill',
          row_count: 3,
          total_cyd: 0,
          total_extended_cost: 350,
          disposal_sites: ['Alpha Landfill'],
          materials: ['Vegetative'],
          record_ids: [
            'transaction:ticket_query:3',
            'transaction:ticket_query:4',
            'transaction:ticket_query:6',
          ],
          evidence_refs: [
            'sheet:ticket_query:row:3',
            'sheet:ticket_query:row:4',
            'sheet:ticket_query:row:6',
          ],
        },
      ],
      record_ids: [
        'transaction:ticket_query:3',
        'transaction:ticket_query:4',
        'transaction:ticket_query:5',
        'transaction:ticket_query:6',
      ],
      evidence_refs: [
        'sheet:ticket_query:row:3',
        'sheet:ticket_query:row:4',
        'sheet:ticket_query:row:5',
        'sheet:ticket_query:row:6',
      ],
    });
    assert.deepEqual(normalized.summary.outlier_rows, [
      {
        record_id: 'transaction:ticket_query:5',
        transaction_number: 'TX-1003',
        invoice_number: null,
        billing_rate_key: 'LOADMONITORING',
        description_match_key: 'load monitoring',
        source_sheet_name: 'ticket_query',
        source_row_number: 5,
        severity: 'warning',
        reasons: [
          'missing invoice number',
          'missing rate code',
          'zero extended cost',
        ],
        metrics: {
          transaction_quantity: 2,
          transaction_rate: 5,
          extended_cost: 0,
          mileage: null,
          cyd: null,
          net_tonnage: null,
        },
        evidence_refs: [
          'sheet:ticket_query:row:5',
          'cell:ticket_query:r5:c0',
          'cell:ticket_query:r5:c1',
          'cell:ticket_query:r5:c2',
          'cell:ticket_query:r5:c3',
          'cell:ticket_query:r5:c4',
          'cell:ticket_query:r5:c5',
          'cell:ticket_query:r5:c6',
          'cell:ticket_query:r5:c7',
          'cell:ticket_query:r5:c8',
          'cell:ticket_query:r5:c9',
          'cell:ticket_query:r5:c13',
          'cell:ticket_query:r5:c12',
        ],
      },
      {
        record_id: 'transaction:ticket_query:6',
        transaction_number: 'TX-1004',
        invoice_number: 'INV-101',
        billing_rate_key: 'RC01',
        description_match_key: 'debris hauling',
        source_sheet_name: 'ticket_query',
        source_row_number: 6,
        severity: 'warning',
        reasons: ['transaction rate 200 deviates from 10 baseline'],
        metrics: {
          transaction_quantity: 1,
          transaction_rate: 200,
          extended_cost: 200,
          mileage: null,
          cyd: null,
          net_tonnage: null,
        },
        evidence_refs: [
          'sheet:ticket_query:row:6',
          'cell:ticket_query:r6:c0',
          'cell:ticket_query:r6:c1',
          'cell:ticket_query:r6:c2',
          'cell:ticket_query:r6:c3',
          'cell:ticket_query:r6:c4',
          'cell:ticket_query:r6:c5',
          'cell:ticket_query:r6:c6',
          'cell:ticket_query:r6:c7',
          'cell:ticket_query:r6:c8',
          'cell:ticket_query:r6:c9',
          'cell:ticket_query:r6:c13',
          'cell:ticket_query:r6:c12',
        ],
      },
    ]);
  });
});
