// Exactly-one closure between a step's classification and its detail record.
//
// Rejecting missing and orphan details was not enough: two rule proposals for
// one step left the specification ambiguous, and any later resolver composing
// the effective reviewed specification would have to pick one arbitrarily.
import { describe, expect, it, vi } from 'vitest';

import { runForgewingWorkflowAssessment, type ForgewingWorkflowAssessmentInput }
  from '@/lib/forgewing/tasks/workflowAssessment';
import { WORKFLOW_DETERMINISM_CONDITIONS }
  from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';

const config = {
  enabled: true, model: 'closure', timeoutMs: 1000, maxCalls: 1, maxOutputTokens: 4000,
} as const;

const input = (): ForgewingWorkflowAssessmentInput => ({
  submissionId: 'closure-1',
  submissionSchemaVersion: 'workflow_intake_v1',
  answers: {
    workflowDescription: 'We reconcile freight tickets against the rate sheet.',
    documentsInvolved: 'Freight tickets, rate sheet, delivery logs.',
    manualChecks: 'A clerk compares ticket tonnage to the delivery log tonnage.',
    frequencyAndVolume: '200 tickets weekly.',
    exceptions: 'Differences over one ton are held.',
    humanDecisions: 'A supervisor waives penalties.',
  },
});

const ALL_TRUE = Object.fromEntries(WORKFLOW_DETERMINISM_CONDITIONS.map((c) => [c, true]));
const SUPPORT = WORKFLOW_DETERMINISM_CONDITIONS.map((condition) => ({
  condition, sourceQuestion: 'manualChecks' as const,
  sourceExcerpt: 'compares ticket tonnage to the delivery log tonnage',
  rationale: 'supports ' + condition,
}));

const step = (o: Record<string, unknown> = {}) => ({
  stepId: 's1', sourceQuestions: ['manualChecks'],
  description: 'Compare ticket tonnage to the delivery log tonnage.',
  classification: 'RULE', rationale: 'An explicit tonnage comparison.',
  requiredInputs: ['tonnage'], evidenceRequirements: ['log row'],
  proposedOutput: 'Match or mismatch.', dependencies: [],
  failureConsequence: 'Short tonnage paid.', unresolvedAssumptions: [],
  determinismBasis: { ...ALL_TRUE }, determinismGaps: [], determinismSupport: SUPPORT, ...o,
});

const rule = (ruleId: string, stepId = 's1') => ({
  ruleId, stepId, plainLanguageRule: 'Tonnage must match.',
  requiredFacts: ['tonnage'], conditionType: 'comparison',
  expectedEvidence: ['ticket'], expectedOutcome: 'Flag a mismatch.',
  userDescribedExceptions: [], unresolvedAssumptions: [],
});
const extraction = (requirementId: string, plausible = true, stepId = 's1') => ({
  requirementId, stepId, describedFact: 'Ticket tonnage.',
  sourceDocument: 'Freight ticket', deterministicExtractionPlausible: plausible,
});
const recovery = (taskId: string, stepId = 's1') => ({
  taskId, stepId, description: 'Recover tonnage from scans.',
  deterministicShortfall: 'Handwriting defeats extraction.',
});

const out = (o: Record<string, unknown> = {}) => ({
  summary: 'Freight reconciliation.', documents: [],
  workflowSteps: [step()], extractionRequirements: [],
  deterministicRuleProposals: [rule('r1')], evidenceRelationships: [],
  verificationRuleProposals: [], forgewingRecoveryTasks: [],
  humanDecisionPoints: [], advisorySteps: [], failureConsequences: [],
  limitations: ['none'], ...o,
});

const run = (body: Record<string, unknown>) => runForgewingWorkflowAssessment(
  input(), { config, taskEnabled: true, provider: vi.fn(async () => JSON.stringify(body)) },
);

