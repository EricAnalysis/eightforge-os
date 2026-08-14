import { gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getReasoningShadowTtlDays,
  persistReasoningShadowArtifact,
  REASONING_SHADOW_ARTIFACT_VERSION,
  REASONING_SHADOW_BUCKET,
  REASONING_SHADOW_CACHE_CONTROL,
  REASONING_SHADOW_MAX_UNCOMPRESSED_BYTES,
  reasoningShadowArtifactPath,
  type ReasoningShadowPersistenceInput,
} from './forgewingShadowPersistence';

const fixedNow = new Date('2026-08-14T12:00:00.000Z');

function input(overrides: Partial<ReasoningShadowPersistenceInput> = {}): ReasoningShadowPersistenceInput {
  const run = {
    runId: 'forgewing-run-0123456789abcdef',
    organizationId: 'organization-1',
    extractionSnapshotId: 'snapshot-1',
    inputSnapshotHash: 'a'.repeat(64),
  };
  const validatedBundle = {
    schemaVersion: 'forgewing-proposal-v1',
    authority: 'non_authoritative',
    run,
    taskId: 'task-1',
    taskType: 'region_classification',
    proposals: [{
      sourceDocumentId: 'document-1',
      sourceArtifactId: 'artifact-1',
      evidence: [{
        artifactId: 'observation-1',
        sourceDocumentId: 'document-1',
        sourceArtifactId: 'artifact-1',
      }],
    }],
    abstentions: [],
  };
  return {
    organizationId: 'organization-1',
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'artifact-1',
    resultStatus: 'applied',
    run,
    schemaVersion: 'forgewing-proposal-v1',
    runtime: {
      model: 'claude-test',
      promptTemplateId: 'region-classification',
      promptTemplateVersion: '1',
      warningCodes: [],
      calls: 1,
      inputTruncated: false,
    },
    validatedBundle,
    ...overrides,
  };
}

function storage(options: {
  uploadError?: Record<string, unknown> | null;
  existing?: Uint8Array | null;
  downloadError?: Record<string, unknown> | null;
} = {}) {
  const upload = vi.fn<(path: string, body: Uint8Array, options: Record<string, unknown>) => Promise<{
    error: Record<string, unknown> | null;
  }>>(async () => (
    { error: options.uploadError ?? null }
  ));
  const download = vi.fn<(path: string) => Promise<{
    data: { arrayBuffer(): Promise<ArrayBuffer> } | null;
    error: Record<string, unknown> | null;
  }>>(async () => ({
    data: options.existing == null ? null : {
      arrayBuffer: async () => Uint8Array.from(options.existing!).buffer,
    },
    error: options.downloadError ?? null,
  }));
  const from = vi.fn<(bucket: string) => { upload: typeof upload; download: typeof download }>(
    () => ({ upload, download }),
  );
  return { admin: { storage: { from } }, from, upload, download };
}

