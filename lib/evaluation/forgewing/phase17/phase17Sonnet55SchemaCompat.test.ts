import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const realClient = vi.hoisted(() => vi.fn(() => { throw new Error('paid calls forbidden'); }));
vi.mock('@/lib/server/ai/claudeClient', () => ({ getClaudeClient: realClient, getClaudeModel: () => 'claude-sonnet-4-6' }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => { throw new Error('database forbidden'); } }));
vi.mock('next/server', () => ({ after: () => { throw new Error('background IO forbidden'); } }));

import { buildPhase17Sonnet55StructuredOutputRequest as oldRequest } from '@/lib/forgewing/runtime/phase17Sonnet55QualificationClient';
import { buildPhase17Sonnet55SchemaCompatStructuredOutputRequest as newRequest } from '@/lib/forgewing/runtime/phase17Sonnet55SchemaCompatQualificationClient';
import { runRecoveryCandidateV2Recommendation } from '@/lib/forgewing/tasks/recoveryCandidateV2';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import { loadRecoveryCandidateV2Prompt } from '@/lib/forgewing/runtime/client';
import { PHASE17_EVALUATION_ACTIVATION_ENV } from './phase17Execution';
import { PHASE17_TEST_RUNTIME_CONFIG } from './__fixtures__/phase17MockProvider';
import { syntheticPhase17Candidates, syntheticPhase17Cohort, syntheticPhase17Labels } from './__fixtures__/phase17SyntheticCohort';
import { runPhase17Sonnet55ContinuationEvaluation as oldRun } from './phase17Sonnet55Run';
import { runPhase17Sonnet55SchemaCompatEvaluation as newRun } from './phase17Sonnet55SchemaCompatRun';
import { verifyPhase17Sonnet55CommittedRun, writePhase17Sonnet55Freeze } from './phase17Sonnet55Artifacts';
import { PHASE17_SONNET_55_ACCEPTED_CONTRACT_PINS as prior } from './phase17Sonnet55OwnerLabelPins';
import { computePhase17Sonnet55SchemaCompatContractPins, PHASE17_SONNET_55_SCHEMA_COMPAT_ACCEPTED_CONTRACT_PINS as accepted } from './phase17Sonnet55SchemaCompatPins';
import { hashCanonical } from '@/lib/extraction/domain/hash';

const roots: string[] = [];
const root = () => { const p = mkdtempSync(path.join(tmpdir(), 'phase17-schema-compat-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('owner-approved additive Phase 17 schema compatibility', () => {
  it('changes only transmitted confidence bounds; preserves request parameters and original schema', () => {
    const probe = { model: 'claude-sonnet-5-5', timeoutMs: 3000, maxOutputTokens: 400, inputJson: '{}' };
    const prompt = loadRecoveryCandidateV2Prompt();
    const before = oldRequest(probe, prompt), after = newRequest(probe, prompt);
    const baseline = JSON.stringify(before);
    expect(after.body.output_config.format.schema.properties.confidence).toEqual({ type: 'number' });
    const expected = JSON.parse(baseline);
    delete expected.body.output_config.format.schema.properties.confidence.minimum;
    delete expected.body.output_config.format.schema.properties.confidence.maximum;
    expect(after).toEqual(expected);
    expect(JSON.stringify(oldRequest(probe, prompt))).toBe(baseline);
    expect(after.body).not.toHaveProperty('temperature');
    expect(after.body).not.toHaveProperty('thinking');
    expect(hashCanonical(after)).not.toBe(hashCanonical(before));
  });

  it.each([-0.01, 1.01, 0, 1])('retains actual task confidence validation at %s', async confidence => {
    const candidates = syntheticPhase17Candidates().slice(0, 2);
    const result = await runRecoveryCandidateV2Recommendation({
      organizationId: '60000000-0000-4000-8000-000000000001',
      extractionSnapshotId: '60000000-0000-4000-8000-000000000002', candidates,
    }, {
      config: { ...PHASE17_TEST_RUNTIME_CONFIG, model: 'claude-sonnet-5-5', enabled: true },
      env: PHASE17_EVALUATION_ACTIVATION_ENV,
      budget: new ForgewingCallBudget(1),
      provider: async () => JSON.stringify({ selectedCandidateId: candidates[0]!.candidateId, confidence, rationaleCode: 'source_match' }),
    });
    expect(result.status).toBe(confidence < 0 || confidence > 1 ? 'structured_output_invalid' : 'requires_human_review');
    expect(realClient).not.toHaveBeenCalled();
  });

  it('pins only the approved schema/request/framework and additive source identities', () => {
    expect(computePhase17Sonnet55SchemaCompatContractPins(process.cwd())).toEqual(accepted);
    const changed = ['outputSchemaSha256', 'requestBuilderSourceSha256', 'clientSourceSha256', 'runnerSourceSha256', 'requestContract', 'qualificationFrameworkVersion'];
    for (const key of Object.keys(prior) as (keyof typeof prior)[]) {
      if (!changed.includes(key)) expect(accepted[key], key).toEqual(prior[key]);
    }
    expect(accepted.requestContract.schemaTransformation).toBe('confidence-provider-bounds-omitted-local-bounds-preserved-v1');
  });

  it('prepares with zero calls and preserves readable, write-once historical artifacts', async () => {
    const cohort = syntheticPhase17Cohort();
    const dependencies = {
      buildCohort: async () => cohort, labelBytes: JSON.stringify(syntheticPhase17Labels(cohort)),
      repoRoot: process.cwd(), codeState: { commitSha: 'a'.repeat(40), treeClean: true }, env: {},
      runtimeConfig: { ...PHASE17_TEST_RUNTIME_CONFIG, model: 'claude-sonnet-5-5' },
    };
    const controls = { mode: 'dry_run' as const, corpusBytes: new Uint8Array([1]), artifactRoot: root(),
      maxCalls: null, maxSpendUsd: null, inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10 };
    const previous = await oldRun(controls, dependencies);
    const bytes = readFileSync(previous.freezePath, 'utf8');
    const next = await newRun({ ...controls, artifactRoot: root() }, dependencies);
    expect(next.summary.accounting.providerInvocations).toBe(0);
    expect(next.freeze.callPlan.plannedCalls).toBe(previous.freeze.callPlan.plannedCalls);
    expect(next.freeze.pins.labelSetSha256).toBe(previous.freeze.pins.labelSetSha256);
    expect(next.freeze.pins.qualificationSemanticsSha256).toBe(previous.freeze.pins.qualificationSemanticsSha256);
    expect(next.runId).toMatch(/^phase17-sonnet-5-5-schema-compat-/);
    expect(() => writePhase17Sonnet55Freeze(controls.artifactRoot, previous.freeze)).toThrow();
    expect(readFileSync(previous.freezePath, 'utf8')).toBe(bytes);
    verifyPhase17Sonnet55CommittedRun(bytes, readFileSync(previous.summaryPath, 'utf8'));
    expect(realClient).not.toHaveBeenCalled();
  });
});
