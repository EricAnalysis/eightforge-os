import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const realClient = vi.hoisted(() => vi.fn(() => { throw new Error('paid calls forbidden'); }));
vi.mock('@/lib/server/ai/claudeClient', () => ({ getClaudeClient: realClient, getClaudeModel: () => 'claude-sonnet-4-6' }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => { throw new Error('database forbidden'); } }));
vi.mock('next/server', () => ({ after: () => { throw new Error('background IO forbidden'); } }));
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { buildPhase17Sonnet55PromptBetweenToolsStructuredOutputRequest as before,
  loadPhase17Sonnet55PromptBetweenToolsPrompt } from '@/lib/forgewing/runtime/phase17Sonnet55PromptBetweenToolsQualificationClient';
import {
  buildPhase17Sonnet55BehavioralPromptStructuredOutputRequest as after,
  loadPhase17Sonnet55BehavioralPromptPrompt,
} from '@/lib/forgewing/runtime/phase17Sonnet55BehavioralPromptQualificationClient';
import { PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_ACCEPTED_CONTRACT_PINS as prior } from './phase17Sonnet55PromptBetweenToolsPins';
import { computePhase17Sonnet55BehavioralPromptContractPins, PHASE17_SONNET_55_BEHAVIORAL_PROMPT_ACCEPTED_CONTRACT_PINS as accepted } from './phase17Sonnet55BehavioralPromptPins';
import { runPhase17Sonnet55BehavioralPromptEvaluation } from './phase17Sonnet55BehavioralPromptRun';
import { verifyPhase17Sonnet55BehavioralPromptCommittedRun } from './phase17Sonnet55BehavioralPromptArtifacts';
import { PHASE17_EVALUATION_ACTIVATION_ENV } from './phase17Execution';
import { syntheticPhase17Cohort, syntheticPhase17Labels } from './__fixtures__/phase17SyntheticCohort';
import { PHASE17_TEST_RUNTIME_CONFIG } from './__fixtures__/phase17MockProvider';
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
describe('additive Phase 17 behavioral-prompt request', () => {
  it('changes only system prompt bytes from v11, preserving schema and transport exactly', () => {
    const probe = { model: 'claude-sonnet-5-5', timeoutMs: 3000, maxOutputTokens: 400, inputJson: '{}' };
    const oldPrompt = loadPhase17Sonnet55PromptBetweenToolsPrompt();
    const prompt = loadPhase17Sonnet55BehavioralPromptPrompt();
    expect(prompt.startsWith(oldPrompt.trimEnd() + '\n\n')).toBe(true);
    const old = before(probe, oldPrompt), next = after(probe, prompt);
    const baseline = JSON.stringify(old);
    expect(next).toEqual({
      ...old,
      body: {
        ...old.body,
        system: prompt,
      },
    });
    expect(JSON.stringify(before(probe, oldPrompt))).toBe(baseline);
    expect(next.body).not.toHaveProperty('temperature');
    expect(next.body).not.toHaveProperty('tools');
    expect(next.body.thinking).toEqual({ type: 'between_tools' });
    expect(next.body.output_config).not.toHaveProperty('effort');
    expect(next.body.output_config.format.schema.properties.confidence).toEqual({ type: 'number' });
    expect(next.body.output_config.format.schema.properties.rationaleCode).toEqual({
      type: 'string',
      description: 'A brief rationale code containing between 1 and 200 characters.',
    });
    expect(next.body.output_config.format.schema.properties.rationaleCode).not.toHaveProperty('maxLength');
    expect(next.body.output_config.format.schema.properties.rationaleCode).not.toHaveProperty('pattern');
  });

  it('adds a general source-row decision procedure with no benchmark-specific hints', () => {
    const prompt = loadPhase17Sonnet55BehavioralPromptPrompt();
    const priorPrompt = loadPhase17Sonnet55PromptBetweenToolsPrompt();
    const addition = prompt.slice(priorPrompt.trimEnd().length + 2);
    expect(addition).toMatch(/^Use this decision procedure before selecting an ID:/);
    for (const required of ['Separate source observations from proposals', 'Determine which source row owns',
      'Semantic similarity alone', 'Only after determining ownership', 'within 1 to 200 characters including']) {
      expect(addition).toContain(required);
    }
    expect(prompt).not.toMatch(/dn-continuation-unit-|recovery-candidate-v2-[a-f0-9]|[a-f0-9]{32}|\b(?:page|p)[ -]?\d+|\b(?:DN|Golden|Hillsdale|reviewer|labels?)\b/i);
  });
  it('preserves every schema, label, qualification and authority semantic pin', () => {
    expect(computePhase17Sonnet55BehavioralPromptContractPins(process.cwd())).toEqual(accepted);
    for (const key of Object.keys(prior) as (keyof typeof prior)[]) {
      if (!['promptTemplateId', 'promptTemplateVersion', 'promptSha256', 'requestBuilderSourceSha256', 'clientSourceSha256',
        'runnerSourceSha256', 'qualificationFrameworkVersion'].includes(key)) {
        expect(accepted[key], key).toEqual(prior[key]);
      }
    }
    expect(accepted.requestContract.schemaTransformation)
      .toBe('confidence-provider-bounds-omitted-rationale-length-description-v1');
    expect(accepted.requestContract.thinking).toEqual({ type: 'between_tools' });
    expect(accepted.requestContract.bindsThinkingMode).toBe(true);
  });
  it('freezes the same 48-call cohort under the new identity with zero paid calls', async () => {
    const cohort = syntheticPhase17Cohort();
    const artifactRoot = mkdtempSync(path.join(tmpdir(), 'phase17-behavioral-prompt-')); roots.push(artifactRoot);
    const result = await runPhase17Sonnet55BehavioralPromptEvaluation({
      mode: 'dry_run', corpusBytes: new Uint8Array([1]), artifactRoot, maxCalls: null, maxSpendUsd: null,
      inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10,
    }, {
      buildCohort: async () => cohort, labelBytes: JSON.stringify(syntheticPhase17Labels(cohort)),
      repoRoot: process.cwd(), codeState: { commitSha: 'a'.repeat(40), treeClean: true }, env: {},
      runtimeConfig: { ...PHASE17_TEST_RUNTIME_CONFIG, model: 'claude-sonnet-5-5' },
    });
    expect(result.freeze.callPlan.plannedCalls).toBe(48);
    expect(result.freeze.requestIdentities).toHaveLength(48);
    expect(result.freeze.requestIdentities.map((identity) => identity.sequence))
      .toEqual(Array.from({ length: 48 }, (_, index) => index + 1));
    expect(result.freeze.requestIdentities.map((identity) => identity.inputSha256))
      .toEqual(result.freeze.callPlan.calls.map((call) => call.inputSha256));
    expect(result.freeze.requestIdentitiesSha256).toBe(hashCanonical(result.freeze.requestIdentities));
    expect(result.summary.accounting.providerInvocations).toBe(0);
    expect(result.freeze.pins.maxOutputTokens).toBe(400);
    expect(result.freeze.pins.timeoutMs).toBe(3000);
    verifyPhase17Sonnet55BehavioralPromptCommittedRun(readFileSync(result.freezePath, 'utf8'), readFileSync(result.summaryPath, 'utf8'));
    expect(realClient).not.toHaveBeenCalled();
  });
});
