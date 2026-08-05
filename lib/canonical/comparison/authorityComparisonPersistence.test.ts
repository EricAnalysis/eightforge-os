/**
 * Audit-only comparison persistence.
 *
 * The properties defended here are the safety ones: persistence never throws,
 * comparison objects never land inside the publisher's idempotency scope, an
 * unchanged comparison is content-addressed and suppressed rather than duplicated,
 * and a failed comparison is still recorded so a broken comparator cannot look like
 * a project with no divergences.
 */

import { describe, expect, it } from 'vitest';

import { CANONICAL_SHADOW_ARTIFACT_BUCKET } from '@/lib/canonical/publication/shadowArtifactDestination';

import { cleanProfile, crossDocumentProfile } from './__fixtures__/authorityComparisonFixtures';
import {
  AUTHORITY_COMPARISON_ARTIFACT_PREFIX,
  authorityComparisonArtifactPath,
  persistAuthorityComparison,
  readAuthorityComparisonArtifact,
  type ComparisonStorageAdmin,
} from './authorityComparisonPersistence';
import {
  PROJECT_TRUTH_AUTHORITY_COMPARISON_VERSION,
  isFailedComparison,
  type AuthorityComparisonOutcome,
  type ProjectTruthAuthorityComparison,
} from './authorityComparisonModel';
import { runProjectTruthAuthorityComparison } from './runProjectTruthAuthorityComparison';
import type { ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';

type Upload = { readonly path: string; readonly bytes: Uint8Array };

function fakeAdmin(options: {
  readonly uploads?: Upload[];
  readonly failWith?: { message: string; statusCode?: string };
  readonly existing?: Map<string, string>;
} = {}): ComparisonStorageAdmin {
  const uploads = options.uploads ?? [];
  const existing = options.existing ?? new Map<string, string>();
  return {
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe(CANONICAL_SHADOW_ARTIFACT_BUCKET);
        return {
          upload: async (path, bytes) => {
            if (options.failWith) return { error: options.failWith };
            if (existing.has(path)) {
              return { error: { message: 'The resource already exists', statusCode: '409' } };
            }
            uploads.push({ path, bytes });
            existing.set(path, new TextDecoder().decode(bytes));
            return { error: null };
          },
          download: async (path) => (existing.has(path)
            ? { data: { text: async () => existing.get(path)! }, error: null }
            : { data: null, error: { message: 'not found' } }),
        };
      },
    },
  };
}

async function compare(
  snapshot: ValidatorSourceSnapshot,
): Promise<ProjectTruthAuthorityComparison> {
  const outcome = await runProjectTruthAuthorityComparison(snapshot.project.id, {
    sourceSnapshot: snapshot,
    now: () => '2026-08-05T00:00:00.000Z',
  });
  if (isFailedComparison(outcome)) throw new Error(outcome.failureReason);
  return outcome;
}

describe('artifact path', () => {
  it('lives under its own prefix, outside the publisher run scope', () => {
    const path = authorityComparisonArtifactPath({
      projectId: 'project-a',
      inputSnapshotDigest: 'digest-input',
      contentDigest: 'digest-content',
    });

    expect(path).toBe(
      `${AUTHORITY_COMPARISON_ARTIFACT_PREFIX}/project/project-a/input/digest-input/digest-content.json`,
    );
    // The publisher's idempotency scope is `project/{id}/run/{runId}/…`. A comparison
    // must never appear there, or it could be mistaken for — or collide with — a
    // canonical publication.
    expect(path.startsWith('project/')).toBe(false);
    expect(path).not.toContain('/run/');
  });

  it('escapes project ids so a crafted id cannot escape the prefix', () => {
    const path = authorityComparisonArtifactPath({
      projectId: '../../escape',
      inputSnapshotDigest: 'd1',
      contentDigest: 'd2',
    });

    expect(path.startsWith(`${AUTHORITY_COMPARISON_ARTIFACT_PREFIX}/`)).toBe(true);
    expect(path).not.toContain('../');
  });
});

