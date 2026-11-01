import { describe, expect, it } from 'vitest';

import {
  buildFdeReadinessPlan,
  FDE_LADDER_RUNGS,
  MAX_FDE_FOLLOW_UPS,
  type FdeSuppliedFile,
} from '@/lib/projectIntelligence/fdeReadiness';

function step(stepId: string, classification: string, overrides: Record<string, unknown> = {}) {
  return { stepId, classification, description: `Step ${stepId}`, unresolvedAssumptions: [], determinismGaps: [], ...overrides };
}

const ASSESSMENT = {
  schemaVersion: 'workflow_assessment_v2',
  documents: [{ documentId: 'd1', name: 'Vendor rate schedule', role: 'Pricing' }, { documentId: 'd2', name: 'Payment approval log', role: 'Approvals' }],
  workflowSteps: [
    step('s1', 'EXTRACT'),
    step('s2', 'EXTRACT'),
    step('s3', 'EXTRACT'),
    step('s4', 'VERIFY', { determinismGaps: [{ condition: 'definedExceptionBehavior', explanation: 'What happens when the billed rate differs by a few cents?' }] }),
    step('s5', 'RULE'),
    step('s6', 'RECOVER'),
    step('s7', 'HUMAN'),
    step('s8', 'ADVISORY', { unresolvedAssumptions: ['Which team owns the vendor rate schedule updates?'] }),
    step('s9', 'EXTRACT'),
  ],
  determinismQualifications: [{ stepId: 's4', state: 'proposed_with_gaps' }, { stepId: 's5', state: 'grounded_unverified' }],
  extractionRequirements: [
    { stepId: 's1', sourceDocument: 'Vendor rate sheet PDF', deterministicExtractionPlausible: true },
    { stepId: 's2', sourceDocument: 'The ERP system of record', deterministicExtractionPlausible: true },
    { stepId: 's3', sourceDocument: 'Handwritten yard logs', deterministicExtractionPlausible: false },
    { stepId: 's9', sourceDocument: 'Morning huddle notes', deterministicExtractionPlausible: true },
  ],
  verificationRuleProposals: [{ stepId: 's4', unresolvedAssumptions: ['What happens when the billed rate differs by a few cents?', 'Is there a cut-off date?'] }],
  deterministicRuleProposals: [],
  humanDecisionPoints: [{ stepId: 's7', description: 'Approve payment over the threshold', whyHumanControlled: 'Authority' }],
  failureConsequences: [{ stepId: 's8', severity: 'high', description: 'x' }],
  limitations: ['Volume was not stated.'],
};

const FILE: FdeSuppliedFile = { filename: 'vendor-rate-schedule.xlsx', sectionLabels: ['Rates 2026'], truncated: true };

