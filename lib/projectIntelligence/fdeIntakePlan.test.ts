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

  it('excludes answers submitted against a later assessment version', () => {
    const question = allFdeFollowUps(assessment)[0]!;
    const future = { answerId: 'future', followUpId: question.followUpId, answer: 'Five cents', answerSource: 'customer_stated', evidenceAttachmentIds: [], revision: 2, assessmentId: 'later', assessmentVersion: 3 };
    const current = { ...future, answerId: 'current', answer: 'Two cents', revision: 1, assessmentId: 'assessment-a', assessmentVersion: 2 };
    const plan = buildFdeIntakePlan({ ...input, answers: [future, current] })!;
    expect(plan.pinnedInputs.answers.map((entry) => entry.answerId)).toEqual(['current']);
    expect(plan.informationNeeds).toContainEqual(expect.objectContaining({ state: 'supplied_uninterpreted', sourceIds: ['current'] }));
  });

  it('uses stable attachment order and preserves every duplicate-name candidate', () => {
    const files = [
      { attachmentId: 'file-b', filename: 'Rate schedule PDF', sectionLabels: ['Rates'], truncated: false },
      { attachmentId: 'file-a', filename: 'Rate schedule PDF', sectionLabels: ['Rates'], truncated: false },
    ];
    const first = buildFdeIntakePlan({ ...input, suppliedFiles: files })!;
    const reversed = buildFdeIntakePlan({ ...input, suppliedFiles: [...files].reverse() })!;
    expect(first).toEqual(reversed);
    expect(first.informationNeeds).toContainEqual(expect.objectContaining({
      description: 'Rate schedule PDF', state: 'supplied_uninterpreted', sourceIds: ['file-a', 'file-b'],
    }));
  });

  it('retains differently named candidate files that match the same described source', () => {
    const files = [
      { attachmentId: 'file-b', filename: 'Contract rates.pdf', sectionLabels: ['Rate schedule'], truncated: false },
      { attachmentId: 'file-a', filename: 'Rate schedule PDF', sectionLabels: ['Rates'], truncated: false },
    ];
    const plan = buildFdeIntakePlan({ ...input, suppliedFiles: files })!;
    expect(plan.informationNeeds).toContainEqual(expect.objectContaining({
      description: 'Rate schedule PDF', state: 'supplied_uninterpreted', sourceIds: ['file-a', 'file-b'],
    }));
    expect(buildFdeIntakePlan({ ...input, suppliedFiles: [...files].reverse() })).toEqual(plan);
  });

  it('keeps unmatched and truncated files visible without treating them as a customer omission', () => {
    const plan = buildFdeIntakePlan({ ...input, suppliedFiles: [{ attachmentId: 'other', filename: 'Other evidence.pdf', sectionLabels: ['Other'], truncated: true,
      limitations: ['Only the first page was read'] }] })!;
    expect(plan.informationNeeds).toContainEqual(expect.objectContaining({ state: 'requires_clarification', description: 'Rate schedule PDF', sourceIds: ['other'] }));
    expect(plan.informationNeeds).toContainEqual(expect.objectContaining({ state: 'supplied_uninterpreted', sourceIds: ['other'], description: expect.stringContaining('Only the first page was read') }));
    expect(plan.readiness.state).toBe('needs_follow_up');
    expect(plan.informationNeeds.some((need) => need.state === 'not_supplied' && need.description === 'Rate schedule PDF')).toBe(false);
  });

  it('distinguishes unavailable attachment evidence and pins the immutable manifest', () => {
    const manifestAttachments = [{ attachmentId: 'file-a', sourceSha256: 'a'.repeat(64), representationDigestSha256: 'b'.repeat(64) }];
    const plan = buildFdeIntakePlan({ ...input, suppliedFiles: [], manifestAttachments, attachmentEvidenceUnavailable: true })!;
    expect(plan.pinnedInputs.manifestAttachments).toEqual(manifestAttachments);
    expect(plan.informationNeeds).toContainEqual(expect.objectContaining({ state: 'evidence_unavailable', sourceIds: ['file-a'] }));
    expect(plan.informationNeeds.some((need) => need.state === 'not_supplied' && need.description === 'Rate schedule PDF')).toBe(false);
    expect(plan.deploymentApproach.rung).toBeNull();
  });

  it('blocks a reviewed step that differs from the assessment proposal without approving the plan', () => {
    const review = { reviewId: 'review-a', reviewVersion: 1, overallDisposition: 'accepted', reviewerSummary: 'Human decision retained',
      stepReviews: [{ assessmentStepId: 'check', proposedClassification: 'VERIFY', reviewedClassification: 'HUMAN', disposition: 'reclassified',
        reviewerNotes: 'Keep this with the operator.', acceptedSpecification: { description: 'Human review' } }] };
    const plan = buildFdeIntakePlan({ ...input, existingReview: review })!;
    expect(plan.informationNeeds).toContainEqual(expect.objectContaining({ state: 'conflicting', stepId: 'check', sourceIds: ['review-a', 'assessment-a'] }));
    expect(plan.deploymentApproach.steps.find((step) => step.stepId === 'check')?.rung).toBeNull();
    expect(plan.humanReview).toMatchObject({ planState: 'pending_review', approvedDeploymentRecommendation: false });
  });

  it('blocks owner activation even with a catalogue-backed capability candidate', () => {
    const advisory = { ...assessment, workflowSteps: [{ stepId: 'explain', classification: 'ADVISORY', description: 'Provide an AI explanation',
      requiredInputs: ['Validated project'], proposedOutput: 'Explanation', unresolvedAssumptions: [], determinismGaps: [] }], documents: [] };
    const plan = buildFdeIntakePlan({ ...input, assessment: advisory, suppliedFiles: [] })!;
    expect(plan.capabilityMatches[0]).toMatchObject({ capabilityId: 'model_explanation', status: 'requires_owner_activation' });
    expect(plan.informationNeeds).toContainEqual(expect.objectContaining({ state: 'missing_human_decision', stepId: 'explain' }));
    expect(plan.readiness.state).toBe('needs_follow_up');
    expect(plan.deploymentApproach.rung).toBeNull();
  });

  it('pins only explicit material fields and changes identity when evidence or review decisions change', () => {
    const file = { attachmentId: 'file-a', filename: 'Rate schedule PDF', sectionLabels: ['Rates'], truncated: false,
      sourceSha256: 'a'.repeat(64), representationDigestSha256: 'b'.repeat(64), contextDigest: 'c'.repeat(64) };
    const review = { reviewId: 'review-a', reviewVersion: 1, overallDisposition: 'accepted', reviewerSummary: 'Reviewed',
      stepReviews: [{ assessmentStepId: 'check', proposedClassification: 'VERIFY', reviewedClassification: 'VERIFY', disposition: 'accepted',
        reviewerNotes: null, acceptedSpecification: null }] };
    const source = { ...input, suppliedFiles: [file], existingReview: review };
    const original = buildFdeIntakePlan(source)!;
    const noisyFile = { ...file, runtimeProperty: 'ignored' };
    const noisyReview = { ...review, runtimeProperty: 'ignored' };
    const irrelevant = buildFdeIntakePlan({ ...source, assessment: { ...assessment, runtimeCache: 'ignored' },
      suppliedFiles: [noisyFile], existingReview: noisyReview })!;
    expect(irrelevant.pinnedInputs).toEqual(original.pinnedInputs);
    expect(buildFdeIntakePlan({ ...source, suppliedFiles: [{ ...file, sourceSha256: 'd'.repeat(64) }] })!.pinnedInputs.suppliedFiles).not.toEqual(original.pinnedInputs.suppliedFiles);
    expect(buildFdeIntakePlan({ ...source, suppliedFiles: [{ ...file, contextDigest: 'e'.repeat(64) }] })!.pinnedInputs.suppliedFiles).not.toEqual(original.pinnedInputs.suppliedFiles);
    expect(buildFdeIntakePlan({ ...source, existingReview: { ...review, stepReviews: [{ ...review.stepReviews[0], disposition: 'rejected' }] } })!.pinnedInputs.assessmentReview?.digest).not.toBe(original.pinnedInputs.assessmentReview?.digest);
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
