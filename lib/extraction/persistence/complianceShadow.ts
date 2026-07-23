import type { SupabaseClient } from '@supabase/supabase-js';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  buildLegacyShadowParserManifest,
  hashParserManifest,
} from '@/lib/extraction/domain/parserManifest';
import {
  STEP0_ENTITY_RESOLVER_VERSION,
  STEP0_INTERPRETER_MANIFEST_HASH,
} from '@/lib/complianceFoundation/shadowVersions';

const ARTIFACT_SCHEMA_VERSION = 'extraction-artifact-v1';
const PROJECTION_SCHEMA_VERSION = 'step0-shadow-projection-v1';
const GAP_KEY = 'legacy-payload-missing-geometry-v1';
const GAP_DETAIL =
  'Step 0 shadow publication preserves the legacy payload unchanged; it cannot manufacture geometry-complete verified fields.';

export type ShadowWriteInput = {
  readonly admin: SupabaseClient;
  readonly organizationId: string;
  readonly sourceDocumentId: string;
  readonly sourceBytes: ArrayBuffer;
  readonly storageObjectVersion: string | null;
  readonly mediaType: string | null;
  readonly legacyExtractionPayload: Record<string, unknown>;
  readonly analysisJobId: string;
  readonly analysisMode: string;
};

type ScheduledShadowWriteInput = Omit<ShadowWriteInput, 'storageObjectVersion'> & {
  readonly storageBucket: string;
  readonly storagePath: string;
  readonly storageVersionBeforeDownload: string | null;
};

const STORAGE_IDENTITY_TIMEOUT_MS = 1_000;
const SHADOW_PUBLICATION_TIMEOUT_MS = 10_000;

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          console.error('[extractionComplianceShadow] bounded shadow operation timed out', {
            mode: 'shadow',
            operation: label,
            timeoutMs,
          });
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface ShadowWriteResult {
  readonly sourceArtifactId: string;
  readonly extractionRunId: string;
  readonly extractionSnapshotId: string;
  readonly interpretationSnapshotId: string;
  readonly parserManifestHash: string;
  readonly status: 'partial';
}

function sniffMediaType(bytes: ArrayBuffer, supplied: string | null): string {
  const header = new Uint8Array(bytes.slice(0, 16));
  const ascii = String.fromCharCode(...header);
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  if (header[0] === 0x50 && header[1] === 0x4b) return 'application/zip';
  const suppliedNormalized = supplied?.split(';')[0]?.trim().toLowerCase();
  if (suppliedNormalized && suppliedNormalized !== 'application/octet-stream') {
    return suppliedNormalized;
  }
  const sample = new Uint8Array(bytes.slice(0, Math.min(bytes.byteLength, 512)));
  const controlCount = [...sample].filter((value) => value === 0 || value < 9).length;
  return controlCount === 0 ? 'text/plain' : 'application/octet-stream';
}

function rpcResult(
  value: unknown,
  parserManifestHash: string,
): ShadowWriteResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('compliance shadow RPC returned no result');
  }
  const row = value as Record<string, unknown>;
  const required = [
    'source_artifact_id',
    'extraction_run_id',
    'extraction_snapshot_id',
    'interpretation_snapshot_id',
  ] as const;
  for (const key of required) {
    if (typeof row[key] !== 'string') {
      throw new Error(`compliance shadow RPC omitted ${key}`);
    }
  }
  return {
    sourceArtifactId: row.source_artifact_id as string,
    extractionRunId: row.extraction_run_id as string,
    extractionSnapshotId: row.extraction_snapshot_id as string,
    interpretationSnapshotId: row.interpretation_snapshot_id as string,
    parserManifestHash,
    status: 'partial',
  };
}

