import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const afterMock = vi.hoisted(() => vi.fn());
vi.mock('next/server', () => ({ after: afterMock }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { scheduleCanonicalProjectTruthShadowPublication } from '@/lib/canonical/publication/publishProjectTruthShadow';
import {
  CANONICAL_SHADOW_ARTIFACT_BUCKET,
  writeShadowArtifactParts,
  type ShadowArtifactBody,
} from '@/lib/canonical/publication/shadowArtifactDestination';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function bytesFrom(body: ShadowArtifactBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

describe('canonical shadow publication flow isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH;
    delete process.env.EIGHTFORGE_CANONICAL_SHADOW_PROJECT_IDS;
  });

  it('returns synchronously without lifecycle work when the flag is disabled', () => {
    scheduleCanonicalProjectTruthShadowPublication({
      projectId: 'project-1',
    } as Parameters<typeof scheduleCanonicalProjectTruthShadowPublication>[0]);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it('registers an after callback and uses the caught detached fallback when registration fails', async () => {
    process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH = 'all';
    const input = {
      projectId: 'project-1',
      runId: 'run-1',
    } as Parameters<typeof scheduleCanonicalProjectTruthShadowPublication>[0];

    scheduleCanonicalProjectTruthShadowPublication(input);
    expect(afterMock).toHaveBeenCalledWith(expect.any(Function));

    afterMock.mockReset();
    afterMock.mockImplementation(() => { throw new Error('no request lifecycle'); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    scheduleCanonicalProjectTruthShadowPublication(input);
    expect(consoleWarn).toHaveBeenCalledWith(
      '[canonicalProjectTruthShadow] lifecycle registration failed',
      expect.objectContaining({ blocking: false, mode: 'shadow' }),
    );
    await vi.waitFor(() => expect(consoleInfo).toHaveBeenCalledWith(
      '[canonicalProjectTruthShadow] publication started',
      expect.objectContaining({ projectId: 'project-1', runId: 'run-1' }),
    ));
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      '[canonicalProjectTruthShadow] publication failed',
      expect.objectContaining({ blocking: false, errorCategory: 'source_unavailable' }),
    ));
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleInfo.mockRestore();
  });

  it('writes streams incrementally, keeps the manifest terminal, and suppresses identical retries', async () => {
    const stored = new Map<string, Uint8Array>();
    const storedMetadata = new Map<string, Readonly<Record<string, unknown>>>();
    const uploadOrder: string[] = [];
    const uploadOptions: unknown[] = [];
    const info = vi.fn(async (path: string) => ({
      data: { metadata: storedMetadata.get(path) },
      error: null,
    }));
    const download = vi.fn();
    const from = vi.fn(() => ({
      list: vi.fn(async () => ({ data: [], error: null })),
      upload: vi.fn(async (path: string, body: ShadowArtifactBody, options: unknown) => {
        uploadOrder.push(path);
        uploadOptions.push(options);
        const bytes = await bytesFrom(body);
        if (stored.has(path)) return { error: { statusCode: 409, message: 'already exists' } };
        stored.set(path, bytes);
        storedMetadata.set(path, (options as { metadata?: Readonly<Record<string, unknown>> }).metadata ?? {});
        return { error: null };
      }),
      info,
      download,
    }));
    const admin = { storage: { from } };
    const prefix = 'project/project-1/run/run-1/publication-1/';
    const core = new TextEncoder().encode('core');
    const request = () => writeShadowArtifactParts({
      projectId: 'project-1',
      runId: 'run-1',
      publicationId: 'publication-1',
      admin,
      parts: [
        {
          path: `${prefix}registry.core.json.gz`,
          contentType: 'application/json',
          expectedByteDigest: digest(core),
          bodyFactory: () => ({ body: core }),
        },
        {
          path: `${prefix}registry.transactions.ndjson.gz`,
          contentType: 'application/x-ndjson',
          comparisonDigest: 'transaction-digest',
          bodyFactory: () => ({
            body: Readable.from([Buffer.from('row-1\n'), Buffer.from('row-2\n')]),
            producerVerification: Promise.resolve({ count: 2 }),
          }),
        },
      ],
      terminalManifestFactory: (parts) => {
        expect(parts).toHaveLength(2);
        const body = new TextEncoder().encode('manifest');
        return {
          path: `${prefix}manifest.json`,
          contentType: 'application/json',
          expectedByteDigest: digest(body),
          bodyFactory: () => ({ body }),
        };
      },
    });

    await expect(request()).resolves.toMatchObject({ status: 'written' });
    await expect(request()).resolves.toMatchObject({ status: 'duplicate_suppressed' });
    expect(from).toHaveBeenCalledWith(CANONICAL_SHADOW_ARTIFACT_BUCKET);
    expect(uploadOrder).toEqual([
      `${prefix}registry.core.json.gz`,
      `${prefix}registry.transactions.ndjson.gz`,
      `${prefix}manifest.json`,
      `${prefix}registry.core.json.gz`,
      `${prefix}registry.transactions.ndjson.gz`,
      `${prefix}manifest.json`,
    ]);
    expect(uploadOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ upsert: false }),
    ]));
    expect(info).toHaveBeenCalled();

    const corePath = `${prefix}registry.core.json.gz`;
    const originalCore = stored.get(corePath);
    storedMetadata.set(corePath, {});
    await expect(request()).rejects.toThrow('differs at immutable path');
    expect(download).not.toHaveBeenCalled();

    storedMetadata.set(corePath, { comparisonDigest: 'different-digest' });
    await expect(request()).rejects.toThrow('differs at immutable path');
    expect(stored.get(corePath)).toBe(originalCore);
    expect(download).not.toHaveBeenCalled();
  });

  it('fails closed when the same run prefix contains a divergent publication identity', async () => {
    const upload = vi.fn();
    const admin = {
      storage: {
        from: vi.fn(() => ({
          list: vi.fn(async () => ({ data: [{ name: 'different-publication' }], error: null })),
          upload,
          info: vi.fn(),
        })),
      },
    };
    const body = new TextEncoder().encode('core');

    await expect(writeShadowArtifactParts({
      projectId: 'project-1',
      runId: 'run-1',
      publicationId: 'publication-1',
      admin,
      parts: [{
        path: 'project/project-1/run/run-1/publication-1/core.json',
        contentType: 'application/json',
        expectedByteDigest: digest(body),
        bodyFactory: () => ({ body }),
      }],
      terminalManifestFactory: () => ({
        path: 'project/project-1/run/run-1/publication-1/manifest.json',
        contentType: 'application/json',
        bodyFactory: () => ({ body }),
      }),
    })).rejects.toThrow('idempotency_conflict');
    expect(upload).not.toHaveBeenCalled();
  });

  it('never writes a manifest after a non-manifest upload or stream failure', async () => {
    const successfulPaths: string[] = [];
    const upload = vi.fn(async (path: string, body: ShadowArtifactBody) => {
      await bytesFrom(body);
      if (path.endsWith('registry.transactions.ndjson.gz')) {
        return { error: { statusCode: 500, message: 'upload failed' } };
      }
      successfulPaths.push(path);
      return { error: null };
    });
    const admin = { storage: { from: vi.fn(() => ({
      list: vi.fn(async () => ({ data: [], error: null })),
      upload,
      info: vi.fn(),
    })) } };
    const prefix = 'project/project-1/run/run-1/publication-1/';
    const core = new TextEncoder().encode('core');

    await expect(writeShadowArtifactParts({
      projectId: 'project-1', runId: 'run-1', publicationId: 'publication-1', admin,
      parts: [
        { path: `${prefix}registry.core.json.gz`, contentType: 'application/json', expectedByteDigest: digest(core), bodyFactory: () => ({ body: core }) },
        { path: `${prefix}registry.transactions.ndjson.gz`, contentType: 'application/x-ndjson', comparisonDigest: 'transactions', bodyFactory: () => ({ body: Readable.from([Buffer.from('row\n')]) }) },
      ],
      terminalManifestFactory: () => ({
        path: `${prefix}manifest.json`, contentType: 'application/json', expectedByteDigest: digest(core), bodyFactory: () => ({ body: core }),
      }),
    })).rejects.toThrow('Failed to upload');
    expect(successfulPaths).toEqual([`${prefix}registry.core.json.gz`]);
    expect(successfulPaths.some((path) => path.endsWith('manifest.json'))).toBe(false);

    const brokenStream = Readable.from((async function* () {
      yield Buffer.from('row\n');
      throw new Error('stream serialization failed');
    })());
    await expect(writeShadowArtifactParts({
      projectId: 'project-1', runId: 'run-2', publicationId: 'publication-2', admin,
      parts: [{
        path: 'project/project-1/run/run-2/publication-2/registry.transactions.ndjson.gz',
        contentType: 'application/x-ndjson', comparisonDigest: 'transactions',
        bodyFactory: () => ({ body: brokenStream }),
      }],
      terminalManifestFactory: () => ({
        path: 'project/project-1/run/run-2/publication-2/manifest.json', contentType: 'application/json', expectedByteDigest: digest(core), bodyFactory: () => ({ body: core }),
      }),
    })).rejects.toThrow('stream serialization failed');
    expect(successfulPaths.some((path) => path.includes('run-2') && path.endsWith('manifest.json'))).toBe(false);
  });

  it('treats a manifest upload failure as a failed publication', async () => {
    const successfulPaths: string[] = [];
    const upload = vi.fn(async (path: string, body: ShadowArtifactBody) => {
      await bytesFrom(body);
      if (path.endsWith('manifest.json')) return { error: { statusCode: 500, message: 'manifest upload failed' } };
      successfulPaths.push(path);
      return { error: null };
    });
    const admin = { storage: { from: vi.fn(() => ({
      list: vi.fn(async () => ({ data: [], error: null })), upload, info: vi.fn(),
    })) } };
    const prefix = 'project/project-1/run/run-1/publication-1/';
    const core = new TextEncoder().encode('core');
    await expect(writeShadowArtifactParts({
      projectId: 'project-1', runId: 'run-1', publicationId: 'publication-1', admin,
      parts: [{ path: `${prefix}core.json`, contentType: 'application/json', expectedByteDigest: digest(core), bodyFactory: () => ({ body: core }) }],
      terminalManifestFactory: () => ({ path: `${prefix}manifest.json`, contentType: 'application/json', expectedByteDigest: digest(core), bodyFactory: () => ({ body: core }) }),
    })).rejects.toThrow('manifest upload failed');
    expect(successfulPaths).toEqual([`${prefix}core.json`]);
  });
});
