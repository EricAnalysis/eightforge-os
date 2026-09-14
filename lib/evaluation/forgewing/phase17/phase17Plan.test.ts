import { describe, expect, it } from 'vitest';

import { RecoveryCandidateV2Schema } from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  PHASE17_ADVERSARIAL_MAX_CALLS,
  PHASE17_CORE_CALLS,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';
import {
  buildPhase17CallPlan,
  estimatePhase17MaxSpend,
  injectionText,
  PHASE17_INJECTION_CANARY,
  withFragmentInjection,
  withIrrelevantEvidence,
  withTargetContextInjection,
} from '@/lib/evaluation/forgewing/phase17/phase17Plan';
import { syntheticPhase17Cohort }
  from '@/lib/evaluation/forgewing/phase17/__fixtures__/phase17SyntheticCohort';
import { canonicalJson } from '@/lib/extraction/domain/hash';

const options = { systemPrompt: 'prompt', outputSchemaJson: '{}' };

describe('Phase 17 call plan', () => {
  it('plans 39 core calls round-robin in canonical, reversed, canonical order', () => {
    const cohort = syntheticPhase17Cohort();
    const core = buildPhase17CallPlan(cohort, options).filter((call) => call.planned.cohort === 'core');
    expect(core).toHaveLength(PHASE17_CORE_CALLS);
    expect(core.map((call) => call.planned.sequence)).toEqual(
      Array.from({ length: 39 }, (_, index) => index + 1));
    for (const [runIndex, order] of (['canonical', 'reversed', 'canonical'] as const).entries()) {
      const run = core.filter((call) => call.planned.runIndex === runIndex);
      expect(run.map((call) => call.planned.unitKey)).toEqual(cohort.units.map((unit) => unit.unitKey));
      expect(run.every((call) => call.planned.candidateOrder === order)).toBe(true);
    }
    const unit = cohort.units[0]!;
    const [canonical, reversed] = core.filter((call) => call.planned.unitKey === unit.unitKey);
    expect(reversed!.candidates.map((candidate) => candidate.candidateId))
      .toEqual([...canonical!.candidates.map((candidate) => candidate.candidateId)].reverse());
  });

  it('sends exactly the production task payload and pins it by digest', () => {
    const call = buildPhase17CallPlan(syntheticPhase17Cohort(), options)[0]!;
    expect(call.inputJson).toBe(canonicalJson({
      taskType: 'recovery_candidate_v2', candidates: call.candidates }));
    expect(call.planned.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(buildPhase17CallPlan(syntheticPhase17Cohort(), options).map((entry) => entry.planned))
      .toEqual(buildPhase17CallPlan(syntheticPhase17Cohort(), options).map((entry) => entry.planned));
  });

  it('bounds adversarial provider calls at six, across three kinds and both orders', () => {
    const adversarial = buildPhase17CallPlan(syntheticPhase17Cohort(), options)
      .filter((call) => call.planned.cohort === 'adversarial');
    expect(adversarial).toHaveLength(PHASE17_ADVERSARIAL_MAX_CALLS);
    expect(adversarial.map((call) => [call.planned.adversarialKind, call.planned.candidateOrder]))
      .toEqual([
        ['fragment_injection', 'canonical'], ['fragment_injection', 'reversed'],
        ['target_context_injection', 'canonical'], ['target_context_injection', 'reversed'],
        ['irrelevant_evidence', 'canonical'], ['irrelevant_evidence', 'reversed'],
      ]);
    expect(new Set(adversarial.map((call) => call.planned.unitKey)).size).toBe(6);
  });

  it('keeps injected candidates schema-valid with unchanged identity', () => {
    const unit = syntheticPhase17Cohort().units[0]!;
    const target = unit.canonicalCandidates[1]!.candidateId;
    const fragment = withFragmentInjection(unit.canonicalCandidates, target);
    expect(fragment.map((candidate) => candidate.candidateId))
      .toEqual(unit.canonicalCandidates.map((candidate) => candidate.candidateId));
    expect(fragment.every((candidate) => RecoveryCandidateV2Schema.safeParse(candidate).success)).toBe(true);
    expect(fragment.every((candidate) => candidate.composedRawText.includes(PHASE17_INJECTION_CANARY)))
      .toBe(true);
    expect(injectionText(target)).toContain(target);

    const context = withTargetContextInjection(unit.canonicalCandidates, target);
    expect(context[0]!.targetContextEvidence!.composedRawText).toContain(PHASE17_INJECTION_CANARY);
    expect(context[1]!.targetContextEvidence!.composedRawText).not.toContain(PHASE17_INJECTION_CANARY);
  });

  it('rebuilds irrelevant-evidence candidates and maps them back to labelled ids', () => {
    const unit = syntheticPhase17Cohort().units[0]!;
    const rebuilt = withIrrelevantEvidence(unit.canonicalCandidates);
    expect(rebuilt.candidates.every((candidate) =>
      RecoveryCandidateV2Schema.safeParse(candidate).success)).toBe(true);
    expect(rebuilt.candidates.map((candidate) => rebuilt.labelledCandidateIdBySentId.get(candidate.candidateId)))
      .toEqual(unit.canonicalCandidates.map((candidate) => candidate.candidateId));
    expect(rebuilt.candidates.some((candidate) =>
      unit.canonicalCandidates.some((original) => original.candidateId === candidate.candidateId))).toBe(false);
  });

  it('computes a maximum spend from estimated input and the full output cap', () => {
    const calls = buildPhase17CallPlan(syntheticPhase17Cohort(), options).map((call) => call.planned);
    const estimate = estimatePhase17MaxSpend(calls, { maxOutputTokensPerCall: 400,
      inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 });
    expect(estimate.maxOutputTokens).toBe(calls.length * 400);
    expect(estimate.estimatedMaxSpendUsd).toBeCloseTo(
      (estimate.estimatedInputTokens * 3 + estimate.maxOutputTokens * 15) / 1_000_000, 10);
    expect(estimatePhase17MaxSpend(calls, { maxOutputTokensPerCall: 400,
      inputUsdPerMillionTokens: null, outputUsdPerMillionTokens: 15 }).estimatedMaxSpendUsd).toBeNull();
  });
});
