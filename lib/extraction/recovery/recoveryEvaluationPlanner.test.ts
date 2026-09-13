import { describe, expect, it } from 'vitest';

import { buildRecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  groupRecoveryEvaluationUnits,
  planRecoveryEvaluation,
  recoveryEvaluationUnitIdentity,
} from '@/lib/extraction/recovery/recoveryEvaluationPlanner';

function candidate(unit: number, digest = 'a'.repeat(64)) {
  const observationId = `fragment:${unit}`;
  return buildRecoveryCandidateV2({
    recoveryType: 'priced_schedule_continuation_attribution',
    sourceDocumentId: '11111111-1111-4111-8111-111111111111',
    sourceArtifactId: '22222222-2222-4222-8222-222222222222',
    physicalPageNumber: 10 + unit,
    pageRepresentationDigest: digest,
    targetRowIdentity: `row:${unit}`,
    orderedObservationIds: [observationId],
    rawTexts: [`fragment ${unit}`],
    composedRawText: `fragment ${unit}`,
    evidence: [{ observationId, sourceLayer: 'pdf_native_text', rawText: `fragment ${unit}`,
      boundingBox: { xMin: 1, xMax: 2, yMin: unit, yMax: unit + 1 } }],
  })!;
}

const policy = (overallCap: number) => ({
  overallCap,
  perTypeCap: {
    priced_schedule_continuation_attribution: overallCap,
    pricing_rate_multi_observation_cluster: 0,
  },
  activation: {
    priced_schedule_continuation_attribution: 'controlled' as const,
    pricing_rate_multi_observation_cluster: 'disabled' as const,
  },
});

const emptyPrior = {
  proposedUnitIdentities: [],
  confirmedCandidateIds: [],
  providerInvokedUnitIdentities: [],
};

describe('recovery evaluation planner', () => {
  it('is input-order independent and preserves authored member order', () => {
    const first = candidate(1);
    const second = candidate(2);
    const forward = groupRecoveryEvaluationUnits([first, second]);
    const reverse = groupRecoveryEvaluationUnits([second, first]);
    expect(reverse.map((unit) => unit.unitKey)).toEqual(forward.map((unit) => unit.unitKey));
    expect(reverse[0]!.candidates[0]!.orderedObservationIds)
      .toEqual(forward[0]!.candidates[0]!.orderedObservationIds);
  });

  it('suppresses exact proposals and confirmed candidates but admits a changed digest', () => {
    const original = groupRecoveryEvaluationUnits([candidate(1)])[0]!;
    const changed = groupRecoveryEvaluationUnits([candidate(1, 'b'.repeat(64))])[0]!;
    const proposed = planRecoveryEvaluation([original, changed], {
      ...emptyPrior,
      proposedUnitIdentities: [recoveryEvaluationUnitIdentity(original)],
    }, policy(2));
    expect(proposed.previouslyHandled).toEqual([original]);
    expect(proposed.selected).toEqual([changed]);

    const confirmed = planRecoveryEvaluation([original], {
      ...emptyPrior,
      confirmedCandidateIds: [original.candidateIds[0]!],
    }, policy(1));
    expect(confirmed.selected).toHaveLength(0);
    expect(confirmed.previouslyHandled).toEqual([original]);
  });

  it('prioritizes never-invoked units ahead of provider failures', () => {
    const units = groupRecoveryEvaluationUnits([candidate(1), candidate(2)]);
    const plan = planRecoveryEvaluation(units, {
      ...emptyPrior,
      providerInvokedUnitIdentities: [recoveryEvaluationUnitIdentity(units[0]!)],
    }, policy(1));
    expect(plan.selected[0]!.unitKey).toBe(units[1]!.unitKey);
    expect(plan.budgetExhausted[0]!.unitKey).toBe(units[0]!.unitKey);
  });

  it.each([1, 4])('progresses across thirteen units with budget %i', (budget) => {
    const units = groupRecoveryEvaluationUnits(Array.from({ length: 13 }, (_, index) =>
      candidate(index + 1)));
    const proposedUnitIdentities: string[] = [];
    const evaluated: string[] = [];
    let runCount = 0;
    while (evaluated.length < units.length) {
      const plan = planRecoveryEvaluation(units, {
        ...emptyPrior,
        proposedUnitIdentities,
      }, policy(budget));
      expect(plan.selected.length).toBeGreaterThan(0);
      runCount += 1;
      for (const unit of plan.selected) {
        evaluated.push(unit.unitKey);
        proposedUnitIdentities.push(recoveryEvaluationUnitIdentity(unit));
      }
    }
    expect(new Set(evaluated).size).toBe(13);
    expect(runCount).toBe(budget === 1 ? 13 : 4);
  });
});
