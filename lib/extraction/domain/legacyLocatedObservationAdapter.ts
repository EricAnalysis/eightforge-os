import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import {
  hashParserManifest,
  type ParserManifest,
} from '@/lib/extraction/domain/parserManifest';
import type {
  BoundingBox,
  ExtractionConfidence,
  ExtractionRun,
  ExtractionSnapshot,
  FieldCandidate,
  PageArtifact,
  ParserIdentity,
  ProcessingGap,
  ProvenanceRequiredPageArtifact,
  ProvenanceRequiredSourceFragmentArtifact,
  SourceArtifact,
  SourceFragmentArtifact,
} from '@/lib/extraction/domain/types';
import {
  inheritPhysicalPageCoordinates,
  legacyPageCoordinate,
  type PhysicalPageCoordinate,
} from '@/lib/extraction/provenance/physicalPageCoordinate';

function inheritedCoordinate(
  parents: readonly PhysicalPageCoordinate[],
  sourceLayer: 'pdf_native_text' | 'ocr' | 'table_artifact',
  artifactLocalIndex?: number | null,
): PhysicalPageCoordinate {
  return inheritPhysicalPageCoordinates(parents, { sourceLayer, artifactLocalIndex });
}
import {
  verifyFieldCandidate,
  type VerificationRepository,
  type VerifiedField,
  type VerifiedFieldHandle,
} from '@/lib/extraction/domain/verifiedField';
import {
  classifySourceGroundedContent,
  type GenericContentAnalysis,
} from '@/lib/extraction/domain/genericContentScheduling';
import {
  buildGenericTableArtifacts,
  type GenericTableArtifactsResult,
} from '@/lib/extraction/domain/genericTableArtifacts';
import {
  arbitrateRegion,
  compareRegionCandidatesForCompatibilityStream,
  compareRegionTokensBySourceOrder,
  REGION_ARBITRATOR,
  REGION_ARBITRATION_POLICY_V2,
} from '@/lib/extraction/domain/regionArbitration';
import type {
  GenericContentDiagnosticGap,
} from '@/lib/extraction/ocrObservationSidecar';
import type {
  ArbitrationDecision,
  FragmentArtifactId,
  MeasuredScore,
  NonEmpty,
  RegionCandidate,
  TableChainArtifact,
  TableContinuationLink,
  LogicalTableRow,
  TableSectionArtifact,
  TableSegmentArtifact,
} from '@/lib/extraction/domain/types';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ADAPTER_PARSER: ParserIdentity = Object.freeze({
  stage: 'primitive_parse',
  name: 'legacy-located-observation-adapter',
  version: '1',
  configuration_hash: sha256Hex('legacy-located-observation-adapter:v1:text-identity'),
});

export interface LegacyOcrWordObservation {
  readonly text: string;
  /** Legacy OCR confidence on its native 0-100 scale. */
  readonly confidence?: number | null;
  readonly bbox?: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  } | null;
  readonly parser?: ParserIdentity;
  readonly physical_page_coordinate?: PhysicalPageCoordinate;
}

export interface LegacyOcrPageObservation {
  readonly page: number;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly rotation_degrees?: 0 | 90 | 180 | 270;
  readonly render_sha256?: string | null;
  readonly parser: ParserIdentity;
  readonly text_detected?: boolean;
  readonly words: readonly LegacyOcrWordObservation[];
  readonly physical_page_coordinate: PhysicalPageCoordinate;
}

export interface UnlocatedLegacyOutput {
  /** Shape/category marker only; unanchored field content must not enter the graph. */
  readonly category: string;
  readonly page?: number | null;
}

interface LegacyLocatedObservationAdapterInput {
  readonly sourceArtifact: SourceArtifact;
  readonly run: ExtractionRun;
  readonly pages: readonly LegacyOcrPageObservation[];
  readonly unlocatedOutputs?: readonly UnlocatedLegacyOutput[];
  readonly invalidLocatedOutputs?: readonly {
    readonly text: string;
    readonly page: number | null;
  }[];
}

interface LegacyLocatedObservationAdapterResult {
  readonly pages: readonly ProvenanceRequiredPageArtifact[];
  readonly fragments: readonly ProvenanceRequiredSourceFragmentArtifact[];
  readonly candidates: readonly FieldCandidate[];
  readonly verifiedFields: readonly VerifiedField[];
  readonly verifiedFieldHandles: readonly VerifiedFieldHandle[];
  readonly gaps: readonly ProcessingGap[];
}

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

function normalizedBox(
  word: LegacyOcrWordObservation,
  width: number,
  height: number,
  rotation: 0 | 90 | 180 | 270,
): BoundingBox | null {
  const box = word.bbox;
  if (!box) return null;
  const values = [box.x0, box.y0, box.x1, box.y1];
  if (values.some((value) => !Number.isFinite(value))
      || box.x0 < 0
      || box.y0 < 0
      || box.x0 >= box.x1
      || box.y0 >= box.y1
      || box.x1 > width
      || box.y1 > height) {
    return null;
  }
  return {
    coordinate_space: 'page_normalized',
    origin: 'top_left',
    x0: box.x0 / width,
    y0: box.y0 / height,
    x1: box.x1 / width,
    y1: box.y1 / height,
    rotation,
  };
}

function recognitionScore(confidence: number | null | undefined): number | null {
  return typeof confidence === 'number' && Number.isFinite(confidence)
    ? Math.max(0, Math.min(1, confidence / 100))
    : null;
}