describe('buildFdeReadinessPlan', () => {
  it('returns nothing to plan from a record with no steps', () => {
    expect(buildFdeReadinessPlan(null)).toBeNull();
    expect(buildFdeReadinessPlan({ workflowSteps: [] })).toBeNull();
  });

  it('is non-authoritative and always asks for human review', () => {
    const plan = buildFdeReadinessPlan(ASSESSMENT)!;
    expect(plan.authority).toBe('non_authoritative');
    expect(plan.requiresHumanReview).toBe(true);
  });

  it('starts each step on the lowest rung the evidence supports, lists what to rule out, and keeps people deciding', () => {
    const plan = buildFdeReadinessPlan(ASSESSMENT)!;
    const rung = (stepId: string) => plan.steps.find((entry) => entry.stepId === stepId)?.startingRung;
    expect(rung('s1')).toBe('existing_capability');
    expect(rung('s2')).toBe('adapter');
    expect(rung('s3')).toBe('extraction_or_validator_improvement');
    expect(rung('s9')).toBe('mapping');
    expect(rung('s5')).toBe('reusable_deterministic_rule');
    expect(rung('s6')).toBe('extraction_or_validator_improvement');
    expect(rung('s8')).toBe('existing_capability');
    expect(rung('s7')).toBeNull();

    expect(plan.steps.find((entry) => entry.stepId === 's1')?.ruleOutFirst).toEqual([]);
    expect(plan.steps.find((entry) => entry.stepId === 's5')?.ruleOutFirst).toEqual(FDE_LADDER_RUNGS.slice(0, 4));
    // Nothing starts at the top: a broad product change is never where a plan begins.
    expect(plan.steps.map((entry) => entry.startingRung)).not.toContain('broad_product_change');

    expect(plan.reusableCapabilities).toEqual(['s1', 's8']);
    expect(plan.adapterNeeds).toEqual(['s2']);
    expect(plan.mappingNeeds).toEqual(['s9']);
    expect(plan.deterministicRuleOpportunities).toEqual(['s4', 's5']);
    expect(plan.improvementOpportunities).toEqual(['s3', 's6']);
    expect(plan.unresolvedHumanDecisions).toEqual(['Approve payment over the threshold']);
  });

  it('asks only about recorded gaps, once each, gaps first', () => {
    const plan = buildFdeReadinessPlan(ASSESSMENT)!;
    expect(plan.followUps.map((entry) => entry.question)).toEqual([
      'What happens when the billed rate differs by a few cents?',
      'Which team owns the vendor rate schedule updates?',
      'Is there a cut-off date?',
    ]);
    expect(plan.followUps[0]?.kind).toBe('determinism_gap');
    expect(plan.executionReadiness).toEqual({ state: 'needs_follow_up', blockers: ['open_questions', 'evidence_not_supplied'] });
  });

  it('is not a questionnaire: it asks nothing when the assessment recorded no gap, and caps what it shows', () => {
    const clean = buildFdeReadinessPlan({ documents: [], workflowSteps: [step('s1', 'RULE')], limitations: [] })!;
    expect(clean.followUps).toEqual([]);
    expect(clean.workflowUnderstood.state).toBe('understood');
    expect(clean.executionReadiness.state).toBe('ready_for_implementation_review');

    const many = Array.from({ length: 10 }, (_, index) => `Open question ${index}?`);
    const capped = buildFdeReadinessPlan({ workflowSteps: [step('s1', 'RULE', { unresolvedAssumptions: many })] })!;
    expect(capped.followUps).toHaveLength(MAX_FDE_FOLLOW_UPS);
    expect(capped.followUpsNotShown).toBe(4);
  });

  it('points at a supplied file before asking anyone, without claiming to have read the answer', () => {
    const plan = buildFdeReadinessPlan(ASSESSMENT, [FILE])!;
    const question = plan.followUps.find((entry) => entry.question.startsWith('Which team'));
    expect(question?.checkSuppliedFileFirst).toBe('vendor-rate-schedule.xlsx');
    expect(plan.followUps).toContainEqual(expect.objectContaining({ question: 'Which team owns the vendor rate schedule updates?' }));
  });

  it('reports which described sources were supplied, and flags a truncated file', () => {
    const plan = buildFdeReadinessPlan(ASSESSMENT, [FILE])!;
    expect(plan.evidenceCompleteness).toEqual({
      state: 'partially_supplied',
      describedSources: [{ name: 'Vendor rate schedule', suppliedAs: 'vendor-rate-schedule.xlsx' }, { name: 'Payment approval log', suppliedAs: null }],
      suppliedFileCount: 1,
      truncatedFiles: ['vendor-rate-schedule.xlsx'],
    });
  });

  it('never calls a workflow ready when a person decides everything in it', () => {
    const plan = buildFdeReadinessPlan({ workflowSteps: [step('s1', 'HUMAN')] })!;
    expect(plan.executionReadiness.state).toBe('not_ready');
    expect(plan.executionReadiness.blockers).toContain('no_step_beyond_human_decision');
  });

  it('reads an older assessment without the newer fields', () => {
    const plan = buildFdeReadinessPlan({ workflowSteps: [{ stepId: 's1', classification: 'RULE' }] })!;
    expect(plan.steps[0]?.startingRung).toBe('reusable_deterministic_rule');
    expect(plan.evidenceCompleteness.state).toBe('none_described');
  });

  it('copies no authority from the record into its own fields', () => {
    const plan = buildFdeReadinessPlan({ ...ASSESSMENT, authority: 'authoritative', requiresHumanReview: false })!;
    expect(plan.authority).toBe('non_authoritative');
    expect(plan.requiresHumanReview).toBe(true);
  });
});
