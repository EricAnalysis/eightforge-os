import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAdmin = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getAdmin }));

import {
  recordWorkflowAssessmentReview,
  WORKFLOW_ASSESSMENT_REVIEW_WRITE_FUNCTION,
  type WorkflowAssessmentReviewInput,
} from '@/lib/server/workflowAssessmentReview';

const ASSESSMENT_ID = '22222222-2222-4222-8222-222222222222';
const REVIEWER_ID = '33333333-3333-4333-8333-333333333333';
const REVIEWER = { actorId: REVIEWER_ID, role: 'admin' } as const;

type RpcArgs = Record<string, unknown>;

function rpcClient(response: unknown) {
  const rpc = vi.fn(async (_name: string, _args?: RpcArgs) => response);
  getAdmin.mockReturnValue({ rpc });
  return rpc;
}

function input(
  overrides: Partial<WorkflowAssessmentReviewInput> = {},
): WorkflowAssessmentReviewInput {
  return {
    assessmentId: ASSESSMENT_ID,
    assessmentVersion: 1,
    stepReviews: [{
      disposition: 'accepted',
      assessmentStepId: 'step-1',
      proposedClassification: 'RULE',
      reviewedClassification: 'RULE',
    }],
    ...overrides,
  } as WorkflowAssessmentReviewInput;
}

const recorded = {
  data: [{
    review_id: '44444444-4444-4444-8444-444444444444',
    review_version: 1,
    overall_disposition: 'accepted',
    step_review_count: 1,
  }],
  error: null,
};

