import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const realClient = vi.hoisted(() => vi.fn(() => { throw new Error('paid calls forbidden'); }));
vi.mock('@/lib/server/ai/claudeClient', () => ({ getClaudeClient: realClient, getClaudeModel: () => 'claude-sonnet-4-6' }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => { throw new Error('database forbidden'); } }));
vi.mock('next/server', () => ({ after: () => { throw new Error('background IO forbidden'); } }));
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { buildPhase17Sonnet55PromptClarificationStructuredOutputRequest as before }
  from '@/lib/forgewing/runtime/phase17Sonnet55PromptClarificationQualificationClient';
import {
  buildPhase17Sonnet55BoundedRationaleStructuredOutputRequest as after,
  loadPhase17Sonnet55BoundedRationalePrompt,
} from '@/lib/forgewing/runtime/phase17Sonnet55BoundedRationaleQualificationClient';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import { runRecoveryCandidateV2Recommendation } from '@/lib/forgewing/tasks/recoveryCandidateV2';
import { PHASE17_SONNET_55_PROMPT_CLARIFICATION_ACCEPTED_CONTRACT_PINS as prior }
  from './phase17Sonnet55PromptClarificationPins';
import { computePhase17Sonnet55BoundedRationaleContractPins, PHASE17_SONNET_55_BOUNDED_RATIONALE_ACCEPTED_CONTRACT_PINS as accepted } from './phase17Sonnet55BoundedRationalePins';
import { runPhase17Sonnet55BoundedRationaleEvaluation } from './phase17Sonnet55BoundedRationaleRun';
import { verifyPhase17Sonnet55BoundedRationaleCommittedRun } from './phase17Sonnet55BoundedRationaleArtifacts';
import { PHASE17_EVALUATION_ACTIVATION_ENV } from './phase17Execution';
import { syntheticPhase17Candidates, syntheticPhase17Cohort, syntheticPhase17Labels } from './__fixtures__/phase17SyntheticCohort';
import { PHASE17_TEST_RUNTIME_CONFIG } from './__fixtures__/phase17MockProvider';
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
describe('additive Phase 17 bounded-rationale request', () => {
  it('adds only the provider-supported rationale bound to the v7 request', () => {
    const probe = { model: 'claude-sonnet-5-5', timeoutMs: 3000, maxOutputTokens: 400, inputJson: '{}' };
    const prompt = loadPhase17Sonnet55BoundedRationalePrompt();
    const old = before(probe, prompt), next = after(probe, prompt);
    const baseline = JSON.stringify(old);
    expect(next).toEqual({
      ...old,
      body: {
        ...old.body,
        output_config: {
          ...old.body.output_config,
          format: {
            ...old.body.output_config.format,
            schema: {
              ...old.body.output_config.format.schema,
              properties: {
                ...old.body.output_config.format.schema.properties,
                rationaleCode: {
                  ...old.body.output_config.format.schema.properties.rationaleCode,
                  pattern: '^[\\s\\S]{1,200}$',
                },
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(before(probe, prompt))).toBe(baseline);
    expect(next.body).not.toHaveProperty('temperature');
    expect(next.body).not.toHaveProperty('tools');
    expect(next.body.thinking).toEqual({ type: 'adaptive' });
    expect(next.body.output_config.effort).toBe('low');
    expect(next.body.output_config.format.schema.properties.confidence).toEqual({ type: 'number' });
    expect(next.body.output_config.format.schema.properties.rationaleCode).toEqual({
      type: 'string',
      description: 'A brief rationale code containing between 1 and 200 characters.',
      pattern: '^[\\s\\S]{1,200}$',
    });
    expect(next.body.output_config.format.schema.properties.rationaleCode).not.toHaveProperty('maxLength');
    const pattern = new RegExp(next.body.output_config.format.schema.properties.rationaleCode.pattern);
    expect(pattern.test('')).toBe(false);
    expect(pattern.test('x'.repeat(200))).toBe(true);
    expect(pattern.test('x'.repeat(201))).toBe(false);
    expect(pattern.test('line one\nline two')).toBe(true);
  });

  it.each([
    ['', 'structured_output_invalid'],
    ['line one\nline two', 'requires_human_review'],
    ['x'.repeat(200), 'requires_human_review'],
    ['x'.repeat(201), 'structured_output_invalid'],
  ] as const)('retains local rationale validation for length %s', async (rationaleCode, status) => {
    const candidates = syntheticPhase17Candidates().slice(0, 2);
    const result = await runRecoveryCandidateV2Recommendation({
      organizationId: '60000000-0000-4000-8000-000000000001',
      extractionSnapshotId: '60000000-0000-4000-8000-000000000002',
      candidates,
    }, {
      config: { ...PHASE17_TEST_RUNTIME_CONFIG, model: 'claude-sonnet-5-5', enabled: true },
      env: PHASE17_EVALUATION_ACTIVATION_ENV,
      budget: new ForgewingCallBudget(1),
      provider: async () => JSON.stringify({
        selectedCandidateId: candidates[0]!.candidateId,
        confidence: 0.5,
        rationaleCode,
      }),
    });
    expect(result.status).toBe(status);
    expect(realClient).not.toHaveBeenCalled();
  });
  it('preserves every schema, label, qualification and authority semantic pin', () => {
    expect(computePhase17Sonnet55BoundedRationaleContractPins(process.cwd())).toEqual(accepted);
    for (const key of Object.keys(prior) as (keyof typeof prior)[]) {
      if (!['outputSchemaSha256', 'requestBuilderSourceSha256', 'clientSourceSha256',
        'runnerSourceSha256', 'requestContract', 'qualificationFrameworkVersion'].includes(key)) {
        expect(accepted[key], key).toEqual(prior[key]);
      }
    }
    expect(accepted.requestContract.schemaTransformation)
      .toBe('confidence-provider-bounds-omitted-rationale-pattern-bounded-v1');
    expect(accepted.requestContract.thinking).toEqual(prior.requestContract.thinking);
    expect(accepted.requestContract.bindsEffort).toBe(true);
  });
  it('freezes the same 48-call cohort under the new identity with zero paid calls', async () => {
    const cohort = syntheticPhase17Cohort();
    const artifactRoot = mkdtempSync(path.join(tmpdir(), 'phase17-bounded-rationale-')); roots.push(artifactRoot);
    const result = await runPhase17Sonnet55BoundedRationaleEvaluation({
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
    verifyPhase17Sonnet55BoundedRationaleCommittedRun(readFileSync(result.freezePath, 'utf8'), readFileSync(result.summaryPath, 'utf8'));
    expect(realClient).not.toHaveBeenCalled();
  });
});
