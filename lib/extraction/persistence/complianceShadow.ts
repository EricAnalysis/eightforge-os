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
import { runForgewingColumnMapping } from '@/lib/forgewing/tasks/columnMapping';
import {
  runForgewingObservationArbitration,
  type ForgewingObservationArbitrationInput,
} from '@/lib/forgewing/tasks/observationArbitration';
import {
  runForgewingPricingInterpretation,
  type ForgewingPricingInterpretationInput,
} from '@/lib/forgewing/tasks/pricingInterpretation';
import {
  isForgewingColumnMappingEnabled,
  isForgewingObservationArbitrationEnabled,
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

function forgewingColumnMappingInput(
  input: Step3InterpretationBridgeInput,
  deterministicPayload: Awaited<ReturnType<Step3InterpretationBridge>>,
  organizationId: string,
  sourceDocumentId: string,
): unknown | null {
  const snapshot = deterministicPayload.interpretation_snapshot;
  if (snapshot && snapshot.status === 'blocked') return null;
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
  const asRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`invalid deterministic column mapping ${label}`);
    }
    return value as Record<string, unknown>;
  };
  const mappingSignals = deterministicPayload.semantic_column_mappings.flatMap((raw) => {
    const mapping = asRecord(raw, 'record');
    if (mapping.status === 'resolved') return [];
    if (mapping.status !== 'ambiguous'
      || typeof mapping.id !== 'string'
      || typeof mapping.table_segment_id !== 'string'
      || !Number.isSafeInteger(mapping.column_index)) {
      throw new Error('invalid deterministic ambiguous column mapping identity');
    }
    const assessment = asRecord(mapping.assessment, 'assessment');
    const decision = asRecord(assessment.decision_evidence, 'decision evidence');
    const policy = asRecord(assessment.resolution_policy, 'resolution policy');
    const reason = decision.ambiguity_reason;
    if (!['conflicting_cell_values', 'multiple_exact_header_roles', 'no_candidate',
      'below_minimum_score', 'below_minimum_margin'].includes(String(reason))) {
      throw new Error('invalid deterministic column ambiguity reason');
    }
    if (!Array.isArray(assessment.candidate_roles)) {
      throw new Error('invalid deterministic column candidate roles');
    }
    const candidateRoles = assessment.candidate_roles.map((rawCandidate) => {
      const candidate = asRecord(rawCandidate, 'candidate role');
      if (typeof candidate.role !== 'string' || typeof candidate.score !== 'number') {
        throw new Error('invalid deterministic column candidate role');
      }
      return { role: candidate.role, score: candidate.score };
    });
    for (const field of ['observed_top_score', 'observed_margin', 'minimum_score', 'minimum_margin'] as const) {
      if (typeof policy[field] !== 'number') {
        throw new Error(`invalid deterministic column mapping ${field}`);
      }
    }
    return [{
      mappingId: mapping.id,
      tableSegmentId: mapping.table_segment_id,
      columnIndex: mapping.column_index,
      status: 'ambiguous',
      ambiguityReason: reason,
      candidateRoles,
      observedTopScore: policy.observed_top_score,
      observedMargin: policy.observed_margin,
      minimumScore: policy.minimum_score,
      minimumMargin: policy.minimum_margin,
    }];
  });
  return {
    organizationId,
    sourceDocumentId,
    extractionSnapshotId: input.extraction_snapshot_id,
    tables: input.segments.map((segment) => ({
      observationId: segment.id,
      kind: 'table',
      organizationId: segment.organization_id,
      sourceDocumentId: segment.source_document_id,
      sourceArtifactId: segment.source_artifact_id,
      extractionSnapshotId: input.extraction_snapshot_id,
      pageArtifactId: segment.page_artifact_id,
      page: segment.page,
      boundingBox: mapBox(segment.bounding_box),
      readingOrder: segment.reading_order,
      ...(mapPhysical(segment.physical_page_coordinate)
        ? { physicalCoordinate: mapPhysical(segment.physical_page_coordinate) }
        : {}),
      chainCompleteness: chainCompleteness.get(segment.id) ?? 'unchained',
      detectionKinds: segment.detection_evidence.map((evidence) => evidence.kind),
      columns: segment.column_hypotheses.map((column) => ({
        index: column.index,
        x0: column.x0,
        x1: column.x1,
        observedHeader: column.header.observed_text,
        normalizedHeader: column.header.normalized_label,
        valueKinds: column.value_kind_hypotheses.map((hypothesis) => hypothesis.kind),
      })),
    })),
    cells: input.cells.map((cell) => ({
      observationId: cell.id,
      kind: 'cell',
      organizationId: cell.organization_id,
      sourceDocumentId: cell.source_document_id,
      sourceArtifactId: cell.source_artifact_id,
      extractionSnapshotId: input.extraction_snapshot_id,
      pageArtifactId: cell.page_artifact_id,
      boundingBox: mapBox(cell.bounding_box),
      readingOrder: cell.reading_order,
      ...(mapPhysical(cell.physical_page_coordinate)
        ? { physicalCoordinate: mapPhysical(cell.physical_page_coordinate) }
        : {}),
      tableSegmentId: cell.table_segment_id,
      text: cell.raw_text,
      rowStart: cell.row_start,
      rowSpan: cell.row_span,
      columnStart: cell.column_start,
      columnSpan: cell.column_span,
      structure: cell.structure,
    })),
    mappingSignals,
  };
}

