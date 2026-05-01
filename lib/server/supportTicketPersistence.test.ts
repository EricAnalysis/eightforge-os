import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { persistCanonicalSupportForDocument } from '@/lib/server/supportTicketPersistence';

type InsertResponse = {
  error?: { code?: string | null; message?: string | null } | null;
};

function makeWorkbookExtractionData() {
  return {
    extraction: {
      content_layers_v1: {
        spreadsheet: {
          normalized_ticket_export: {
            family: 'ticket',
            sheets: [
              {
                sheet_name: 'Tickets',
                row_count: 1,
                missing_quantity_rows: 0,
                missing_rate_rows: 0,
              },
            ],
            rows: [
              {
                id: 'ticket:sheet-1:3',
                sheet_key: 'sheet-1',
                sheet_name: 'Tickets',
                row_number: 3,
                ticket_id: 'MT-100',
                quantity: 12,
                unit: 'CY',
                rate: 45.5,
                invoice_number: 'INV-100',
                contract_line_item: 'CLIN-01',
                evidence_ref: 'sheet:sheet-1:row:3',
                column_headers: {
                  ticket_id: 'Ticket #',
                  quantity: 'Qty',
                  rate: 'Rate',
                  unit: 'Unit',
                  invoice_number: 'Invoice #',
                  contract_line_item: 'CLIN',
                },
                field_evidence_ids: {
                  ticket_id: 'cell:sheet-1:r3:c0',
                  quantity: 'cell:sheet-1:r3:c1',
                },
                confidence: 0.93,
                missing_fields: [],
              },
            ],
            summary: {
              row_count: 1,
              missing_quantity_rows: 0,
              missing_rate_rows: 0,
            },
            confidence: 0.93,
            gaps: [],
          },
        },
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
          const response = params?.onInsert?.(table, payload, attempt) ?? { error: null };

          return {
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

describe('persistCanonicalSupportForDocument', () => {
  it('writes normalized ticket-export workbook rows into canonical mobile_tickets', async () => {
    const harness = createAdminHarness();

    const result = await persistCanonicalSupportForDocument({
      admin: harness.admin as never,
      documentId: 'doc-1',
      projectId: 'project-1',
      organizationId: 'org-1',
      extractionData: makeWorkbookExtractionData(),
      extracted: null,
    });

    assert.equal(result.persisted, true);
    assert.equal(result.skipped, false);
    assert.equal(result.mobileTicketCount, 1);

    const mobileTicketInsert = harness.inserts.find((entry) => entry.table === 'mobile_tickets');
    assert.ok(mobileTicketInsert);
    const insertedRow = (mobileTicketInsert?.payload as Array<Record<string, unknown>>)[0];
    assert.equal(insertedRow?.project_id, 'project-1');
    assert.equal(insertedRow?.organization_id, 'org-1');
    assert.equal(insertedRow?.source_document_id, 'doc-1');
    assert.equal(insertedRow?.mobile_ticket_id, 'MT-100');
    assert.equal(insertedRow?.quantity_cyd, 12);
    assert.equal(insertedRow?.invoice_number, 'INV-100');
    assert.equal(insertedRow?.source_sheet_name, 'Tickets');

    assert.ok(
      harness.deletes.some((entry) => entry.table === 'mobile_tickets' && entry.column === 'source_document_id'),
    );
    assert.ok(
      harness.deletes.some((entry) => entry.table === 'mobile_tickets' && entry.column === 'document_id'),
    );
  });

  it('routes mobile unit ticket rows by service item into canonical load_tickets', async () => {
    const harness = createAdminHarness();

    const result = await persistCanonicalSupportForDocument({
      admin: harness.admin as never,
      documentId: 'doc-unit',
      projectId: 'project-1',
      organizationId: 'org-1',
      extractionData: {
        extraction: {
          content_layers_v1: {
            spreadsheet: {
              normalized_ticket_export: {
                family: 'ticket',
                sheets: [],
                rows: [{
                  id: 'ticket:sheet-1:4',
                  sheet_key: 'sheet-1',
                  sheet_name: 'Unit Tickets',
                  row_number: 4,
                  ticket_id: 'UT-100',
                  quantity: 1,
                  unit: 'Each',
                  rate: 315,
                  invoice_number: 'INV-200',
                  contract_line_item: null,
                  material: null,
                  service_item: 'Hazardous Tree 25 36 in',
                  ticket_family: 'mobile_unit_ticket',
                  evidence_ref: 'sheet:sheet-1:row:4',
                  column_headers: {},
                  field_evidence_ids: {},
                  confidence: 0.91,
                  missing_fields: [],
                }],
                summary: { row_count: 1, missing_quantity_rows: 0, missing_rate_rows: 0 },
                confidence: 0.91,
                gaps: [],
              },
            },
          },
        },
      },
      extracted: null,
    });

    assert.equal(result.persisted, true);
    assert.equal(result.mobileTicketCount, 0);
    assert.equal(result.loadTicketCount, 1);

    const unitTicketInsert = harness.inserts.find((entry) => entry.table === 'load_tickets');
    assert.ok(unitTicketInsert);
    const insertedRow = (unitTicketInsert?.payload as Array<Record<string, unknown>>)[0];
    assert.equal(insertedRow?.load_ticket_id, 'UT-100');
    assert.equal(insertedRow?.service_item, 'Hazardous Tree 25 36 in');
    assert.equal(insertedRow?.source_work_descriptor, 'Hazardous Tree 25 36 in');
    assert.equal(insertedRow?.ticket_family, 'mobile_unit_ticket');
  });

  it('writes ticket-document support extraction into canonical mobile_tickets', async () => {
    const harness = createAdminHarness();

    const result = await persistCanonicalSupportForDocument({
      admin: harness.admin as never,
      documentId: 'doc-2',
      projectId: 'project-2',
      organizationId: 'org-1',
      extractionData: null,
      extracted: {
        ticketId: 'T-200',
        quantityCY: 18,
        contractor: 'Acme Debris',
        subcontractor: 'Subhaul LLC',
        disposalSite: 'Alpha Landfill',
        material: 'Vegetative',
        truckId: 'Truck-9',
        truckCapacity: 20,
        projectCode: 'GOLDEN',
      },
    });

    assert.equal(result.persisted, true);
    assert.equal(result.skipped, false);
    assert.equal(result.mobileTicketCount, 1);

    const mobileTicketInsert = harness.inserts.find((entry) => entry.table === 'mobile_tickets');
    assert.ok(mobileTicketInsert);
    const insertedRow = (mobileTicketInsert?.payload as Array<Record<string, unknown>>)[0];
    assert.equal(insertedRow?.ticket_id, 'T-200');
    assert.equal(insertedRow?.contractor_name, 'Acme Debris');
    assert.equal(insertedRow?.subcontractor, 'Subhaul LLC');
    assert.equal(insertedRow?.disposal_site, 'Alpha Landfill');
    assert.equal(insertedRow?.material, 'Vegetative');
    assert.equal(insertedRow?.truck_id, 'Truck-9');
    assert.equal(insertedRow?.project_code, 'GOLDEN');
  });
});
