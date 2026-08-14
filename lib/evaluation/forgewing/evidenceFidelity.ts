import type { ForgewingEvidenceRef, ForgewingProposal } from '@/lib/forgewing/proposal/schema';
import type {
  EvidenceCheckStatus,
  EvidenceFidelityFinding,
  EvidenceFidelityStatus,
  FrozenRegionArtifact,
} from '@/lib/evaluation/forgewing/types';

function claimedMatch<T>(claimed: T | undefined, actual: T | null): EvidenceCheckStatus {
  if (claimed == null) return 'not_claimed';
  if (actual == null) return 'mismatch';
  return claimed === actual ? 'match' : 'mismatch';
}

function requiredClaimMatch<T>(claimed: T | undefined, actual: T | null): EvidenceCheckStatus {
  if (claimed == null) return 'unverifiable';
  if (actual == null) return 'mismatch';
  return claimed === actual ? 'match' : 'mismatch';
}

function sameGeometry(
  claimed: NonNullable<ForgewingEvidenceRef['boundingBox']>,
  actual: FrozenRegionArtifact['boundingBox'],
): boolean {
  return claimed.coordinateSpace === actual.coordinateSpace
    && claimed.origin === actual.origin
    && claimed.x0 === actual.x0
    && claimed.y0 === actual.y0
    && claimed.x1 === actual.x1
    && claimed.y1 === actual.y1
    && claimed.rotation === actual.rotation;
}

function findingStatus(checks: readonly EvidenceCheckStatus[]): EvidenceFidelityStatus {
  if (checks.includes('mismatch')) return 'invalid';
  if (checks.includes('unverifiable')) return 'unverifiable';
  return 'valid';
}

export function evaluateEvidenceReference(params: Readonly<{
  proposal: ForgewingProposal;
  reference: ForgewingEvidenceRef;
  evidenceIndex: number;
  expectedExtractionSnapshotId: string;
  artifactById: ReadonlyMap<string, FrozenRegionArtifact>;
}>): EvidenceFidelityFinding {
  const { proposal, reference } = params;
  const artifact = params.artifactById.get(reference.artifactId);
  if (!artifact) {
    const checks = {
      artifact: 'mismatch',
      sourceDocument: 'unverifiable',
      sourceArtifact: 'unverifiable',
      extractionSnapshot: 'unverifiable',
      pageArtifact: 'unverifiable',
      physicalPage: 'unverifiable',
      artifactLocalIndex: 'unverifiable',
      sourceLayer: 'unverifiable',
      geometry: 'unverifiable',
      rawSpan: 'unverifiable',
    } as const;
    return {
      proposalId: proposal.proposalId,
      evidenceIndex: params.evidenceIndex,
      artifactId: reference.artifactId,
      status: 'invalid',
      checks,
      diagnostics: ['evidence_artifact_unresolved'],
    };
  }

  const checks = {
    artifact: 'match' as const,
    sourceDocument: requiredClaimMatch(reference.sourceDocumentId, artifact.sourceDocumentId),
    sourceArtifact: requiredClaimMatch(reference.sourceArtifactId, artifact.sourceArtifactId),
    extractionSnapshot: artifact.extractionSnapshotId === params.expectedExtractionSnapshotId
      ? 'match' as const
      : 'mismatch' as const,
    pageArtifact: claimedMatch(reference.pageArtifactId, artifact.pageArtifactId),
    physicalPage: claimedMatch(reference.physicalPageNumber, artifact.physicalPageNumber),
    artifactLocalIndex: claimedMatch(reference.artifactLocalIndex, artifact.artifactLocalIndex),
    sourceLayer: claimedMatch(reference.sourceLayer, artifact.sourceLayer),
    geometry: reference.boundingBox == null
      ? 'not_claimed' as const
      : sameGeometry(reference.boundingBox, artifact.boundingBox)
        ? 'match' as const
        : 'mismatch' as const,
    rawSpan: reference.rawSpan == null
      ? 'not_claimed' as const
      : artifact.rawText == null
        ? 'unverifiable' as const
        : artifact.rawText.includes(reference.rawSpan)
          ? 'match' as const
          : 'mismatch' as const,
  };
  const diagnostics = Object.entries(checks)
    .filter(([, status]) => status === 'mismatch' || status === 'unverifiable')
    .map(([name, status]) => `evidence_${name}_${status}`)
    .sort();
  return {
    proposalId: proposal.proposalId,
    evidenceIndex: params.evidenceIndex,
    artifactId: reference.artifactId,
    status: findingStatus(Object.values(checks)),
    checks,
    diagnostics,
  };
}

export function evaluateProposalEvidence(params: Readonly<{
  proposal: ForgewingProposal;
  expectedExtractionSnapshotId: string;
  sourceArtifacts: readonly FrozenRegionArtifact[];
}>): readonly EvidenceFidelityFinding[] {
  const artifactCounts = new Map<string, number>();
  params.sourceArtifacts.forEach((artifact) => {
    artifactCounts.set(artifact.artifactId, (artifactCounts.get(artifact.artifactId) ?? 0) + 1);
  });
  const artifactById = new Map(params.sourceArtifacts.map((artifact) => [artifact.artifactId, artifact]));
  return params.proposal.evidence
    .map((reference, evidenceIndex) => {
      if ((artifactCounts.get(reference.artifactId) ?? 0) > 1) {
        return {
          proposalId: params.proposal.proposalId,
          evidenceIndex,
          artifactId: reference.artifactId,
          status: 'invalid' as const,
          checks: {
            artifact: 'mismatch' as const,
            sourceDocument: 'unverifiable' as const,
            sourceArtifact: 'unverifiable' as const,
            extractionSnapshot: 'unverifiable' as const,
            pageArtifact: 'unverifiable' as const,
            physicalPage: 'unverifiable' as const,
            artifactLocalIndex: 'unverifiable' as const,
            sourceLayer: 'unverifiable' as const,
            geometry: 'unverifiable' as const,
            rawSpan: 'unverifiable' as const,
          },
          diagnostics: ['evidence_artifact_identity_ambiguous'],
        };
      }
      return evaluateEvidenceReference({
        proposal: params.proposal,
        reference,
        evidenceIndex,
        expectedExtractionSnapshotId: params.expectedExtractionSnapshotId,
        artifactById,
      });
    })
    .sort((left, right) => left.evidenceIndex - right.evidenceIndex
      || left.artifactId.localeCompare(right.artifactId));
}
