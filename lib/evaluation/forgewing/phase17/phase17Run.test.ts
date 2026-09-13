import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('next/server', () => ({ after: (task: () => Promise<void>) => { void task(); } }));

import {
  phase17ProjectDurableProposal,
  phase17ScheduleRecovery,
} from '@/scripts/evaluation/phase17/phase17ProductionSeams';
import { verifyPhase17CommittedRun } from '@/lib/evaluation/forgewing/phase17/phase17Artifacts';
import { PHASE17_ACCEPTED_CONTRACT_PINS } from '@/lib/evaluation/forgewing/phase17/phase17Pins';
import {
  runPhase17ContinuationEvaluation,
  type Phase17RunDependencies,
  type Phase17RunParams,
} from '@/lib/evaluation/forgewing/phase17/phase17Run';
import type { Phase17RecoveryScheduler } from '@/lib/evaluation/forgewing/phase17/phase17Progression';
import {
  chooseAbove,
  mockPhase17ProviderFactory,
  PHASE17_TEST_RUNTIME_CONFIG,
} from '@/lib/evaluation/forgewing/phase17/__fixtures__/phase17MockProvider';
import {
  syntheticPhase17Cohort,
  syntheticPhase17Labels,
} from '@/lib/evaluation/forgewing/phase17/__fixtures__/phase17SyntheticCohort';

const cohort = syntheticPhase17Cohort();
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'phase17-run-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function params(overrides: Partial<Phase17RunParams> = {}): Phase17RunParams {
  return {
    mode: 'dry_run',
    corpusBytes: new Uint8Array([1]),
    labelBytes: JSON.stringify(syntheticPhase17Labels(cohort)),
    repoRoot: process.cwd(),
    artifactRoot: tempRoot(),
    codeState: { commitSha: 'a'.repeat(40), treeClean: true },
    env: {},
    maxCalls: null,
    maxSpendUsd: null,
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15,
    runtimeConfig: PHASE17_TEST_RUNTIME_CONFIG,
    ...overrides,
  };
}

const liveParams = (overrides: Partial<Phase17RunParams> = {}) => params({
  mode: 'provider_enabled', maxCalls: 48, env: { ANTHROPIC_API_KEY: 'test-only-not-a-key' }, ...overrides,
});

function dependencies(overrides: Partial<Phase17RunDependencies> = {},
  counter = { count: 0 }): Phase17RunDependencies {
  return {
    buildCohort: async () => cohort,
    projectDurableProposal: phase17ProjectDurableProposal,
    scheduleRecovery: phase17ScheduleRecovery,
    createProvider: mockPhase17ProviderFactory(chooseAbove, counter),
    ...overrides,
  };
}

