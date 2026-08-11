import { describe, expect, it, vi } from 'vitest';

import {
  runSourceArtifactIdentityBackfill,
  SourceIdentityStorageFailure,
  SourceIdentityWriteConflict,
  type SourceIdentityBackfillDependencies,
  type SourceIdentityBackfillDocument,
} from './sourceArtifactIdentityBackfill';
import { sha256Hex } from '../domain/hash';

const DOCUMENTS: readonly SourceIdentityBackfillDocument[] = Object.freeze([
  { id: 'doc-a', organizationId: 'org-1', storagePath: 'org-1/a.pdf' },
  { id: 'doc-b', organizationId: 'org-1', storagePath: 'org-1/b.pdf' },
]);

function dependencies(overrides: Partial<SourceIdentityBackfillDependencies> = {}) {
  const base: SourceIdentityBackfillDependencies = {
    listDocuments: async () => DOCUMENTS,
    loadArtifacts: async () => [],
    readStorageVersion: async () => 'version-1',
    downloadSourceBytes: async (document) => ({
      bytes: new TextEncoder().encode(document.id).buffer,
      suppliedMediaType: 'application/pdf',
    }),
    recordIdentity: async () => 'newly_populated',
  };
  return { ...base, ...overrides };
}

describe('runSourceArtifactIdentityBackfill', () => {
  it('is dry-run by default and performs no writes', async () => {
    const recordIdentity = vi.fn<SourceIdentityBackfillDependencies['recordIdentity']>();
    const report = await runSourceArtifactIdentityBackfill(dependencies({ recordIdentity }));

    expect(recordIdentity).not.toHaveBeenCalled();
    expect(report.mode).toBe('dry-run');
    expect(report.counts).toMatchObject({
      eligible: 2,
      would_populate: 2,
      newly_populated: 0,
      completed: 2,
    });
  });

  it('populates once and reports an idempotent rerun as already populated', async () => {
    const stored = new Map<string, { sourceSha256: string; storageObjectVersion: string }>();
    const deps = dependencies({
      loadArtifacts: async (document) => {
        const artifact = stored.get(document.id);
        return artifact ? [artifact] : [];
      },
      recordIdentity: async (input) => {
        stored.set(input.document.id, {
          sourceSha256: input.sourceSha256,
          storageObjectVersion: input.storageObjectVersion,
        });
        return 'newly_populated';
      },
    });

    const first = await runSourceArtifactIdentityBackfill(deps, { write: true });
    const second = await runSourceArtifactIdentityBackfill(deps, { write: true });
    expect(first.counts.newly_populated).toBe(2);
    expect(second.counts.already_populated).toBe(2);
    expect(stored.size).toBe(2);
  });

  it('reports missing, unreadable, write-conflict, and unstable-version categories', async () => {
    const cases = [
      dependencies({ downloadSourceBytes: async () => { throw new SourceIdentityStorageFailure('missing', 'missing'); } }),
      dependencies({ downloadSourceBytes: async () => { throw new SourceIdentityStorageFailure('unreadable', 'denied'); } }),
      dependencies({ recordIdentity: async () => { throw new SourceIdentityWriteConflict(); } }),
      (() => {
        let calls = 0;
        return dependencies({ readStorageVersion: async () => `version-${++calls}` });
      })(),
    ] as const;

    const reports = [];
    for (const deps of cases) reports.push(await runSourceArtifactIdentityBackfill(deps, { write: true }));
    expect(reports[0].counts.missing_storage_object).toBe(2);
    expect(reports[1].counts.unreadable_storage_object).toBe(2);
    expect(reports[2].counts.hash_conflict).toBe(2);
    expect(reports[3].counts.unstable_version).toBe(2);
    expect(reports[3].counts.failed).toBe(0);
  });

  it('separates an ineligible missing path from an eligible missing object', async () => {
    const noPath = { id: 'doc-no-path', organizationId: 'org-1', storagePath: null };
    const missingObject = { id: 'doc-missing', organizationId: 'org-1', storagePath: 'org-1/missing.pdf' };
    const report = await runSourceArtifactIdentityBackfill(dependencies({
      listDocuments: async () => [noPath, missingObject],
      readStorageVersion: async () => {
        throw new SourceIdentityStorageFailure('missing', 'missing');
      },
    }));

    expect(report.counts).toMatchObject({
      eligible: 1,
      ineligible_no_storage_path: 1,
      missing_storage_object: 1,
      completed: 2,
    });
    expect(report.outcomes).toEqual([
      { documentId: 'doc-missing', category: 'missing_storage_object' },
      { documentId: 'doc-no-path', category: 'ineligible_no_storage_path' },
    ]);
  });

  it('keeps unexpected processing errors in the failed category', async () => {
    const report = await runSourceArtifactIdentityBackfill(dependencies({
      loadArtifacts: async () => { throw new Error('unexpected'); },
    }));
    expect(report.counts.failed).toBe(2);
  });

  it.each([
    { write: false, successCategory: 'would_populate' as const },
    { write: true, successCategory: 'newly_populated' as const },
  ])('reconciles every processed document exactly once in $successCategory mode', async ({ write, successCategory }) => {
    const documents: SourceIdentityBackfillDocument[] = [
      { id: 'already', organizationId: 'org-1', storagePath: 'already.pdf' },
      { id: 'failed', organizationId: 'org-1', storagePath: 'failed.pdf' },
      { id: 'hash-conflict', organizationId: 'org-1', storagePath: 'hash.pdf' },
      { id: 'ineligible', organizationId: 'org-1', storagePath: null },
      { id: 'missing', organizationId: 'org-1', storagePath: 'missing.pdf' },
      { id: 'success', organizationId: 'org-1', storagePath: 'success.pdf' },
      { id: 'unreadable', organizationId: 'org-1', storagePath: 'unreadable.pdf' },
      { id: 'unstable', organizationId: 'org-1', storagePath: 'unstable.pdf' },
    ];
    const bytesFor = (id: string) => new TextEncoder().encode(id).buffer;
    const versionCalls = new Map<string, number>();
    const report = await runSourceArtifactIdentityBackfill(dependencies({
      listDocuments: async () => documents,
      loadArtifacts: async (document) => {
        if (document.id === 'failed') throw new Error('unexpected');
        if (document.id === 'hash-conflict') {
          return [{ sourceSha256: 'f'.repeat(64), storageObjectVersion: 'version-1' }];
        }
        if (document.id === 'already') {
          return [{ sourceSha256: sha256Hex(bytesFor(document.id)), storageObjectVersion: 'version-1' }];
        }
        return [];
      },
      readStorageVersion: async (document) => {
        if (document.id === 'missing') throw new SourceIdentityStorageFailure('missing', 'missing');
        if (document.id === 'unreadable') throw new SourceIdentityStorageFailure('unreadable', 'denied');
        const call = (versionCalls.get(document.id) ?? 0) + 1;
        versionCalls.set(document.id, call);
        return document.id === 'unstable' ? `version-${call}` : 'version-1';
      },
      downloadSourceBytes: async (document) => ({
        bytes: bytesFor(document.id),
        suppliedMediaType: 'application/pdf',
      }),
    }), { write });

    const counts = report.counts;
    const successful = counts[successCategory];
    expect(counts.eligible).toBe(
      counts.already_populated
      + successful
      + counts.missing_storage_object
      + counts.unreadable_storage_object
      + counts.unstable_version
      + counts.hash_conflict
      + counts.failed,
    );
    expect(counts.completed).toBe(counts.eligible + counts.ineligible_no_storage_path);
    expect(report.outcomes).toHaveLength(counts.completed);
    expect(new Set(report.outcomes.map(({ documentId }) => documentId)).size).toBe(counts.completed);
    expect(counts[successCategory]).toBe(1);
    expect(write ? counts.would_populate : counts.newly_populated).toBe(0);
  });

  it('does not overwrite a conflicting stored hash', async () => {
    const recordIdentity = vi.fn<SourceIdentityBackfillDependencies['recordIdentity']>();
    const report = await runSourceArtifactIdentityBackfill(dependencies({
      loadArtifacts: async () => [{ sourceSha256: 'f'.repeat(64), storageObjectVersion: 'version-1' }],
      recordIdentity,
    }), { write: true });

    expect(report.counts.hash_conflict).toBe(2);
    expect(recordIdentity).not.toHaveBeenCalled();
  });

  it('supports bounded deterministic resume without duplicate processing', async () => {
    const listDocuments = vi.fn<SourceIdentityBackfillDependencies['listDocuments']>(async ({ afterDocumentId }) => (
      afterDocumentId == null
        ? [...DOCUMENTS, { id: 'doc-c', organizationId: 'org-1', storagePath: 'org-1/c.pdf' }]
        : [{ id: 'doc-c', organizationId: 'org-1', storagePath: 'org-1/c.pdf' }]
    ));
    const deps = dependencies({ listDocuments });
    const first = await runSourceArtifactIdentityBackfill(deps, { pageSize: 2, maxDocuments: 2 });
    const second = await runSourceArtifactIdentityBackfill(deps, {
      afterDocumentId: first.lastDocumentId,
      pageSize: 2,
    });

    expect(first.hasMore).toBe(true);
    expect(first.lastDocumentId).toBe('doc-b');
    expect(second.outcomes.map((outcome) => outcome.documentId)).toEqual(['doc-c']);
  });
});
