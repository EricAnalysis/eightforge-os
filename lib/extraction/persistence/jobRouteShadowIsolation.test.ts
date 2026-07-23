import { afterEach, describe, expect, it, vi } from 'vitest';

describe('job processing compliance shadow isolation', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('does not wait for pending storage identity or shadow publication', async () => {
    const documentChain = {
      eq: vi.fn(),
      single: vi.fn(async () => ({
        data: {
          id: 'document-1',
          title: 'Contract',
          name: 'contract.pdf',
          document_type: 'contract',
          status: 'uploaded',
          storage_path: 'org-1/contract.pdf',
          organization_id: 'org-1',
          project_id: null,
        },
        error: null,
      })),
    };
    documentChain.eq.mockReturnValue(documentChain);
    const extractionChain = {
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: { id: 'extraction-1', data: {}, created_at: '2026-07-23T00:00:00Z' },
            error: null,
          })),
        })),
      })),
    };
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'documents') {
          return { select: vi.fn(() => documentChain) };
        }
        if (table === 'document_extractions') return extractionChain;
        throw new Error(`Unexpected table ${table}`);
      }),
      storage: {
        from: vi.fn(() => ({
          download: vi.fn(async () => ({
            data: {
              arrayBuffer: async () => new TextEncoder().encode('pdf bytes').buffer,
              type: 'application/pdf',
            },
            error: null,
          })),
        })),
      },
    };
    const pendingShadowPublication = new Promise<null>(() => undefined);
    const scheduleExtractionComplianceShadow = vi.fn(
      () => pendingShadowPublication,
    );
    const after = vi.fn((task: Promise<unknown>) => {
      void task;
    });

    vi.doMock('next/server', async (importOriginal) => ({
      ...await importOriginal<typeof import('next/server')>(),
      after,
    }));
    vi.doMock('@/lib/server/getActorContext', () => ({
      getActorContext: vi.fn(async () => ({
        ok: true,
        actor: { organizationId: 'org-1' },
      })),
    }));
    vi.doMock('@/lib/server/supabaseAdmin', () => ({
      getSupabaseAdmin: vi.fn(() => admin),
    }));
    vi.doMock('@/lib/server/analysisJobService', () => ({
      getJob: vi.fn(async () => ({
        id: 'job-1',
        document_id: 'document-1',
        organization_id: 'org-1',
        status: 'queued',
        analysis_mode: 'deterministic',
      })),
      updateJobStatus: vi.fn(async () => undefined),
      setDocumentStatus: vi.fn(async () => undefined),
    }));
    vi.doMock('@/lib/server/documentExtraction', () => ({
      extractDocument: vi.fn(async () => ({
        fields: {},
        extraction: { mode: 'pdf_text', text_preview: 'contract text' },
      })),
    }));
    vi.doMock('@/lib/server/documentAiEnrichment', () => ({
      runAiEnrichment: vi.fn(),
    }));
    vi.doMock('@/lib/server/aiDecisionPersistence', () => ({
      persistAiEnrichmentDecisions: vi.fn(),
    }));
    vi.doMock('@/lib/server/heuristicDecisionEngine', () => ({
      runDecisionEngine: vi.fn(async () => []),
    }));
    vi.doMock('@/lib/server/decisionPersistence', () => ({
      persistDecisions: vi.fn(),
      documentDecisionsToPersisted: vi.fn(),
    }));
    vi.doMock('@/lib/server/legacyWorkflowEngine', () => ({
      runWorkflowEngine: vi.fn(async () => undefined),
    }));
    vi.doMock('@/lib/server/workflowTasks', () => ({
      createWorkflowTasksFromDecisions: vi.fn(),
    }));
    vi.doMock('@/lib/validator/triggerProjectValidation', () => ({
      triggerProjectValidation: vi.fn(),
    }));
    vi.doMock('@/lib/extraction/persistence/complianceShadow', () => ({
      captureStorageObjectVersion: vi.fn(async () => 'version-1:object-1'),
      scheduleExtractionComplianceShadow,
    }));

    const { POST } = await import('@/app/api/jobs/process/[jobId]/route');
    const response = await POST(
      new Request('http://localhost/api/jobs/process/job-1', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'job-1' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      jobId: 'job-1',
    });
    expect(scheduleExtractionComplianceShadow).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledWith(pendingShadowPublication);
  });
});
