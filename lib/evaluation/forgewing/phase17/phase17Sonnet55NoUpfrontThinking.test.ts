import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const realClient = vi.hoisted(() => vi.fn(() => { throw new Error('paid calls forbidden'); }));
vi.mock('@/lib/server/ai/claudeClient', () => ({ getClaudeClient: realClient, getClaudeModel: () => 'claude-sonnet-4-6' }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => { throw new Error('database forbidden'); } }));
vi.mock('next/server', () => ({ after: () => { throw new Error('background IO forbidden'); } }));
import { buildPhase17Sonnet55SchemaCompatStructuredOutputRequest as before } from '@/lib/forgewing/runtime/phase17Sonnet55SchemaCompatQualificationClient';
import { buildPhase17Sonnet55NoUpfrontThinkingStructuredOutputRequest as after } from '@/lib/forgewing/runtime/phase17Sonnet55NoUpfrontThinkingQualificationClient';
import { loadRecoveryCandidateV2Prompt } from '@/lib/forgewing/runtime/client';
import { PHASE17_SONNET_55_SCHEMA_COMPAT_ACCEPTED_CONTRACT_PINS as prior } from './phase17Sonnet55SchemaCompatPins';
import { computePhase17Sonnet55NoUpfrontThinkingContractPins, PHASE17_SONNET_55_NO_UPFRONT_THINKING_ACCEPTED_CONTRACT_PINS as accepted } from './phase17Sonnet55NoUpfrontThinkingPins';
import { runPhase17Sonnet55NoUpfrontThinkingEvaluation } from './phase17Sonnet55NoUpfrontThinkingRun';
import { verifyPhase17Sonnet55NoUpfrontThinkingCommittedRun } from './phase17Sonnet55NoUpfrontThinkingArtifacts';
import { syntheticPhase17Cohort, syntheticPhase17Labels } from './__fixtures__/phase17SyntheticCohort';
import { PHASE17_TEST_RUNTIME_CONFIG } from './__fixtures__/phase17MockProvider';
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
describe('additive Phase 17 no-upfront-thinking request', () => {
  it('adds only between_tools thinking to the compatible frozen request', () => {
    const probe = { model: 'claude-sonnet-5-5', timeoutMs: 3000, maxOutputTokens: 400, inputJson: '{}' };
    const prompt = loadRecoveryCandidateV2Prompt();
    const old = before(probe, prompt), next = after(probe, prompt);
    expect(next).toEqual({ ...old, body: { ...old.body, thinking: { type: 'between_tools' } } });
    expect(next.body).not.toHaveProperty('temperature');
    expect(next.body).not.toHaveProperty('tools');
    expect(before(probe, prompt).body).not.toHaveProperty('thinking');
  });
  it('preserves every schema, label, qualification and authority semantic pin', () => {
    expect(computePhase17Sonnet55NoUpfrontThinkingContractPins(process.cwd())).toEqual(accepted);
    for (const key of Object.keys(prior) as (keyof typeof prior)[]) {
      if (!['requestBuilderSourceSha256', 'clientSourceSha256', 'runnerSourceSha256', 'requestContract', 'qualificationFrameworkVersion'].includes(key)) {
        expect(accepted[key], key).toEqual(prior[key]);
      }
    }
    expect(accepted.requestContract.thinking).toEqual({ type: 'between_tools' });
  });
  it('freezes the same 48-call cohort under the new identity with zero paid calls', async () => {
    const cohort = syntheticPhase17Cohort();
    const artifactRoot = mkdtempSync(path.join(tmpdir(), 'phase17-no-upfront-thinking-')); roots.push(artifactRoot);
    const result = await runPhase17Sonnet55NoUpfrontThinkingEvaluation({
      mode: 'dry_run', corpusBytes: new Uint8Array([1]), artifactRoot, maxCalls: null, maxSpendUsd: null,
      inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10,
    }, {
      buildCohort: async () => cohort, labelBytes: JSON.stringify(syntheticPhase17Labels(cohort)),
      repoRoot: process.cwd(), codeState: { commitSha: 'a'.repeat(40), treeClean: true }, env: {},
      runtimeConfig: { ...PHASE17_TEST_RUNTIME_CONFIG, model: 'claude-sonnet-5-5' },
    });
    expect(result.freeze.callPlan.plannedCalls).toBe(48);
    expect(result.summary.accounting.providerInvocations).toBe(0);
    expect(result.freeze.pins.maxOutputTokens).toBe(400);
    expect(result.freeze.pins.timeoutMs).toBe(3000);
    verifyPhase17Sonnet55NoUpfrontThinkingCommittedRun(readFileSync(result.freezePath, 'utf8'), readFileSync(result.summaryPath, 'utf8'));
    expect(realClient).not.toHaveBeenCalled();
  });
});
