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

type VisualSourceEvidenceBase = Readonly<{
  sourceArtifactId: string;
  sourceDocumentId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
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
