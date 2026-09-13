import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { scheduleRecoveryCandidateV2Shadow } from '@/lib/extraction/persistence/complianceShadow';
import { buildRecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';

const SOURCE_DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ARTIFACT_ID = '22222222-2222-4222-8222-222222222222';
const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333';

const continuation = buildRecoveryCandidateV2({
  recoveryType: 'priced_schedule_continuation_attribution',
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourceArtifactId: SOURCE_ARTIFACT_ID,
  physicalPageNumber: 3,
  pageRepresentationDigest: 'a'.repeat(64),
  targetRowIdentity: 'page_priced_schedule:p3:r1',
  orderedObservationIds: ['obs:fragment'],
  rawTexts: ['Disposal'],
  composedRawText: 'Inert Debris Removal and Disposal',
  evidence: [{
    observationId: 'obs:fragment',
    sourceLayer: 'pdf_native_text',
    rawText: 'Disposal',
    boundingBox: { xMin: 1, xMax: 2, yMin: 3, yMax: 4 },
  }],
})!;

const pricingCluster = buildRecoveryCandidateV2({
  recoveryType: 'pricing_rate_multi_observation_cluster',
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourceArtifactId: SOURCE_ARTIFACT_ID,
  physicalPageNumber: 3,
  pageRepresentationDigest: 'a'.repeat(64),
  targetRowIdentity: 'page_priced_schedule:p3:r2',
  orderedObservationIds: ['obs:rate-dollars', 'obs:rate-cents'],
  rawTexts: ['12', '50'],
  composedRawText: '12 50',
  evidence: [
    {
      observationId: 'obs:rate-dollars',
      sourceLayer: 'pdf_native_text',
      rawText: '12',
      boundingBox: { xMin: 10, xMax: 12, yMin: 30, yMax: 34 },
    },
    {
      observationId: 'obs:rate-cents',
      sourceLayer: 'pdf_native_text',
      rawText: '50',
      boundingBox: { xMin: 13, xMax: 15, yMin: 30, yMax: 34 },
    },
  ],
})!;

const MASTER_ON = {
  FORGEWING_SHADOW_ENABLED: '1',
  FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1',
} as const;

type ScheduledRun = ReturnType<typeof vi.fn>;

function scheduleBoth(
  env: Readonly<Record<string, string | undefined>>,
  budget = new ForgewingCallBudget(4),
) {
  const registered: Array<() => Promise<void>> = [];
  // `requires_human_review` is the only status the dispatcher persists, so a
  // run returning it proves scheduling reached both the provider seam and the
  // proposal seam for exactly the recovery types that were admitted.
  const run = vi.fn(async (
    taskInput: { candidates: readonly { recoveryType: string; candidateId: string }[] },
    dependencies?: { budget?: ForgewingCallBudget },
  ) => {
    dependencies?.budget?.tryConsume();
    return {
      status: 'requires_human_review' as const,
      selectedCandidateId: taskInput.candidates[0]!.candidateId,
      confidence: 0.8,
      rationaleCode: 'row_context',
      providerCalls: 1,
      model: 'test-model',
      promptTemplateId: 'test-prompt',
      promptTemplateVersion: 'v1',
    };
  });
  const persistProposal = vi.fn(async () => ({ status: 'persisted' as const }));
  const persistOutcome = vi.fn(async (_input: unknown) => ({ status: 'persisted' as const,
    outcomeRowId: 'outcome-1', diagnosticId: 'd'.repeat(64), inserted: true }));

  scheduleRecoveryCandidateV2Shadow({
    organizationId: ORGANIZATION_ID,
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourceArtifactId: SOURCE_ARTIFACT_ID,
    extractionSnapshotId: 'snapshot-1',
    pricingRows: [],
    sourceObservations: [],
    pricingSourceEligibility: null,
    recoveryCandidatesV2: [continuation, pricingCluster],
    env,
  }, {
    register: (task) => { registered.push(task); },
    run: run as never,
    persistProposal: persistProposal as never,
    persistOutcome: persistOutcome as never,
    budget,
  });

  return { registered, run, persistProposal, persistOutcome, budget };
}

async function drain(registered: readonly (() => Promise<void>)[]): Promise<void> {
  for (const task of registered) await task();
}

function scheduledTypes(run: ScheduledRun): string[] {
  return run.mock.calls.flatMap(([taskInput]) => (taskInput as {
    candidates: readonly { recoveryType: string }[];
  }).candidates.map((candidate) => candidate.recoveryType));
}

describe('Recovery V2 domain gate split', () => {
  it('schedules continuation and withholds pricing cluster while the cluster gate is off', async () => {
    // The intended production state: continuation attribution is qualified on
    // the real DN priced corpus and runs; split-token cluster recovery is
    // synthetic-only and must not run under the flag that admits continuation.
    const { registered, run, persistProposal, persistOutcome, budget } = scheduleBoth(MASTER_ON);
    await drain(registered);

    expect(scheduledTypes(run)).toEqual(['priced_schedule_continuation_attribution']);
    expect(registered).toHaveLength(2);
    expect(persistProposal).toHaveBeenCalledTimes(1);
    expect(persistOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: 'recovery_disabled', providerInvoked: false,
      candidateIds: [pricingCluster.candidateId],
    }));
    // One unit served, one call consumed: the withheld pricing cluster took
    // nothing from the document's shared provider budget.
    expect(budget.used).toBe(1);
  });

  it('leaves the whole budget to continuation when pricing candidates are withheld', async () => {
    // A budget of exactly one proves a withheld pricing cluster cannot
    // displace the continuation unit by forming an evaluation unit ahead of it.
    const { registered, run, budget } = scheduleBoth(MASTER_ON, new ForgewingCallBudget(1));
    await drain(registered);

    expect(scheduledTypes(run)).toEqual(['priced_schedule_continuation_attribution']);
    expect(budget.used).toBe(1);
  });

  it('schedules both recovery types once the cluster gate is on', async () => {
    const { registered, run, persistProposal, budget } = scheduleBoth({
      ...MASTER_ON,
      FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED: '1',
    });
    await drain(registered);

    expect(registered).toHaveLength(2);
    expect([...scheduledTypes(run)].sort()).toEqual([
      'priced_schedule_continuation_attribution',
      'pricing_rate_multi_observation_cluster',
    ]);
    expect(persistProposal).toHaveBeenCalledTimes(2);
    expect(budget.used).toBe(2);
  });

  it('treats any cluster-gate value other than exact 1 as off', async () => {
    for (const value of ['true', 'TRUE', 'yes', 'on', '0', '', ' 1']) {
      const { registered, run, budget } = scheduleBoth({
        ...MASTER_ON,
        FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED: value,
      });
      await drain(registered);

      expect(scheduledTypes(run)).toEqual(['priced_schedule_continuation_attribution']);
      expect(budget.used).toBe(1);
    }
  });

  it('schedules neither recovery type while the master or V2 gate is off', async () => {
    for (const [env, expectedPersistenceTasks] of [
      [{ FORGEWING_SHADOW_ENABLED: '1' }, 2],
      [{ FORGEWING_SHADOW_ENABLED: '1', FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED: '1' }, 2],
      [{ FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1' }, 0],
      [{ FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1',
        FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED: '1' }, 0],
      [{}, 0],
    ] as const) {
      const { registered, run, persistProposal, persistOutcome, budget } = scheduleBoth(env);
      await drain(registered);

      expect(registered).toHaveLength(expectedPersistenceTasks);
      expect(run).not.toHaveBeenCalled();
      expect(persistProposal).not.toHaveBeenCalled();
      expect(persistOutcome).toHaveBeenCalledTimes(expectedPersistenceTasks);
      for (const call of persistOutcome.mock.calls) {
        expect(call[0]).toMatchObject({ outcomeCode: 'recovery_disabled', providerInvoked: false });
      }
      expect(budget.used).toBe(0);
    }
  });

  it('records a bounded V2 budget outcome and does not create a proposal', async () => {
    const registered: Array<() => Promise<void>> = [];
    const persistProposal = vi.fn();
    const persistOutcome = vi.fn(async () => ({
      status: 'persisted' as const, outcomeRowId: 'outcome-1',
      diagnosticId: 'd'.repeat(64), inserted: true,
    }));
    scheduleRecoveryCandidateV2Shadow({
      organizationId: ORGANIZATION_ID,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourceArtifactId: SOURCE_ARTIFACT_ID,
      extractionSnapshotId: 'snapshot-1',
      pricingRows: [], sourceObservations: [], pricingSourceEligibility: null,
      recoveryCandidatesV2: [continuation], env: MASTER_ON,
    }, {
      register: (task) => registered.push(task),
      run: vi.fn(async () => ({
        status: 'eligible_not_executed' as const,
        reason: 'budget_exhausted' as const, providerCalls: 0 as const,
      })) as never,
      persistProposal: persistProposal as never,
      persistOutcome: persistOutcome as never,
    });
    await drain(registered);
    expect(persistProposal).not.toHaveBeenCalled();
    expect(persistOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: 'budget_exhausted', sanitizedReason: 'budget_exhausted',
      providerInvoked: false,
      candidateIds: [continuation.candidateId],
    }));
  });

  it('does not relabel an arbitrary V2 task exception as a provider failure', async () => {
    const registered: Array<() => Promise<void>> = [];
    const persistOutcome = vi.fn();
    scheduleRecoveryCandidateV2Shadow({
      organizationId: ORGANIZATION_ID, sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourceArtifactId: SOURCE_ARTIFACT_ID, extractionSnapshotId: 'snapshot-1',
      pricingRows: [], sourceObservations: [], pricingSourceEligibility: null,
      recoveryCandidatesV2: [continuation], env: MASTER_ON,
    }, {
      register: (task) => registered.push(task),
      run: vi.fn(async () => { throw new Error('unexpected downstream failure'); }) as never,
      persistOutcome: persistOutcome as never,
    });
    await drain(registered);
    expect(persistOutcome).not.toHaveBeenCalled();
  });

  it('gates scheduling only: review, re-entry and reconstruction stay gate-free', () => {
    // The gate must not leak into human review or deterministic re-entry.
    // Those paths are human-authoritative and provider-free, and a generation
    // flag able to hide an already-reviewed proposal would make immutable
    // review history unreadable and a confirmed recovery unapplyable.
    for (const surface of [
      'app/api/internal/forgewing-recovery-review/route.ts',
      'lib/server/forgewingRecoveryReview.ts',
      'lib/server/forgewingRecoveryReviewRead.ts',
      'lib/server/effectiveRecoveryConfirmations.ts',
      'lib/extraction/pdf/pagePricedScheduleReconstruction.ts',
      'lib/pipeline/processDocument.ts',
    ]) {
      expect(readFileSync(surface, 'utf8'))
        .not.toContain('FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED');
    }
  });
});
