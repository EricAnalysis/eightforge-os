/** SYNTHETIC FIXTURES ONLY. Phase C fixed-denominator scoring paths. */
import { describe, expect, it } from 'vitest';

import {
  scoreForgewingV2PhaseC,
  type PhaseCHumanField,
  type PhaseCObservation,
} from '@/lib/evaluation/forgewing/pricingProposalV2PhaseCScoring';

function humanField(params: {
  id: string; role: string; semantic: string;
  contributions: readonly (readonly [string, string])[];
  state?: string;
}): PhaseCHumanField {
  return { sourceFieldId: params.id, sourceFieldRole: params.role,
    expectedSemanticRole: params.semantic,
    expectedInterpretationState: params.state ?? 'observed',
    sourceObservationIds: params.contributions.map(([id]) => id),
    expectedContributions: params.contributions
      .map(([observationId, contributionRole]) => ({ observationId, contributionRole })) };
}

/** Two-member rate with a value, two-member rate with a placeholder, single unit. */
const FIELDS: PhaseCHumanField[] = [
  humanField({ id: 'field-rate-value', role: 'rate', semantic: 'rate_like_amount',
    contributions: [['obs-a', 'type_marker'], ['obs-b', 'value_token']] }),
  humanField({ id: 'field-rate-absent', role: 'rate', semantic: 'rate_like_amount',
    contributions: [['obs-c', 'type_marker'], ['obs-d', 'placeholder_absence']] }),
  humanField({ id: 'field-unit', role: 'unit', semantic: 'unit_like_text',
    contributions: [['obs-e', 'semantic_head']] }),
];

function observed(id: string, semantic: string, state: string,
  contributions: readonly (readonly [string, string])[]): [string, PhaseCObservation] {
  return [id, { status: 'observed', field: { sourceFieldId: id, semanticRole: semantic,
    interpretationState: state,
    contributions: contributions.map(([observationId, contributionRole]) =>
      ({ observationId, contributionRole })) } }];
}

const PERFECT = new Map<string, PhaseCObservation>([
  observed('field-rate-value', 'rate_like_amount', 'observed',
    [['obs-a', 'type_marker'], ['obs-b', 'value_token']]),
  observed('field-rate-absent', 'rate_like_amount', 'observed',
    [['obs-c', 'type_marker'], ['obs-d', 'placeholder_absence']]),
  observed('field-unit', 'unit_like_text', 'observed', [['obs-e', 'semantic_head']]),
]);