describe('exactly-one classification/detail closure', () => {
  it('accepts exactly one detail for a step', async () => {
    const result = await run(out());
    expect(result.status).toBe('requires_human_review');
  });

  // 6. duplicate RULE proposal for one step
  it('rejects two rule proposals for one RULE step', async () => {
    const result = await run(out({ deterministicRuleProposals: [rule('r1'), rule('r2')] }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_rule_proposal');
  });

  // 7. duplicate VERIFY proposal
  it('rejects two verification proposals for one VERIFY step', async () => {
    const result = await run(out({
      workflowSteps: [step({ classification: 'VERIFY' })],
      deterministicRuleProposals: [],
      verificationRuleProposals: [rule('v1'), rule('v2')],
    }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_verification_proposal');
  });

  // 8. duplicate extraction requirement
  it('rejects two extraction requirements for one EXTRACT step', async () => {
    const result = await run(out({
      workflowSteps: [step({
        classification: 'EXTRACT', determinismBasis: null,
        determinismSupport: [], determinismGaps: [],
      })],
      deterministicRuleProposals: [],
      extractionRequirements: [extraction('e1'), extraction('e2')],
    }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_extraction_requirement');
  });

  // 9. duplicate recovery task
  it('rejects two recovery tasks for one RECOVER step', async () => {
    const result = await run(out({
      workflowSteps: [step({
        classification: 'RECOVER', determinismBasis: null,
        determinismSupport: [], determinismGaps: [],
      })],
      deterministicRuleProposals: [],
      extractionRequirements: [extraction('e1', false)],
      forgewingRecoveryTasks: [recovery('t1'), recovery('t2')],
    }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_recovery_task');
  });

  it('rejects duplicate HUMAN and ADVISORY details', async () => {
    const human = await run(out({
      workflowSteps: [step({
        classification: 'HUMAN', determinismBasis: null,
        determinismSupport: [], determinismGaps: [],
      })],
      deterministicRuleProposals: [],
      humanDecisionPoints: [
        { decisionId: 'd1', stepId: 's1', description: 'Waive.', whyHumanControlled: 'x' },
        { decisionId: 'd2', stepId: 's1', description: 'Waive.', whyHumanControlled: 'y' },
      ],
    }));
    expect(human.status).toBe('deterministic_validation_failed');

    const advisory = await run(out({
      workflowSteps: [step({
        classification: 'ADVISORY', determinismBasis: null,
        determinismSupport: [], determinismGaps: [],
      })],
      deterministicRuleProposals: [],
      advisorySteps: [
        { advisoryId: 'a1', stepId: 's1', description: 'Note.' },
        { advisoryId: 'a2', stepId: 's1', description: 'Note.' },
      ],
    }));
    expect(advisory.status).toBe('deterministic_validation_failed');
  });

  it('rejects reused detail identifiers even across different steps', async () => {
    const result = await run(out({
      workflowSteps: [step(), step({ stepId: 's2' })],
      deterministicRuleProposals: [rule('same'), rule('same', 's2')],
    }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_detail_id:same');
  });

  it('rejects duplicate workflow step identifiers', async () => {
    const result = await run(out({
      workflowSteps: [step(), step()],
      deterministicRuleProposals: [rule('r1')],
    }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_step_id');
  });
  // Identifiers must be unique across the WHOLE assessment. Per-collection
  // uniqueness left a rule proposal and an extraction requirement free to share
  // an id, which makes provenance ambiguous the moment anything references the
  // id alone.
  it('rejects a RULE id reused as a VERIFY id', async () => {
    const result = await run(out({
      workflowSteps: [step(), step({ stepId: 's2', classification: 'VERIFY' })],
      deterministicRuleProposals: [rule('shared')],
      verificationRuleProposals: [rule('shared', 's2')],
    }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_detail_id:shared');
  });

  it('rejects a RULE id reused as an extraction requirement id', async () => {
    const result = await run(out({
      workflowSteps: [step(), step({
        stepId: 's2', classification: 'EXTRACT', determinismBasis: null,
        determinismSupport: [], determinismGaps: [],
      })],
      deterministicRuleProposals: [rule('shared')],
      extractionRequirements: [extraction('shared', true, 's2')],
    }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_detail_id:shared');
  });

  it('rejects a recovery task id reused as a human decision id', async () => {
    const result = await run(out({
      workflowSteps: [
        step({ classification: 'RECOVER', determinismBasis: null,
          determinismSupport: [], determinismGaps: [] }),
        step({ stepId: 's2', classification: 'HUMAN', determinismBasis: null,
          determinismSupport: [], determinismGaps: [] }),
      ],
      deterministicRuleProposals: [],
      extractionRequirements: [extraction('e1', false)],
      forgewingRecoveryTasks: [recovery('shared')],
      humanDecisionPoints: [{
        decisionId: 'shared', stepId: 's2',
        description: 'Waive.', whyHumanControlled: 'Not delegable.',
      }],
    }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_detail_id:shared');
  });

  it('rejects an advisory id reused as a rule proposal id', async () => {
    const result = await run(out({
      workflowSteps: [step(), step({
        stepId: 's2', classification: 'ADVISORY', determinismBasis: null,
        determinismSupport: [], determinismGaps: [],
      })],
      deterministicRuleProposals: [rule('shared')],
      advisorySteps: [{ advisoryId: 'shared', stepId: 's2', description: 'Note.' }],
    }));
    expect(result.status).toBe('deterministic_validation_failed');
    if (result.status !== 'deterministic_validation_failed') return;
    expect(result.reason).toContain('duplicate_detail_id:shared');
  });
});
