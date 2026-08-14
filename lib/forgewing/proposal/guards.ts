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
      && (reference.pageArtifactId == null
        || reference.pageArtifactId === proposal.pageArtifactId)
      && (reference.physicalPageNumber == null
        || reference.physicalPageNumber === proposal.physicalPageNumber)
      && (reference.artifactLocalIndex == null
        || reference.artifactLocalIndex === proposal.artifactLocalIndex)
    ));
}

export function assertProposalEvidenceContract(proposal: ForgewingProposal): void {
  const hasValue = 'value' in proposal;
  const minimumEvidence = proposal.state === 'ambiguous' || proposal.state === 'conflicting'
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
  if ((proposal.state === 'observed' || proposal.state === 'inferred') !== hasValue) {
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
