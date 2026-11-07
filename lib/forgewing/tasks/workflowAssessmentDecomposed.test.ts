// P2 of DECOMPOSITION-PLAN.md: the decomposed pipeline, provider-free. A fake stage provider returns stage
// outputs projected from a strictly valid canonical assessment; composition must reproduce it exactly, every
// stage must fail closed, and the composed output must pass through the same finalization as the single call.
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import { ForgewingProviderOutputError, type ForgewingProviderRequest } from '@/lib/forgewing/runtime/client';
import { WORKFLOW_ASSESSMENT_MAX_OUTPUT_TOKENS, WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS } from '@/lib/forgewing/runtime/modelConfig';
import type { WorkflowAssessmentStageCall } from '@/lib/forgewing/runtime/observedWorkflowAssessmentClient';
import { buildStageAGrammar, buildStageBGrammar, STAGE_A_FIELDS } from '@/lib/forgewing/runtime/workflowAssessmentStageGrammars';
import {
  FORGEWING_WORKFLOW_ASSESSMENT_DECOMPOSED_PROMPT_ID, loadWorkflowAssessmentStageAPrompt, loadWorkflowAssessmentStageBPrompt,
  SHARED_RULES_ANCHOR,
} from '@/lib/forgewing/runtime/workflowAssessmentStagePrompts';
import { WORKFLOW_DETERMINISM_CONDITIONS, WorkflowAssessmentModelOutputSchema } from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';
import {
  composeDecomposedWorkflowAssessment, DERIVED_DETAIL_ID_SUFFIX as S, runDecomposedWorkflowAssessment,
  WORKFLOW_ASSESSMENT_DECOMPOSED_MAX_CALLS, WORKFLOW_ASSESSMENT_STAGE_LIMITS,
} from '@/lib/forgewing/tasks/workflowAssessmentDecomposed';
import type { ForgewingWorkflowAssessmentInput } from '@/lib/forgewing/tasks/workflowAssessment';

const config = { enabled: true, model: 'fake-local-model', timeoutMs: 600_000, maxCalls: 1, maxOutputTokens: 26_000 } as const;
const input: ForgewingWorkflowAssessmentInput = {
  submissionId: 'submission-1', submissionSchemaVersion: 'workflow_intake_v1',
  answers: {
    workflowDescription: 'Reviewing contractor invoices against rate schedules.',
    documentsInvolved: 'Invoices, rate schedules, approved work orders.',
    manualChecks: 'A reviewer compares billed rates to the contract rate.',
    frequencyAndVolume: '40 packages each week, averaging 12 documents each.',
    exceptions: 'Mismatches are escalated to the project manager.',
    humanDecisions: 'Final approval of any payment adjustment.',
  },
};

// ---- A strictly valid canonical assessment whose detail IDs already follow the derivation (D-2) ----
const basis = Object.fromEntries(WORKFLOW_DETERMINISM_CONDITIONS.map((c) => [c, true]));
const support = WORKFLOW_DETERMINISM_CONDITIONS.map((condition) => ({ condition, sourceQuestion: 'manualChecks',
  sourceExcerpt: 'compares billed rates to the contract rate', rationale: `Supports ${condition}.` }));
const step = (stepId: string, classification: string) => {
  const det = classification === 'RULE' || classification === 'VERIFY';
  return { stepId, sourceQuestions: ['manualChecks'], description: `Handle ${stepId}.`, classification, rationale: 'Stated in the intake.',
    requiredInputs: ['Invoice line'], evidenceRequirements: ['Rate schedule row'], proposedOutput: 'An outcome.', dependencies: [],
    failureConsequence: 'Overbilling is paid.', unresolvedAssumptions: [], determinismBasis: det ? basis : null,
    determinismGaps: [], determinismSupport: det ? support : [] };
};
const rule = (stepId: string, suffix: string) => ({ ruleId: `${stepId}${suffix}`, stepId, plainLanguageRule: 'Billed rate must equal the contract rate.',
  requiredFacts: ['Billed rate'], conditionType: 'comparison', expectedEvidence: ['Invoice line'], expectedOutcome: 'Flag differences.',
  userDescribedExceptions: [], unresolvedAssumptions: [] });
