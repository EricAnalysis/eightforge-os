import { hashCanonical } from '@/lib/extraction/domain/hash';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import type {
  ArbitrationDecision,
  BoundingBox,
  MeasuredScore,
  NonEmpty,
  ParserIdentity,
  ProcessingGap,
  RegionCandidate,
  SourceFragmentArtifact,
} from '@/lib/extraction/domain/types';

export const REGION_ARBITRATION_POLICY_V2 = Object.freeze({
  name: 'region-arbitration',
  version: 'v2',
  physical_region_minimum_vertical_overlap_ratio: 0.5,
  comparison_iou_minimum: 0.5,
  comparison_containment_minimum: 0.8,
  winner_quality_margin_minimum: 0.15,
  high_quality_conflict_minimum: 0.75,
  normalization: 'unicode-nfkc-collapse-whitespace',
  compatibility_stream_selection:
    'observed_engine_confidence_then_quality_then_source_evidence',
});

export const REGION_ARBITRATOR: ParserIdentity = Object.freeze({
  stage: 'region_arbitration',
  name: REGION_ARBITRATION_POLICY_V2.name,
  version: REGION_ARBITRATION_POLICY_V2.version,
  configuration_hash: hashCanonical(REGION_ARBITRATION_POLICY_V2),
});

export interface ArbitrateRegionInput {
  readonly candidates: NonEmpty<RegionCandidate>;
  readonly tokens: readonly SourceFragmentArtifact[];
}

export interface ArbitrateRegionResult {
  readonly decision: ArbitrationDecision;
  readonly gap: ProcessingGap | null;
}

export interface BuildRegionCandidateInput {
  readonly tokens: NonEmpty<SourceFragmentArtifact>;
  readonly region_role?: RegionCandidate['region_role'];
  readonly engine_reported_confidence?: number | null;
  readonly image_text_coverage?: number | null;
}

function nonEmpty<T>(items: readonly T[]): NonEmpty<T> {
  if (items.length === 0) throw new Error('Expected at least one arbitration dependency.');
  return items as unknown as NonEmpty<T>;
}

function area(box: BoundingBox): number {
  return Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
}

function overlap(left: BoundingBox, right: BoundingBox): {
  readonly iou: number;
  readonly containment: number;
} {
  const intersection = Math.max(0, Math.min(left.x1, right.x1) - Math.max(left.x0, right.x0))
    * Math.max(0, Math.min(left.y1, right.y1) - Math.max(left.y0, right.y0));
  const leftArea = area(left);
  const rightArea = area(right);
  return {
    iou: intersection / Math.max(Number.EPSILON, leftArea + rightArea - intersection),
    containment: intersection / Math.max(Number.EPSILON, Math.min(leftArea, rightArea)),
  };
}

