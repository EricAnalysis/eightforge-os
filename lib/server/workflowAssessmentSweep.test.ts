import { beforeEach, describe, expect, it, vi } from 'vitest';

const pendingRead = vi.hoisted(() => vi.fn());
const runAssessment = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/workflowAssessmentPending', () => ({
  readPendingWorkflowAssessments: pendingRead,
}));
vi.mock('@/lib/server/workflowAssessment', () => ({
  runAndRecordWorkflowAssessment: runAssessment,
  isWorkflowAssessmentEnabled: enabled,
}));

import { POST } from '@/app/api/internal/workflow-assessment-sweep/route';

const SECRET = 'sweep-secret';
const SUBMISSION = '11111111-1111-4111-8111-111111111111';

function request(auth: string | null = `Bearer ${SECRET}`): Request {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  return new Request('http://localhost/api/internal/workflow-assessment-sweep', {
    method: 'POST', headers,
  });
}

describe('workflow assessment sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    enabled.mockReturnValue(true);
    pendingRead.mockResolvedValue({
      status: 'ok',
      pending: [{ submissionId: SUBMISSION, schemaVersion: 'workflow_intake_v1', submittedAt: '' }],
    });
    runAssessment.mockResolvedValue({
      status: 'assessment_recorded', assessmentId: 'a1', sourceSubmissionId: SUBMISSION,
      assessmentVersion: 1, requiresHumanReview: true, authority: 'non_authoritative',
    });
  });

  it('assesses exactly one pending submission per invocation', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, assessed: 1 });
    expect(pendingRead).toHaveBeenCalledWith(1);
    expect(runAssessment).toHaveBeenCalledTimes(1);
    expect(runAssessment).toHaveBeenCalledWith(SUBMISSION);
  });

  it.each([
    ['no authorization header', null],
    ['a wrong secret', 'Bearer not-the-secret'],
    ['a bare token', SECRET],
  ])('refuses %s and assesses nothing', async (_label, auth) => {
    const response = await POST(request(auth));
    expect(response.status).toBe(401);
    expect(pendingRead).not.toHaveBeenCalled();
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('does not even look at pending work while the feature is disabled', async () => {
    enabled.mockReturnValue(false);
    const response = await POST(request());
    await expect(response.json()).resolves.toMatchObject({
      assessed: 0, reason: 'assessment_disabled',
    });
    expect(pendingRead).not.toHaveBeenCalled();
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('does nothing when no submission is pending', async () => {
    pendingRead.mockResolvedValue({ status: 'ok', pending: [] });
    const response = await POST(request());
    await expect(response.json()).resolves.toMatchObject({
      assessed: 0, reason: 'nothing_pending',
    });
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('never returns the intake answers', async () => {
    const response = await POST(request());
    const body = await response.text();
    expect(body).not.toMatch(/workflowDescription|manualChecks|humanDecisions/);
  });

  it('exposes no GET: discovery and execution are separate surfaces', async () => {
    const route = await import('@/app/api/internal/workflow-assessment-sweep/route');
    expect(Object.keys(route)).not.toContain('GET');
  });

  it('reports a failed assessment without claiming success', async () => {
    runAssessment.mockResolvedValue({ status: 'assessment_not_produced', reason: 'x' });
    const response = await POST(request());
    await expect(response.json()).resolves.toMatchObject({ ok: false, assessed: 0 });
  });
});
