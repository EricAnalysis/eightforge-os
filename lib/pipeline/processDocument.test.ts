import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachLocatedOcrObservations } from '@/lib/extraction/ocrObservationSidecar';

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
  '@/lib/extraction/persistence/complianceShadow',
] as const;

type SetupParams = {
  documentId?: string;
  documentType: string;
  projectId?: string | null;
  extractionMode?: string;
  canonicalResult?: Record<string, unknown>;
  canonicalError?: Error;
  heuristicDecisions?: Array<Record<string, unknown>>;
  storageVersions?: readonly [string | null, string | null];
  pendingStorageVersion?: boolean;
  pendingShadowPublisher?: boolean;
};

async function loadProcessDocument() {
  const importedProcessDocument = await import('@/lib/pipeline/processDocument');
  return importedProcessDocument.processDocument;
}

beforeAll(async () => {
  // Warm Vitest's transformed module graph outside the per-test timeout. Each test still
  // resets the module cache so its isolated doMock factories remain authoritative.
  await import('@/lib/pipeline/processDocument');
  vi.resetModules();
}, 30_000);

function buildCanonicalResult(overrides: Record<string, unknown> = {}) {
  return {
    handled: true,
    family: 'contract',
    intelligence: null,
    execution_trace_persisted: true,
    transaction_data_persisted: true,
    canonical_persistence_error: null,
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
  attachLocatedOcrObservations(extractionPayload, {
    pages: [{
      page_number: 1,
      render_sha256: 'a'.repeat(64),
      width: 1224,
      height: 1584,
      text_detected: false,
      words: [],
    }],
  });
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
  const setDocumentStatus = vi.fn(async (_input: { status: string }) => {
    void _input;
  });
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
  const storageVersions = params.storageVersions ?? [
    'object-1:version-1',
    'object-1:version-1',
  ];
  const captureStorageObjectVersion = params.pendingStorageVersion
    ? vi.fn(async () => null)
    : vi.fn()
        .mockResolvedValueOnce(storageVersions[0])
        .mockResolvedValue(storageVersions[1]);
  const publishExtractionComplianceShadowNonBlocking = params.pendingShadowPublisher
    ? vi.fn((input: Record<string, unknown>) => {
        void input;
        return new Promise<null>(() => undefined);
      })
    : vi.fn(async (input: Record<string, unknown>) => {
        void input;
        return null;
      });
  const scheduleExtractionComplianceShadow = vi.fn((input: {
    storageVersionBeforeDownload: string | null;
    storageBucket: string;
    storagePath: string;
  } & Record<string, unknown>) => {
    return (async () => {
      if (!input.storageVersionBeforeDownload) return;
      const after = await captureStorageObjectVersion(
        admin as never,
        input.storageBucket,
        input.storagePath,
      );
      await publishExtractionComplianceShadowNonBlocking({
        ...input,
        storageObjectVersion:
          input.storageVersionBeforeDownload === after
            ? input.storageVersionBeforeDownload
            : null,
      });
    })();
  });
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
  vi.doMock('@/lib/extraction/persistence/complianceShadow', () => ({
    captureStorageObjectVersion,
    publishExtractionComplianceShadowNonBlocking,
    scheduleExtractionComplianceShadow,
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
      captureStorageObjectVersion,
      publishExtractionComplianceShadowNonBlocking,
      scheduleExtractionComplianceShadow,
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
  it('captures one storage generation and completes the non-fatal compliance write', async () => {
    const { processDocument, spies } = await setupProcessDocumentTest({
      documentType: 'contract',
    });
    const result = await processDocument({
      organizationId: 'org-1',
      documentId: 'doc-1',
      analysisMode: 'deterministic',
      triggeredBy: 'manual',
    });
    expect(result.success).toBe(true);
    await vi.waitFor(() => {
      expect(spies.scheduleExtractionComplianceShadow).toHaveBeenCalledWith(
        expect.objectContaining({
          locatedObservations: expect.objectContaining({
            pages: [expect.objectContaining({ page_number: 1 })],
          }),
        }),
      );
      expect(spies.captureStorageObjectVersion).toHaveBeenCalledTimes(3);
      expect(spies.publishExtractionComplianceShadowNonBlocking).toHaveBeenCalledWith(
        expect.objectContaining({ storageObjectVersion: 'object-1:version-1' }),
      );
    });
  });

  it('refuses to bind downloaded bytes to a changed storage generation', async () => {
    const { processDocument, spies } = await setupProcessDocumentTest({
      documentType: 'contract',
      storageVersions: ['object-1:version-1', 'object-1:version-2'],
    });
    const result = await processDocument({
      organizationId: 'org-1',
      documentId: 'doc-1',
      analysisMode: 'deterministic',
      triggeredBy: 'manual',
    });
    expect(result.success).toBe(true);
    await vi.waitFor(() => {
      expect(spies.publishExtractionComplianceShadowNonBlocking).toHaveBeenCalledWith(
        expect.objectContaining({ storageObjectVersion: null }),
      );
    });
  });

  it('continues when bounded storage identity capture yields no identity', async () => {
    const pendingStorage = await setupProcessDocumentTest({
      documentType: 'contract',
      pendingStorageVersion: true,
    });
    await expect(pendingStorage.processDocument({
      organizationId: 'org-1',
      documentId: 'doc-1',
      analysisMode: 'deterministic',
      triggeredBy: 'manual',
    })).resolves.toMatchObject({ success: true });
    expect(pendingStorage.spies.scheduleExtractionComplianceShadow).toHaveBeenCalledOnce();
  });

  it('does not wait for pending Step 1 shadow publication', async () => {
    const registerBackgroundTask = vi.fn();
    const pendingPublisher = await setupProcessDocumentTest({
      documentType: 'contract',
      pendingShadowPublisher: true,
    });
    await expect(pendingPublisher.processDocument({
      organizationId: 'org-1',
      documentId: 'doc-1',
      analysisMode: 'deterministic',
      triggeredBy: 'manual',
      registerBackgroundTask,
    })).resolves.toMatchObject({ success: true });
    expect(pendingPublisher.spies.scheduleExtractionComplianceShadow).toHaveBeenCalledOnce();
    expect(registerBackgroundTask).toHaveBeenCalledWith(expect.any(Promise));
  });

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

  it('fails spreadsheet transaction_data reprocesses when canonical persistence returns a trace failure', async () => {
    const { processDocument, spies } = await setupProcessDocumentTest({
      documentId: 'spreadsheet-doc',
      documentType: 'transaction_data',
      extractionMode: 'spreadsheet',
      canonicalResult: {
        family: 'spreadsheet',
        execution_trace_persisted: false,
        transaction_data_persisted: true,
        canonical_persistence_error: 'Execution trace persistence failed for spreadsheet-doc: documents.intelligence_trace update timed out',
      },
    });

    const result = await processDocument({
      documentId: 'spreadsheet-doc',
      organizationId: 'org-1',
      analysisMode: 'deterministic',
      triggeredBy: 'manual',
    });

    expect(result).toMatchObject({
      success: false,
      jobId: 'job-1',
      processing_status: 'failed',
      error: 'Execution trace persistence failed for spreadsheet-doc: documents.intelligence_trace update timed out',
    });
    expect(spies.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        status: 'failed',
        completedAt: expect.any(String),
        errorMessage: 'Execution trace persistence failed for spreadsheet-doc: documents.intelligence_trace update timed out',
        resultExtractionId: null,
      }),
    );
    expect(spies.setDocumentStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'spreadsheet-doc',
        status: 'failed',
        processingError: 'Execution trace persistence failed for spreadsheet-doc: documents.intelligence_trace update timed out',
        processedAt: expect.any(String),
      }),
    );
    expect(spies.setDocumentStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'decisioned' }),
    );
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

  it('logs canonical document processing as document/project activity, not decision activity', async () => {
    const { processDocument, spies } = await setupProcessDocumentTest({
      documentId: 'canonical-doc',
      documentType: 'invoice',
      projectId: 'project-123',
      extractionMode: 'pdf_text',
      canonicalResult: {
        handled: true,
        family: 'invoice',
        execution_trace_persisted: true,
      },
    });

    await processDocument({
      documentId: 'canonical-doc',
      organizationId: 'org-1',
      analysisMode: 'deterministic',
      triggeredBy: 'manual',
    });

    expect(spies.logActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        project_id: 'project-123',
        entity_type: 'document',
        entity_id: 'canonical-doc',
        event_type: 'updated',
        new_value: expect.objectContaining({
          action: 'pipeline_processing_canonical_intelligence',
          document_id: 'canonical-doc',
          project_id: 'project-123',
          validation_refresh_requested: true,
        }),
      }),
    );
    expect(spies.logActivityEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'decision',
        entity_id: 'canonical-doc',
      }),
    );
  });
});