function score(candidate: RegionCandidate): number {
  const values = [
    candidate.quality_signals.glyph_validity.value,
    candidate.quality_signals.geometry_coverage.value,
    candidate.quality_signals.reading_order_consistency.value,
    candidate.quality_signals.image_text_coverage?.value,
  ].filter((value): value is number => value != null);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizedText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareRegionTokensBySourceOrder(
  left: SourceFragmentArtifact,
  right: SourceFragmentArtifact,
): number {
  return left.page - right.page
    || left.reading_order - right.reading_order
    || left.bounding_box.y0 - right.bounding_box.y0
    || left.bounding_box.x0 - right.bounding_box.x0
    || left.bounding_box.y1 - right.bounding_box.y1
    || left.bounding_box.x1 - right.bounding_box.x1
    || compareText(left.raw_text, right.raw_text)
    || compareText(left.parser.stage, right.parser.stage)
    || compareText(left.parser.name, right.parser.name)
    || compareText(left.parser.version, right.parser.version);
}

export function compareRegionCandidatesBySourceEvidence(
  left: RegionCandidate,
  right: RegionCandidate,
): number {
  return left.page - right.page
    || left.bounding_box.y0 - right.bounding_box.y0
    || left.bounding_box.x0 - right.bounding_box.x0
    || left.bounding_box.y1 - right.bounding_box.y1
    || left.bounding_box.x1 - right.bounding_box.x1
    || left.reading_order - right.reading_order
    || compareText(normalizedText(left.raw_text), normalizedText(right.raw_text))
    || compareText(left.parser.stage, right.parser.stage)
    || compareText(left.parser.name, right.parser.name)
    || compareText(left.parser.version, right.parser.version);
}

export function compareRegionCandidatesForCompatibilityStream(
  left: RegionCandidate,
  right: RegionCandidate,
): number {
  const leftRecognition = left.engine_reported_confidence
    ?? left.recognition_confidence;
  const rightRecognition = right.engine_reported_confidence
    ?? right.recognition_confidence;
  return Number(rightRecognition != null) - Number(leftRecognition != null)
    || (rightRecognition ?? -1) - (leftRecognition ?? -1)
    || score(right) - score(left)
    || compareRegionCandidatesBySourceEvidence(left, right);
}

function isValidBox(box: BoundingBox): boolean {
  return box.coordinate_space === 'page_normalized'
    && box.origin === 'top_left'
    && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
    && box.x0 >= 0 && box.y0 >= 0 && box.x1 <= 1 && box.y1 <= 1
    && box.x0 < box.x1 && box.y0 < box.y1;
}

export function buildRegionCandidate(input: BuildRegionCandidateInput): RegionCandidate {
  const ordered = nonEmpty([...input.tokens].sort((left, right) =>
    compareRegionTokensBySourceOrder(left, right)));
  const first = ordered[0];
  if (ordered.some((token) =>
    token.kind !== 'token'
    || !isValidBox(token.bounding_box)
    || token.organization_id !== first.organization_id
    || token.extraction_run_id !== first.extraction_run_id
    || token.source_artifact_id !== first.source_artifact_id
    || token.source_document_id !== first.source_document_id
    || token.source_sha256 !== first.source_sha256
    || token.parser_manifest_hash !== first.parser_manifest_hash
    || token.page_artifact_id !== first.page_artifact_id
    || token.page !== first.page
    || hashCanonical(token.parser) !== hashCanonical(first.parser)
  )) {
    throw new Error('Region candidate tokens require one engine, page, and provenance identity.');
  }
  const basis = nonEmpty(ordered.map(({ id }) => id));
  const observed = (value: number, diagnostic: string): MeasuredScore => ({
    value,
    calculator: first.parser,
    basis_artifact_ids: basis,
    diagnostics: [diagnostic],
  });
  const rawText = ordered.map(({ raw_text }) => raw_text).join(' ');
  const glyphCount = [...rawText].length;
  const validGlyphCount = [...rawText].filter((character) =>
    character === '\n' || character === '\t' || character >= ' ').length;
  const orderedByGeometry = [...ordered].sort((left, right) =>
    left.bounding_box.y0 - right.bounding_box.y0
    || left.bounding_box.x0 - right.bounding_box.x0
    || left.bounding_box.y1 - right.bounding_box.y1
    || left.bounding_box.x1 - right.bounding_box.x1
    || left.reading_order - right.reading_order
    || compareRegionTokensBySourceOrder(left, right));
  const positionById = new Map(orderedByGeometry.map(({ id }, index) => [id, index]));
  let concordant = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if ((positionById.get(ordered[index - 1].id) ?? 0)
      <= (positionById.get(ordered[index].id) ?? 0)) concordant += 1;
  }
  const readingOrderScore = ordered.length === 1 ? 1 : concordant / (ordered.length - 1);
  const boundingBox: BoundingBox = {
    coordinate_space: 'page_normalized',
    origin: 'top_left',
    x0: Math.min(...ordered.map(({ bounding_box }) => bounding_box.x0)),
    y0: Math.min(...ordered.map(({ bounding_box }) => bounding_box.y0)),
    x1: Math.max(...ordered.map(({ bounding_box }) => bounding_box.x1)),
    y1: Math.max(...ordered.map(({ bounding_box }) => bounding_box.y1)),
    rotation: first.bounding_box.rotation,
  };
  const id = opaqueIds.fragmentArtifact({
    kind: 'region_candidate',
    page_artifact_id: first.page_artifact_id,
    parser: first.parser,
    ordered_token_ids: basis,
    bounding_box: boundingBox,
  });
  return {
    id,
    organization_id: first.organization_id,
    kind: 'region',
    extraction_run_id: first.extraction_run_id,
    source_artifact_id: first.source_artifact_id,
    page_artifact_id: first.page_artifact_id,
    source_document_id: first.source_document_id,
    source_sha256: first.source_sha256,
    parser_manifest_hash: first.parser_manifest_hash,
    page: first.page,
    bounding_box: boundingBox,
    raw_text: rawText,
    parser: first.parser,
    recognition_confidence: input.engine_reported_confidence ?? null,
    reading_order: Math.min(...ordered.map(({ reading_order }) => reading_order)),
    region_role: input.region_role ?? 'unknown',
    child_fragment_ids: basis,
    ordered_token_ids: basis,
    engine_reported_confidence: input.engine_reported_confidence ?? null,
    quality_signals: {
      glyph_validity: observed(
        glyphCount === 0 ? 0 : validGlyphCount / glyphCount,
        'Ratio of source-observed printable glyphs.',
      ),
      geometry_coverage: observed(1, 'Every retained token has exact in-page geometry.'),
      reading_order_consistency: observed(
        readingOrderScore,
        'Concordance of engine reading order with observed geometry.',
      ),
      image_text_coverage: input.image_text_coverage == null
        ? null
        : observed(input.image_text_coverage, 'Measured source-image text coverage.'),
    },
  };
}

