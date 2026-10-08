import type {
  CanonicalBox,
  GeometryCoordinateSpace,
} from '@/lib/extraction/geometry/canonicalPageFrame';

export type VisualHighlightRole =
  | 'candidate_member'
  | 'target_row_context'
  | 'alternative_candidate';

export type VisualSourceBox = Readonly<{
  observationId: string;
  rawText: string;
  role: VisualHighlightRole;
  /** Historical source geometry, in `sourceCoordinateSpace`. Never rewritten. */
  boundingBox: Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;
  sourceLayer: 'pdf_native_text' | 'ocr';
  /**
   * Explicit space of `boundingBox`. Absent on historical v1 evidence, which
   * the viewer resolves through `historicalV1CoordinateSpace`.
   */
  sourceCoordinateSpace?: Exclude<GeometryCoordinateSpace, 'canonical_v1'>;
  /** Derived canonical geometry, when the evidence's source box still matches. */
  canonicalBoundingBox?: CanonicalBox;
  memberIndex: number;
}>;

type VisualSourceEvidenceBase = Readonly<{
  sourceArtifactId: string;
  sourceDocumentId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  ocrPixelWidth?: number;
  ocrPixelHeight?: number;
  boxes: readonly VisualSourceBox[];
}>;

export type RecoveryVisualSourceEvidence = VisualSourceEvidenceBase & Readonly<{
  kind?: 'recovery';
  candidateId: string;
  recoveryType: 'pricing_rate_single_observation'
    | 'pricing_rate_multi_observation_cluster'
    | 'priced_schedule_continuation_attribution'
    | 'priced_schedule_header_role_selection';
  composedRawText: string;
}>;

export type DiagnosticVisualSourceEvidence = VisualSourceEvidenceBase & Readonly<{
  kind: 'diagnostic';
  diagnosticId: string;
  summary: string;
}>;

export type VisualSourceEvidence = RecoveryVisualSourceEvidence | DiagnosticVisualSourceEvidence;

export function visualSourceEvidenceIdentity(evidence: VisualSourceEvidence): string {
  return evidence.kind === 'diagnostic' ? evidence.diagnosticId : evidence.candidateId;
}

/**
 * The canonical boxes of a line's source observations: exactly one valid
 * canonical_v1 box per observation, sorted by observation id. Null when any
 * observation lacks one, so an unproven region is never drawn. The value-reading
 * crop and offline qualification both use it, so qualification measures the
 * region production would send.
 */
export function canonicalBoxesForObservations(
  evidence: Pick<VisualSourceEvidenceBase, 'boxes'>,
  sourceObservationIds: readonly string[],
): CanonicalBox[] | null {
  const ids = [...new Set(sourceObservationIds)].sort();
  if (ids.length === 0) return null;
  const canonicalBoxes: CanonicalBox[] = [];
  for (const id of ids) {
    const matches = evidence.boxes.filter((box) => box.observationId === id);
    const canonical = matches[0]?.canonicalBoundingBox;
    if (matches.length !== 1 || !canonical || canonical.coordinate_space !== 'canonical_v1'
      || ![canonical.x_min, canonical.x_max, canonical.y_min, canonical.y_max].every(Number.isFinite)
      || canonical.x_max <= canonical.x_min || canonical.y_max <= canonical.y_min) return null;
    canonicalBoxes.push({ coordinate_space: 'canonical_v1', x_min: canonical.x_min, x_max: canonical.x_max,
      y_min: canonical.y_min, y_max: canonical.y_max });
  }
  return canonicalBoxes;
}
