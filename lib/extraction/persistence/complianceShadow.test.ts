import { afterEach, describe, expect, it, vi } from 'vitest';

const runForgewingRegionClassification = vi.hoisted(() => vi.fn(async () => ({
  status: 'skipped' as const,
  reason: 'forgewing_disabled' as const,
})));

vi.mock('@/lib/forgewing/tasks/regionClassification', () => ({
  runForgewingRegionClassification,
}));

vi.mock('@/lib/forgewing/runtime/modelConfig', () => ({
  isForgewingShadowEnabled: () => process.env.FORGEWING_SHADOW_ENABLED === '1',
}));

import {
  captureStorageObjectVersion,
  persistExtractionComplianceShadow,
  publishExtractionComplianceShadowNonBlocking,
  scheduleExtractionComplianceShadow,
  withForgewingRegionClassificationShadow,
} from '@/lib/extraction/persistence/complianceShadow';

describe('compliance shadow dual-write isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    runForgewingRegionClassification.mockClear();
  });

  it('returns the deterministic Step 3 payload unchanged while Forgewing observes shadow input', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const payload = {
      interpretation_snapshot: { id: 'interpretation-1' },
      semantic_column_mappings: [{ id: 'mapping-1' }],
      interpretation_records: [{ id: 'record-1' }],
    };
    const deterministicBridge = vi.fn(async () => payload);
    const bridge = withForgewingRegionClassificationShadow(
      deterministicBridge,
      'organization-1',
      'document-1',
    );
    const bridgeInput = {
      extraction_snapshot_id: 'snapshot-1',
      chains: [],
      segments: [],
      cells: [],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    };

    await expect(bridge?.(bridgeInput as never)).resolves.toBe(payload);
    expect(deterministicBridge).toHaveBeenCalledWith(bridgeInput);
    expect(runForgewingRegionClassification).toHaveBeenCalledOnce();
  });

  it('does no Forgewing input work or provider orchestration when default-off', async () => {
    const payload = {
      interpretation_snapshot: null,
      semantic_column_mappings: [],
      interpretation_records: [],
    };
    const bridge = withForgewingRegionClassificationShadow(
      async () => payload,
      'organization-1',
      'document-1',
    );
    await expect(bridge?.({
      extraction_snapshot_id: 'snapshot-1',
      get chains() { throw new Error('must not slice when disabled'); },
      segments: [],
      cells: [],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    } as never)).resolves.toBe(payload);
    expect(runForgewingRegionClassification).not.toHaveBeenCalled();
  });

  it('contains Forgewing failure after deterministic Step 3 succeeds', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const payload = {
      interpretation_snapshot: null,
      semantic_column_mappings: [],
      interpretation_records: [],
    };
    runForgewingRegionClassification.mockRejectedValueOnce(new Error('provider failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bridge = withForgewingRegionClassificationShadow(
      async () => payload,
      'organization-1',
      'document-1',
    );

    await expect(bridge?.({
      extraction_snapshot_id: 'snapshot-1',
      chains: [],
      segments: [],
      cells: [],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    } as never)).resolves.toBe(payload);
    expect(consoleError).toHaveBeenCalledWith(
      '[forgewingShadow] non-fatal region classification failure',
      expect.objectContaining({ mode: 'shadow', error: 'provider failed' }),
    );
    consoleError.mockRestore();
  });

  it.each([
    ['success', { status: 'applied', warnings: [], metadata: { calls: 1, inputTruncated: false } }],
    ['timeout', { status: 'abstained', warnings: ['provider_timeout'], metadata: { calls: 1, inputTruncated: false } }],
    ['schema rejection', { status: 'abstained', warnings: ['model_schema_rejected'], metadata: { calls: 1, inputTruncated: false } }],
  ])('keeps deterministic Step 3 identical on Forgewing %s', async (_case, outcome) => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    runForgewingRegionClassification.mockResolvedValueOnce(outcome as never);
    const payload = {
      interpretation_snapshot: { id: 'deterministic' },
      semantic_column_mappings: [],
      interpretation_records: [],
    };
    const bridge = withForgewingRegionClassificationShadow(
      async () => payload,
      'organization-1',
      'document-1',
    );
    await expect(bridge?.({
      extraction_snapshot_id: 'snapshot-1',
      chains: [],
      segments: [],
      cells: [],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    } as never)).resolves.toBe(payload);
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

  it('bounds pending Step 1 publication without changing the caller lifecycle', async () => {
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
      locatedObservations: { pages: [] },
      analysisJobId: 'job-1',
      analysisMode: 'deterministic',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(admin.rpc).toHaveBeenCalledWith(
      'resolve_extraction_step1_source',
      expect.any(Object),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(task).resolves.toBeUndefined();
  });

  it('keeps rejected Step 1 publication nonfatal', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'build-digest-1');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const admin = {
      storage: {
        from: vi.fn(() => ({
          info: vi.fn(async () => ({
            data: { id: 'object-1', version: 'version-1' },
            error: null,
          })),
        })),
      },
      rpc: vi.fn(async () => {
        throw new Error('Step 1 unavailable');
      }),
    };

    await expect(scheduleExtractionComplianceShadow({
      admin: admin as never,
      organizationId: 'org-1',
      sourceDocumentId: 'document-1',
      sourceBytes: new TextEncoder().encode('source bytes').buffer,
      storageBucket: 'documents',
      storagePath: 'org-1/document-1.pdf',
      storageVersionBeforeDownload: 'version-1:object-1',
      mediaType: 'application/pdf',
      legacyExtractionPayload: {},
      locatedObservations: { pages: [] },
      analysisJobId: 'job-1',
      analysisMode: 'deterministic',
    })).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      '[extractionStep1Shadow] non-fatal publish failure',
      expect.objectContaining({
        mode: 'shadow',
        sourceDocumentId: 'document-1',
      }),
    );
    consoleError.mockRestore();
  });
});
