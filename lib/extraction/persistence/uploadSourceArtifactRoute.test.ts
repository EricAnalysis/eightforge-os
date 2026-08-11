import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import {
  captureUploadedStorageObjectVersion,
  persistUploadedSourceArtifactIdentity,
} from '@/lib/extraction/persistence/sourceArtifactIdentity';
import { POST } from '@/app/api/documents/upload/route';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn() }));
vi.mock('@/lib/extraction/persistence/sourceArtifactIdentity', () => ({
  captureUploadedStorageObjectVersion: vi.fn(),
  persistUploadedSourceArtifactIdentity: vi.fn(),
}));

const organizationId = '10000000-0000-0000-0000-000000000001';
const documentId = '20000000-0000-0000-0000-000000000001';

function adminHarness() {
  const upload = vi.fn().mockResolvedValue({ data: { path: 'stored' }, error: null });
  const remove = vi.fn().mockResolvedValue({ data: [], error: null });
  const storageFrom = vi.fn(() => ({ upload, remove }));
  const single = vi.fn().mockResolvedValue({
    data: {
      id: documentId,
      title: 'Exact upload',
      name: 'exact.pdf',
      document_type: 'contract',
      status: 'uploaded',
      created_at: '2026-08-11T16:00:00.000Z',
    },
    error: null,
  });
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));
  return { admin: { storage: { from: storageFrom }, from }, upload, remove };
}

function uploadRequest(content: Uint8Array): Request {
  const form = new FormData();
  form.set('title', 'Exact upload');
  form.set('documentType', 'contract');
  const bytes = content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength,
  ) as ArrayBuffer;
  form.set('file', new File([bytes], 'exact.pdf', { type: 'application/pdf' }));
  return new Request('http://localhost/api/documents/upload', { method: 'POST', body: form });
}

describe('document upload immutable source identity', () => {
  beforeEach(() => {
    vi.mocked(getActorContext).mockResolvedValue({
      ok: true,
      actor: { organizationId },
    } as never);
    vi.mocked(captureUploadedStorageObjectVersion).mockResolvedValue('object-1:v1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads and hashes the same exact byte sequence', async () => {
    const harness = adminHarness();
    vi.mocked(getSupabaseAdmin).mockReturnValue(harness.admin as never);
    vi.mocked(persistUploadedSourceArtifactIdentity).mockResolvedValue({
      status: 'persisted',
      sourceArtifactId: '30000000-0000-0000-0000-000000000001',
      sourceSha256: 'a'.repeat(64),
      storageObjectVersion: 'object-1:v1',
      outcome: 'newly_populated',
      failure: null,
    });
    const content = new TextEncoder().encode('%PDF-exact-upload-bytes');

    const response = await POST(uploadRequest(content));

    expect(response.status).toBe(200);
    const uploadedBody = harness.upload.mock.calls[0]?.[1];
    expect(uploadedBody).toBeInstanceOf(Uint8Array);
    expect([...uploadedBody as Uint8Array]).toEqual([...content]);
    const identityInput = vi.mocked(persistUploadedSourceArtifactIdentity).mock.calls[0]?.[0];
    expect([...new Uint8Array(identityInput!.sourceBytes)]).toEqual([...content]);
    expect(identityInput).toMatchObject({
      organizationId,
      sourceDocumentId: documentId,
      storageBucket: 'documents',
      storageObjectVersion: 'object-1:v1',
      mediaType: 'application/pdf',
    });
  });

  it('keeps a successful upload available with only a sanitized identity failure', async () => {
    const harness = adminHarness();
    vi.mocked(getSupabaseAdmin).mockReturnValue(harness.admin as never);
    vi.mocked(persistUploadedSourceArtifactIdentity).mockResolvedValue({
      status: 'unavailable',
      sourceArtifactId: null,
      sourceSha256: 'a'.repeat(64),
      storageObjectVersion: 'object-1:v1',
      outcome: null,
      failure: {
        code: 'persistence_failed',
        safeMessage: 'Immutable source identity could not be recorded.',
      },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await POST(uploadRequest(new Uint8Array([1, 2, 3])));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sourceIdentity).toEqual({
      status: 'unavailable',
      failure: {
        code: 'persistence_failed',
        safeMessage: 'Immutable source identity could not be recorded.',
      },
    });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[documents/upload] source identity unavailable',
      { code: 'persistence_failed', documentId },
    );
  });
});
