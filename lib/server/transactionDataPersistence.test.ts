import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  getTransactionDataForProject,
  persistTransactionDataForDocument,
} from '@/lib/server/transactionDataPersistence';

type QueryResult = {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
};

type PersistenceAdminOptions = {
  deleteErrors?: Partial<Record<string, QueryResult['error']>>;
  insertErrors?: Partial<Record<string, QueryResult['error']>>;
  selectResults?: Partial<Record<string, QueryResult>>;
};

function createAdmin(options: PersistenceAdminOptions = {}) {
  const calls: Array<Record<string, unknown>> = [];

  const admin = {
    from(table: string) {
      return {
        delete() {
          return {
            eq(column: string, value: unknown) {
              calls.push({ table, action: 'delete', column, value });
              return Promise.resolve({
                error: options.deleteErrors?.[table] ?? null,
              });
            },
          };
        },
        insert(payload: unknown) {
          calls.push({ table, action: 'insert', payload });
          return Promise.resolve({
            error: options.insertErrors?.[table] ?? null,
          });
        },
        select(selection: string) {
          const call: Record<string, unknown> = {
            table,
            action: 'select',
            selection,
            filters: [],
            orders: [],
          };
          calls.push(call);

          const chain = {
            eq(column: string, value: unknown) {
              (call.filters as Array<Record<string, unknown>>).push({ column, value });
              return chain;
            },
            order(column: string, options?: Record<string, unknown>) {
              (call.orders as Array<Record<string, unknown>>).push({ column, options: options ?? null });
              return chain;
            },
            then(resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) {
              const result = options.selectResults?.[table] ?? { data: [], error: null };
              return Promise.resolve(result).then(resolve, reject);
            },
          };

          return chain;
        },
      };
    },
  };

  return { admin, calls };
}

const sampleExtracted = {
  sourceType: 'transaction_data',
  rowCount: 2,
  summary: {
    row_count: 2,
    total_extended_cost: 325.5,
    total_transaction_quantity: 19,
    inferred_date_range_start: '2026-01-05',
    inferred_date_range_end: '2026-01-06',
    grouped_by_rate_code: [
      {
        billing_rate_key: 'RC01',
        rate_code: 'RC01',
        rate_description_sample: null,
        row_count: 2,
        total_transaction_quantity: 19,
        total_extended_cost: 325.5,
        distinct_invoice_numbers: ['INV-100', 'INV-101'],
        distinct_materials: ['Vegetative'],
        distinct_service_items: [],
      },
    ],
  },
  records: [
    {
      invoice_number: 'INV-100',
      transaction_number: 'TX-1001',
      rate_code: 'RC-01',
      billing_rate_key: 'RC01',
      description_match_key: 'debris hauling',
      site_material_key: 's:alpha landfill|m:vegetative',
      invoice_rate_key: 'INV100::RC01',
      transaction_quantity: 10,
      extended_cost: 100.5,
      invoice_date: '2026-01-05',
      source_sheet_name: 'ticket_query',
      source_row_number: 3,
      raw_row: { 'Invoice #': 'INV-100', Quantity: 10 },
    },
    {
      invoice_number: 'INV-101',
      transaction_number: 'TX-1002',
      rate_code: 'RC-01',
      billing_rate_key: 'RC01',
      description_match_key: 'debris hauling',
      site_material_key: 's:alpha landfill|m:vegetative',
      invoice_rate_key: 'INV101::RC01',
      transaction_quantity: 9,
      extended_cost: 225,
      invoice_date: '2026-01-06',
      source_sheet_name: 'ticket_query',
      source_row_number: 4,
      raw_row: { 'Invoice #': 'INV-101', Quantity: 9 },
    },
  ],
} as const;

