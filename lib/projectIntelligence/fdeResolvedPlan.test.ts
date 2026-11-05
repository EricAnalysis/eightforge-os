import { describe, expect, it } from 'vitest';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { buildFdeIntakePlan } from '@/lib/projectIntelligence/fdeIntakePlan';
import { FDE_WAIVER_ACKNOWLEDGMENT_TEXT, FDE_WAIVER_ACKNOWLEDGMENT_VERSION,
  isFdeWaiverEligibleNeed, resolveFdePlan } from '@/lib/projectIntelligence/fdeResolvedPlan';

const assessment = {
  schemaVersion: 'workflow_assessment_v2',
  workflowSteps: [{ stepId: 'extract', classification: 'EXTRACT', description: 'Read the schedule',
    requiredInputs: ['Rate schedule PDF'], proposedOutput: 'Rate rows', unresolvedAssumptions: [], determinismGaps: [] }],
  documents: [{ documentId: 'rates', name: 'Rate schedule PDF', role: 'Pricing' }],
  humanDecisionPoints: [], evidenceRelationships: [], limitations: [],
};
const review = { reviewId: 'review-a', reviewVersion: 1, overallDisposition: 'accepted', stepReviews: [
  { assessmentStepId: 'extract', proposedClassification: 'EXTRACT', reviewedClassification: 'EXTRACT',
    disposition: 'accepted', reviewerNotes: null, acceptedSpecification: null },
] };
const input = {
  assessmentId: 'assessment-a', assessmentVersion: 1, sourceSubmissionId: 'submission-a',
  intake: { workflowDescription: 'Read contract schedules', successOutcome: 'Reviewed rate rows' },
  assessment, answers: [], existingReview: review,
};

