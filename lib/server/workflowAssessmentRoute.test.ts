import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runAssessment = vi.hoisted(() => vi.fn());

// The manual trigger now goes through the shared claim seam, so it cannot
// reach the provider without acquiring a claim the sweep would also need.
vi.mock('@/lib/server/workflowAssessmentClaim', () => ({
  executeClaimedWorkflowAssessment: runAssessment,
}));

import { POST } from '@/app/api/internal/workflow-assessment/route';

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'workflow-assessment-review-secret';

function request(body: unknown, authorization = `Bearer ${SECRET}`): Request {
  return new Request('http://localhost/api/internal/workflow-assessment', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('internal workflow assessment route', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    runAssessment.mockReset();
    runAssessment.mockResolvedValue({ status: 'submission_not_found' });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it.each([
    ['workflowDescription', 'caller-controlled prose'],
    ['organizationId', 'organization-1'],
    ['assessment', { authority: 'authoritative' }],
    ['providerSettings', { model: 'caller-model' }],
    ['model', 'caller-model'],
  ])('rejects unknown field %s before orchestration', async (field, value) => {
    const response = await POST(request({ submissionId: SUBMISSION_ID, [field]: value }));
    expect(response.status).toBe(400);
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { submissionId: 'not-a-uuid' },
    { submissionId: 42 },
  ])('rejects an invalid body before orchestration', async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('accepts exactly one valid submission identity', async () => {
    runAssessment.mockResolvedValue({ status: 'nothing_claimable' });
    const response = await POST(request({ submissionId: `  ${SUBMISSION_ID}  ` }));
    // Nothing claimable is a conflict, not a missing submission: the row may
    // exist but already be assessed, claimed, or out of attempts.
    expect(response.status).toBe(409);
    expect(runAssessment).toHaveBeenCalledExactlyOnceWith(SUBMISSION_ID);
  });

  it('refuses to assess a submission that cannot be claimed', async () => {
    runAssessment.mockResolvedValue({ status: 'nothing_claimable' });
    const response = await POST(request({ submissionId: SUBMISSION_ID }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'nothing_claimable' });
  });

  it('reports a recorded assessment as non-authoritative', async () => {
    runAssessment.mockResolvedValue({
      status: 'attempt_completed', attemptId: 'att-1', submissionId: SUBMISSION_ID,
      attemptNumber: 1, outcome: 'assessment_recorded', recorded: true,
    });
    const response = await POST(request({ submissionId: SUBMISSION_ID }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, authority: 'non_authoritative', requiresHumanReview: true,
    });
  });

  it('rejects an anonymous trigger before orchestration', async () => {
    const response = await POST(request({ submissionId: SUBMISSION_ID }, ''));
    expect(response.status).toBe(401);
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('reports finalization failure even when the assessment was recorded', async () => {
    runAssessment.mockResolvedValue({
      status: 'attempt_finalization_failed', attemptId: 'att-1', submissionId: SUBMISSION_ID,
      attemptNumber: 1, outcome: 'assessment_recorded', recorded: true,
      reason: 'finalization_rpc_error',
    });
    const response = await POST(request({ submissionId: SUBMISSION_ID }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: 'attempt_finalization_failed', attemptId: 'att-1',
      assessmentRecorded: true,
    });
    expect(runAssessment).toHaveBeenCalledTimes(1);
  });
});