function forgewingObservationArbitrationInput(
  input: Step3InterpretationBridgeInput,
  organizationId: string,
  sourceDocumentId: string,
): ForgewingObservationArbitrationInput {
  const mapBox = (box: (typeof input.region_candidates)[number]['bounding_box']) => ({
    coordinateSpace: box.coordinate_space,
    origin: box.origin,
    x0: box.x0,
    y0: box.y0,
    x1: box.x1,
    y1: box.y1,
    rotation: box.rotation,
  });
  const mapCoordinate = (
    coordinate: (typeof input.region_candidates)[number]['physical_page_coordinate'],
  ) => coordinate.mappingState === 'resolved_physical_page'
    ? {
        mappingState: coordinate.mappingState,
        sourceDocumentId: coordinate.sourceDocumentId,
        sourceArtifactId: coordinate.sourceArtifactId,
        physicalPageNumber: coordinate.physicalPageNumber,
        artifactLocalIndex: coordinate.artifactLocalIndex,
        sourceLayer: coordinate.sourceLayer,
      }
    : {
        mappingState: coordinate.mappingState,
        sourceDocumentId: coordinate.sourceDocumentId,
        sourceArtifactId: coordinate.sourceArtifactId,
        physicalPageNumber: null,
        artifactLocalIndex: coordinate.artifactLocalIndex,
        sourceLayer: coordinate.sourceLayer,
      };
  const mapSignal = (signal: (typeof input.region_candidates)[number]['quality_signals']['glyph_validity']) => ({
    value: signal.value,
    basisArtifactIds: [...signal.basis_artifact_ids],
  });
  return {
    organizationId,
    sourceDocumentId,
    extractionSnapshotId: input.extraction_snapshot_id,
    regionCandidates: input.region_candidates.map((candidate) => ({
      candidateId: candidate.id,
      organizationId: candidate.organization_id,
      sourceDocumentId: candidate.source_document_id,
      sourceArtifactId: candidate.source_artifact_id,
      extractionSnapshotId: input.extraction_snapshot_id,
      pageArtifactId: candidate.page_artifact_id,
      page: candidate.page,
      boundingBox: mapBox(candidate.bounding_box),
      rawText: candidate.raw_text,
      parser: {
        stage: candidate.parser.stage,
        name: candidate.parser.name,
        version: candidate.parser.version,
        configurationHash: candidate.parser.configuration_hash,
      },
      recognitionConfidence: candidate.recognition_confidence,
      readingOrder: candidate.reading_order,
      regionRole: candidate.region_role,
      orderedTokenIds: [...candidate.ordered_token_ids],
      engineReportedConfidence: candidate.engine_reported_confidence,
      qualitySignals: {
        glyphValidity: mapSignal(candidate.quality_signals.glyph_validity),
        geometryCoverage: mapSignal(candidate.quality_signals.geometry_coverage),
        readingOrderConsistency: mapSignal(candidate.quality_signals.reading_order_consistency),
        imageTextCoverage: candidate.quality_signals.image_text_coverage == null
          ? null
          : mapSignal(candidate.quality_signals.image_text_coverage),
      },
      physicalCoordinate: mapCoordinate(candidate.physical_page_coordinate),
    })),
    arbitrationDecisions: input.arbitration_decisions.map((decision) => ({
      targetId: decision.id,
      organizationId: decision.organization_id,
      sourceDocumentId: decision.source_document_id,
      sourceArtifactId: decision.source_artifact_id,
      extractionSnapshotId: input.extraction_snapshot_id,
      pageArtifactId: decision.page_artifact_id,
      candidateIds: [...decision.candidate_ids],
      deterministicState: decision.decision,
      agreement: decision.agreement?.value ?? null,
      diagnostics: [...decision.diagnostics],
    })),
  };
}

