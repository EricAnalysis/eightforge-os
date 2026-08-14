import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  hashParserManifest,
} from '@/lib/extraction/domain/parserManifest';
import {
  STEP0_ENTITY_RESOLVER_VERSION,
  STEP0_INTERPRETER_MANIFEST_HASH,
} from '@/lib/complianceFoundation/shadowVersions';
import type { LocatedOcrObservationSidecar } from '@/lib/extraction/ocrObservationSidecar';
import type {
  Step3InterpretationBridge,
  Step3InterpretationBridgeInput,
} from '@/lib/extraction/domain/step3InterpretationBridge';
import {
  runForgewingRegionClassification,
  type ForgewingRegionClassificationInput,
} from '@/lib/forgewing/tasks/regionClassification';
import {
  runForgewingTableContinuation,
  type ForgewingTableContinuationInput,
} from '@/lib/forgewing/tasks/tableContinuation';
import {
  isForgewingShadowEnabled,
  isForgewingTableContinuationEnabled,
} from '@/lib/forgewing/runtime/modelConfig';
import { buildRuntimeShadowParserManifest } from '@/lib/extraction/persistence/shadowRuntimeManifest';
import { sniffExtractionMediaType } from '@/lib/extraction/persistence/shadowSourceIdentity';
import { publishExtractionStep1ShadowNonBlocking } from '@/lib/extraction/persistence/step1Shadow';
import {
  persistReasoningShadowArtifact,
  type ReasoningShadowPersistenceInput,
  type ReasoningShadowPersistenceResult,
} from '@/lib/extraction/persistence/forgewingShadowPersistence';
import {
  buildGenericPdfShadowSidecar,
  mergeLocatedSidecars,
} from '@/lib/server/documentExtraction';

const ARTIFACT_SCHEMA_VERSION = 'extraction-artifact-v1';
const PROJECTION_SCHEMA_VERSION = 'step0-shadow-projection-v1';
const GAP_KEY = 'legacy-payload-missing-geometry-v1';
const GAP_DETAIL =
  'Step 0 shadow publication preserves the legacy payload unchanged; it cannot manufacture geometry-complete verified fields.';

export type ShadowWriteInput = {
  readonly admin: SupabaseClient;
  readonly organizationId: string;
  readonly sourceDocumentId: string;
  readonly sourceBytes: ArrayBuffer;
  readonly storageObjectVersion: string | null;
  readonly mediaType: string | null;
  readonly legacyExtractionPayload: Record<string, unknown>;
  readonly analysisJobId: string;
  readonly analysisMode: string;
  readonly observedAt?: string;
  readonly step3InterpretationBridge?: Step3InterpretationBridge;
};

type ScheduledShadowWriteInput = Omit<ShadowWriteInput, 'storageObjectVersion'> & {
  readonly storageBucket: string;
  readonly storagePath: string;
  readonly storageVersionBeforeDownload: string | null;
  readonly locatedObservations?: LocatedOcrObservationSidecar | null;
  readonly observedAt?: string;
};

const STORAGE_IDENTITY_TIMEOUT_MS = 1_000;
const SHADOW_PUBLICATION_TIMEOUT_MS = 10_000;

