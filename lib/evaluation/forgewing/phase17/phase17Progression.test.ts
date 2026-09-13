import { describe, expect, it } from 'vitest';

import { phase17ProviderInputJson } from '@/lib/evaluation/forgewing/phase17/phase17Plan';
import { buildPhase17ProgressionCalls, predictPhase17Progression }
  from '@/lib/evaluation/forgewing/phase17/phase17Progression';
import { syntheticPhase17Cohort }
  from '@/lib/evaluation/forgewing/phase17/__fixtures__/phase17SyntheticCohort';

describe('Phase 17 progression prediction from the Phase 16 planner', () => {
  it('predicts three advancing progression runs that skip the reviewed unit', () => {
    const cohort = syntheticPhase17Cohort();
    const prediction = predictPhase17Progression(cohort);
    const keys = prediction.selected.map((unit) => unit.unitKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain(prediction.reviewedSkip.unitKey);
    const { calls } = buildPhase17ProgressionCalls(cohort, 46, () => 1);
    expect(calls.map((call) => [call.planned.sequence, call.planned.cohort, call.planned.runIndex]))
      .toEqual([[46, 'progression', 0], [47, 'progression', 1], [48, 'progression', 2]]);
    expect(calls[0]!.inputJson).toBe(phase17ProviderInputJson(calls[0]!.candidates));
  });
});
