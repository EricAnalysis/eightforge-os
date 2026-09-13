import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
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
import { loadRecoveryCandidateV2Prompt } from '@/lib/forgewing/runtime/client';
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
    // Mocked evidence passes every threshold yet can never support a recommendation.
    expect(outcome.summary.qualification).toMatchObject({ state: 'passed', zeroToleranceViolations: [],
      providerExecution: 'injected_mock', productionQualificationRecommendable: false,
      recommendationBlockers: ['provider_execution_not_anthropic_live'], promotionAuthorized: false,
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
      ['a spend ceiling above two dollars', () => runPhase17ContinuationEvaluation(params({ maxSpendUsd: 2.01 }),
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

  describe('exact prompt bytes (B1)', () => {
    const crlfPrompt = () => loadRecoveryCandidateV2Prompt().replace(/\n/g, '\r\n');

    it('refuses live execution when the runtime prompt carries CRLF, before any freeze or call', async () => {
      const counter = { count: 0 };
      const root = tempRoot();
      await expect(runPhase17ContinuationEvaluation(liveParams({ artifactRoot: root }),
        dependencies({ loadPrompt: crlfPrompt }, counter))).rejects.toThrow(/PROMPT_BYTES_NOT_LF/);
      expect(counter.count).toBe(0);
      expect(readdirSync(root)).toEqual([]);
    });

    it('also refuses a CRLF prompt in a dry run', async () => {
      await expect(runPhase17ContinuationEvaluation(params(), dependencies({ loadPrompt: crlfPrompt })))
        .rejects.toThrow(/PROMPT_BYTES_NOT_LF/);
    });

    it('records the digest of the exact prompt bytes that will be sent', async () => {
      const outcome = await runPhase17ContinuationEvaluation(params(), dependencies());
      expect(outcome.freeze.pins.promptSha256)
        .toBe(createHash('sha256').update(loadRecoveryCandidateV2Prompt(), 'utf8').digest('hex'));
    });
  });

  describe('request builder (M1)', () => {
    it('freezes temperature and retries read back from the production request builder', async () => {
      const outcome = await runPhase17ContinuationEvaluation(params(), dependencies());
      expect(outcome.freeze.pins.requestContract).toEqual(PHASE17_ACCEPTED_CONTRACT_PINS.requestContract);
      expect(outcome.freeze.pins.requestBuilderSourceSha256)
        .toBe(PHASE17_ACCEPTED_CONTRACT_PINS.requestBuilderSourceSha256);
    });

    it('refuses to run when the request builder no longer matches the accepted contract', async () => {
      await expect(runPhase17ContinuationEvaluation(params(), dependencies({
        acceptedContractPins: { ...PHASE17_ACCEPTED_CONTRACT_PINS,
          requestContract: { ...PHASE17_ACCEPTED_CONTRACT_PINS.requestContract, maxRetries: 2 } },
      }))).rejects.toThrow(/CONTRACT_MISMATCH.*requestContract/);
    });
  });

  describe('provider provenance (M2)', () => {
    it('marks a dry run as dry_run', async () => {
      const outcome = await runPhase17ContinuationEvaluation(params(), dependencies());
      expect(outcome.providerExecution).toBe('dry_run');
      expect(outcome.freeze.providerExecution).toBe('dry_run');
      expect(outcome.summary.providerExecution).toBe('dry_run');
    });

    it('marks an injected provider injected_mock and never recommends from its evidence', async () => {
      const outcome = await runPhase17ContinuationEvaluation(liveParams(), dependencies());
      expect(outcome.providerExecution).toBe('injected_mock');
      expect(outcome.freeze.providerExecution).toBe('injected_mock');
      expect(outcome.summary).toMatchObject({ providerExecution: 'injected_mock',
        qualification: { state: 'passed', providerExecution: 'injected_mock',
          productionQualificationRecommendable: false } });
      expect(outcome.summary.qualification.recommendationBlockers)
        .toContain('provider_execution_not_anthropic_live');
    }, 30_000);

    it('cannot pass a mock off as live even beneath the real seam', async () => {
      // The real observed seam with the Anthropic client itself replaced: the seam
      // is genuine, so provenance is anthropic_live, but the responses carry no
      // Anthropic identity and the recommendation is blocked.
      realClaudeClient.mockImplementation((() => ({ messages: { create: async (body: {
        messages: { content: string }[] }) => {
        const candidates = JSON.parse(body.messages[0]!.content).candidates;
        return { id: 'msg_mock', _request_id: 'req_mock', model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: JSON.stringify({ selectedCandidateId:
            candidates[0].candidateId, confidence: 0.5, rationaleCode: 'mock' }) }] };
      } } })) as never);
      try {
        const outcome = await runPhase17ContinuationEvaluation(liveParams(),
          dependencies({ createProvider: undefined }));
        expect(outcome.providerExecution).toBe('anthropic_live');
        expect(outcome.summary.qualification.productionQualificationRecommendable).toBe(false);
        expect(outcome.summary.qualification.recommendationBlockers)
          .toContain('provider_response_identity_unverified');
      } finally {
        realClaudeClient.mockReset();
        realClaudeClient.mockImplementation(() => {
          throw new Error('phase17 tests must not construct a real Claude client');
        });
      }
    }, 30_000);

    it('offers callers no way to declare provenance', () => {
      const runParams: Record<keyof Phase17RunParams, true> = {
        mode: true, corpusBytes: true, labelBytes: true, repoRoot: true, artifactRoot: true,
        codeState: true, env: true, maxCalls: true, maxSpendUsd: true, inputUsdPerMillionTokens: true,
        outputUsdPerMillionTokens: true, runtimeConfig: true, now: true, runNonce: true,
      };
      expect(Object.keys(runParams)).not.toContain('providerExecution');
    });
  });

  describe('raw evidence durability (M3)', () => {
    function runDirectory(root: string): string {
      const runs = readdirSync(root);
      expect(runs).toHaveLength(1);
      return path.join(root, runs[0]!);
    }

    it('keeps raw evidence of every completed call when summary generation fails', async () => {
      const root = tempRoot();
      const longModel = 'x'.repeat(300); // violates the summary schema after all 48 calls
      await expect(runPhase17ContinuationEvaluation(liveParams({ artifactRoot: root }), dependencies({
        createProvider: (observer) => {
          const inner = mockPhase17ProviderFactory(chooseAbove)((observation) =>
            observer({ ...observation, returnedModel: longModel }));
          return inner;
        },
      }))).rejects.toThrow();
      const directory = runDirectory(root);
      expect(existsSync(path.join(directory, 'freeze.json'))).toBe(true);
      expect(existsSync(path.join(directory, 'summary.json'))).toBe(false);
      const raw = JSON.parse(readFileSync(path.join(directory, 'local', 'raw.json'), 'utf8'));
      expect(raw).toMatchObject({ executionStatus: 'completed' });
      expect(raw.records).toHaveLength(48);
    }, 30_000);

    it('keeps raw evidence of the calls that completed before execution aborted', async () => {
      const root = tempRoot();
      let factories = 0;
      await expect(runPhase17ContinuationEvaluation(liveParams({ artifactRoot: root }), dependencies({
        createProvider: (observer) => {
          factories += 1;
          if (factories === 5) throw new Error('provider construction failed');
          return mockPhase17ProviderFactory(chooseAbove)(observer);
        },
      }))).rejects.toThrow('provider construction failed');
      const directory = runDirectory(root);
      expect(existsSync(path.join(directory, 'summary.json'))).toBe(false);
      const raw = JSON.parse(readFileSync(path.join(directory, 'local', 'raw.json'), 'utf8'));
      expect(raw).toMatchObject({ executionStatus: 'aborted' });
      expect(raw.records.map((record: { sequence: number }) => record.sequence)).toEqual([1, 2, 3, 4]);
    });

    it('writes raw evidence before the summary and never overwrites either', async () => {
      const outcome = await runPhase17ContinuationEvaluation(liveParams(), dependencies());
      const rawWritten = statSync(outcome.localRawPath!).mtimeMs;
      expect(rawWritten).toBeLessThanOrEqual(statSync(outcome.summaryPath).mtimeMs);
      expect(() => writeFileSync(outcome.localRawPath!, '{}', { flag: 'wx' })).toThrow();
      expect(readFileSync(outcome.localRawPath!, 'utf8')).not.toContain('ANTHROPIC_API_KEY');
      expect(readFileSync(outcome.localRawPath!, 'utf8')).not.toContain('test-only-not-a-key');
    }, 30_000);
  });
});