export async function persistExtractionComplianceShadow(
  input: ShadowWriteInput,
): Promise<ShadowWriteResult> {
  const storageObjectVersion = input.storageObjectVersion?.trim();
  if (!storageObjectVersion) {
    throw new Error('exact storage object version is required for compliance publication');
  }

  const sourceSha256 = sha256Hex(input.sourceBytes);
  const openAiAvailable =
    typeof process.env.OPENAI_API_KEY === 'string'
    && process.env.OPENAI_API_KEY.trim().length > 0;
  const instructorConfigured = process.env.EIGHTFORGE_INSTRUCTOR_ENABLED !== '0';
  const implementationBuild =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim()
    || process.env.GIT_COMMIT_SHA?.trim()
    || process.env.EIGHTFORGE_BUILD_DIGEST?.trim();
  if (!implementationBuild) {
    throw new Error(
      'VERCEL_GIT_COMMIT_SHA, GIT_COMMIT_SHA, or EIGHTFORGE_BUILD_DIGEST is required for compliance publication',
    );
  }
  const manifest = buildLegacyShadowParserManifest({
    analysisMode: input.analysisMode,
    unstructuredEnabled:
      typeof process.env.UNSTRUCTURED_API_KEY === 'string'
      && process.env.UNSTRUCTURED_API_KEY.trim().length > 0,
    visionEnabled: openAiAvailable,
    typedAiEnabled: instructorConfigured && openAiAvailable,
    implementationBuild,
    unstructured: {
      apiUrl:
        process.env.UNSTRUCTURED_API_URL?.trim()
        || 'https://api.unstructuredapp.io/general/v0/general',
      strategy: process.env.UNSTRUCTURED_PARTITION_STRATEGY?.trim() || 'hi_res',
      splitConcurrency:
        process.env.UNSTRUCTURED_SPLIT_PDF_CONCURRENCY?.trim() || '8',
      timeoutMs: Number(process.env.UNSTRUCTURED_API_TIMEOUT_MS) > 0
        ? Number(process.env.UNSTRUCTURED_API_TIMEOUT_MS)
        : 45_000,
    },
    visionModel: process.env.EIGHTFORGE_VISION_MODEL ?? 'gpt-4o',
    typedAiModel: process.env.EIGHTFORGE_INSTRUCTOR_EXTRACTION_MODEL ?? 'gpt-4o-mini',
    instructorEnabled: instructorConfigured && openAiAvailable,
    instructorMaxRetries: Number(process.env.EIGHTFORGE_INSTRUCTOR_MAX_RETRIES) >= 0
      ? Number(process.env.EIGHTFORGE_INSTRUCTOR_MAX_RETRIES)
      : 2,
  });
  const parserManifestHash = hashParserManifest(manifest);
  const gap = {
    gap_key: GAP_KEY,
    page: null,
    stage: 'field_verification',
    reason: 'missing_geometry',
    retryable: false,
    attempts: 1,
    detail: GAP_DETAIL,
  };
  const gapDependencyHash = hashCanonical(gap);
  const members = [{ kind: 'gap', dependency_hash: gapDependencyHash }] as const;
  const artifactRootHash = hashCanonical({
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
    members,
  });
  const contentExtractionFingerprint = hashCanonical({
    source_sha256: sourceSha256,
    parser_manifest_hash: parserManifestHash,
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
    members,
  });
  const completedAt = new Date().toISOString();

  const { data, error } = await input.admin.rpc('publish_extraction_compliance_shadow', {
    payload: {
      organization_id: input.organizationId,
      source_document_id: input.sourceDocumentId,
      source_sha256: sourceSha256,
      storage_object_version: storageObjectVersion,
      media_type_sniffed: sniffMediaType(input.sourceBytes, input.mediaType),
      byte_length: input.sourceBytes.byteLength,
      parser_manifest: manifest,
      parser_manifest_hash: parserManifestHash,
      artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
      idempotency_key: `analysis-job:${input.analysisJobId}`,
      started_at: completedAt,
      completed_at: completedAt,
      gap_key: GAP_KEY,
      gap_detail: GAP_DETAIL,
      gap_dependency_hash: gapDependencyHash,
      artifact_root_hash: artifactRootHash,
      content_extraction_fingerprint: contentExtractionFingerprint,
      interpreter_manifest_hash: STEP0_INTERPRETER_MANIFEST_HASH,
      entity_resolver_version: STEP0_ENTITY_RESOLVER_VERSION,
      effective_truth_set_hash: hashCanonical([]),
      interpretation_output_root_hash: hashCanonical({
        extraction_artifact_root_hash: artifactRootHash,
        status: 'blocked',
        gap_dependency_hash: gapDependencyHash,
      }),
      projection_schema_version: PROJECTION_SCHEMA_VERSION,
    },
  });
  if (error) {
    throw new Error(`publish extraction compliance shadow: ${error.message}`);
  }
  return rpcResult(data, parserManifestHash);
}

