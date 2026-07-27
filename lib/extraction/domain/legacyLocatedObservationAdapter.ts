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
  SourceArtifact,
  SourceFragmentArtifact,
} from '@/lib/extraction/domain/types';
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
  readonly pages: readonly PageArtifact[];
  readonly fragments: readonly SourceFragmentArtifact[];
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
  const pages: PageArtifact[] = [];
  const fragments: SourceFragmentArtifact[] = [];
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
    const pageArtifact: PageArtifact = {
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
        parser: pageInput.parser,
      });
      const fragment: SourceFragmentArtifact = {
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
        parser: pageInput.parser,
        recognition_confidence: recognitionScore(word.confidence),
        reading_order: index + 1,
        artifact_data: {},
      };
      const candidate: FieldCandidate = {
        id: opaqueIds.fieldCandidate({
          extraction_run_id: input.run.id,
          source_fragment_ids: [fragmentId],
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
}

export interface LegacyLocatedPageObservation {
  readonly page: number;
  readonly page_width: number;
  readonly page_height: number;
  readonly rotation_degrees?: 0 | 90 | 180 | 270;
  readonly render_sha256: string;
  readonly parser: ParserIdentity;
  readonly text_detected: boolean;
}

export interface Step1ShadowExtractionRun extends ExtractionRun {
  readonly parser_manifest: ParserManifest;
  readonly idempotency_key: string;
  readonly started_at: string;
  readonly completed_at: string;
}

export interface Step1ShadowSnapshotMember {
  readonly member_kind: 'page' | 'fragment' | 'candidate' | 'verified_field' | 'gap';
  readonly page_artifact_id?: PageArtifact['id'];
  readonly fragment_artifact_id?: SourceFragmentArtifact['id'];
  readonly field_candidate_id?: FieldCandidate['id'];
  readonly verified_field_id?: VerifiedField['id'];
  readonly processing_gap_id?: string;
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
  readonly completedAt?: string;
}

export interface AdaptLegacyExtractionToStep1ShadowResult {
  readonly run: Step1ShadowExtractionRun;
  readonly pages: readonly PageArtifact[];
  readonly fragments: readonly SourceFragmentArtifact[];
  readonly candidates: readonly FieldCandidate[];
  readonly verifiedFields: readonly VerifiedField[];
  readonly gaps: readonly ProcessingGap[];
  readonly snapshot: ExtractionSnapshot;
  readonly members: readonly Step1ShadowSnapshotMember[];
  readonly skippedRecordCount: number;
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
  if (input.parserManifest.artifact_schema_version !== input.artifactSchemaVersion) {
    throw new Error('artifact schema version does not match the parser manifest');
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
      parser: observation.parser,
    };
    if (existing && hashCanonical({
      width: existing.width,
      height: existing.height,
      rotation: existing.rotation_degrees ?? 0,
      render_sha256: existing.render_sha256,
      parser: existing.parser,
    }) !== hashCanonical(pageIdentity)) {
      conflictingOutputs.push({ text: observation.text, page: observation.page });
      continue;
    }
    const word: LegacyOcrWordObservation = {
      text: observation.text,
      confidence: observation.confidence,
      bbox: observation.bbox,
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
  const schedulingGaps: ProcessingGap[] = (input.genericContentAnalysis?.decisions ?? [])
    .flatMap((decision): ProcessingGap[] => {
      const page = pageGroups.get(decision.page);
      const ocrProducedText = page?.words.some((word) => hasText(word.text)) ?? false;
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
  const gaps = [...adapted.gaps, ...schedulingGaps];
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
    ...adapted.fragments.map((artifact) => ({
      member_kind: 'fragment' as const,
      fragment_artifact_id: artifact.id,
      artifact,
    })),
    ...adapted.candidates.map((artifact) => ({
      member_kind: 'candidate' as const,
      field_candidate_id: artifact.id,
      artifact,
    })),
    ...adapted.verifiedFields.map((artifact) => ({
      member_kind: 'verified_field' as const,
      verified_field_id: artifact.id,
      artifact,
    })),
    ...gaps.map((artifact) => ({
      member_kind: 'gap' as const,
      processing_gap_id: artifact.id,
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
        const classification = classifySourceGroundedContent({
          verified_texts: adapted.verifiedFields.map((field) => field.raw_text),
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
    fragments: adapted.fragments,
    candidates: adapted.candidates,
    verifiedFields: adapted.verifiedFields,
    gaps,
    snapshot,
    members,
    skippedRecordCount: gaps.length,
  };
}
