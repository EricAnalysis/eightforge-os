import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  TRANSACTION_DATA_HEADER_ALIASES,
  TRANSACTION_DATA_ROW_SCHEMA,
  TRANSACTION_DATA_SUMMARY_SCHEMA,
} from '@/lib/types/transactionData';

describe('transaction_data schema', () => {
  it('defines the required canonical row and summary contract for ticket_query exports', () => {
    assert.deepEqual(TRANSACTION_DATA_ROW_SCHEMA.transaction_number, {
      type: 'string',
      required: false,
      nullable: true,
    });
    assert.deepEqual(TRANSACTION_DATA_ROW_SCHEMA.transaction_rate, {
      type: 'currency',
      required: false,
      nullable: true,
    });
    assert.deepEqual(TRANSACTION_DATA_ROW_SCHEMA.source_sheet_name, {
      type: 'string',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_ROW_SCHEMA.source_row_number, {
      type: 'integer',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_ROW_SCHEMA.raw_row, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_ROW_SCHEMA.billing_rate_key, {
      type: 'string',
      required: false,
      nullable: true,
    });
    assert.deepEqual(TRANSACTION_DATA_ROW_SCHEMA.description_match_key, {
      type: 'string',
      required: false,
      nullable: true,
    });
    assert.deepEqual(TRANSACTION_DATA_ROW_SCHEMA.site_material_key, {
      type: 'string',
      required: false,
      nullable: true,
    });
    assert.deepEqual(TRANSACTION_DATA_ROW_SCHEMA.invoice_rate_key, {
      type: 'string',
      required: false,
      nullable: true,
    });

    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.total_extended_cost, {
      type: 'currency',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.total_tickets, {
      type: 'integer',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.total_cyd, {
      type: 'number',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.distinct_invoice_count, {
      type: 'integer',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.total_invoiced_amount, {
      type: 'currency',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.project_operations_overview, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.invoice_readiness_summary, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.detected_header_map, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.inferred_date_range_start, {
      type: 'date',
      required: false,
      nullable: true,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.grouped_by_rate_code, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.grouped_by_invoice, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.grouped_by_site_material, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.grouped_by_service_item, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.grouped_by_material, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.grouped_by_site_type, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.grouped_by_disposal_site, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.rows_with_missing_invoice_number, {
      type: 'integer',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.rows_with_zero_cost, {
      type: 'integer',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.rows_with_extreme_unit_rate, {
      type: 'integer',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.outlier_rows, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.dms_fds_lifecycle_summary, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.boundary_location_review, {
      type: 'json',
      required: true,
      nullable: false,
    });
    assert.deepEqual(TRANSACTION_DATA_SUMMARY_SCHEMA.truck_trip_time_review, {
      type: 'json',
      required: true,
      nullable: false,
    });

    assert.ok(TRANSACTION_DATA_HEADER_ALIASES.transaction_number.includes('transaction #'));
    assert.ok(TRANSACTION_DATA_HEADER_ALIASES.invoice_number.includes('invoice #'));
    assert.ok(TRANSACTION_DATA_HEADER_ALIASES.transaction_quantity.includes('quantity'));
    assert.ok(TRANSACTION_DATA_HEADER_ALIASES.transaction_rate.includes('unit rate'));
    assert.ok(TRANSACTION_DATA_HEADER_ALIASES.extended_cost.includes('line total'));
    assert.ok(TRANSACTION_DATA_HEADER_ALIASES.project_name.includes('project'));
  });
});
