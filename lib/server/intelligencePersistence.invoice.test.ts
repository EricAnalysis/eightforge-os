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
  '@/lib/server/invoicePersistence',
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

describe('generateAndPersistCanonicalIntelligence invoice persistence', () => {
  it('writes canonical invoice rows from the shared extraction blob on the invoice path', async () => {
    const persistCanonicalInvoiceForDocument = vi.fn(async () => ({
      persisted: true,
      skipped: false,
      invoiceCount: 1,
      lineCount: 2,
    }));
    const persistTransactionDataForDocument = vi.fn(async () => ({
      persisted: false,
      skipped: true,
      reason: 'not_transaction_data' as const,
      rowCount: 0,
    }));

    vi.doMock('@/lib/documentIntelligence', () => ({
      buildDocumentIntelligence: vi.fn(() => ({
        classification: { family: 'invoice' },
      })),
    }));
    vi.doMock('@/lib/pipeline/documentPipeline', () => ({
      runDocumentPipeline: vi.fn(() => ({
        handled: true,
        extracted: {
          invoiceNumber: 'INV-100',
        },
      })),
      pipelineResultToIntelligence: vi.fn(() => ({
        classification: { family: 'invoice' },
      })),
    }));
    vi.doMock('@/lib/contractInvoicePrimary', () => ({
      isContractInvoicePrimaryDocumentType: vi.fn(() => true),
      isContractInvoicePrimaryFamily: vi.fn(() => true),
    }));
    vi.doMock('@/lib/blobExtractionSelection', () => ({
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
          classification: { family: 'invoice' },
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
    vi.doMock('@/lib/server/invoicePersistence', () => ({
      persistCanonicalInvoiceForDocument,
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
                    title: 'Invoice 100',
                    name: 'invoice-100.pdf',
                    document_type: 'invoice',
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

    const extractionData = {
      fields: {
        typed_fields: {
          schema_type: 'invoice',
          invoice_number: 'INV-100',
        },
      },
    } as Record<string, unknown>;

    const { generateAndPersistCanonicalIntelligence } = await loadModule();
    const result = await generateAndPersistCanonicalIntelligence({
      admin: admin as never,
      documentId: 'doc-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      extractionData,
    });

    assert.equal(result.handled, false);
    assert.equal(result.family, 'invoice');
    assert.equal(result.execution_trace_persisted, true);
    assert.equal(result.canonical_persistence_error, null);
    assert.equal(persistCanonicalInvoiceForDocument.mock.calls.length, 1);
    assert.deepEqual(persistCanonicalInvoiceForDocument.mock.calls[0]?.[0], {
      admin,
      documentId: 'doc-1',
      projectId: 'project-1',
      extractionData,
    });
  });
});
