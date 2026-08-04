import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const adminFrom = vi.hoisted(() => vi.fn());
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => ({ from: adminFrom }) }));

import {
  publishProjectTruthShadow,
  type CanonicalProjectTruthShadowPublicationInput,
  type PublishProjectTruthShadowDependencies,
} from './publishProjectTruthShadow';
import type {
  ShadowArtifactPart,
  ShadowArtifactWrittenPart,
} from './shadowArtifactDestination';
import { writeShadowArtifactParts } from './shadowArtifactDestination';

function input(): CanonicalProjectTruthShadowPublicationInput {
  const result = {
    status: 'VALIDATED',
    blocked_reasons: [],
    findings: [],
    summary: {
      cross_document_rate_verification: null,
      contract_invoice_reconciliation: null,
      invoice_transaction_reconciliation: null,
      reconciliation: null,
      exposure: null,
    },
    rulesApplied: [],
    validator_status: 'READY',
    validator_open_items: [],
    validator_blockers: [],
    contract_invoice_reconciliation: null,
    invoice_transaction_reconciliation: null,
    cross_document_rate_verification: null,
    reconciliation: null,
    exposure: null,
  };
  return {
    projectId: 'project-1',
    runId: 'run-1',
    triggerSource: 'manual',
    inputsSnapshotHash: 'snapshot-hash',
    validatorInput: {
      project: { id: 'project-1', organization_id: 'organization-1' },
      documents: [],
      governingDocumentIds: {},
      assembledContractPricingRows: Object.freeze([]),
      sourceArtifactSnapshot: Object.freeze([]),
      contractValidationContext: null,
      invoices: [],
      invoiceLines: [],
      invoiceLineToRateMap: new Map(),
      transactionData: { datasets: [], rows: [] },
    },
    effectiveResult: result,
    persistedFindings: [],
  } as unknown as CanonicalProjectTruthShadowPublicationInput;
}

const completedRun = {
  id: 'run-1',
  status: 'complete',
  run_at: '2026-08-02T10:00:00.000Z',
  completed_at: '2026-08-02T10:01:00.000Z',
  triggered_by: 'manual',
  triggered_by_user_id: null,
  rule_version: 'v1',
  inputs_snapshot_hash: 'snapshot-hash',
};

function adaptedFixture() {
  const transactionDigest = createHash('sha256').update('').digest('hex');
  return {
    registryWithoutTransactions: {},
    core: { construction: { mode: 'shadow_only', persisted: false }, transactions: {
      count: 0, digest: transactionDigest, part: 'registry.transactions.ndjson.gz',
    } },
    transactionPlan: {
      count: 0,
      digest: transactionDigest,
      createGzipStream: () => ({
        stream: Readable.from([]),
        verification: Promise.resolve({ count: 0, digest: transactionDigest }),
      }),
    },
    sourceDocuments: [],
    sourceSnapshotId: 'source-snapshot',
    gaps: [],
    inputCounts: { transactionRows: 0 },
    outputCounts: { transactions: 0 },
  };
}

async function bodyBytes(part: ShadowArtifactPart): Promise<Uint8Array> {
  const produced = part.bodyFactory();
  if (produced.body instanceof Uint8Array) return produced.body;
  const chunks: Buffer[] = [];
  for await (const chunk of produced.body as Readable) chunks.push(Buffer.from(chunk));
  await produced.producerVerification;
  return new Uint8Array(Buffer.concat(chunks));
}