function buildConfidence(
  fragmentId: SourceFragmentArtifact['id'],
  recognition: number | null,
): ExtractionConfidence {
  const observedGeometry = {
    state: 'observed' as const,
    score: 1,
    basis_artifact_ids: [fragmentId] as const,
    diagnostics: ['finite_page_normalized_word_box'],
  };
  const recognitionComponent = recognition == null
    ? {
        state: 'not_available' as const,
        score: null,
        basis_artifact_ids: [] as const,
        diagnostics: ['legacy_ocr_confidence_unavailable'],
      }
    : {
        state: 'observed' as const,
        score: recognition,
        basis_artifact_ids: [fragmentId] as const,
        diagnostics: ['legacy_ocr_word_confidence_normalized_from_0_100'],
      };
  const uncertainties = [
    'single_engine_only',
    ...(recognition == null ? ['legacy_ocr_confidence_unavailable'] : []),
  ];
  const uncappedOverall = recognition == null
    ? 0.5
    : Math.round(((recognition + 1 + 1) / 3) * 1_000_000) / 1_000_000;
  const overall = Math.min(0.85, uncappedOverall);
  return {
    version: 'extraction-confidence-v1',
    recognition: recognitionComponent,
    geometry_alignment: observedGeometry,
    parse_normalization: {
      state: 'observed',
      score: 1,
      basis_artifact_ids: [fragmentId],
      diagnostics: ['identity_text_primitive'],
    },
    cross_engine_agreement: {
      state: 'not_available',
      score: null,
      basis_artifact_ids: [],
      diagnostics: ['single_engine_only'],
    },
    overall,
    grade: overall >= 0.85 ? 'high' : overall >= 0.65 ? 'medium' : 'low',
    uncertainties,
  };
}

function missingGeometryGap(
  input: LegacyLocatedObservationAdapterInput,
  page: number | null,
  semanticIdentity: unknown,
  reason: ProcessingGap['reason'] = 'missing_geometry',
): ProcessingGap {
  const id = opaqueIds.processingGap({
    extraction_run_id: input.run.id,
    page,
    semantic_identity: semanticIdentity,
  });
  return {
    id,
    gap_key: `step1:${reason}:${page ?? 'document'}:${id}`,
    organization_id: input.sourceArtifact.organization_id,
    source_document_id: input.sourceArtifact.source_document_id,
    extraction_run_id: input.run.id,
    page,
    bounding_box: null,
    stage: 'field_verification',
    reason,
    retryable: false,
    attempts: 1,
    detail: reason === 'no_source_span'
      ? 'Legacy extraction output has no exact source span and remains unverified.'
      : 'Legacy extraction observation lacks complete source geometry and was skipped.',
    upstream_artifact_ids: [],
  };
}

/**
 * Shadow-only bridge for Step 1 evaluation. It has no persistence or reader
 * integration and deliberately refuses to turn unlocated legacy values into
 * machine fields.
 */
