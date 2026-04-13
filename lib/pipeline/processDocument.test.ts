import { afterEach, describe, expect, it, vi } from 'vitest';

const MOCKED_MODULES = [
  '@/lib/server/supabaseAdmin',
  '@/lib/server/analysisJobService',
  '@/lib/server/documentExtraction',
  '@/lib/server/extractionNormalizer',
  '@/lib/server/documentAiEnrichment',
  '@/lib/server/aiDecisionPersistence',
  '@/lib/pipeline/decisionEngine',
  '@/lib/pipeline/workflowOrchestrator',
  '@/lib/server/ruleEngine',
  '@/lib/server/decisionEngine',
  '@/lib/server/workflowEngine',
  '@/lib/server/activity/logActivityEvent',
  '@/lib/server/intelligencePersistence',
  '@/lib/pipeline/projectRerun',
] as const;

type SetupParams = {
  documentId?: string;
  documentType: string;
  projectId?: string | null;
  extractionMode?: string;
  canonicalResult?: Record<string, unknown>;
  canonicalError?: Error;
  heuristicDecisions?: Array<Record<string, unknown>>;
};

async function loadProcessDocument() {
  const module = await import('@/lib/pipeline/processDocument');
  return module.processDocument;
}

function buildCanonicalResult(overrides: Record<string, unknown> = {}) {
  return {
    handled: true,
    family: 'contract',
    intelligence: null,
    execution_trace_persisted: true,
    decisions_created: 0,
    decisions_updated: 0,
    decisions_deleted: 0,
    decisions_preserved: 0,
    tasks_created: 0,
    tasks_updated: 0,
    tasks_deleted: 0,
    tasks_preserved: 0,
    legacy_decisions_suppressed: 0,
    legacy_tasks_cancelled: 0,
    ...overrides,
  };
}

async function setupProcessDocumentTest(params: SetupParams) {
  const documentId = params.documentId ?? 'doc-1';
  const extractionPayload = {
    fields: {},
    extraction: {
      mode: params.extractionMode ?? 'ocr_recovery',
      text_preview: 'Recovered OCR contract text',
    },
  };
  const insertedExtraction = {
    id: 'ext-1',
    data: extractionPayload,
    created_at: '2026-03-29T12:00:00.000Z',
  };

  const documentSelectChain = {
    eq: vi.fn(),
    single: vi.fn(async () => ({
      data: {
        id: documentId,
        title: 'Test document',
        name: 'test-document.pdf',
        document_type: params.documentType,
        domain: 'public_works',
        status: 'uploaded',
        storage_path: `documents/${documentId}.pdf`,
        organization_id: 'org-1',
        project_id: params.projectId ?? 'project-123',
      },
      error: null,
    })),
  };
  documentSelectChain.eq.mockReturnValue(documentSelectChain);

  const extractionInsertSelectChain = {
    single: vi.fn(async () => ({
      data: insertedExtraction,
      error: null,
    })),
  };
  const extractionInsertChain = {
    select: vi.fn(() => extractionInsertSelectChain),
  };

  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn(() => documentSelectChain),
        };
      }

      if (table === 'document_extractions') {
        return {
          insert: vi.fn(() => extractionInsertChain),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    }),
    storage: {
      from: vi.fn(() => ({
        download: vi.fn(async () => ({
          data: {
            arrayBuffer: async () => new TextEncoder().encode('pdf-bytes').buffer,
            type: 'application/pdf',
          },
          error: null,
        })),
      })),
    },
  };

  const createAnalysisJob = vi.fn(async () => ({
    id: 'job-1',
  }));
  const updateJobStatus = vi.fn(async () => undefined);
  const setDocumentStatus = vi.fn(async () => undefined);
  const extractDocument = vi.fn(async () => extractionPayload);
  const normalizeExtraction = vi.fn(async () => undefined);
  const runAiEnrichment = vi.fn(async () => ({
    confidence_note: null,
  }));
  const persistAiEnrichmentDecisions = vi.fn(async () => undefined);
  const generateAndPersistDecisions = vi.fn(async () => params.heuristicDecisions ?? []);
  const orchestrateWorkflows = vi.fn(async () => undefined);
  const evaluateDocument = vi.fn(async () => ({
    matched: [],
    facts: {},
  }));
  const createDecisionsFromRules = vi.fn(async () => ({
    decisions: [],
    created: 0,
    updated: 0,
    skipped: 0,
  }));
  const createTasksFromDecisions = vi.fn(async () => ({
    created: 0,
    skipped: 0,
  }));
  const logActivityEvent = vi.fn(async () => undefined);
  const getProjectRerunStoredDocTypes = vi.fn(() => []);
  const generateAndPersistCanonicalIntelligence = params.canonicalError
    ? vi.fn(async () => {
        throw params.canonicalError;
      })
    : vi.fn(async () => buildCanonicalResult(params.canonicalResult));

  vi.doMock('@/lib/server/supabaseAdmin', () => ({
    getSupabaseAdmin: vi.fn(() => admin),
  }));
  vi.doMock('@/lib/server/analysisJobService', () => ({
    createAnalysisJob,
    updateJobStatus,
    setDocumentStatus,
  }));
  vi.doMock('@/lib/server/documentExtraction', () => ({
    extractDocument,
  }));
  vi.doMock('@/lib/server/extractionNormalizer', () => ({
    normalizeExtraction,
  }));
  vi.doMock('@/lib/server/documentAiEnrichment', () => ({
    runAiEnrichment,
  }));
  vi.doMock('@/lib/server/aiDecisionPersistence', () => ({
    persistAiEnrichmentDecisions,
  }));
  vi.doMock('@/lib/pipeline/decisionEngine', () => ({
    generateAndPersistDecisions,
  }));
  vi.doMock('@/lib/pipeline/workflowOrchestrator', () => ({
    orchestrateWorkflows,
  }));
  vi.doMock('@/lib/server/ruleEngine', () => ({
    evaluateDocument,
  }));
  vi.doMock('@/lib/server/decisionEngine', () => ({
    createDecisionsFromRules,
  }));
  vi.doMock('@/lib/server/workflowEngine', () => ({
    createTasksFromDecisions,
  }));
  vi.doMock('@/lib/server/activity/logActivityEvent', () => ({
    logActivityEvent,
  }));
  vi.doMock('@/lib/server/intelligencePersistence', () => ({
    generateAndPersistCanonicalIntelligence,
  }));
  vi.doMock('@/lib/pipeline/projectRerun', () => ({
    getProjectRerunStoredDocTypes,
  }));

  const processDocument = await loadProcessDocument();

  return {
    processDocument,
    spies: {
      createAnalysisJob,
      updateJobStatus,
      setDocumentStatus,
      extractDocument,
      normalizeExtraction,
      runAiEnrichment,
      persistAiEnrichmentDecisions,
      generateAndPersistCanonicalIntelligence,
      evaluateDocument,
      createDecisionsFromRules,
      createTasksFromDecisions,
      generateAndPersistDecisions,
      orchestrateWorkflows,
      logActivityEvent,
      getProjectRerunStoredDocTypes,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const moduleId of MOCKED_MODULES) {
    vi.doUnmock(moduleId);
  }
});