function canonical(extraSteps = 0) {
  // Extra steps alternate HUMAN and ADVISORY so every collection stays inside its canonical bound.
  const humans = Array.from({ length: Math.ceil(extraSteps / 2) }, (_, i) => `h${i + 2}`);
  const advisories = Array.from({ length: Math.floor(extraSteps / 2) }, (_, i) => `a${i + 2}`);
  return {
    summary: 'Invoice rate verification.', documents: [{ documentId: 'doc-1', name: 'Rate schedule', role: 'Contract rates.' }],
    workflowSteps: [step('r', 'RULE'), step('v', 'VERIFY'), step('e', 'EXTRACT'), step('c', 'RECOVER'), step('h', 'HUMAN'),
      ...humans.map((h) => step(h, 'HUMAN')), step('a', 'ADVISORY'), ...advisories.map((a) => step(a, 'ADVISORY'))],
    extractionRequirements: [
      { requirementId: `e${S.extraction}`, stepId: 'e', describedFact: 'Billed rate per line.', sourceDocument: 'Invoices', deterministicExtractionPlausible: true },
      { requirementId: `c${S.extraction}`, stepId: 'c', describedFact: 'Contract rate.', sourceDocument: 'Scanned schedule', deterministicExtractionPlausible: false }],
    deterministicRuleProposals: [rule('r', S.rule)],
    evidenceRelationships: [{ relationshipId: 'rel-1', description: 'Invoices bill against the schedule.', relatedDocuments: ['Rate schedule'] }],
    verificationRuleProposals: [rule('v', S.verification)],
    forgewingRecoveryTasks: [{ taskId: `c${S.recovery}`, stepId: 'c', description: 'Recover the contract rate.', deterministicShortfall: 'The schedule is scanned.' }],
    humanDecisionPoints: ['h', ...humans].map((h) => ({ decisionId: `${h}${S.decision}`, stepId: h, description: 'Approve an adjustment.', whyHumanControlled: 'Approval authority.' })),
    advisorySteps: ['a', ...advisories].map((a) => ({ advisoryId: `${a}${S.advisory}`, stepId: a, description: 'Context for reviewers.' })),
    failureConsequences: [{ consequenceId: 'fc-1', stepId: 'r', description: 'Overpayment.', severity: 'high' }],
    limitations: ['No tolerance was stated.'],
  };
}
type Canonical = ReturnType<typeof canonical>;
const strip = (r: Record<string, unknown>, ...k: string[]) => Object.fromEntries(Object.entries(r).filter(([key]) => !k.includes(key)));
function stageAOf(x: Canonical) { return Object.fromEntries(STAGE_A_FIELDS.map((k) => [k, (x as Record<string, unknown>)[k]])); }
function recordsOf(x: Canonical): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of x.deterministicRuleProposals) out[r.stepId] = strip(r, 'ruleId', 'stepId');
  for (const r of x.verificationRuleProposals) out[r.stepId] = strip(r, 'ruleId', 'stepId');
  for (const r of x.extractionRequirements) if (r.stepId !== 'c') out[r.stepId] = strip(r, 'requirementId', 'stepId');
  out.c = { extractionRequirement: strip(x.extractionRequirements.find((r) => r.stepId === 'c')!, 'requirementId', 'stepId'),
    recoveryTask: strip(x.forgewingRecoveryTasks[0]!, 'taskId', 'stepId') };
  for (const r of x.humanDecisionPoints) out[r.stepId] = strip(r, 'decisionId', 'stepId');
  for (const r of x.advisorySteps) out[r.stepId] = strip(r, 'advisoryId', 'stepId');
  return out;
}

