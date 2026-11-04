import { describe, expect, it } from 'vitest';

import { allFdeFollowUps } from '@/lib/projectIntelligence/fdeReadiness';
import { buildFdeIntakePlan, type FdeIntakePlanInput } from '@/lib/projectIntelligence/fdeIntakePlan';

const assessment = {
  schemaVersion: 'workflow_assessment_v2',
  workflowSteps: [
    { stepId: 'extract', classification: 'EXTRACT', description: 'Read the rate schedule PDF', requiredInputs: ['Rate schedule PDF'], proposedOutput: 'Rate rows', unresolvedAssumptions: [], determinismGaps: [] },
    { stepId: 'check', classification: 'VERIFY', description: 'Check the billed rate against the contract', requiredInputs: ['Billed rates'], proposedOutput: 'Rate findings', unresolvedAssumptions: ['What tolerance applies?'], determinismGaps: [] },
    { stepId: 'approve', classification: 'HUMAN', description: 'Approve payment', requiredInputs: [], proposedOutput: 'Approval decision', unresolvedAssumptions: [], determinismGaps: [] },
  ],
  documents: [{ documentId: 'rates', name: 'Rate schedule PDF', role: 'Pricing' }],
  humanDecisionPoints: [{ stepId: 'approve', description: 'Approve payment', whyHumanControlled: 'Human authority' }],
  evidenceRelationships: [], limitations: [],
};
const input: FdeIntakePlanInput = {
  assessmentId: 'assessment-a', assessmentVersion: 2, sourceSubmissionId: 'submission-a',
  intake: { workflowDescription: 'Review invoices for payment', manualChecks: 'Compare billed rates', successOutcome: 'Reviewed invoices' },
  assessment,
  suppliedFiles: [{ attachmentId: 'file-a', filename: 'Rate schedule PDF', sectionLabels: ['Rates'], truncated: false }],
  answers: [],
};

describe('structured FDE intake plan', () => {
  it('is deterministic and pins the assessment, file, answer, and catalogue identities', () => {
    const question = allFdeFollowUps(assessment)[0]!;
    const answer = { answerId: 'answer-a', followUpId: question.followUpId, answer: 'Two cents', answerSource: 'customer_stated', evidenceAttachmentIds: ['file-a'], revision: 1, assessmentId: 'assessment-a', assessmentVersion: 2 };
    const source = { ...input, answers: [answer] };
    const plan = buildFdeIntakePlan(source)!;
    expect(plan).toEqual(buildFdeIntakePlan(source));
    expect(plan.pinnedInputs).toMatchObject({ assessmentId: 'assessment-a', assessmentVersion: 2, sourceSubmissionId: 'submission-a', answers: [{ answerId: 'answer-a', revision: 1 }], suppliedFiles: [{ attachmentId: 'file-a' }] });
    expect(plan.pinnedInputs.capabilityCatalogue.identity).toBeTruthy();
    expect(plan.supportingEvidence.map((e) => e.kind)).toContain('follow_up_answer');
    expect(plan.authority).toBe('non_authoritative');
  });

  it('keeps submitted answers unreviewed and never promotes an assessment review to plan approval', () => {
    const question = allFdeFollowUps(assessment)[0]!;
    const plan = buildFdeIntakePlan({ ...input, answers: [{ answerId: 'answer-a', followUpId: question.followUpId, answer: 'Two cents', answerSource: 'customer_stated', evidenceAttachmentIds: [], revision: 1, assessmentId: 'assessment-a', assessmentVersion: 2 }], existingReview: { reviewId: 'review-a', reviewVersion: 1, overallDisposition: 'accepted' } })!;
    expect(plan.informationNeeds).toContainEqual(expect.objectContaining({ state: 'supplied_uninterpreted', description: 'What tolerance applies?' }));
    expect(plan.readiness.state).toBe('needs_follow_up');
    expect(plan.deploymentApproach.state).toBe('undetermined');
    expect(plan.humanReview).toMatchObject({ planState: 'pending_review', approvedDeploymentRecommendation: false, assessmentReview: { reviewId: 'review-a', disposition: 'accepted' } });
    expect(plan.workflowUnderstanding.humanDecisions).toContain('Approve payment');
  });

  it('retains a submission-scoped answer from an earlier assessment version when the question persists', () => {
    const question = allFdeFollowUps(assessment)[0]!;
    const prior = { answerId: 'old-answer', followUpId: question.followUpId, answer: 'Two cents', answerSource: 'customer_stated', evidenceAttachmentIds: [], revision: 1, assessmentId: 'assessment-old', assessmentVersion: 1 };
    const plan = buildFdeIntakePlan({ ...input, answers: [prior] })!;
    expect(plan.informationNeeds).toContainEqual(expect.objectContaining({ state: 'supplied_uninterpreted', sourceIds: ['old-answer'] }));
    expect(plan.pinnedInputs.answers).toContainEqual(expect.objectContaining({ answerId: 'old-answer', assessmentId: 'assessment-old', assessmentVersion: 1 }));
  });

  it('uses only catalogue matches, ranks the lower supported rung, and preserves human decisions', () => {
    const plan = buildFdeIntakePlan(input)!;
    expect(plan.capabilityMatches.find((match) => match.stepId === 'extract')).toMatchObject({ capabilityId: 'document_text_extraction', status: 'supported' });
    expect(plan.capabilityMatches.find((match) => match.stepId === 'check')).toMatchObject({ capabilityId: 'validator_contract_invoice_rules' });
    expect(plan.deploymentApproach.steps.find((step) => step.stepId === 'check')).toMatchObject({ rung: 'existing_capability', lowerRungsToRuleOut: [] });
    expect(plan.deploymentApproach.steps.find((step) => step.stepId === 'approve')).toMatchObject({ rung: null });
  });

  it('fails closed for unreadable answers, missing evidence, and explicitly conflicting information', () => {
    const plan = buildFdeIntakePlan({ ...input, answers: null, suppliedFiles: [], assessment: { ...assessment, limitations: ['Conflicting rate schedules'] } })!;
    expect(plan.informationNeeds.map((need) => need.state)).toEqual(expect.arrayContaining(['requires_clarification', 'not_supplied', 'conflicting']));
    expect(plan.readiness.state).toBe('needs_follow_up');
    expect(plan.deploymentApproach.rung).toBeNull();
  });

  it('does not invent an unknown capability or rewrite the assessment', () => {
    const unknown = { ...assessment, workflowSteps: [{ stepId: 'new', classification: 'VERIFY', description: 'Verify an unrecognized custom operation', requiredInputs: [], proposedOutput: 'Result', unresolvedAssumptions: [], determinismGaps: [] }] };
    const before = JSON.stringify(unknown);
    const plan = buildFdeIntakePlan({ ...input, assessment: unknown, suppliedFiles: [] })!;
    expect(plan.capabilityMatches[0]!.capabilityId).toBeNull();
    expect(plan.deploymentApproach.steps[0]!.rung).toBe('reusable_deterministic_rule');
    expect(plan.deploymentApproach.steps[0]!.lowerRungsToRuleOut).toContain('mapping');
    expect(JSON.stringify(unknown)).toBe(before);
  });
});