type NeutralPricingScopeDiagnostics = Readonly<{
  sourceDocumentId: string;
  sourceArtifactId: string | null;
  pageScopeApplicable: boolean;
  scope: Readonly<{ kind: string; authoritativePages: readonly number[] }>;
  observations: readonly Readonly<{
    observationId: string;
    sourceDocumentId: string;
    sourceArtifactId: string | null;
    physicalPageNumber: number | null;
    eligibility: string;
    reason: string;
  }>[];
}>;

export type ForgewingPricingInterpretationShadowInput = Readonly<{
  organizationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  extractionSnapshotId: string;
  /** Source-derived pricing rows enriched at the post-scope boundary. */
  pricingRows: readonly unknown[];
  /** Actual pipeline evidence objects; assembled row text is never used as a cited span. */
  sourceObservations: readonly unknown[];
  /** Structural copy of PricingSourceEligibilityDiagnostics; no authority import. */
  pricingSourceEligibility: unknown;
  env?: Readonly<Record<string, string | undefined>>;
}>;

type PricingShadowDependencies = Readonly<{
  register?: (task: () => Promise<void>) => void;
  run?: typeof runForgewingPricingInterpretation;
  persist?: (params: { input: ReasoningShadowPersistenceInput }) => Promise<ReasoningShadowPersistenceResult>;
}>;

function pricingRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pricingString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function pricingIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && value.trim() === value
    ? value
    : null;
}

const MAX_PRICING_SHADOW_SOURCE_TEXT_CHARS = 1_000_000;
const MAX_PRICING_SHADOW_CELLS = 10_000;

function pricingInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function neutralPricingDiagnostics(value: unknown): NeutralPricingScopeDiagnostics | null {
  const record = pricingRecord(value);
  const scope = pricingRecord(record?.scope);
  if (!record || !scope || !Array.isArray(record.observations)) return null;
  const sourceDocumentId = pricingIdentifier(record.sourceDocumentId);
  const sourceArtifactId = pricingIdentifier(record.sourceArtifactId);
  const scopeKind = pricingString(scope.kind);
  if (!sourceDocumentId || !sourceArtifactId || !scopeKind
    || !Array.isArray(scope.authoritativePages)) return null;
  const parsedPages = scope.authoritativePages.map(pricingInteger);
  if (parsedPages.some((page) => page == null || page < 1)) return null;
  const authoritativePages = parsedPages as number[];
  if (new Set(authoritativePages).size !== authoritativePages.length) return null;
  authoritativePages.sort((left, right) => left - right);
  const observations: Array<NeutralPricingScopeDiagnostics['observations'][number]> = [];
  for (const raw of record.observations) {
    const observation = pricingRecord(raw);
    const observationId = pricingIdentifier(observation?.observationId);
    const observationDocumentId = pricingIdentifier(observation?.sourceDocumentId);
    const observationArtifactId = pricingIdentifier(observation?.sourceArtifactId);
    const physicalPageNumber = pricingInteger(observation?.physicalPageNumber);
    const eligibility = pricingString(observation?.eligibility);
    const reason = pricingString(observation?.reason);
    if (!observationId || !observationDocumentId || !observationArtifactId
      || physicalPageNumber == null || physicalPageNumber < 1 || !eligibility || !reason) return null;
    observations.push({
      observationId,
      sourceDocumentId: observationDocumentId,
      sourceArtifactId: observationArtifactId,
      physicalPageNumber,
      eligibility,
      reason,
    });
  }
  if (new Set(observations.map((observation) => observation.observationId)).size
    !== observations.length) return null;
  return {
    sourceDocumentId,
    sourceArtifactId,
    pageScopeApplicable: record.pageScopeApplicable === true,
    scope: { kind: scopeKind, authoritativePages },
    observations,
  };
}

