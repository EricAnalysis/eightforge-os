import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runAssessment = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/workflowAssessment', () => ({
  runAndRecordWorkflowAssessment: runAssessment,
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
    const response = await POST(request({ submissionId: `  ${SUBMISSION_ID}  ` }));
    expect(response.status).toBe(404);
    expect(runAssessment).toHaveBeenCalledExactlyOnceWith(SUBMISSION_ID);
  });

  it('rejects an anonymous trigger before orchestration', async () => {
    const response = await POST(request({ submissionId: SUBMISSION_ID }, ''));
    expect(response.status).toBe(401);
    expect(runAssessment).not.toHaveBeenCalled();
  });
});
