import assert from 'node:assert/strict';
import { afterEach, beforeAll, describe, it, vi } from 'vitest';

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
  '@/lib/server/supportTicketPersistence',
] as const;

async function loadModule() {
  return import('@/lib/server/intelligencePersistence');
}

beforeAll(async () => {
  // Warm Vitest's transformed module graph outside the per-test timeout. Tests still reset
  // the module cache so their isolated persistence doMock factories remain authoritative.
  await import('@/lib/server/intelligencePersistence');
  vi.resetModules();
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const moduleId of MOCKED_MODULES) {
    vi.doUnmock(moduleId);
  }
});

describe('generateAndPersistCanonicalIntelligence support persistence', () => {
  it('writes canonical support rows for non-transaction support workbooks', async () => {
    const persistCanonicalSupportForDocument = vi.fn(async (_params: unknown) => {
      void _params;
      return {
        persisted: true,
        skipped: false,
        mobileTicketCount: 2,
        loadTicketCount: 0,
      };
    });
    const persistTransactionDataForDocument = vi.fn(async () => ({
      persisted: false,
      skipped: true,
      reason: 'not_transaction_data' as const,
      rowCount: 0,
    }));
    const persistCanonicalInvoiceForDocument = vi.fn(async () => ({
      persisted: false,
      skipped: true,
      reason: 'not_invoice' as const,
      invoiceCount: 0,
      lineCount: 0,
    }));

    const extractionData = {
      extraction: {
        content_layers_v1: {
          spreadsheet: {
            normalized_ticket_export: {
              family: 'ticket',
              rows: [{ id: 'ticket:sheet-1:3' }],
            },
          },
        },
      },
    } as Record<string, unknown>;

    const extracted = {
      fileName: 'support-workbook.xlsx',
      rowCount: 2,
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
    vi.doMock('@/lib/server/invoicePersistence', () => ({
      persistCanonicalInvoiceForDocument,
    }));
    vi.doMock('@/lib/server/supportTicketPersistence', () => ({
      persistCanonicalSupportForDocument,
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
                    title: 'Support Workbook',
                    name: 'support-workbook.xlsx',
                    document_type: 'spreadsheet',
                    project_id: 'project-1',
                    projects: { name: 'Golden Project' },
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
      extractionData,
    });

    assert.equal(result.handled, false);
    assert.equal(result.family, 'spreadsheet');
    assert.equal(result.execution_trace_persisted, true);
    assert.equal(result.canonical_persistence_error, null);
    assert.equal(persistCanonicalSupportForDocument.mock.calls.length, 1);
    assert.deepEqual(persistCanonicalSupportForDocument.mock.calls[0]?.[0], {
      admin,
      documentId: 'doc-1',
      projectId: 'project-1',
      organizationId: 'org-1',
      extractionData,
      extracted,
    });
  });

  it('surfaces canonical support persistence failures when structured support tables are unavailable', async () => {
    const persistCanonicalSupportForDocument = vi.fn(async () => ({
      persisted: false,
      skipped: true,
      reason: 'missing_table' as const,
      mobileTicketCount: 0,
      loadTicketCount: 0,
    }));
    const persistTransactionDataForDocument = vi.fn(async () => ({
      persisted: false,
      skipped: true,
      reason: 'not_transaction_data' as const,
      rowCount: 0,
    }));
    const persistCanonicalInvoiceForDocument = vi.fn(async () => ({
      persisted: false,
      skipped: true,
      reason: 'not_invoice' as const,
      invoiceCount: 0,
      lineCount: 0,
    }));

    vi.doMock('@/lib/documentIntelligence', () => ({
      buildDocumentIntelligence: vi.fn(() => ({
        classification: { family: 'ticket' },
      })),
    }));
    vi.doMock('@/lib/pipeline/documentPipeline', () => ({
      runDocumentPipeline: vi.fn(() => ({
        handled: true,
        extracted: {
          ticketId: 'T-900',
          quantityCY: 5,
          contractor: 'Acme Debris',
        },
      })),
      pipelineResultToIntelligence: vi.fn(() => ({
        classification: { family: 'ticket' },
      })),
    }));
    vi.doMock('@/lib/contractInvoicePrimary', () => ({
      isContractInvoicePrimaryDocumentType: vi.fn(() => false),
      isContractInvoicePrimaryFamily: vi.fn(() => false),
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
          classification: { family: 'ticket' },
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
    vi.doMock('@/lib/server/supportTicketPersistence', () => ({
      persistCanonicalSupportForDocument,
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
                    id: 'doc-2',
                    title: 'Ticket Support PDF',
                    name: 'ticket-support.pdf',
                    document_type: 'ticket',
                    project_id: 'project-1',
                    projects: { name: 'Golden Project' },
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
      documentId: 'doc-2',
      organizationId: 'org-1',
      projectId: 'project-1',
      extractionData: null,
    });

    assert.equal(result.handled, false);
    assert.equal(
      result.canonical_persistence_error,
      'Support persistence failed for doc-2: missing_table.',
    );
  });
});