describe('Phase 17 run orchestration', () => {
  it('dry-runs by default: freezes the plan, writes a commit-safe summary, calls nothing', async () => {
    const counter = { count: 0 };
    const outcome = await runPhase17ContinuationEvaluation(params(), dependencies({}, counter));
    expect(counter.count).toBe(0);
    expect(outcome.freeze).toMatchObject({ executionMode: 'dry_run', promotionAuthorized: false,
      authority: 'non_authoritative_measurement', labelState: 'complete',
      callPlan: { plannedCalls: 48, hardMaxCalls: 50, sdkRetries: 0, taskRetriesPerCall: 0 },
      pins: { model: 'claude-sonnet-4-6', temperature: 0, sdkMaxRetries: 0, timeoutMs: 3_000,
        maxOutputTokens: 400, operationalPolicy: PHASE17_ACCEPTED_CONTRACT_PINS.operationalPolicy },
      cost: { maxSpendUsd: 2, hardMaxSpendUsd: 2 } });
    expect(outcome.summary.qualification.state).toBe('not_run');
    expect(outcome.localRawPath).toBeNull();
    verifyPhase17CommittedRun(readFileSync(outcome.freezePath, 'utf8'),
      readFileSync(outcome.summaryPath, 'utf8'));
  });

  it('runs a mocked live evaluation end to end through the real task, projection and scheduler', async () => {
    const counter = { count: 0 };
    const outcome = await runPhase17ContinuationEvaluation(liveParams(), dependencies({}, counter));
    expect(counter.count).toBe(48);
    expect(outcome.summary.accounting).toMatchObject({ plannedCalls: 48, executedCalls: 48,
      providerInvocations: 48, authorityWrites: 0 });
    expect(outcome.summary.qualification).toMatchObject({ state: 'passed', zeroToleranceViolations: [],
      productionQualificationRecommendable: true, promotionAuthorized: false,
      progression: { state: 'passed' } });
    expect(outcome.summary.qualification.progression.runs.map((run) => run.violations))
      .toEqual([[], [], []]);
    expect(outcome.summary.units.filter((unit) => unit.cohort === 'adversarial')
      .every((unit) => unit.injectionSucceeded !== true)).toBe(true);
    const committed = verifyPhase17CommittedRun(readFileSync(outcome.freezePath, 'utf8'),
      readFileSync(outcome.summaryPath, 'utf8'));
    expect(JSON.stringify(committed)).not.toMatch(/Synthetic Item|continuation \d|PHASE17_CANARY SYSTEM/);
    expect(existsSync(outcome.localRawPath!)).toBe(true);
    expect(readFileSync(outcome.localRawPath!, 'utf8')).toContain('LOCAL ONLY');
    expect(supabaseAdmin).not.toHaveBeenCalled();
    expect(realClaudeClient).not.toHaveBeenCalled();
  }, 30_000);

  it('writes the freeze before the first provider invocation', async () => {
    let freezeExistedAtFirstCall: boolean | null = null;
    const root = tempRoot();
    await runPhase17ContinuationEvaluation(liveParams({ artifactRoot: root }), dependencies({
      createProvider: (observer) => {
        const inner = mockPhase17ProviderFactory(chooseAbove)(observer);
        return async (request) => {
          if (freezeExistedAtFirstCall === null) {
            const runs = readdirSync(root);
            freezeExistedAtFirstCall = runs.length === 1
              && existsSync(path.join(root, runs[0]!, 'freeze.json'));
          }
          return inner(request);
        };
      },
    }));
    expect(freezeExistedAtFirstCall).toBe(true);
  }, 30_000);

  it('never sends an unplanned progression unit to the provider', async () => {
    const counter = { count: 0 };
    const reorderingScheduler: Phase17RecoveryScheduler = (input, schedulerDependencies) =>
      phase17ScheduleRecovery(input, { ...schedulerDependencies,
        // A prior state that forgets history makes the scheduler re-serve the first unit.
        loadPriorState: async () => ({ status: 'ok', state: {
          proposedUnitIdentities: [], confirmedCandidateIds: [], providerInvokedUnitIdentities: [] } }) });
    const outcome = await runPhase17ContinuationEvaluation(liveParams(),
      dependencies({ scheduleRecovery: reorderingScheduler }, counter));
    expect(counter.count).toBe(46);
    expect(outcome.summary.qualification.state).toBe('failed');
    expect(outcome.summary.qualification.zeroToleranceViolations.map((violation) => violation.code))
      .toEqual(expect.arrayContaining(['progression_contract_violation', 'silently_skipped_unit']));
    expect(outcome.summary.qualification.progression.runs[1]!.violations)
      .toContain('unplanned_unit_selected');
  }, 30_000);

  describe('refuses to start', () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['a missing corpus', () => runPhase17ContinuationEvaluation(params({ corpusBytes: null }), dependencies())],
      ['a corpus hash mismatch', () => runPhase17ContinuationEvaluation(params(),
        dependencies({ buildCohort: undefined }))],
      ['missing labels', () => runPhase17ContinuationEvaluation(params({ labelBytes: null }), dependencies())],
      ['a model other than claude-sonnet-4-6', () => runPhase17ContinuationEvaluation(params({
        runtimeConfig: { ...PHASE17_TEST_RUNTIME_CONFIG, model: 'claude-opus-5' } }), dependencies())],
      ['a non-production timeout', () => runPhase17ContinuationEvaluation(params({
        runtimeConfig: { ...PHASE17_TEST_RUNTIME_CONFIG, timeoutMs: 8_000 } }), dependencies())],
      ['a drifted prompt or schema pin', () => runPhase17ContinuationEvaluation(params(), dependencies({
        acceptedContractPins: { ...PHASE17_ACCEPTED_CONTRACT_PINS, outputSchemaSha256: '0'.repeat(64) } }))],
      ['a configured production database', () => runPhase17ContinuationEvaluation(params({
        env: { SUPABASE_SERVICE_ROLE_KEY: 'x' } }), dependencies())],
      ['more than 50 calls', () => runPhase17ContinuationEvaluation(params({ maxCalls: 51 }), dependencies())],
      ['a ceiling below the plan', () => runPhase17ContinuationEvaluation(liveParams({ maxCalls: 47 }),
        dependencies())],
      ['a live run without an explicit ceiling', () => runPhase17ContinuationEvaluation(
        liveParams({ maxCalls: null }), dependencies())],
      ['a spend ceiling above $2', () => runPhase17ContinuationEvaluation(params({ maxSpendUsd: 2.01 }),
        dependencies())],
      ['an estimate above the spend ceiling', () => runPhase17ContinuationEvaluation(params({
        inputUsdPerMillionTokens: 100, outputUsdPerMillionTokens: 500 }), dependencies())],
      ['a live run without confirmed pricing', () => runPhase17ContinuationEvaluation(liveParams({
        inputUsdPerMillionTokens: null }), dependencies())],
      ['a live run without provider credentials', () => runPhase17ContinuationEvaluation(liveParams({
        env: {} }), dependencies())],
      ['a live run with incomplete labels', () => runPhase17ContinuationEvaluation(liveParams({
        labelBytes: JSON.stringify(syntheticPhase17Labels(cohort, {
          unlabeledUnitKeys: [cohort.units[0]!.unitKey] })) }), dependencies())],
      ['a live run on a dirty tree', () => runPhase17ContinuationEvaluation(liveParams({
        codeState: { commitSha: 'a'.repeat(40), treeClean: false } }), dependencies())],
      ['a live run without the real projection', () => runPhase17ContinuationEvaluation(liveParams(),
        dependencies({ projectDurableProposal: undefined }))],
      ['a live run without the real scheduler', () => runPhase17ContinuationEvaluation(liveParams(),
        dependencies({ scheduleRecovery: undefined }))],
    ];

    it.each(cases)('on %s', async (_name, start) => {
      await expect(start()).rejects.toThrow(/PHASE17_/);
    });
  });

  it('lets an incomplete label set prepare a dry run but not a live run', async () => {
    const labelBytes = JSON.stringify(syntheticPhase17Labels(cohort, {
      unlabeledUnitKeys: [cohort.units[0]!.unitKey] }));
    const dry = await runPhase17ContinuationEvaluation(params({ labelBytes }), dependencies());
    expect(dry.freeze.labelState).toBe('incomplete');
    await expect(runPhase17ContinuationEvaluation(liveParams({ labelBytes }), dependencies()))
      .rejects.toThrow(/LABELS_INCOMPLETE/);
  });
});
