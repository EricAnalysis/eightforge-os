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
const REVIEWER_EMAIL = 'platform.reviewer@example.test';
// Authorization is now platform-wide and allowlist-driven. An organization
// role such as 'admin' no longer grants review access on its own, so tests that
// exercise an authorized path must configure the allowlist explicitly.
const REVIEWER = {
  actorId: REVIEWER_ID, role: 'admin', email: REVIEWER_EMAIL,
} as const;

type RpcArgs = Record<string, unknown>;

/**
 * A client whose stored assessment is structurally composable.
 *
 * The seam re-checks proposal closure against the persisted payload before
 * allowing "accepted as proposed", so tests exercising that path need a stored
 * assessment to check. `closure` overrides it to model a historical assessment
 * that predates the current contract.
 */
function rpcClient(response: unknown, closure?: unknown) {
  const rpc = vi.fn(async (_name: string, _args?: RpcArgs) => response);
  const assessment = closure ?? {
    workflowSteps: [{ stepId: 'step-1', classification: 'RULE' }],
    deterministicRuleProposals: [{
      ruleId: 'r1', stepId: 'step-1', plainLanguageRule: 'Compare the facts',
      requiredFacts: ['fact'], conditionType: 'comparison',
      expectedEvidence: ['evidence'], expectedOutcome: 'match',
      userDescribedExceptions: [], unresolvedAssumptions: [],
    }],
    verificationRuleProposals: [], extractionRequirements: [],
    forgewingRecoveryTasks: [], humanDecisionPoints: [], advisorySteps: [],
    failureConsequences: [],
  };
  getAdmin.mockReturnValue({
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { assessment }, error: null }) }) }),
      }),
    }),
  });
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
  beforeEach(() => {
    getAdmin.mockReset();
    process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS = REVIEWER_EMAIL;
    delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_ROLES;
  });
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS;
    delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_ROLES;
  });

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

  it.each(['accepted', 'rejected'] as const)(
    'omits the specification key for %s, preserving SQL NULL rather than JSON null', async (disposition) => {
      const rpc = rpcClient(recorded);
      const stepReview = disposition === 'accepted'
        ? input().stepReviews[0]!
        : { disposition, assessmentStepId: 'step-1', proposedClassification: 'RULE' as const,
          reviewerNotes: 'The proposal is not suitable.' };
      const result = await recordWorkflowAssessmentReview(input({ stepReviews: [stepReview] }), REVIEWER);
      expect(result.status).toBe('review_recorded');
      const payload = rpc.mock.calls[0]![1] as { p_step_reviews: Record<string, unknown>[] };
      expect(payload.p_step_reviews[0]).not.toHaveProperty('accepted_specification');
    },
  );

  it('never issues a direct table write', async () => {
    const rpc = vi.fn(async (_name: string, _args?: RpcArgs) => recorded);
    // The closure gate legitimately READS the stored assessment before allowing
    // "accepted as proposed". What must never happen is a write: the review
    // tables grant INSERT to nobody, and the RPC is the only writer.
    const builder = {
      select: vi.fn(() => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                assessment: {
                  workflowSteps: [{ stepId: 'step-1', classification: 'RULE' }],
                  deterministicRuleProposals: [{
                    ruleId: 'r1', stepId: 'step-1', plainLanguageRule: 'Compare facts.',
                    requiredFacts: ['fact'], conditionType: 'comparison',
                    expectedEvidence: ['source'], expectedOutcome: 'match',
                    userDescribedExceptions: [], unresolvedAssumptions: [],
                  }],
                  verificationRuleProposals: [], extractionRequirements: [],
                  forgewingRecoveryTasks: [], humanDecisionPoints: [],
                  advisorySteps: [], failureConsequences: [],
                },
              },
              error: null,
            }),
          }),
        }),
      })),
    } as Record<string, unknown>;
    const from = vi.fn((table: string) => {
      // Only the assessment table, and only to read it.
      expect(table).toBe('workflow_assessments');
      return builder;
    });
    getAdmin.mockReturnValue({ rpc, from });

    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);
    expect(result.status).toBe('review_recorded');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(builder.insert).toBeUndefined();
    expect(builder.update).toBeUndefined();
    expect(builder.delete).toBeUndefined();
    expect(builder.select).toHaveBeenCalled();
    // The review tables themselves are never touched directly.
    for (const call of from.mock.calls) {
      expect(call[0]).not.toContain('review');
    }
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
        acceptedSpecification: {
          description: 'Approve a payment adjustment.',
          whyHumanControlled: 'Approval authority is not delegable.',
        },
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

  // These roles used to grant review access on their own. They must not: a
  // workflow assessment belongs to no organization, so an organization
  // administrator has no claim on another tenant's submitted business process.
  it.each([['owner'], ['admin'], ['Admin'], ['  OWNER  ']])(
    'refuses organization role %s when it is not allowlisted', async (role) => {
      const rpc = rpcClient(recorded);
      const result = await recordWorkflowAssessmentReview(
        input(), { actorId: REVIEWER_ID, role, email: 'someone@other.test' } as never,
      );
      expect(result.status).toBe('reviewer_not_eligible');
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('allows an allowlisted platform reviewer email', async () => {
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);
    expect(result.status).toBe('review_recorded');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('allows an allowlisted platform role', async () => {
    process.env.INTERNAL_ORCHESTRATOR_ALLOWED_ROLES = 'platform_reviewer';
    delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS;
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(
      input(), { actorId: REVIEWER_ID, role: 'platform_reviewer', email: null } as never,
    );
    expect(result.status).toBe('review_recorded');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('fails closed when no allowlist is configured at all', async () => {
    delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS;
    delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_ROLES;
    const rpc = rpcClient(recorded);
    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);
    expect(result).toMatchObject({
      status: 'reviewer_not_eligible', reason: 'not_configured',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

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
  // A historical assessment stored before the closure rules existed was never
  // validated against them, and it is immutable. It stays readable; what it
  // loses is the right to be approved as proposed.
  it('refuses accepted-as-proposed against an incompatible historical assessment', async () => {
    const rpc = rpcClient(recorded, {
      // Two rule proposals for one step: a resolver composing the effective
      // specification would have no rule for choosing between them.
      workflowSteps: [{ stepId: 'step-1', classification: 'RULE' }],
      deterministicRuleProposals: [
        { ruleId: 'r1', stepId: 'step-1' }, { ruleId: 'r2', stepId: 'step-1' },
      ],
      verificationRuleProposals: [], extractionRequirements: [],
      forgewingRecoveryTasks: [], humanDecisionPoints: [], advisorySteps: [],
      failureConsequences: [],
    });
    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);
    expect(result.status).toBe('assessment_incompatible_with_current_review_contract');
    // Nothing was written, and the assessment was not repaired.
    expect(rpc).not.toHaveBeenCalled();
  });

  it('allows complete replacements of unused malformed historical details with valid step identity', async () => {
    // Only modified/reclassified/rejected steps: the effective specification
    // comes from typed reviewed artifacts, not from the original proposal, so
    // historical proposal closure is not load-bearing here.
    const rpc = rpcClient(recorded, {
      // Step identity remains pinned, while the unused historical HUMAN detail
      // is intentionally incomplete and may be superseded by the replacement.
      workflowSteps: [{ stepId: 'step-1', classification: 'HUMAN' }],
      humanDecisionPoints: [{ stepId: 'step-1' }],
    });
    const result = await recordWorkflowAssessmentReview(input({
      stepReviews: [{
        disposition: 'modified', assessmentStepId: 'step-1',
        proposedClassification: 'HUMAN', reviewedClassification: 'HUMAN',
        reviewerNotes: 'tightened',
        acceptedSpecification: {
          description: 'Approve an adjustment.',
          whyHumanControlled: 'Not delegable.',
        },
      }],
    }), REVIEWER);
    expect(result.status).toBe('review_recorded');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 42, ''])('rejects a historical RULE with detail ID %s when accepted', async (ruleId) => {
    const rpc = rpcClient(recorded, {
      workflowSteps: [{ stepId: 'step-1', classification: 'RULE' }],
      deterministicRuleProposals: [{ stepId: 'step-1', ruleId }],
    });
    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);
    expect(result.status).toBe('assessment_incompatible_with_current_review_contract');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['modified', 'reclassified'] as const)(
    'allows a complete %s replacement of a malformed historical RULE', async (disposition) => {
      const rpc = rpcClient(recorded, {
        workflowSteps: [{ stepId: 'step-1', classification: 'RULE' }],
        deterministicRuleProposals: [{ stepId: 'step-1', ruleId: 42 }],
      });
      const acceptedSpecification = disposition === 'modified' ? {
        plainLanguageRule: 'Compare the supplied facts.', requiredFacts: ['fact'],
        conditionType: 'comparison', expectedEvidence: ['source record'],
        expectedOutcome: 'Report whether the facts match.',
        userDescribedExceptions: [], unresolvedAssumptions: [],
      } : {
        description: 'Review the supplied facts.', whyHumanControlled: 'Requires human judgment.',
      };
      const result = await recordWorkflowAssessmentReview(input({ stepReviews: [{
        disposition, assessmentStepId: 'step-1', proposedClassification: 'RULE',
        reviewedClassification: disposition === 'modified' ? 'RULE' : 'HUMAN',
        reviewerNotes: 'Replace the incomplete historical proposal.', acceptedSpecification,
      }] }), REVIEWER);
      expect(result.status).toBe('review_recorded');
      const payload = rpc.mock.calls[0]![1] as { p_step_reviews: Record<string, unknown>[] };
      expect(payload.p_step_reviews[0]!.accepted_specification).toEqual(acceptedSpecification);
    },
  );

  it.each(['accepted', 'modified', 'reclassified', 'rejected'] as const)(
    'rejects malformed stored step identity for %s', async (disposition) => {
      const rpc = rpcClient(recorded, {
        workflowSteps: [{ stepId: 42, classification: 'RULE' }],
      });
      const stepReview = disposition === 'accepted' ? input().stepReviews[0]!
        : disposition === 'rejected'
          ? { disposition, assessmentStepId: 'step-1', proposedClassification: 'RULE' as const,
            reviewerNotes: 'The proposal is not suitable.' }
          : {
            disposition, assessmentStepId: 'step-1', proposedClassification: 'RULE' as const,
            reviewedClassification: disposition === 'modified' ? 'RULE' as const : 'HUMAN' as const,
            reviewerNotes: 'Replace the original.',
            acceptedSpecification: disposition === 'modified' ? {
              plainLanguageRule: 'Compare facts.', requiredFacts: ['fact'],
              conditionType: 'comparison', expectedEvidence: ['source'], expectedOutcome: 'match',
              userDescribedExceptions: [], unresolvedAssumptions: [],
            } : { description: 'Review facts.', whyHumanControlled: 'Judgment.' },
          };
      const result = await recordWorkflowAssessmentReview(input({ stepReviews: [stepReview] }), REVIEWER);
      expect(result.status).toBe('assessment_incompatible_with_current_review_contract');
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  // The closure check must run against the EXACT assessment version under
  // review, not the latest for that submission. A version mismatch would let a
  // newer compatible assessment vouch for an older incompatible one, and the
  // effective specification would then be composed from proposals nobody
  // checked.
  it('checks closure against the exact assessment id and version under review', async () => {
    const filters: Array<[string, unknown]> = [];
    const rpc = vi.fn(async (_name: string, _args?: RpcArgs) => recorded);
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
      maybeSingle: async () => ({
        data: {
          assessment: {
            workflowSteps: [{ stepId: 'step-1', classification: 'RULE' }],
            deterministicRuleProposals: [{ ruleId: 'r1', stepId: 'step-1' }],
            verificationRuleProposals: [], extractionRequirements: [],
            forgewingRecoveryTasks: [], humanDecisionPoints: [],
            advisorySteps: [], failureConsequences: [],
          },
        },
        error: null,
      }),
    } as Record<string, unknown>;
    getAdmin.mockReturnValue({ rpc, from: () => chain });

    await recordWorkflowAssessmentReview(
      input({ assessmentId: ASSESSMENT_ID, assessmentVersion: 7 }), REVIEWER,
    );

    expect(filters).toEqual([
      ['id', ASSESSMENT_ID],
      ['assessment_version', 7],
    ]);
  });

  it('does not fall back to the latest version when the pinned one is absent', async () => {
    const rpc = vi.fn(async (_name: string, _args?: RpcArgs) => recorded);
    const chain = {
      select: () => chain,
      eq: () => chain,
      // No row at that exact version.
      maybeSingle: async () => ({ data: null, error: null }),
    } as Record<string, unknown>;
    getAdmin.mockReturnValue({ rpc, from: () => chain });

    const result = await recordWorkflowAssessmentReview(input(), REVIEWER);
    expect(result.status).toBe('assessment_not_found');
    expect(rpc).not.toHaveBeenCalled();
  });
});
