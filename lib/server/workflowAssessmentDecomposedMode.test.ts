// P4 of DECOMPOSITION-PLAN.md: the server seam in decomposed mode. The REAL single-call and decomposed tasks
// run; only the database client and the observed providers are faked. Proves the mode is opt-in, persistence
// happens only after the strict final validation, every provider call gets its own durable ledger row with its
// own outcome (so partial-stage failures are recorded call by call), and intake is never written.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  admin: null as unknown,
  singleCalls: 0,
  stageCalls: [] as { stage: string; batch: number }[],
  singleOutput: '' as string,
  stageOutput: (_call: { stage: string; batch: number }, _inputJson: string): string | Promise<string> => '',
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => fake.admin }));
vi.mock('@/lib/forgewing/runtime/observedWorkflowAssessmentClient', () => ({
  createObservedWorkflowAssessmentProvider: (observer: (o: Record<string, unknown>) => void) => async () => {
    fake.singleCalls += 1;
    observer({ requestId: 'req_single', returnedModel: 'claude-sonnet-4-6', stopReason: 'end_turn', inputTokens: 12000, outputTokens: 18000, latencyMs: 300000 });
    return fake.singleOutput;
  },
  createObservedWorkflowAssessmentStageProvider: (observer: (o: Record<string, unknown>, c: { stage: string; batch: number }) => void) =>
    async (request: { inputJson: string }, call: { stage: string; batch: number }) => {
      fake.stageCalls.push({ stage: call.stage, batch: call.batch });
      const output = await fake.stageOutput(call, request.inputJson); // may throw or stay pending, like a provider
      observer({ requestId: `req_${call.stage}${call.batch}`, returnedModel: 'claude-sonnet-4-6', stopReason: 'end_turn',
        inputTokens: call.stage === 'A' ? 14000 : 20000, outputTokens: call.stage === 'A' ? 14000 : 4000, latencyMs: call.stage === 'A' ? 260000 : 130000 }, call);
      return output;
    },
}));

import { WORKFLOW_DETERMINISM_CONDITIONS } from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';
import { STAGE_A_FIELDS } from '@/lib/forgewing/runtime/workflowAssessmentStageGrammars';
import { DERIVED_DETAIL_ID_SUFFIX as S } from '@/lib/forgewing/tasks/workflowAssessmentDecomposed';
import { runAndRecordWorkflowAssessment, WORKFLOW_ASSESSMENT_TABLE } from '@/lib/server/workflowAssessment';

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';
const intakeRow = {
  id: SUBMISSION_ID, schema_version: 'workflow_intake_v1',
  workflow_description: 'Reviewing contractor invoices against rate schedules.',
  documents_involved: 'Invoices, rate schedules, approved work orders.',
  manual_checks: 'A reviewer compares billed rates to the contract rate.',
  frequency_and_volume: '40 packages each week.', exceptions: 'Mismatches escalate to the project manager.',
  human_decisions: 'Final approval of any payment adjustment.', submitted_at: '2026-08-30T00:00:00.000Z',
};

function fakeAdmin() {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const from = vi.fn((table: string) => ({
    insert: vi.fn(async (row: Record<string, unknown>) => { inserts.push({ table, row }); return { error: null }; }),
    select: () => { const chain = { eq: () => chain, order: () => chain, limit: async () => ({ data: [], error: null }) }; return chain; },
  }));
  const rpc = vi.fn(async () => ({ data: [intakeRow], error: null }));
  return { admin: { from, rpc } as never, inserts, from };
}

// ---- A strictly valid canonical assessment (detail IDs already derived) and its stage projections ----
const basis = Object.fromEntries(WORKFLOW_DETERMINISM_CONDITIONS.map((c) => [c, true]));
const support = WORKFLOW_DETERMINISM_CONDITIONS.map((condition) => ({ condition, sourceQuestion: 'manualChecks',
  sourceExcerpt: 'compares billed rates to the contract rate', rationale: `Supports ${condition}.` }));
