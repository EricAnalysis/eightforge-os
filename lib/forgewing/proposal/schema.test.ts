import { describe, expect, it } from 'vitest';

import {
  ForgewingProposalBundleSchema,
  ForgewingProposalSchema,
} from '@/lib/forgewing/proposal/schema';
import {
  assertForgewingProposalIsNonAuthoritative,
  assertProposalEvidenceContract,
  hasResolvableProposalEvidence,
} from '@/lib/forgewing/proposal/guards';
import { FORGEWING_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';

const evidence = (artifactId: string) => ({
  artifactId,
  sourceDocumentId: 'document-1',
  sourceArtifactId: 'source-artifact-1',
  pageArtifactId: 'page-artifact-1',
  physicalPageNumber: 1,
  artifactLocalIndex: 0,
  sourceLayer: 'table_artifact' as const,
});

const baseProposal = {
  proposalId: 'proposal-1',
  taskId: 'task-1',
  taskType: 'region_classification' as const,
  sourceDocumentId: 'document-1',
  sourceArtifactId: 'source-artifact-1',
  extractionSnapshotId: 'snapshot-1',
  pageArtifactId: 'page-artifact-1',
  physicalPageNumber: 1,
  artifactLocalIndex: 0,
  inputObservationIds: ['observation-1'],
  confidence: null,
};

const value = { label: 'table' as const };

describe('ForgewingProposalSchema evidence and value contracts', () => {
  it('accepts observed value with evidence', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'observed',
      value,
      evidence: [evidence('observation-1')],
    }).success).toBe(true);
  });

  it('rejects observed value without evidence', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'observed',
      value,
      evidence: [],
    }).success).toBe(false);
  });

  it('rejects observed state without a value', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'observed',
      evidence: [evidence('observation-1')],
    }).success).toBe(false);
  });

  it('accepts inferred value with evidence and rejects missing evidence', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'inferred',
      value,
      evidence: [evidence('observation-1')],
    }).success).toBe(true);
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'inferred',
      value,
      evidence: [],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'inferred',
      evidence: [evidence('observation-1')],
    }).success).toBe(false);
  });

  it('accepts ambiguous state with two evidence refs and no value', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      inputObservationIds: ['observation-1', 'observation-2'],
      state: 'ambiguous',
      evidence: [evidence('observation-1'), evidence('observation-2')],
    }).success).toBe(true);
  });

  it('rejects ambiguous state with a value or only one evidence ref', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      inputObservationIds: ['observation-1', 'observation-2'],
      state: 'ambiguous',
      value,
      evidence: [evidence('observation-1'), evidence('observation-2')],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'ambiguous',
      evidence: [evidence('observation-1')],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'ambiguous',
      evidence: [evidence('observation-1'), evidence('observation-1')],
    }).success).toBe(false);
  });

  it('allows distinct competing citations within one input artifact', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'ambiguous',
      evidence: [
        { ...evidence('observation-1'), rawSpan: 'Table heading' },
        { ...evidence('observation-1'), rawSpan: 'Continuation heading' },
      ],
    }).success).toBe(true);
  });

  it('accepts unresolved state with evidence and no value', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'unresolved',
      evidence: [evidence('observation-1')],
    }).success).toBe(true);
  });

  it('rejects unresolved state with a value', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'unresolved',
      value,
      evidence: [evidence('observation-1')],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'unresolved',
      evidence: [],
    }).success).toBe(false);
  });

  it('accepts conflicting state with two evidence refs and no value', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      inputObservationIds: ['observation-1', 'observation-2'],
      state: 'conflicting',
      evidence: [evidence('observation-1'), evidence('observation-2')],
    }).success).toBe(true);
  });

  it('rejects conflicting state with a value or only one evidence ref', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      inputObservationIds: ['observation-1', 'observation-2'],
      state: 'conflicting',
      value,
      evidence: [evidence('observation-1'), evidence('observation-2')],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'conflicting',
      evidence: [evidence('observation-1')],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'conflicting',
      evidence: [evidence('observation-1'), evidence('observation-1')],
    }).success).toBe(false);
  });

  it('accepts insufficient evidence with a non-empty missing-evidence list', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'insufficient_evidence',
      inputObservationIds: [],
      pageArtifactId: undefined,
      physicalPageNumber: undefined,
      artifactLocalIndex: undefined,
      evidence: [],
      missingEvidence: [{ code: 'insufficient_table_context' }],
    }).success).toBe(true);
  });

  it('rejects insufficient evidence with a value or empty missing-evidence list', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'insufficient_evidence',
      inputObservationIds: [],
      pageArtifactId: undefined,
      physicalPageNumber: undefined,
      artifactLocalIndex: undefined,
      value,
      evidence: [],
      missingEvidence: [{ code: 'insufficient_table_context' }],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'insufficient_evidence',
      inputObservationIds: [],
      pageArtifactId: undefined,
      physicalPageNumber: undefined,
      artifactLocalIndex: undefined,
      evidence: [],
      missingEvidence: [],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...baseProposal,
      state: 'insufficient_evidence',
      evidence: [evidence('observation-1'), evidence('observation-1')],
      missingEvidence: [{ code: 'conflicting_observations' }],
    }).success).toBe(false);
  });
});

