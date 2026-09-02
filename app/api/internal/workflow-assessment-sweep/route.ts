// app/api/internal/workflow-assessment-sweep/route.ts
// The scheduled production caller between intake and assessment.
//
// GET is the cron method: Vercel Cron invokes scheduled paths with GET, so a
// POST-only handler would have returned 405 on every run and the sweep would
// never have executed. POST is retained for manual internal invocation and
// delegates to the same function, so the two cannot drift.
//
// Neither method reaches the provider directly. Both go through
// executeClaimedWorkflowAssessment, which acquires a durable claim first, so a
// sweep racing another sweep -- or a sweep racing the manual trigger -- cannot
// both spend a provider call on the same submission.
//
// Anonymous submission still cannot cause provider spend: a visitor persists a
// row and returns, and this path is CRON_SECRET gated and feature-flagged.

import { timingSafeEqual } from 'node:crypto';

import { executeClaimedWorkflowAssessment } from '@/lib/server/workflowAssessmentClaim';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(request: Request, secret: string): boolean {
  const provided = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One bounded sweep. Shared by both methods so behaviour cannot diverge. */
async function sweep(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: 'sweep_not_configured' }, { status: 503 });
  }
  if (!authorized(request, secret)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Exactly one claimed submission per invocation. A backlog drains at the
  // cron's rate rather than in one unbounded burst.
  const result = await executeClaimedWorkflowAssessment();

  switch (result.status) {
    case 'attempt_completed':
      return Response.json({
        ok: result.recorded,
        assessed: result.recorded ? 1 : 0,
        attemptNumber: result.attemptNumber,
        // Reason codes only; intake answers are never returned from here.
        reason: result.outcome,
      });
    case 'nothing_claimable':
      // Already assessed, already claimed, or out of attempts.
      return Response.json({ ok: true, assessed: 0, reason: 'nothing_claimable' });
    case 'assessment_disabled':
      return Response.json({ ok: true, assessed: 0, reason: 'assessment_disabled' });
    case 'not_configured':
      return Response.json({ ok: false, error: 'not_configured' }, { status: 503 });
    case 'claim_failed':
      console.error('[workflowAssessmentSweep] claim failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'claim_failed' }, { status: 503 });
  }
}

export async function GET(request: Request): Promise<Response> {
  return sweep(request);
}

export async function POST(request: Request): Promise<Response> {
  return sweep(request);
}
