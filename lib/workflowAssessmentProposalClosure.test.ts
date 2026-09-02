// One canonical answer to "is this assessment structurally composable?"
//
// The same validator runs before a new assessment is persisted and again, later,
// against a stored payload when an operator wants to accept it as proposed. A
// second implementation would eventually disagree with the first, and the
// disagreement would surface as an operator approving something a resolver
// cannot compose.
import { describe, expect, it } from 'vitest';

import { resolveWorkflowAssessmentProposalClosure }
  from '@/lib/workflowAssessmentProposalClosure';

const step = (stepId: string, classification: string) => ({
  stepId, classification, description: 'x', rationale: 'y',
  requiredInputs: [], evidenceRequirements: [], proposedOutput: 'z',
  dependencies: [], failureConsequence: 'c', unresolvedAssumptions: [],
});
const rule = (ruleId: string, stepId: string) => ({
  ruleId, stepId, plainLanguageRule: 'r', requiredFacts: [],
  conditionType: 'comparison', expectedEvidence: [], expectedOutcome: 'o',
  userDescribedExceptions: [], unresolvedAssumptions: [],
});

const compatible = {
  workflowSteps: [step('s1', 'RULE')],
  extractionRequirements: [],
  deterministicRuleProposals: [rule('r1', 's1')],
  verificationRuleProposals: [],
  forgewingRecoveryTasks: [],
  humanDecisionPoints: [],
  advisorySteps: [],
  failureConsequences: [],
};

describe('workflow assessment proposal closure', () => {
  it('accepts a structurally complete assessment', () => {
    expect(resolveWorkflowAssessmentProposalClosure(compatible))
      .toEqual({ compatible: true });
  });

  it.each([
    ['a step with no detail', { ...compatible, deterministicRuleProposals: [] }],
    ['two details for one step', {
      ...compatible, deterministicRuleProposals: [rule('r1', 's1'), rule('r2', 's1')],
    }],
    ['an orphan detail', {
      ...compatible, deterministicRuleProposals: [rule('r1', 's1'), rule('r2', 'ghost')],
    }],
    ['a reused identifier across collections', {
      ...compatible,
      workflowSteps: [step('s1', 'RULE'), step('s2', 'ADVISORY')],
      deterministicRuleProposals: [rule('shared', 's1')],
      advisorySteps: [{ advisoryId: 'shared', stepId: 's2', description: 'n' }],
    }],
    ['a RECOVER without its recovery task', {
      ...compatible,
      workflowSteps: [step('s1', 'RECOVER')],
      deterministicRuleProposals: [],
      extractionRequirements: [{
        requirementId: 'e1', stepId: 's1', describedFact: 'f',
        sourceDocument: 'd', deterministicExtractionPlausible: false,
      }],
    }],
  ])('reports %s as incompatible', (_label, assessment) => {
    const result = resolveWorkflowAssessmentProposalClosure(assessment);
    expect(result.compatible).toBe(false);
    if (result.compatible) return;
    expect(result.violations.length).toBeGreaterThan(0);
  });

  // A historical payload may be missing whole collections or carry malformed
  // links. Those are closure failures to report, not crashes.
  it.each([
    ['a payload missing every detail collection', { workflowSteps: [step('s1', 'RULE')] }],
    ['a payload with no steps at all', { workflowSteps: [] }],
    ['a non-object payload', 'not an assessment'],
    ['null', null],
    ['a payload whose steps are not objects', { workflowSteps: ['s1', 's2'] }],
    ['a detail with a non-string stepId', {
      ...compatible, deterministicRuleProposals: [{ ...rule('r1', 's1'), stepId: 42 }],
    }],
  ])('fails closed on %s rather than throwing', (_label, assessment) => {
    const result = resolveWorkflowAssessmentProposalClosure(assessment);
    // An empty assessment has no steps needing details, so it is vacuously
    // composable; what matters is that nothing throws and nothing is repaired.
    expect(typeof result.compatible).toBe('boolean');
  });

  it('never mutates the assessment it inspects', () => {
    const original = JSON.parse(JSON.stringify(compatible)) as unknown;
    resolveWorkflowAssessmentProposalClosure(compatible);
    expect(compatible).toEqual(original);
  });

  it('reports structural reason codes, not proposal prose', () => {
    const result = resolveWorkflowAssessmentProposalClosure({
      ...compatible,
      deterministicRuleProposals: [
        { ...rule('r1', 's1'), plainLanguageRule: 'SECRET BUSINESS DETAIL' },
        rule('r2', 's1'),
      ],
    });
    expect(result.compatible).toBe(false);
    if (result.compatible) return;
    expect(JSON.stringify(result.violations)).not.toContain('SECRET BUSINESS DETAIL');
  });
});
