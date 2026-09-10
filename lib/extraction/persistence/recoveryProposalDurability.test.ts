import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/forgewing/tasks/pricingRateClusterRecovery', () => ({
  runForgewingPricingRateClusterRecovery: vi.fn(),
}));
vi.mock('@/lib/forgewing/runtime/modelConfig', () => ({
  isForgewingShadowEnabled: () => true,
  isForgewingColumnMappingEnabled: () => false,
  isForgewingTableContinuationEnabled: () => false,
  isForgewingObservationArbitrationEnabled: () => false,
  isForgewingPricingRateClusterRecoveryEnabled: () => true,
  isForgewingPricingInterpretationEnabled: () => false,
  isForgewingRegionClassificationEnabled: () => false,
}));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { scheduleForgewingPricingRateClusterRecoveryShadow }
  from '@/lib/extraction/persistence/complianceShadow';

/**
 * The TTL hazard, closed.
 *
 * A recovery proposal used to exist only as a storage blob with a five-day
 * lifetime. A human review pins a proposal, so if the proposal could expire the
 * review would be pinned to nothing. These tests prove the durable record is
 * written independently of the blob: a blob that fails, or one that is later
 * swept by cleanup, leaves the reviewable proposal intact.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ART = '33333333-3333-4333-8333-333333333333';
const HASH32 = 'a'.repeat(32);

function observationRow(id: string, rawText: string, x: number) {
  return {
    id,
    source_document_id: DOC, source_artifact_id: ART,
    physical_page_number: 2, source_method: 'pdfjs', raw_text: rawText,
    physical_page_coordinate: {
      mappingState: 'resolved_physical_page', sourceDocumentId: DOC,
      sourceArtifactId: ART, physicalPageNumber: 2, artifactLocalIndex: 1,
    },
    location: { page: 2, bounding_box: { x_min: x, x_max: x + 10, y_min: 100, y_max: 110 } },
  };
}

function shadowInput() {
  return {
    organizationId: ORG,
    sourceDocumentId: DOC,
    sourceArtifactId: ART,
    extractionSnapshotId: 'snapshot-1',
    pricingRows: [{
      row_id: 'row-1', page: 2, source_anchor_ids: ['evidence-1'],
      raw_text: 'Candidate service | CY | $12.00', confidence: 'needs_review',
    }],
    sourceObservations: [{
      id: 'evidence-1', kind: 'table_row', source_type: 'pdf',
      description: 'Source rate row', text: 'Candidate service | CY | $12.00',
      value: null, location: { page: 2 }, confidence: 0.8, weak: false,
      source_document_id: DOC,
      physical_page_coordinate: {
        sourceDocumentId: DOC, sourceArtifactId: ART,
        sourceLayer: 'pdf_native_text', artifactLocalIndex: 1,
        physicalPageNumber: 2, mappingState: 'resolved_physical_page',
        mappingBasis: 'extractor_iterated_physical_page', legacyPageValue: null,
        totalPhysicalPages: 3,
      },
    }],
    pricingSourceEligibility: {
      sourceDocumentId: DOC, sourceArtifactId: ART, pageScopeApplicable: true,
      scope: { kind: 'authoritative', authoritativePages: [2] },
      observations: [{
        observationId: 'evidence-1', sourceDocumentId: DOC, sourceArtifactId: ART,
        physicalPageNumber: 2, eligibility: 'canonical_eligible',
        reason: 'authoritative_scope_match',
      }],
    },
    pricingRecoveryDiagnostics: [{
      reason: 'ambiguous_rate_clusters', physicalPageNumber: 2,
      observations: [
        observationRow('description-1', 'Candidate service', 10),
        observationRow('rate-1', '$12.00', 50),
        observationRow('rate-2', '120', 70),
      ],
    }],
    env: {
      FORGEWING_SHADOW_ENABLED: '1',
      FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED: '1',
    },
  };
}

function evidence() {
  return [
    { observationId: 'description-1', sourceDocumentId: DOC, sourceArtifactId: ART,
      physicalPageNumber: 2, artifactLocalIndex: 1, sourceLayer: 'pdf_native_text' as const,
      rawText: 'Candidate service', boundingBox: { xMin: 10, xMax: 20, yMin: 100, yMax: 110 } },
    { observationId: 'rate-1', sourceDocumentId: DOC, sourceArtifactId: ART,
      physicalPageNumber: 2, artifactLocalIndex: 1, sourceLayer: 'pdf_native_text' as const,
      rawText: '$12.00', boundingBox: { xMin: 50, xMax: 60, yMin: 100, yMax: 110 } },
    { observationId: 'rate-2', sourceDocumentId: DOC, sourceArtifactId: ART,
      physicalPageNumber: 2, artifactLocalIndex: 1, sourceLayer: 'pdf_native_text' as const,
      rawText: '120', boundingBox: { xMin: 70, xMax: 80, yMin: 100, yMax: 110 } },
  ];
}

function recoveryResult() {
  return {
    status: 'requires_human_review' as const,
    bundle: {
      schemaVersion: 'forgewing-pricing-rate-cluster-recovery-v1',
      authority: 'non_authoritative',
      run: {
        runId: `forgewing-run-pricing-rate-cluster-${HASH32}`, organizationId: ORG,
        extractionSnapshotId: 'snapshot-1', inputSnapshotHash: 'b'.repeat(64),
      },
      taskId: `forgewing-task-pricing-rate-cluster-${HASH32}`,
      taskType: 'pricing_rate_cluster_recovery',
      proposals: [{
        proposalId: `forgewing-proposal-pricing-rate-cluster-${HASH32}`,
        taskId: `forgewing-task-pricing-rate-cluster-${HASH32}`,
        taskType: 'pricing_rate_cluster_recovery', status: 'recovered_candidate',
        authority: 'non_authoritative', proposedField: 'rate',
        proposedValue: '$12.00', normalizedValue: '12.00',
        sourceDocumentId: DOC, sourceArtifactId: ART,
        extractionSnapshotId: 'snapshot-1', physicalPageNumber: 2,
        selectedObservationIds: ['rate-1'], alternativeObservationIds: ['rate-2'],
        evidence: evidence(), certainty: 0.5,
        reasonCategory: 'explicit_currency_marker', requiresHumanReview: true,
      }],
      abstentions: [],
    },
    metadata: {
      considered: true, eligibilityReason: 'ambiguous_relationship', providerInvoked: true,
      calls: 1, model: 'fake-local-model',
      promptTemplateId: 'forgewing-pricing-rate-cluster-recovery',
      promptTemplateVersion: 'v1', timeoutMs: 100, maxOutputTokens: 100,
      deterministicValidationSuccessful: true, humanReviewRequired: true,
    },
  };
}

async function schedule(dependencies: Record<string, unknown>) {
  const registered: Array<() => Promise<void>> = [];
  scheduleForgewingPricingRateClusterRecoveryShadow(shadowInput() as never, {
    register: (task: () => Promise<void>) => registered.push(task),
    run: (async () => recoveryResult()) as never,
    ...dependencies,
  } as never);
  expect(registered).toHaveLength(1);
  await registered[0]!();
}

describe('durable recovery proposal survives the shadow blob', () => {
  it('records the durable proposal alongside a successful blob', async () => {
    const persistProposal = vi.fn(async () => ({
      status: 'persisted' as const, proposalRowId: DOC,
      proposalDigestSha256: 'd'.repeat(64), inserted: true,
    }));
    await schedule({
      persist: async () => ({ status: 'persisted', path: 'forgewing/shadow/blob.json.gz' }),
      persistProposal,
    });
    expect(persistProposal).toHaveBeenCalledOnce();
    const written = (persistProposal.mock.calls as unknown as unknown[][])[0]![0] as unknown as Record<string, unknown>;
    expect(written).toMatchObject({
      organizationId: ORG, sourceDocumentId: DOC, sourceArtifactId: ART,
      selectedObservationId: 'rate-1', proposedValue: '$12.00',
      authority: 'non_authoritative', requiresHumanReview: true,
      // The blob path is recorded as a diagnostic pointer only.
      shadowArtifactPath: 'forgewing/shadow/blob.json.gz',
    });
  });

  it('records the durable proposal even when the blob write fails', async () => {
    const persistProposal = vi.fn(async () => ({
      status: 'persisted' as const, proposalRowId: DOC,
      proposalDigestSha256: 'd'.repeat(64), inserted: true,
    }));
    await schedule({
      persist: async () => ({ status: 'failed', reason: 'upload_failed', warningCode: 'x' }),
      persistProposal,
    });
    expect(persistProposal).toHaveBeenCalledOnce();
    // No blob, and therefore no pointer -- but a fully reviewable proposal.
    expect(((persistProposal.mock.calls as unknown as unknown[][])[0]![0] as unknown as Record<string, unknown>)
      .shadowArtifactPath).toBeNull();
  });

  it('marks only the monetary candidates selectable for a later modified review', async () => {
    const persistProposal = vi.fn(async () => ({
      status: 'persisted' as const, proposalRowId: DOC,
      proposalDigestSha256: 'd'.repeat(64), inserted: true,
    }));
    await schedule({
      persist: async () => ({ status: 'persisted', path: 'forgewing/shadow/blob.json.gz' }),
      persistProposal,
    });
    const written = (persistProposal.mock.calls as unknown as unknown[][])[0]![0] as unknown as {
      evidence: Array<{ observationId: string; eligible: boolean }>;
    };
    expect(written.evidence.filter((entry) => entry.eligible).map((entry) => entry.observationId))
      .toEqual(['rate-1', 'rate-2']);
  });

  it('does not write a durable proposal when no review is required', async () => {
    const persistProposal = vi.fn();
    const registered: Array<() => Promise<void>> = [];
    scheduleForgewingPricingRateClusterRecoveryShadow(shadowInput() as never, {
      register: (task: () => Promise<void>) => registered.push(task),
      run: (async () => ({
        status: 'deterministic_validation_failed', reason: 'proposal_value_validation_failed',
        metadata: recoveryResult().metadata,
      })) as never,
      persistProposal: persistProposal as never,
    } as never);
    await registered[0]!();
    expect(persistProposal).not.toHaveBeenCalled();
  });
});
