// Determinism qualification cannot be manufactured by the provider.
//
// Reproduces the attack that made this remediation necessary: an excerpt that
// is verbatim from the persisted intake but irrelevant to every condition it is
// cited for. Citation proves provenance, never entailment, so no state reachable
// from provider self-attestation may imply trusted determinism.
import { describe, expect, it, vi } from 'vitest';
import { runForgewingWorkflowAssessment, type ForgewingWorkflowAssessmentInput }
  from '@/lib/forgewing/tasks/workflowAssessment';
import { WORKFLOW_DETERMINISM_CONDITIONS }
  from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';

const config = { enabled: true, model: 'probe', timeoutMs: 1000, maxCalls: 1, maxOutputTokens: 4000 } as const;
const ANSWERS = {
  workflowDescription: 'We reconcile freight tickets against the hauling rate sheet.',
  documentsInvolved: 'Freight tickets, rate sheet, signed delivery logs.',
  manualChecks: 'A clerk compares ticket tonnage to the delivery log tonnage.',
  frequencyAndVolume: '40 packages each week',
  exceptions: 'Any tonnage difference over one ton is held for review.',
  humanDecisions: 'A supervisor decides whether to waive a short-tonnage penalty.',
};
const input = (): ForgewingWorkflowAssessmentInput => ({
  submissionId: 'f2-after', submissionSchemaVersion: 'workflow_intake_v1', answers: { ...ANSWERS },
});
const ALL_TRUE = Object.fromEntries(WORKFLOW_DETERMINISM_CONDITIONS.map((c) => [c, true]));
const IRRELEVANT = WORKFLOW_DETERMINISM_CONDITIONS.map((condition) => ({
  condition, sourceQuestion: 'frequencyAndVolume' as const,
  sourceExcerpt: '40 packages each week',
  rationale: 'volume establishes ' + condition,
}));
const step = (o: Record<string, unknown> = {}) => ({
  stepId: 's1', sourceQuestions: ['frequencyAndVolume'],
  description: 'Compare ticket tonnage to the delivery log tonnage.',
  classification: 'RULE', rationale: 'The workflow calculates a tonnage difference.',
  requiredInputs: ['Ticket tonnage'], evidenceRequirements: ['Delivery log row'],
  proposedOutput: 'Match or mismatch per ticket.', dependencies: [],
  failureConsequence: 'Short tonnage is paid.', unresolvedAssumptions: [],
  determinismBasis: { ...ALL_TRUE }, determinismGaps: [], determinismSupport: IRRELEVANT, ...o,
});
const out = (o: Record<string, unknown> = {}) => ({
  summary: 'Freight ticket tonnage reconciliation.', documents: [],
  workflowSteps: [step()], extractionRequirements: [],
  deterministicRuleProposals: [{
    ruleId: 'r1', stepId: 's1',
    plainLanguageRule: 'Ticket tonnage must equal delivery log tonnage.',
    requiredFacts: ['Ticket tonnage'], conditionType: 'comparison',
    expectedEvidence: ['Ticket'], expectedOutcome: 'Flag when tonnage differs.',
    userDescribedExceptions: [], unresolvedAssumptions: [],
  }],
  evidenceRelationships: [], verificationRuleProposals: [], forgewingRecoveryTasks: [],
  humanDecisionPoints: [], advisorySteps: [], failureConsequences: [],
  limitations: ['No tolerance stated.'], ...o,
});
const run = (body: Record<string, unknown>) => runForgewingWorkflowAssessment(
  input(), { config, taskEnabled: true, provider: vi.fn(async () => JSON.stringify(body)) });

describe('F2 REMEDIATION: provider cannot manufacture trusted determinism', () => {
  it('no state name implies trusted qualification', async () => {
    const r = await run(out());
    expect(r.status).toBe('requires_human_review');
    if (r.status !== 'requires_human_review') return;
    const q = r.assessment.determinismQualifications[0]!;
    console.log('F2-AFTER state =', q.state);
    console.log('F2-AFTER metrics =', JSON.stringify(r.assessment.automationAssessment));
    expect(q.state).not.toBe('qualified');
    expect(JSON.stringify(r.assessment)).not.toContain('"qualified"');
    expect(r.assessment.automationAssessment.basis)
      .toBe('eightforge_proposed_workflow_steps');
  });

  it('a proposal-level unresolved assumption prevents grounded_unverified', async () => {
    const r = await run(out({ deterministicRuleProposals: [{
      ruleId: 'r1', stepId: 's1',
      plainLanguageRule: 'Ticket tonnage must equal delivery log tonnage.',
      requiredFacts: ['Ticket tonnage'], conditionType: 'comparison',
      expectedEvidence: ['Ticket'], expectedOutcome: 'Flag when tonnage differs.',
      userDescribedExceptions: [],
      unresolvedAssumptions: ['No tolerance for rounding was stated.'],
    }] }));
    expect(r.status).toBe('requires_human_review');
    if (r.status !== 'requires_human_review') return;
    const q = r.assessment.determinismQualifications[0]!;
    console.log('F2-AFTER assumption state =', q.state, JSON.stringify(q.reasons));
    expect(q.state).toBe('proposed');
    expect(q.reasons).toContain('unresolved_assumptions_present');
    expect(r.assessment.automationAssessment.stepsWithUnresolvedAssumptions).toBe(1);
  });
});
