import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'vitest';

import {
  CANONICAL_PROJECT_TRUTH_SCHEMA_VERSION,
  type SourceArtifactSnapshotEntry,
} from './projectTruthPublication';
import {
  buildProjectTruthPublicationIdentity,
  canonicalJson,
  hashCanonicalJson,
} from './projectTruthPublicationIdentity';
import { bindPublicationSourceDocuments, publicationAvailabilityGap } from './projectTruthShadowAdapter';
import { prepareCanonicalTransactionStream } from './projectTruthTransactionStream';
import { isCanonicalShadowPublicationEnabled, resolveCanonicalShadowPublicationFlag } from './shadowPublicationFlag';

function artifact(overrides: Partial<SourceArtifactSnapshotEntry> = {}): SourceArtifactSnapshotEntry {
  return {
    documentId: 'document-1', documentType: 'invoice', documentRole: 'billing',
    storagePath: 'private/invoice.pdf', sourceArtifactId: 'artifact-1', sourceSha256: 'sha-a',
    storageObjectVersion: 'version-a', mediaTypeSniffed: 'application/pdf', byteLength: 123,
    artifactCreatedAt: '2026-08-02T00:00:00.000Z',
    exactSourceIdentity: 'artifact-1:sha-a:version-a', ...overrides,
  };
}