function forgewingInput(
  input: Step3InterpretationBridgeInput,
  organizationId: string,
  sourceDocumentId: string,
): ForgewingRegionClassificationInput {
  const chainCompleteness = new Map<string, 'complete' | 'partial' | 'ambiguous'>();
  for (const chain of input.chains) {
    for (const segmentId of chain.segment_ids) {
      const prior = chainCompleteness.get(segmentId);
      if (
        prior == null
        || chain.completeness === 'ambiguous'
        || (chain.completeness === 'partial' && prior === 'complete')
      ) {
        chainCompleteness.set(segmentId, chain.completeness);
      }
    }
  }
  const mapPhysical = (
    coordinate: (typeof input.segments)[number]['physical_page_coordinate'],
  ) => coordinate?.mappingState === 'resolved_physical_page'
    ? {
        physicalPageNumber: coordinate.physicalPageNumber,
        artifactLocalIndex: coordinate.artifactLocalIndex,
        sourceLayer: coordinate.sourceLayer,
      }
    : undefined;
  const mapBox = (box: (typeof input.segments)[number]['bounding_box']) => ({
    coordinateSpace: box.coordinate_space,
    origin: box.origin,
    x0: box.x0,
    y0: box.y0,
    x1: box.x1,
    y1: box.y1,
    rotation: box.rotation,
  });

  return {
    organizationId,
    sourceDocumentId,
    extractionSnapshotId: input.extraction_snapshot_id,
    segments: input.segments.map((segment) => ({
      observationId: segment.id,
      kind: 'segment' as const,
      organizationId: segment.organization_id,
      sourceDocumentId: segment.source_document_id,
      sourceArtifactId: segment.source_artifact_id,
      extractionSnapshotId: input.extraction_snapshot_id,
      pageArtifactId: segment.page_artifact_id,
      page: segment.page,
      boundingBox: mapBox(segment.bounding_box),
      text: segment.raw_text,
      readingOrder: segment.reading_order,
      ...(mapPhysical(segment.physical_page_coordinate)
        ? { physicalCoordinate: mapPhysical(segment.physical_page_coordinate) }
        : {}),
      chainCompleteness: chainCompleteness.get(segment.id) ?? 'unchained',
      detectionKinds: segment.detection_evidence.map((evidence) => evidence.kind),
    })),
    cells: input.cells.map((cell) => ({
      observationId: cell.id,
      kind: 'cell' as const,
      organizationId: cell.organization_id,
      sourceDocumentId: cell.source_document_id,
      sourceArtifactId: cell.source_artifact_id,
      extractionSnapshotId: input.extraction_snapshot_id,
      pageArtifactId: cell.page_artifact_id,
      page: cell.page,
      boundingBox: mapBox(cell.bounding_box),
      text: cell.raw_text,
      readingOrder: cell.reading_order,
      ...(mapPhysical(cell.physical_page_coordinate)
        ? { physicalCoordinate: mapPhysical(cell.physical_page_coordinate) }
        : {}),
      rowStart: cell.row_start,
      rowSpan: cell.row_span,
      columnStart: cell.column_start,
      columnSpan: cell.column_span,
      structure: cell.structure,
      targetSegmentId: cell.table_segment_id,
    })),
  };
}