describe('transactionDataPersistence', () => {
  it('persists a transaction dataset and rows idempotently for a document', async () => {
    const { admin, calls } = createAdmin();

    const result = await persistTransactionDataForDocument({
      admin: admin as never,
      documentId: 'doc-1',
      projectId: 'project-1',
      extracted: sampleExtracted as unknown as Record<string, unknown>,
    });

    assert.deepEqual(result, {
      persisted: true,
      skipped: false,
      rowCount: 2,
    });
    assert.deepEqual(
      calls.map((call) => [call.table, call.action]),
      [
        ['transaction_data_rows', 'delete'],
        ['transaction_data_datasets', 'delete'],
        ['transaction_data_datasets', 'insert'],
        ['transaction_data_rows', 'insert'],
      ],
    );

    const datasetInsert = calls.find((call) =>
      call.table === 'transaction_data_datasets' && call.action === 'insert',
    );
    assert.deepEqual(datasetInsert?.payload, {
      document_id: 'doc-1',
      project_id: 'project-1',
      row_count: 2,
      total_extended_cost: 325.5,
      total_transaction_quantity: 19,
      date_range_start: '2026-01-05',
      date_range_end: '2026-01-06',
      summary_json: sampleExtracted.summary,
    });

    const rowsInsert = calls.find((call) =>
      call.table === 'transaction_data_rows' && call.action === 'insert',
    );
    assert.equal(Array.isArray(rowsInsert?.payload), true);
    assert.deepEqual((rowsInsert?.payload as Array<Record<string, unknown>>)[0], {
      document_id: 'doc-1',
      project_id: 'project-1',
      invoice_number: 'INV-100',
      transaction_number: 'TX-1001',
      rate_code: 'RC-01',
      billing_rate_key: 'RC01',
      description_match_key: 'debris hauling',
      site_material_key: 's:alpha landfill|m:vegetative',
      invoice_rate_key: 'INV100::RC01',
      transaction_quantity: 10,
      extended_cost: 100.5,
      invoice_date: '2026-01-05',
      source_sheet_name: 'ticket_query',
      source_row_number: 3,
      record_json: sampleExtracted.records[0],
      raw_row_json: sampleExtracted.records[0].raw_row,
    });
  });

  it('skips persistence cleanly when the project-scoped tables are unavailable', async () => {
    const { admin, calls } = createAdmin({
      deleteErrors: {
        transaction_data_rows: {
          code: '42P01',
          message: 'relation "transaction_data_rows" does not exist',
        },
      },
    });

    const result = await persistTransactionDataForDocument({
      admin: admin as never,
      documentId: 'doc-1',
      projectId: 'project-1',
      extracted: sampleExtracted as unknown as Record<string, unknown>,
    });

    assert.deepEqual(result, {
      persisted: false,
      skipped: true,
      reason: 'missing_table',
      rowCount: 0,
    });
    assert.deepEqual(
      calls.map((call) => [call.table, call.action]),
      [['transaction_data_rows', 'delete']],
    );
  });

  it('loads persisted transaction datasets and rows for a project', async () => {
    const { admin, calls } = createAdmin({
      selectResults: {
        transaction_data_datasets: {
          data: [
            {
              id: 'dataset-1',
              document_id: 'doc-1',
              project_id: 'project-1',
              row_count: 2,
              total_extended_cost: 325.5,
              total_transaction_quantity: 19,
              date_range_start: '2026-01-05',
              date_range_end: '2026-01-06',
              summary_json: { row_count: 2 },
              created_at: '2026-04-04T17:00:00Z',
            },
          ],
          error: null,
        },
        transaction_data_rows: {
          data: [
            {
              id: 'row-1',
              document_id: 'doc-1',
              project_id: 'project-1',
              invoice_number: 'INV-100',
              transaction_number: 'TX-1001',
              rate_code: 'RC-01',
              billing_rate_key: 'RC01',
              description_match_key: 'debris hauling',
              site_material_key: 's:alpha landfill|m:vegetative',
              invoice_rate_key: 'INV100::RC01',
              transaction_quantity: 10,
              extended_cost: 100.5,
              invoice_date: '2026-01-05',
              source_sheet_name: 'ticket_query',
              source_row_number: 3,
              record_json: { invoice_number: 'INV-100' },
              raw_row_json: { 'Invoice #': 'INV-100' },
              created_at: '2026-04-04T17:00:00Z',
            },
          ],
          error: null,
        },
      },
    });

    const result = await getTransactionDataForProject('project-1', admin as never);

    assert.equal(result.datasets.length, 1);
    assert.equal(result.datasets[0]?.id, 'dataset-1');
    assert.equal(result.datasets[0]?.total_extended_cost, 325.5);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.transaction_number, 'TX-1001');
    assert.equal(result.rows[0]?.billing_rate_key, 'RC01');
    assert.equal(result.rows[0]?.description_match_key, 'debris hauling');
    assert.equal(result.rows[0]?.invoice_rate_key, 'INV100::RC01');
    assert.equal(result.rows[0]?.record_json.invoice_number, 'INV-100');

    const datasetSelect = calls.find((call) =>
      call.table === 'transaction_data_datasets' && call.action === 'select',
    );
    assert.deepEqual(datasetSelect?.filters, [{ column: 'project_id', value: 'project-1' }]);

    const rowsSelect = calls.find((call) =>
      call.table === 'transaction_data_rows' && call.action === 'select',
    );
    assert.deepEqual(rowsSelect?.filters, [{ column: 'project_id', value: 'project-1' }]);
  });
});
