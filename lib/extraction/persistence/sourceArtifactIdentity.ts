import type { SupabaseClient } from '@supabase/supabase-js';
import { sha256Hex } from '@/lib/extraction/domain/hash';
import { sniffExtractionMediaType } from '@/lib/extraction/persistence/shadowSourceIdentity';
import { captureStorageObjectVersion } from '@/lib/extraction/persistence/complianceShadow';

export type SourceArtifactIdentityFailure = {
  readonly code:
    | 'storage_identity_unavailable'
    | 'identity_conflict'
    | 'persistence_failed';
  readonly safeMessage: string;
};

export type UploadedSourceArtifactIdentityResult =
  | {
      readonly status: 'persisted';
      readonly sourceArtifactId: string;
      readonly sourceSha256: string;
      readonly storageObjectVersion: string;
      readonly outcome: 'newly_populated' | 'already_populated';
      readonly failure: null;
    }
  | {
      readonly status: 'unavailable';
      readonly sourceArtifactId: null;
      readonly sourceSha256: string;
      readonly storageObjectVersion: string | null;
      readonly outcome: null;
      readonly failure: SourceArtifactIdentityFailure;
    };

type RpcError = {
  readonly code?: string | null;
  readonly message?: string | null;
};

function safeFailure(error: RpcError | null | undefined): SourceArtifactIdentityFailure {
  const code = error?.code?.trim().toUpperCase() ?? '';
  const message = error?.message?.toLowerCase() ?? '';
  if (code === '23514' && message.includes('immutable source artifact identity conflict')) {
    return Object.freeze({
      code: 'identity_conflict',
      safeMessage: 'Immutable source identity conflicts with the recorded storage version.',
    });
  }
  return Object.freeze({
    code: 'persistence_failed',
    safeMessage: 'Immutable source identity could not be recorded.',
  });
}

export async function captureUploadedStorageObjectVersion(params: {
  readonly admin: SupabaseClient;
  readonly storageBucket: string;
  readonly storagePath: string;
}): Promise<string | null> {
  return captureStorageObjectVersion(
    params.admin,
    params.storageBucket,
    params.storagePath,
  );
}

export async function persistUploadedSourceArtifactIdentity(params: {
  readonly admin: SupabaseClient;
  readonly organizationId: string;
  readonly sourceDocumentId: string;
  readonly sourceBytes: ArrayBuffer;
  readonly storageBucket: string;
  readonly storagePath: string;
  readonly storageObjectVersion: string | null;
  readonly mediaType: string | null;
}): Promise<UploadedSourceArtifactIdentityResult> {
  const sourceSha256 = sha256Hex(params.sourceBytes);
  const storageObjectVersion = params.storageObjectVersion?.trim() || null;
  if (!storageObjectVersion) {
    return Object.freeze({
      status: 'unavailable',
      sourceArtifactId: null,
      sourceSha256,
      storageObjectVersion: null,
      outcome: null,
      failure: Object.freeze({
        code: 'storage_identity_unavailable',
        safeMessage: 'Immutable storage object identity is unavailable.',
      }),
    });
  }

  const { data, error } = await params.admin.rpc(
    'record_extraction_source_artifact_identity',
    {
      payload: {
        organization_id: params.organizationId,
        source_document_id: params.sourceDocumentId,
        source_sha256: sourceSha256,
        storage_object_version: storageObjectVersion,
        storage_bucket: params.storageBucket,
        storage_path: params.storagePath,
        media_type_sniffed: sniffExtractionMediaType(params.sourceBytes, params.mediaType),
        byte_length: params.sourceBytes.byteLength,
        identity_origin: 'upload',
      },
    },
  );

  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    return Object.freeze({
      status: 'unavailable',
      sourceArtifactId: null,
      sourceSha256,
      storageObjectVersion,
      outcome: null,
      failure: safeFailure(error),
    });
  }

  const row = data as Record<string, unknown>;
  const sourceArtifactId = typeof row.source_artifact_id === 'string'
    ? row.source_artifact_id
    : null;
  const outcome = row.outcome === 'newly_populated' || row.outcome === 'already_populated'
    ? row.outcome
    : null;
  if (!sourceArtifactId || !outcome) {
    return Object.freeze({
      status: 'unavailable',
      sourceArtifactId: null,
      sourceSha256,
      storageObjectVersion,
      outcome: null,
      failure: safeFailure(null),
    });
  }

  return Object.freeze({
    status: 'persisted',
    sourceArtifactId,
    sourceSha256,
    storageObjectVersion,
    outcome,
    failure: null,
  });
}
