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
  ruleId, stepId, plainLanguageRule: 'r', requiredFacts: ['fact'],
  conditionType: 'comparison', expectedEvidence: ['evidence'], expectedOutcome: 'o',
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
    ['RULE', {
      deterministicRuleProposals: [rule('r1', 's1')],
    }],
    ['VERIFY', {
      verificationRuleProposals: [rule('v1', 's1')],
    }],
    ['EXTRACT', {
      extractionRequirements: [{
        requirementId: 'e1', stepId: 's1', describedFact: 'fact',
        sourceDocument: 'document', deterministicExtractionPlausible: true,
      }],
    }],
    ['RECOVER', {
      extractionRequirements: [{
        requirementId: 'e1', stepId: 's1', describedFact: 'fact',
        sourceDocument: 'document', deterministicExtractionPlausible: false,
      }],
      forgewingRecoveryTasks: [{
        taskId: 't1', stepId: 's1', description: 'recover',
        deterministicShortfall: 'not deterministic',
      }],
    }],
    ['HUMAN', {
      humanDecisionPoints: [{
        decisionId: 'h1', stepId: 's1', description: 'decide',
        whyHumanControlled: 'authority remains human',
      }],
    }],
    ['ADVISORY', {
      advisorySteps: [{ advisoryId: 'a1', stepId: 's1', description: 'advise' }],
    }],
  ] as const)('requires a complete %s class specification', (classification, details) => {
    const assessment = {
      workflowSteps: [step('s1', classification)],
      extractionRequirements: [], deterministicRuleProposals: [],
      verificationRuleProposals: [], forgewingRecoveryTasks: [],
      humanDecisionPoints: [], advisorySteps: [], failureConsequences: [],
      ...details,
    };
    expect(resolveWorkflowAssessmentProposalClosure(assessment))
      .toEqual({ compatible: true });

    for (const [detailKey, records] of Object.entries(details)) {
      const first = records[0] as Record<string, unknown>;
      for (const field of Object.keys(first)) {
        const missing = { ...first };
        delete missing[field];
        expect(resolveWorkflowAssessmentProposalClosure({
          ...assessment, [detailKey]: [missing],
        }).compatible, `${classification}.${detailKey}.${field} is required`).toBe(false);
        expect(resolveWorkflowAssessmentProposalClosure({
          ...assessment, [detailKey]: [{ ...first, [field]: {} }],
        }).compatible, `${classification}.${detailKey}.${field} has the correct type`).toBe(false);
      }
      const identifierKey = Object.keys(first).find((field) => field !== 'stepId' && field.endsWith('Id'))!;
      for (const id of [42, '']) {
        expect(resolveWorkflowAssessmentProposalClosure({
          ...assessment, [detailKey]: [{ ...first, [identifierKey]: id }],
        }).compatible, `${classification} detail ID must be a nonempty string`).toBe(false);
      }
    }
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
    expect(result.compatible).toBe(false);
  });

  it.each([undefined, 42, '', ' r1', 'r1 '])('rejects malformed detail identity %s', (ruleId) => {
    expect(resolveWorkflowAssessmentProposalClosure({
      ...compatible,
      deterministicRuleProposals: [{ ...rule('r1', 's1'), ruleId }],
    }, { acceptedStepIds: ['s1'] }).compatible).toBe(false);
  });

  it.each([
    { requiredFacts: [] }, { requiredFacts: [42] },
    { expectedEvidence: [{}] }, { userDescribedExceptions: undefined },
    { unresolvedAssumptions: undefined }, { conditionType: 'unknown' },
    { plainLanguageRule: null },
  ])('rejects an incomplete or mistyped rule specification %j', (fields) => {
    expect(resolveWorkflowAssessmentProposalClosure({
      ...compatible,
      deterministicRuleProposals: [{ ...rule('r1', 's1'), ...fields }],
    }, { acceptedStepIds: ['s1'] }).compatible).toBe(false);
  });

  it.each([undefined, 42, '', ' s1', 's1 '])(
    'rejects malformed step identity %s even when every proposal is replaced', (stepId) => {
      expect(resolveWorkflowAssessmentProposalClosure({
        ...compatible,
        workflowSteps: [{ ...step('s1', 'RULE'), stepId }],
      }, { acceptedStepIds: [] }).compatible).toBe(false);
    },
  );

  it('preserves known unique step and classification identities for complete replacements', () => {
    for (const workflowSteps of [
      [step('s1', 'UNKNOWN')],
      [step('s1', 'RULE'), step('s1', 'HUMAN')],
    ]) {
      expect(resolveWorkflowAssessmentProposalClosure({ workflowSteps }, {
        acceptedStepIds: [],
      }).compatible).toBe(false);
    }
  });

  it('checks accepted details while allowing unused malformed historical details to be replaced', () => {
    const mixed = {
      ...compatible,
      workflowSteps: [step('s1', 'RULE'), step('s2', 'HUMAN')],
      humanDecisionPoints: [{ stepId: 's2', decisionId: 42 }],
    };
    expect(resolveWorkflowAssessmentProposalClosure(mixed).compatible).toBe(false);
    expect(resolveWorkflowAssessmentProposalClosure(mixed, { acceptedStepIds: ['s1'] }))
      .toEqual({ compatible: true });
    expect(resolveWorkflowAssessmentProposalClosure(mixed, { acceptedStepIds: ['ghost'] })
      .compatible).toBe(false);
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