describe('ForgewingProposalSchema metadata contract', () => {
  const proposal = {
    ...baseProposal,
    state: 'observed' as const,
    value,
    evidence: [evidence('observation-1')],
  };

  it('accepts explicit null or numeric confidence without defaulting', () => {
    expect(ForgewingProposalSchema.parse(proposal).confidence).toBeNull();
    expect(ForgewingProposalSchema.parse({ ...proposal, confidence: 0 }).confidence).toBe(0);
    expect(ForgewingProposalSchema.parse({ ...proposal, confidence: 1 }).confidence).toBe(1);
  });

  it('rejects missing and out-of-range confidence', () => {
    const { confidence: _confidence, ...withoutConfidence } = proposal;
    void _confidence;
    expect(ForgewingProposalSchema.safeParse(withoutConfidence).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({ ...proposal, confidence: -0.01 }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({ ...proposal, confidence: 1.01 }).success).toBe(false);
  });

  it('accepts bounded rationale and rejects oversized rationale', () => {
    expect(ForgewingProposalSchema.safeParse({ ...proposal, rationale: 'Evidence is localized to the observed region.' }).success).toBe(true);
    expect(ForgewingProposalSchema.safeParse({ ...proposal, rationale: 'x'.repeat(401) }).success).toBe(false);
  });

  it('rejects unexpected model-style fields', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...proposal,
      chainOfThought: ['hidden'],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...proposal,
      evidence: [{ ...evidence('observation-1'), recognitionConfidence: 0.9 }],
    }).success).toBe(false);
  });

  it('rejects undeclared or contradictory evidence provenance', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...proposal,
      evidence: [evidence('observation-2')],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...proposal,
      evidence: [{ ...evidence('observation-1'), physicalPageNumber: 2 }],
    }).success).toBe(false);
  });

  it('rejects unbound physical-page claims and degenerate geometry', () => {
    expect(ForgewingProposalSchema.safeParse({
      ...proposal,
      evidence: [{ artifactId: 'observation-1', physicalPageNumber: 1, sourceLayer: 'legacy' }],
    }).success).toBe(false);
    expect(ForgewingProposalSchema.safeParse({
      ...proposal,
      evidence: [{
        ...evidence('observation-1'),
        boundingBox: {
          coordinateSpace: 'page_normalized',
          origin: 'top_left',
          x0: 0.5,
          y0: 0.1,
          x1: 0.5,
          y1: 0.2,
          rotation: 0,
        },
      }],
    }).success).toBe(false);
  });
});

describe('ForgewingProposalBundleSchema', () => {
  const proposal = {
    ...baseProposal,
    state: 'observed' as const,
    value,
    evidence: [evidence('observation-1')],
  };
  const bundle = {
    schemaVersion: FORGEWING_PROPOSAL_SCHEMA_VERSION,
    authority: 'non_authoritative' as const,
    taskId: 'task-1',
    taskType: 'region_classification' as const,
    proposals: [proposal],
  };

  it('accepts the explicit version and non-authoritative seal', () => {
    expect(ForgewingProposalBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('rejects invalid or missing versions', () => {
    expect(ForgewingProposalBundleSchema.safeParse({
      ...bundle,
      schemaVersion: 'forgewing-proposal-v2',
    }).success).toBe(false);
    const { schemaVersion: _schemaVersion, ...withoutVersion } = bundle;
    void _schemaVersion;
    expect(ForgewingProposalBundleSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('rejects authority vocabulary and unknown envelope fields', () => {
    expect(ForgewingProposalBundleSchema.safeParse({
      ...bundle,
      authority: 'canonical',
    }).success).toBe(false);
    expect(ForgewingProposalBundleSchema.safeParse({
      ...bundle,
      approved: true,
    }).success).toBe(false);
  });

  it('rejects proposals whose task identity differs from the bundle', () => {
    expect(ForgewingProposalBundleSchema.safeParse({
      ...bundle,
      proposals: [{ ...proposal, taskId: 'task-2' }],
    }).success).toBe(false);
  });
});

describe('Forgewing proposal guards', () => {
  it('recognizes coherent evidence and asserts the non-authoritative contract', () => {
    const proposal = ForgewingProposalSchema.parse({
      ...baseProposal,
      state: 'observed',
      value,
      evidence: [evidence('observation-1')],
    });
    const bundle = ForgewingProposalBundleSchema.parse({
      schemaVersion: FORGEWING_PROPOSAL_SCHEMA_VERSION,
      authority: 'non_authoritative',
      taskId: 'task-1',
      taskType: 'region_classification',
      proposals: [proposal],
    });

    expect(hasResolvableProposalEvidence(proposal)).toBe(true);
    expect(() => assertProposalEvidenceContract(proposal)).not.toThrow();
    expect(() => assertForgewingProposalIsNonAuthoritative(bundle)).not.toThrow();
  });

  it('does not call an empty abstention evidence set resolvable', () => {
    const abstention = ForgewingProposalSchema.parse({
      ...baseProposal,
      inputObservationIds: [],
      pageArtifactId: undefined,
      physicalPageNumber: undefined,
      artifactLocalIndex: undefined,
      state: 'insufficient_evidence',
      evidence: [],
      missingEvidence: [{ code: 'missing_source_observation' }],
    });
    expect(hasResolvableProposalEvidence(abstention)).toBe(false);
    expect(() => assertProposalEvidenceContract(abstention)).not.toThrow();
  });
});
