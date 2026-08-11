/**
 * D1 — the immutable source-identity store must not report a read failure as an
 * absence of identity. Source identity is load-bearing for a blocking
 * duplicate-authority decision, so "no artifact recorded" and "store
 * unreadable" have to stay distinguishable at the call site.
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(),
}));

import { loadSourceArtifactSnapshot } from '@/lib/validator/projectValidator';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { ValidatorDocumentRow, ValidatorProjectRow } from '@/lib/validator/shared';

const PROJECT = {
  id: 'project-1',
  organization_id: 'org-1',
  name: 'Project',
  code: 'P1',
  validation_status: null,
  validation_summary_json: null,
} as unknown as ValidatorProjectRow;

const DOCUMENTS = [
  { id: 'doc-a', document_type: 'price_sheet', created_at: '2026-06-16T00:00:00.000Z' },
  { id: 'doc-b', document_type: 'price_sheet', created_at: '2026-07-04T00:00:00.000Z' },
] as unknown as ValidatorDocumentRow[];

/** Mocks the `extraction_source_artifacts` read with one fixed outcome. */
function mockArtifactRead(outcome: { data: unknown; error: unknown }) {
  const inFilter = vi.fn().mockResolvedValue(outcome);
  const eq = vi.fn(() => ({ in: inFilter }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as never);
  return { from };
}

describe('source identity store read states', () => {
  it('reports a successful read of zero rows as identity absent, not unreadable', async () => {
    mockArtifactRead({ data: [], error: null });

    const snapshot = await loadSourceArtifactSnapshot({ project: PROJECT, documents: DOCUMENTS });

    assert.equal(snapshot.storeState, 'read');
    assert.equal(snapshot.readError, null);
    assert.equal(snapshot.entries.length, 2);
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.exactSourceIdentity),
      [null, null],
      'no artifact recorded is an honest null identity',
    );
  });

  it('does not convert a query failure into an empty artifact set', async () => {
    mockArtifactRead({
      data: null,
      error: { code: '42P01', message: 'relation "extraction_source_artifacts" does not exist' },
    });

    const snapshot = await loadSourceArtifactSnapshot({ project: PROJECT, documents: DOCUMENTS });

    assert.equal(snapshot.storeState, 'unreadable');
    assert.deepEqual(snapshot.readError, {
      code: 'relation_unavailable',
      safeMessage: 'Source identity store relation is unavailable.',
    });
  });

  it('lets a caller distinguish absent identity from an unreadable store', async () => {
    mockArtifactRead({ data: [], error: null });
    const absent = await loadSourceArtifactSnapshot({ project: PROJECT, documents: DOCUMENTS });

    mockArtifactRead({ data: null, error: { code: '42501', message: 'permission denied' } });
    const unreadable = await loadSourceArtifactSnapshot({ project: PROJECT, documents: DOCUMENTS });

    // Both yield null identities; only `storeState` says whether that is
    // evidence about the documents or evidence about the store.
    assert.deepEqual(
      absent.entries.map((entry) => entry.exactSourceIdentity),
      unreadable.entries.map((entry) => entry.exactSourceIdentity),
    );
    assert.notEqual(absent.storeState, unreadable.storeState);
  });

  it('surfaces a permission failure as unreadable rather than as no identity', async () => {
    mockArtifactRead({ data: null, error: { code: '42501', message: 'permission denied for table' } });

    const snapshot = await loadSourceArtifactSnapshot({ project: PROJECT, documents: DOCUMENTS });

    assert.equal(snapshot.storeState, 'unreadable');
    assert.deepEqual(snapshot.readError, {
      code: 'permission_denied',
      safeMessage: 'Source identity store access was denied.',
    });
  });

  it('does not retain credentials, SQL, provider hints, or local paths', async () => {
    const secrets = [
      'postgresql://admin:password@example.test/db',
      'service_role=eyJ-secret',
      'select * from extraction_source_artifacts',
      'C:\\Users\\operator\\secrets.txt',
      '/var/run/private/provider.log',
    ];
    mockArtifactRead({
      data: null,
      error: {
        code: '42501',
        message: `permission denied ${secrets.join(' ')}`,
        details: secrets.join(' '),
        hint: 'provider stack trace',
      },
    });

    const snapshot = await loadSourceArtifactSnapshot({ project: PROJECT, documents: DOCUMENTS });
    const serialized = JSON.stringify(snapshot);

    assert.deepEqual(snapshot.readError, {
      code: 'permission_denied',
      safeMessage: 'Source identity store access was denied.',
    });
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('provider stack trace'), false);
  });

  it('reports an empty document set as a read, without querying the store', async () => {
    const { from } = mockArtifactRead({ data: [], error: null });

    const snapshot = await loadSourceArtifactSnapshot({ project: PROJECT, documents: [] });

    assert.equal(snapshot.storeState, 'read');
    assert.deepEqual(snapshot.entries, []);
    assert.equal(from.mock.calls.length, 0);
  });

  it('carries recorded identity through on a successful read', async () => {
    mockArtifactRead({
      data: [{
        id: 'artifact-1',
        source_document_id: 'doc-a',
        source_sha256: 'sha256:fixture-a',
        storage_object_version: 'v1',
        storage_bucket: 'documents',
        storage_path: 'org-1/doc-a.pdf',
        identity_origin: 'upload',
        media_type_sniffed: 'application/pdf',
        byte_length: 825904,
        created_at: '2026-07-01T00:00:00.000Z',
      }],
      error: null,
    });

    const snapshot = await loadSourceArtifactSnapshot({ project: PROJECT, documents: DOCUMENTS });

    assert.equal(snapshot.storeState, 'read');
    const docA = snapshot.entries.find((entry) => entry.documentId === 'doc-a');
    const docB = snapshot.entries.find((entry) => entry.documentId === 'doc-b');
    assert.equal(docA?.sourceSha256, 'sha256:fixture-a');
    assert.equal(docA?.logicalSourceIdentity, 'source_sha256:sha256:fixture-a');
    assert.equal(docA?.storageBucket, 'documents');
    assert.equal(docA?.storageObjectPath, 'org-1/doc-a.pdf');
    assert.equal(docA?.identityOrigin, 'upload');
    assert.equal(docB?.sourceSha256, null);
  });
});
