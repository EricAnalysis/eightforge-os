import type {
  CanonicalFactId,
  ExtractionRunId,
  ExtractionSnapshotId,
  FieldCandidateId,
  FragmentArtifactId,
  PageArtifactId,
  SourceArtifactId,
  VerifiedFieldId,
} from '@/lib/extraction/domain/types';
import { hashCanonical } from '@/lib/extraction/domain/hash';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function opaqueUuid<T extends string>(kind: string, semanticIdentity: unknown): T {
  const digest = hashCanonical({ kind, semantic_identity: semanticIdentity });
  const versioned = `${digest.slice(0, 12)}5${digest.slice(13, 16)}`;
  const variantNibble = ((Number.parseInt(digest[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return [
    versioned.slice(0, 8),
    versioned.slice(8, 12),
    versioned.slice(12, 16),
    `${variantNibble}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-') as T;
}

/**
 * Artifact identifiers are association identities, not content fingerprints.
 * Content identity remains in the explicit hash fields on each artifact.
 */
export const opaqueIds = Object.freeze({
  existingSourceArtifact: (value: string): SourceArtifactId => {
    if (!UUID_PATTERN.test(value)) {
      throw new Error('source artifact identity must be a UUID');
    }
    return value as SourceArtifactId;
  },
  sourceArtifact: (identity: unknown): SourceArtifactId =>
    opaqueUuid('source_artifact', identity),
  extractionRun: (identity: unknown): ExtractionRunId =>
    opaqueUuid('extraction_run', identity),
  pageArtifact: (identity: unknown): PageArtifactId =>
    opaqueUuid('page_artifact', identity),
  fragmentArtifact: (identity: unknown): FragmentArtifactId =>
    opaqueUuid('fragment_artifact', identity),
  fieldCandidate: (identity: unknown): FieldCandidateId =>
    opaqueUuid('field_candidate', identity),
  verifiedField: (identity: unknown): VerifiedFieldId =>
    opaqueUuid('verified_field', identity),
  extractionSnapshot: (identity: unknown): ExtractionSnapshotId =>
    opaqueUuid('extraction_snapshot', identity),
  canonicalFact: (identity: unknown): CanonicalFactId =>
    opaqueUuid('canonical_fact', identity),
  processingGap: (identity: unknown): string =>
    opaqueUuid('processing_gap', identity),
});