async function adaptLegacyLocatedObservations(
  input: LegacyLocatedObservationAdapterInput,
): Promise<LegacyLocatedObservationAdapterResult> {
  const pages: ProvenanceRequiredPageArtifact[] = [];
  const fragments: ProvenanceRequiredSourceFragmentArtifact[] = [];
  const candidates: FieldCandidate[] = [];
  const verifiedFields: VerifiedField[] = [];
  const verifiedFieldHandles: VerifiedFieldHandle[] = [];
  const gaps: ProcessingGap[] = [];

  for (const pageInput of input.pages) {
    const width = pageInput.width ?? 0;
    const height = pageInput.height ?? 0;
    const completePage = Number.isFinite(width)
      && Number.isFinite(height)
      && width > 0
      && height > 0
      && Number.isInteger(pageInput.page)
      && pageInput.page > 0
      && typeof pageInput.render_sha256 === 'string'
      && SHA256_PATTERN.test(pageInput.render_sha256);
    if (!completePage) {
      if (pageInput.words.length === 0) {
        gaps.push(missingGeometryGap(input, pageInput.page, {
          reason: pageInput.text_detected
            ? 'ocr_text_without_word_geometry'
            : 'ocr_page_without_verified_blank_or_word_geometry',
        }));
      }
      for (const [index, word] of pageInput.words.entries()) {
        if (hasText(word.text)) {
          gaps.push(missingGeometryGap(input, pageInput.page, {
            reason: 'page_geometry_incomplete',
            reading_order: index + 1,
            raw_text_sha256: sha256Hex(word.text),
          }));
        }
      }
      continue;
    }

    const pageId = opaqueIds.pageArtifact({
      extraction_run_id: input.run.id,
      source_artifact_id: input.sourceArtifact.id,
      page: pageInput.page,
      render_sha256: pageInput.render_sha256,
      parser: pageInput.parser,
    });
    const pageGapsBefore = gaps.length;
    const pageArtifact: ProvenanceRequiredPageArtifact = {
      id: pageId,
      organization_id: input.sourceArtifact.organization_id,
      extraction_run_id: input.run.id,
      source_artifact_id: input.sourceArtifact.id,
      source_document_id: input.sourceArtifact.source_document_id,
      source_sha256: input.sourceArtifact.source_sha256,
      page: pageInput.page,
      width,
      height,
      rotation_degrees: pageInput.rotation_degrees ?? 0,
      render_sha256: pageInput.render_sha256,
      parser_manifest_hash: input.run.parser_manifest_hash,
      parser: pageInput.parser,
      status: pageInput.words.length === 0 ? 'partial' : 'processed',
      physical_page_coordinate: pageInput.physical_page_coordinate,
    };
    pages.push(pageArtifact);

    if (pageInput.words.length === 0) {
      gaps.push(missingGeometryGap(input, pageInput.page, {
        reason: pageInput.text_detected
          ? 'ocr_text_without_word_geometry'
          : 'ocr_page_without_verified_blank_or_word_geometry',
      }));
    }

    for (const [index, word] of pageInput.words.entries()) {
      const text = word.text;
      if (!hasText(text)) continue;
      const box = normalizedBox(
        word,
        width,
        height,
        pageInput.rotation_degrees ?? 0,
      );
      if (!box) {
        gaps.push(missingGeometryGap(input, pageInput.page, {
          reason: 'word_geometry_incomplete',
          reading_order: index + 1,
          raw_text_sha256: sha256Hex(text),
        }));
        continue;
      }
      const fragmentId = opaqueIds.fragmentArtifact({
        page_artifact_id: pageId,
        reading_order: index + 1,
        bounding_box: box,
        raw_text_sha256: sha256Hex(text),
        parser: word.parser ?? pageInput.parser,
      });
      const fragment: ProvenanceRequiredSourceFragmentArtifact = {
        id: fragmentId,
        organization_id: input.sourceArtifact.organization_id,
        kind: 'token',
        extraction_run_id: input.run.id,
        source_artifact_id: input.sourceArtifact.id,
        page_artifact_id: pageId,
        source_document_id: input.sourceArtifact.source_document_id,
        source_sha256: input.sourceArtifact.source_sha256,
        parser_manifest_hash: input.run.parser_manifest_hash,
        page: pageInput.page,
        bounding_box: box,
        raw_text: text,
        parser: word.parser ?? pageInput.parser,
        recognition_confidence: recognitionScore(word.confidence),
        reading_order: index + 1,
        artifact_data: {},
        physical_page_coordinate: inheritedCoordinate(
          [word.physical_page_coordinate ?? pageInput.physical_page_coordinate],
          (word.parser ?? pageInput.parser).stage === 'native_text'
            ? 'pdf_native_text'
            : 'ocr',
          index,
        ),
      };
      const candidate: FieldCandidate = {
        id: opaqueIds.fieldCandidate({
          extraction_run_id: input.run.id,
          source_fragment_ids: [fragmentId],
          source_fragment_dependencies: [{
            fragment_artifact_id: fragmentId,
            dependency_role: 'content',
          }],
          primitive_kind: 'text',
          proposed_value: { type: 'text', value: text },
        }),
        organization_id: input.sourceArtifact.organization_id,
        extraction_run_id: input.run.id,
        source_artifact_id: input.sourceArtifact.id,
        source_document_id: input.sourceArtifact.source_document_id,
        source_sha256: input.sourceArtifact.source_sha256,
        parser_manifest_hash: input.run.parser_manifest_hash,
        source_fragment_ids: [fragmentId],
        source_fragment_dependencies: [{
          fragment_artifact_id: fragmentId,
          dependency_role: 'content',
        }],
        raw_text: text,
        primitive_kind: 'text',
        proposed_value: { type: 'text', value: text },
        transformations: [],
        parser: ADAPTER_PARSER,
        confidence: buildConfidence(fragmentId, fragment.recognition_confidence),
        status: 'candidate',
      };
      fragments.push(fragment);
      candidates.push(candidate);
    }

    if (gaps.length > pageGapsBefore) {
      pages[pages.length - 1] = { ...pageArtifact, status: 'partial' };
    }
  }

  for (const [index, output] of (input.unlocatedOutputs ?? []).entries()) {
    if (hasText(output.category)) {
      gaps.push(missingGeometryGap(input, output.page ?? null, {
        reason: 'unlocated_legacy_output',
        category: output.category,
        occurrence: index + 1,
      }, 'no_source_span'));
    }
  }
  for (const output of input.invalidLocatedOutputs ?? []) {
    if (hasText(output.text)) {
      gaps.push(missingGeometryGap(input, output.page, {
        reason: 'conflicting_page_geometry',
        raw_text_sha256: sha256Hex(output.text),
      }));
    }
  }

  const pageById = new Map(pages.map((page) => [page.id, page]));
  const fragmentById = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const repository: VerificationRepository = {
    async getCandidate(id) {
      return candidateById.get(id) ?? null;
    },
    async getFragments(ids) {
      return ids.flatMap((id) => {
        const fragment = fragmentById.get(id as SourceFragmentArtifact['id']);
        return fragment ? [fragment] : [];
      });
    },
    async getPages(ids) {
      return ids.flatMap((id) => {
        const page = pageById.get(id as PageArtifact['id']);
        return page ? [page] : [];
      });
    },
    async getRun(id) {
      return id === input.run.id ? input.run : null;
    },
    async getSourceArtifact(id) {
      return id === input.sourceArtifact.id ? input.sourceArtifact : null;
    },
    async getCorroborationPolicy() {
      return null;
    },
  };

  for (const candidate of candidates) {
    const result = await verifyFieldCandidate(candidate.id, repository);
    if (!result.ok) {
      throw new Error(`located legacy observation failed verification: ${result.code}`);
    }
    verifiedFields.push(result.verifiedField);
    verifiedFieldHandles.push(result.handle);
  }

  return {
    pages,
    fragments,
    candidates,
    verifiedFields,
    verifiedFieldHandles,
    gaps,
  };
}

export interface LegacyLocatedObservation {
  readonly page: number;
  readonly page_width?: number | null;
  readonly page_height?: number | null;
  readonly rotation_degrees?: 0 | 90 | 180 | 270;
  readonly render_sha256?: string | null;
  readonly parser: ParserIdentity;
  readonly text: string;
  /** Legacy OCR confidence on its native 0-100 scale. */
  readonly confidence?: number | null;
  readonly bbox?: LegacyOcrWordObservation['bbox'];
  readonly physical_page_coordinate?: PhysicalPageCoordinate;
}

export interface LegacyLocatedPageObservation {
  readonly page: number;
  readonly page_width: number;
  readonly page_height: number;
  readonly rotation_degrees?: 0 | 90 | 180 | 270;
  readonly render_sha256: string;
  readonly parser: ParserIdentity;
  readonly text_detected: boolean;
  readonly physical_page_coordinate?: PhysicalPageCoordinate;
}

export interface Step1ShadowExtractionRun extends ExtractionRun {
  readonly parser_manifest: ParserManifest;
  readonly idempotency_key: string;
  readonly started_at: string;
  readonly completed_at: string;
}

export interface Step1ShadowSnapshotMember {
  readonly member_kind:
    | 'page'
    | 'fragment'
    | 'candidate'
    | 'verified_field'
    | 'gap'
    | 'continuation_link'
    | 'table_chain'
    | 'table_section'
    | 'arbitration_decision';
  readonly page_artifact_id?: PageArtifact['id'];
  readonly fragment_artifact_id?: SourceFragmentArtifact['id'];
  readonly field_candidate_id?: FieldCandidate['id'];
  readonly verified_field_id?: VerifiedField['id'];
  readonly processing_gap_id?: string;
  readonly continuation_link_id?: string;
  readonly table_chain_id?: string;
  readonly table_section_id?: string;
  readonly arbitration_decision_id?: string;
  readonly dependency_hash: string;
  readonly sequence: number;
}

