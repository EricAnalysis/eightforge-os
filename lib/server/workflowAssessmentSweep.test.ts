import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/workflowAssessmentClaim', () => ({
  sweepWorkflowAssessments: execute,
}));

import { GET, POST } from '@/app/api/internal/workflow-assessment-sweep/route';

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
    execute.mockResolvedValue({
      attempted: 1, recorded: 1, outcomes: [], stoppedBecause: 'nothing_claimable',
    });
  });

  // Vercel Cron invokes scheduled paths with GET. A POST-only handler returned
  // 405 on every scheduled run, so the sweep never actually executed.
  it('GET is the cron method and reaches the claim path', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, attempted: 1, assessed: 1,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('POST is retained for manual invocation and behaves identically', async () => {
    const get = await GET(request());
    execute.mockClear();
    const post = await POST(request());
    expect(post.status).toBe(get.status);
    await expect(post.json()).resolves.toEqual(await get.json());
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['GET', GET],
    ['POST', POST],
  ])('%s with no authorization never claims', async (_label, handler) => {
    const response = await handler(request(null));
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', GET],
    ['POST', POST],
  ])('%s with a wrong secret never claims', async (_label, handler) => {
    const response = await handler(request('Bearer not-the-secret'));
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports nothing claimable without claiming to have assessed', async () => {
    execute.mockResolvedValue({
      attempted: 0, recorded: 0, outcomes: [], stoppedBecause: 'nothing_claimable',
    });
    await expect((await GET(request())).json()).resolves.toMatchObject({
      attempted: 0, assessed: 0, reason: 'nothing_claimable',
    });
  });

  it('reports a disabled deployment without error', async () => {
    execute.mockResolvedValue({
      attempted: 0, recorded: 0, outcomes: [], stoppedBecause: 'disabled',
    });
    await expect((await GET(request())).json()).resolves.toMatchObject({
      attempted: 0, assessed: 0, reason: 'disabled',
    });
  });

  it('distinguishes attempts made from assessments recorded', async () => {
    // Three attempts, one of which produced an assessment.
    execute.mockResolvedValue({
      attempted: 3, recorded: 1, outcomes: [], stoppedBecause: 'batch_full',
    });
    await expect((await GET(request())).json()).resolves.toMatchObject({
      attempted: 3, assessed: 1, reason: 'batch_full',
    });
  });

  it('never returns the intake answers', async () => {
    const body = await (await GET(request())).text();
    expect(body).not.toMatch(/workflowDescription|manualChecks|humanDecisions/);
  });

  it('surfaces a claim failure as unavailable rather than success', async () => {
    execute.mockResolvedValue({
      attempted: 0, recorded: 0, outcomes: [], stoppedBecause: 'claim_failed',
    });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('deadlock');
  });

  it('surfaces finalization failure with accurate attempted and recorded counts', async () => {
    execute.mockResolvedValue({
      attempted: 2, recorded: 1, outcomes: [], stoppedBecause: 'attempt_finalization_failed',
    });
    const response = await GET(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false, error: 'attempt_finalization_failed', attempted: 2, assessed: 1,
    });
  });
});
