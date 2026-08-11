import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { persistUploadedSourceArtifactIdentity } from '@/lib/extraction/persistence/sourceArtifactIdentity';

const bytes = new TextEncoder().encode('exact uploaded bytes').buffer;
const expectedSha = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');

function input(rpc: ReturnType<typeof vi.fn>, storageObjectVersion: string | null = 'object-1:v1') {
  return {
    admin: { rpc } as never,
    organizationId: '10000000-0000-0000-0000-000000000001',
    sourceDocumentId: '20000000-0000-0000-0000-000000000001',
    sourceBytes: bytes,
    storageBucket: 'documents',
    storagePath: 'org/exact.pdf',
    storageObjectVersion,
    mediaType: 'application/pdf',
  };
}

describe('uploaded source artifact identity persistence', () => {
  it('hashes the exact uploaded bytes and publishes immutable storage provenance', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        source_artifact_id: '30000000-0000-0000-0000-000000000001',
        outcome: 'newly_populated',
      },
      error: null,
    });

    const result = await persistUploadedSourceArtifactIdentity(input(rpc));

    expect(result).toMatchObject({
      status: 'persisted',
      sourceSha256: expectedSha,
      storageObjectVersion: 'object-1:v1',
      outcome: 'newly_populated',
    });
    expect(rpc).toHaveBeenCalledWith('record_extraction_source_artifact_identity', {
      payload: {
        organization_id: '10000000-0000-0000-0000-000000000001',
        source_document_id: '20000000-0000-0000-0000-000000000001',
        source_sha256: expectedSha,
        storage_object_version: 'object-1:v1',
        storage_bucket: 'documents',
        storage_path: 'org/exact.pdf',
        media_type_sniffed: 'application/pdf',
        byte_length: bytes.byteLength,
        identity_origin: 'upload',
      },
    });
  });

  it('accepts an identical idempotent retry result', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        source_artifact_id: '30000000-0000-0000-0000-000000000001',
        outcome: 'already_populated',
      },
      error: null,
    });

    await expect(persistUploadedSourceArtifactIdentity(input(rpc))).resolves.toMatchObject({
      status: 'persisted',
      sourceArtifactId: '30000000-0000-0000-0000-000000000001',
      outcome: 'already_populated',
    });
  });

  it('returns a sanitized conflict without retaining provider details', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '23514',
        message: 'immutable source artifact identity conflict; secret database detail',
      },
    });

    const result = await persistUploadedSourceArtifactIdentity(input(rpc));

    expect(result).toMatchObject({
      status: 'unavailable',
      failure: {
        code: 'identity_conflict',
        safeMessage: 'Immutable source identity conflicts with the recorded storage version.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret database detail');
  });

  it('does not call persistence when exact storage identity is unavailable', async () => {
    const rpc = vi.fn();

    await expect(persistUploadedSourceArtifactIdentity(input(rpc, null))).resolves.toMatchObject({
      status: 'unavailable',
      sourceSha256: expectedSha,
      failure: { code: 'storage_identity_unavailable' },
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