function forgewingTableContinuationInput(
  input: Step3InterpretationBridgeInput,
  organizationId: string,
  sourceDocumentId: string,
): ForgewingTableContinuationInput {
  const chainCompleteness = new Map<string, 'complete' | 'partial' | 'ambiguous'>();
  for (const chain of input.chains) {
    for (const segmentId of chain.segment_ids) {
      const prior = chainCompleteness.get(segmentId);
      if (prior == null || chain.completeness === 'ambiguous'
        || (chain.completeness === 'partial' && prior === 'complete')) {
        chainCompleteness.set(segmentId, chain.completeness);
      }
    }
  }
  const mapPhysical = (
    coordinate: (typeof input.segments)[number]['physical_page_coordinate'],
  ) => coordinate?.mappingState === 'resolved_physical_page'
    ? {
        mappingState: coordinate.mappingState,
        sourceDocumentId: coordinate.sourceDocumentId,
        sourceArtifactId: coordinate.sourceArtifactId,
        physicalPageNumber: coordinate.physicalPageNumber,
        artifactLocalIndex: coordinate.artifactLocalIndex,
        sourceLayer: coordinate.sourceLayer,
      }
    : undefined;
  const mapBox = (box: (typeof input.segments)[number]['bounding_box']) => ({
    coordinateSpace: box.coordinate_space,
    origin: box.origin,
    x0: box.x0,
    y0: box.y0,
    x1: box.x1,
    y1: box.y1,
    rotation: box.rotation,
  });
  return {
    organizationId,
    sourceDocumentId,
    extractionSnapshotId: input.extraction_snapshot_id,
    segments: input.segments.map((segment) => ({
      observationId: segment.id,
      kind: 'segment' as const,
      organizationId: segment.organization_id,
      sourceDocumentId: segment.source_document_id,
      sourceArtifactId: segment.source_artifact_id,
      extractionSnapshotId: input.extraction_snapshot_id,
      pageArtifactId: segment.page_artifact_id,
      boundingBox: mapBox(segment.bounding_box),
      text: segment.raw_text,
      readingOrder: segment.reading_order,
      ...(mapPhysical(segment.physical_page_coordinate)
        ? { physicalCoordinate: mapPhysical(segment.physical_page_coordinate) }
        : {}),
      chainCompleteness: chainCompleteness.get(segment.id) ?? 'unchained',
      columns: segment.column_hypotheses.map((column) => ({
        index: column.index,
        x0: column.x0,
        x1: column.x1,
        observedHeader: column.header.observed_text,
        normalizedHeader: column.header.normalized_label,
        valueKinds: column.value_kind_hypotheses.map((hypothesis) => hypothesis.kind),
      })),
      repeatedHeaderCount: segment.repeated_header_row_ids.length,
      detectionKinds: segment.detection_evidence.map((evidence) => evidence.kind),
    })),
    cells: input.cells.map((cell) => ({
      observationId: cell.id,
      kind: 'cell' as const,
      organizationId: cell.organization_id,
      sourceDocumentId: cell.source_document_id,
      sourceArtifactId: cell.source_artifact_id,
      extractionSnapshotId: input.extraction_snapshot_id,
      pageArtifactId: cell.page_artifact_id,
      boundingBox: mapBox(cell.bounding_box),
      text: cell.raw_text,
      readingOrder: cell.reading_order,
      ...(mapPhysical(cell.physical_page_coordinate)
        ? { physicalCoordinate: mapPhysical(cell.physical_page_coordinate) }
        : {}),
      targetSegmentId: cell.table_segment_id,
      rowStart: cell.row_start,
      rowSpan: cell.row_span,
      columnStart: cell.column_start,
      columnSpan: cell.column_span,
      structure: cell.structure,
    })),
    continuationLinks: (input.continuation_links ?? []).map((link) => ({
      linkId: link.id,
      fromSegmentId: link.from_segment_id,
      toSegmentId: link.to_segment_id,
      decision: link.decision,
    })),
  };
}