function capturingDestination(attempts: Map<string, Uint8Array>[]) {
  return vi.fn(async (params: {
    parts: readonly ShadowArtifactPart[];
    terminalManifestFactory(parts: readonly ShadowArtifactWrittenPart[]): ShadowArtifactPart;
  }) => {
    const bytes = new Map<string, Uint8Array>();
    const written: ShadowArtifactWrittenPart[] = [];
    for (const part of params.parts) {
      const body = await bodyBytes(part);
      bytes.set(part.path, body);
      written.push({
        path: part.path,
        byteDigest: createHash('sha256').update(body).digest('hex'),
        byteLength: body.byteLength,
        duplicate: false,
      });
    }
    const manifest = params.terminalManifestFactory(written);
    const manifestBody = await bodyBytes(manifest);
    bytes.set(manifest.path, manifestBody);
    written.push({
      path: manifest.path,
      byteDigest: createHash('sha256').update(manifestBody).digest('hex'),
      byteLength: manifestBody.byteLength,
      duplicate: false,
    });
    attempts.push(bytes);
    return { status: 'written' as const, parts: written };
  });
}

function dependencies(destination: PublishProjectTruthShadowDependencies['destination']): PublishProjectTruthShadowDependencies {
  return {
    loadValidationRun: async () => completedRun,
    adaptSource: (() => adaptedFixture()) as unknown as PublishProjectTruthShadowDependencies['adaptSource'],
    buildParity: (() => ({ comparisons: [], amountDeltas: {}, quantityDeltas: {} })) as PublishProjectTruthShadowDependencies['buildParity'],
    destination,
  };
}