describe('processDocument canonical persistence gating', () => {
  it('keeps Williamson-style contract failures at extracted and blocks all downstream decisioning', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { processDocument, spies } = await setupProcessDocumentTest({
      documentId: 'williamson-doc',
      documentType: 'williamson_contract',
      extractionMode: 'ocr_recovery',
      canonicalError: new Error('Williamson canonical write failed'),
    });

    const result = await processDocument({
      documentId: 'williamson-doc',
      organizationId: 'org-1',
      analysisMode: 'deterministic',
      triggeredBy: 'manual',
    });

    expect(result).toMatchObject({
      success: false,
      jobId: 'job-1',
      processing_status: 'extracted',
      error: 'Williamson canonical write failed',
    });
    expect(spies.setDocumentStatus.mock.calls.map(([call]) => call.status)).toEqual([
      'processing',
      'extracted',
      'extracted',
    ]);
    expect(spies.setDocumentStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'decisioned' }),
    );
    expect(spies.setDocumentStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(spies.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        status: 'failed',
        errorMessage: 'Williamson canonical write failed',
        resultExtractionId: 'ext-1',
      }),
    );
    expect(spies.evaluateDocument).not.toHaveBeenCalled();
    expect(spies.createDecisionsFromRules).not.toHaveBeenCalled();
    expect(spies.createTasksFromDecisions).not.toHaveBeenCalled();
    expect(spies.generateAndPersistDecisions).not.toHaveBeenCalled();
    expect(spies.orchestrateWorkflows).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[processDocument] canonical intelligence persistence failed',
      expect.objectContaining({
        documentId: 'williamson-doc',
        organizationId: 'org-1',
        projectId: 'project-123',
        documentType: 'williamson_contract',
        extractionMode: 'ocr_recovery',
        error: 'Williamson canonical write failed',
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[processDocument] blocking decisioned status after canonical persistence failure',
      expect.objectContaining({
        documentId: 'williamson-doc',
        projectId: 'project-123',
        documentType: 'williamson_contract',
        executionTracePersisted: false,
      }),
    );
  });

  it('blocks invoice decisioning when canonical work returns without persisting the execution trace', async () => {
    const { processDocument, spies } = await setupProcessDocumentTest({
      documentId: 'invoice-doc',
      documentType: 'invoice',
      extractionMode: 'pdf_text',
      canonicalResult: {
        family: 'invoice',
        execution_trace_persisted: false,
      },
    });

    const result = await processDocument({
      documentId: 'invoice-doc',
      organizationId: 'org-1',
      analysisMode: 'deterministic',
      triggeredBy: 'manual',
    });

    expect(result).toMatchObject({
      success: false,
      jobId: 'job-1',
      processing_status: 'extracted',
      error: 'Canonical intelligence trace did not persist for invoice invoice-doc.',
    });
    expect(spies.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        status: 'failed',
        resultExtractionId: 'ext-1',
      }),
    );
    expect(spies.evaluateDocument).not.toHaveBeenCalled();
    expect(spies.generateAndPersistDecisions).not.toHaveBeenCalled();
    expect(spies.orchestrateWorkflows).not.toHaveBeenCalled();
  });

  it('preserves the old decisioned path for non-contract primary documents', async () => {
    const { processDocument, spies } = await setupProcessDocumentTest({
      documentId: 'notice-doc',
      documentType: 'notice',
      extractionMode: 'pdf_text',
      canonicalResult: {
        handled: false,
        family: 'notice',
        execution_trace_persisted: false,
      },
      heuristicDecisions: [{ id: 'heuristic-1' }],
    });

    const result = await processDocument({
      documentId: 'notice-doc',
      organizationId: 'org-1',
      analysisMode: 'deterministic',
      triggeredBy: 'manual',
    });

    expect(result).toMatchObject({
      success: true,
      jobId: 'job-1',
      processing_status: 'decisioned',
    });
    expect(spies.generateAndPersistDecisions).toHaveBeenCalledTimes(1);
    expect(spies.orchestrateWorkflows).toHaveBeenCalledTimes(1);
    expect(spies.setDocumentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'decisioned' }),
    );
    expect(spies.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        status: 'completed',
        resultExtractionId: 'ext-1',
      }),
    );
  });
});