function pricingEvidenceText(value: Record<string, unknown>): string | null {
  const location = pricingRecord(value.location);
  const authoredSpans = [
    value.text,
    typeof value.value === 'string' ? value.value : null,
    location?.nearby_text,
  ];
  const span = authoredSpans.find((part): part is string =>
    typeof part === 'string' && part.trim().length > 0);
  return span ?? null;
}

function neutralPricingSourceObservation(
  raw: unknown,
  input: ForgewingPricingInterpretationShadowInput,
  admitted: NeutralPricingScopeDiagnostics['observations'][number],
) {
  const evidence = pricingRecord(raw);
  const location = pricingRecord(evidence?.location);
  const coordinate = pricingRecord(evidence?.physical_page_coordinate);
  const metadata = pricingRecord(evidence?.metadata);
  const observationId = pricingIdentifier(evidence?.id);
  const sourceDocumentId = pricingIdentifier(evidence?.source_document_id);
  const physicalPageNumber = pricingInteger(location?.page);
  const rawText = evidence ? pricingEvidenceText(evidence) : null;
  if (!evidence || !observationId || !sourceDocumentId || !rawText
    || rawText.length > MAX_PRICING_SHADOW_SOURCE_TEXT_CHARS
    || physicalPageNumber == null
    || observationId !== admitted.observationId
    || sourceDocumentId !== input.sourceDocumentId
    || physicalPageNumber !== admitted.physicalPageNumber) return null;

  const coordinateResolved = coordinate?.mappingState === 'resolved_physical_page'
    && pricingIdentifier(coordinate.sourceDocumentId) === input.sourceDocumentId
    && pricingIdentifier(coordinate.sourceArtifactId) === input.sourceArtifactId
    && pricingInteger(coordinate.physicalPageNumber) === physicalPageNumber;
  const sourceLayer = coordinateResolved ? pricingSourceLayer(coordinate.sourceLayer) : null;
  const artifactLocalIndex = coordinateResolved
    ? pricingInteger(coordinate.artifactLocalIndex)
    : null;
  const rawPageArtifactId = metadata?.pageArtifactId ?? metadata?.page_artifact_id;
  const pageArtifactId = rawPageArtifactId == null ? null : pricingIdentifier(rawPageArtifactId);
  const boundingBox = pricingBoundingBox(metadata?.boundingBox ?? metadata?.bounding_box);
  if (!coordinateResolved || !sourceLayer || (rawPageArtifactId != null && !pageArtifactId)) return null;
  return {
    observationId,
    rawText,
    columnIndex: pricingInteger(location?.column_index) ?? 0,
    readingOrder: 0,
    sourceDocumentId: input.sourceDocumentId,
    sourceArtifactId: input.sourceArtifactId,
    physicalPageNumber,
    sourceLayer,
    ...(coordinateResolved && artifactLocalIndex != null ? { artifactLocalIndex } : {}),
    ...(pageArtifactId ? { pageArtifactId } : {}),
    ...(boundingBox ? { boundingBox } : {}),
  };
}

function pricingBoundingBox(value: unknown) {
  const box = pricingRecord(value);
  if (!box || box.coordinateSpace !== 'page_normalized' || box.origin !== 'top_left') return null;
  const values = ['x0', 'y0', 'x1', 'y1', 'rotation'] as const;
  if (values.some((key) => typeof box[key] !== 'number' || !Number.isFinite(box[key]))) return null;
  const x0 = box.x0 as number;
  const y0 = box.y0 as number;
  const x1 = box.x1 as number;
  const y1 = box.y1 as number;
  const rotation = box.rotation;
  if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1 || x0 >= x1 || y0 >= y1
    || ![0, 90, 180, 270].includes(rotation as number)) return null;
  return {
    coordinateSpace: 'page_normalized' as const,
    origin: 'top_left' as const,
    x0,
    y0,
    x1,
    y1,
    rotation: rotation as 0 | 90 | 180 | 270,
  };
}

