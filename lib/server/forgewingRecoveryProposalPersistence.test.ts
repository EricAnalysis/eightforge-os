import { describe, expect, it, vi } from 'vitest';

import {
  DurableRecoveryProposalSchema,
  eligibleRecoveryObservationIds,
} from '@/lib/forgewingRecoveryProposal';
import {
  buildDurableRecoveryProposal,
  buildDurableRecoveryProposalV2,
  persistForgewingRecoveryProposal,
  persistForgewingRecoveryProposalV2,
  recoveryProposalDigest,
  RECOVERY_PROPOSAL_WRITE_FUNCTION,
  RECOVERY_PROPOSAL_V2_WRITE_FUNCTION,
} from '@/lib/server/forgewingRecoveryProposalPersistence';
import { buildRecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import type { ForgewingPricingRateClusterRecoveryBundle }
  from '@/lib/forgewing/tasks/pricingRateClusterRecovery';

const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ART = '33333333-3333-4333-8333-333333333333';
const HASH32 = 'a'.repeat(32);

function observation(id: string, rawText: string, x: number) {
  return {
    observationId: id,
    sourceDocumentId: DOC,
    sourceArtifactId: ART,
    physicalPageNumber: 3,
    artifactLocalIndex: 2,
    sourceLayer: 'pdf_native_text' as const,
    rawText,
    boundingBox: { xMin: x, xMax: x + 20, yMin: 100, yMax: 110 },
  };
}

function bundle(overrides: Partial<{
  selected: string; alternatives: string[]; proposedValue: string; normalizedValue: string;
}> = {}): ForgewingPricingRateClusterRecoveryBundle {
  const evidence = [
    observation('pdf:layout-token:v1:aa', '$8.75', 100),
    observation('pdf:layout-token:v1:bb', '$52.50', 300),
    observation('pdf:layout-token:v1:cc', 'Crushed Stone', 20),
  ];
  return {
    schemaVersion: 'forgewing-pricing-rate-cluster-recovery-v1',
    authority: 'non_authoritative',
    run: {
      runId: `forgewing-run-pricing-rate-cluster-${HASH32}`,
      organizationId: ORG,
      extractionSnapshotId: 'snapshot-1',
      inputSnapshotHash: 'b'.repeat(64),
    },
    taskId: `forgewing-task-pricing-rate-cluster-${HASH32}`,
    taskType: 'pricing_rate_cluster_recovery',
    proposals: [{
      proposalId: `forgewing-proposal-pricing-rate-cluster-${HASH32}`,
      taskId: `forgewing-task-pricing-rate-cluster-${HASH32}`,
      taskType: 'pricing_rate_cluster_recovery',
      status: 'recovered_candidate',
      authority: 'non_authoritative',
      proposedField: 'rate',
      proposedValue: overrides.proposedValue ?? '$8.75',
      normalizedValue: overrides.normalizedValue ?? '8.75',
      sourceDocumentId: DOC,
      sourceArtifactId: ART,
      extractionSnapshotId: 'snapshot-1',
      physicalPageNumber: 3,
      selectedObservationIds: [overrides.selected ?? 'pdf:layout-token:v1:aa'],
      alternativeObservationIds: overrides.alternatives ?? ['pdf:layout-token:v1:bb'],
      evidence,
      certainty: 0.82,
      reasonCategory: 'explicit_currency_marker',
      requiresHumanReview: true,
    }],
    abstentions: [],
  } as ForgewingPricingRateClusterRecoveryBundle;
}

const runtime = {
  providerModel: 'claude-test-model',
  promptTemplateId: 'forgewing.pricing_rate_cluster_recovery',
  promptTemplateVersion: 'v1',
};

describe('durable recovery proposal projection', () => {
  it('projects a validated bundle, marking only monetary candidates eligible', () => {
    const proposal = buildDurableRecoveryProposal({ organizationId: ORG, bundle: bundle(), ...runtime });
    expect(proposal).not.toBeNull();
    expect(proposal!.authority).toBe('non_authoritative');
    expect(proposal!.requiresHumanReview).toBe(true);
    expect(proposal!.selectedObservationId).toBe('pdf:layout-token:v1:aa');
    expect(eligibleRecoveryObservationIds(proposal!))
      .toEqual(['pdf:layout-token:v1:aa', 'pdf:layout-token:v1:bb']);
    // The description token is evidence a reviewer can see, never a selection.
    expect(proposal!.evidence.find((e) => e.observationId === 'pdf:layout-token:v1:cc')!.eligible)
      .toBe(false);
  });

  it('carries no shadow blob dependency when the blob was not persisted', () => {
    const proposal = buildDurableRecoveryProposal({ organizationId: ORG, bundle: bundle(), ...runtime });
    expect(proposal!.shadowArtifactPath).toBeNull();
  });

  it('rejects a caller organization outside the recovery run tenant', () => {
    expect(buildDurableRecoveryProposal({
      organizationId: '99999999-9999-4999-8999-999999999999',
      bundle: bundle(),
      ...runtime,
    })).toBeNull();
  });

  it('rejects a proposal whose value disagrees with its selected observation', () => {
    expect(buildDurableRecoveryProposal({
      organizationId: ORG, bundle: bundle({ proposedValue: '$9.99' }), ...runtime,
    })).toBeNull();
  });

  it('rejects a selection outside the cited monetary candidates', () => {
    expect(buildDurableRecoveryProposal({
      organizationId: ORG, bundle: bundle({ selected: 'pdf:layout-token:v1:cc' }), ...runtime,
    })).toBeNull();
  });

  it('rejects an alternative that is not itself a monetary candidate', () => {
    const parsed = DurableRecoveryProposalSchema.safeParse({
      ...buildDurableRecoveryProposal({ organizationId: ORG, bundle: bundle(), ...runtime })!,
      alternativeObservationIds: ['pdf:layout-token:v1:cc'],
    });
    expect(parsed.success).toBe(false);
  });

  it('digests every field a review pins', () => {
    const base = recoveryProposalDigest(bundle());
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(recoveryProposalDigest(bundle({
      selected: 'pdf:layout-token:v1:bb',
      alternatives: ['pdf:layout-token:v1:aa'],
      proposedValue: '$52.50',
      normalizedValue: '52.50',
    }))).not.toBe(base);
  });
});

describe('durable recovery proposal persistence', () => {
  it('writes through the service-role seam and reports idempotent replay', async () => {
    const rpc = vi.fn(async () => ({ data: [{ proposal_row_id: DOC, inserted: false }], error: null }));
    const proposal = buildDurableRecoveryProposal({ organizationId: ORG, bundle: bundle(), ...runtime })!;
    const result = await persistForgewingRecoveryProposal(proposal, { admin: { rpc } });
    expect(result).toEqual({
      status: 'persisted', proposalRowId: DOC,
      proposalDigestSha256: proposal.proposalDigestSha256, inserted: false,
    });
    expect(rpc).toHaveBeenCalledWith(RECOVERY_PROPOSAL_WRITE_FUNCTION, expect.objectContaining({
      p_organization_id: ORG, p_selected_observation_id: 'pdf:layout-token:v1:aa',
      p_proposed_value: '$8.75', p_page_representation_digest: null,
    }));
  });

  it('skips rather than throws when storage is not configured', async () => {
    const proposal = buildDurableRecoveryProposal({ organizationId: ORG, bundle: bundle(), ...runtime })!;
    await expect(persistForgewingRecoveryProposal(proposal, { admin: null }))
      .resolves.toEqual({ status: 'skipped', reason: 'not_configured' });
  });

  it('fails closed on a write error', async () => {
    const proposal = buildDurableRecoveryProposal({ organizationId: ORG, bundle: bundle(), ...runtime })!;
    await expect(persistForgewingRecoveryProposal(proposal, {
      admin: { rpc: async () => ({ data: null, error: { message: 'denied' } }) },
    })).resolves.toEqual({ status: 'failed', reason: 'write_failed' });
  });

  it('refuses an invalid proposal before reaching the database', async () => {
    const rpc = vi.fn();
    const result = await persistForgewingRecoveryProposal(
      { ...buildDurableRecoveryProposal({ organizationId: ORG, bundle: bundle(), ...runtime })!,
        proposalId: 'not-a-recovery-proposal' } as never,
      { admin: { rpc } },
    );
    expect(result).toEqual({ status: 'failed', reason: 'invalid_proposal' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('candidate-based recovery V2 persistence', () => {
  const candidate = buildRecoveryCandidateV2({
    recoveryType: 'pricing_rate_multi_observation_cluster',
    sourceDocumentId: DOC, sourceArtifactId: ART, physicalPageNumber: 3,
    pageRepresentationDigest: 'd'.repeat(64), targetRowIdentity: 'page_priced_schedule:p3:r2',
    orderedObservationIds: ['obs:dollar', 'obs:number'], rawTexts: ['$', '8.75'],
    composedRawText: '$ 8.75',
    evidence: [
      { observationId: 'obs:dollar', sourceLayer: 'pdf_native_text' as const, rawText: '$',
        boundingBox: { xMin: 1, xMax: 2, yMin: 3, yMax: 4 } },
      { observationId: 'obs:number', sourceLayer: 'pdf_native_text' as const, rawText: '8.75',
        boundingBox: { xMin: 2, xMax: 3, yMin: 3, yMax: 4 } },
    ],
  })!;

  it('builds one immutable proposal around pre-built candidates', () => {
    const proposal = buildDurableRecoveryProposalV2({
      organizationId: ORG, extractionSnapshotId: 'snapshot-v2', candidates: [candidate],
      selectedCandidateId: candidate.candidateId, certainty: 0.8,
      reasonCategory: 'whole_cluster', ...runtime,
    });
    expect(proposal).toMatchObject({ proposalVersion: 2, selectedCandidateId: candidate.candidateId,
      authority: 'non_authoritative', requiresHumanReview: true });
  });

  it('writes V2 through its service-role RPC with no observation array supplied by a reviewer', async () => {
    const proposal = buildDurableRecoveryProposalV2({
      organizationId: ORG, extractionSnapshotId: 'snapshot-v2', candidates: [candidate],
      selectedCandidateId: candidate.candidateId, certainty: 0.8,
      reasonCategory: 'whole_cluster', ...runtime,
    })!;
    const rpc = vi.fn(async () => ({ data: [{ proposal_row_id: DOC, inserted: true }], error: null }));
    await expect(persistForgewingRecoveryProposalV2(proposal, { admin: { rpc } }))
      .resolves.toMatchObject({ status: 'persisted', inserted: true });
    expect(rpc).toHaveBeenCalledWith(RECOVERY_PROPOSAL_V2_WRITE_FUNCTION,
      expect.objectContaining({ p_selected_candidate_id: candidate.candidateId,
        p_recovery_candidates: [candidate] }));
  });
});
