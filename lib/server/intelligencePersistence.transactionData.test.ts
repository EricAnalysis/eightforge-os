import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

const MOCKED_MODULES = [
  '@/lib/documentIntelligence',
  '@/lib/pipeline/documentPipeline',
  '@/lib/contractInvoicePrimary',
  '@/lib/blobExtractionSelection',
  '@/lib/canonicalIntelligenceFamilies',
  '@/lib/server/intelligenceAdapter',
  '@/lib/server/documentPrecedence',
  '@/lib/server/transactionDataPersistence',
] as const;

async function loadModule() {
  return import('@/lib/server/intelligencePersistence');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const moduleId of MOCKED_MODULES) {
    vi.doUnmock(moduleId);
  }
});

describe('generateAndPersistCanonicalIntelligence transaction_data persistence', () => {
  it('persists normalized transaction data after the pipeline normalize stage', async () => {
    const persistTransactionDataForDocument = vi.fn(async () => ({
      persisted: true,
      skipped: false,
      rowCount: 1,
    }));

    const extracted = {
      sourceType: 'transaction_data',
      rowCount: 1,
      records: [
        {
          invoice_number: 'INV-100',
          transaction_number: 'TX-1001',
          rate_code: 'RC-01',
          billing_rate_key: 'RC01',
          site_material_key: 's:alpha landfill|m:vegetative',
          transaction_quantity: 10,
          extended_cost: 100.5,
          invoice_date: '2026-01-05',
          source_sheet_name: 'ticket_query',
          source_row_number: 3,
          raw_row: { 'Invoice #': 'INV-100' },
        },
      ],
      summary: {
        row_count: 1,
        total_extended_cost: 100.5,
        total_transaction_quantity: 10,
        inferred_date_range_start: '2026-01-05',
        inferred_date_range_end: '2026-01-05',
      },
      rollups: {
        total_extended_cost: 100.5,
        total_transaction_quantity: 10,
      },
    };

    vi.doMock('@/lib/documentIntelligence', () => ({
      buildDocumentIntelligence: vi.fn(() => ({
        classification: { family: 'spreadsheet' },
      })),
    }));
    vi.doMock('@/lib/pipeline/documentPipeline', () => ({
      runDocumentPipeline: vi.fn(() => ({
        handled: true,
        extracted,
      })),
      pipelineResultToIntelligence: vi.fn(() => ({
        classification: { family: 'spreadsheet' },
      })),
    }));
    vi.doMock('@/lib/contractInvoicePrimary', () => ({
      isContractInvoicePrimaryDocumentType: vi.fn(() => false),
      isContractInvoicePrimaryFamily: vi.fn(() => false),
    }));
    vi.doMock('@/lib/blobExtractionSelection', () => ({
      hasUsableExtractionBlobData: vi.fn(() => true),
      pickPreferredExtractionBlob: vi.fn(() => null),
    }));
    vi.doMock('@/lib/canonicalIntelligenceFamilies', () => ({
      supportsCanonicalIntelligencePersistence: vi.fn(() => false),
    }));
    vi.doMock('@/lib/server/intelligenceAdapter', () => ({
      INTELLIGENCE_PERSISTENCE_GENERATOR: 'document_intelligence',
      INTELLIGENCE_PERSISTENCE_VERSION: 'v2',
      materializePersistedExecutionTrace: vi.fn((value) => value),
      mapIntelligenceToPersistenceRows: vi.fn(() => ({
        executionTrace: {
          generated_at: '2026-04-04T18:00:00.000Z',
          generator: 'document_intelligence',
          generator_version: 'v2',
          classification: { family: 'spreadsheet' },
          pipeline: null,
          related_document_ids: [],
          extraction_snapshot_id: null,
          source_document_ids: [],
          facts: {},
          decisions: [],
          flow_tasks: [],
          audit_notes: [],
          summary: null,
        },
        decisions: [],
        tasks: [],
      })),
    }));
    vi.doMock('@/lib/server/documentPrecedence', () => ({
      loadPrecedenceAwareRelatedDocs: vi.fn(async () => []),
    }));
    vi.doMock('@/lib/server/transactionDataPersistence', () => ({
      persistTransactionDataForDocument,
    }));

    const updateChain = {
      eq() {
        return updateChain;
      },
      then(resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };

    const admin = {
      from(table: string) {
        if (table !== 'documents') {
          throw new Error(`Unexpected table ${table}`);
        }

        return {
          select() {
            const chain = {
              eq() {
                return chain;
              },
              maybeSingle() {
                return Promise.resolve({
                  data: {
                    id: 'doc-1',
                    title: 'Ticket Query Export',
                    name: 'ticket_query.xlsx',
                    document_type: 'transaction_data',
                    project_id: 'project-1',
                    projects: { name: 'Williamson County' },
                  },
                  error: null,
                });
              },
            };

            return chain;
          },
          update() {
            return updateChain;
          },
        };
      },
    };

    const { generateAndPersistCanonicalIntelligence } = await loadModule();
    const result = await generateAndPersistCanonicalIntelligence({
      admin: admin as never,
      documentId: 'doc-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      extractionData: { extraction: { mode: 'spreadsheet' } },
    });

    assert.equal(result.handled, false);
    assert.equal(result.family, 'spreadsheet');
    assert.equal(result.execution_trace_persisted, true);
    assert.equal(persistTransactionDataForDocument.mock.calls.length, 1);
    assert.deepEqual(persistTransactionDataForDocument.mock.calls[0]?.[0], {
      admin,
      documentId: 'doc-1',
      projectId: 'project-1',
      extracted,
    });
  });
});
