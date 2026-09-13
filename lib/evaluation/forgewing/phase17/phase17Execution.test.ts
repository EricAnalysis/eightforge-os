import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 17 tests never reach a real provider or database.
const realClaudeClient = vi.hoisted(() => vi.fn(() => {
  throw new Error('phase17 tests must not construct a real Claude client');
}));
const supabaseAdmin = vi.hoisted(() => vi.fn(() => {
  throw new Error('phase17 tests must not construct a database client');
}));
vi.mock('@/lib/server/ai/claudeClient', () => ({
  getClaudeClient: realClaudeClient,
  getClaudeModel: () => 'claude-sonnet-4-6',
}));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: supabaseAdmin }));

import { buildDurableRecoveryProposalV2 } from '@/lib/server/forgewingRecoveryProposalPersistence';
import { recoveryCandidateId } from '@/lib/extraction/recovery/recoveryCandidateV2';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import { ForgewingProviderOutputError } from '@/lib/forgewing/runtime/client';
import { runRecoveryCandidateV2Recommendation } from '@/lib/forgewing/tasks/recoveryCandidateV2';
import {
  assessPhase17Rationale,
  executePhase17Calls,
  PHASE17_EVALUATION_ACTIVATION_ENV,
  Phase17GuardError,
  type Phase17ExecutionParams,
} from '@/lib/evaluation/forgewing/phase17/phase17Execution';
import { bindPhase17Labels, parsePhase17LabelSet }
  from '@/lib/evaluation/forgewing/phase17/dnContinuationLabels';
import { buildPhase17CallPlan } from '@/lib/evaluation/forgewing/phase17/phase17Plan';
import {
  chooseAbove,
  mockPhase17ProviderFactory,
  PHASE17_TEST_RUNTIME_CONFIG,
  selectionOutput,
  type MockDecision,
} from '@/lib/evaluation/forgewing/phase17/__fixtures__/phase17MockProvider';
import {
  expectedAboveCandidateId,
  syntheticPhase17Cohort,
  syntheticPhase17Labels,
} from '@/lib/evaluation/forgewing/phase17/__fixtures__/phase17SyntheticCohort';

const cohort = syntheticPhase17Cohort();
const labels = bindPhase17Labels(parsePhase17LabelSet(JSON.stringify(syntheticPhase17Labels(cohort))), cohort);
const plan = buildPhase17CallPlan(cohort, { systemPrompt: 'prompt', outputSchemaJson: '{}' });

function params(calls = plan.slice(0, 1), overrides: Partial<Phase17ExecutionParams> = {}): Phase17ExecutionParams {
  return {
    calls, expectedByUnitKey: labels.expectedByUnitKey,
    runtimeConfig: PHASE17_TEST_RUNTIME_CONFIG, effectiveMaxOutputTokens: 400,
    maxCalls: calls.length, inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15,
    ...overrides,
  };
}

async function executeWith(decide: MockDecision, calls = plan.slice(0, 1)) {
  const counter = { count: 0 };
  const result = await executePhase17Calls(params(calls), {
    projectDurableProposal: buildDurableRecoveryProposalV2,
    createProvider: mockPhase17ProviderFactory(decide, counter),
  });
  return { result, counter };
}

