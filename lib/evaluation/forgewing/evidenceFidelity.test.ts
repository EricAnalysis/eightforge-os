import { describe, expect, it } from 'vitest';

import { evaluateProposalEvidence } from '@/lib/evaluation/forgewing/evidenceFidelity';
import type { FrozenRegionArtifact } from '@/lib/evaluation/forgewing/types';
import { ForgewingProposalSchema, type ForgewingProposal } from '@/lib/forgewing/proposal/schema';

const box = {
  coordinateSpace: 'page_normalized' as const,
  origin: 'top_left' as const,
  x0: 0.1,
  y0: 0.2,
  x1: 0.8,
  y1: 0.9,
  rotation: 0 as const,
};

function artifact(overrides: Partial<FrozenRegionArtifact> = {}): FrozenRegionArtifact {
  return {
    artifactId: 'region-1',
    kind: 'region',
    organizationId: 'org-1',
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'source-1',
    extractionSnapshotId: 'snapshot-1',
    pageArtifactId: 'page-1',
    page: 1,
    boundingBox: box,
    rawText: 'Labor rate table',
    physicalPageNumber: 3,
    artifactLocalIndex: 2,
    sourceLayer: 'table_artifact',
    ...overrides,
  };
}

function proposal(overrides: Partial<ForgewingProposal> = {}): ForgewingProposal {
  return ForgewingProposalSchema.parse({
    proposalId: 'proposal-1',
    taskId: 'task-1',
    taskType: 'region_classification',
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'source-1',
    extractionSnapshotId: 'snapshot-1',
    pageArtifactId: 'page-1',
    physicalPageNumber: 3,
    artifactLocalIndex: 2,
    confidence: 0.8,
    inputObservationIds: ['region-1'],
    state: 'observed',
    value: { label: 'table' },
    evidence: [{
      artifactId: 'region-1',
      sourceDocumentId: 'document-1',
      sourceArtifactId: 'source-1',
      pageArtifactId: 'page-1',
      physicalPageNumber: 3,
      artifactLocalIndex: 2,
      sourceLayer: 'table_artifact',
      boundingBox: box,
      rawSpan: 'Labor rate',
    }],
    ...overrides,
  });
}

describe('Forgewing evidence fidelity', () => {
  it('independently validates source identity, physical provenance, geometry, and verbatim span', () => {
    const [finding] = evaluateProposalEvidence({
      proposal: proposal(),
      expectedExtractionSnapshotId: 'snapshot-1',
      sourceArtifacts: [artifact()],
    });
    expect(finding).toMatchObject({
      status: 'valid',
      checks: {
        artifact: 'match',
        sourceDocument: 'match',
        sourceArtifact: 'match',
        extractionSnapshot: 'match',
        pageArtifact: 'match',
        physicalPage: 'match',
        artifactLocalIndex: 'match',
        sourceLayer: 'match',
        geometry: 'match',
        rawSpan: 'match',
      },
    });
  });

  it.each([
    ['unknown artifact', [], 'evidence_artifact_unresolved'],
    ['foreign source artifact', [artifact({ sourceArtifactId: 'source-foreign' })], 'evidence_sourceArtifact_mismatch'],
    ['geometry mismatch', [artifact({ boundingBox: { ...box, x1: 0.7 } })], 'evidence_geometry_mismatch'],
    ['raw span mismatch', [artifact({ rawText: 'Different source text' })], 'evidence_rawSpan_mismatch'],
  ])('marks %s invalid', (_name, sourceArtifacts, diagnostic) => {
    const [finding] = evaluateProposalEvidence({
      proposal: proposal(),
      expectedExtractionSnapshotId: 'snapshot-1',
      sourceArtifacts,
    });
    expect(finding?.status).toBe('invalid');
    expect(finding?.diagnostics).toContain(diagnostic);
  });

  it('marks a claimed span unverifiable when frozen representation lacks source text', () => {
    const [finding] = evaluateProposalEvidence({
      proposal: proposal(),
      expectedExtractionSnapshotId: 'snapshot-1',
      sourceArtifacts: [artifact({ rawText: null })],
    });
    expect(finding?.status).toBe('unverifiable');
    expect(finding?.checks.rawSpan).toBe('unverifiable');
  });

  it('fails closed when a referenced artifact ID is not unique in the frozen set', () => {
    const [finding] = evaluateProposalEvidence({
      proposal: proposal(),
      expectedExtractionSnapshotId: 'snapshot-1',
      sourceArtifacts: [artifact(), artifact({ rawText: 'Conflicting duplicate' })],
    });
    expect(finding).toMatchObject({
      status: 'invalid',
      diagnostics: ['evidence_artifact_identity_ambiguous'],
    });
  });

  it('does not normalize whitespace while checking raw spans', () => {
    const exactWhitespace = proposal({
      evidence: [{
        ...proposal().evidence[0]!,
        rawSpan: 'Labor rate',
      }],
    });
    expect(evaluateProposalEvidence({
      proposal: exactWhitespace,
      expectedExtractionSnapshotId: 'snapshot-1',
      sourceArtifacts: [artifact({ rawText: 'Labor rate table' })],
    })[0]?.status).toBe('valid');
    expect(evaluateProposalEvidence({
      proposal: exactWhitespace,
      expectedExtractionSnapshotId: 'snapshot-1',
      sourceArtifacts: [artifact({ rawText: 'Labor  rate  table' })],
    })[0]?.status).toBe('invalid');
  });
});