const step = (stepId: string, classification: string, extra: Record<string, unknown> = {}) => {
  const det = classification === 'RULE';
  return { stepId, sourceQuestions: ['manualChecks'], description: `Handle ${stepId}.`, classification, rationale: 'Stated.',
    requiredInputs: [], evidenceRequirements: [], proposedOutput: 'An outcome.', dependencies: [], failureConsequence: 'A consequence.',
    unresolvedAssumptions: [], determinismBasis: det ? basis : null, determinismGaps: [], determinismSupport: det ? support : [], ...extra };
};
const canonical = (humanExtra: Record<string, unknown> = {}) => ({
  summary: 'Invoice rate verification.', documents: [],
  workflowSteps: [step('r', 'RULE'), step('h', 'HUMAN', humanExtra), step('a', 'ADVISORY')],
  extractionRequirements: [],
  deterministicRuleProposals: [{ ruleId: `r${S.rule}`, stepId: 'r', plainLanguageRule: 'Billed rate must equal the contract rate.',
    requiredFacts: ['Billed rate'], conditionType: 'comparison', expectedEvidence: ['Invoice line'], expectedOutcome: 'Flag differences.',
    userDescribedExceptions: [], unresolvedAssumptions: [] }],
  evidenceRelationships: [], verificationRuleProposals: [], forgewingRecoveryTasks: [],
  humanDecisionPoints: [{ decisionId: `h${S.decision}`, stepId: 'h', description: 'Approve an adjustment.', whyHumanControlled: 'Approval authority.' }],
  advisorySteps: [{ advisoryId: `a${S.advisory}`, stepId: 'a', description: 'x'.repeat(650) }], // D-6: 401-800 accepted
  failureConsequences: [], limitations: [],
});
const strip = (r: Record<string, unknown>, ...k: string[]) => Object.fromEntries(Object.entries(r).filter(([key]) => !k.includes(key)));
function stageOutputs(x: ReturnType<typeof canonical>) {
  const a = JSON.stringify(Object.fromEntries(STAGE_A_FIELDS.map((k) => [k, (x as Record<string, unknown>)[k]])));
  const records: Record<string, unknown> = {
    r: strip(x.deterministicRuleProposals[0]!, 'ruleId', 'stepId'),
    h: strip(x.humanDecisionPoints[0]!, 'decisionId', 'stepId'),
    a: strip(x.advisorySteps[0]!, 'advisoryId', 'stepId'),
  };
  return { a, records };
}
const useStages = (x: ReturnType<typeof canonical>, b?: (records: Record<string, unknown>) => Record<string, unknown>) => {
  const { a, records } = stageOutputs(x);
  fake.stageOutput = (call) => (call.stage === 'A' ? a : JSON.stringify(b ? b(records) : records));
};
const ledgerRows = (inserts: { table: string; row: Record<string, unknown> }[]) =>
  inserts.filter((i) => i.table === 'forgewing_provider_call_observations').map((i) => i.row);
const assessmentRows = (inserts: { table: string; row: Record<string, unknown> }[]) =>
  inserts.filter((i) => i.table === WORKFLOW_ASSESSMENT_TABLE).map((i) => i.row);

beforeEach(() => {
  vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
  vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_ENABLED', '1');
  vi.stubEnv('FORGEWING_MODEL', 'claude-sonnet-4-6');
  fake.singleCalls = 0;
  fake.stageCalls = [];
  fake.singleOutput = JSON.stringify({ assessmentJson: JSON.stringify(canonical()) });
});
afterEach(() => vi.unstubAllEnvs());

