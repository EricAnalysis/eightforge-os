import type { SupabaseClient } from '@supabase/supabase-js';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  adaptLegacyExtractionToStep1Shadow,
  type LegacyLocatedObservation,
  type LegacyLocatedPageObservation,
} from '@/lib/extraction/domain/legacyLocatedObservationAdapter';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import { hashParserManifest } from '@/lib/extraction/domain/parserManifest';
import type { ParserIdentity, SourceArtifact } from '@/lib/extraction/domain/types';
import type { Step3InterpretationBridge } from '@/lib/extraction/domain/step3InterpretationBridge';
import type { LocatedOcrObservationSidecar } from '@/lib/extraction/ocrObservationSidecar';
import { buildRuntimeShadowParserManifest } from '@/lib/extraction/persistence/shadowRuntimeManifest';
import { sniffExtractionMediaType } from '@/lib/extraction/persistence/shadowSourceIdentity';

const ARTIFACT_SCHEMA_VERSION = 'extraction-artifact-v1';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Step1ShadowWriteInput {
  readonly admin: SupabaseClient;
  readonly organizationId: string;
  readonly sourceDocumentId: string;
  readonly sourceBytes: ArrayBuffer;
  readonly storageObjectVersion: string | null;
  readonly mediaType: string | null;
  readonly legacyExtractionPayload: Record<string, unknown>;
  readonly locatedObservations: LocatedOcrObservationSidecar;
  readonly analysisJobId: string;
  readonly analysisMode: string;
  readonly observedAt: string;
  readonly step3InterpretationBridge?: Step3InterpretationBridge;
}

export interface Step1ShadowWriteResult {
  readonly sourceArtifactId: string;
  readonly extractionRunId: string;
  readonly extractionSnapshotId: string;
  readonly parserManifestHash: string;
  readonly candidateCount: number;
  readonly verifiedFieldCount: number;
  readonly gapCount: number;
  readonly skippedRecordCount: number;
  readonly reused: boolean;
  readonly assignmentUpdated: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasNonEmptyObject(value: unknown): boolean {
  const record = object(value);
  return record != null && Object.keys(record).length > 0;
}

function unlocatedLegacyCategories(
  payload: Record<string, unknown>,
  locatedPageCount: number,
): Array<{ category: string; page: null }> {
  const fields = object(payload.fields);
  const extraction = object(payload.extraction);
  const content = object(extraction?.content_layers_v1);
  const pdfContent = object(content?.pdf);
  const spreadsheetContent = object(content?.spreadsheet);
  const categories = [
    hasNonEmptyObject(fields?.typed_fields) ? 'typed_fields_without_source_span' : null,
    hasNonEmptyObject(extraction?.evidence_v1) ? 'evidence_v1_without_complete_geometry' : null,
    hasNonEmptyObject(pdfContent?.text) ? 'pdf_text_without_complete_geometry' : null,
    hasNonEmptyObject(pdfContent?.tables) ? 'pdf_tables_without_complete_geometry' : null,
    hasNonEmptyObject(pdfContent?.forms) ? 'pdf_forms_without_complete_geometry' : null,
    hasNonEmptyObject(spreadsheetContent)
      ? 'spreadsheet_content_without_page_geometry'
      : null,
    hasNonEmptyObject(extraction?.parsed_elements_v1)
      ? 'partition_elements_without_render_binding'
      : null,
    hasNonEmptyObject(extraction?.ai_assist_v1) ? 'ai_output_without_source_span' : null,
  ].filter((value): value is string => value != null);
  if (categories.length === 0 && locatedPageCount === 0) {
    categories.push('legacy_output_without_located_observations');
  }
  return categories.map((category) => ({ category, page: null }));
}

function flattenLocatedObservations(
  sidecar: LocatedOcrObservationSidecar,
  parser: ParserIdentity,
): LegacyLocatedObservation[] {
  const pages = sidecar.engine_pages && sidecar.engine_pages.length > 0
    ? sidecar.engine_pages
    : sidecar.pages;
  return pages.flatMap((page) =>
    page.words.map((word) => ({
      page: page.page_number,
      page_width: page.width,
      page_height: page.height,
      rotation_degrees: 0 as const,
      render_sha256: page.render_sha256,
      parser: (page as { readonly parser?: ParserIdentity }).parser ?? parser,
      text: word.text,
      confidence: word.confidence,
      bbox: word.bbox,
    })),
  );
}

function locatedPages(
  sidecar: LocatedOcrObservationSidecar,
  parser: ParserIdentity,
): LegacyLocatedPageObservation[] {
  return sidecar.pages.map((page) => ({
    page: page.page_number,
    page_width: page.width,
    page_height: page.height,
    rotation_degrees: 0,
    render_sha256: page.render_sha256,
    parser,
    text_detected: page.text_detected,
  }));
}

function resolvedSourceArtifact(
  value: unknown,
  input: Step1ShadowWriteInput,
  sourceSha256: string,
  mediaTypeSniffed: string,
): SourceArtifact {
  const row = object(value);
  const id = row?.source_artifact_id;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new Error('Step 1 source resolver returned an invalid source_artifact_id');
  }
  if (row?.source_document_id !== input.sourceDocumentId
      || row?.source_sha256 !== sourceSha256
      || row?.storage_object_version !== input.storageObjectVersion) {
    throw new Error('Step 1 source resolver returned divergent provenance');
  }
  return {
    id: opaqueIds.existingSourceArtifact(id),
    organization_id: input.organizationId,
    source_document_id: input.sourceDocumentId,
    source_sha256: sourceSha256,
    storage_object_version: input.storageObjectVersion as string,
    media_type_sniffed: mediaTypeSniffed,
    byte_length: input.sourceBytes.byteLength,
    created_at: new Date().toISOString(),
  };
}