describe('canonical Project Truth publisher amendment coverage', () => {
  it('uses the admin client only for the persisted validation run, never mutable source identity', async () => {
    const chain = {
      select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: completedRun, error: null })),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    adminFrom.mockImplementation((table: string) => {
      if (table !== 'project_validation_runs') throw new Error(`unexpected source query: ${table}`);
      return chain;
    });
    const attempts: Map<string, Uint8Array>[] = [];
    const deps = dependencies({ writeShadowArtifactParts: capturingDestination(attempts) });
    const { loadValidationRun: _injectedRun, ...withoutInjectedRun } = deps;

    await expect(publishProjectTruthShadow(input(), withoutInjectedRun)).resolves.toMatchObject({ status: 'published' });
    expect(adminFrom.mock.calls.map(([table]) => table)).toEqual(['project_validation_runs']);
    expect(adminFrom).not.toHaveBeenCalledWith('documents');
    expect(adminFrom).not.toHaveBeenCalledWith('extraction_source_artifacts');
    adminFrom.mockReset();
  });

  it('derives generatedAt only from the persisted run and emits byte-identical deterministic artifacts', async () => {
    const attempts: Map<string, Uint8Array>[] = [];
    const destination = { writeShadowArtifactParts: capturingDestination(attempts) };
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1).mockReturnValueOnce(2)
      .mockReturnValueOnce(99_999).mockReturnValueOnce(100_000);

    const first = await publishProjectTruthShadow(input(), dependencies(destination));
    const second = await publishProjectTruthShadow(input(), dependencies(destination));
    now.mockRestore();

    expect(first).toEqual(second);
    expect(attempts).toHaveLength(2);
    const firstManifest = [...attempts[0]!.entries()].find(([path]) => path.endsWith('/manifest.json'))![1];
    expect(JSON.parse(new TextDecoder().decode(firstManifest)).generatedAt).toBe(completedRun.completed_at);
    expect([...attempts[0]!.keys()]).toEqual([...attempts[1]!.keys()]);
    for (const [path, bytes] of attempts[0]!) {
      expect(attempts[1]!.get(path)).toEqual(bytes);
    }
  });

  it('uses run_at when completed_at is absent', async () => {
    const attempts: Map<string, Uint8Array>[] = [];
    const destination = { writeShadowArtifactParts: capturingDestination(attempts) };
    await publishProjectTruthShadow(input(), {
      ...dependencies(destination),
      loadValidationRun: async () => ({ ...completedRun, completed_at: null }),
    });
    const manifest = [...attempts[0]!.entries()].find(([path]) => path.endsWith('/manifest.json'))![1];
    expect(JSON.parse(new TextDecoder().decode(manifest)).generatedAt).toBe(completedRun.run_at);
  });

  it.each([
    ['incomplete status', { status: 'running' }],
    ['mismatched input snapshot', { inputs_snapshot_hash: 'different' }],
  ])('fails freshness closed for %s with one normalized error and zero writes', async (_name, mutation) => {
    const destination = { writeShadowArtifactParts: vi.fn() };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await publishProjectTruthShadow(input(), {
      ...dependencies(destination),
      loadValidationRun: async () => ({ ...completedRun, ...mutation }),
    });

    expect(result).toMatchObject({ status: 'failed', stage: 'source_run' });
    expect(destination.writeShadowArtifactParts).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[canonicalProjectTruthShadow] publication failed',
      expect.objectContaining({ stage: 'source_run', errorCategory: 'source_unavailable' }),
    );
    consoleError.mockRestore();
  });

  it.each([
    ['adaptation', 'adaptation', 'adaptation_error'],
    ['destination', 'destination', 'upload_error'],
    ['stream', 'destination', 'stream_error'],
  ])('contains a %s failure with no manifest and exactly one categorized error', async (failure, stage, category) => {
    const destination = { writeShadowArtifactParts: vi.fn(async () => {
      throw new Error(failure === 'stream' ? 'gzip stream failed' : 'upload failed');
    }) };
    const deps = failure === 'adaptation'
      ? {
        ...dependencies(destination),
        adaptSource: (() => { throw new Error('adapter failed'); }) as PublishProjectTruthShadowDependencies['adaptSource'],
      }
      : dependencies(destination);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await publishProjectTruthShadow(input(), deps);

    expect(result).toMatchObject({ status: 'failed', stage });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[canonicalProjectTruthShadow] publication failed',
      expect.objectContaining({ stage, errorCategory: category }),
    );
    expect(destination.writeShadowArtifactParts).toHaveBeenCalledTimes(failure === 'adaptation' ? 0 : 1);
    consoleError.mockRestore();
  });

  it.each(['upload', 'stream'] as const)(
    'keeps the manifest absent and logs once for an integrated %s failure',
    async (failure) => {
      const uploadedPaths: string[] = [];
      const bucket = {
        list: vi.fn(async () => ({ data: [], error: null })),
        info: vi.fn(async () => ({ data: null, error: null })),
        upload: vi.fn(async (path: string, body: Uint8Array | NodeJS.ReadableStream) => {
          for await (const _chunk of body instanceof Uint8Array ? Readable.from([body]) : body) {
            // Consume the body so producer verification and byte metering settle.
          }
          uploadedPaths.push(path);
          return path.endsWith('registry.transactions.ndjson.gz') && failure === 'upload'
            ? { error: { statusCode: 500, message: 'injected upload failure' } }
            : { error: null };
        }),
      };
      const base = adaptedFixture();
      const adapted = failure === 'stream'
        ? {
          ...base,
          transactionPlan: {
            ...base.transactionPlan,
            createGzipStream: () => ({
              stream: Readable.from((async function* () {
                yield Buffer.from('row\n');
                throw new Error('injected stream failure');
              })()),
              verification: Promise.resolve({ count: 0, digest: base.transactionPlan.digest }),
            }),
          },
        }
        : base;
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const result = await publishProjectTruthShadow(input(), {
        ...dependencies({
          writeShadowArtifactParts: (params) => writeShadowArtifactParts({
            ...params,
            admin: { storage: { from: () => bucket } },
          }),
        }),
        adaptSource: (() => adapted) as unknown as PublishProjectTruthShadowDependencies['adaptSource'],
      });

      expect(result).toMatchObject({ status: 'failed', stage: 'destination' });
      expect(uploadedPaths.some((path) => path.endsWith('/manifest.json'))).toBe(false);
      expect(consoleError).toHaveBeenCalledTimes(1);
      consoleError.mockRestore();
    },
  );
});