function pricingDeterministicState(row: Record<string, unknown>) {
  const explicit = pricingString(row.deterministicState)?.toLowerCase();
  const categoryState = pricingString(row.category_resolution_status)?.toLowerCase();
  const signal = explicit ?? categoryState;
  if (signal?.includes('conflict')) return 'conflict' as const;
  if (signal?.includes('ambigu')) return 'ambiguous' as const;
  if (signal?.includes('unresolved') || signal === 'requires_review') return 'unresolved' as const;
  if (row.category_requires_review === true || row.confidence === 'needs_review') return 'unresolved' as const;
  return null;
}

function pricingSourceLayer(value: unknown) {
  return ['pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact'].includes(String(value))
    ? value as 'pdf_page_render' | 'pdf_native_text' | 'ocr' | 'table_artifact'
    : null;
}

type NeutralPricingSemanticHint =
  | 'category_like_text' | 'description_like_text' | 'unit_like_text'
  | 'rate_like_amount' | 'quantity_like_amount' | 'item_number_like_text'
  | 'extended_amount_like_text' | 'unknown';

function isNeutralPricingSemanticHint(value: unknown): value is NeutralPricingSemanticHint {
  return [
    'category_like_text', 'description_like_text', 'unit_like_text',
    'rate_like_amount', 'quantity_like_amount', 'item_number_like_text',
    'extended_amount_like_text', 'unknown',
  ].includes(String(value));
}

function freezePricingInterpretationInput(
  input: ForgewingPricingInterpretationInput,
): ForgewingPricingInterpretationInput {
  for (const cell of input.rowObservation.cells) {
    if (cell.semanticHints) Object.freeze(cell.semanticHints);
    if (cell.boundingBox) Object.freeze(cell.boundingBox);
    Object.freeze(cell);
  }
  Object.freeze(input.rowObservation.cells);
  for (const group of input.rowObservation.sourceCellGroups ?? []) {
    Object.freeze(group.sourceObservationIds);
    Object.freeze(group);
  }
  if (input.rowObservation.sourceCellGroups) Object.freeze(input.rowObservation.sourceCellGroups);
  if (input.rowObservation.boundingBox) Object.freeze(input.rowObservation.boundingBox);
  Object.freeze(input.rowObservation);
  Object.freeze(input.pricingScope);
  return Object.freeze(input);
}

/**
 * Pure post-scope adapter shared by production shadow scheduling and offline
 * evaluation. It exposes only fully admitted task inputs, never a scope
 * resolver or a canonical pricing object.
 */