describe('generation mode is opt-in (not activated by default)', () => {
  it.each([[undefined], ['single_call'], ['Decomposed'], ['decomposed ']])('mode %s keeps the single-call path', async (mode) => {
    if (mode !== undefined) vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_GENERATION', mode);
    const db = fakeAdmin(); fake.admin = db.admin;
    await expect(runAndRecordWorkflowAssessment(SUBMISSION_ID)).resolves.toMatchObject({ status: 'assessment_recorded' });
    expect(fake.singleCalls).toBe(1);
    expect(fake.stageCalls).toEqual([]);
    expect(assessmentRows(db.inserts)[0]).toMatchObject({ prompt_template_id: 'forgewing-workflow-assessment', prompt_template_version: 'v8' });
    expect(ledgerRows(db.inserts)).toHaveLength(1);
  });

  it('never runs either path when assessment itself is disabled', async () => {
    vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_GENERATION', 'decomposed');
    vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_ENABLED', '0');
    const db = fakeAdmin(); fake.admin = db.admin;
    await expect(runAndRecordWorkflowAssessment(SUBMISSION_ID)).resolves.toEqual({ status: 'assessment_not_produced', reason: 'assessment_disabled' });
    expect(fake.singleCalls + fake.stageCalls.length).toBe(0);
    expect(db.inserts).toEqual([]);
  });
});