describe('workflow assessment review seam', () => {
  beforeEach(() => { getAdmin.mockReset(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('writes only through the validated SECURITY DEFINER function', async () => {
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);

    expect(result).toEqual({
      status: 'review_recorded',
      reviewId: '44444444-4444-4444-8444-444444444444',
      reviewVersion: 1,
      overallDisposition: 'accepted',
      stepReviewCount: 1,
      executable: false,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![0]).toBe(WORKFLOW_ASSESSMENT_REVIEW_WRITE_FUNCTION);
  });

  it('never sends an overall disposition: it is derived in the database', async () => {
    const rpc = rpcClient(recorded);
    await recordWorkflowAssessmentReview(input(), REVIEWER);
    const payload = JSON.stringify(rpc.mock.calls[0]![1]);
    expect(payload).not.toMatch(/overall/i);
  });

  it('never issues a direct table write', async () => {
    const rpc = vi.fn(async (_name: string, _args?: RpcArgs) => recorded);
    const from = vi.fn();
    getAdmin.mockReturnValue({ rpc, from });
    await recordWorkflowAssessmentReview(input(), REVIEWER);
    // The tables grant INSERT to nobody; the seam must not even attempt one.
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ['a caller-supplied overall disposition', { overallDisposition: 'accepted' }],
    ['a caller-supplied review version', { reviewVersion: 9 }],
    ['a caller-supplied source submission', { sourceSubmissionId: ASSESSMENT_ID }],
    ['a caller-asserted reviewer identity', { reviewerActorId: REVIEWER_ID }],
    ['a caller-asserted reviewer alias', { reviewer: REVIEWER_ID }],
    ['an arbitrary extra field', { deploy: true }],
  ])('rejects %s', async (_label, extra) => {
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(
      { ...input(), ...extra } as WorkflowAssessmentReviewInput, REVIEWER,
    );
    expect(result.status).toBe('input_invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['accepted carrying a changed classification', {
      disposition: 'accepted', assessmentStepId: 's1',
      proposedClassification: 'RULE', reviewedClassification: 'HUMAN',
    }],
    ['reclassified whose classification did not change', {
      disposition: 'reclassified', assessmentStepId: 's1',
      proposedClassification: 'RULE', reviewedClassification: 'RULE',
      reviewerNotes: 'no actual change',
    }],
    ['modified with no refined specification', {
      disposition: 'modified', assessmentStepId: 's1',
      proposedClassification: 'RULE', reviewedClassification: 'RULE',
      reviewerNotes: 'changed something, supplied nothing',
    }],
    ['rejected carrying an accepted specification', {
      disposition: 'rejected', assessmentStepId: 's1',
      proposedClassification: 'RECOVER', reviewerNotes: 'no',
      acceptedSpecification: { rule: 'x' },
    }],
    ['rejected carrying a reviewed classification', {
      disposition: 'rejected', assessmentStepId: 's1',
      proposedClassification: 'RECOVER', reviewedClassification: 'HUMAN',
      reviewerNotes: 'no',
    }],
    ['an unknown disposition', {
      disposition: 'approved', assessmentStepId: 's1',
      proposedClassification: 'RULE', reviewedClassification: 'RULE',
    }],
    ['an unknown classification', {
      disposition: 'accepted', assessmentStepId: 's1',
      proposedClassification: 'DEPLOY', reviewedClassification: 'DEPLOY',
    }],
  ])('rejects an incoherent step review: %s', async (_label, step) => {
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(
      input({ stepReviews: [step] as never }), REVIEWER,
    );
    expect(result.status).toBe('input_invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('preserves both classifications when a RULE is downgraded to HUMAN', async () => {
    const rpc = rpcClient({
      data: [{
        review_id: '44444444-4444-4444-8444-444444444444',
        review_version: 1, overall_disposition: 'changes_required', step_review_count: 1,
      }],
      error: null,
    });
    await recordWorkflowAssessmentReview(input({
      stepReviews: [{
        disposition: 'reclassified', assessmentStepId: 'step-1',
        proposedClassification: 'RULE', reviewedClassification: 'HUMAN',
        reviewerNotes: 'Approval authority is not delegable.',
      }],
    }), REVIEWER);
    const sent = rpc.mock.calls[0]![1] as unknown as { p_step_reviews: RpcArgs[] };
    expect(sent.p_step_reviews[0]).toMatchObject({
      proposed_classification: 'RULE',
      reviewed_classification: 'HUMAN',
      disposition: 'reclassified',
    });
  });

  it('rejects a repeated step id before reaching the database', async () => {
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(input({
      stepReviews: [
        { disposition: 'accepted', assessmentStepId: 'step-1',
          proposedClassification: 'RULE', reviewedClassification: 'RULE' },
        { disposition: 'accepted', assessmentStepId: 'step-1',
          proposedClassification: 'RULE', reviewedClassification: 'RULE' },
      ],
    }), REVIEWER);
    expect(result.status).toBe('duplicate_step_review');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['no workflow assessment 22222222 at version 3', 'assessment_not_found'],
    ['review must disposition every proposed step: expected 4, received 2', 'review_rejected'],
    ['step review references a step or proposed classification absent from assessment',
      'review_rejected'],
    ['some unrelated database failure', 'persist_failed'],
  ])('maps database failure %j to %s', async (message, expected) => {
    rpcClient({ data: null, error: { message } });
    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);
    expect(result.status).toBe(expected);
  });

  it('reports not_configured without a service client', async () => {
    getAdmin.mockReturnValue(null);
    await expect(recordWorkflowAssessmentReview(input(), REVIEWER))
      .resolves.toEqual({ status: 'not_configured' });
  });

  it('fails closed when the write returns no row', async () => {
    rpcClient({ data: [], error: null });
    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);
    expect(result.status).toBe('persist_failed');
  });

  it('does not leak reviewer prose into an input_invalid reason', async () => {
    const secret = 'reviewer typed a confidential business detail here';
    const result = await recordWorkflowAssessmentReview(input({
      reviewerSummary: secret, stepReviews: [] as never,
    }), REVIEWER);
    expect(result.status).toBe('input_invalid');
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each([
    ['a missing reviewer', undefined],
    ['an empty reviewer', {}],
    ['a non-uuid reviewer', { actorId: 'not-a-uuid', role: 'admin' }],
    ['a role name instead of a person', { actorId: 'service_role', role: 'admin' }],
    ['a null actorId', { actorId: null, role: 'admin' }],
  ])('fails closed on %s rather than attributing the review', async (_label, reviewer) => {
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(
      input(), reviewer as never,
    );
    expect(result.status).toBe('reviewer_unresolved');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('records the session reviewer, not anything from the payload', async () => {
    const rpc = rpcClient(recorded);
    await recordWorkflowAssessmentReview(
      { ...input(), reviewerActorId: '99999999-9999-4999-8999-999999999999' } as never,
      REVIEWER,
    );
    // The payload identity is rejected outright by the strict schema, so the
    // call never happens; identity can only arrive through the session.
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sends the session actor id to the database', async () => {
    const rpc = rpcClient(recorded);
    await recordWorkflowAssessmentReview(input(), REVIEWER);
    const sent = rpc.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(sent.p_reviewer_actor_id).toBe(REVIEWER_ID);
  });
  it.each([
    ['viewer', 'viewer'],
    ['member', 'member'],
    ['analyst', 'analyst'],
    ['empty string', ''],
    ['null role', null],
    ['service_role', 'service_role'],
  ])('refuses an ineligible reviewer role: %s', async (_label, role) => {
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(
      input(), { actorId: REVIEWER_ID, role } as never,
    );
    expect(result.status).toBe('reviewer_not_eligible');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([['owner'], ['admin'], ['Admin'], ['  OWNER  ']])(
    'allows eligible role %s', async (role) => {
      const rpc = rpcClient(recorded);
      const result = await recordWorkflowAssessmentReview(
        input(), { actorId: REVIEWER_ID, role } as never,
      );
      expect(result.status).toBe('review_recorded');
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );

  it('rebuilds the reviewed specification instead of passing it through', async () => {
    const rpc = rpcClient(recorded);
    await recordWorkflowAssessmentReview(input({
      stepReviews: [{
        disposition: 'modified', assessmentStepId: 'step-1',
        proposedClassification: 'RULE', reviewedClassification: 'RULE',
        reviewerNotes: 'Tightened the tolerance wording.',
        acceptedSpecification: {
          plainLanguageRule: 'Billed rate must equal the contract rate.',
          requiredFacts: ['Billed rate'], conditionType: 'comparison',
          expectedEvidence: ['Invoice line'], expectedOutcome: 'Flag a mismatch.',
          userDescribedExceptions: [], unresolvedAssumptions: [],
        },
      }],
    }), REVIEWER);
    const sent = rpc.mock.calls[0]![1] as unknown as { p_step_reviews: RpcArgs[] };
    const spec = sent.p_step_reviews[0]!.accepted_specification as Record<string, unknown>;
    expect(Object.keys(spec).sort()).toEqual([
      'conditionType', 'expectedEvidence', 'expectedOutcome', 'plainLanguageRule',
      'requiredFacts', 'unresolvedAssumptions', 'userDescribedExceptions',
    ]);
  });

  it.each([
    ['an unknown field', { plainLanguageRule: 'x', requiredFacts: ['a'],
      conditionType: 'comparison', expectedEvidence: ['e'], expectedOutcome: 'o',
      userDescribedExceptions: [], unresolvedAssumptions: [], sqlToRun: 'DROP TABLE x' }],
    ['arbitrary json', { anything: 'goes' }],
    ['an executable expression field', { expression: '1 = 1' }],
    ['a missing required field', { requiredFacts: ['a'] }],
  ])('rejects a reviewed specification with %s', async (_label, spec) => {
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(input({
      stepReviews: [{
        disposition: 'modified', assessmentStepId: 'step-1',
        proposedClassification: 'RULE', reviewedClassification: 'RULE',
        reviewerNotes: 'note', acceptedSpecification: spec,
      }],
    }), REVIEWER);
    expect(result.status).toBe('specification_invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('validates a reclassified step against its REVIEWED classification', async () => {
    const rpc = rpcClient(recorded);
    // RULE downgraded to HUMAN must carry a human-decision specification; the
    // rule shape it was downgraded away from must not survive.
    const result = await recordWorkflowAssessmentReview(input({
      stepReviews: [{
        disposition: 'reclassified', assessmentStepId: 'step-1',
        proposedClassification: 'RULE', reviewedClassification: 'HUMAN',
        reviewerNotes: 'Approval authority is not delegable.',
        acceptedSpecification: {
          plainLanguageRule: 'Billed rate must equal the contract rate.',
          requiredFacts: ['Billed rate'], conditionType: 'comparison',
          expectedEvidence: ['Invoice line'], expectedOutcome: 'Flag a mismatch.',
          userDescribedExceptions: [], unresolvedAssumptions: [],
        },
      }],
    }), REVIEWER);
    expect(result.status).toBe('specification_invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps an unknown reviewer from the database to reviewer_unresolved', async () => {
    rpcClient({ data: null, error: {
      message: 'workflow assessment reviewer 333 is not a known user profile',
    } });
    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);
    expect(result.status).toBe('reviewer_unresolved');
  });
});
