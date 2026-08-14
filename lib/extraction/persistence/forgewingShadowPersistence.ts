import { gzipSync } from 'node:zlib';

import { canonicalJson, sha256Hex } from '@/lib/extraction/domain/hash';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const REASONING_SHADOW_ARTIFACT_VERSION = 'forgewing-shadow-artifact-v1';
export const REASONING_SHADOW_BUCKET = 'canonical-shadow-artifacts';
export const REASONING_SHADOW_PREFIX = 'forgewing';
export const REASONING_SHADOW_DEFAULT_TTL_DAYS = 5;
export const REASONING_SHADOW_MIN_TTL_DAYS = 1;
export const REASONING_SHADOW_MAX_TTL_DAYS = 30;
export const REASONING_SHADOW_MAX_UNCOMPRESSED_BYTES = 256 * 1024;
export const REASONING_SHADOW_CACHE_CONTROL = '0';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ReasoningShadowPersistenceInput = Readonly<{
  organizationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  resultStatus: 'applied' | 'abstained' | 'skipped' | 'failed';
  run: Readonly<{
    runId: string;
    organizationId: string;
    extractionSnapshotId: string;
    inputSnapshotHash: string;
  }>;
  schemaVersion: string;
  runtime: Readonly<{
    model: string;
    promptTemplateId: string;
    promptTemplateVersion: string;
    warningCodes: readonly string[];
    calls: number;
    inputTruncated: boolean;
  }>;
  validatedBundle?: unknown;
}>;

export type ReasoningShadowPersistenceResult =
  | Readonly<{ status: 'persisted'; path: string; sha256: string; expiresAt: string; idempotent: boolean }>
  | Readonly<{ status: 'skipped'; reason: 'ineligible_status' | 'missing_bundle' | 'storage_not_configured' }>
  | Readonly<{
      status: 'failed';
      reason: 'invalid_identity' | 'mixed_source_identity' | 'serialization_failed' | 'artifact_too_large'
        | 'upload_failed' | 'duplicate_read_failed' | 'content_conflict';
      warningCode: string;
    }>;

type StorageError = Readonly<{
  message?: string;
  status?: string | number;
  statusCode?: string | number;
  error?: string;
}>;

type StorageBucket = Readonly<{
  upload(path: string, body: Uint8Array, options: Readonly<{
    contentType: string;
    cacheControl: string;
    upsert: false;
    metadata: Readonly<Record<string, string>>;
  }>): Promise<{ error: StorageError | null }>;
  download(path: string): Promise<{
    data: { arrayBuffer(): Promise<ArrayBuffer> } | null;
    error: StorageError | null;
  }>;
}>;

export type ReasoningShadowStorageAdmin = Readonly<{
  storage: Readonly<{ from(bucket: string): StorageBucket }>;
}>;

type ArtifactEnvelope = Readonly<{
  artifactVersion: typeof REASONING_SHADOW_ARTIFACT_VERSION;
  createdAt: string;
  expiresAt: string;
  run: ReasoningShadowPersistenceInput['run'];
  source: Readonly<{ sourceDocumentId: string; sourceArtifactId: string }>;
  runtime: ReasoningShadowPersistenceInput['runtime'] & Readonly<{
    status: 'applied' | 'abstained';
    schemaVersion: string;
  }>;
  bundle: JsonValue;
}>;

export function getReasoningShadowTtlDays(raw = process.env.FORGEWING_SHADOW_TTL_DAYS): number {
  if (raw == null || !/^\d+$/.test(raw.trim())) return REASONING_SHADOW_DEFAULT_TTL_DAYS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed)
    && parsed >= REASONING_SHADOW_MIN_TTL_DAYS
    && parsed <= REASONING_SHADOW_MAX_TTL_DAYS
    ? parsed
    : REASONING_SHADOW_DEFAULT_TTL_DAYS;
}

function validPathComponent(value: string): boolean {
  return value.length > 0
    && value.length <= 200
    && value !== '.'
    && value !== '..'
    && !value.includes('..')
    && /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,198}[A-Za-z0-9])?$/.test(value);
}

export function reasoningShadowArtifactPath(input: Pick<ReasoningShadowPersistenceInput,
  'organizationId' | 'sourceArtifactId' | 'run'>): string | null {
  const components = [input.organizationId, input.sourceArtifactId, input.run.runId];
  if (!components.every(validPathComponent)) return null;
  return `${REASONING_SHADOW_PREFIX}/${components[0]}/${components[1]}/${components[2]}.json.gz`;
}

function toStrictJson(value: unknown): JsonValue {
  const seen = new Set<object>();
  const visit = (current: unknown): JsonValue => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('non-finite number');
      return current;
    }
    if (typeof current !== 'object') throw new Error(`unsupported JSON value: ${typeof current}`);
    if (seen.has(current)) throw new Error('cyclic JSON value');
    seen.add(current);
    try {
      if (Array.isArray(current)) return current.map(visit);
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain JSON object');
      const output: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(current)) output[key] = visit(item);
      return output;
    } finally {
      seen.delete(current);
    }
  };
  return visit(value);
}