describe('SYNTHETIC: Phase C fixed-denominator scoring', () => {
  it('derives denominators from human truth, not provider output', () => {
    const result = scoreForgewingV2PhaseC({ humanFields: FIELDS, observations: PERFECT });
    expect(result.fixedDenominators).toEqual({ field: 3, contribution: 5 });
    expect(result.semanticRole.denominator).toBe(3);
    expect(result.contributionRole.denominator).toBe(5);
  });

  it('scores a fully correct run', () => {
    const r = scoreForgewingV2PhaseC({ humanFields: FIELDS, observations: PERFECT });
    expect(r.semanticRole.correct).toBe(3);
    expect(r.contributionRole.correct).toBe(5);
    expect(r.contributionRole.accuracyFixedDenominator).toBe(1);
    expect(r.membership.exact).toBe(3);
    expect(r.interpretationState.correct).toBe(3);
    expect(r.placeholderSafety).toMatchObject({ denominator: 1,
      correctPlaceholderAbsence: 1, predictedValueToken: 0, predictedComponentPart: 0,
      criticalFailuresTotal: 0 });
  });

  it('preserves both denominators when every provider output is unavailable', () => {
    const none = new Map<string, PhaseCObservation>(FIELDS.map((f) =>
      [f.sourceFieldId, { status: 'unavailable', reason: 'provider_error' }]));
    const r = scoreForgewingV2PhaseC({ humanFields: FIELDS, observations: none });
    expect(r.fixedDenominators).toEqual({ field: 3, contribution: 5 });
    expect(r.semanticRole).toMatchObject({ denominator: 3, correct: 0, unavailable: 3,
      accuracyFixedDenominator: 0 });
    expect(r.contributionRole).toMatchObject({ denominator: 5, correct: 0, unavailable: 5,
      accuracyFixedDenominator: 0 });
    expect(r.contributionRole.accuracyAmongScoredSecondaryDiagnostic).toBeNull();
    expect(r.unavailability.byReason).toEqual({ provider_error: 3 });
  });

  it('treats a field the provider never returned as unavailable, not absent', () => {
    const partial = new Map<string, PhaseCObservation>([PERFECT.get('field-unit')
      ? ['field-unit', PERFECT.get('field-unit')!] : ['field-unit', PERFECT.get('field-unit')!]]);
    const r = scoreForgewingV2PhaseC({ humanFields: FIELDS, observations: partial });
    expect(r.fixedDenominators).toEqual({ field: 3, contribution: 5 });
    expect(r.semanticRole.unavailable).toBe(2);
    expect(r.contributionRole.unavailable).toBe(4);
    expect(r.unavailability.byReason).toEqual({ not_returned: 2 });
  });

  it('flags absence collapsed into a value as a critical placeholder failure', () => {
    const collapsed = new Map(PERFECT);
    collapsed.set(...observed('field-rate-absent', 'rate_like_amount', 'observed',
      [['obs-c', 'type_marker'], ['obs-d', 'value_token']]));
    const r = scoreForgewingV2PhaseC({ humanFields: FIELDS, observations: collapsed });
    expect(r.placeholderSafety).toMatchObject({ denominator: 1,
      correctPlaceholderAbsence: 0, predictedValueToken: 1, predictedComponentPart: 0,
      criticalFailuresTotal: 1 });
    expect(r.contributionRole.confusion.placeholder_absence!.value_token).toBe(1);
  });

  it('reports the structural mapper and majority baselines as controls', () => {
    const r = scoreForgewingV2PhaseC({ humanFields: FIELDS, observations: PERFECT });
    expect(r.semanticRole.structuralMapperBaseline)
      .toMatchObject({ matches: 3, denominator: 3, accuracy: 1 });
    expect(r.semanticRole.interpretation).toBe('STRUCTURALLY_CONFOUNDED');
    expect(r.contributionRole.majorityClassBaseline)
      .toMatchObject({ role: 'type_marker', matches: 2, denominator: 5 });
  });

  it('marks abstention as not measurable and keeps state scoring descriptive', () => {
    const abstained = new Map(PERFECT);
    abstained.set(...observed('field-unit', 'unknown', 'insufficient_evidence', []));
    const r = scoreForgewingV2PhaseC({ humanFields: FIELDS, observations: abstained });
    expect(r.interpretationState.abstentionAppropriateness)
      .toBe('NOT_MEASURABLE_FROM_THIS_PACKAGE');
    expect(r.interpretationState.correct).toBe(2);
    expect(r.interpretationState.incorrect).toBe(1);
    expect(r.contributionRole.unavailable).toBe(1);
  });

  it('scores membership violations without shrinking the denominator', () => {
    const broken = new Map(PERFECT);
    broken.set(...observed('field-rate-value', 'rate_like_amount', 'observed',
      [['obs-a', 'type_marker'], ['obs-a', 'type_marker'], ['obs-zzz', 'value_token']]));
    const r = scoreForgewingV2PhaseC({ humanFields: FIELDS, observations: broken });
    expect(r.fixedDenominators).toEqual({ field: 3, contribution: 5 });
    expect(r.membership.exact).toBe(2);
    expect(r.membership.duplicateMemberReferences).toBe(1);
    expect(r.membership.missingMemberReferences).toBe(1);
    expect(r.membership.foreignMemberReferences).toBe(1);
  });

  it('fails closed on a duplicated human field', () => {
    expect(() => scoreForgewingV2PhaseC({ humanFields: [FIELDS[0]!, FIELDS[0]!],
      observations: PERFECT })).toThrow('forgewing_v2_phase_c_duplicate_human_field');
  });
});
