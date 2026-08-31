import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordReview = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/workflowAssessmentReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/workflowAssessmentReview')>()),
  recordWorkflowAssessmentReview: recordReview,
}));

import { POST } from '@/app/api/internal/workflow-assessment-review/route';

const ASSESSMENT_ID = '22222222-2222-4222-8222-222222222222';
const REVIEWER_ID = '33333333-3333-4333-8333-333333333333';
const SECRET = 'workflow-assessment-review-route-secret';

const body = (overrides: Record<string, unknown> = {}) => ({
  assessmentId: ASSESSMENT_ID,
  assessmentVersion: 1,
  reviewerActorId: REVIEWER_ID,
  stepReviews: [{
    disposition: 'accepted',
    assessmentStepId: 'step-1',
    proposedClassification: 'RULE',
    reviewedClassification: 'RULE',
  }],
  ...overrides,
});

function request(payload: unknown, authorization = `Bearer ${SECRET}`): Request {
  return new Request('http://localhost/api/internal/workflow-assessment-review', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('internal workflow assessment review route', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    recordReview.mockReset();
    recordReview.mockResolvedValue({
      status: 'review_recorded',
      reviewId: '44444444-4444-4444-8444-444444444444',
      reviewVersion: 1,
      overallDisposition: 'accepted',
      stepReviewCount: 1,
      executable: false,
    });
  });

  afterEach(() => { delete process.env.CRON_SECRET; });

  it('records a review for an authorized caller', async () => {
    const response = await POST(request(body()));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, reviewVersion: 1, overallDisposition: 'accepted', executable: false,
    });
  });

  it('returns 503 without a configured secret', async () => {
    delete process.env.CRON_SECRET;
    const response = await POST(request(body()));
    expect(response.status).toBe(503);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong secret', 'Bearer nope'],
    ['no authorization header', ''],
    ['a bare secret without the scheme', SECRET],
  ])('rejects %s before doing any work', async (_label, authorization) => {
    const response = await POST(request(body(), authorization));
    expect(response.status).toBe(401);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it.each([
    ['a caller-supplied overall disposition', { overallDisposition: 'accepted' }],
    ['a caller-supplied review version', { reviewVersion: 4 }],
    ['a caller-supplied reviewer identity override', { reviewer: 'someone else' }],
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
    ['a missing reviewer', { reviewerActorId: undefined }],
  ])('rejects %s with 400', async (_label, override) => {
    const response = await POST(request(body(override)));
    expect(response.status).toBe(400);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it('rejects a malformed body without reaching the seam', async () => {
    const response = await POST(new Request(
      'http://localhost/api/internal/workflow-assessment-review',
      { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: 'not json' },
    ));
    expect(response.status).toBe(400);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it.each([
    ['assessment_not_found', 404],
    ['not_configured', 503],
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