export interface AdaptLegacyExtractionToStep1ShadowInput {
  readonly sourceArtifact: SourceArtifact;
  readonly parserManifest: ParserManifest;
  readonly parserManifestHash: string;
  readonly artifactSchemaVersion: string;
  readonly idempotencyKey: string;
  readonly locatedObservations: readonly LegacyLocatedObservation[];
  readonly locatedPages?: readonly LegacyLocatedPageObservation[];
  readonly unlocatedOutputs?: readonly UnlocatedLegacyOutput[];
  readonly genericContentAnalysis?: GenericContentAnalysis;
  readonly genericContentGaps?: readonly GenericContentDiagnosticGap[];
  readonly completedAt?: string;
}

export interface AdaptLegacyExtractionToStep1ShadowResult {
  readonly run: Step1ShadowExtractionRun;
  /** Historical-compatible read views. New persistence uses the required aliases below. */
  readonly pages: readonly PageArtifact[];
  readonly fragments: readonly SourceFragmentArtifact[];
  readonly provenanceRequiredPages: readonly ProvenanceRequiredPageArtifact[];
  readonly provenanceRequiredFragments: readonly ProvenanceRequiredSourceFragmentArtifact[];
  readonly candidates: readonly FieldCandidate[];
  readonly verifiedFields: readonly VerifiedField[];
  readonly verifiedFieldHandles: readonly VerifiedFieldHandle[];
  readonly gaps: readonly ProcessingGap[];
  readonly fragmentDependencies: readonly {
    readonly fragment_artifact_id: FragmentArtifactId;
    readonly dependency_fragment_ids: NonEmpty<FragmentArtifactId>;
  }[];
  readonly continuationLinks: readonly (TableContinuationLink & {
    readonly basis_fragments: readonly {
      readonly basis_kind: keyof TableContinuationLink['basis'] | 'overall';
      readonly fragment_artifact_id: FragmentArtifactId;
      readonly sequence: number;
    }[];
  })[];
  readonly tableChains: readonly TableChainArtifact[];
  readonly tableRows: readonly LogicalTableRow[];
  readonly tableSegments: readonly TableSegmentArtifact[];
  readonly tableSections: readonly TableSectionArtifact[];
  readonly tableReconstructionDiagnostics:
    GenericTableArtifactsResult['reconstruction_diagnostics'];
  readonly arbitrationDecisions: readonly (ArbitrationDecision & {
    readonly processing_gap_id?: string | null;
  })[];
  readonly snapshot: ExtractionSnapshot;
  readonly members: readonly Step1ShadowSnapshotMember[];
  readonly skippedRecordCount: number;
}

function nonEmptyIds(
  ids: readonly FragmentArtifactId[],
  detail: string,
): NonEmpty<FragmentArtifactId> {
  const first = ids[0];
  if (!first) throw new Error(detail);
  return [first, ...ids.slice(1)];
}

function unionFragmentBox(fragments: NonEmpty<SourceFragmentArtifact>): BoundingBox {
  return {
    coordinate_space: 'page_normalized',
    origin: 'top_left',
    x0: Math.min(...fragments.map((fragment) => fragment.bounding_box.x0)),
    y0: Math.min(...fragments.map((fragment) => fragment.bounding_box.y0)),
    x1: Math.max(...fragments.map((fragment) => fragment.bounding_box.x1)),
    y1: Math.max(...fragments.map((fragment) => fragment.bounding_box.y1)),
    rotation: fragments[0].bounding_box.rotation,
  };
}

function regionMeasurement(
  value: number,
  ids: NonEmpty<FragmentArtifactId>,
  diagnostics: readonly string[],
): MeasuredScore {
  return {
    value,
    calculator: REGION_ARBITRATOR,
    basis_artifact_ids: ids,
    diagnostics,
  };
}

