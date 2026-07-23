import type {
  ExtractionSnapshot,
  ProjectionStamp,
} from '@/lib/extraction/domain/types';

export function createProjectionStamp(input: {
  readonly extractionSnapshot: ExtractionSnapshot;
  readonly interpretationSnapshot: {
    readonly id: string;
    readonly extraction_snapshot_id: string;
  };
  readonly projectionSchemaVersion: string;
}): ProjectionStamp {
  if (
    input.interpretationSnapshot.extraction_snapshot_id
    !== input.extractionSnapshot.id
  ) {
    throw new Error('Interpretation snapshot does not target the extraction snapshot.');
  }
  if (!input.projectionSchemaVersion.trim()) {
    throw new Error('Projection schema version is required.');
  }
  return Object.freeze({
    source_artifact_id: input.extractionSnapshot.source_artifact_id,
    source_sha256: input.extractionSnapshot.source_sha256,
    extraction_snapshot_id: input.extractionSnapshot.id,
    parser_manifest_hash: input.extractionSnapshot.parser_manifest_hash,
    interpretation_snapshot_id: input.interpretationSnapshot.id,
    projection_schema_version: input.projectionSchemaVersion,
  });
}
