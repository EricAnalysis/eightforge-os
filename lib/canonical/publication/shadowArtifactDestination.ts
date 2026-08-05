import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const CANONICAL_SHADOW_ARTIFACT_BUCKET = 'canonical-shadow-artifacts';

export type ShadowArtifactBody = Uint8Array | NodeJS.ReadableStream;

export type ShadowArtifactPart = {
  readonly path: string;
  readonly contentType: string;
  readonly contentEncoding?: 'gzip';
  /** A fresh body is required for every attempted write; streams are single-use. */
  readonly bodyFactory: () => {
    readonly body: ShadowArtifactBody;
    readonly producerVerification?: Promise<unknown>;
  };
  /** Optional precondition for small in-memory parts. */
  readonly expectedByteDigest?: string;
  /** Trusted deterministic content digest persisted for bounded duplicate checks. */
  readonly comparisonDigest?: string;
};

export type ShadowArtifactWrittenPart = {
  readonly path: string;
  readonly byteDigest: string;
  readonly byteLength: number;
  readonly duplicate: boolean;
};

export type ShadowArtifactWriteResult = {
  readonly status: 'written' | 'duplicate_suppressed';
  readonly parts: readonly ShadowArtifactWrittenPart[];
};

type StorageError = {
  readonly message?: string;
  readonly statusCode?: string | number;
  readonly status?: string | number;
};

type StorageBucket = {
  list(path: string, options: {
    limit: number;
    sortBy: { column: 'name'; order: 'asc' };
  }): Promise<{
    data: readonly { name: string }[] | null;
    error: StorageError | null;
  }>;
  upload(path: string, body: ShadowArtifactBody, options: {
    contentType: string;
    cacheControl: string;
    upsert: false;
    duplex?: 'half';
    metadata?: Record<string, string>;
  }): Promise<{ error: StorageError | null }>;
  info(path: string): Promise<{
    data: { metadata?: Readonly<Record<string, unknown>> } | null;
    error: StorageError | null;
  }>;
};

export type ShadowArtifactDestination = {
  readonly writeShadowArtifactParts: typeof writeShadowArtifactParts;
};

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isAlreadyExistsError(error: StorageError): boolean {
  const status = String(error.statusCode ?? error.status ?? '');
  const message = (error.message ?? '').toLowerCase();
  return status === '409'
    || message.includes('already exists')
    || message.includes('duplicate');
}

function validatePath(path: string, expectedPrefix: string): void {
  if (!path || path.startsWith('/') || path.includes('..') || !path.startsWith(expectedPrefix)) {
    throw new Error(`Invalid shadow artifact path: ${path}`);
  }
}

function instrumentBody(body: ShadowArtifactBody, signal?: AbortSignal): {
  readonly uploadBody: ShadowArtifactBody;
  readonly integrity: Promise<{ readonly byteDigest: string; readonly byteLength: number }>;
} {
  if (body instanceof Uint8Array && !signal) {
    return {
      uploadBody: body,
      integrity: Promise.resolve({ byteDigest: sha256Bytes(body), byteLength: body.byteLength }),
    };
  }

  const hash = createHash('sha256');
  let byteLength = 0;
  let resolveIntegrity!: (value: { readonly byteDigest: string; readonly byteLength: number }) => void;
  let rejectIntegrity!: (reason: unknown) => void;
  const integrity = new Promise<{ readonly byteDigest: string; readonly byteLength: number }>(
    (resolve, reject) => {
      resolveIntegrity = resolve;
      rejectIntegrity = reject;
    },
  );
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      byteLength += chunk.byteLength;
      callback(null, chunk);
    },
    flush(callback) {
      resolveIntegrity({ byteDigest: hash.digest('hex'), byteLength });
      callback();
    },
  });
  const source = body instanceof Uint8Array ? Readable.from([body]) : body as Readable;
  const abort = () => {
    const error = new Error('Shadow artifact upload aborted before terminal completion');
    source.destroy(error);
    meter.destroy(error);
  };
  signal?.addEventListener('abort', abort, { once: true });
  integrity.finally(() => signal?.removeEventListener('abort', abort)).catch(() => undefined);
  source.once('error', rejectIntegrity);
  meter.once('error', rejectIntegrity);
  source.pipe(meter);
  return { uploadBody: meter, integrity };
}

function storageFailure(action: string, error: StorageError | null): Error {
  const status = String(error?.statusCode ?? error?.status ?? 'unknown');
  return new Error(`${action} [storage_status=${status}]: ${error?.message ?? 'unknown error'}`);
}