function buildArbitratedRegions(input: {
  readonly sourceArtifact: SourceArtifact;
  readonly run: Step1ShadowExtractionRun;
  readonly tokens: readonly ProvenanceRequiredSourceFragmentArtifact[];
}): {
  readonly regions: readonly ProvenanceRequiredSourceFragmentArtifact<RegionCandidate>[];
  readonly decisions: readonly (ArbitrationDecision & {
    readonly processing_gap_id?: string | null;
  })[];
  readonly acceptedTokens: readonly ProvenanceRequiredSourceFragmentArtifact[];
  readonly gaps: readonly ProcessingGap[];
} {
  const regions: ProvenanceRequiredSourceFragmentArtifact<RegionCandidate>[] = [];
  const decisions: Array<ArbitrationDecision & { processing_gap_id?: string | null }> = [];
  const gaps: ProcessingGap[] = [];
  const acceptedTokenIds = new Set<FragmentArtifactId>();
  const byPage = new Map<number, SourceFragmentArtifact[]>();
  for (const token of input.tokens.filter((fragment) => fragment.kind === 'token')) {
    byPage.set(token.page, [...(byPage.get(token.page) ?? []), token]);
  }
  for (const pageTokens of byPage.values()) {
    const bands: SourceFragmentArtifact[][] = [];
    for (const token of [...pageTokens].sort((left, right) =>
      left.bounding_box.y0 - right.bounding_box.y0
      || left.bounding_box.x0 - right.bounding_box.x0
      || left.bounding_box.y1 - right.bounding_box.y1
      || left.bounding_box.x1 - right.bounding_box.x1
      || compareRegionTokensBySourceOrder(left, right))) {
      const band = bands.find((candidate) => {
        return candidate.some((member) => {
          const overlap = Math.max(
            0,
            Math.min(token.bounding_box.y1, member.bounding_box.y1)
              - Math.max(token.bounding_box.y0, member.bounding_box.y0),
          );
          const minimumHeight = Math.min(
            token.bounding_box.y1 - token.bounding_box.y0,
            member.bounding_box.y1 - member.bounding_box.y0,
          );
          return minimumHeight > 0
            && overlap / minimumHeight
              >= REGION_ARBITRATION_POLICY_V2
                .physical_region_minimum_vertical_overlap_ratio;
        });
      });
      if (band) band.push(token);
      else bands.push([token]);
    }
    for (const [bandIndex, band] of bands.entries()) {
      const byEngine = new Map<string, SourceFragmentArtifact[]>();
      for (const token of band) {
        const key = hashCanonical(token.parser);
        byEngine.set(key, [...(byEngine.get(key) ?? []), token]);
      }
      const candidates = [...byEngine.values()].map((engineTokens) => {
        const ordered = engineTokens.sort((left, right) =>
          left.bounding_box.x0 - right.bounding_box.x0
          || left.bounding_box.x1 - right.bounding_box.x1
          || left.bounding_box.y0 - right.bounding_box.y0
          || left.bounding_box.y1 - right.bounding_box.y1
          || compareRegionTokensBySourceOrder(left, right));
        const firstToken = ordered[0];
        if (!firstToken) throw new Error('Region engine group requires source tokens.');
        const nonEmptyTokens: NonEmpty<SourceFragmentArtifact> = [
          firstToken,
          ...ordered.slice(1),
        ];
        const ids = nonEmptyIds(
          ordered.map((token) => token.id),
          'Region candidate requires source tokens.',
        );
        const rawText = ordered.map((token) => token.raw_text).join(' ');
        const glyphCharacters = [...rawText];
        const glyphValidity = glyphCharacters.length === 0 ? 0
          : glyphCharacters.filter((character) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(character)).length
            / glyphCharacters.length;
        const recognition = ordered
          .map((token) => token.recognition_confidence)
          .filter((score): score is number => score != null);
        const regionId = opaqueIds.fragmentArtifact({
          kind: 'region_candidate',
          page_artifact_id: firstToken.page_artifact_id,
          band_index: bandIndex,
          parser: firstToken.parser,
          ordered_token_ids: ids,
        });
        return {
          id: regionId,
          organization_id: input.sourceArtifact.organization_id,
          kind: 'region' as const,
          extraction_run_id: input.run.id,
          source_artifact_id: input.sourceArtifact.id,
          page_artifact_id: firstToken.page_artifact_id,
          source_document_id: input.sourceArtifact.source_document_id,
          source_sha256: input.sourceArtifact.source_sha256,
          parser_manifest_hash: input.run.parser_manifest_hash,
          page: firstToken.page,
          bounding_box: unionFragmentBox(nonEmptyTokens),
          raw_text: rawText,
          parser: firstToken.parser,
          recognition_confidence: recognition.length === ordered.length
            ? recognition.reduce((sum, score) => sum + score, 0) / recognition.length
            : null,
          reading_order: bandIndex + 1,
          artifact_data: { region_candidate: true },
          region_role: 'unknown' as const,
          child_fragment_ids: ids,
          ordered_token_ids: ids,
          engine_reported_confidence: recognition.length === ordered.length
            ? recognition.reduce((sum, score) => sum + score, 0) / recognition.length
            : null,
          quality_signals: {
            glyph_validity: regionMeasurement(glyphValidity, ids, ['observed glyph validity']),
            geometry_coverage: regionMeasurement(1, ids, ['all tokens have exact normalized boxes']),
            reading_order_consistency: regionMeasurement(1, ids, ['deterministic geometric order']),
            image_text_coverage: null,
          },
          physical_page_coordinate: inheritedCoordinate(
            ordered.map((token) => token.physical_page_coordinate
              ?? legacyPageCoordinate({
                sourceDocumentId: token.source_document_id,
                sourceArtifactId: token.source_artifact_id,
                legacyPageValue: token.page,
              })),
            firstToken.parser.stage === 'native_text' ? 'pdf_native_text' : 'ocr',
            bandIndex,
          ),
        } satisfies RegionCandidate;
      });
      if (candidates.length === 0) continue;
      const firstCandidate = candidates[0];
      if (!firstCandidate) continue;
      const nonEmptyCandidates: NonEmpty<RegionCandidate> = [
        firstCandidate,
        ...candidates.slice(1),
      ];
      regions.push(...candidates);
      const result = arbitrateRegion({
        candidates: nonEmptyCandidates,
        tokens: band,
      });
      if (result.gap) gaps.push(result.gap);
      decisions.push({
        ...result.decision,
        processing_gap_id: result.gap?.id ?? null,
      });
      const acceptedCandidateIds = new Set(
        result.decision.accepted_candidate_ids,
      );
      const selected = candidates
        .filter((candidate) => acceptedCandidateIds.has(candidate.id))
        .sort(compareRegionCandidatesForCompatibilityStream)[0];
      for (const tokenId of selected?.ordered_token_ids ?? []) acceptedTokenIds.add(tokenId);
    }
  }
  return {
    regions,
    decisions,
    acceptedTokens: input.tokens.filter((token) => acceptedTokenIds.has(token.id)),
    gaps,
  };
}

/**
 * Builds an isolated Step 1 artifact graph from legacy OCR observations.
 * Nothing returned here is persisted or selected by a production reader.
 */