describe('audit-only persistence', () => {
  it('writes one immutable object keyed by input and content digest', async () => {
    const comparison = await compare(crossDocumentProfile());
    const uploads: Upload[] = [];

    const result = await persistAuthorityComparison({
      outcome: comparison,
      admin: fakeAdmin({ uploads }),
    });

    expect(result.status).toBe('written');
    expect(uploads.length).toBe(1);
    expect(uploads[0]!.path).toContain(comparison.inputSnapshotDigest);
    const stored = JSON.parse(new TextDecoder().decode(uploads[0]!.bytes));
    expect(stored.projectId).toBe('fixture-cross-document');
    expect(stored.comparisonVersion).toBe(PROJECT_TRUTH_AUTHORITY_COMPARISON_VERSION);
  });

  it('records every field an operator needs without downloading the artifact', async () => {
    const comparison = await compare(crossDocumentProfile());
    const result = await persistAuthorityComparison({
      outcome: comparison,
      admin: fakeAdmin(),
    });

    expect(result.status).toBe('written');
    const record = (result as { record: Record<string, unknown> }).record;
    expect(record.projectId).toBe('fixture-cross-document');
    expect(record.comparisonVersion).toBe(PROJECT_TRUTH_AUTHORITY_COMPARISON_VERSION);
    expect(record.inputSnapshotDigest).toBe(comparison.inputSnapshotDigest);
    expect(record.comparisonStatus).toBe(comparison.comparisonStatus);
    expect(record.totalDeltas).toBe(comparison.classificationSummary.totalDeltas);
    expect(record.blockingDeltas).toBe(comparison.classificationSummary.blockingDeltas);
    expect(record.legacySummaryDigest).not.toBeNull();
    expect(record.canonicalSummaryDigest).not.toBeNull();
    expect(record.artifactReference).not.toBeNull();
    expect(record.operatorDispositionSummary).not.toBeNull();
    expect(record.createdAt).toBe('2026-08-05T00:00:00.000Z');
  });

  it('suppresses an unchanged comparison instead of accumulating duplicates', async () => {
    const uploads: Upload[] = [];
    const admin = fakeAdmin({ uploads });

    const first = await persistAuthorityComparison({
      outcome: await compare(crossDocumentProfile()),
      admin,
    });
    const second = await persistAuthorityComparison({
      outcome: await compare(crossDocumentProfile()),
      admin,
    });

    expect(first.status).toBe('written');
    expect(second.status).toBe('duplicate_suppressed');
    expect(uploads.length).toBe(1);
  });

  it('writes a different object when the comparison content changes', async () => {
    const uploads: Upload[] = [];
    const admin = fakeAdmin({ uploads });

    await persistAuthorityComparison({ outcome: await compare(crossDocumentProfile()), admin });
    await persistAuthorityComparison({ outcome: await compare(cleanProfile()), admin });

    expect(uploads.length).toBe(2);
    expect(uploads[0]!.path).not.toBe(uploads[1]!.path);
  });

  it('persists a failed comparison so a broken comparator is not invisible', async () => {
    const failure: AuthorityComparisonOutcome = {
      comparisonVersion: PROJECT_TRUTH_AUTHORITY_COMPARISON_VERSION,
      projectId: 'fixture-clean',
      inputSnapshotDigest: 'digest-input',
      comparisonStatus: 'comparison_failed',
      failureReason: 'comparison_failed: injected',
      createdAt: '2026-08-05T00:00:00.000Z',
    };
    const uploads: Upload[] = [];

    const result = await persistAuthorityComparison({ outcome: failure, admin: fakeAdmin({ uploads }) });

    expect(result.status).toBe('written');
    expect(uploads.length).toBe(1);
    const record = (result as { record: Record<string, unknown> }).record;
    expect(record.comparisonStatus).toBe('comparison_failed');
    expect(record.failureReason).toBe('comparison_failed: injected');
    expect(record.totalDeltas).toBe(0);
  });

  it('skips rather than fabricating a path when the comparison has no input digest', async () => {
    const result = await persistAuthorityComparison({
      outcome: {
        comparisonVersion: PROJECT_TRUTH_AUTHORITY_COMPARISON_VERSION,
        projectId: 'fixture-clean',
        inputSnapshotDigest: null,
        comparisonStatus: 'comparison_failed',
        failureReason: 'comparison_reentered',
        createdAt: '2026-08-05T00:00:00.000Z',
      },
      admin: fakeAdmin(),
    });

    expect(result.status).toBe('skipped');
    expect((result as { reason: string }).reason).toContain('input snapshot digest');
  });
});

describe('persistence failure never escapes', () => {
  it('returns a failed status instead of throwing on a storage error', async () => {
    const result = await persistAuthorityComparison({
      outcome: await compare(cleanProfile()),
      admin: fakeAdmin({ failWith: { message: 'bucket missing', statusCode: '404' } }),
    });

    expect(result.status).toBe('failed');
    expect((result as { reason: string }).reason).toContain('bucket missing');
  });

  it('returns a failed status instead of throwing when the client raises', async () => {
    const result = await persistAuthorityComparison({
      outcome: await compare(cleanProfile()),
      admin: {
        storage: {
          from: () => {
            throw new Error('client exploded');
          },
        },
      } as unknown as ComparisonStorageAdmin,
    });

    expect(result.status).toBe('failed');
    expect((result as { reason: string }).reason).toContain('client exploded');
  });

  it('skips when no storage client is configured', async () => {
    const result = await persistAuthorityComparison({
      outcome: await compare(cleanProfile()),
      admin: null,
    });

    // No client in a test environment. Skipped, never thrown.
    expect(['skipped', 'failed']).toContain(result.status);
  });
});

describe('the reader is operator tooling, never an authority', () => {
  it('reads back an artifact it wrote', async () => {
    const admin = fakeAdmin();
    const comparison = await compare(cleanProfile());
    const written = await persistAuthorityComparison({ outcome: comparison, admin });
    const path = (written as { record: { artifactReference: string } }).record.artifactReference;

    const read = await readAuthorityComparisonArtifact({ path, admin });

    expect(read.status).toBe('read');
    expect(JSON.parse((read as { json: string }).json).projectId).toBe('fixture-clean');
  });

  it('refuses a path outside the comparison prefix', async () => {
    for (const path of [
      'project/p/run/r/manifest.json',
      `${AUTHORITY_COMPARISON_ARTIFACT_PREFIX}/../project/p/run/r/manifest.json`,
    ]) {
      const read = await readAuthorityComparisonArtifact({ path, admin: fakeAdmin() });
      expect(read.status).toBe('failed');
    }
  });

  it('returns a failure instead of throwing for a missing artifact', async () => {
    const read = await readAuthorityComparisonArtifact({
      path: `${AUTHORITY_COMPARISON_ARTIFACT_PREFIX}/project/p/input/d/absent.json`,
      admin: fakeAdmin(),
    });

    expect(read.status).toBe('failed');
  });
});