async function existingObjectMatches(
  bucket: StorageBucket,
  path: string,
  comparisonDigest: string,
): Promise<boolean> {
  const { data, error } = await bucket.info(path);
  if (error || !data) {
    throw storageFailure(`Failed to inspect existing shadow artifact ${path}`, error);
  }
  return data.metadata?.comparisonDigest === comparisonDigest;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Shadow artifact destination aborted before terminal completion');
}

async function writePart(
  bucket: StorageBucket,
  part: ShadowArtifactPart,
  signal?: AbortSignal,
): Promise<ShadowArtifactWrittenPart> {
  throwIfAborted(signal);
  const comparisonDigest = part.comparisonDigest ?? part.expectedByteDigest;
  if (!comparisonDigest) {
    throw new Error(`Shadow artifact lacks a trusted comparison digest: ${part.path}`);
  }
  const produced = part.bodyFactory();
  const { uploadBody, integrity } = instrumentBody(produced.body, signal);
  const upload = bucket.upload(part.path, uploadBody, {
    contentType: part.contentType,
    cacheControl: '31536000',
    upsert: false,
    ...(uploadBody instanceof Uint8Array ? {} : { duplex: 'half' as const }),
    metadata: {
      comparisonDigest,
      ...(part.contentEncoding ? { contentEncoding: part.contentEncoding } : {}),
    },
  });
  const [{ error }, measured] = await Promise.all([
    upload,
    integrity,
    produced.producerVerification ?? Promise.resolve(),
  ]);
  if (part.expectedByteDigest && measured.byteDigest !== part.expectedByteDigest) {
    throw new Error(`Shadow artifact digest mismatch during upload: ${part.path}`);
  }
  if (!error) return { path: part.path, ...measured, duplicate: false };
  if (!isAlreadyExistsError(error)) {
    throw storageFailure(`Failed to upload shadow artifact ${part.path}`, error);
  }
  if (!await existingObjectMatches(bucket, part.path, comparisonDigest)) {
    throw new Error(`Existing shadow artifact differs at immutable path: ${part.path}`);
  }
  return { path: part.path, ...measured, duplicate: true };
}

/**
 * Writes immutable section objects, then constructs and writes the terminal
 * manifest. The private bucket is provisioned manually; runtime code has no
 * runtime provisioning path.
 */
export async function writeShadowArtifactParts(params: {
  readonly projectId: string;
  readonly runId: string;
  readonly publicationId: string;
  readonly parts: readonly ShadowArtifactPart[];
  readonly terminalManifestFactory: (
    parts: readonly ShadowArtifactWrittenPart[],
  ) => ShadowArtifactPart;
  readonly admin?: { storage: { from(bucket: string): StorageBucket } };
  readonly signal?: AbortSignal;
}): Promise<ShadowArtifactWriteResult> {
  const admin = params.admin ?? getSupabaseAdmin();
  if (!admin) throw new Error('Server validation client is not configured.');
  const bucket = admin.storage.from(CANONICAL_SHADOW_ARTIFACT_BUCKET) as unknown as StorageBucket;
  const runPrefix = `project/${encodeURIComponent(params.projectId)}/run/${encodeURIComponent(params.runId)}`;
  const expectedPrefix = `${runPrefix}/${params.publicationId}/`;
  const { data: existingPublications, error: listError } = await bucket.list(runPrefix, {
    limit: 100,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (listError) {
    throw storageFailure('Failed to inspect shadow publication run prefix', listError);
  }
  if ((existingPublications?.length ?? 0) >= 100) {
    throw new Error('idempotency_conflict: run-prefix publication listing exceeded the fail-closed limit');
  }
  const divergentPublication = (existingPublications ?? [])
    .map((entry) => entry.name)
    .filter((name) => name && name !== params.publicationId)
    .sort((left, right) => left.localeCompare(right, 'en-US'))[0];
  if (divergentPublication) {
    throw new Error(
      `idempotency_conflict: validation run already has publication ${divergentPublication}`,
    );
  }
  const paths = new Set<string>();
  const written: ShadowArtifactWrittenPart[] = [];

  for (const part of params.parts) {
    throwIfAborted(params.signal);
    validatePath(part.path, expectedPrefix);
    if (paths.has(part.path)) throw new Error(`Duplicate shadow artifact path: ${part.path}`);
    paths.add(part.path);
    written.push(await writePart(bucket, part, params.signal));
  }

  throwIfAborted(params.signal);
  const manifest = params.terminalManifestFactory(written);
  throwIfAborted(params.signal);
  validatePath(manifest.path, expectedPrefix);
  if (paths.has(manifest.path)) throw new Error(`Duplicate shadow artifact path: ${manifest.path}`);
  written.push(await writePart(bucket, manifest, params.signal));

  return {
    status: written.every((part) => part.duplicate) ? 'duplicate_suppressed' : 'written',
    parts: written,
  };
}
