import { describe, expect, it } from 'vitest';
import { resolveEffectiveReviewedSpecification } from '@/lib/workflowEffectiveReviewedSpecification';
import { buildReviewedWorkflowAdaptationContext } from './reviewedWorkflowContext';

function fixture(disposition: 'accepted' | 'modified' | 'rejected' = 'accepted') {
  const assessmentId = '11111111-1111-4111-8111-111111111111';
  const reviewId = '22222222-2222-4222-8222-222222222222';
  const sourceId = '33333333-3333-4333-8333-333333333333';
  const actorId = '44444444-4444-4444-8444-444444444444';
  const at = '2026-10-12T00:00:00Z';
  const proposal = 'CRM and scheduling status reconciliation every morning; success is no unexplained mismatch.';
  const evidence = {
    pin: { assessmentId, assessmentVersion: 1, reviewId, reviewVersion: 1 },
    assessmentRow: { id: assessmentId, assessment_version: 1, source_submission_id: sourceId,
      authority: 'non_authoritative', requires_human_review: true, created_at: at,
      assessment: {
        summary: 'UNREVIEWED provider summary', documents: [],
        workflowSteps: [{ stepId: 'context', sourceQuestions: ['workflowDescription'],
          description: 'Describe reconciliation context', classification: 'ADVISORY', rationale: 'Context only',
          requiredInputs: [], evidenceRequirements: [], proposedOutput: 'Operational context',
          dependencies: [], failureConsequence: 'Unknown context', unresolvedAssumptions: [],
          determinismBasis: null, determinismGaps: [], determinismSupport: [] }],
        extractionRequirements: [], deterministicRuleProposals: [], evidenceRelationships: [],
        verificationRuleProposals: [], forgewingRecoveryTasks: [], humanDecisionPoints: [],
        advisorySteps: [{ advisoryId: 'context-proposal', stepId: 'context', description: proposal }],
        failureConsequences: [], limitations: [],
      } },
    reviewRow: { id: reviewId, assessment_id: assessmentId, assessment_version: 1,
      source_submission_id: sourceId, review_version: 1, reviewer_actor_id: actorId,
      overall_disposition: disposition === 'modified' ? 'changes_required' : disposition,
      reviewer_summary: null, created_at: at },
    stepReviewRows: [{ id: '55555555-5555-4555-8555-555555555555', review_id: reviewId,
      assessment_step_id: 'context', proposed_classification: 'ADVISORY',
      reviewed_classification: disposition === 'rejected' ? null : 'ADVISORY', disposition,
      reviewer_notes: disposition === 'accepted' ? null : 'Human correction',
      accepted_specification: disposition === 'modified'
        ? { description: 'Reconcile weekly; managers decide ambiguous customer status; success is traceable resolution.' } : null,
      created_at: at }],
  };
  const resolved = resolveEffectiveReviewedSpecification(evidence);
  if (!resolved.ok) throw new Error(resolved.code);
  return resolved.artifact;
}

describe('reviewed workflow context for future adaptation proposals', () => {
  it('retains only reviewed specifications, exact identity and human provenance', () => {
    const input = fixture();
    const original = JSON.stringify(input);
    const result = buildReviewedWorkflowAdaptationContext(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.source).toEqual({ pin: input.pin,
      effectiveReviewedSpecificationDigestSha256: input.digest.value });
    expect(result.context.reviewedSteps[0]?.provenance.reviewerActorId)
      .toBe(input.evidence.parentReview.reviewer_actor_id);
    expect(JSON.stringify(result.context)).not.toContain('UNREVIEWED provider summary');
    expect(result.context).toMatchObject({ authority: 'non_authoritative', executable: false,
      grantsExecutionAuthority: false, grantsMappingActivationAuthority: false,
      requiresSeparateAdaptationApproval: true });
    expect(result.context).not.toHaveProperty('organizationId');
    expect(result.context).not.toHaveProperty('mappings');
    expect(Object.isFrozen(result.context.reviewedSteps[0]?.effectiveSpecification)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(JSON.stringify(input)).toBe(original);
    expect(buildReviewedWorkflowAdaptationContext(input)).toEqual(result);
  });

  it('uses the human replacement instead of original provider prose', () => {
    const result = buildReviewedWorkflowAdaptationContext(fixture('modified'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.reviewedSteps[0]?.effectiveSpecification).toEqual({
      description: 'Reconcile weekly; managers decide ambiguous customer status; success is traceable resolution.' });
    expect(JSON.stringify(result.context)).not.toContain('every morning');
  });

  it('requires human review and declines rejected-only context', () => {
    const input = fixture();
    expect(buildReviewedWorkflowAdaptationContext(input.evidence.assessment)).toEqual({
      ok: false, code: 'invalid_reviewed_artifact' });
    expect(buildReviewedWorkflowAdaptationContext({ ...input, evidence: {
      ...input.evidence, stepReviews: [] } })).toEqual({ ok: false, code: 'invalid_reviewed_artifact' });
    expect(buildReviewedWorkflowAdaptationContext(fixture('rejected'))).toEqual({
      ok: false, code: 'no_reviewed_context' });
  });

  it.each(['specification', 'digest', 'pin', 'tenant', 'activation'])('rejects %s tampering', (kind) => {
    const input = JSON.parse(JSON.stringify(fixture()));
    if (kind === 'specification') input.effectiveImplementationSet[0].effectiveSpecification.description = 'AI replacement';
    if (kind === 'digest') input.digest.value = 'f'.repeat(64);
    if (kind === 'pin') input.pin.reviewVersion = 9;
    if (kind === 'tenant') input.organizationId = '66666666-6666-4666-8666-666666666666';
    if (kind === 'activation') input.grantsMappingActivationAuthority = true;
    expect(buildReviewedWorkflowAdaptationContext(input)).toEqual({ ok: false, code: 'invalid_reviewed_artifact' });
  });
});