async function bytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('canonical Project Truth publication domain', () => {
  it('keeps publication disabled by default and parses deterministic allowlists', () => {
    assert.deepEqual(resolveCanonicalShadowPublicationFlag(undefined), { mode: 'off', projectIds: [] });
    assert.deepEqual(resolveCanonicalShadowPublicationFlag('allowlist', ' project-b,project-a,project-b '), {
      mode: 'allowlist', projectIds: ['project-a', 'project-b'],
    });
    assert.deepEqual(resolveCanonicalShadowPublicationFlag('project-a', 'project-a'), { mode: 'off', projectIds: [] });
    assert.equal(isCanonicalShadowPublicationEnabled('project-a', 'off'), false);
    assert.equal(isCanonicalShadowPublicationEnabled('project-a', 'allowlist', 'project-b'), false);
    assert.equal(isCanonicalShadowPublicationEnabled('project-a', 'allowlist', 'project-a,project-b'), true);
    assert.equal(isCanonicalShadowPublicationEnabled('anything', 'all'), true);
  });

  it('canonicalizes object keys and excludes generated time from publication identity', () => {
    assert.equal(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: 3 }), canonicalJson({ a: 3, nested: { a: 1, b: 2 }, z: 1 }));
    const common = {
      projectId: 'project-1', inputsSnapshotHash: 'input-hash', registryContentHash: 'registry-hash',
      parityContentHash: 'parity-hash', gapContentHash: 'gap-hash', runId: 'run-1', pipelineVersion: 'commit-1',
      canonicalSchemaVersion: CANONICAL_PROJECT_TRUTH_SCHEMA_VERSION,
    };
    const first = buildProjectTruthPublicationIdentity(common);
    const second = buildProjectTruthPublicationIdentity({ ...common });
    assert.deepEqual(first, second);
    assert.notEqual(first.publicationId, buildProjectTruthPublicationIdentity({ ...common, gapContentHash: 'changed' }).publicationId);
  });

  it('emits deterministic gaps without inferring a missing exact source identity', () => {
    const missing = bindPublicationSourceDocuments({
      snapshot: [artifact({ sourceArtifactId: null, sourceSha256: null, storageObjectVersion: null, exactSourceIdentity: null })],
      governingDocumentIds: { invoice: ['document-1'] },
    });
    assert.equal(missing.gaps.length, 1);
    assert.equal(missing.gaps[0]?.reason, 'source_unavailable');
    assert.deepEqual(missing.gaps[0], {
      ...missing.gaps[0],
      boundary: 'manifest',
      reason: 'source_unavailable',
      rejectingFunction: 'bindPublicationSourceDocuments',
      missingFields: ['sourceArtifactId', 'sourceSha256', 'storageObjectVersion'],
    });
    assert.equal(missing.documents[0]?.exactSourceIdentity, null);
    assert.equal(missing.documents[0]?.isGoverning, true);
    assert.equal(missing.documents[0]?.family, 'invoice');

    const repeated = bindPublicationSourceDocuments({
      snapshot: [artifact({ sourceArtifactId: null, sourceSha256: null, storageObjectVersion: null, exactSourceIdentity: null })],
      governingDocumentIds: { invoice: ['document-1'] },
    });
    assert.equal(repeated.gaps[0]?.gapKey, missing.gaps[0]?.gapKey);

    for (const [overrides, expected] of [
      [{ sourceArtifactId: null, exactSourceIdentity: null }, ['sourceArtifactId']],
      [{ sourceSha256: null, exactSourceIdentity: null }, ['sourceSha256']],
      [{ storageObjectVersion: null, exactSourceIdentity: null }, ['storageObjectVersion']],
    ] as const) {
      const bound = bindPublicationSourceDocuments({
        snapshot: [artifact(overrides)],
        governingDocumentIds: {},
      });
      assert.deepEqual(bound.gaps[0]?.missingFields, expected);
    }
  });

  it('distinguishes immutable versions of the same logical document', () => {
    const first = bindPublicationSourceDocuments({ snapshot: [artifact()], governingDocumentIds: {} });
    const second = bindPublicationSourceDocuments({
      snapshot: [artifact({ storageObjectVersion: 'version-b', exactSourceIdentity: 'artifact-1:sha-a:version-b' })],
      governingDocumentIds: {},
    });
    assert.notEqual(first.sourceSnapshotId, second.sourceSnapshotId);
    const changedSha = bindPublicationSourceDocuments({
      snapshot: [artifact({ sourceSha256: 'sha-b', exactSourceIdentity: 'artifact-1:sha-b:version-a' })],
      governingDocumentIds: {},
    });
    assert.notEqual(first.sourceSnapshotId, changedSha.sourceSnapshotId);

    const identityFor = (registryContentHash: string) => buildProjectTruthPublicationIdentity({
      projectId: 'project-1', inputsSnapshotHash: 'input-hash', registryContentHash,
      parityContentHash: 'parity-hash', gapContentHash: 'gap-hash', runId: 'run-1',
      pipelineVersion: 'commit-1', canonicalSchemaVersion: CANONICAL_PROJECT_TRUTH_SCHEMA_VERSION,
    }).publicationId;
    assert.notEqual(identityFor(first.sourceSnapshotId), identityFor(second.sourceSnapshotId));
    assert.notEqual(identityFor(first.sourceSnapshotId), identityFor(changedSha.sourceSnapshotId));
  });

  it('classifies unavailable summaries from the exact rule-pack execution record', () => {
    assert.equal(publicationAvailabilityGap({
      rulesApplied: [], boundary: 'exposure', packId: 'financial_integrity', detail: 'missing',
    }).reason, 'pack_not_executed');
    assert.equal(publicationAvailabilityGap({
      rulesApplied: ['financial_integrity:failed'], boundary: 'exposure', packId: 'financial_integrity', detail: 'missing',
    }).reason, 'pack_failed');
    assert.equal(publicationAvailabilityGap({
      rulesApplied: ['financial_integrity'], boundary: 'exposure', packId: 'financial_integrity', detail: 'missing',
    }).reason, 'source_unavailable');
  });

  it('hashes and streams all 5,063 transactions in identical bounded passes', async () => {
    const rows = Array.from({ length: 5_063 }, (_, index) => ({
      id: `transaction-${String(index).padStart(5, '0')}`,
      document_id: 'document-1',
      transaction_number: `T-${index}`,
      transaction_quantity: index + 1,
      extended_cost: index * 2,
      source_sheet_name: 'Transactions',
      source_row_number: index + 2,
      record_json: { applied_rate: 2, material: 'source-observed' },
      raw_row_json: { ticket: `T-${index}` },
    })).reverse();
    const prepared = prepareCanonicalTransactionStream({ rows, sourceArtifacts: [artifact()] });
    assert.equal(prepared.count, 5_063);
    const first = prepared.createGzipStream();
    const firstBytes = await bytes(first.stream);
    assert.deepEqual(await first.verification, { count: 5_063, digest: prepared.digest });
    const lines = gunzipSync(firstBytes).toString('utf8').trimEnd().split('\n');
    assert.equal(lines.length, 5_063);
    const decoded = lines.map((line) => JSON.parse(line) as { transactionId: string });
    assert.equal(decoded[0]?.transactionId, 'transaction-00000');
    assert.equal(decoded.at(-1)?.transactionId, 'transaction-05062');
    assert.deepEqual(
      decoded.map((transaction) => transaction.transactionId),
      [...decoded.map((transaction) => transaction.transactionId)].sort((left, right) => (
        left.localeCompare(right, 'en-US')
      )),
    );

    const second = prepared.createGzipStream();
    const secondBytes = await bytes(second.stream);
    await second.verification;
    assert.deepEqual(secondBytes, firstBytes);
  }, 60_000);
});
