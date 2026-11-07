// D4 grounding correction (prompt v6). The prompt now states seven exact-quotation rules for determinism
// support. These tests pin the rules in the prompt the providers send, and prove each rule describes how the
// unchanged validator already behaves: following a rule can earn grounding, breaking it never does.
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { loadObservedWorkflowAssessmentPrompt } from '@/lib/forgewing/runtime/observedWorkflowAssessmentClient';
import { buildWorkflowAssessmentFieldContract } from '@/lib/forgewing/runtime/workflowAssessmentFieldContract';
import {
  WORKFLOW_ASSESSMENT_ENVELOPE_PROMPT_VERSION,
  WORKFLOW_DETERMINISM_CONDITIONS,
} from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';
import {
  runForgewingWorkflowAssessment,
  type ForgewingWorkflowAssessmentInput,
} from '@/lib/forgewing/tasks/workflowAssessment';

const prompt = readFileSync('lib/forgewing/prompts/workflowAssessment.md', 'utf8').replace(/\r\n/g, '\n');

describe('v8 prompt states the exact-quotation grounding rules', () => {
  it('is v8, and both providers send it', () => {
    expect(WORKFLOW_ASSESSMENT_ENVELOPE_PROMPT_VERSION).toBe('v8');
    expect(loadObservedWorkflowAssessmentPrompt().replace(/\r\n/g, '\n')).toBe(prompt);
  });

  it.each([
    ['1: copied character for character from the named answer', 'Copy every sourceExcerpt character for character from the intake answer named by its sourceQuestion.'],
    ['2: capitalization, punctuation, spacing and wording preserved', 'Preserve capitalization (including the first letter), punctuation, spacing and exact wording.'],
    ['3: sourceQuestion names the answer that contains the excerpt', 'Set sourceQuestion to the intake question whose answer actually contains the excerpt'],
    ['4: every cited question listed in the step sourceQuestions', "Every question cited by a determinismSupport entry must also appear in the same step's sourceQuestions."],
    ['5: never paraphrased or reconstructed', 'Never paraphrase, summarize, reorder, join separate passages, or reconstruct an excerpt.'],
    ['6: no exact excerpt means a false condition with a gap', 'If no exact supporting excerpt exists in the intake answers for a condition, that condition is unsupported: set it to false in determinismBasis and provide its determinismGaps entry instead of a determinismSupport entry.'],
    ['7: no fabricated evidence', 'Do not fabricate, stretch, or borrow evidence to make all six conditions true'],
  ])('rule %s', (_label, sentence) => {
    expect(prompt).toContain(sentence);
  });

  it('never instructs rewording an excerpt to satisfy a length limit', () => {
    const contract = buildWorkflowAssessmentFieldContract();
    expect(prompt).toContain(contract);
    // The only "state it more concisely" instruction carves sourceExcerpt out of it.
    expect(contract).toContain('otherwise state it more concisely. The exception is sourceExcerpt, an exact quotation: shorten it only by quoting a shorter contiguous passage, never by rewording.');
    expect(prompt).toContain('To shorten an excerpt, quote a shorter contiguous passage of the same answer.');
    expect(prompt).toContain('Do not invent or normalize source text.');
  });
});

// ---- Each rule against the unchanged validator, through the real task runner ----

const config = { enabled: true, model: 'fake-local-model', timeoutMs: 1_000, maxCalls: 1, maxOutputTokens: 4_000 } as const;
const answers = {
  workflowDescription: 'Reviewing contractor invoices against rate schedules.',
  documentsInvolved: 'Invoices, rate schedules, approved work orders.',
  manualChecks: 'A reviewer compares billed rates to the contract rate.',
  frequencyAndVolume: '40 packages each week, averaging 12 documents each.',
  exceptions: 'Mismatches are escalated to the project manager.',
  humanDecisions: 'Final approval of any payment adjustment.',
};
const input: ForgewingWorkflowAssessmentInput = { submissionId: 'submission-1', submissionSchemaVersion: 'workflow_intake_v1', answers };

type Support = { condition: string; sourceQuestion: string; sourceExcerpt: string; rationale: string };
const EXACT = 'A reviewer compares billed rates to the contract rate.';
const support = (overrides: Partial<Support> = {}) => WORKFLOW_DETERMINISM_CONDITIONS.map((condition) => ({
  condition, sourceQuestion: 'manualChecks', sourceExcerpt: EXACT, rationale: `The intake supports ${condition}.`, ...overrides,
}));
const allTrue = Object.fromEntries(WORKFLOW_DETERMINISM_CONDITIONS.map((condition) => [condition, true]));

