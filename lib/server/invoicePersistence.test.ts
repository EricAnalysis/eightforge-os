import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  getCanonicalInvoicesForProject,
  persistCanonicalInvoiceForDocument,
} from '@/lib/server/invoicePersistence';

type InsertResponse = {
  data?: Record<string, unknown> | null;
  error?: { code?: string | null; message?: string | null } | null;
};

function makeExtractionData() {
  return {
    fields: {
      typed_fields: {
        schema_type: 'invoice',
        invoice_number: 'INV-100',
        invoice_date: '2026-01-05',
        vendor_name: 'Acme Debris LLC',
        client_name: 'Williamson County',
        total_amount: 100.5,
        subtotal_amount: 100.5,
        line_items: [
          {
            line_code: 'RC-01',
            description: 'Haul debris',
            quantity: 10,
            unit: 'CY',
            unit_price: 10.05,
            line_total: 100.5,
          },
        ],
      },
    },
  } as Record<string, unknown>;
}

function createAdminHarness(params?: {
  deleteErrors?: Record<string, { code?: string | null; message?: string | null } | null>;
  onInsert?: (table: string, payload: unknown, attempt: number) => InsertResponse;
}) {
  const deletes: Array<{ table: string; column: string; value: string }> = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const insertAttempts = new Map<string, number>();

  const admin = {
    from(table: string) {
      return {
        delete() {
          return {
            eq(column: string, value: string) {
              deletes.push({ table, column, value });
              return Promise.resolve({
                error: params?.deleteErrors?.[`${table}:${column}`] ?? null,
              });
            },
          };
        },
        insert(payload: unknown) {
          inserts.push({ table, payload });
          const attempt = insertAttempts.get(table) ?? 0;
          insertAttempts.set(table, attempt + 1);
          const response = params?.onInsert?.(table, payload, attempt) ?? { data: null, error: null };

          return {
            select() {
              return {
                single() {
                  return Promise.resolve({
                    data: response.data ?? null,
                    error: response.error ?? null,
                  });
                },
              };
            },
            then(
              resolve: (value: { error: { code?: string | null; message?: string | null } | null }) => unknown,
              reject?: (reason: unknown) => unknown,
            ) {
              return Promise.resolve({
                error: response.error ?? null,
              }).then(resolve, reject);
            },
          };
        },
      };
    },
  };

  return {
    admin,
    deletes,
    inserts,
  };
}

function createReadAdminHarness(params: {
  onSelect: (table: string, filters: Array<Record<string, unknown>>) => {
    data?: unknown;
    error?: { code?: string | null; message?: string | null } | null;
  };
}) {
  const calls: Array<{ table: string; filters: Array<Record<string, unknown>> }> = [];

  const admin = {
    from(table: string) {
      return {
        select() {
          const filters: Array<Record<string, unknown>> = [];
          const chain = {
            eq(column: string, value: unknown) {
              filters.push({ column, value });
              return chain;
            },
            in(column: string, value: unknown[]) {
              filters.push({ column, value });
              return chain;
            },
            then(
              resolve: (value: { data: unknown; error: { code?: string | null; message?: string | null } | null }) => unknown,
              reject?: (reason: unknown) => unknown,
            ) {
              calls.push({ table, filters: [...filters] });
              const response = params.onSelect(table, filters);
              return Promise.resolve({
                data: response.data ?? [],
                error: response.error ?? null,
              }).then(resolve, reject);
            },
          };

          return chain;
        },
      };
    },
  };

  return { admin, calls };
}