export function buildEligiblePricingReasoningShadowCandidates(
  input: ForgewingPricingInterpretationShadowInput,
): readonly ForgewingPricingInterpretationInput[] {
  if (!pricingIdentifier(input.organizationId)
    || !pricingIdentifier(input.sourceDocumentId)
    || !pricingIdentifier(input.sourceArtifactId)
    || !pricingIdentifier(input.extractionSnapshotId)) return [];
  const diagnostics = neutralPricingDiagnostics(input.pricingSourceEligibility);
  if (!diagnostics) return [];
  if (!diagnostics.pageScopeApplicable
    || diagnostics.scope.kind !== 'authoritative'
    || diagnostics.sourceDocumentId !== input.sourceDocumentId
    || diagnostics.sourceArtifactId !== input.sourceArtifactId) return [];

  let duplicateIdentity = false;
  const candidates: Array<Readonly<{
    stableKey: string;
    input: ForgewingPricingInterpretationInput;
  }>> = input.pricingRows.flatMap((raw) => {
    const row = pricingRecord(raw);
    if (!row) return [];
    const deterministicState = pricingDeterministicState(row);
    if (!deterministicState) return [];
    const rawRowId = row.observationId ?? row.row_id;
    const rawRowDocumentId = row.sourceDocumentId ?? row.source_document_id;
    const rawRowArtifactId = row.sourceArtifactId ?? row.source_artifact_id;
    const rawPageArtifactId = row.pageArtifactId ?? row.page_artifact_id;
    const rowId = pricingIdentifier(rawRowId);
    const rowDocumentId = rawRowDocumentId == null ? null : pricingIdentifier(rawRowDocumentId);
    const rowArtifactId = rawRowArtifactId == null ? null : pricingIdentifier(rawRowArtifactId);
    const pageArtifactId = rawPageArtifactId == null ? null : pricingIdentifier(rawPageArtifactId);
    const physicalPageNumber = pricingInteger(row.physicalPageNumber ?? row.page);
    const artifactLocalIndex = pricingInteger(row.artifactLocalIndex ?? row.artifact_local_index);
    const sourceLayer = pricingSourceLayer(row.sourceLayer ?? row.source_layer);
    const boundingBox = pricingBoundingBox(row.boundingBox ?? row.bounding_box);
    const anchors = Array.isArray(row.source_anchor_ids)
      ? row.source_anchor_ids.map(pricingIdentifier)
      : [];
    if (anchors.length > MAX_PRICING_SHADOW_CELLS
      || anchors.some((anchor) => anchor == null)
      || new Set(anchors).size !== anchors.length
      || (rawRowDocumentId != null && !rowDocumentId)
      || (rawRowArtifactId != null && !rowArtifactId)
      || (rawPageArtifactId != null && !pageArtifactId)) return [];
    const validAnchors = anchors as string[];
    const matchingObservation = diagnostics.observations.find((observation) =>
      validAnchors.includes(observation.observationId)
      && observation.sourceDocumentId === input.sourceDocumentId
      && observation.sourceArtifactId === input.sourceArtifactId
      && observation.physicalPageNumber === physicalPageNumber
      && observation.eligibility === 'canonical_eligible'
      && observation.reason === 'authoritative_scope_match');
    if (!rowId || physicalPageNumber == null || physicalPageNumber < 1 || !matchingObservation
      || !diagnostics.scope.authoritativePages.includes(physicalPageNumber)
      || (rowDocumentId != null && rowDocumentId !== input.sourceDocumentId)
      || (rowArtifactId != null && rowArtifactId !== input.sourceArtifactId)) return [];
    const admittedById = new Map(diagnostics.observations
      .filter((observation) => validAnchors.includes(observation.observationId)
        && observation.sourceDocumentId === input.sourceDocumentId
        && observation.sourceArtifactId === input.sourceArtifactId
        && observation.physicalPageNumber === physicalPageNumber
        && observation.eligibility === 'canonical_eligible'
        && observation.reason === 'authoritative_scope_match')
      .map((observation) => [observation.observationId, observation]));
    const cells = input.sourceObservations.flatMap((source) => {
      const sourceId = pricingIdentifier(pricingRecord(source)?.id);
      const admitted = sourceId ? admittedById.get(sourceId) : null;
      if (!admitted) return [];
      const cell = neutralPricingSourceObservation(source, input, admitted);
      if (!cell) return [];
      const semanticHints: NeutralPricingSemanticHint[] = [
        [row.description, 'description_like_text'],
        [row.category ?? row.source_category, 'category_like_text'],
        [row.unit, 'unit_like_text'],
        [row.rate_raw, 'rate_like_amount'],
        [row.quantity_text, 'quantity_like_amount'],
      ].flatMap(([value, role]) => typeof value === 'string' && value.length > 0
        && cell.rawText.includes(value) ? [role as NeutralPricingSemanticHint] : []);
      return [{ ...cell, ...(semanticHints.length > 0 ? { semanticHints } : {}) }];
    });
    if (cells.length === 0) return [];
    cells.sort((left, right) => left.columnIndex - right.columnIndex
      || left.readingOrder - right.readingOrder
      || left.observationId.localeCompare(right.observationId, 'en-US'));
    if (new Set(cells.map((cell) => cell.observationId)).size !== cells.length) {
      duplicateIdentity = true;
      return [];
    }
    if (admittedById.size !== validAnchors.length
      || cells.length !== admittedById.size
      || cells.some((cell) => !admittedById.has(cell.observationId))
      || (pageArtifactId != null
        && cells.some((cell) => cell.pageArtifactId != null
          && cell.pageArtifactId !== pageArtifactId))) return [];
    const rawGroups = row.pricing_cell_evidence;
    let sourceCellGroups: ForgewingPricingInterpretationInput['rowObservation']['sourceCellGroups'];
    if (rawGroups != null) {
      if (!Array.isArray(rawGroups) || rawGroups.length === 0 || rawGroups.length > 16) return [];
      const allowedRoles = new Set([
        'category', 'description', 'unit', 'origin_destination', 'rate', 'quantity',
        'item_number', 'extended_amount', 'unknown',
      ]);
      const groupedIds = new Set<string>();
      sourceCellGroups = [];
      for (const rawGroup of rawGroups) {
        const group = pricingRecord(rawGroup);
        const role = pricingString(group?.source_cell_role);
        const authoredRawText = typeof group?.authored_raw_text === 'string'
          ? group.authored_raw_text
          : null;
        const ids = Array.isArray(group?.source_observation_ids)
          ? group.source_observation_ids.map(pricingIdentifier)
          : [];
        if (!group || !role || !allowedRoles.has(role) || authoredRawText == null
          || authoredRawText.length > MAX_PRICING_SHADOW_SOURCE_TEXT_CHARS
          || ids.length === 0 || ids.length > 16 || ids.some((id) => id == null)) return [];
        const validIds = ids as string[];
        if (validIds.some((id) => !admittedById.has(id) || groupedIds.has(id))) return [];
        validIds.forEach((id) => groupedIds.add(id));
        sourceCellGroups.push({
          sourceCellRole: role as NonNullable<typeof sourceCellGroups>[number]['sourceCellRole'],
          sourceObservationIds: validIds,
          authoredRawText,
        });
      }
      if (groupedIds.size !== cells.length
        || cells.some((cell) => !groupedIds.has(cell.observationId))) return [];
    }
    const rawText = cells.map((cell) => cell.rawText).join('\n');
    if (rawText.length > MAX_PRICING_SHADOW_SOURCE_TEXT_CHARS) return [];
    const admittedObservationIds = [...admittedById.keys()].sort((left, right) =>
      left.localeCompare(right, 'en-US'));
    const scopeIdentity = hashCanonical({
      organizationId: input.organizationId,
      sourceDocumentId: input.sourceDocumentId,
      sourceArtifactId: input.sourceArtifactId,
      pageScopeApplicable: diagnostics.pageScopeApplicable,
      authoritativePages: diagnostics.scope.authoritativePages,
      admittedObservationIds,
    });
    return [{
      stableKey: `${rowId}:${admittedObservationIds.join(':')}`,
      input: {
        organizationId: input.organizationId,
        sourceDocumentId: input.sourceDocumentId,
        sourceArtifactId: input.sourceArtifactId,
        extractionSnapshotId: input.extractionSnapshotId,
        pricingScope: {
          scopeKind: 'authoritative' as const,
          eligibility: 'canonical_eligible' as const,
          eligibilityReason: 'authoritative_scope_match' as const,
          scopeIdentity,
        },
        rowObservation: {
          // The row keeps its own identity; cells cite actual admitted source
          // observations and never assembled row text.
          observationId: rowId,
          rawText,
          deterministicState,
          physicalPageNumber,
          cells,
          ...(sourceCellGroups ? { sourceCellGroups } : {}),
          ...(pageArtifactId ? { pageArtifactId } : {}),
          ...(artifactLocalIndex != null ? { artifactLocalIndex } : {}),
          ...(sourceLayer ? { sourceLayer } : {}),
          ...(boundingBox ? { boundingBox } : {}),
        },
      },
    }];
  });
  candidates.sort((left, right) => left.stableKey.localeCompare(right.stableKey, 'en-US'));
  if (duplicateIdentity
    || new Set(candidates.map((candidate) => candidate.stableKey)).size !== candidates.length
    || new Set(candidates.map((candidate) => candidate.input.rowObservation.observationId)).size
      !== candidates.length) return [];
  const frozenInputs = candidates.map((candidate) =>
    freezePricingInterpretationInput(candidate.input));
  return Object.freeze(frozenInputs);
}