describe('evidence-bound FDE recommendation', () => {
  it('requires a human conclusion for a supplied document and binds its exact source representation', () => {
    const base = buildFdeIntakePlan({ ...input, suppliedFiles: [{ attachmentId: 'file-a', filename: 'Rate schedule PDF',
      sectionLabels: ['rates'], truncated: false, sourceSha256: 'a'.repeat(64), representationDigestSha256: 'b'.repeat(64) }] })!;
    const need = base.informationNeeds.find((entry) => entry.needKind === 'described_document')!;
    expect(need.state).toBe('supplied_uninterpreted');
    expect(resolveFdePlan(base, [], []).eligible).toBe(false);
    const file = base.pinnedInputs.suppliedFiles[0];
    const judgment = { needId: need.needId, disposition: 'confirmed' as const, conclusion: 'The schedule supports the proposed rate extraction.',
      rationale: 'Reviewed the supplied schedule.', sourceRefs: [{ kind: 'attachment' as const, id: file.attachmentId, digest: hashCanonical(file) }] };
    const resolved = resolveFdePlan(base, [judgment], []);
    expect(resolved.eligible).toBe(true);
    expect(resolved.resolvedPlan.needs[0].state).toBe('confirmed');
    expect(resolved.digest).toBe(hashCanonical(resolved.resolvedPlan));
    expect(resolveFdePlan(base, [{ ...judgment, sourceRefs: [{ ...judgment.sourceRefs[0], digest: '0'.repeat(64) }] }], []).eligible).toBe(false);
  });

  it('keeps an acknowledged missing-document waiver distinct from confirmed evidence', () => {
    const base = buildFdeIntakePlan({ ...input, suppliedFiles: [] })!;
    const need = base.informationNeeds.find((entry) => entry.needKind === 'described_document')!;
    expect(isFdeWaiverEligibleNeed(need, base)).toBe(true);
    const waiver = { needId: need.needId, requirement: need.description, customerStatement: 'Our rate schedule will be provided later.',
      reason: 'Proceed with planning while the schedule is unavailable.', acknowledgmentText: FDE_WAIVER_ACKNOWLEDGMENT_TEXT,
      acknowledgmentVersion: FDE_WAIVER_ACKNOWLEDGMENT_VERSION, acknowledged: true,
      sourceRefs: [{ kind: 'intake' as const, id: 'submission-a', digest: hashCanonical(base.pinnedInputs.intakeDigest) }] };
    expect(resolveFdePlan(base, [], [{ ...waiver, acknowledged: false }]).eligible).toBe(false);
    const resolved = resolveFdePlan(base, [], [waiver]);
    expect(resolved.eligible).toBe(true);
    expect(resolved.resolvedPlan.needs[0].state).toBe('waived');
    expect(resolved.resolvedPlan.waivedAssumptions).toHaveLength(1);
  });

  it('never lets a customer waiver override owner activation', () => {
    const base = buildFdeIntakePlan({ ...input, suppliedFiles: [] })!;
    const need = base.informationNeeds.find((entry) => entry.needKind === 'described_document')!;
    const ownerNeed = { ...need, needId: 'need_owner', needKind: 'owner_activation' as const, state: 'missing_human_decision' as const };
    const withOwner = { ...base, informationNeeds: [...base.informationNeeds, ownerNeed] };
    expect(isFdeWaiverEligibleNeed(ownerNeed, withOwner)).toBe(false);
    expect(resolveFdePlan(withOwner, [], [{ needId: ownerNeed.needId, requirement: ownerNeed.description,
      customerStatement: 'Please proceed', reason: 'Requested', acknowledgmentText: FDE_WAIVER_ACKNOWLEDGMENT_TEXT,
      acknowledgmentVersion: FDE_WAIVER_ACKNOWLEDGMENT_VERSION, acknowledged: true, sourceRefs: [] }]).eligible).toBe(false);
  });

  it('uses an explicit need association for a later document even when its filename differs', () => {
    const initial = buildFdeIntakePlan({ ...input, suppliedFiles: [] })!;
    const needId = initial.informationNeeds.find((entry) => entry.needKind === 'described_document')!.needId;
    const next = buildFdeIntakePlan({ ...input, suppliedFiles: [{ attachmentId: 'late-a', filename: 'customer-upload.pdf',
      associatedNeedIds: [needId], sectionLabels: ['rates'], truncated: false,
      sourceSha256: 'c'.repeat(64), representationDigestSha256: 'd'.repeat(64) }],
      supplementalEvidence: { evidenceRevision: 1, documents: [{ attachmentId: 'late-a',
        sourceSha256: 'c'.repeat(64), representationDigestSha256: 'd'.repeat(64), contextDigest: 'e'.repeat(64),
        status: 'processed', associatedNeedIds: [needId] }] } })!;
    expect(next.informationNeeds.find((entry) => entry.needId === needId)).toMatchObject({
      state: 'supplied_uninterpreted', sourceIds: ['late-a'],
    });
    expect(hashCanonical(next)).not.toBe(hashCanonical(initial));
  });

  it('reopens a waived document need when later evidence arrives', () => {
    const initial = buildFdeIntakePlan({ ...input, suppliedFiles: [] })!;
    const need = initial.informationNeeds.find((entry) => entry.needKind === 'described_document')!;
    const waiver = { needId: need.needId, requirement: need.description,
      customerStatement: 'We will supply the schedule later.', reason: 'Continue planning.',
      acknowledgmentText: FDE_WAIVER_ACKNOWLEDGMENT_TEXT,
      acknowledgmentVersion: FDE_WAIVER_ACKNOWLEDGMENT_VERSION, acknowledged: true,
      sourceRefs: [{ kind: 'intake' as const, id: 'submission-a', digest: hashCanonical(initial.pinnedInputs.intakeDigest) }] };
    expect(resolveFdePlan(initial, [], [waiver]).eligible).toBe(true);
    const revised = buildFdeIntakePlan({ ...input,
      suppliedFiles: [{ attachmentId: 'late-a', filename: 'rates.pdf', associatedNeedIds: [need.needId],
        sectionLabels: ['rates'], truncated: false, sourceSha256: 'c'.repeat(64),
        representationDigestSha256: 'd'.repeat(64) }],
      supplementalEvidence: { evidenceRevision: 1, documents: [{ attachmentId: 'late-a',
        sourceSha256: 'c'.repeat(64), representationDigestSha256: 'd'.repeat(64),
        contextDigest: 'e'.repeat(64), status: 'processed', associatedNeedIds: [need.needId] }] } })!;
    expect(revised.informationNeeds.find((entry) => entry.needId === need.needId)?.state).toBe('supplied_uninterpreted');
    expect(resolveFdePlan(revised, [], [waiver]).eligible).toBe(false);
    expect(resolveFdePlan(revised, [], []).eligible).toBe(false);
    expect(hashCanonical(revised)).not.toBe(hashCanonical(initial));
  });

  it('lets a later associated document supply an unanswered follow-up for human interpretation', () => {
    const withQuestion = { ...assessment, workflowSteps: [{ ...assessment.workflowSteps[0],
      unresolvedAssumptions: ['Which schedule is authoritative?'] }] };
    const initial = buildFdeIntakePlan({ ...input, assessment: withQuestion, suppliedFiles: [] })!;
    const followUp = initial.informationNeeds.find((entry) => entry.needKind === 'follow_up')!;
    const next = buildFdeIntakePlan({ ...input, assessment: withQuestion,
      suppliedFiles: [{ attachmentId: 'late-answer', filename: 'support.pdf', associatedNeedIds: [followUp.needId],
        sectionLabels: ['answer'], truncated: false }] })!;
    expect(next.informationNeeds.find((entry) => entry.needId === followUp.needId)).toMatchObject({
      state: 'supplied_uninterpreted', sourceIds: ['late-answer'],
    });
    expect(next.informationNeeds.some((entry) => entry.needKind === 'unmatched_file')).toBe(false);
  });
});
