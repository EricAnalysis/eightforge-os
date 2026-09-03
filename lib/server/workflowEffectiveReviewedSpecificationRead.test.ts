import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), admin: vi.fn(), resolve: vi.fn() }));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: mocks.actor }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: mocks.admin }));
vi.mock('@/lib/workflowEffectiveReviewedSpecification', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/workflowEffectiveReviewedSpecification')>(),
  resolveEffectiveReviewedSpecification: mocks.resolve,
}));

import { readEffectiveReviewedSpecification } from './workflowEffectiveReviewedSpecificationRead';

const pin = {
  assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 3,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 7,
};
const actor = {
  actorId: '33333333-3333-4333-8333-333333333333',
  email: 'reviewer@example.test', role: 'admin',
  organizationId: '44444444-4444-4444-8444-444444444444', displayName: null,
};
const tables = ['workflow_assessments', 'workflow_assessment_reviews',
  'workflow_assessment_step_reviews'] as const;
const request = () => new Request('https://example.test/internal/resolve', {
  headers: { authorization: 'Bearer test-session' },
});

type Response = { data: unknown; error: unknown };
function client(responses: Response[] = [
  { data: { id: pin.assessmentId }, error: null },
  { data: { id: pin.reviewId }, error: null },
  { data: [], error: null },
]) {
  const queries = responses.map((response) => {
    const settled = Promise.resolve(response);
    const query = {
      select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => response),
      then: settled.then.bind(settled),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return query;
  });
  const from = vi.fn((table: string) => queries[tables.indexOf(table as typeof tables[number])]);
  // Any unexpected mutation, RPC, intake read or ordering method is absent and
  // causes the successful-path assertion to fail.
  mocks.admin.mockReturnValue({ from });
  return { from, queries };
}

