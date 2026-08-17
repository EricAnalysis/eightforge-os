import { describe, expect, it } from 'vitest';

import {
  ForgewingObservationArbitrationProposalBundleSchema,
} from '@/lib/forgewing/proposal/schema';

const HASH = 'a'.repeat(64);
const evidence = (artifactId: string) => ({
  artifactId,
  sourceDocumentId: 'document-1',
  sourceArtifactId: 'artifact-1',
  pageArtifactId: 'page-1',
  boundingBox: {
    coordinateSpace: 'page_normalized' as const,
    origin: 'top_left' as const,
    x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2, rotation: 0 as const,
  },
  rawSpan: artifactId === 'candidate-a' ? 'Item 1 | Debris Removal' : 'Item 1 | Debris Removal | CY',
});

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'forgewing-observation-arbitration-proposal-v1',
    authority: 'non_authoritative',
    run: {
      runId: 'run-1', organizationId: 'organization-1', extractionSnapshotId: 'snapshot-1',
      inputSnapshotHash: HASH,
    },
    taskId: 'task-1',
    taskType: 'observation_arbitration',
    proposals: [{
      proposalId: 'proposal-1', taskId: 'task-1', taskType: 'observation_arbitration',
      sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1',
      extractionSnapshotId: 'snapshot-1', targetId: 'decision-1',
      deterministicState: 'conflict', candidateAId: 'candidate-a', candidateBId: 'candidate-b',
      pageArtifactId: 'page-1', inputObservationIds: ['candidate-a', 'candidate-b'],
      state: 'inferred', relation: 'preserve_both', confidence: 0.7,
      rationaleCodes: ['complementary_fragments'],
      evidence: [evidence('candidate-a'), evidence('candidate-b')],
      ...overrides,
    }],
    abstentions: [],
  };
}

describe('Forgewing observation arbitration proposal schema', () => {
  it('keeps preserve-both and genuine conflict distinct without a preferred candidate', () => {
    expect(ForgewingObservationArbitrationProposalBundleSchema.parse(bundle())
      .proposals[0]).toMatchObject({ relation: 'preserve_both' });
    expect(ForgewingObservationArbitrationProposalBundleSchema.parse(bundle({
      relation: 'genuinely_conflicting', rationaleCodes: ['value_conflict'],
    })).proposals[0]).toMatchObject({ relation: 'genuinely_conflicting' });
  });

  it('requires a slot-consistent known preferred candidate and evidence from both sides', () => {
    expect(ForgewingObservationArbitrationProposalBundleSchema.safeParse(bundle({
      relation: 'prefer_candidate_a', preferredCandidateId: 'candidate-b',
    })).success).toBe(false);
    expect(ForgewingObservationArbitrationProposalBundleSchema.safeParse(bundle({
      evidence: [evidence('candidate-a'), evidence('unknown')],
    })).success).toBe(false);
  });

  it('represents insufficient evidence without a fabricated relation or citation', () => {
    const insufficient = bundle({
      state: 'insufficient_evidence', confidence: null, evidence: [],
      rationaleCodes: ['insufficient_structure'],
      missingEvidence: [{ code: 'missing_source_observation' }],
    });
    delete (insufficient.proposals[0] as Record<string, unknown>).relation;
    expect(ForgewingObservationArbitrationProposalBundleSchema.parse(insufficient)
      .proposals[0]).toMatchObject({ state: 'insufficient_evidence', evidence: [] });
  });

  it('seals every bundle to exactly one target outcome', () => {
    const twoProposals = bundle();
    twoProposals.proposals.push({ ...twoProposals.proposals[0]!, proposalId: 'proposal-2' });
    expect(ForgewingObservationArbitrationProposalBundleSchema.safeParse(twoProposals).success)
      .toBe(false);

    const mixed = bundle();
    mixed.abstentions.push({
      taskId: 'task-1', taskType: 'observation_arbitration', sourceDocumentId: 'document-1',
      sourceArtifactId: 'artifact-1', extractionSnapshotId: 'snapshot-1',
      inputObservationIds: ['candidate-a', 'candidate-b'], reason: 'runtime_unavailable',
    } as never);
    expect(ForgewingObservationArbitrationProposalBundleSchema.safeParse(mixed).success).toBe(false);
  });
});