function measured(
  value: number,
  candidates: NonEmpty<RegionCandidate>,
  diagnostic: string,
): MeasuredScore {
  return {
    value,
    calculator: REGION_ARBITRATOR,
    basis_artifact_ids: nonEmpty(candidates.map((candidate) => candidate.id)),
    diagnostics: [diagnostic],
  };
}

function makeGap(
  candidate: RegionCandidate,
  candidates: NonEmpty<RegionCandidate>,
  detail: string,
): ProcessingGap {
  const id = opaqueIds.processingGap({
    extraction_run_id: candidate.extraction_run_id,
    candidate_ids: candidates.map(({ id: candidateId }) => candidateId),
    reason: 'arbitration_unresolved',
    detail,
  });
  return {
    id,
    gap_key: `step3:arbitration_unresolved:${id}`,
    organization_id: candidate.organization_id,
    source_document_id: candidate.source_document_id,
    extraction_run_id: candidate.extraction_run_id,
    page: candidate.page,
    bounding_box: candidate.bounding_box,
    stage: 'region_arbitration',
    reason: 'arbitration_unresolved',
    retryable: false,
    attempts: 1,
    detail,
    upstream_artifact_ids: candidates.map(({ id: candidateId }) => candidateId),
  };
}

function exactSupportingText(
  candidate: RegionCandidate,
  tokenById: ReadonlyMap<string, SourceFragmentArtifact>,
): boolean {
  const resolved = candidate.ordered_token_ids.map((id) => tokenById.get(id));
  if (resolved.some((token) => !token || token.kind !== 'token')) return false;
  const tokens = resolved as SourceFragmentArtifact[];
  return normalizedText(tokens.map((token) => token.raw_text).join(' '))
    === normalizedText(candidate.raw_text);
}

function assertClosedIdentity(candidates: NonEmpty<RegionCandidate>): void {
  const first = candidates[0];
  for (const candidate of candidates) {
    if (
      candidate.organization_id !== first.organization_id
      || candidate.extraction_run_id !== first.extraction_run_id
      || candidate.source_artifact_id !== first.source_artifact_id
      || candidate.source_document_id !== first.source_document_id
      || candidate.source_sha256 !== first.source_sha256
      || candidate.parser_manifest_hash !== first.parser_manifest_hash
      || candidate.page_artifact_id !== first.page_artifact_id
      || candidate.page !== first.page
    ) {
      throw new Error('Region arbitration candidates must share page and provenance identity.');
    }
  }
}