describe('persistCanonicalInvoiceForDocument', () => {
  it('writes canonical invoice rows into invoices and invoice_lines', async () => {
    const harness = createAdminHarness({
      onInsert(table) {
        if (table === 'invoices') {
          return {
            data: { id: 'invoice-row-1' },
            error: null,
          };
        }
        return { error: null };
      },
    });

    const result = await persistCanonicalInvoiceForDocument({
      admin: harness.admin as never,
      documentId: 'doc-1',
      projectId: 'project-1',
      extractionData: makeExtractionData(),
    });

    assert.equal(result.persisted, true);
    assert.equal(result.skipped, false);
    assert.equal(result.invoiceCount, 1);
    assert.equal(result.lineCount, 1);

    const invoiceInsert = harness.inserts.find((entry) => entry.table === 'invoices');
    assert.ok(invoiceInsert);
    assert.deepEqual(invoiceInsert?.payload, [{
      project_id: 'project-1',
      source_document_id: 'doc-1',
      document_id: 'doc-1',
      invoice_number: 'INV-100',
      invoice_status: null,
      invoice_date: '2026-01-05',
      period_start: null,
      period_end: null,
      period_through: null,
      vendor_name: 'Acme Debris LLC',
      client_name: 'Williamson County',
      subtotal_amount: 100.5,
      total_amount: 100.5,
      billed_amount: 100.5,
      line_item_count: 1,
    }]);

    const lineInsert = harness.inserts.find((entry) => entry.table === 'invoice_lines');
    assert.ok(lineInsert);
    assert.deepEqual(lineInsert?.payload, [
      {
        project_id: 'project-1',
        source_document_id: 'doc-1',
        document_id: 'doc-1',
        invoice_id: 'invoice-row-1',
        invoice_number: 'INV-100',
        line_code: 'RC-01',
        rate_code: 'RC-01',
        description: 'Haul debris',
        line_description: 'Haul debris',
        material: null,
        service_item: 'Haul debris',
        quantity: 10,
        unit: 'CY',
        unit_price: 10.05,
        line_total: 100.5,
        total_amount: 100.5,
        billing_rate_key: 'RC01',
        description_match_key: 'haul debris',
        invoice_rate_key: 'INV100::RC01',
        canonical_category: null,
        category_confidence: null,
      },
    ]);

    assert.ok(
      harness.deletes.some((entry) => entry.table === 'invoices' && entry.column === 'source_document_id'),
    );
    assert.ok(
      harness.deletes.some((entry) => entry.table === 'invoice_lines' && entry.column === 'source_document_id'),
    );
  });

  it('retries invoice_lines inserts without project_id when the column is unavailable', async () => {
    const harness = createAdminHarness({
      onInsert(table, payload, attempt) {
        if (table === 'invoices') {
          return {
            data: { id: 'invoice-row-1' },
            error: null,
          };
        }

        if (table === 'invoice_lines' && attempt === 0) {
          const rows = payload as Array<Record<string, unknown>>;
          assert.equal(rows[0]?.project_id, 'project-1');
          return {
            error: {
              code: '42703',
              message: 'column invoice_lines.project_id does not exist',
            },
          };
        }

        return { error: null };
      },
    });

    const result = await persistCanonicalInvoiceForDocument({
      admin: harness.admin as never,
      documentId: 'doc-1',
      projectId: 'project-1',
      extractionData: makeExtractionData(),
    });

    assert.equal(result.persisted, true);
    assert.equal(result.lineCount, 1);

    const invoiceLineInserts = harness.inserts.filter((entry) => entry.table === 'invoice_lines');
    assert.equal(invoiceLineInserts.length, 2);
    const retriedPayload = invoiceLineInserts[1]?.payload as Array<Record<string, unknown>>;
    assert.equal('project_id' in (retriedPayload[0] ?? {}), false);
    assert.equal(retriedPayload[0]?.invoice_id, 'invoice-row-1');
  });

  it('skips when the extraction is not an invoice payload', async () => {
    const harness = createAdminHarness();

    const result = await persistCanonicalInvoiceForDocument({
      admin: harness.admin as never,
      documentId: 'doc-1',
      projectId: 'project-1',
      extractionData: {
        fields: {
          typed_fields: {
            schema_type: 'contract',
          },
        },
      },
    });

    assert.equal(result.persisted, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not_invoice');
    assert.equal(harness.inserts.length, 0);
  });

  it('loads canonical invoice totals and invoice lines for a project', async () => {
    const harness = createReadAdminHarness({
      onSelect(table, filters) {
        const projectScoped = filters.some((filter) => filter.column === 'project_id');

        if (table === 'invoices' && projectScoped) {
          return {
            data: [
              {
                id: 'invoice-row-1',
                project_id: 'project-1',
                source_document_id: 'doc-1',
                invoice_number: 'INV-100',
                billed_amount: 100.5,
                total_amount: 100.5,
              },
            ],
            error: null,
          };
        }

        if (table === 'invoice_lines' && projectScoped) {
          return {
            data: [
              {
                id: 'line-row-1',
                project_id: 'project-1',
                source_document_id: 'doc-1',
                invoice_id: 'invoice-row-1',
                invoice_number: 'INV-100',
                line_total: 100.5,
                total_amount: 100.5,
              },
            ],
            error: null,
          };
        }

        return { data: [], error: null };
      },
    });

    const result = await getCanonicalInvoicesForProject({
      projectId: 'project-1',
      documentIds: ['doc-1'],
      admin: harness.admin as never,
    });

    assert.equal(result.invoices.length, 1);
    assert.equal(result.invoiceLines.length, 1);
    assert.equal(result.invoices[0]?.billed_amount, 100.5);
    assert.equal(result.invoices[0]?.invoice_number_raw, 'INV-100');
    assert.equal(result.invoices[0]?.invoice_number_normalized, 'INV-100');
    const lineItems = result.invoices[0]?.line_items;
    assert.ok(Array.isArray(lineItems));
    assert.equal(lineItems.length, 1);
    assert.equal(result.invoiceLines[0]?.line_total, 100.5);
    assert.deepEqual(harness.calls[0]?.filters, [{ column: 'project_id', value: 'project-1' }]);
    assert.deepEqual(harness.calls[1]?.filters, [{ column: 'project_id', value: 'project-1' }]);
  });
});