function identityIsCoherent(
  bundle: JsonValue,
  input: ReasoningShadowPersistenceInput,
): boolean {
  if (bundle == null || Array.isArray(bundle) || typeof bundle !== 'object') return false;
  const record = bundle as Readonly<Record<string, JsonValue>>;
  const bundleRun = record.run;
  if (bundleRun == null || Array.isArray(bundleRun) || typeof bundleRun !== 'object') return false;
  const run = bundleRun as Readonly<Record<string, JsonValue>>;
  if (
    record.schemaVersion !== input.schemaVersion
    || run.runId !== input.run.runId
    || run.organizationId !== input.run.organizationId
    || run.extractionSnapshotId !== input.run.extractionSnapshotId
    || run.inputSnapshotHash !== input.run.inputSnapshotHash
  ) return false;
  const collections = [record.proposals, record.abstentions];
  let found = false;
  for (const collection of collections) {
    if (!Array.isArray(collection)) return false;
    for (const item of collection) {
      if (item == null || Array.isArray(item) || typeof item !== 'object') return false;
      const identity = item as Readonly<Record<string, JsonValue>>;
      if (
        identity.sourceDocumentId !== input.sourceDocumentId
        || identity.sourceArtifactId !== input.sourceArtifactId
      ) {
        return false;
      }
      found = true;
      const evidence = identity.evidence;
      if (evidence != null) {
        if (!Array.isArray(evidence)) return false;
        for (const reference of evidence) {
          if (reference == null || Array.isArray(reference) || typeof reference !== 'object') return false;
          const evidenceIdentity = reference as Readonly<Record<string, JsonValue>>;
          if (
            evidenceIdentity.sourceDocumentId !== input.sourceDocumentId
            || evidenceIdentity.sourceArtifactId !== input.sourceArtifactId
          ) return false;
        }
      }
    }
  }
  return found;
}

function isDuplicate(error: StorageError): boolean {
  const status = String(error.statusCode ?? error.status ?? '');
  const detail = `${error.error ?? ''} ${error.message ?? ''}`.toLowerCase();
  return status === '409' || detail.includes('duplicate') || detail.includes('already exists');
}

function failure(
  reason: Extract<ReasoningShadowPersistenceResult, { status: 'failed' }>['reason'],
): ReasoningShadowPersistenceResult {
  return { status: 'failed', reason, warningCode: `forgewing_shadow_${reason}` };
}

export async function persistReasoningShadowArtifact(params: {
  input: ReasoningShadowPersistenceInput;
  admin?: ReasoningShadowStorageAdmin | null;
  now?: () => Date;
}): Promise<ReasoningShadowPersistenceResult> {
  try {
    const { input } = params;
    if (input.resultStatus !== 'applied' && input.resultStatus !== 'abstained') {
      return { status: 'skipped', reason: 'ineligible_status' };
    }
    if (input.validatedBundle == null) return { status: 'skipped', reason: 'missing_bundle' };
    if (input.organizationId !== input.run.organizationId) return failure('invalid_identity');

    const path = reasoningShadowArtifactPath(input);
    if (!path || !validPathComponent(input.sourceDocumentId) || !validPathComponent(input.run.extractionSnapshotId)) {
      return failure('invalid_identity');
    }

    let bundle: JsonValue;
    try {
      bundle = toStrictJson(input.validatedBundle);
    } catch {
      return failure('serialization_failed');
    }
    if (!identityIsCoherent(bundle, input)) {
      return failure('mixed_source_identity');
    }

    const created = (params.now ?? (() => new Date()))();
    if (!Number.isFinite(created.getTime())) return failure('serialization_failed');
    const createdAt = created.toISOString();
    const expiresAt = new Date(
      created.getTime() + getReasoningShadowTtlDays() * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const envelope: ArtifactEnvelope = {
      artifactVersion: REASONING_SHADOW_ARTIFACT_VERSION,
      createdAt,
      expiresAt,
      run: input.run,
      source: {
        sourceDocumentId: input.sourceDocumentId,
        sourceArtifactId: input.sourceArtifactId,
      },
      runtime: {
        status: input.resultStatus,
        model: input.runtime.model,
        promptTemplateId: input.runtime.promptTemplateId,
        promptTemplateVersion: input.runtime.promptTemplateVersion,
        schemaVersion: input.schemaVersion,
        warningCodes: input.runtime.warningCodes,
        calls: input.runtime.calls,
        inputTruncated: input.runtime.inputTruncated,
      },
      bundle,
    };

    let json: string;
    try {
      json = canonicalJson(toStrictJson(envelope));
    } catch {
      return failure('serialization_failed');
    }
    const uncompressed = new TextEncoder().encode(json);
    if (uncompressed.byteLength > REASONING_SHADOW_MAX_UNCOMPRESSED_BYTES) {
      return failure('artifact_too_large');
    }
    const compressed = new Uint8Array(gzipSync(uncompressed, { level: 9 }));
    const sha256 = sha256Hex(compressed);
    const admin = params.admin ?? (getSupabaseAdmin() as unknown as ReasoningShadowStorageAdmin | null);
    if (!admin) return { status: 'skipped', reason: 'storage_not_configured' };
    const bucket = admin.storage.from(REASONING_SHADOW_BUCKET);
    const { error } = await bucket.upload(path, compressed, {
      contentType: 'application/json',
      cacheControl: REASONING_SHADOW_CACHE_CONTROL,
      upsert: false,
      metadata: {
        contentEncoding: 'gzip',
        sha256,
        expiresAt,
      },
    });
    if (!error) return { status: 'persisted', path, sha256, expiresAt, idempotent: false };
    if (!isDuplicate(error)) return failure('upload_failed');

    const existing = await bucket.download(path);
    if (existing.error || !existing.data) return failure('duplicate_read_failed');
    const existingSha256 = sha256Hex(await existing.data.arrayBuffer());
    return existingSha256 === sha256
      ? { status: 'persisted', path, sha256, expiresAt, idempotent: true }
      : failure('content_conflict');
  } catch {
    return failure('upload_failed');
  }
}
