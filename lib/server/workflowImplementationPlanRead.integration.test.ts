import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { resolveEffectiveReviewedSpecification } from '@/lib/workflowEffectiveReviewedSpecification';
import { buildWorkflowImplementationPlan } from '@/lib/workflowImplementationPlan';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), admin: vi.fn() }));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: mocks.actor }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: mocks.admin }));

import { readWorkflowImplementationPlan } from './workflowImplementationPlanRead';
import { GET } from '@/app/api/internal/workflow-assessments/[assessmentId]/implementation-plan/route';

const pin = {
  assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 3,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 7,
};
const actor = {
  actorId: '33333333-3333-4333-8333-333333333333', email: 'reviewer@example.test',
  role: 'admin', organizationId: '44444444-4444-4444-8444-444444444444', displayName: null,
};
const sourceId = '55555555-5555-4555-8555-555555555555';
const tables = ['workflow_assessments', 'workflow_assessment_reviews', 'workflow_assessment_step_reviews'];
const request = () => new Request('https://example.test/internal/plan', {
  headers: { authorization: 'Bearer test-session' },
});

function evidence() {
  const stepIds = ['kept-advisory', 'rejected-advisory'];
  return {
    pin,
    assessmentRow: {
      id: pin.assessmentId, assessment_version: pin.assessmentVersion,
      source_submission_id: sourceId, authority: 'non_authoritative', requires_human_review: true,
      created_at: '2026-09-03T00:00:00Z',
      assessment: {
        summary: 'Pinned advisory assessment', documents: [],
        workflowSteps: stepIds.map((stepId) => ({
          stepId, sourceQuestions: ['workflowDescription'], description: `${stepId} description`,
          classification: 'ADVISORY', rationale: 'Operator guidance', requiredInputs: [],
          evidenceRequirements: [], proposedOutput: 'Guidance', dependencies: [],
          failureConsequence: 'Guidance unavailable', unresolvedAssumptions: [],
          determinismBasis: null, determinismGaps: [], determinismSupport: [],
        })),
        extractionRequirements: [], deterministicRuleProposals: [], evidenceRelationships: [],
        verificationRuleProposals: [], forgewingRecoveryTasks: [], humanDecisionPoints: [],
        advisorySteps: stepIds.map((stepId) => ({
          advisoryId: `${stepId}-detail`, stepId, description: `${stepId} exact prose`,
        })),
        failureConsequences: stepIds.map((stepId) => ({
          consequenceId: `${stepId}-consequence`, stepId, description: 'Guidance unavailable', severity: 'moderate',
        })), limitations: [],
      },
    },
    reviewRow: {
      id: pin.reviewId, assessment_id: pin.assessmentId, assessment_version: pin.assessmentVersion,
      source_submission_id: sourceId, review_version: pin.reviewVersion,
      reviewer_actor_id: actor.actorId, overall_disposition: 'changes_required',
      reviewer_summary: 'One advisory retained', created_at: '2026-09-03T00:01:00Z',
    },
    stepReviewRows: stepIds.map((stepId, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`,
      review_id: pin.reviewId, assessment_step_id: stepId, proposed_classification: 'ADVISORY',
      reviewed_classification: index === 0 ? 'ADVISORY' : null,
      disposition: index === 0 ? 'accepted' : 'rejected', reviewer_notes: `  ${stepId} note\n`,
      accepted_specification: null, created_at: '2026-09-03T00:01:00Z',
    })),
  };
}

function client(input = evidence(), override: Partial<Record<number, unknown>> = {}) {
  const payloads: unknown[] = [input.assessmentRow, input.reviewRow, input.stepReviewRows];
  const queries = payloads.map((payload, index) => {
    const response = { data: index in override ? override[index] : payload, error: null };
    const settled = Promise.resolve(response);
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => response), then: settled.then.bind(settled) };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return query;
  });
  // No mutation, RPC, ordering, latest-selection, or intake methods exist.
  const from = vi.fn((table: string) => queries[tables.indexOf(table)]);
  mocks.admin.mockReturnValue({ from });
  return { from, queries };
}

describe('trusted implementation plan consumer with real resolver and builder', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', actor.email);
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES', '');
    mocks.actor.mockResolvedValue({ ok: true, actor });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network/provider calls forbidden'); }));
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('loads exactly the four-part pin and preserves the real projection, readiness and both digests', async () => {
    const input = evidence();
    const resolved = resolveEffectiveReviewedSpecification(input);
    if (!resolved.ok) return expect.fail(`Invalid fixture: ${resolved.code}`);
    const expected = buildWorkflowImplementationPlan(resolved.artifact);
    const { from, queries } = client(input);
    const req = request();
    const result = await readWorkflowImplementationPlan(req, pin);
    expect(result).toStrictEqual(expected);
    if (!result.ok) return expect.fail(`Read failed: ${result.code}`);
    expect(result.artifact.source).toEqual({ pin, effectiveReviewedSpecificationDigestSha256: resolved.artifact.digest.value });
    expect(result.artifact.plannedSteps).toHaveLength(1);
    expect(result.artifact.plannedSteps[0]).toMatchObject({
      stepId: 'kept-advisory', specification: { description: 'kept-advisory exact prose' },
      implementationReadiness: { state: 'specification_complete' },
      provenance: { ...pin, reviewerNotes: '  kept-advisory note\n' },
    });
    expect(result.artifact.rejectedSteps).toStrictEqual(resolved.artifact.steps.filter((step) => step.disposition === 'rejected'));
    expect(result.artifact.rejectedSteps.map((step) => step.stepId)).toEqual(['rejected-advisory']);
    const { digest, ...envelope } = result.artifact;
    expect(digest.value).toBe(hashCanonical(envelope));
    expect(digest.value).not.toBe(resolved.artifact.digest.value);
    expect(result.artifact).toMatchObject({ authority: 'non_authoritative', executable: false, grantsExecutionAuthority: false });
    expect(mocks.actor).toHaveBeenCalledWith(req);
    expect(mocks.actor.mock.invocationCallOrder[0]).toBeLessThan(mocks.admin.mock.invocationCallOrder[0]!);
    expect(from.mock.calls).toEqual(tables.map((table) => [table]));
    expect(queries.map((query) => query.eq.mock.calls)).toEqual([
      [['id', pin.assessmentId], ['assessment_version', pin.assessmentVersion]],
      [['id', pin.reviewId], ['review_version', pin.reviewVersion], ['assessment_id', pin.assessmentId], ['assessment_version', pin.assessmentVersion]],
      [['review_id', pin.reviewId]],
    ]);
    expect(queries[0]!.maybeSingle).toHaveBeenCalledOnce();
    expect(queries[1]!.maybeSingle).toHaveBeenCalledOnce();
    expect(queries[2]!.maybeSingle).not.toHaveBeenCalled();
  });

  it('returns the real plan and both digests through GET with no-store', async () => {
    const input = evidence();
    const resolved = resolveEffectiveReviewedSpecification(input);
    if (!resolved.ok) return expect.fail(`Invalid fixture: ${resolved.code}`);
    const expected = buildWorkflowImplementationPlan(resolved.artifact);
    if (!expected.ok) return expect.fail('Invalid expected plan');
    client(input);
    const req = new Request(`https://example.test/api/internal/workflow-assessments/${pin.assessmentId}/implementation-plan?assessmentVersion=3&reviewId=${pin.reviewId}&reviewVersion=7`);
    const response = await GET(req, { params: Promise.resolve({ assessmentId: pin.assessmentId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toStrictEqual({ plan: expected.artifact });
    expect(mocks.actor).toHaveBeenCalledWith(req);
  });

  it.each(['assessmentId', 'reviewId'] as const)('rejects malformed %s through GET and the real seam', async (field) => {
    const invalid = { ...pin, [field]: 'latest' };
    const req = new Request(`https://example.test/internal/plan?assessmentVersion=3&reviewId=${invalid.reviewId}&reviewVersion=7`);
    const response = await GET(req, { params: Promise.resolve({ assessmentId: invalid.assessmentId }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_pin' });
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('returns byte-identical plans for repeated reads of unchanged pinned evidence', async () => {
    const { from } = client();
    const first = await readWorkflowImplementationPlan(request(), pin);
    const second = await readWorkflowImplementationPlan(request(), pin);
    expect(first.ok).toBe(true);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(from).toHaveBeenCalledTimes(6);
    expect(mocks.actor).toHaveBeenCalledTimes(2);
  });

  it('re-reads evidence and recomputes the plan on every request without caching', async () => {
    const firstClient = client();
    const first = await readWorkflowImplementationPlan(request(), pin);
    const changed = evidence();
    changed.assessmentRow.assessment.advisorySteps[0]!.description = 'Changed persisted advisory';
    const secondClient = client(changed);
    const second = await readWorkflowImplementationPlan(request(), pin);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.artifact.plannedSteps[0]!.specification).toEqual({ description: 'Changed persisted advisory' });
    expect(second.artifact.digest.value).not.toBe(first.artifact.digest.value);
    expect(second.artifact.source.effectiveReviewedSpecificationDigestSha256).not.toBe(first.artifact.source.effectiveReviewedSpecificationDigestSha256);
    expect(firstClient.from).toHaveBeenCalledTimes(3);
    expect(secondClient.from).toHaveBeenCalledTimes(3);
    expect(mocks.actor).toHaveBeenCalledTimes(2);
  });

  it('stops unauthorized callers before database access', async () => {
    mocks.actor.mockResolvedValue({ ok: false, status: 401, error: 'private auth detail' });
    expect(await readWorkflowImplementationPlan(request(), pin)).toEqual({ ok: false, code: 'unauthorized' });
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('rejects an authenticated tenant administrator outside the platform allowlist', async () => {
    mocks.actor.mockResolvedValue({ ok: true, actor: { ...actor, email: 'other@example.test' } });
    expect(await readWorkflowImplementationPlan(request(), pin)).toEqual({ ok: false, code: 'reviewer_not_eligible' });
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each([0, 1])('does not replace missing pinned evidence at query %s', async (index) => {
    const { from } = client(evidence(), { [index]: null });
    expect(await readWorkflowImplementationPlan(request(), pin)).toEqual({
      ok: false, code: index === 0 ? 'assessment_not_found' : 'review_not_found',
    });
    expect(from).toHaveBeenCalledTimes(index + 1);
  });

  it('propagates historical proposal incompatibility without producing a partial plan', async () => {
    const input = evidence();
    input.assessmentRow.assessment.advisorySteps = [];
    client(input);
    expect(await readWorkflowImplementationPlan(request(), pin)).toEqual({ ok: false, code: 'proposal_not_composable' });
  });

  it('rejects incomplete child evidence through the real resolver', async () => {
    client(evidence(), { 2: [] });
    expect(await readWorkflowImplementationPlan(request(), pin)).toEqual({ ok: false, code: 'missing_step_review' });
  });
});