function assessment(stepOverrides: Record<string, unknown>) {
  return {
    summary: 'Invoice rate verification against a contract rate schedule.', documents: [],
    workflowSteps: [{
      stepId: 'step-1', sourceQuestions: ['manualChecks'], description: 'Compare each billed rate to the contract rate schedule.',
      classification: 'RULE', rationale: 'The description states an explicit rate comparison.', requiredInputs: ['Invoice line rate'],
      evidenceRequirements: ['Rate schedule row'], proposedOutput: 'Match or mismatch per invoice line.', dependencies: [],
      failureConsequence: 'Overbilling is paid.', unresolvedAssumptions: [], determinismBasis: allTrue, determinismGaps: [],
      determinismSupport: support(), ...stepOverrides,
    }, {
      stepId: 'step-2', sourceQuestions: ['humanDecisions'], description: 'Approve any payment adjustment.', classification: 'HUMAN',
      rationale: 'Approval authority stays with the project manager.', requiredInputs: [], evidenceRequirements: [],
      proposedOutput: 'Approved or rejected adjustment.', dependencies: [], failureConsequence: 'An adjustment is paid without approval.',
      unresolvedAssumptions: [], determinismBasis: null, determinismGaps: [], determinismSupport: [],
    }],
    extractionRequirements: [],
    deterministicRuleProposals: [{ ruleId: 'rule-1', stepId: 'step-1', plainLanguageRule: 'Billed rate must equal the contract rate for the same code.',
      requiredFacts: ['Billed rate', 'Contract rate'], conditionType: 'comparison', expectedEvidence: ['Invoice line', 'Rate schedule row'],
      expectedOutcome: 'Flag the line when the rates differ.', userDescribedExceptions: [], unresolvedAssumptions: [] }],
    evidenceRelationships: [], verificationRuleProposals: [], forgewingRecoveryTasks: [],
    humanDecisionPoints: [{ decisionId: 'decision-1', stepId: 'step-2', description: 'Approve a payment adjustment.',
      whyHumanControlled: 'Approval authority is not delegable to software.' }],
    advisorySteps: [], failureConsequences: [], limitations: ['The intake did not state a tolerance for rate differences.'],
  };
}

async function qualification(stepOverrides: Record<string, unknown>) {
  const body = assessment(stepOverrides);
  const result = await runForgewingWorkflowAssessment(input, { config, taskEnabled: true,
    provider: vi.fn(async () => JSON.stringify({ assessmentJson: JSON.stringify(body) })) });
  expect(result.status).toBe('requires_human_review');
  const assessed = (result as unknown as { assessment: { determinismQualifications: { stepId: string; state: string; reasons: string[] }[] } }).assessment;
  return assessed.determinismQualifications.find((entry) => entry.stepId === 'step-1')!;
}

describe('each v6 grounding rule matches the unchanged validator', () => {
  it('following every rule earns grounded_unverified, still non-authoritative', async () => {
    expect(EXACT).toBe(answers.manualChecks);
    expect(await qualification({})).toMatchObject({ state: 'grounded_unverified', reasons: [] });
  });

  it('rules 1-2: a single changed capital letter loses grounding (the D3 run 1 "If" -> "if" pattern)', async () => {
    const q = await qualification({ determinismSupport: support({ sourceExcerpt: `a${EXACT.slice(1)}` }) });
    expect(q.state).toBe('proposed');
    expect(q.reasons).toContain('support_excerpt_not_in_intake:objectiveInputs');
  });

  it('rule 2: changed punctuation or spacing loses grounding', async () => {
    for (const excerpt of [EXACT.replace('.', ','), EXACT.replace('compares billed', 'compares  billed')]) {
      expect((await qualification({ determinismSupport: support({ sourceExcerpt: excerpt }) })).state).toBe('proposed');
    }
  });

  it('rule 1 permits shortening only by quoting a shorter contiguous passage', async () => {
    expect((await qualification({ determinismSupport: support({ sourceExcerpt: 'compares billed rates to the contract rate' }) })).state)
      .toBe('grounded_unverified');
  });

  it('rule 3: real intake text attributed to the wrong question loses grounding', async () => {
    const q = await qualification({ sourceQuestions: ['manualChecks', 'exceptions'],
      determinismSupport: support({ sourceQuestion: 'exceptions' }) });
    expect(q.reasons).toContain('support_excerpt_not_in_intake:objectiveInputs');
    expect(q.state).toBe('proposed');
  });

  it("rule 4: a cited question missing from the step's sourceQuestions loses grounding", async () => {
    const q = await qualification({ sourceQuestions: ['workflowDescription'] });
    expect(q.reasons).toContain('support_question_not_linked:objectiveInputs');
    expect(q.state).toBe('proposed');
  });

  it('rule 5: a paraphrase or stitched reconstruction loses grounding', async () => {
    for (const excerpt of ['A reviewer checks billed rates against the contract rate.', 'A reviewer compares ... the contract rate.']) {
      expect((await qualification({ determinismSupport: support({ sourceExcerpt: excerpt }) })).state).toBe('proposed');
    }
  });

  it('rule 6: an unsupported condition marked false with its gap is accepted and reported as a gap', async () => {
    const q = await qualification({
      determinismBasis: { ...allTrue, definedExceptionBehavior: false },
      determinismSupport: support().filter((entry) => entry.condition !== 'definedExceptionBehavior'),
      determinismGaps: [{ condition: 'definedExceptionBehavior', explanation: 'The intake does not say what happens when no rate exists.' }],
    });
    expect(q).toMatchObject({ state: 'proposed_with_gaps', reasons: ['condition_gap:definedExceptionBehavior'] });
  });

  it('rule 7: claiming a condition true without support never earns grounding', async () => {
    const q = await qualification({ determinismSupport: support().filter((entry) => entry.condition !== 'stableEvidenceSource') });
    expect(q.reasons).toContain('missing_grounded_support:stableEvidenceSource');
    expect(q.state).toBe('proposed');
  });
});