/**
 * Registers one post-scope pricing proposal task. It returns before touching row
 * data when either flag is off and never exposes scope resolution to Forgewing.
 */
export function scheduleForgewingPricingInterpretationShadow(
  input: ForgewingPricingInterpretationShadowInput,
  dependencies: PricingShadowDependencies = {},
): void {
  const env = input.env ?? process.env;
  if (env.FORGEWING_SHADOW_ENABLED !== '1'
    || env.FORGEWING_PRICING_INTERPRETATION_ENABLED !== '1') return;
  const candidate = buildEligiblePricingReasoningShadowCandidates(input)[0];
  if (!candidate) return;
  const task = async (): Promise<void> => {
    try {
      const result = await (dependencies.run ?? runForgewingPricingInterpretation)(candidate);
      if (result.status === 'applied' || result.status === 'abstained') {
        const source = result.bundle.proposals[0] ?? result.bundle.abstentions[0];
        const persisted = await (dependencies.persist ?? persistReasoningShadowArtifact)({ input: {
          organizationId: input.organizationId,
          sourceDocumentId: input.sourceDocumentId,
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
        } });
        if (persisted.status !== 'persisted') {
          console.warn('[forgewingShadow] non-fatal pricing interpretation persistence outcome', {
            mode: 'shadow', status: persisted.status, reason: persisted.reason,
            ...('warningCode' in persisted ? { warningCode: persisted.warningCode } : {}),
          });
        }
      }
    } catch (error) {
      console.error('[forgewingShadow] non-fatal pricing interpretation failure', {
        mode: 'shadow', error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  try {
    (dependencies.register ?? ((backgroundTask) => after(backgroundTask)))(task);
  } catch (error) {
    console.error('[forgewingShadow] pricing interpretation registration failed', {
      mode: 'shadow', error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Neutral production-facing name; Forgewing remains private to this sole consumer. */
export const scheduleEligiblePricingReasoningShadow =
  scheduleForgewingPricingInterpretationShadow;

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
    if (isForgewingObservationArbitrationEnabled()) {
      const task = async (): Promise<void> => {
        try {
          const result = await runForgewingObservationArbitration(
            forgewingObservationArbitrationInput(input, organizationId, sourceDocumentId),
          );
          if (result.status === 'applied' || result.status === 'abstained') {
            const source = result.bundle.proposals[0] ?? result.bundle.abstentions[0];
            const persist = persistence.persist ?? persistReasoningShadowArtifact;
            const persisted = await persist({ input: {
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
            } });
            if (persisted.status !== 'persisted') {
              console.warn('[forgewingShadow] non-fatal observation arbitration persistence outcome', {
                mode: 'shadow', status: persisted.status, reason: persisted.reason,
                ...('warningCode' in persisted ? { warningCode: persisted.warningCode } : {}),
              });
            }
          }
          if (result.status !== 'skipped') {
            console.info('[forgewingShadow] observation arbitration completed', {
              mode: 'shadow', status: result.status, warnings: result.warnings,
              calls: result.metadata.calls, inputTruncated: result.metadata.inputTruncated,
            });
          }
        } catch (error) {
          console.error('[forgewingShadow] non-fatal observation arbitration failure', {
            mode: 'shadow', error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      try {
        (persistence.register ?? ((backgroundTask) => after(backgroundTask)))(task);
      } catch (error) {
        console.error('[forgewingShadow] observation arbitration registration failed', {
          mode: 'shadow', error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (isForgewingColumnMappingEnabled()) {
      const task = async (): Promise<void> => {
        try {
          const columnInput = forgewingColumnMappingInput(
            input,
            deterministicPayload,
            organizationId,
            sourceDocumentId,
          );
          if (!columnInput) return;
          const result = await runForgewingColumnMapping(columnInput);
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
              console.warn('[forgewingShadow] non-fatal column mapping persistence outcome', {
                mode: 'shadow',
                status: persisted.status,
                reason: persisted.reason,
                ...('warningCode' in persisted ? { warningCode: persisted.warningCode } : {}),
              });
            }
          }
          if (result.status !== 'skipped') {
            console.info('[forgewingShadow] column mapping completed', {
              mode: 'shadow', status: result.status, warnings: result.warnings,
              calls: result.metadata.calls, inputTruncated: result.metadata.inputTruncated,
            });
          }
        } catch (error) {
          console.error('[forgewingShadow] non-fatal column mapping failure', {
            mode: 'shadow', error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      try {
        (persistence.register ?? ((backgroundTask) => after(backgroundTask)))(task);
      } catch (error) {
        console.error('[forgewingShadow] column mapping registration failed', {
          mode: 'shadow', error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
