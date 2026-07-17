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

describe('generateAndPersistCanonicalIntelligence invoice persistence', () => {
  it('writes canonical invoice rows from the shared extraction blob on the invoice path', async () => {
    const persistCanonicalInvoiceForDocument = vi.fn(async (_params: unknown) => {
      void _params;
      return {
        persisted: true,
        skipped: false,
        invoiceCount: 1,
        lineCount: 2,
      };
    });
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

  it('persists shadow rate diff after invoice and contract assembly snapshots exist', async () => {
    const invoiceAssembly = {
      rows: [{
        row_id: 'invoice:r1',
        document_id: 'invoice-doc',
        source_table_key: 'invoice-table',
        source_document_family: 'invoice',
        assembly_semantic_mode: 'transactional',
        row_role: 'line_item',
        description: 'Collect remove haul 0-15 miles ROW to DMS',
        unit: 'CY',
        unit_price: 7.25,
        mileage_tier: '0-15',
        site_type: 'ROW_to_DMS',
        warnings: [],
        confidence: 1,
        evidence_refs: [{
          document_id: 'invoice-doc',
          page_number: 1,
          table_key: 'invoice-table',
          row_index: 1,
          cell_index: 1,
          raw_text: 'Collect remove haul',
          field_assigned: 'description',
          confidence: 1,
        }],
        raw_fragments: [],
      }],
      rejected_rows: [],
      unclassified_rows: [],
      assembly_warnings: [],
    };
    const contractAssembly = {
      rows: [{
        row_id: 'contract:r1',
        document_id: 'contract-doc',
        source_table_key: 'contract-table',
        source_document_family: 'contract',
        assembly_semantic_mode: 'schedule_definition',
        row_role: 'unit_rate_definition',
        description: 'Vegetative debris collection 0-15 miles ROW to DMS',
        unit: 'Cubic Yard',
        unit_price: 6.9,
        mileage_tier: '0-15',
        site_type: 'ROW_to_DMS',
        warnings: [],
        confidence: 0.95,
        evidence_refs: [{
          document_id: 'contract-doc',
          page_number: 8,
          table_key: 'contract-table',
          row_index: 1,
          cell_index: 1,
          raw_text: 'Vegetative debris collection',
          field_assigned: 'description',
          confidence: 1,
        }],
        raw_fragments: [],
      }],
    };
    let extractionData: Record<string, unknown> = {
      fields: { typed_fields: {} },
      extraction: { diagnostics: {} },
    };
    const updates: Array<Record<string, unknown>> = [];

    vi.doMock('@/lib/documentIntelligence', () => ({
      buildDocumentIntelligence: vi.fn(() => ({ classification: { family: 'invoice' } })),
    }));
    vi.doMock('@/lib/pipeline/documentPipeline', () => ({
      runDocumentPipeline: vi.fn(() => ({
        handled: true,
        extracted: { canonicalOperationalTableRowAssembly: invoiceAssembly },
      })),
      pipelineResultToIntelligence: vi.fn((result) => ({
        classification: { family: 'invoice' },
        extracted: result.extracted,
      })),
    }));
    vi.doMock('@/lib/contractInvoicePrimary', () => ({
      isContractInvoicePrimaryDocumentType: vi.fn(() => true),
      isContractInvoicePrimaryFamily: vi.fn(() => true),
    }));
    vi.doMock('@/lib/blobExtractionSelection', () => ({
      pickPreferredExtractionBlob: vi.fn(() => ({ id: 'extract-1', data: extractionData })),
    }));
    vi.doMock('@/lib/canonicalIntelligenceFamilies', () => ({
      supportsCanonicalIntelligencePersistence: vi.fn(() => false),
    }));
    vi.doMock('@/lib/server/intelligenceAdapter', () => ({
      INTELLIGENCE_PERSISTENCE_GENERATOR: 'document_intelligence',
      INTELLIGENCE_PERSISTENCE_VERSION: 'v2',
      materializePersistedExecutionTrace: vi.fn((value) => value),
      mapIntelligenceToPersistenceRows: vi.fn((params) => ({
        executionTrace: {
          generated_at: '2026-05-15T15:00:00.000Z',
          generator: 'document_intelligence',
          generator_version: 'v2',
          classification: { family: 'invoice' },
          extracted: params.intelligence.extracted,
          facts: {},
          decisions: [],
          flow_tasks: [],
        },
        decisions: [],
        tasks: [],
      })),
    }));
    vi.doMock('@/lib/server/documentPrecedence', () => ({
      loadPrecedenceAwareRelatedDocs: vi.fn(async () => [{
        id: 'contract-doc',
        document_type: 'contract',
        name: 'contract.pdf',
        title: 'Contract',
        is_governing: true,
        extraction: {
          extraction: {
            diagnostics: {
              canonicalContractRateScheduleAssembly: contractAssembly,
            },
          },
        },
      }]),
    }));
    vi.doMock('@/lib/server/transactionDataPersistence', () => ({
      persistTransactionDataForDocument: vi.fn(async () => ({ persisted: false, skipped: true, reason: 'not_transaction_data', rowCount: 0 })),
    }));
    vi.doMock('@/lib/server/invoicePersistence', () => ({
      persistCanonicalInvoiceForDocument: vi.fn(async () => ({ persisted: true, skipped: false, invoiceCount: 1, lineCount: 1 })),
    }));

    const admin = makePersistenceAdmin({ extractionData, updates, onExtractionUpdate: (next) => { extractionData = next; } });
    const { generateAndPersistCanonicalIntelligence } = await loadModule();
    await generateAndPersistCanonicalIntelligence({
      admin: admin as never,
      documentId: 'invoice-doc',
      organizationId: 'org-1',
      projectId: 'project-1',
    });

    const diagnostics = (extractionData.extraction as Record<string, unknown>).diagnostics as Record<string, unknown>;
    const diff = diagnostics.canonicalOperationalRateDiff as { summary?: { rows_exceeding_contract_ceiling?: number } };
    assert.equal(diff.summary?.rows_exceeding_contract_ceiling, 1);
    assert.deepEqual(diagnostics.canonicalOperationalRateDiffWarnings, []);
    assert.ok(updates.length >= 2);
  });

  it('persists a shadow rate diff warning when contract assembly snapshot is missing', async () => {
    const invoiceAssembly = {
      rows: [{
        row_id: 'invoice:r1',
        document_id: 'invoice-doc',
        source_table_key: 'invoice-table',
        source_document_family: 'invoice',
        assembly_semantic_mode: 'transactional',
        row_role: 'line_item',
        description: 'Collect remove haul',
        unit_price: 7.25,
        warnings: [],
        confidence: 1,
        evidence_refs: [],
        raw_fragments: [],
      }],
    };
    let extractionData: Record<string, unknown> = {
      fields: { typed_fields: {} },
      extraction: { diagnostics: {} },
    };
    const updates: Array<Record<string, unknown>> = [];

    vi.doMock('@/lib/documentIntelligence', () => ({
      buildDocumentIntelligence: vi.fn(() => ({ classification: { family: 'invoice' } })),
    }));
    vi.doMock('@/lib/pipeline/documentPipeline', () => ({
      runDocumentPipeline: vi.fn(() => ({
        handled: true,
        extracted: { canonicalOperationalTableRowAssembly: invoiceAssembly },
      })),
      pipelineResultToIntelligence: vi.fn((result) => ({
        classification: { family: 'invoice' },
        extracted: result.extracted,
      })),
    }));
    vi.doMock('@/lib/contractInvoicePrimary', () => ({
      isContractInvoicePrimaryDocumentType: vi.fn(() => true),
      isContractInvoicePrimaryFamily: vi.fn(() => true),
    }));
    vi.doMock('@/lib/blobExtractionSelection', () => ({
      pickPreferredExtractionBlob: vi.fn(() => ({ id: 'extract-1', data: extractionData })),
    }));
    vi.doMock('@/lib/canonicalIntelligenceFamilies', () => ({
      supportsCanonicalIntelligencePersistence: vi.fn(() => false),
    }));
    vi.doMock('@/lib/server/intelligenceAdapter', () => ({
      INTELLIGENCE_PERSISTENCE_GENERATOR: 'document_intelligence',
      INTELLIGENCE_PERSISTENCE_VERSION: 'v2',
      materializePersistedExecutionTrace: vi.fn((value) => value),
      mapIntelligenceToPersistenceRows: vi.fn(() => ({
        executionTrace: { classification: { family: 'invoice' }, facts: {}, decisions: [], flow_tasks: [] },
        decisions: [],
        tasks: [],
      })),
    }));
    vi.doMock('@/lib/server/documentPrecedence', () => ({
      loadPrecedenceAwareRelatedDocs: vi.fn(async () => []),
    }));
    vi.doMock('@/lib/server/transactionDataPersistence', () => ({
      persistTransactionDataForDocument: vi.fn(async () => ({ persisted: false, skipped: true, reason: 'not_transaction_data', rowCount: 0 })),
    }));
    vi.doMock('@/lib/server/invoicePersistence', () => ({
      persistCanonicalInvoiceForDocument: vi.fn(async () => ({ persisted: true, skipped: false, invoiceCount: 1, lineCount: 1 })),
    }));

    const admin = makePersistenceAdmin({ extractionData, updates, onExtractionUpdate: (next) => { extractionData = next; } });
    const { generateAndPersistCanonicalIntelligence } = await loadModule();
    await generateAndPersistCanonicalIntelligence({
      admin: admin as never,
      documentId: 'invoice-doc',
      organizationId: 'org-1',
      projectId: 'project-1',
    });

    const diagnostics = (extractionData.extraction as Record<string, unknown>).diagnostics as Record<string, unknown>;
    assert.deepEqual(diagnostics.canonicalOperationalRateDiffWarnings, [
      'canonicalOperationalRateDiff skipped: contract assembly snapshot missing',
    ]);
    assert.equal(diagnostics.canonicalOperationalRateDiff, undefined);
    assert.ok(updates.length >= 2);
  });
});

function makePersistenceAdmin(params: {
  extractionData: Record<string, unknown>;
  updates: Array<Record<string, unknown>>;
  onExtractionUpdate: (next: Record<string, unknown>) => void;
}) {
  const updateChain = {
    eq() {
      return updateChain;
    },
    then(resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve({ error: null }).then(resolve, reject);
    },
  };
  return {
    from(table: string) {
      if (table === 'documents') {
        return {
          select() {
            const chain = {
              eq() {
                return chain;
              },
              maybeSingle() {
                return Promise.resolve({
                  data: {
                    id: 'invoice-doc',
                    title: 'Invoice',
                    name: 'invoice.pdf',
                    document_type: 'invoice',
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
      }
      if (table === 'document_extractions') {
        return {
          select() {
            const chain = {
              eq() {
                return chain;
              },
              is() {
                return chain;
              },
              order() {
                return chain;
              },
              limit() {
                return chain;
              },
              maybeSingle() {
                return Promise.resolve({
                  data: { id: 'extract-1', data: params.extractionData },
                  error: null,
                });
              },
              then(resolve: (value: { data: unknown[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
                return Promise.resolve({
                  data: [{ id: 'extract-1', data: params.extractionData }],
                  error: null,
                }).then(resolve, reject);
              },
            };
            return chain;
          },
          update(next: { data: Record<string, unknown> }) {
            params.updates.push(next.data);
            params.extractionData = next.data;
            params.onExtractionUpdate(next.data);
            return updateChain;
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
}
