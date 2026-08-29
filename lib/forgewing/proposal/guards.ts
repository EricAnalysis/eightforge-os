import type { ForgewingProposal, ForgewingProposalBundle } from '@/lib/forgewing/proposal/schema';

export function hasResolvableProposalEvidence(proposal: ForgewingProposal): boolean {
  const inputIds = new Set(proposal.inputObservationIds);
  return proposal.evidence.length > 0
    && proposal.evidence.every((reference) => (
      inputIds.has(reference.artifactId)
      && (reference.sourceDocumentId == null
        || reference.sourceDocumentId === proposal.sourceDocumentId)
      && (reference.sourceArtifactId == null
        || reference.sourceArtifactId === proposal.sourceArtifactId)
      && (proposal.taskType === 'region_classification'
        ? (
            (reference.pageArtifactId == null
              || reference.pageArtifactId === proposal.pageArtifactId)
            && (reference.physicalPageNumber == null
              || reference.physicalPageNumber === proposal.physicalPageNumber)
            && (reference.artifactLocalIndex == null
              || reference.artifactLocalIndex === proposal.artifactLocalIndex)
          )
        : proposal.taskType === 'table_continuation'
          ? (
            reference.pageArtifactId === proposal.priorPageArtifactId
              ? (
                  (reference.physicalPageNumber == null
                    || reference.physicalPageNumber === proposal.priorPhysicalPageNumber)
                )
              : reference.pageArtifactId === proposal.nextPageArtifactId
                && (reference.physicalPageNumber == null
                  || reference.physicalPageNumber === proposal.nextPhysicalPageNumber)
          )
          : proposal.taskType === 'column_mapping'
            ? (
              (reference.pageArtifactId == null
                || reference.pageArtifactId === proposal.pageArtifactId)
              && (reference.physicalPageNumber == null
                || proposal.physicalPageNumber == null
                || reference.physicalPageNumber === proposal.physicalPageNumber)
            )
            : (
                reference.pageArtifactId === proposal.pageArtifactId
                && (reference.physicalPageNumber == null
                  || proposal.physicalPageNumber == null
                  || reference.physicalPageNumber === proposal.physicalPageNumber)
              ))
    ));
}

export function assertProposalEvidenceContract(proposal: ForgewingProposal): void {
  const hasResolvedValue = proposal.taskType === 'region_classification'
    ? 'value' in proposal
    : proposal.taskType === 'table_continuation'
      ? 'relation' in proposal && proposal.relation !== 'ambiguous'
      : proposal.taskType === 'column_mapping'
        ? proposal.columnMappings.some(
          (mapping) => mapping.state === 'observed' || mapping.state === 'inferred',
        )
        : proposal.state === 'inferred';
  const minimumEvidence = proposal.taskType === 'observation_arbitration'
    && proposal.state === 'inferred'
    ? 2
    : proposal.state === 'ambiguous' || proposal.state === 'conflicting'
    ? 2
    : proposal.state === 'insufficient_evidence'
      ? 0
      : 1;

  if (proposal.evidence.length < minimumEvidence) {
    throw new Error(`Forgewing ${proposal.state} proposal has insufficient evidence references`);
  }
  if (
    new Set(proposal.evidence.map((reference) => JSON.stringify(reference))).size
    !== proposal.evidence.length
  ) {
    throw new Error(`Forgewing ${proposal.state} proposal repeats an evidence reference`);
  }
  if (proposal.evidence.length > 0 && !hasResolvableProposalEvidence(proposal)) {
    throw new Error(`Forgewing ${proposal.state} proposal cites undeclared or conflicting evidence`);
  }
  if (proposal.taskType === 'column_mapping') {
    if (
      (proposal.state === 'observed' || proposal.state === 'inferred')
      && !hasResolvedValue
    ) {
      throw new Error(`Forgewing ${proposal.state} proposal violates its value contract`);
    }
    if (proposal.state === 'insufficient_evidence' && hasResolvedValue) {
      throw new Error(`Forgewing ${proposal.state} proposal violates its value contract`);
    }
  } else if (proposal.taskType === 'observation_arbitration') {
    if ((proposal.state === 'inferred') !== hasResolvedValue) {
      throw new Error(`Forgewing ${proposal.state} proposal violates its value contract`);
    }
  } else if (
    (proposal.state === 'observed' || proposal.state === 'inferred') !== hasResolvedValue
  ) {
    throw new Error(`Forgewing ${proposal.state} proposal violates its value contract`);
  }
  if (
    proposal.state === 'insufficient_evidence'
    && proposal.missingEvidence.length === 0
  ) {
    throw new Error('Forgewing insufficient_evidence proposal must describe missing evidence');
  }
}

export function assertForgewingProposalIsNonAuthoritative(
  bundle: ForgewingProposalBundle,
): void {
  if (bundle.authority !== 'non_authoritative') {
    throw new Error('Forgewing output must remain non-authoritative');
  }
}
