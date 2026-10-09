import type { VisualSourceBox, VisualSourceEvidence } from '@/lib/recovery/visualSourceEvidence';
import type { RecoveryReviewCandidate } from '@/lib/server/forgewingRecoveryReviewRead';

/**
 * The source page evidence for one selectable confirmation of a recovery
 * proposal: the selected candidate's members, its target row context and the
 * other candidates' rows as alternatives. Built only from the server-read
 * candidate, by exact id. Shared by the document recovery panel and the
 * resolution workspace so both draw the same evidence.
 */
export function recoveryCandidateVisualEvidence(
  candidate: RecoveryReviewCandidate,
  selectedId: string,
): VisualSourceEvidence | null {
  if (candidate.proposalVersion === 2) {
    const selected = candidate.selectableCandidates.find((entry) => entry.candidateId === selectedId);
    if (!selected) return null;
    const boxes: VisualSourceBox[] = [
      ...selected.observations.map((observation, memberIndex) => ({
        ...observation, role: 'candidate_member' as const, memberIndex,
      })),
      ...selected.targetContext.map((observation, memberIndex) => ({
        ...observation, role: 'target_row_context' as const, memberIndex,
      })),
      ...candidate.selectableCandidates
        .filter((entry) => entry.candidateId !== selected.candidateId)
        .flatMap((entry) => entry.targetContext.map((observation, memberIndex) => ({
          ...observation, role: 'alternative_candidate' as const, memberIndex,
        }))),
    ];
    return {
      sourceDocumentId: selected.sourceDocumentId,
      sourceArtifactId: selected.sourceArtifactId,
      physicalPageNumber: selected.physicalPageNumber,
      pageRepresentationDigest: selected.pageRepresentationDigest,
      ...(candidate.ocrPixelWidth && candidate.ocrPixelHeight ? {
        ocrPixelWidth: candidate.ocrPixelWidth,
        ocrPixelHeight: candidate.ocrPixelHeight,
      } : {}),
      candidateId: selected.candidateId,
      recoveryType: selected.recoveryType,
      composedRawText: selected.composedRawText,
      boxes,
    };
  }
  if (!candidate.sourceArtifactId || !candidate.pageRepresentationDigest) return null;
  const selected = candidate.selectableObservations.find((entry) => entry.observationId === selectedId);
  if (!selected) return null;
  return {
    sourceDocumentId: candidate.sourceDocumentId,
    sourceArtifactId: candidate.sourceArtifactId,
    physicalPageNumber: candidate.physicalPageNumber,
    pageRepresentationDigest: candidate.pageRepresentationDigest,
    ...(candidate.ocrPixelWidth && candidate.ocrPixelHeight ? {
      ocrPixelWidth: candidate.ocrPixelWidth,
      ocrPixelHeight: candidate.ocrPixelHeight,
    } : {}),
    candidateId: `v1:${selected.observationId}`,
    recoveryType: 'pricing_rate_single_observation',
    composedRawText: selected.rawText,
    boxes: [{ ...selected, role: 'candidate_member', memberIndex: 0 }],
  };
}
