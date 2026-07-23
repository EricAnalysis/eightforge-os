import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureStorageObjectVersion,
  persistExtractionComplianceShadow,
  publishExtractionComplianceShadowNonBlocking,
  scheduleExtractionComplianceShadow,
} from '@/lib/extraction/persistence/complianceShadow';

describe('compliance shadow dual-write isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it('is non-fatal and never mutates the legacy extraction payload', async () => {
    const payload = {
      extraction: { mode: 'pdf_text', text_preview: 'unchanged' },
      fields: { typed_fields: { amount: 10 } },
    };
    const before = structuredClone(payload);
    const admin = {
      from: vi.fn(() => {
        throw new Error('new tables unavailable');
      }),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await publishExtractionComplianceShadowNonBlocking({
      admin: admin as never,
      organizationId: 'org-1',
      sourceDocumentId: 'document-1',
      sourceBytes: new TextEncoder().encode('source bytes').buffer,
      storageObjectVersion: 'object-id:2026-07-23T00:00:00.000Z',
      mediaType: 'text/plain',
      legacyExtractionPayload: payload,
      analysisJobId: 'job-1',
      analysisMode: 'heuristic',
    });

    expect(result).toBeNull();
    expect(payload).toEqual(before);
    expect(consoleError).toHaveBeenCalledWith(
      '[extractionComplianceShadow] non-fatal publish failure',
      expect.objectContaining({
        mode: 'shadow',
        sourceDocumentId: 'document-1',
      }),
    );
    consoleError.mockRestore();
  });

  it('hashes configured parser assignment independently of transient output success', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'build-digest-1');
    vi.stubEnv('OPENAI_API_KEY', 'configured');
    vi.stubEnv('UNSTRUCTURED_API_KEY', 'configured');
    const rpc = vi.fn(async () => ({
      data: {
        source_artifact_id: 'source-1',
        extraction_run_id: 'run-1',
        extraction_snapshot_id: 'snapshot-1',
        interpretation_snapshot_id: 'interpretation-1',
      },
      error: null,
    }));
    const base = {
      admin: { rpc } as never,
      organizationId: 'org-1',
      sourceDocumentId: 'document-1',
      sourceBytes: new TextEncoder().encode('same source').buffer,
      storageObjectVersion: 'object-1:version-1',
      mediaType: 'application/pdf',
      analysisMode: 'deterministic',
    };
    const first = await persistExtractionComplianceShadow({
      ...base,
      analysisJobId: 'job-1',
      legacyExtractionPayload: { extraction: { parsed_elements_v1: { status: 'failed' } } },
    });
    const second = await persistExtractionComplianceShadow({
      ...base,
      analysisJobId: 'job-2',
      legacyExtractionPayload: {
        extraction: {
          parsed_elements_v1: { status: 'available' },
          content_layers_v1: { pdf: { tables: [{ id: 'vision:p1:t1' }] } },
        },
      },
    });
    expect(first.parserManifestHash).toBe(second.parserManifestHash);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('bounds a storage identity lookup that never settles', async () => {
    const admin = {
      storage: {
        from: vi.fn(() => ({
          info: vi.fn(() => new Promise(() => undefined)),
        })),
      },
    };

    await expect(captureStorageObjectVersion(
      admin as never,
      'documents',
      'org-1/document-1.pdf',
      1,
    )).resolves.toBeNull();
  });

  it('bounds compliance publication that never settles', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'build-digest-1');
    const admin = {
      storage: {
        from: vi.fn(() => ({
          info: vi.fn(async () => ({
            data: { id: 'object-1', version: 'version-1' },
            error: null,
          })),
        })),
      },
      rpc: vi.fn(() => new Promise(() => undefined)),
    };

    const task = scheduleExtractionComplianceShadow({
      admin: admin as never,
      organizationId: 'org-1',
      sourceDocumentId: 'document-1',
      sourceBytes: new TextEncoder().encode('source bytes').buffer,
      storageBucket: 'documents',
      storagePath: 'org-1/document-1.pdf',
      storageVersionBeforeDownload: 'version-1:object-1',
      mediaType: 'application/pdf',
      legacyExtractionPayload: {},
      analysisJobId: 'job-1',
      analysisMode: 'deterministic',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(admin.rpc).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(task).resolves.toBeUndefined();
  });
});
