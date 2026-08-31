import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordReview = vi.hoisted(() => vi.fn());
const actorContext = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/workflowAssessmentReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/workflowAssessmentReview')>()),
  recordWorkflowAssessmentReview: recordReview,
}));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: actorContext }));

import { POST } from '@/app/api/internal/workflow-assessment-review/route';

const ASSESSMENT_ID = '22222222-2222-4222-8222-222222222222';
const REVIEWER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';

const body = (overrides: Record<string, unknown> = {}) => ({
  assessmentId: ASSESSMENT_ID,
  assessmentVersion: 1,
  stepReviews: [{
    disposition: 'accepted',
    assessmentStepId: 'step-1',
    proposedClassification: 'RULE',
    reviewedClassification: 'RULE',
  }],
  ...overrides,
});

function request(payload: unknown): Request {
  return new Request('http://localhost/api/internal/workflow-assessment-review', {
    method: 'POST',
    headers: { authorization: 'Bearer operator-session-jwt', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('workflow assessment review route', () => {
  beforeEach(() => {
    recordReview.mockReset();
    actorContext.mockReset();
    actorContext.mockResolvedValue({
      ok: true,
      actor: { actorId: REVIEWER_ID, organizationId: 'org-1', displayName: 'Op', role: 'admin' },
    });
    recordReview.mockResolvedValue({
      status: 'review_recorded',
      reviewId: '44444444-4444-4444-8444-444444444444',
      reviewVersion: 1,
      overallDisposition: 'accepted',
      stepReviewCount: 1,
      executable: false,
    });
  });

  it('records a review for an authenticated operator', async () => {
    const response = await POST(request(body()));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, reviewVersion: 1, overallDisposition: 'accepted', executable: false,
    });
  });

  it('passes the session actor as the reviewer, never the payload', async () => {
    await POST(request(body()));
    expect(recordReview).toHaveBeenCalledTimes(1);
    expect(recordReview.mock.calls[0]![1]).toEqual({ actorId: REVIEWER_ID });
  });

  it('never forwards a payload-asserted identity', async () => {
    // The strict schema rejects it outright, so the write never happens.
    const response = await POST(request(body({ reviewerActorId: OTHER_ID })));
    expect(response.status).toBe(400);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it('cannot be driven by the internal cron secret', async () => {
    // CRON_SECRET must not stand in for a human review. With no valid session,
    // the route refuses regardless of any shared secret being configured.
    process.env.CRON_SECRET = 'shared-machine-secret';
    actorContext.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    try {
      const response = await POST(request(body()));
      expect(response.status).toBe(401);
      expect(recordReview).not.toHaveBeenCalled();
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  it.each([
    ['no session', { ok: false, status: 401, error: 'Unauthorized' }, 401],
    ['no user_profiles row', { ok: false, status: 403, error: 'User profile not found' }, 403],
    ['no organization', { ok: false, status: 403, error: 'No organization' }, 403],
    ['auth not configured', { ok: false, status: 503, error: 'Server not configured' }, 503],
  ])('refuses when there is %s', async (_label, resolution, expected) => {
    actorContext.mockResolvedValue(resolution);
    const response = await POST(request(body()));
    expect(response.status).toBe(expected);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it('resolves identity before parsing the body', async () => {
    actorContext.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    const response = await POST(request({ total: 'garbage' }));
    // Unauthenticated callers learn nothing about payload validity.
    expect(response.status).toBe(401);
  });

  it.each([
    ['a caller-supplied overall disposition', { overallDisposition: 'accepted' }],
    ['a caller-supplied review version', { reviewVersion: 4 }],
    ['an execution request', { execute: true }],
    ['a deployment request', { deploy: true }],
    ['an arbitrary extra property', { unexpected: 'value' }],
  ])('rejects %s with 400 before orchestration', async (_label, extra) => {
    const response = await POST(request(body(extra)));
    expect(response.status).toBe(400);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-uuid assessment id', { assessmentId: 'not-a-uuid' }],
    ['a zero assessment version', { assessmentVersion: 0 }],
    ['an empty step review list', { stepReviews: [] }],
  ])('rejects %s with 400', async (_label, override) => {
    const response = await POST(request(body(override)));
    expect(response.status).toBe(400);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it('rejects a malformed body without reaching the seam', async () => {
    const response = await POST(new Request(
      'http://localhost/api/internal/workflow-assessment-review',
      { method: 'POST', headers: { authorization: 'Bearer jwt' }, body: 'not json' },
    ));
    expect(response.status).toBe(400);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it.each([
    ['assessment_not_found', 404],
    ['not_configured', 503],
    ['reviewer_unresolved', 403],
    ['duplicate_step_review', 422],
    ['review_rejected', 422],
    ['persist_failed', 500],
    ['input_invalid', 400],
  ])('maps seam status %s to HTTP %i', async (status, expected) => {
    recordReview.mockResolvedValue({ status, reason: 'r' });
    const response = await POST(request(body()));
    expect(response.status).toBe(expected);
  });

  it('never returns the database reason to the caller', async () => {
    recordReview.mockResolvedValue({
      status: 'persist_failed', reason: 'relation "secret_table" denied',
    });
    const response = await POST(request(body()));
    await expect(response.text()).resolves.not.toContain('secret_table');
  });

  it('exposes no read path', async () => {
    const route = await import('@/app/api/internal/workflow-assessment-review/route');
    expect(Object.keys(route)).not.toContain('GET');
  });
});
