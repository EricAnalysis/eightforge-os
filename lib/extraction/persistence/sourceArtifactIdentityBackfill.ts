import { sha256Hex } from '@/lib/extraction/domain/hash';
import { sniffExtractionMediaType } from '@/lib/extraction/persistence/shadowSourceIdentity';

export type SourceIdentityBackfillDocument = Readonly<{
  id: string;
  organizationId: string;
  storagePath: string | null;
}>;

export type SourceIdentityBackfillArtifact = Readonly<{
  sourceSha256: string;
  storageObjectVersion: string;
}>;

export type SourceIdentityStorageFailureKind = 'missing' | 'unreadable';

export class SourceIdentityStorageFailure extends Error {
  constructor(
    readonly kind: SourceIdentityStorageFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'SourceIdentityStorageFailure';
  }
}

export class SourceIdentityWriteConflict extends Error {
  constructor(message = 'immutable source identity conflicts with the stored artifact') {
    super(message);
    this.name = 'SourceIdentityWriteConflict';
  }
}

export type SourceIdentityBackfillCounts = Readonly<{
  eligible: number;
  ineligible_no_storage_path: number;
  already_populated: number;
  would_populate: number;
  newly_populated: number;
  missing_storage_object: number;
  unreadable_storage_object: number;
  unstable_version: number;
  hash_conflict: number;
  failed: number;
  completed: number;
}>;

export type SourceIdentityBackfillTerminalCategory = Exclude<
  keyof SourceIdentityBackfillCounts,
  'eligible' | 'completed'
>;

export type SourceIdentityBackfillReport = Readonly<{
  mode: 'dry-run' | 'write';
  afterDocumentId: string | null;
  lastDocumentId: string | null;
  hasMore: boolean;
  counts: SourceIdentityBackfillCounts;
  outcomes: readonly Readonly<{
    documentId: string;
    category: SourceIdentityBackfillTerminalCategory;
  }>[];
}>;

export type SourceIdentityBackfillDependencies = Readonly<{
  listDocuments(input: {
    afterDocumentId: string | null;
    limit: number;
  }): Promise<readonly SourceIdentityBackfillDocument[]>;
  loadArtifacts(document: SourceIdentityBackfillDocument): Promise<readonly SourceIdentityBackfillArtifact[]>;
  readStorageVersion(document: SourceIdentityBackfillDocument): Promise<string>;
  downloadSourceBytes(document: SourceIdentityBackfillDocument): Promise<Readonly<{
    bytes: ArrayBuffer;
    suppliedMediaType: string | null;
  }>>;
  recordIdentity(input: {
    document: SourceIdentityBackfillDocument;
    sourceSha256: string;
    storageObjectVersion: string;
    byteLength: number;
    mediaTypeSniffed: string;
  }): Promise<'already_populated' | 'newly_populated'>;
}>;

const EMPTY_COUNTS: SourceIdentityBackfillCounts = Object.freeze({
  eligible: 0,
  ineligible_no_storage_path: 0,
  already_populated: 0,
  would_populate: 0,
  newly_populated: 0,
  missing_storage_object: 0,
  unreadable_storage_object: 0,
  unstable_version: 0,
  hash_conflict: 0,
  failed: 0,
  completed: 0,
});

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

/**
 * Backfills immutable source identity without ever updating an artifact row.
 *
 * The caller supplies storage/database adapters so the state machine is fully
 * testable. Every object is versioned before and after download; changed
 * metadata is an unstable-version outcome, never a manufactured identity. Dry-run performs
 * the same reads and conflict checks but never calls `recordIdentity`.
 */
export async function runSourceArtifactIdentityBackfill(
  dependencies: SourceIdentityBackfillDependencies,
  options: Readonly<{
    write?: boolean;
    afterDocumentId?: string | null;
    pageSize?: number;
    maxDocuments?: number;
  }> = {},
): Promise<SourceIdentityBackfillReport> {
  const pageSize = Math.min(positiveInteger(options.pageSize ?? 100, 'pageSize'), 1_000);
  const maxDocuments = positiveInteger(options.maxDocuments ?? pageSize, 'maxDocuments');
  const requestedLimit = Math.min(pageSize, maxDocuments) + 1;
  const listed = [...await dependencies.listDocuments({
    afterDocumentId: options.afterDocumentId ?? null,
    limit: requestedLimit,
  })].sort((left, right) => left.id.localeCompare(right.id, 'en-US'));
  const hasMore = listed.length > Math.min(pageSize, maxDocuments);
  const documents = listed.slice(0, Math.min(pageSize, maxDocuments));
  const mutableCounts = { ...EMPTY_COUNTS };
  const outcomes: Array<{ documentId: string; category: SourceIdentityBackfillTerminalCategory }> = [];

  const finish = (
    documentId: string,
    category: SourceIdentityBackfillTerminalCategory,
  ) => {
    mutableCounts[category] += 1;
    mutableCounts.completed += 1;
    outcomes.push({ documentId, category });
  };

  for (const document of documents) {
    if (!document.storagePath) {
      finish(document.id, 'ineligible_no_storage_path');
      continue;
    }
    mutableCounts.eligible += 1;

    try {
      const artifacts = await dependencies.loadArtifacts(document);
      const beforeVersion = await dependencies.readStorageVersion(document);
      const downloaded = await dependencies.downloadSourceBytes(document);
      const bytes = downloaded.bytes;
      const afterVersion = await dependencies.readStorageVersion(document);
      if (!beforeVersion || beforeVersion !== afterVersion) {
        finish(document.id, 'unstable_version');
        continue;
      }

      const sourceSha256 = sha256Hex(bytes);
      const invalidArtifact = artifacts.find((artifact) => !isSha256(artifact.sourceSha256));
      const conflictingArtifact = artifacts.find((artifact) => (
        artifact.storageObjectVersion === beforeVersion
        && artifact.sourceSha256 !== sourceSha256
      ));
      if (invalidArtifact || conflictingArtifact) {
        finish(document.id, 'hash_conflict');
        continue;
      }

      const alreadyPopulated = artifacts.some((artifact) => (
        artifact.storageObjectVersion === beforeVersion
        && artifact.sourceSha256 === sourceSha256
      ));
      if (alreadyPopulated) {
        finish(document.id, 'already_populated');
        continue;
      }

      if (!options.write) {
        finish(document.id, 'would_populate');
        continue;
      }

      const result = await dependencies.recordIdentity({
        document,
        sourceSha256,
        storageObjectVersion: beforeVersion,
        byteLength: bytes.byteLength,
        mediaTypeSniffed: sniffExtractionMediaType(bytes, downloaded.suppliedMediaType),
      });
      finish(document.id, result);
    } catch (error) {
      if (error instanceof SourceIdentityStorageFailure) {
        finish(
          document.id,
          error.kind === 'missing' ? 'missing_storage_object' : 'unreadable_storage_object',
        );
      } else if (error instanceof SourceIdentityWriteConflict) {
        finish(document.id, 'hash_conflict');
      } else {
        finish(document.id, 'failed');
      }
    }
  }

  return Object.freeze({
    mode: options.write ? 'write' : 'dry-run',
    afterDocumentId: options.afterDocumentId ?? null,
    lastDocumentId: documents.at(-1)?.id ?? options.afterDocumentId ?? null,
    hasMore,
    counts: Object.freeze(mutableCounts),
    outcomes: Object.freeze(outcomes.map((outcome) => Object.freeze(outcome))),
  });
}
