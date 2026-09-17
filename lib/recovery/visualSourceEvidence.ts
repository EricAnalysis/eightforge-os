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
    | 'priced_schedule_continuation_attribution';
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
