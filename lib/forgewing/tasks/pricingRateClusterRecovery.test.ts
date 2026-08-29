import { describe, expect, it, vi } from 'vitest';

import {
  runForgewingPricingRateClusterRecovery,
  type ForgewingPricingRateClusterRecoveryInput,
} from '@/lib/forgewing/tasks/pricingRateClusterRecovery';

const config = {
  enabled: true,
  model: 'fake-local-model',
  timeoutMs: 1_000,
  maxCalls: 1,
  maxOutputTokens: 800,
} as const;

function input(): ForgewingPricingRateClusterRecoveryInput {
  const common = {
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'artifact-1',
    physicalPageNumber: 7,
    artifactLocalIndex: 6,
    sourceLayer: 'pdf_native_text' as const,
  };
  return {
    organizationId: 'organization-1',
    sourceDocumentId: common.sourceDocumentId,
    sourceArtifactId: common.sourceArtifactId,
    extractionSnapshotId: 'snapshot-1',
    physicalPageNumber: common.physicalPageNumber,
    recoveryTaskType: 'pricing_rate_cluster_recovery',
    eligibilityReason: 'ambiguous_relationship',
    diagnosticReason: 'ambiguous_rate_clusters',
    observations: [
      { ...common, observationId: 'description-1', rawText: 'Candidate service',
        boundingBox: { xMin: 10, xMax: 30, yMin: 100, yMax: 110 } },
      { ...common, observationId: 'rate-1', rawText: '$12.00',
        boundingBox: { xMin: 50, xMax: 60, yMin: 100, yMax: 110 } },
      { ...common, observationId: 'rate-2', rawText: '120',
        boundingBox: { xMin: 70, xMax: 80, yMin: 100, yMax: 110 } },
    ],
  };
}

function validProvider() {
  return vi.fn(async (request: { inputJson: string }) => {
    const parsed = JSON.parse(request.inputJson) as { candidateId: string };
    return JSON.stringify({
      candidateId: parsed.candidateId,
      proposedRawValue: '$12.00',
      proposedNormalizedValue: '12.00',
      selectedObservationIds: ['rate-1'],
      alternativeObservationIds: ['rate-2'],
      confidence: 0.61,
      rationaleCode: 'explicit_currency_marker',
    });
  });
}

describe('Forgewing pricing rate-cluster recovery V1', () => {
  it('does not invoke recovery when no deterministic diagnostic exists', async () => {
    const provider = validProvider();
    await expect(runForgewingPricingRateClusterRecovery(null, {
      config, taskEnabled: true, provider,
    })).resolves.toEqual({ status: 'not_needed', reason: 'no_ambiguous_rate_clusters' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('reports eligible_not_executed while default-off without touching the provider', async () => {
    const provider = validProvider();
    const result = await runForgewingPricingRateClusterRecovery(input(), {
      config: { ...config, enabled: false }, taskEnabled: false, provider,
    });
    expect(result).toMatchObject({ status: 'eligible_not_executed', reason: 'recovery_disabled',
      metadata: { providerInvoked: false, calls: 0 } });
    expect(provider).not.toHaveBeenCalled();
  });

  it('creates a provenance-bound non-authoritative candidate that requires review', async () => {
    const provider = validProvider();
    const canonicalTruth = Object.freeze({ acceptedRate: null, facts: Object.freeze([]) });
    const before = JSON.stringify(canonicalTruth);
    const result = await runForgewingPricingRateClusterRecovery(input(), {
      config, taskEnabled: true, provider,
    });

    expect(result).toMatchObject({
      status: 'requires_human_review',
      metadata: {
        providerInvoked: true, calls: 1, deterministicValidationSuccessful: true,
        humanReviewRequired: true,
      },
      bundle: {
        authority: 'non_authoritative',
        taskType: 'pricing_rate_cluster_recovery',
        proposals: [{
          status: 'recovered_candidate', authority: 'non_authoritative',
          proposedField: 'rate', proposedValue: '$12.00', normalizedValue: '12.00',
          sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1',
          extractionSnapshotId: 'snapshot-1', physicalPageNumber: 7,
          selectedObservationIds: ['rate-1'], alternativeObservationIds: ['rate-2'],
          requiresHumanReview: true,
        }],
      },
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(JSON.stringify(canonicalTruth)).toBe(before);
  });

  it('fails closed on foreign input identity before provider execution', async () => {
    const provider = validProvider();
    const foreign = input();
    foreign.observations[0] = { ...foreign.observations[0]!, sourceArtifactId: 'foreign' };
    const result = await runForgewingPricingRateClusterRecovery(foreign, {
      config, taskEnabled: true, provider,
    });
    expect(result).toMatchObject({ status: 'evidence_binding_failed',
      reason: 'input_identity_closure_failed' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('classifies malformed output and provider failures without producing proposals', async () => {
    const malformed = await runForgewingPricingRateClusterRecovery(input(), {
      config, taskEnabled: true, provider: async () => '{not json',
    });
    expect(malformed).toMatchObject({ status: 'structured_output_invalid',
      reason: 'invalid_model_json' });

    const failed = await runForgewingPricingRateClusterRecovery(input(), {
      config, taskEnabled: true, provider: async () => { throw new Error('provider_timeout'); },
    });
    expect(failed).toMatchObject({ status: 'provider_failed', reason: 'provider_timeout' });
  });

  it('rejects unknown evidence and provider-authored normalization', async () => {
    const unknown = await runForgewingPricingRateClusterRecovery(input(), {
      config, taskEnabled: true, provider: async (request) => JSON.stringify({
        candidateId: (JSON.parse(request.inputJson) as { candidateId: string }).candidateId,
        proposedRawValue: '$12.00', proposedNormalizedValue: '12.00',
        selectedObservationIds: ['foreign-rate'], alternativeObservationIds: ['rate-2'],
        confidence: 0.5, rationaleCode: 'numeric_rate_pattern',
      }),
    });
    expect(unknown).toMatchObject({ status: 'evidence_binding_failed',
      reason: 'unknown_evidence_reference' });

    const altered = await runForgewingPricingRateClusterRecovery(input(), {
      config, taskEnabled: true, provider: async (request) => JSON.stringify({
        candidateId: (JSON.parse(request.inputJson) as { candidateId: string }).candidateId,
        proposedRawValue: '$12.00', proposedNormalizedValue: '1200.00',
        selectedObservationIds: ['rate-1'], alternativeObservationIds: ['rate-2'],
        confidence: 0.5, rationaleCode: 'numeric_rate_pattern',
      }),
    });
    expect(altered).toMatchObject({ status: 'deterministic_validation_failed',
      reason: 'proposal_value_validation_failed' });
  });

  it('preserves authored nonnumeric "$ -" as evidence rather than a normalized rate', async () => {
    const nonnumeric = input();
    nonnumeric.observations[1] = { ...nonnumeric.observations[1]!, rawText: '$ -' };
    const provider = validProvider();
    const result = await runForgewingPricingRateClusterRecovery(nonnumeric, {
      config, taskEnabled: true, provider,
    });
    expect(result).toMatchObject({ status: 'deterministic_validation_failed',
      reason: 'fewer_than_two_distinct_monetary_candidates' });
    expect(provider).not.toHaveBeenCalled();
  });
});