function publicationResult(
  value: unknown,
  graph: Awaited<ReturnType<typeof adaptLegacyExtractionToStep1Shadow>>,
  parserManifestHash: string,
): Step1ShadowWriteResult {
  const row = object(value);
  for (const key of [
    'source_artifact_id',
    'extraction_run_id',
    'extraction_snapshot_id',
  ] as const) {
    if (typeof row?.[key] !== 'string') {
      throw new Error(`Step 1 publication RPC omitted ${key}`);
    }
  }
  return {
    sourceArtifactId: row?.source_artifact_id as string,
    extractionRunId: row?.extraction_run_id as string,
    extractionSnapshotId: row?.extraction_snapshot_id as string,
    parserManifestHash,
    candidateCount: graph.candidates.length,
    verifiedFieldCount: graph.verifiedFields.length,
    gapCount: graph.gaps.length,
    skippedRecordCount: graph.skippedRecordCount,
    reused: row?.reused === true,
    assignmentUpdated: row?.assignment_updated === true,
  };
}

export async function persistExtractionStep1Shadow(
  input: Step1ShadowWriteInput,
): Promise<Step1ShadowWriteResult> {
  const storageObjectVersion = input.storageObjectVersion?.trim();
  if (!storageObjectVersion) {
    throw new Error('exact storage object version is required for Step 1 publication');
  }
  const sourceSha256 = sha256Hex(input.sourceBytes);
  const mediaTypeSniffed = sniffExtractionMediaType(input.sourceBytes, input.mediaType);
  const manifest = buildRuntimeShadowParserManifest(
    input.analysisMode,
    'step1_span_verified',
  );
  const parserManifestHash = hashParserManifest(manifest);
  const { data: sourceData, error: sourceError } = await input.admin.rpc(
    'resolve_extraction_step1_source',
    {
      payload: {
        organization_id: input.organizationId,
        source_document_id: input.sourceDocumentId,
        source_sha256: sourceSha256,
        storage_object_version: storageObjectVersion,
        media_type_sniffed: mediaTypeSniffed,
        byte_length: input.sourceBytes.byteLength,
      },
    },
  );
  if (sourceError) {
    throw new Error(`resolve Step 1 source artifact: ${sourceError.message}`);
  }
  const sourceArtifact = resolvedSourceArtifact(
    sourceData,
    input,
    sourceSha256,
    mediaTypeSniffed,
  );
  const ocrParser: ParserIdentity = {
    stage: 'ocr',
    name: manifest.ocr.name,
    version: manifest.ocr.version,
    configuration_hash: manifest.ocr.configuration_hash,
  };
  const rendererParser: ParserIdentity = {
    stage: 'page_render',
    name: manifest.renderer.name,
    version: manifest.renderer.version,
    configuration_hash: manifest.renderer.configuration_hash,
  };
  const semanticPublicationKey = hashCanonical({
    source_artifact_id: sourceArtifact.id,
    parser_manifest_hash: parserManifestHash,
    artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
  });
  const graph = await adaptLegacyExtractionToStep1Shadow({
    sourceArtifact,
    parserManifest: manifest,
    parserManifestHash,
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    idempotencyKey: `step1-shadow:${semanticPublicationKey}`,
    completedAt: input.observedAt,
    locatedPages: locatedPages(input.locatedObservations, rendererParser),
    locatedObservations: flattenLocatedObservations(input.locatedObservations, ocrParser),
    unlocatedOutputs: unlocatedLegacyCategories(
      input.legacyExtractionPayload,
      input.locatedObservations.pages.length,
    ),
    genericContentAnalysis: input.locatedObservations.content_analysis,
    genericContentGaps: input.locatedObservations.content_gaps,
  });
  const interpretation = input.step3InterpretationBridge
    ? await input.step3InterpretationBridge({
        extraction_snapshot_id: graph.snapshot.id,
        chains: graph.tableChains,
        segments: graph.tableSegments,
        verified_field_handles: graph.verifiedFieldHandles,
        published_at: graph.run.completed_at,
      })
    : {
        interpretation_snapshot: null,
        semantic_column_mappings: [],
        interpretation_records: [],
      };
  const completedAt = graph.run.completed_at;
  const { data, error } = await input.admin.rpc('publish_extraction_step1_shadow', {
    payload: {
      organization_id: input.organizationId,
      source_document_id: input.sourceDocumentId,
      source_artifact_id: sourceArtifact.id,
      source_sha256: sourceSha256,
      parser_manifest: manifest,
      parser_manifest_hash: parserManifestHash,
      artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
      run_id: graph.run.id,
      snapshot_id: graph.snapshot.id,
      idempotency_key: graph.run.idempotency_key,
      run_status: graph.run.status,
      run_state_reason: graph.gaps.length > 0 ? 'step1_shadow_has_explicit_gaps' : null,
      started_at: graph.run.started_at,
      completed_at: completedAt,
      snapshot_status: graph.snapshot.status,
      content_extraction_fingerprint: graph.snapshot.content_extraction_fingerprint,
      artifact_root_hash: graph.snapshot.artifact_root_hash,
      pages: graph.pages,
      fragments: graph.fragments,
      candidates: graph.candidates,
      verified_fields: graph.verifiedFields,
      gaps: graph.gaps,
      snapshot_members: graph.members,
      fragment_dependencies: graph.fragmentDependencies,
      continuation_links: graph.continuationLinks,
      table_chains: graph.tableChains,
      table_sections: graph.tableSections,
      arbitration_decisions: graph.arbitrationDecisions,
      ...interpretation,
    },
  });
  if (error) {
    throw new Error(`publish Step 1 extraction shadow: ${error.message}`);
  }
  return publicationResult(data, graph, parserManifestHash);
}

export async function publishExtractionStep1ShadowNonBlocking(
  input: Step1ShadowWriteInput,
): Promise<Step1ShadowWriteResult | null> {
  try {
    const result = await persistExtractionStep1Shadow(input);
    console.info('[extractionStep1Shadow] published', {
      mode: 'shadow',
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      analysisJobId: input.analysisJobId,
      extractionRunId: result.extractionRunId,
      parserManifestHash: result.parserManifestHash,
      sourceArtifactId: result.sourceArtifactId,
      candidateCount: result.candidateCount,
      verifiedFieldCount: result.verifiedFieldCount,
      gapCount: result.gapCount,
      skippedRecordCount: result.skippedRecordCount,
      extractionSnapshotId: result.extractionSnapshotId,
      publicationOutcome: result.reused ? 'reused' : 'created',
      assignmentOutcome: result.assignmentUpdated ? 'updated' : 'unchanged',
    });
    return result;
  } catch (error) {
    console.error('[extractionStep1Shadow] non-fatal publish failure', {
      mode: 'shadow',
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      analysisJobId: input.analysisJobId,
      publicationOutcome: 'failed',
      errorCategory: error instanceof Error ? error.name : 'unknown',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