describe('reasoning shadow persistence', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('writes one deterministic gzip artifact with short private-bucket cache semantics', async () => {
    const store = storage();
    const result = await persistReasoningShadowArtifact({
      input: input(),
      admin: store.admin as never,
      now: () => fixedNow,
    });

    expect(result).toEqual({
      status: 'persisted',
      path: 'forgewing/organization-1/artifact-1/forgewing-run-0123456789abcdef.json.gz',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresAt: '2026-08-19T12:00:00.000Z',
      idempotent: false,
    });
    expect(store.from).toHaveBeenCalledWith(REASONING_SHADOW_BUCKET);
    const [path, body, options] = store.upload.mock.calls[0]!;
    expect(path).toBe(result.status === 'persisted' ? result.path : '');
    expect(options).toMatchObject({
      contentType: 'application/json',
      cacheControl: REASONING_SHADOW_CACHE_CONTROL,
      upsert: false,
      metadata: { contentEncoding: 'gzip', expiresAt: '2026-08-19T12:00:00.000Z' },
    });
    const artifact = JSON.parse(gunzipSync(body).toString('utf8'));
    expect(artifact).toMatchObject({
      artifactVersion: REASONING_SHADOW_ARTIFACT_VERSION,
      createdAt: '2026-08-14T12:00:00.000Z',
      expiresAt: '2026-08-19T12:00:00.000Z',
      source: { sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1' },
      runtime: { status: 'applied', schemaVersion: 'forgewing-proposal-v1' },
    });
    for (const forbidden of [
      'rawPrompt', 'rawProviderResponse', 'pdfBytes', 'ocrPayload', 'pageImageBase64',
      'fullExtractionSnapshot', 'apiKey', 'stackTrace', 'chainOfThought', 'reasoningTrace',
    ]) expect(JSON.stringify(artifact)).not.toContain(forbidden);
  });

  it('treats a duplicate with identical compressed bytes as idempotent success', async () => {
    const first = storage();
    await persistReasoningShadowArtifact({ input: input(), admin: first.admin as never, now: () => fixedNow });
    const bytes = first.upload.mock.calls[0]![1] as Uint8Array;
    const retry = storage({ uploadError: { statusCode: 409, message: 'Duplicate' }, existing: bytes });

    await expect(persistReasoningShadowArtifact({
      input: input(), admin: retry.admin as never, now: () => fixedNow,
    })).resolves.toMatchObject({ status: 'persisted', idempotent: true });
  });

  it('fails closed when the same run path already contains different bytes', async () => {
    const store = storage({
      uploadError: { statusCode: 409, message: 'already exists' },
      existing: new TextEncoder().encode('different'),
    });
    await expect(persistReasoningShadowArtifact({
      input: input(), admin: store.admin as never, now: () => fixedNow,
    })).resolves.toEqual({
      status: 'failed',
      reason: 'content_conflict',
      warningCode: 'forgewing_shadow_content_conflict',
    });
  });

  it('skips non-actionable statuses before creating a storage client', async () => {
    const store = storage();
    await expect(persistReasoningShadowArtifact({
      input: input({ resultStatus: 'skipped', validatedBundle: undefined }),
      admin: store.admin as never,
    })).resolves.toEqual({ status: 'skipped', reason: 'ineligible_status' });
    expect(store.from).not.toHaveBeenCalled();
  });

  it('rejects tenant, source, and path identity mismatches without upload', async () => {
    const cases = [
      input({ organizationId: 'organization-2' }),
      input({ sourceArtifactId: '../artifact' }),
      input({ sourceDocumentId: 'document-2' }),
    ];
    for (const candidate of cases) {
      const store = storage();
      const result = await persistReasoningShadowArtifact({ input: candidate, admin: store.admin as never });
      expect(result.status).toBe('failed');
      expect(store.upload).not.toHaveBeenCalled();
    }
    expect(reasoningShadowArtifactPath(input({ sourceArtifactId: 'a/b' }))).toBeNull();
    expect(reasoningShadowArtifactPath(input({ sourceArtifactId: 'a\\b' }))).toBeNull();
  });

  it('rejects undefined values and oversized artifacts before upload', async () => {
    const invalid = input();
    (invalid.validatedBundle as { unexpected?: unknown }).unexpected = undefined;
    const invalidStore = storage();
    await expect(persistReasoningShadowArtifact({
      input: invalid, admin: invalidStore.admin as never,
    })).resolves.toMatchObject({ status: 'failed', reason: 'serialization_failed' });
    expect(invalidStore.upload).not.toHaveBeenCalled();

    const huge = input();
    (huge.validatedBundle as { proposals: Array<Record<string, unknown>> }).proposals[0]!.large =
      'x'.repeat(REASONING_SHADOW_MAX_UNCOMPRESSED_BYTES);
    const hugeStore = storage();
    await expect(persistReasoningShadowArtifact({
      input: huge, admin: hugeStore.admin as never,
    })).resolves.toMatchObject({ status: 'failed', reason: 'artifact_too_large' });
    expect(hugeStore.upload).not.toHaveBeenCalled();
  });

  it('contains storage errors in the typed result', async () => {
    const store = storage({ uploadError: { statusCode: 503, message: 'unavailable' } });
    await expect(persistReasoningShadowArtifact({
      input: input(), admin: store.admin as never, now: () => fixedNow,
    })).resolves.toEqual({
      status: 'failed', reason: 'upload_failed', warningCode: 'forgewing_shadow_upload_failed',
    });
  });
});

describe('reasoning shadow retention configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, 5], ['3', 3], ['5', 5], ['invalid', 5], ['0', 5], ['-1', 5], ['31', 5],
  ])('maps %s to %s days', (raw, expected) => {
    expect(getReasoningShadowTtlDays(raw)).toBe(expected);
  });
});
