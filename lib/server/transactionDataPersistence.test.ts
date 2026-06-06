import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  getCanonicalTransactionDataForProject,
  getTransactionDataForProject,
  isTransactionDataTableUnavailableError,
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
  onSelect?: (table: string, call: Record<string, unknown>) => QueryResult;
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
            range: null,
          };
          calls.push(call);

          const chain = {
            eq(column: string, value: unknown) {
              (call.filters as Array<Record<string, unknown>>).push({ column, value });
              return chain;
            },
            in(column: string, value: unknown) {
              (call.filters as Array<Record<string, unknown>>).push({
                column,
                op: 'in',
                value,
              });
              return chain;
            },
            order(column: string, orderOptions?: Record<string, unknown>) {
              (call.orders as Array<Record<string, unknown>>).push({
                column,
                options: orderOptions ?? null,
              });
              return chain;
            },
            range(from: number, to: number) {
              call.range = { from, to };
              return chain;
            },
            then(resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) {
              const result = options.onSelect?.(table, call)
                ?? options.selectResults?.[table]
                ?? { data: [], error: null };
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

function buildTransactionRecord(index: number): Record<string, unknown> {
  return {
    invoice_number: `INV-${String(index).padStart(3, '0')}`,
    transaction_number: `TX-${String(index).padStart(4, '0')}`,
    rate_code: 'RC-01',
    billing_rate_key: 'RC01',
    description_match_key: 'debris hauling',
    site_material_key: 's:alpha landfill|m:vegetative',
    invoice_rate_key: `INV${String(index).padStart(3, '0')}::RC01`,
    transaction_quantity: 1,
    extended_cost: 10,
    invoice_date: '2026-01-05',
    source_sheet_name: 'ticket_query',
    source_row_number: index + 2,
    raw_row: { 'Invoice #': `INV-${String(index).padStart(3, '0')}`, Quantity: 1 },
  };
}

describe('transactionDataPersistence', () => {
  it('persists a transaction dataset and rows idempotently for a document', async () => {
    const { admin, calls } = createAdmin();

    const result = await persistTransactionDataForDocument({
      admin: admin as never,
      documentId: 'doc-1',
      projectId: 'project-1',
      organizationId: 'org-1',
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
      organization_id: 'org-1',
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
      organizationId: 'org-1',
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

  it('splits row inserts into smaller sequential batches', async () => {
    const { admin, calls } = createAdmin();
    const records = Array.from({ length: 151 }, (_, index) => buildTransactionRecord(index + 1));

    const result = await persistTransactionDataForDocument({
      admin: admin as never,
      documentId: 'doc-1',
      projectId: 'project-1',
      organizationId: 'org-1',
      extracted: {
        sourceType: 'transaction_data',
        rowCount: records.length,
        summary: {
          row_count: records.length,
          total_extended_cost: records.length * 10,
          total_transaction_quantity: records.length,
          inferred_date_range_start: '2026-01-05',
          inferred_date_range_end: '2026-01-05',
        },
        records,
      } as Record<string, unknown>,
    });

    assert.deepEqual(result, {
      persisted: true,
      skipped: false,
      rowCount: 151,
    });

    const rowInsertCalls = calls.filter((call) =>
      call.table === 'transaction_data_rows' && call.action === 'insert',
    );
    assert.equal(rowInsertCalls.length, 2);
    assert.equal((rowInsertCalls[0]?.payload as Array<Record<string, unknown>>).length, 150);
    assert.equal((rowInsertCalls[1]?.payload as Array<Record<string, unknown>>).length, 1);
  });

  it('does not classify row constraint errors as missing tables', async () => {
    const constraintError = {
      code: '23502',
      message:
        'null value in column "organization_id" of relation "transaction_data_rows" violates not-null constraint',
    };

    assert.equal(isTransactionDataTableUnavailableError(constraintError), false);

    const { admin } = createAdmin({
      insertErrors: {
        transaction_data_rows: constraintError,
      },
    });

    await assert.rejects(
      () =>
        persistTransactionDataForDocument({
          admin: admin as never,
          documentId: 'doc-1',
          projectId: 'project-1',
          organizationId: 'org-1',
          extracted: sampleExtracted as unknown as Record<string, unknown>,
        }),
      /null value in column "organization_id".*violates not-null constraint/i,
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

  it('falls back to document-scoped canonical transaction rows when project-scoped queries are empty', async () => {
    const { admin, calls } = createAdmin({
      onSelect(table, call) {
        const filters = (call.filters ?? []) as Array<Record<string, unknown>>;
        const projectScoped = filters.some((filter) => filter.column === 'project_id');
        const documentScoped = filters.some((filter) => filter.column === 'document_id');

        if (projectScoped) {
          return { data: [], error: null };
        }

        if (table === 'transaction_data_datasets' && documentScoped) {
          return {
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
                summary_json: sampleExtracted.summary,
                created_at: '2026-04-04T17:00:00Z',
              },
            ],
            error: null,
          };
        }

        if (table === 'transaction_data_rows' && documentScoped) {
          return {
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
                record_json: sampleExtracted.records[0],
                raw_row_json: sampleExtracted.records[0].raw_row,
                created_at: '2026-04-04T17:00:00Z',
              },
            ],
            error: null,
          };
        }

        return { data: [], error: null };
      },
    });

    const result = await getCanonicalTransactionDataForProject({
      projectId: 'project-1',
      documentIds: ['doc-1'],
      admin: admin as never,
    });

    assert.equal(result.datasets.length, 1);
    assert.equal(result.rows.length, 1);
    assert.equal(result.datasets[0]?.row_count, 2);
    assert.equal(result.rows[0]?.record_json.invoice_number, 'INV-100');

    const documentScopedSelects = calls.filter((call) =>
      call.action === 'select'
      && ((call.filters as Array<Record<string, unknown>>).some((filter) => filter.column === 'document_id')),
    );
    assert.equal(documentScopedSelects.length, 2);
  });

  it('paginates transaction rows beyond the default Supabase page size', async () => {
    const rows = Array.from({ length: 1500 }, (_, index) => ({
      id: `row-${index}`,
      document_id: 'doc-1',
      project_id: 'project-1',
      invoice_number: index < 1000 ? '2026-002' : '2026-003',
      transaction_number: `TX-${index}`,
      rate_code: '2A',
      billing_rate_key: '2A',
      description_match_key: null,
      site_material_key: null,
      invoice_rate_key: index < 1000 ? '2026002::2A' : '2026003::2A',
      transaction_quantity: 1,
      extended_cost: 10,
      invoice_date: '2026-01-05',
      source_sheet_name: 'ticket_query',
      source_row_number: index + 1,
      record_json: { invoice_number: index < 1000 ? '2026-002' : '2026-003' },
      raw_row_json: {},
      created_at: '2026-04-04T17:00:00Z',
    }));

    const { admin } = createAdmin({
      selectResults: {
        transaction_data_datasets: { data: [], error: null },
      },
      onSelect(table, call) {
        if (table !== 'transaction_data_rows') {
          return { data: [], error: null };
        }

        const range = call.range as { from: number; to: number } | null;
        if (!range) {
          return { data: [], error: null };
        }

        return {
          data: rows.slice(range.from, range.to + 1),
          error: null,
        };
      },
    });

    const result = await getCanonicalTransactionDataForProject({
      projectId: 'project-1',
      admin: admin as never,
    });

    assert.equal(result.rows.length, 1500);
    assert.equal(
      result.rows.filter((row) => row.invoice_number === '2026-003').length,
      500,
    );
  });
});
