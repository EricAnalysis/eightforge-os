export type VisualHighlightRole =
  | 'candidate_member'
  | 'target_row_context'
  | 'alternative_candidate';

export type VisualSourceBox = Readonly<{
  observationId: string;
  rawText: string;
  role: VisualHighlightRole;
  boundingBox: Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;
  sourceLayer: 'pdf_native_text' | 'ocr';
  memberIndex: number;
}>;

export type VisualSourceEvidence = Readonly<{
  sourceArtifactId: string;
  sourceDocumentId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  candidateId: string;
  recoveryType: 'pricing_rate_single_observation'
    | 'pricing_rate_multi_observation_cluster'
    | 'priced_schedule_continuation_attribution';
  composedRawText: string;
  boxes: readonly VisualSourceBox[];
}>;