export async function adaptLegacyExtractionToStep1Shadow(
  input: AdaptLegacyExtractionToStep1ShadowInput,
): Promise<AdaptLegacyExtractionToStep1ShadowResult> {
  if (hashParserManifest(input.parserManifest) !== input.parserManifestHash) {
    throw new Error('parser manifest hash does not match the supplied manifest');
  }
  if (!input.parserManifest.artifact_schema_version.trim()) {
    throw new Error('parser manifest artifact schema version must be nonblank');
  }
  if (!input.artifactSchemaVersion.trim()) {
    throw new Error('artifact persistence schema version must be nonblank');
  }
  const completedAt = input.completedAt ?? new Date().toISOString();
  const pageGroups = new Map<number, LegacyOcrPageObservation>();
  const conflictingOutputs: Array<{ text: string; page: number }> = [];
  for (const page of [...(input.locatedPages ?? [])].sort(
    (left, right) => left.page - right.page,
  )) {
    pageGroups.set(page.page, {
      page: page.page,
      width: page.page_width,
      height: page.page_height,
      rotation_degrees: page.rotation_degrees,
      render_sha256: page.render_sha256,
      parser: page.parser,
      text_detected: page.text_detected,
      words: [],
      physical_page_coordinate: page.physical_page_coordinate
        ?? legacyPageCoordinate({
          sourceDocumentId: input.sourceArtifact.source_document_id,
          sourceArtifactId: input.sourceArtifact.id,
          legacyPageValue: page.page,
        }),
    });
  }
  const orderedObservations = [...input.locatedObservations].sort((left, right) => {
    const leftBox = left.bbox;
    const rightBox = right.bbox;
    return left.page - right.page
      || (leftBox?.y0 ?? Number.POSITIVE_INFINITY) - (rightBox?.y0 ?? Number.POSITIVE_INFINITY)
      || (leftBox?.x0 ?? Number.POSITIVE_INFINITY) - (rightBox?.x0 ?? Number.POSITIVE_INFINITY)
      || (leftBox?.y1 ?? Number.POSITIVE_INFINITY) - (rightBox?.y1 ?? Number.POSITIVE_INFINITY)
      || (leftBox?.x1 ?? Number.POSITIVE_INFINITY) - (rightBox?.x1 ?? Number.POSITIVE_INFINITY)
      || left.text.localeCompare(right.text)
      || hashCanonical(left.parser).localeCompare(hashCanonical(right.parser));
  });
  for (const observation of orderedObservations) {
    const existing = pageGroups.get(observation.page);
    const pageIdentity = {
      width: observation.page_width,
      height: observation.page_height,
      rotation: observation.rotation_degrees ?? 0,
      render_sha256: observation.render_sha256,
    };
    if (existing && hashCanonical({
      width: existing.width,
      height: existing.height,
      rotation: existing.rotation_degrees ?? 0,
      render_sha256: existing.render_sha256,
    }) !== hashCanonical(pageIdentity)) {
      conflictingOutputs.push({ text: observation.text, page: observation.page });
      continue;
    }
    const word: LegacyOcrWordObservation = {
      text: observation.text,
      confidence: observation.confidence,
      bbox: observation.bbox,
      parser: observation.parser,
      physical_page_coordinate: observation.physical_page_coordinate,
    };
    if (existing) {
      pageGroups.set(observation.page, {
        ...existing,
        words: [...existing.words, word],
      });
    } else {
      pageGroups.set(observation.page, {
        page: observation.page,
        width: observation.page_width,
        height: observation.page_height,
        rotation_degrees: observation.rotation_degrees,
        render_sha256: observation.render_sha256,
        parser: observation.parser,
        text_detected: true,
        words: [word],
        physical_page_coordinate: observation.physical_page_coordinate
          ?? legacyPageCoordinate({
            sourceDocumentId: input.sourceArtifact.source_document_id,
            sourceArtifactId: input.sourceArtifact.id,
            legacyPageValue: observation.page,
          }),
      });
    }
  }

  const preliminaryRun: Step1ShadowExtractionRun = {
    id: opaqueIds.extractionRun({
      source_artifact_id: input.sourceArtifact.id,
      parser_manifest_hash: input.parserManifestHash,
      artifact_schema_version: input.artifactSchemaVersion,
    }),
    organization_id: input.sourceArtifact.organization_id,
    semantic_key: hashCanonical({
      source_artifact_id: input.sourceArtifact.id,
      parser_manifest_hash: input.parserManifestHash,
      artifact_schema_version: input.artifactSchemaVersion,
    }),
    attempt_number: 1,
    source_artifact_id: input.sourceArtifact.id,
    parser_manifest_hash: input.parserManifestHash,
    parser_manifest: input.parserManifest,
    artifact_schema_version: input.artifactSchemaVersion,
    idempotency_key: input.idempotencyKey,
    status: 'complete',
    started_at: completedAt,
    completed_at: completedAt,
  };
  const orderedUnlocatedOutputs = [...(input.unlocatedOutputs ?? [])].sort(
    (left, right) =>
      (left.page ?? Number.POSITIVE_INFINITY) - (right.page ?? Number.POSITIVE_INFINITY)
      || left.category.localeCompare(right.category),
  );
  const adapted = await adaptLegacyLocatedObservations({
    sourceArtifact: input.sourceArtifact,
    run: preliminaryRun,
    pages: [...pageGroups.values()],
    unlocatedOutputs: [
      ...orderedUnlocatedOutputs,
    ],
    invalidLocatedOutputs: conflictingOutputs,
  });
  const arbitration = buildArbitratedRegions({
    sourceArtifact: input.sourceArtifact,
    run: preliminaryRun,
    tokens: adapted.fragments,
  });
  const tableResult: GenericTableArtifactsResult = buildGenericTableArtifacts({
    source_artifact: input.sourceArtifact,
    run: preliminaryRun,
    pages: adapted.pages,
    fragments: arbitration.acceptedTokens,
  });
  const tableFragments: ProvenanceRequiredSourceFragmentArtifact[] = [
    ...tableResult.provenanceRequiredCells,
    ...tableResult.provenanceRequiredRows,
    ...tableResult.provenanceRequiredSegments,
  ];
  const fragments = [
    ...adapted.fragments,
    ...arbitration.regions,
    ...tableFragments,
  ];
  const candidates = [...adapted.candidates, ...tableResult.candidates];
  const pageById = new Map(adapted.pages.map((page) => [page.id, page]));
  const fragmentById = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const tableVerifiedFields: VerifiedField[] = [];
  const tableVerifiedHandles: VerifiedFieldHandle[] = [];
  const tableRepository: VerificationRepository = {
    async getCandidate(id) {
      return candidateById.get(id) ?? null;
    },
    async getFragments(ids) {
      return ids.flatMap((id) => {
        const fragment = fragmentById.get(id as FragmentArtifactId);
        return fragment ? [fragment] : [];
      });
    },
    async getPages(ids) {
      return ids.flatMap((id) => {
        const page = pageById.get(id as PageArtifact['id']);
        return page ? [page] : [];
      });
    },
    async getRun(id) {
      return id === preliminaryRun.id ? preliminaryRun : null;
    },
    async getSourceArtifact(id) {
      return id === input.sourceArtifact.id ? input.sourceArtifact : null;
    },
    async getCorroborationPolicy() {
      return null;
    },
  };
  for (const candidate of tableResult.candidates) {
    const verification = await verifyFieldCandidate(candidate.id, tableRepository);
    if (!verification.ok) {
      throw new Error(`table cell candidate failed verification: ${verification.code}`);
    }
    tableVerifiedFields.push(verification.verifiedField);
    tableVerifiedHandles.push(verification.handle);
  }
  const verifiedFields = [...adapted.verifiedFields, ...tableVerifiedFields];
  const verifiedFieldHandles = [
    ...adapted.verifiedFieldHandles,
    ...tableVerifiedHandles,
  ];
  const fragmentDependencies = [
    ...arbitration.regions.map((region) => ({
      fragment_artifact_id: region.id,
      dependency_fragment_ids: region.ordered_token_ids,
    })),
    ...tableResult.cells.map((cell) => ({
      fragment_artifact_id: cell.id,
      dependency_fragment_ids: nonEmptyIds(
        cell.content_token_ids,
        'Table cell requires content dependencies.',
      ),
    })),
    ...tableResult.rows.map((row) => ({
      fragment_artifact_id: row.id,
      dependency_fragment_ids: nonEmptyIds(
        row.cell_ids,
        'Table row requires cell dependencies.',
      ),
    })),
    ...tableResult.segments.map((segment) => ({
      fragment_artifact_id: segment.id,
      dependency_fragment_ids: segment.child_fragment_ids,
    })),
  ];
  const continuationLinks = tableResult.continuation_links.map((link) => ({
    ...link,
    basis_fragments: Object.entries({ ...link.basis, overall: link.score })
      .flatMap(([basisKind, score]) =>
        score == null ? [] : score.basis_artifact_ids.map((fragmentId, index) => ({
        basis_kind: basisKind as keyof TableContinuationLink['basis'] | 'overall',
        fragment_artifact_id: fragmentId,
        sequence: index + 1,
      }))),
  }));
  const tableChains = tableResult.chains.map((chain) => ({
    ...chain,
    continuation_link_ids: chain.continuation_links.map((link) => link.id),
  }));
  const tableSections = tableResult.sections.map((section, index) => ({
    ...section,
    sequence: index + 1,
  }));
  const arbitrationDecisions = arbitration.decisions.map((decision) => ({
    ...decision,
    candidates: decision.candidate_ids.map((candidateId, index) => ({
      candidate_fragment_id: candidateId,
      disposition: decision.accepted_candidate_ids.includes(candidateId)
        ? 'accepted' : 'rejected',
      sequence: index + 1,
    })),
  }));
  const schedulingGaps: ProcessingGap[] = (input.genericContentAnalysis?.decisions ?? [])
    .flatMap((decision): ProcessingGap[] => {
      const page = pageGroups.get(decision.page);
      const ocrProducedText = page?.words.some((word) => {
        if (!hasText(word.text) || !page.width || !page.height) return false;
        const box = normalizedBox(
          word,
          page.width,
          page.height,
          page.rotation_degrees ?? 0,
        );
        if (!box) return false;
        const centerX = (box.x0 + box.x1) / 2;
        const centerY = (box.y0 + box.y1) / 2;
        return centerX >= decision.bounding_box.x0
          && centerX < decision.bounding_box.x1
          && centerY >= decision.bounding_box.y0
          && centerY < decision.bounding_box.y1;
      }) ?? false;
      if (decision.action === 'ocr' && ocrProducedText) return [];
      const reason: ProcessingGap['reason'] = decision.action === 'skip'
        ? 'content_quality_skip'
        : 'ocr_region_failure';
      const id = opaqueIds.processingGap({
        extraction_run_id: preliminaryRun.id,
        region_id: decision.region_id,
        reason,
      });
      return [{
        id,
        gap_key: `step2:${reason}:${decision.region_id}`,
        organization_id: input.sourceArtifact.organization_id,
        source_document_id: input.sourceArtifact.source_document_id,
        extraction_run_id: preliminaryRun.id,
        page: decision.page,
        bounding_box: {
          coordinate_space: 'page_normalized',
          origin: 'top_left',
          ...decision.bounding_box,
          rotation: 0,
        },
        stage: 'ocr',
        reason,
        retryable: reason === 'ocr_region_failure',
        attempts: reason === 'ocr_region_failure' ? 1 : 0,
        detail: reason === 'content_quality_skip'
          ? `OCR skipped because ${decision.region_id} has adequate native text quality.`
          : `OCR was scheduled for ${decision.region_id} but produced no located text.`,
        upstream_artifact_ids: [],
      }];
    });
  const diagnosticGaps: ProcessingGap[] = (input.genericContentGaps ?? [])
    .map((gap) => ({
      id: opaqueIds.processingGap({
        extraction_run_id: preliminaryRun.id,
        gap_key: gap.gap_key,
        reason: gap.reason,
      }),
      gap_key: gap.gap_key,
      organization_id: input.sourceArtifact.organization_id,
      source_document_id: input.sourceArtifact.source_document_id,
      extraction_run_id: preliminaryRun.id,
      page: null,
      bounding_box: null,
      stage: gap.stage,
      reason: gap.reason,
      retryable: gap.retryable,
      attempts: gap.attempts,
      detail: gap.reason === 'decode_failure'
        ? `Generic PDF decoding failed (${gap.error_category}).`
        : `Generic content shadow diagnostic (${gap.error_category}).`,
      upstream_artifact_ids: [],
    }));
  const gaps = [
    ...adapted.gaps,
    ...arbitration.gaps,
    ...tableResult.gaps,
    ...schedulingGaps,
    ...diagnosticGaps,
  ];
  const closedTableChains = tableChains;
  const run: Step1ShadowExtractionRun = {
    ...preliminaryRun,
    status: gaps.some((gap) => gap.retryable)
      ? 'partial_retryable'
      : gaps.length > 0 ? 'partial_terminal' : 'complete',
  };

  const memberTargets: Array<
    Omit<Step1ShadowSnapshotMember, 'dependency_hash' | 'sequence'> & {
      readonly artifact: unknown;
    }
  > = [
    ...adapted.pages.map((artifact) => ({
      member_kind: 'page' as const,
      page_artifact_id: artifact.id,
      artifact,
    })),
    ...fragments.map((artifact) => ({
      member_kind: 'fragment' as const,
      fragment_artifact_id: artifact.id,
      artifact,
    })),
    ...candidates.map((artifact) => ({
      member_kind: 'candidate' as const,
      field_candidate_id: artifact.id,
      artifact,
    })),
    ...verifiedFields.map((artifact) => ({
      member_kind: 'verified_field' as const,
      verified_field_id: artifact.id,
      artifact,
    })),
    ...gaps.map((artifact) => ({
      member_kind: 'gap' as const,
      processing_gap_id: artifact.id,
      artifact,
    })),
    ...continuationLinks.map((artifact) => ({
      member_kind: 'continuation_link' as const,
      continuation_link_id: artifact.id,
      artifact,
    })),
    ...closedTableChains.map((artifact) => ({
      member_kind: 'table_chain' as const,
      table_chain_id: artifact.id,
      artifact,
    })),
    ...tableSections.map((artifact) => ({
      member_kind: 'table_section' as const,
      table_section_id: artifact.id,
      artifact,
    })),
    ...arbitrationDecisions.map((artifact) => ({
      member_kind: 'arbitration_decision' as const,
      arbitration_decision_id: artifact.id,
      artifact,
    })),
  ];
  const members = memberTargets.map(({ artifact, ...target }, index) => ({
    ...target,
    dependency_hash: hashCanonical(artifact),
    sequence: index + 1,
  }));
  const artifactRootHash = hashCanonical({
    artifact_schema_version: input.artifactSchemaVersion,
    members: members.map((member) => ({
      member_kind: member.member_kind,
      dependency_hash: member.dependency_hash,
      sequence: member.sequence,
    })),
  });
  const genericContentAnalysis = input.genericContentAnalysis
    ? (() => {
        // Scheduler classification may use provisional native text to plan work,
        // but it is never persisted directly. Persisted classification is always
        // recomputed from verified text and verified observed structure here.
        const classification = classifySourceGroundedContent({
          verified_texts: verifiedFields.map((field) => field.raw_text),
          structural_kinds: input.genericContentAnalysis?.decisions.map(
            (decision) => decision.structural_kind,
          ) ?? [],
        });
        const analysis = {
          policy: input.genericContentAnalysis.policy,
          media_type_sniffed: input.genericContentAnalysis.media_type_sniffed,
          page_count: input.genericContentAnalysis.page_count,
          decisions: input.genericContentAnalysis.decisions,
          pages_scheduled_for_ocr:
            input.genericContentAnalysis.pages_scheduled_for_ocr,
        };
        return {
          ...analysis,
          classification,
          content_extraction_fingerprint: hashCanonical({
            ...analysis,
            classification,
          }),
        };
      })()
    : null;
  const semanticObservationContent = {
    located_observations: orderedObservations.map((observation) => ({
      page: observation.page,
      page_width: observation.page_width,
      page_height: observation.page_height,
      rotation_degrees: observation.rotation_degrees ?? 0,
      render_sha256: observation.render_sha256,
      parser: observation.parser,
      raw_text: observation.text,
      recognition_confidence: recognitionScore(observation.confidence),
      bounding_box: observation.bbox,
    })),
    unlocated_output_markers: orderedUnlocatedOutputs.map((output) => ({
      category: output.category,
      page: output.page ?? null,
    })),
    generic_content_analysis: genericContentAnalysis,
    generic_content_gaps: input.genericContentGaps ?? [],
  };
  const snapshot: ExtractionSnapshot = {
    id: opaqueIds.extractionSnapshot({
      source_artifact_id: input.sourceArtifact.id,
      parser_manifest_hash: input.parserManifestHash,
      artifact_schema_version: input.artifactSchemaVersion,
      artifact_root_hash: artifactRootHash,
    }),
    organization_id: input.sourceArtifact.organization_id,
    source_document_id: input.sourceArtifact.source_document_id,
    source_artifact_id: input.sourceArtifact.id,
    source_sha256: input.sourceArtifact.source_sha256,
    parser_manifest_hash: input.parserManifestHash,
    artifact_schema_version: input.artifactSchemaVersion,
    producing_run_id: run.id,
    status: gaps.length > 0 ? 'partial' : 'complete',
    content_extraction_fingerprint: hashCanonical({
      source_sha256: input.sourceArtifact.source_sha256,
      parser_manifest_hash: input.parserManifestHash,
      artifact_schema_version: input.artifactSchemaVersion,
      semantic_observation_content: semanticObservationContent,
    }),
    artifact_root_hash: artifactRootHash,
    gap_ids: gaps.map((gap) => gap.id),
    published_at: completedAt,
  };

  return {
    run,
    pages: adapted.pages,
    fragments,
    provenanceRequiredPages: adapted.pages,
    provenanceRequiredFragments: fragments,
    candidates,
    verifiedFields,
    verifiedFieldHandles,
    gaps,
    fragmentDependencies,
    continuationLinks,
    tableChains: closedTableChains,
    tableRows: tableResult.rows,
    tableSegments: tableResult.segments,
    tableSections,
    tableReconstructionDiagnostics: tableResult.reconstruction_diagnostics,
    arbitrationDecisions,
    snapshot,
    members,
    skippedRecordCount: gaps.length,
  };
}