describe('decomposed mode through the server seam', () => {
  beforeEach(() => vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_GENERATION', 'decomposed'));

  it('persists only the strictly validated assessment, with one ledger row per stage call', async () => {
    const db = fakeAdmin(); fake.admin = db.admin;
    useStages(canonical());
    await expect(runAndRecordWorkflowAssessment(SUBMISSION_ID)).resolves.toMatchObject({ status: 'assessment_recorded', authority: 'non_authoritative' });
    expect(fake.singleCalls).toBe(0);
    expect(fake.stageCalls).toEqual([{ stage: 'A', batch: 0 }, { stage: 'B', batch: 0 }]);
    const [row] = assessmentRows(db.inserts);
    expect(row).toMatchObject({ prompt_template_id: 'forgewing-workflow-assessment-decomposed', prompt_template_version: 'v1',
      authority: 'non_authoritative', requires_human_review: true, review_status: 'pending_human_review' });
    expect((row!.assessment as { advisorySteps: { description: string }[] }).advisorySteps[0]!.description).toHaveLength(650);
    expect(ledgerRows(db.inserts).map((r) => [r.provider_request_id, r.outcome, r.input_tokens, r.output_tokens]))
      .toEqual([['req_A0', 'succeeded', 14000, 14000], ['req_B0', 'succeeded', 20000, 4000]]);
    expect(db.from).not.toHaveBeenCalledWith('workflow_intake_submissions');
  });

  it('records a partial-stage failure call by call and persists nothing', async () => {
    const db = fakeAdmin(); fake.admin = db.admin;
    useStages(canonical(), (records) => strip(records, 'h')); // stage B omits a record
    await expect(runAndRecordWorkflowAssessment(SUBMISSION_ID)).resolves.toEqual({ status: 'assessment_not_produced', reason: 'structured_output_invalid' });
    expect(assessmentRows(db.inserts)).toEqual([]);
    expect(ledgerRows(db.inserts).map((r) => [r.provider_request_id, r.outcome])).toEqual([['req_A0', 'succeeded'], ['req_B0', 'output_invalid']]);
  });

  it('stops after a stage A provider failure: one ledger row, no stage B spend, nothing persisted', async () => {
    const db = fakeAdmin(); fake.admin = db.admin;
    fake.stageOutput = () => { throw new Error('overloaded'); };
    await expect(runAndRecordWorkflowAssessment(SUBMISSION_ID)).resolves.toEqual({ status: 'assessment_not_produced', reason: 'provider_failed' });
    expect(fake.stageCalls).toEqual([{ stage: 'A', batch: 0 }]);
    expect(ledgerRows(db.inserts).map((r) => r.outcome)).toEqual(['provider_failed']);
    expect(assessmentRows(db.inserts)).toEqual([]);
  });

  it('a composed answer that fails the shared final validation persists nothing; calls keep their stage-level outcomes', async () => {
    const db = fakeAdmin(); fake.admin = db.admin;
    useStages(canonical({ determinismBasis: basis })); // a basis on a HUMAN step is refused by finalization
    await expect(runAndRecordWorkflowAssessment(SUBMISSION_ID)).resolves.toEqual({ status: 'assessment_not_produced', reason: 'deterministic_validation_failed' });
    // Each row was written when its call settled, with that stage's own verdict (both stage outputs were
    // strictly valid). The rejection is an attempt-level outcome; it never relabels already-recorded rows.
    expect(ledgerRows(db.inserts).map((r) => [r.provider_request_id, r.outcome])).toEqual([['req_A0', 'succeeded'], ['req_B0', 'succeeded']]);
    expect(assessmentRows(db.inserts)).toEqual([]);
  });

  it('bounds provider calls and wall clock: ≤3 calls per attempt, ≤6 per submission, stages inside the route budget', async () => {
    const { readFileSync } = await import('node:fs');
    const { WORKFLOW_ASSESSMENT_MAX_ATTEMPTS } = await import('@/lib/server/workflowAssessmentClaim');
    const { WORKFLOW_ASSESSMENT_DECOMPOSED_MAX_CALLS, WORKFLOW_ASSESSMENT_STAGE_LIMITS } = await import('@/lib/forgewing/tasks/workflowAssessmentDecomposed');
    const { WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS } = await import('@/lib/forgewing/runtime/modelConfig');
    expect(WORKFLOW_ASSESSMENT_DECOMPOSED_MAX_CALLS).toBe(3); // stage A + at most two stage B batches (40 steps, 30 per batch)
    expect(WORKFLOW_ASSESSMENT_MAX_ATTEMPTS * WORKFLOW_ASSESSMENT_DECOMPOSED_MAX_CALLS).toBe(6); // lifetime ceiling per submission
    // Stage B batches run in parallel, so one attempt's provider time is bounded by A + B in series.
    const attemptMs = WORKFLOW_ASSESSMENT_STAGE_LIMITS.A.timeoutMs + WORKFLOW_ASSESSMENT_STAGE_LIMITS.B.timeoutMs;
    expect(attemptMs).toBeLessThanOrEqual(WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS);
    for (const route of ['app/api/internal/workflow-assessment/route.ts', 'app/api/internal/workflow-assessment-sweep/route.ts']) {
      const maxDuration = Number(/export const maxDuration = (\d+);/.exec(readFileSync(route, 'utf8'))?.[1]);
      // At least 60 s left for the claim, telemetry, strict validation, persistence and finalization.
      expect(attemptMs + 60_000, route).toBeLessThanOrEqual(maxDuration * 1000);
    }
  });

  it('records stage A durably before stage B settles, so an attempt cut off during stage B keeps its accounting', async () => {
    const db = fakeAdmin(); fake.admin = db.admin;
    const { a } = stageOutputs(canonical());
    let releaseB!: (value: string) => void;
    const pendingB = new Promise<string>((resolve) => { releaseB = resolve; });
    fake.stageOutput = (call) => (call.stage === 'A' ? a : pendingB); // stage B never answers until released
    const run = runAndRecordWorkflowAssessment(SUBMISSION_ID);
    await vi.waitFor(() => expect(fake.stageCalls).toEqual([{ stage: 'A', batch: 0 }, { stage: 'B', batch: 0 }]));
    // Stage B is still in flight: the paid stage A call is already in the ledger, and nothing is persisted.
    expect(ledgerRows(db.inserts).map((r) => [r.provider_request_id, r.outcome])).toEqual([['req_A0', 'succeeded']]);
    expect(assessmentRows(db.inserts)).toEqual([]);
    releaseB('{not json');
    await expect(run).resolves.toEqual({ status: 'assessment_not_produced', reason: 'structured_output_invalid' });
    expect(ledgerRows(db.inserts).map((r) => [r.provider_request_id, r.outcome])).toEqual([['req_A0', 'succeeded'], ['req_B0', 'output_invalid']]);
    expect(assessmentRows(db.inserts)).toEqual([]);
  });

  it('still rejects an advisory description above the 800-character contract', async () => {
    const db = fakeAdmin(); fake.admin = db.admin;
    const x = canonical(); x.advisorySteps[0]!.description = 'x'.repeat(801);
    useStages(x);
    await expect(runAndRecordWorkflowAssessment(SUBMISSION_ID)).resolves.toEqual({ status: 'assessment_not_produced', reason: 'structured_output_invalid' });
    expect(assessmentRows(db.inserts)).toEqual([]);
  });
});