export async function publishExtractionComplianceShadowNonBlocking(
  input: ShadowWriteInput,
): Promise<ShadowWriteResult | null> {
  try {
    const result = await persistExtractionComplianceShadow(input);
    console.info('[extractionComplianceShadow] published', {
      mode: 'shadow',
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      analysisJobId: input.analysisJobId,
      sourceArtifactId: result.sourceArtifactId,
      extractionSnapshotId: result.extractionSnapshotId,
      status: result.status,
    });
    return result;
  } catch (error) {
    console.error('[extractionComplianceShadow] non-fatal publish failure', {
      mode: 'shadow',
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      analysisJobId: input.analysisJobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Starts the Step 0 dual-write without putting storage metadata or the new
 * compliance ledger on the legacy processing critical path.
 */
export function scheduleExtractionComplianceShadow(
  input: ScheduledShadowWriteInput,
): Promise<void> {
  return (async () => {
    if (!input.storageVersionBeforeDownload) {
      console.info('[extractionComplianceShadow] skipped without pre-download identity', {
        mode: 'shadow',
        organizationId: input.organizationId,
        sourceDocumentId: input.sourceDocumentId,
        analysisJobId: input.analysisJobId,
      });
      return;
    }
    const storageVersionAfterDownload = await captureStorageObjectVersion(
      input.admin,
      input.storageBucket,
      input.storagePath,
    );
    const storageObjectVersion =
      input.storageVersionBeforeDownload === storageVersionAfterDownload
        ? input.storageVersionBeforeDownload
        : null;

    await settleWithin(publishExtractionComplianceShadowNonBlocking({
      admin: input.admin,
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      sourceBytes: input.sourceBytes,
      storageObjectVersion,
      mediaType: input.mediaType,
      legacyExtractionPayload: input.legacyExtractionPayload,
      analysisJobId: input.analysisJobId,
      analysisMode: input.analysisMode,
    }), SHADOW_PUBLICATION_TIMEOUT_MS, 'publication');
  })().catch((error) => {
    console.error('[extractionComplianceShadow] detached shadow task failed', {
      mode: 'shadow',
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      analysisJobId: input.analysisJobId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function captureStorageObjectVersion(
  admin: SupabaseClient,
  storageBucket: string,
  storagePath: string,
  timeoutMs = STORAGE_IDENTITY_TIMEOUT_MS,
): Promise<string | null> {
  return settleWithin(
    readStorageObjectVersion(admin, storageBucket, storagePath),
    timeoutMs,
    'storage_identity',
  );
}

export async function readStorageObjectVersion(
  admin: SupabaseClient,
  storageBucket: string,
  storagePath: string,
): Promise<string | null> {
  try {
    const bucket = admin.storage.from(storageBucket) as unknown as {
      info: (path: string) => Promise<{
        data: {
          id?: string;
          version?: string;
          updated_at?: string;
          metadata?: { eTag?: string; etag?: string };
        } | null;
        error: { message?: string } | null;
      }>;
    };
    const { data, error } = await bucket.info(storagePath);
    if (error || !data) {
      throw new Error(`load storage object version: ${error?.message ?? 'no object metadata'}`);
    }
    const storageObjectVersion = [
      data.version,
      data.id,
      data.updated_at,
      data.metadata?.eTag ?? data.metadata?.etag,
    ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(':');
    if (!storageObjectVersion) {
      throw new Error('storage object metadata did not contain a version identity');
    }
    return storageObjectVersion;
  } catch (error) {
    console.error('[extractionComplianceShadow] storage identity unavailable', {
      storageBucket,
      storagePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