export function withForgewingRegionClassificationShadow(
  deterministicBridge: Step3InterpretationBridge | undefined,
  organizationId: string,
  sourceDocumentId: string,
  persistence: Readonly<{
    register?: (task: () => Promise<void>) => void;
    persist?: (params: { input: ReasoningShadowPersistenceInput }) => Promise<ReasoningShadowPersistenceResult>;
  }> = {},
): Step3InterpretationBridge | undefined {
  if (!deterministicBridge) return undefined;
  return async (input) => {
    const deterministicPayload = await deterministicBridge(input);
    if (!isForgewingShadowEnabled()) return deterministicPayload;
    if (isForgewingTableContinuationEnabled()) {
      const task = async (): Promise<void> => {
        try {
          const result = await runForgewingTableContinuation(
            forgewingTableContinuationInput(input, organizationId, sourceDocumentId),
          );
          if (result.status === 'applied' || result.status === 'abstained') {
            const source = result.bundle.proposals[0] ?? result.bundle.abstentions[0];
            const persist = persistence.persist ?? persistReasoningShadowArtifact;
            const persisted = await persist({
              input: {
                organizationId,
                sourceDocumentId,
                sourceArtifactId: source.sourceArtifactId,
                resultStatus: result.status,
                run: result.bundle.run,
                schemaVersion: result.bundle.schemaVersion,
                runtime: {
                  model: result.metadata.model,
                  promptTemplateId: result.metadata.promptTemplateId,
                  promptTemplateVersion: result.metadata.promptTemplateVersion,
                  warningCodes: result.warnings,
                  calls: result.metadata.calls,
                  inputTruncated: result.metadata.inputTruncated,
                },
                validatedBundle: result.bundle,
              },
            });
            if (persisted.status !== 'persisted') {
              console.warn('[forgewingShadow] non-fatal table continuation persistence outcome', {
                mode: 'shadow',
                status: persisted.status,
                reason: persisted.reason,
                ...('warningCode' in persisted ? { warningCode: persisted.warningCode } : {}),
              });
            }
          }
          if (result.status !== 'skipped') {
            console.info('[forgewingShadow] table continuation completed', {
              mode: 'shadow',
              status: result.status,
              warnings: result.warnings,
              calls: result.metadata.calls,
              inputTruncated: result.metadata.inputTruncated,
            });
          }
        } catch (error) {
          console.error('[forgewingShadow] non-fatal table continuation failure', {
            mode: 'shadow',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      try {
        (persistence.register ?? ((backgroundTask) => after(backgroundTask)))(task);
      } catch (error) {
        console.error('[forgewingShadow] table continuation registration failed', {
          mode: 'shadow',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      const result = await runForgewingRegionClassification(
        forgewingInput(input, organizationId, sourceDocumentId),
      );
      if (result.status === 'applied' || result.status === 'abstained') {
        const source = result.bundle.proposals[0] ?? result.bundle.abstentions[0];
        const persistenceInput: ReasoningShadowPersistenceInput = {
          organizationId,
          sourceDocumentId,
          sourceArtifactId: source.sourceArtifactId,
          resultStatus: result.status,
          run: result.bundle.run,
          schemaVersion: result.bundle.schemaVersion,
          runtime: {
            model: result.metadata.model,
            promptTemplateId: result.metadata.promptTemplateId,
            promptTemplateVersion: result.metadata.promptTemplateVersion,
            warningCodes: result.warnings,
            calls: result.metadata.calls,
            inputTruncated: result.metadata.inputTruncated,
          },
          validatedBundle: result.bundle,
        };
        const persist = persistence.persist ?? persistReasoningShadowArtifact;
        const task = async (): Promise<void> => {
          try {
            const persisted = await persist({ input: persistenceInput });
            if (persisted.status === 'persisted') {
              console.info('[forgewingShadow] proposal bundle persisted', {
                mode: 'shadow',
                status: persisted.status,
                path: persisted.path,
                expiresAt: persisted.expiresAt,
                idempotent: persisted.idempotent,
              });
              return;
            }
            console.warn('[forgewingShadow] non-fatal proposal persistence outcome', {
              mode: 'shadow',
              status: persisted.status,
              reason: persisted.reason,
              ...('warningCode' in persisted ? { warningCode: persisted.warningCode } : {}),
            });
          } catch (error) {
            console.error('[forgewingShadow] non-fatal proposal persistence failure', {
              mode: 'shadow',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        };
        try {
          (persistence.register ?? ((backgroundTask) => after(backgroundTask)))(task);
        } catch (error) {
          console.error('[forgewingShadow] persistence registration failed', {
            mode: 'shadow',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (result.status !== 'skipped') {
        console.info('[forgewingShadow] region classification completed', {
          mode: 'shadow',
          status: result.status,
          warnings: result.warnings,
          calls: result.metadata.calls,
          inputTruncated: result.metadata.inputTruncated,
        });
      }
    } catch (error) {
      console.error('[forgewingShadow] non-fatal region classification failure', {
        mode: 'shadow',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return deterministicPayload;
  };
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          console.error('[extractionComplianceShadow] bounded shadow operation timed out', {
            mode: 'shadow',
            operation: label,
            timeoutMs,
          });
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface ShadowWriteResult {
  readonly sourceArtifactId: string;
  readonly extractionRunId: string;
  readonly extractionSnapshotId: string;
  readonly interpretationSnapshotId: string;
  readonly parserManifestHash: string;
  readonly status: 'partial';
}

function rpcResult(
  value: unknown,
  parserManifestHash: string,
): ShadowWriteResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('compliance shadow RPC returned no result');
  }
  const row = value as Record<string, unknown>;
  const required = [
    'source_artifact_id',
    'extraction_run_id',
    'extraction_snapshot_id',
    'interpretation_snapshot_id',
  ] as const;
  for (const key of required) {
    if (typeof row[key] !== 'string') {
      throw new Error(`compliance shadow RPC omitted ${key}`);
    }
  }
  return {
    sourceArtifactId: row.source_artifact_id as string,
    extractionRunId: row.extraction_run_id as string,
    extractionSnapshotId: row.extraction_snapshot_id as string,
    interpretationSnapshotId: row.interpretation_snapshot_id as string,
    parserManifestHash,
    status: 'partial',
  };
}

export async function persistExtractionComplianceShadow(
  input: ShadowWriteInput,
): Promise<ShadowWriteResult> {
  const storageObjectVersion = input.storageObjectVersion?.trim();
  if (!storageObjectVersion) {
    throw new Error('exact storage object version is required for compliance publication');
  }

  const sourceSha256 = sha256Hex(input.sourceBytes);
  const manifest = buildRuntimeShadowParserManifest(input.analysisMode);
  const parserManifestHash = hashParserManifest(manifest);
  const gap = {
    gap_key: GAP_KEY,
    page: null,
    stage: 'field_verification',
    reason: 'missing_geometry',
    retryable: false,
    attempts: 1,
    detail: GAP_DETAIL,
  };
  const gapDependencyHash = hashCanonical(gap);
  const members = [{ kind: 'gap', dependency_hash: gapDependencyHash }] as const;
  const artifactRootHash = hashCanonical({
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
    members,
  });
  const contentExtractionFingerprint = hashCanonical({
    source_sha256: sourceSha256,
    parser_manifest_hash: parserManifestHash,
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
    members,
  });
  const completedAt = input.observedAt ?? new Date().toISOString();

  const { data, error } = await input.admin.rpc('publish_extraction_compliance_shadow', {
    payload: {
      organization_id: input.organizationId,
      source_document_id: input.sourceDocumentId,
      source_sha256: sourceSha256,
      storage_object_version: storageObjectVersion,
      media_type_sniffed: sniffExtractionMediaType(input.sourceBytes, input.mediaType),
      byte_length: input.sourceBytes.byteLength,
      parser_manifest: manifest,
      parser_manifest_hash: parserManifestHash,
      artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
      idempotency_key: `analysis-job:${input.analysisJobId}`,
      started_at: completedAt,
      completed_at: completedAt,
      gap_key: GAP_KEY,
      gap_detail: GAP_DETAIL,
      gap_dependency_hash: gapDependencyHash,
      artifact_root_hash: artifactRootHash,
      content_extraction_fingerprint: contentExtractionFingerprint,
      interpreter_manifest_hash: STEP0_INTERPRETER_MANIFEST_HASH,
      entity_resolver_version: STEP0_ENTITY_RESOLVER_VERSION,
      effective_truth_set_hash: hashCanonical([]),
      interpretation_output_root_hash: hashCanonical({
        extraction_artifact_root_hash: artifactRootHash,
        status: 'blocked',
        gap_dependency_hash: gapDependencyHash,
      }),
      projection_schema_version: PROJECTION_SCHEMA_VERSION,
    },
  });
  if (error) {
    throw new Error(`publish extraction compliance shadow: ${error.message}`);
  }
  return rpcResult(data, parserManifestHash);
}

export async function publishExtractionComplianceShadowNonBlocking(
  input: ShadowWriteInput,
): Promise<ShadowWriteResult | null> {
  try {
    const result = await persistExtractionComplianceShadow(input);
    console.info('[extractionComplianceShadow] published', {
      mode: 'shadow',
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      analysisJobId: input.analysisJobId,
      sourceArtifactId: result.sourceArtifactId,
      extractionSnapshotId: result.extractionSnapshotId,
      status: result.status,
    });
    return result;
  } catch (error) {
    console.error('[extractionComplianceShadow] non-fatal publish failure', {
      mode: 'shadow',
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      analysisJobId: input.analysisJobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Starts the Step 0 dual-write without putting storage metadata or the new
 * compliance ledger on the legacy processing critical path.
 */
export function scheduleExtractionComplianceShadow(
  input: ScheduledShadowWriteInput,
): Promise<void> {
  return (async () => {
    if (!input.storageVersionBeforeDownload) {
      console.info('[extractionComplianceShadow] skipped without pre-download identity', {
        mode: 'shadow',
        organizationId: input.organizationId,
        sourceDocumentId: input.sourceDocumentId,
        analysisJobId: input.analysisJobId,
      });
      return;
    }
    const storageVersionAfterDownload = await captureStorageObjectVersion(
      input.admin,
      input.storageBucket,
      input.storagePath,
    );
    const storageObjectVersion =
      input.storageVersionBeforeDownload === storageVersionAfterDownload
        ? input.storageVersionBeforeDownload
        : null;

    const commonInput = {
      admin: input.admin,
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      sourceBytes: input.sourceBytes,
      storageObjectVersion,
      mediaType: input.mediaType,
      legacyExtractionPayload: input.legacyExtractionPayload,
      analysisJobId: input.analysisJobId,
      analysisMode: input.analysisMode,
      observedAt: input.observedAt,
    };
    const mediaTypeSniffed = sniffExtractionMediaType(input.sourceBytes, input.mediaType);
    const scheduledGenericContentSidecar = await settleWithin(
      buildGenericPdfShadowSidecar(input.sourceBytes, mediaTypeSniffed),
      SHADOW_PUBLICATION_TIMEOUT_MS,
      'generic_content_scheduling',
    );
    const genericContentSidecar = scheduledGenericContentSidecar
      ?? (mediaTypeSniffed === 'application/pdf'
        ? {
            pages: [],
            content_gaps: [{
              gap_key: `step3:timeout:${sha256Hex(input.sourceBytes)}`,
              stage: 'table_reconstruction' as const,
              reason: 'timeout' as const,
              retryable: true,
              attempts: 1,
              error_category: 'generic_content_scheduling_timeout',
            }],
          }
        : null);
    const locatedObservations = mergeLocatedSidecars(
      genericContentSidecar,
      input.locatedObservations ?? { pages: [] },
    );
    if (genericContentSidecar || input.locatedObservations) {
      await settleWithin(publishExtractionStep1ShadowNonBlocking({
          ...commonInput,
          locatedObservations,
          step3InterpretationBridge: withForgewingRegionClassificationShadow(
            input.step3InterpretationBridge,
            input.organizationId,
            input.sourceDocumentId,
          ),
          observedAt: input.observedAt ?? new Date().toISOString(),
        }), SHADOW_PUBLICATION_TIMEOUT_MS, 'publication');
    } else {
      await settleWithin(
        publishExtractionComplianceShadowNonBlocking(commonInput),
        SHADOW_PUBLICATION_TIMEOUT_MS,
        'publication',
      );
    }
  })().catch((error) => {
    console.error('[extractionComplianceShadow] detached shadow task failed', {
      mode: 'shadow',
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      analysisJobId: input.analysisJobId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function captureStorageObjectVersion(
  admin: SupabaseClient,
  storageBucket: string,
  storagePath: string,
  timeoutMs = STORAGE_IDENTITY_TIMEOUT_MS,
): Promise<string | null> {
  return settleWithin(
    readStorageObjectVersion(admin, storageBucket, storagePath),
    timeoutMs,
    'storage_identity',
  );
}

export async function readStorageObjectVersion(
  admin: SupabaseClient,
  storageBucket: string,
  storagePath: string,
): Promise<string | null> {
  try {
    const bucket = admin.storage.from(storageBucket) as unknown as {
      info: (path: string) => Promise<{
        data: {
          id?: string;
          version?: string;
          updated_at?: string;
          metadata?: { eTag?: string; etag?: string };
        } | null;
        error: { message?: string } | null;
      }>;
    };
    const { data, error } = await bucket.info(storagePath);
    if (error || !data) {
      throw new Error(`load storage object version: ${error?.message ?? 'no object metadata'}`);
    }
    const storageObjectVersion = [
      data.version,
      data.id,
      data.updated_at,
      data.metadata?.eTag ?? data.metadata?.etag,
    ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(':');
    if (!storageObjectVersion) {
      throw new Error('storage object metadata did not contain a version identity');
    }
    return storageObjectVersion;
  } catch (error) {
    console.error('[extractionComplianceShadow] storage identity unavailable', {
      storageBucket,
      storagePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