/** Fake stage provider: stage A returns A; stage B returns exactly the requested steps' records. */
function fakeProvider(x: Canonical, overrides: Partial<{ a: () => string; b: (ids: string[], batch: number) => string }> = {}) {
  return vi.fn(async (request: { inputJson: string }, call: WorkflowAssessmentStageCall) => {
    if (call.stage === 'A') return overrides.a ? overrides.a() : JSON.stringify(stageAOf(x));
    const ids = JSON.parse(request.inputJson).stageBStepIds as string[];
    if (overrides.b) return overrides.b(ids, call.batch);
    const all = recordsOf(x);
    return JSON.stringify(Object.fromEntries(ids.map((id) => [id, all[id]])));
  });
}
const run = (provider: ReturnType<typeof fakeProvider>, budget?: ForgewingCallBudget) =>
  runDecomposedWorkflowAssessment(input, { config, taskEnabled: true, stageProvider: provider, ...(budget ? { budget } : {}) });
const modelOutput = (assessment: Record<string, unknown>) => Object.fromEntries(Object.keys(canonical()).map((k) => [k, assessment[k]]));

describe('composition is deterministic and content-preserving', () => {
  it('reproduces the canonical assessment exactly from its two stage projections', () => {
    const x = canonical();
    expect(WorkflowAssessmentModelOutputSchema.safeParse(x).success).toBe(true);
    expect(composeDecomposedWorkflowAssessment(stageAOf(x) as never, recordsOf(x))).toEqual(x);
  });

  it('fails loudly on a missing record rather than inventing one', () => {
    const x = canonical();
    const records = recordsOf(x);
    delete records.h;
    expect(() => composeDecomposedWorkflowAssessment(stageAOf(x) as never, records)).toThrow('compose_missing_record:h');
  });
});

describe('the decomposed pipeline end to end (provider-free)', () => {
  it('produces the same non-authoritative assessment through the shared finalization', async () => {
    const x = canonical();
    const provider = fakeProvider(x);
    const result = await run(provider);
    expect(result.status).toBe('requires_human_review');
    if (result.status !== 'requires_human_review') return;
    expect(modelOutput(result.assessment as never)).toEqual(x);
    expect(result.assessment).toMatchObject({ authority: 'non_authoritative', requiresHumanReview: true });
    expect(result.metadata).toMatchObject({ promptTemplateId: FORGEWING_WORKFLOW_ASSESSMENT_DECOMPOSED_PROMPT_ID, promptTemplateVersion: 'v2', calls: 2 });
    expect(result.metadata.stageCalls?.map((c) => [c.stage, c.batch, c.steps])).toEqual([['A', 0, 0], ['B', 0, x.workflowSteps.length]]);
  });

  it('sends each stage its derived grammar, its prompt, its limits and the right payload', async () => {
    const x = canonical();
    const provider = fakeProvider(x);
    await run(provider);
    const [[reqA, callA], [reqB, callB]] = provider.mock.calls as unknown as [[ForgewingProviderRequest, WorkflowAssessmentStageCall], [ForgewingProviderRequest, WorkflowAssessmentStageCall]];
    expect(callA.grammar).toEqual(buildStageAGrammar('workflow_intake_v1'));
    expect(callA.prompt).toBe(loadWorkflowAssessmentStageAPrompt());
    expect(reqA).toMatchObject(WORKFLOW_ASSESSMENT_STAGE_LIMITS.A);
    expect(JSON.parse(reqA.inputJson)).toMatchObject({ task: 'workflow_assessment', stage: 'A', answers: input.answers });
    expect(callB.grammar).toEqual(buildStageBGrammar(x.workflowSteps.map((s) => ({ stepId: s.stepId, classification: s.classification }))));
    expect(callB.prompt).toBe(loadWorkflowAssessmentStageBPrompt());
    expect(reqB).toMatchObject(WORKFLOW_ASSESSMENT_STAGE_LIMITS.B);
    const payloadB = JSON.parse(reqB.inputJson);
    expect(payloadB).toMatchObject({ stage: 'B', stageBStepIds: x.workflowSteps.map((s) => s.stepId) });
    expect(payloadB.stageA).toEqual(stageAOf(x));
  });

  it('batches stage B above 30 steps, runs batches in parallel and composes in step order', async () => {
    const x = canonical(30); // 36 steps
    const provider = fakeProvider(x);
    const result = await run(provider);
    expect(result.status).toBe('requires_human_review');
    if (result.status !== 'requires_human_review') return;
    expect(result.metadata.calls).toBe(3);
    expect(result.metadata.stageCalls?.filter((c) => c.stage === 'B').map((c) => c.steps)).toEqual([18, 18]);
    expect(modelOutput(result.assessment as never)).toEqual(x);
  });
});