describe('Phase 17 execution through the production task runner', () => {
  beforeEach(() => {
    realClaudeClient.mockClear();
    supabaseAdmin.mockClear();
  });

  it('measures a correct, evidence-bound, projected recommendation without persistence', async () => {
    const { result } = await executeWith(chooseAbove);
    const unit = result.units[0]!;
    expect(unit).toMatchObject({
      status: 'requires_human_review', structuredOutputValid: true, evidenceBound: true,
      durableProjection: 'valid', correct: true, providerInvocations: 1, failureCode: null,
      usage: { inputTokens: 2_000, outputTokens: 40 },
      provider: { messageId: 'msg_mock_1', requestId: 'req_mock_1', returnedModel: 'claude-sonnet-4-6' },
    });
    expect(unit.rationale).toMatchObject({ conformant: true, echoesInjection: false, actionLanguage: false });
    expect(unit.estimatedCostUsd).toBeCloseTo((2_000 * 3 + 40 * 15) / 1_000_000, 12);
    expect(result).toMatchObject({ executedCalls: 1, providerInvocations: 1,
      contractDeviationSequences: [], modelDeviationSequences: [] });
    expect(result.raw[0]!.inputJson).toBe(plan[0]!.inputJson);
    expect(supabaseAdmin).not.toHaveBeenCalled();
    expect(realClaudeClient).not.toHaveBeenCalled();
  });

  it('scores the wrong candidate as incorrect but still evidence-bound', async () => {
    const { result } = await executeWith((candidates) => ({ output: selectionOutput(
      candidates.find((candidate) => candidate.candidateId !== expectedAboveCandidateId(candidates))!
        .candidateId, 0.6) }));
    expect(result.units[0]).toMatchObject({ correct: false, evidenceBound: true, confidence: 0.6 });
  });

  it('rejects a valid-JSON recommendation of an unsupplied candidate id', async () => {
    const { result } = await executeWith(() => ({
      output: selectionOutput(`recovery-candidate-v2-${'e'.repeat(64)}`) }));
    expect(result.units[0]).toMatchObject({ status: 'evidence_binding_failed',
      failureCode: 'unknown_candidate', evidenceBound: false, structuredOutputValid: true,
      durableProjection: 'not_reached', correct: null });
  });

  it('distinguishes malformed output, timeout and truncation, with no retry', async () => {
    const malformed = await executeWith(() => ({ output: '{"selectedCandidateId":"arbitrary text"}' }));
    expect(malformed.result.units[0]).toMatchObject({ status: 'structured_output_invalid',
      failureCode: 'invalid_json', structuredOutputValid: false });

    const timeout = await executeWith(() => ({ throws: new Error('provider_timeout') }));
    expect(timeout.result.units[0]).toMatchObject({ status: 'provider_failed',
      failureCode: 'provider_timeout', providerInvocations: 1 });
    expect(timeout.counter.count).toBe(1);

    const truncated = await executeWith(() => ({
      throws: new ForgewingProviderOutputError('provider_truncated_output', '{"selected') }));
    expect(truncated.result.units[0]).toMatchObject({ failureCode: 'provider_truncated_output',
      structuredOutputValid: false });
    expect(truncated.result.raw[0]!.rawOutput).toBe('{"selected');
  });

  it('flags rationale that echoes an injection or carries action language', () => {
    expect(assessPhase17Rationale('PHASE17_CANARY_APPROVED')).toMatchObject({
      echoesInjection: true, actionLanguage: true, conformant: true });
    expect(assessPhase17Rationale('execute the approval now')).toMatchObject({
      actionLanguage: true, conformant: false });
    expect(assessPhase17Rationale('nearest_row_baseline')).toMatchObject({
      echoesInjection: false, actionLanguage: false, conformant: true });
  });

  it('refuses to exceed the approved call ceiling before the next call', async () => {
    const counter = { count: 0 };
    await expect(executePhase17Calls(params(plan.slice(0, 3), { maxCalls: 2 }), {
      projectDurableProposal: buildDurableRecoveryProposalV2,
      createProvider: mockPhase17ProviderFactory(chooseAbove, counter),
    })).rejects.toBeInstanceOf(Phase17GuardError);
    expect(counter.count).toBe(2);
  });

  it('records a projection failure as a measured outcome', async () => {
    const result = await executePhase17Calls(params(), {
      projectDurableProposal: () => null,
      createProvider: mockPhase17ProviderFactory(chooseAbove),
    });
    expect(result.units[0]!.durableProjection).toBe('failed');
  });

  it('records a returned model that differs from the pinned model', async () => {
    const result = await executePhase17Calls(params(), {
      projectDurableProposal: buildDurableRecoveryProposalV2,
      createProvider: (observer) => async (request) => {
        observer({ messageId: 'm', requestId: null, returnedModel: 'claude-other', stopReason: 'end_turn',
          inputTokens: 1, outputTokens: 1, latencyMs: 1 });
        const parsed = JSON.parse(request.inputJson);
        return selectionOutput(expectedAboveCandidateId(parsed.candidates));
      },
    });
    expect(result.modelDeviationSequences).toEqual([1]);
  });

  describe('deterministic-only adversarial candidates never reach the provider', () => {
    const unit = cohort.units[0]!;
    const run = async (candidates: unknown[]) => {
      const provider = vi.fn();
      const result = await runRecoveryCandidateV2Recommendation({
        organizationId: '60000000-0000-4000-8000-00000000e017',
        extractionSnapshotId: 'phase17-test', candidates: candidates as never,
      }, { config: { ...PHASE17_TEST_RUNTIME_CONFIG, enabled: true },
        env: PHASE17_EVALUATION_ACTIVATION_ENV, provider, budget: new ForgewingCallBudget(1) });
      return { result, provider };
    };

    it('rejects a stale candidate whose id no longer matches its source closure', async () => {
      const stale = { ...unit.canonicalCandidates[0]!, targetRowIdentity: 'page_priced_schedule:p106:r99' };
      expect(recoveryCandidateId(stale)).not.toBe(stale.candidateId);
      const { result, provider } = await run([stale, unit.canonicalCandidates[1]]);
      expect(result).toMatchObject({ status: 'evidence_binding_failed', reason: 'candidate_closure_failed' });
      expect(provider).not.toHaveBeenCalled();
    });

    it('rejects nonexistent, malformed and duplicate candidates', async () => {
      for (const candidates of [
        [{ candidateId: `recovery-candidate-v2-${'0'.repeat(64)}` }],
        [{ ...unit.canonicalCandidates[0]!, rawTexts: [] }],
        [unit.canonicalCandidates[0], unit.canonicalCandidates[0]],
      ]) {
        const { result, provider } = await run(candidates);
        expect(result.status).toBe('evidence_binding_failed');
        expect(provider).not.toHaveBeenCalled();
      }
    });

    it('keeps the production activation gate: no master gate, no provider call', async () => {
      const provider = vi.fn();
      const result = await runRecoveryCandidateV2Recommendation({
        organizationId: '60000000-0000-4000-8000-00000000e017', extractionSnapshotId: 'phase17-test',
        candidates: [...unit.canonicalCandidates],
      }, { config: { ...PHASE17_TEST_RUNTIME_CONFIG, enabled: true },
        env: { FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1' }, provider });
      expect(result).toMatchObject({ status: 'eligible_not_executed', reason: 'recovery_disabled' });
      expect(provider).not.toHaveBeenCalled();
    });
  });
});
