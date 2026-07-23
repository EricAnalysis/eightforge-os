import { describe, expect, it } from 'vitest';
import type {
  ExtractionRunId,
  ExtractionSnapshot,
  ExtractionSnapshotId,
  SourceArtifactId,
} from '@/lib/extraction/domain/types';
import { createProjectionStamp } from '@/lib/interpretation/persistence/projectionStamp';

const snapshot: ExtractionSnapshot = {
  id: 'snapshot-1' as ExtractionSnapshotId,
  organization_id: 'org-1',
  source_document_id: 'document-1',
  source_artifact_id: 'source-1' as SourceArtifactId,
  source_sha256: 'a'.repeat(64),
  parser_manifest_hash: 'b'.repeat(64),
  artifact_schema_version: 'v1',
  producing_run_id: 'run-1' as ExtractionRunId,
  status: 'complete',
  content_extraction_fingerprint: 'c'.repeat(64),
  artifact_root_hash: 'd'.repeat(64),
  gap_ids: [],
  published_at: '2026-07-23T00:00:00.000Z',
};

describe('projection stamps', () => {
  it('copies the complete immutable source/snapshot identity', () => {
    expect(createProjectionStamp({
      extractionSnapshot: snapshot,
      interpretationSnapshot: {
        id: 'interpretation-1',
        extraction_snapshot_id: snapshot.id,
      },
      projectionSchemaVersion: 'projection-v1',
    })).toEqual({
      source_artifact_id: snapshot.source_artifact_id,
      source_sha256: snapshot.source_sha256,
      extraction_snapshot_id: snapshot.id,
      parser_manifest_hash: snapshot.parser_manifest_hash,
      interpretation_snapshot_id: 'interpretation-1',
      projection_schema_version: 'projection-v1',
    });
  });

  it('rejects a cross-snapshot interpretation stamp', () => {
    expect(() => createProjectionStamp({
      extractionSnapshot: snapshot,
      interpretationSnapshot: {
        id: 'interpretation-2',
        extraction_snapshot_id: 'snapshot-other',
      },
      projectionSchemaVersion: 'projection-v1',
    })).toThrow(/does not target/);
  });
});