describe('every stage fails closed, before any later spend', () => {
  const x = canonical();
  const cases: [string, ReturnType<typeof fakeProvider>, string, string, number][] = [
    ['stage A provider error', fakeProvider(x, { a: () => { throw new Error('overloaded'); } }), 'provider_failed', 'stage_a_overloaded', 1],
    ['stage A timeout', fakeProvider(x, { a: () => { throw new Error('provider_timeout'); } }), 'provider_failed', 'stage_a_provider_timeout', 1],
    ['stage A truncation', fakeProvider(x, { a: () => { throw new ForgewingProviderOutputError('provider_truncated_output', '{"summ'); } }),
      'structured_output_invalid', 'stage_a_provider_truncated_output', 1],
    ['stage A invalid JSON', fakeProvider(x, { a: () => '{"summary":' }), 'structured_output_invalid', 'stage_a_invalid_json', 1],
    ['stage A over a schema bound', fakeProvider(x, { a: () => JSON.stringify({ ...stageAOf(x), summary: 'x'.repeat(2001) }) }),
      'structured_output_invalid', 'stage_a_schema_rejected', 1],
    ['stage A unknown field', fakeProvider(x, { a: () => JSON.stringify({ ...stageAOf(x), advisorySteps: [] }) }),
      'structured_output_invalid', 'stage_a_schema_rejected', 1],
    ['stage A duplicate step', fakeProvider(x, { a: () => JSON.stringify({ ...stageAOf(x), workflowSteps: [...x.workflowSteps, x.workflowSteps[0]] }) }),
      'deterministic_validation_failed', 'stage_a_duplicate_step_id', 1],
    ['stage B provider error', fakeProvider(x, { b: () => { throw new Error('overloaded'); } }), 'provider_failed', 'stage_b0_overloaded', 2],
    ['stage B missing record', fakeProvider(x, { b: (ids) => JSON.stringify(Object.fromEntries(ids.filter((i) => i !== 'h').map((i) => [i, recordsOf(x)[i]]))) }),
      'structured_output_invalid', 'stage_b0_schema_rejected', 2],
    ['stage B extra record', fakeProvider(x, { b: (ids) => JSON.stringify({ ...Object.fromEntries(ids.map((i) => [i, recordsOf(x)[i]])), ghost: recordsOf(x).h }) }),
      'structured_output_invalid', 'stage_b0_schema_rejected', 2],
    ['stage B wrong shape (recovery on VERIFY)', fakeProvider(x, { b: (ids) => JSON.stringify({ ...Object.fromEntries(ids.map((i) => [i, recordsOf(x)[i]])), v: recordsOf(x).c }) }),
      'structured_output_invalid', 'stage_b0_schema_rejected', 2],
  ];
  it.each(cases)('%s', async (_label, provider, status, reason, calls) => {
    const result = await run(provider);
    expect(result).toEqual({ status, reason });
    expect(provider).toHaveBeenCalledTimes(calls);
  });

  it('fails the whole attempt when one of two parallel batches fails', async () => {
    const big = canonical(30);
    const provider = fakeProvider(big, { b: (ids, batch) => { if (batch === 1) throw new Error('overloaded');
      return JSON.stringify(Object.fromEntries(ids.map((i) => [i, recordsOf(big)[i]]))); } });
    expect(await run(provider)).toEqual({ status: 'provider_failed', reason: 'stage_b1_overloaded' });
  });

  it('rejects a composed assessment whose derived identity breaks the canonical bound', async () => {
    const long = canonical();
    const id = 'v'.repeat(115); // 115 + "-verification" > 120
    const renamed = JSON.parse(JSON.stringify(long).replaceAll('"v"', `"${id}"`).replaceAll('"v-verification"', `"${id}-verification"`)) as Canonical;
    const provider = fakeProvider(renamed);
    expect(await run(provider)).toEqual({ status: 'structured_output_invalid', reason: 'composed_schema_rejected' });
  });

  it('applies the shared finalization unchanged (a basis on a HUMAN step is still refused)', async () => {
    const bad = canonical();
    bad.workflowSteps[4] = { ...bad.workflowSteps[4]!, determinismBasis: basis as never };
    const result = await run(fakeProvider(bad));
    expect(result.status).toBe('deterministic_validation_failed');
    expect((result as { reason: string }).reason).toContain('h:determinism_basis_on_non_deterministic_step');
  });

  it('respects the call budget: no stage B call once the budget is spent', async () => {
    const provider = fakeProvider(canonical());
    expect(await run(provider, new ForgewingCallBudget(1))).toEqual({ status: 'provider_failed', reason: 'budget_exhausted' });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('passes the shared gate through unchanged', async () => {
    const provider = fakeProvider(canonical());
    expect(await runDecomposedWorkflowAssessment(input, { config, taskEnabled: false, stageProvider: provider })).toEqual({ status: 'assessment_disabled' });
    expect(await runDecomposedWorkflowAssessment({ ...input, submissionId: ' bad ' }, { config, taskEnabled: true, stageProvider: provider }))
      .toEqual({ status: 'input_invalid', reason: 'submission_identity_closure_failed' });
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('stage limits and prompts', () => {
  it('fit inside the Workflow Assessment ceilings, with stage A and B in series within the timeout', () => {
    const { A, B } = WORKFLOW_ASSESSMENT_STAGE_LIMITS;
    expect(A.timeoutMs + B.timeoutMs).toBeLessThanOrEqual(WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS);
    expect(Math.max(A.maxOutputTokens, B.maxOutputTokens)).toBeLessThanOrEqual(WORKFLOW_ASSESSMENT_MAX_OUTPUT_TOKENS);
    expect(WORKFLOW_ASSESSMENT_DECOMPOSED_MAX_CALLS).toBe(3);
  });

  it('assemble header, schema-derived contract and the shared rules from the unchanged v7 prompt', () => {
    const v7 = readFileSync('lib/forgewing/prompts/workflowAssessment.md', 'utf8').replace(/\r\n/g, '\n');
    const rules = v7.slice(v7.indexOf(SHARED_RULES_ANCHOR)).trim();
    const a = loadWorkflowAssessmentStageAPrompt();
    const b = loadWorkflowAssessmentStageBPrompt();
    expect(a.startsWith('You are decomposing one described operational workflow')).toBe(true);
    expect(a).toContain('This request is stage A of two.');
    expect(a).toContain('- `stageA.workflowSteps[]`:');
    expect(a).toContain('determinismBasis: object or null');
    expect(a.trimEnd().endsWith(rules)).toBe(true);
    expect(b).toContain('This request is stage B of two.');
    for (const c of ['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY']) expect(b).toContain(`- \`recordByClassification.${c}\`:`);
    expect(b).toContain('deterministicExtractionPlausible: const(false) (exactly this value)');
    expect(b.trimEnd().endsWith(rules)).toBe(true);
    expect(a).not.toContain('assessmentJson');
    expect(b).not.toContain('assessmentJson');
  });
});
