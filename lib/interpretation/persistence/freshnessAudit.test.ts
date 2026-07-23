import { describe, expect, it } from 'vitest';
import {
  evaluateFreshnessShadow,
  STEP0_ENTITY_RESOLVER_VERSION,
  STEP0_INTERPRETER_MANIFEST_HASH,
  type FreshnessAuditInput,
} from '@/lib/interpretation/persistence/freshnessAudit';

function freshInput(overrides: Partial<FreshnessAuditInput> = {}): FreshnessAuditInput {
  return {
    sourceDocumentId: 'document-1',
    currentSourceArtifactId: 'source-1',
    assignedSourceArtifactId: 'source-1',
    currentSourceSha256: 'a'.repeat(64),
    desiredParserManifestHash: 'b'.repeat(64),
    desiredArtifactSchemaVersion: 'extraction-artifact-v1',
    activationMode: 'shadow',
    extractionSnapshot: {
      id: 'snapshot-1',
      sourceArtifactId: 'source-1',
      sourceSha256: 'a'.repeat(64),
      parserManifestHash: 'b'.repeat(64),
      artifactSchemaVersion: 'extraction-artifact-v1',
      status: 'complete',
      invalidated: false,
      dependencyRootValid: true,
      hasGapMember: false,
    },
    interpretationSnapshot: {
      id: 'interpretation-1',
      extractionSnapshotId: 'snapshot-1',
      status: 'complete',
      interpreterManifestHash: STEP0_INTERPRETER_MANIFEST_HASH,
      entityResolverVersion: STEP0_ENTITY_RESOLVER_VERSION,
    },
    ...overrides,
  };
}

describe('validator freshness shadow evaluator', () => {
  it('recognizes a fresh, exactly pinned snapshot without blocking', () => {
    expect(evaluateFreshnessShadow(freshInput())).toMatchObject({
      mode: 'shadow',
      fresh: true,
      codes: [],
    });
  });

  it.each([
    [
      'missing extraction',
      { extractionSnapshot: null },
      ['MISSING_EXTRACTION_SNAPSHOT'],
    ],
    [
      'source mismatch',
      {
        extractionSnapshot: {
          ...freshInput().extractionSnapshot!,
          sourceSha256: 'c'.repeat(64),
        },
      },
      ['STALE_EXTRACTION_SNAPSHOT'],
    ],
    [
      'assignment source mismatch',
      { assignedSourceArtifactId: 'source-other' },
      ['STALE_EXTRACTION_SNAPSHOT'],
    ],
    [
      'complete status with a gap member',
      {
        extractionSnapshot: {
          ...freshInput().extractionSnapshot!,
          hasGapMember: true,
        },
      },
      ['EXTRACTION_GAP'],
    ],
    [
      'manifest mismatch',
      {
        extractionSnapshot: {
          ...freshInput().extractionSnapshot!,
          parserManifestHash: 'c'.repeat(64),
        },
      },
      ['STALE_EXTRACTION_SNAPSHOT'],
    ],
    [
      'schema mismatch',
      {
        extractionSnapshot: {
          ...freshInput().extractionSnapshot!,
          artifactSchemaVersion: 'v0',
        },
      },
      ['UNSUPPORTED_ARTIFACT_SCHEMA'],
    ],
    [
      'matching but unsupported schemas',
      {
        desiredArtifactSchemaVersion: 'unknown-v9',
        extractionSnapshot: {
          ...freshInput().extractionSnapshot!,
          artifactSchemaVersion: 'unknown-v9',
        },
      },
      ['UNSUPPORTED_ARTIFACT_SCHEMA'],
    ],
    [
      'partial extraction',
      {
        extractionSnapshot: {
          ...freshInput().extractionSnapshot!,
          status: 'partial' as const,
        },
      },
      ['EXTRACTION_GAP'],
    ],
    [
      'interpretation mismatch',
      {
        interpretationSnapshot: {
          ...freshInput().interpretationSnapshot!,
          id: 'interpretation-2',
          extractionSnapshotId: 'snapshot-other',
          status: 'complete' as const,
        },
      },
      ['INTERPRETATION_SNAPSHOT_MISMATCH'],
    ],
  ])('detects %s in shadow mode', (_label, overrides, codes) => {
    const result = evaluateFreshnessShadow(freshInput(overrides));
    expect(result.fresh).toBe(false);
    expect(result.codes).toEqual(expect.arrayContaining(codes));
    expect(result.mode).toBe('shadow');
  });
});