export function arbitrateRegion(input: ArbitrateRegionInput): ArbitrateRegionResult {
  const candidates = [...input.candidates].sort(
    compareRegionCandidatesBySourceEvidence,
  ) as unknown as NonEmpty<RegionCandidate>;
  assertClosedIdentity(candidates);
  const first = candidates[0];
  const tokenById = new Map(input.tokens.map((token) => [token.id, token]));
  const ungroundedVision = candidates.find(
    (candidate) =>
      candidate.parser.stage === 'vision'
      && (!area(candidate.bounding_box) || !exactSupportingText(candidate, tokenById)),
  );
  if (ungroundedVision) {
    const detail = 'Vision candidate lacks an exact page polygon or exact supporting text.';
    const gap = makeGap(first, candidates, detail);
    return {
      decision: decisionFor(candidates, [], 'unresolved', null, [detail]),
      gap,
    };
  }

  if (candidates.length === 1) {
    return {
      decision: decisionFor(candidates, [first.id], 'single_source', null, [
        'One grounded source candidate was available.',
      ]),
      gap: null,
    };
  }

  const comparable = candidates.every((candidate, index) =>
    candidates.slice(index + 1).every((other) => {
      const measuredOverlap = overlap(candidate.bounding_box, other.bounding_box);
      return measuredOverlap.iou >= REGION_ARBITRATION_POLICY_V2.comparison_iou_minimum
        || measuredOverlap.containment
          >= REGION_ARBITRATION_POLICY_V2.comparison_containment_minimum;
    }));
  if (!comparable) {
    const detail = 'Same-page candidates do not cross the manifest-versioned overlap threshold.';
    return {
      decision: decisionFor(candidates, [], 'unresolved', null, [detail]),
      gap: makeGap(first, candidates, detail),
    };
  }

  const texts = new Set(candidates.map((candidate) => normalizedText(candidate.raw_text)));
  if (texts.size === 1) {
    return {
      decision: decisionFor(
        candidates,
        candidates.map(({ id }) => id),
        'consensus',
        measured(1, candidates, 'Candidate text is normalized-equivalent.'),
        ['Exact or permitted-normalized text consensus.'],
      ),
      gap: null,
    };
  }

  const ranked = candidates
    .map((candidate) => ({ candidate, quality: score(candidate) }))
    .sort((left, right) => right.quality - left.quality
      || compareRegionCandidatesBySourceEvidence(
        left.candidate,
        right.candidate,
      ));
  const winner = ranked[0];
  const conflicts = ranked.slice(1);
  const margin = winner.quality - conflicts[0].quality;
  const highQualityConflict = conflicts.some(
    ({ quality }) =>
      quality >= REGION_ARBITRATION_POLICY_V2.high_quality_conflict_minimum,
  );
  if (
    margin >= REGION_ARBITRATION_POLICY_V2.winner_quality_margin_minimum
    && !highQualityConflict
  ) {
    return {
      decision: decisionFor(candidates, [winner.candidate.id], 'single_source', measured(
        margin,
        candidates,
        'Winner quality margin over conflicting candidates.',
      ), ['One grounded candidate exceeded all conflicts by the required margin.']),
      gap: null,
    };
  }

  const detail = highQualityConflict
    ? 'Conflicting high-quality candidates remain.'
    : 'No candidate exceeds every conflict by the required quality margin.';
  return {
    decision: decisionFor(
      candidates,
      [],
      'conflict',
      measured(Math.max(0, margin), candidates, 'Observed quality margin under conflict.'),
      [detail],
    ),
    gap: makeGap(first, candidates, detail),
  };
}

function decisionFor(
  candidates: NonEmpty<RegionCandidate>,
  accepted: readonly RegionCandidate['id'][],
  decision: ArbitrationDecision['decision'],
  agreement: MeasuredScore | null,
  diagnostics: readonly string[],
): ArbitrationDecision {
  const first = candidates[0];
  const rejected = candidates
    .map(({ id }) => id)
    .filter((id) => !accepted.includes(id));
  return {
    id: opaqueIds.fragmentArtifact({
      kind: 'arbitration_decision',
      extraction_run_id: first.extraction_run_id,
      candidate_ids: candidates.map(({ id }) => id),
      accepted_candidate_ids: accepted,
      decision,
      parser: REGION_ARBITRATOR,
    }),
    organization_id: first.organization_id,
    extraction_run_id: first.extraction_run_id,
    source_artifact_id: first.source_artifact_id,
    source_document_id: first.source_document_id,
    source_sha256: first.source_sha256,
    parser_manifest_hash: first.parser_manifest_hash,
    page_artifact_id: first.page_artifact_id,
    parser: REGION_ARBITRATOR,
    physical_region_id: first.id,
    candidate_ids: nonEmpty(candidates.map(({ id }) => id)),
    accepted_candidate_ids: accepted,
    rejected_candidate_ids: rejected,
    agreement,
    decision,
    diagnostics,
  };
}