describe('effective reviewed specification read authorization and pinning', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', actor.email);
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES', '');
    mocks.actor.mockResolvedValue({ ok: true, actor });
    mocks.resolve.mockReturnValue({ ok: true, artifact: { test: 'resolved' } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resolves session identity before reading exactly the pinned assessment and review', async () => {
    const { from, queries } = client();
    const req = request();
    const result = await readEffectiveReviewedSpecification(req, pin);
    expect(result).toEqual({ ok: true, artifact: { test: 'resolved' } });
    expect(mocks.actor).toHaveBeenCalledWith(req);
    expect(mocks.actor.mock.invocationCallOrder[0]).toBeLessThan(mocks.admin.mock.invocationCallOrder[0]!);
    expect(from.mock.calls).toEqual(tables.map((table) => [table]));
    expect(queries[0]!.eq.mock.calls).toEqual([
      ['id', pin.assessmentId], ['assessment_version', pin.assessmentVersion],
    ]);
    expect(queries[1]!.eq.mock.calls).toEqual([
      ['id', pin.reviewId], ['review_version', pin.reviewVersion],
      ['assessment_id', pin.assessmentId], ['assessment_version', pin.assessmentVersion],
    ]);
    expect(queries[2]!.eq.mock.calls).toEqual([['review_id', pin.reviewId]]);
    expect(queries[0]!.maybeSingle).toHaveBeenCalledOnce();
    expect(queries[1]!.maybeSingle).toHaveBeenCalledOnce();
    expect(queries[2]!.maybeSingle).not.toHaveBeenCalled();
    expect(queries.map((query) => query.select.mock.calls[0]![0])).toEqual([
      'id, assessment_version, source_submission_id, assessment, authority, requires_human_review, created_at',
      'id, assessment_id, assessment_version, source_submission_id, review_version, reviewer_actor_id, overall_disposition, reviewer_summary, created_at',
      'id, review_id, assessment_step_id, proposed_classification, reviewed_classification, disposition, reviewer_notes, accepted_specification, created_at',
    ]);
  });

  it.each([401, 403, 503])('stops before evidence access on actor failure %s', async (status) => {
    mocks.actor.mockResolvedValue({ ok: false, status, error: 'sensitive auth detail' });
    expect(await readEffectiveReviewedSpecification(request(), pin)).toEqual({
      ok: false, code: status === 503 ? 'not_configured' : 'unauthorized',
    });
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('does not grant a tenant %s platform access', async (role) => {
    mocks.actor.mockResolvedValue({ ok: true, actor: { ...actor, role, email: 'other@example.test' } });
    expect(await readEffectiveReviewedSpecification(request(), pin)).toEqual({ ok: false, code: 'reviewer_not_eligible' });
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('fails closed when allowlists are empty', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', '');
    expect(await readEffectiveReviewedSpecification(request(), pin)).toEqual({ ok: false, code: 'reviewer_not_eligible' });
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('honors an explicitly allowlisted verified role', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', '');
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES', 'workflow-reviewer');
    mocks.actor.mockResolvedValue({ ok: true, actor: { ...actor, role: 'workflow-reviewer' } });
    client();
    expect((await readEffectiveReviewedSpecification(request(), pin)).ok).toBe(true);
  });

  it.each([
    {}, { ...pin, reviewId: undefined }, { ...pin, reviewVersion: undefined },
    { ...pin, assessmentVersion: '3' }, { ...pin, reviewVersion: 0 },
    { ...pin, reviewId: 'latest' }, { ...pin, reviewer: actor },
  ])('rejects incomplete, coerced or extended pins without evidence reads: %j', async (input) => {
    expect(await readEffectiveReviewedSpecification(request(), input)).toEqual({ ok: false, code: 'invalid_pin' });
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('reports absent admin configuration', async () => {
    mocks.admin.mockReturnValue(null);
    expect(await readEffectiveReviewedSpecification(request(), pin)).toEqual({ ok: false, code: 'not_configured' });
  });

  it.each([0, 1, 2])('fails closed on evidence read failure at query %s', async (failedIndex) => {
    const responses = [0, 1, 2].map((index) => ({
      data: index === 2 ? [] : {}, error: index === failedIndex ? { message: 'sensitive evidence' } : null,
    }));
    const { from } = client(responses);
    expect(await readEffectiveReviewedSpecification(request(), pin)).toEqual({ ok: false, code: 'read_failed' });
    expect(from).toHaveBeenCalledTimes(failedIndex + 1);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([0, 1])('never falls back when pinned row %s is absent', async (missingIndex) => {
    const { from } = client([0, 1, 2].map((index) => ({ data: index === missingIndex ? null : {}, error: null })));
    expect(await readEffectiveReviewedSpecification(request(), pin)).toEqual({
      ok: false, code: missingIndex === 0 ? 'assessment_not_found' : 'review_not_found',
    });
    expect(from).toHaveBeenCalledTimes(missingIndex + 1);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('passes raw evidence and the exact core result through without coercion or row filtering', async () => {
    const assessmentRow = { assessment_version: 'wrong-type', assessment: { untouched: [' b ', 'a'] } };
    const reviewRow = { review_version: null };
    const stepReviewRows = [null, { accepted_specification: { description: ' keep spaces ' } }, false];
    client([assessmentRow, reviewRow, stepReviewRows].map((data) => ({ data, error: null })));
    const failure = { ok: false, code: 'invalid_evidence', details: ['test'] };
    mocks.resolve.mockReturnValue(failure);
    expect(await readEffectiveReviewedSpecification(request(), pin)).toBe(failure);
    expect(mocks.resolve).toHaveBeenCalledWith({ pin, assessmentRow, reviewRow, stepReviewRows });
    const input = mocks.resolve.mock.calls[0]![0];
    expect(input.assessmentRow).toBe(assessmentRow);
    expect(input.reviewRow).toBe(reviewRow);
    expect(input.stepReviewRows).toBe(stepReviewRows);
  });

  it('does not turn a missing child payload into an empty successful review', async () => {
    client([{ data: {}, error: null }, { data: {}, error: null }, { data: null, error: null }]);
    mocks.resolve.mockReturnValue({ ok: false, code: 'invalid_evidence' });
    expect(await readEffectiveReviewedSpecification(request(), pin)).toEqual({ ok: false, code: 'invalid_evidence' });
    expect(mocks.resolve.mock.calls[0]![0].stepReviewRows).toBeNull();
  });

  it('returns a typed failure without leaking transport exceptions', async () => {
    mocks.admin.mockImplementation(() => { throw new Error('private database detail'); });
    expect(await readEffectiveReviewedSpecification(request(), pin)).toEqual({ ok: false, code: 'read_failed' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
