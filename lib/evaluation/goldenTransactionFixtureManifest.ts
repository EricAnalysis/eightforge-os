/** Golden transaction fixture identity helpers — EVALUATION ONLY. */
import manifest from '@/lib/evaluation/goldenTransactionFixtureManifest.json';

export const GOLDEN_TRANSACTION_FIXTURE_MANIFEST = manifest;

export type GoldenTransactionSourceStatus =
  | 'exact_source_parity'
  | 'non_authoritative_source';

export type GoldenTransactionSourceIdentity = {
  readonly logicalRole: string;
  readonly status: GoldenTransactionSourceStatus;
  readonly sha256: string;
  readonly expectedRowCount: number;
  readonly persistedReferenceCount: number;
  readonly delta: number;
};

export function requireAuthoritativeGoldenTransactionHash(sha256: string): void {
  if (sha256 === manifest.authoritative.sha256) return;
  const variant = manifest.known_variants.find((candidate) => candidate.sha256 === sha256);
  if (variant) {
    throw new Error(
      `Golden transaction source is non_authoritative_source (${variant.logical_role}, ${variant.sha256}); the full-chain fixture requires ${manifest.authoritative.logical_role} (${manifest.authoritative.sha256}).`,
    );
  }
  throw new Error(`Unknown Golden transaction workbook hash: ${sha256}.`);
}

export function identifyGoldenTransactionSource(
  sha256: string,
  rowCount: number,
): GoldenTransactionSourceIdentity {
  const authoritative = manifest.authoritative;
  const persistedReferenceCount = manifest.authoritative_expected_rollups.row_count;

  if (sha256 === authoritative.sha256) {
    if (rowCount !== authoritative.data_row_count) {
      throw new Error(
        `Golden authoritative transaction population mismatch: expected ${authoritative.data_row_count} rows for ${authoritative.sha256}, received ${rowCount}.`,
      );
    }
    return {
      logicalRole: authoritative.logical_role,
      status: 'exact_source_parity',
      sha256,
      expectedRowCount: authoritative.data_row_count,
      persistedReferenceCount,
      delta: rowCount - persistedReferenceCount,
    };
  }

  const variant = manifest.known_variants.find((candidate) => candidate.sha256 === sha256);
  if (variant) {
    if (rowCount !== variant.data_row_count) {
      throw new Error(
        `Golden edited transaction variant population mismatch: expected ${variant.data_row_count} rows for ${variant.sha256}, received ${rowCount}.`,
      );
    }
    return {
      logicalRole: variant.logical_role,
      status: 'non_authoritative_source',
      sha256,
      expectedRowCount: variant.data_row_count,
      persistedReferenceCount,
      delta: rowCount - persistedReferenceCount,
    };
  }

  throw new Error(`Unknown Golden transaction workbook hash: ${sha256}.`);
}

export function requireAuthoritativeGoldenTransactionSource(
  sha256: string,
  rowCount: number,
): GoldenTransactionSourceIdentity {
  requireAuthoritativeGoldenTransactionHash(sha256);
  const identity = identifyGoldenTransactionSource(sha256, rowCount);
  if (identity.status !== 'exact_source_parity') {
    throw new Error(
      `Golden transaction source is ${identity.status} (${identity.logicalRole}, ${identity.sha256}); the full-chain fixture requires ${manifest.authoritative.logical_role} (${manifest.authoritative.sha256}).`,
    );
  }
  return identity;
}
