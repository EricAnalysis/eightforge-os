import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const realClaudeClient = vi.hoisted(() => vi.fn(() => {
  throw new Error('Sonnet 5.5 qualification tests must not construct a real Claude client');
}));
const supabaseAdmin = vi.hoisted(() => vi.fn(() => {
  throw new Error('Sonnet 5.5 qualification tests must not construct a database client');
}));
vi.mock('@/lib/server/ai/claudeClient', () => ({
  getClaudeClient: realClaudeClient,
  getClaudeModel: () => 'claude-sonnet-4-6',
}));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: supabaseAdmin }));
vi.mock('next/server', () => ({ after: (task: () => Promise<void>) => { void task(); } }));

import { verifyPhase17Sonnet55CommittedRun }
  from '@/lib/evaluation/forgewing/phase17/phase17Sonnet55Artifacts';
import {
  PHASE17_SONNET_55_ACCEPTED_CONTRACT_PINS,
  computePhase17Sonnet55ContractPins,
} from '@/lib/evaluation/forgewing/phase17/phase17Sonnet55Pins';
import {
  runPhase17Sonnet55ContinuationEvaluation,
  type Phase17RunDependencies,
  type Phase17RunParams,
} from '@/lib/evaluation/forgewing/phase17/phase17Sonnet55Run';
import {
  syntheticPhase17Cohort,
  syntheticPhase17Labels,
} from '@/lib/evaluation/forgewing/phase17/__fixtures__/phase17SyntheticCohort';
import { PHASE17_TEST_RUNTIME_CONFIG }
  from '@/lib/evaluation/forgewing/phase17/__fixtures__/phase17MockProvider';
import {
  buildPhase17Sonnet55StructuredOutputRequest,
} from '@/lib/forgewing/runtime/phase17Sonnet55QualificationClient';
import { loadRecoveryCandidateV2Prompt } from '@/lib/forgewing/runtime/client';

const cohort = syntheticPhase17Cohort();
const roots: string[] = [];
const root = () => { const value = mkdtempSync(path.join(tmpdir(), 'phase17-sonnet-55-')); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

const params = (): Phase17RunParams => ({ mode: 'dry_run', corpusBytes: new Uint8Array([1]), artifactRoot: root(),
  maxCalls: null, maxSpendUsd: null, inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 });
const dependencies = (model = 'claude-sonnet-5-5'): Phase17RunDependencies => ({
  buildCohort: async () => cohort,
  labelBytes: JSON.stringify(syntheticPhase17Labels(cohort)),
  repoRoot: process.cwd(),
  codeState: { commitSha: 'a'.repeat(40), treeClean: true },
  env: {},
  runtimeConfig: { ...PHASE17_TEST_RUNTIME_CONFIG, model },
});

describe('additive Phase 17 Sonnet 5.5 qualification path', () => {
  it('freezes an isolated v2 dry run with omitted-temperature provenance and zero calls', async () => {
    const outcome = await runPhase17Sonnet55ContinuationEvaluation(params(), dependencies());
    expect(outcome.runId).toMatch(/^phase17-sonnet-5-5-/);
    expect(outcome.freeze).toMatchObject({
      freezeVersion: 'phase17-continuation-freeze-v2-sonnet-5-5',
      evaluationVersion: 'phase17-continuation-eval-v2-sonnet-5-5',
      promotionAuthorized: false,
      pins: { model: 'claude-sonnet-5-5', sampling: { temperature: { state: 'omitted' } },
        qualificationFrameworkVersion: 'phase17-continuation-qualification-contract-v2-sonnet-5-5' },
    });
    expect(outcome.summary.accounting.providerInvocations).toBe(0);
    expect(outcome.summary.qualification.state).toBe('not_run');
    expect(outcome.localRawPath).toBeNull();
    expect(outcome.freezePath).toContain('phase17-sonnet-5-5-');
    verifyPhase17Sonnet55CommittedRun(readFileSync(outcome.freezePath, 'utf8'), readFileSync(outcome.summaryPath, 'utf8'));
    expect(JSON.parse(readFileSync(outcome.artifactManifestPath, 'utf8'))).toMatchObject({
      model: 'claude-sonnet-5-5',
      sampling: { temperature: { state: 'omitted' } },
      resultArtifactDigest: outcome.resultArtifactDigest,
    });
    expect(realClaudeClient).not.toHaveBeenCalled();
    expect(supabaseAdmin).not.toHaveBeenCalled();
  });

  it('rejects the Sonnet 4.6 runtime before any provider construction', async () => {
    await expect(runPhase17Sonnet55ContinuationEvaluation(params(), dependencies('claude-sonnet-4-6')))
      .rejects.toThrow('MODEL_MISMATCH');
    expect(realClaudeClient).not.toHaveBeenCalled();
  });

  it('pins a distinct request builder that omits temperature and reuses the frozen semantics', () => {
    const request = buildPhase17Sonnet55StructuredOutputRequest({ model: 'claude-sonnet-5-5', timeoutMs: 3000,
      maxOutputTokens: 400, inputJson: '{}' }, loadRecoveryCandidateV2Prompt());
    expect(Object.prototype.hasOwnProperty.call(request.body, 'temperature')).toBe(false);
    expect(request.body.model).toBe('claude-sonnet-5-5');
    expect(Object.keys(request.body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(computePhase17Sonnet55ContractPins(process.cwd())).toEqual(PHASE17_SONNET_55_ACCEPTED_CONTRACT_PINS);
  });

  it('leaves every frozen Phase 17 v1 source byte unchanged', () => {
    const expected: Record<string, string> = {
      'lib/evaluation/forgewing/phase17/phase17Contract.ts': '9fbf32156840ca300141804c2af8d3503c92fbc72b72eaf88e2125e025dd205d',
      'lib/evaluation/forgewing/phase17/phase17Pins.ts': '72cfa796d97b412c369a7a26b28a23f56e78a3c50591244848defc61d02a3a5e',
      'lib/evaluation/forgewing/phase17/phase17Run.ts': '575837d5f2f1066f208713c3d87784b34317cebd256676f30681f77e2c53559b',
      'lib/evaluation/forgewing/phase17/phase17Artifacts.ts': 'b614b4d28abe90e092df10b6d6d86f2a34f74ffaab1d682e50052259ae8a8cae',
      'lib/forgewing/runtime/client.ts': 'a45b4647e41393e353c3c184645dd3805814ac7083d3ab29819c691b4713d354',
    };
    for (const [file, digest] of Object.entries(expected)) {
      expect(createHash('sha256').update(readFileSync(file)).digest('hex'), file).toBe(digest);
    }
  });
});
