'use client';

import { SourceEvidencePage } from '@/components/recovery/SourceEvidencePage';
import type { ForgewingLabelLinkageReviewPacket } from '@/lib/evaluation/forgewing/labelledPricingLinkageReview';
import type { VisualSourceEvidence } from '@/lib/recovery/visualSourceEvidence';

type PacketLabel = ForgewingLabelLinkageReviewPacket['labels'][number];
type Observation = PacketLabel['modern_pdf_layout_token_observations'][number];

export function A3LinkagePdfPage({ sourceUrl, pageNumber, observations, selectedObservationIds,
  hoveredObservationId, onHoverObservation, onToggleObservation }: {
  sourceUrl: string; pageNumber: number; pageWidth: number; pageHeight: number;
  observations: readonly Observation[]; selectedObservationIds: readonly string[];
  hoveredObservationId: string | null; onHoverObservation: (id: string | null) => void;
  onToggleObservation: (id: string) => void;
}) {
  const first = observations[0];
  const evidence: VisualSourceEvidence = {
    sourceArtifactId: first?.source_artifact_id ?? 'evaluation-artifact-unavailable',
    sourceDocumentId: first?.source_document_id ?? 'evaluation-document-unavailable',
    physicalPageNumber: pageNumber,
    pageRepresentationDigest: first?.page_representation_digest ?? 'evaluation-digest-unavailable',
    candidateId: first?.candidate_row_id ?? 'evaluation-candidate-unavailable',
    recoveryType: 'pricing_rate_single_observation',
    composedRawText: observations.map((observation) => observation.raw_text).join(' '),
    boxes: observations.map((observation, memberIndex) => ({
      observationId: observation.observation_id, rawText: observation.raw_text,
      role: 'candidate_member',
      boundingBox: { xMin: observation.bbox.x_min, xMax: observation.bbox.x_max,
        yMin: observation.bbox.y_min, yMax: observation.bbox.y_max },
      sourceLayer: observation.source_method === 'ocr_fallback' ? 'ocr' : 'pdf_native_text',
      memberIndex,
    })),
  };
  return <SourceEvidencePage sourceUrl={sourceUrl} evidence={evidence}
    selectedObservationIds={selectedObservationIds} hoveredObservationId={hoveredObservationId}
    onHoverObservation={onHoverObservation} onToggleObservation={onToggleObservation} />;
}
