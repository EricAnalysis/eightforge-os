// app/api/internal/workflow-assessment/route.ts
// Internal-only trigger for one bounded Forgewing workflow assessment.
//
// Deliberately NOT wired to public submission. An anonymous visitor must never
// be able to cause a provider call, so intake persistence and assessment
// generation are separate steps and only an operator holding the internal
// secret can start the second one.
//
// There is no GET: assessments describe a visitor's business process and have
// no read path in V1, public or otherwise.

import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { executeClaimedWorkflowAssessment } from '@/lib/server/workflowAssessmentClaim';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(request: Request, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestSchema = z.object({
  submissionId: z.string().trim().regex(UUID),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: 'assessment_not_configured' }, { status: 503 });
  }
  if (!authorized(request, secret)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const body = requestSchema.safeParse(await request.json().catch(() => null));
  // Only an id is accepted. Prose supplied by a caller is never assessed: the
  // persisted submission is the input authority.
  if (!body.success) {
    return Response.json({ ok: false, error: 'invalid assessment request' }, { status: 400 });
  }

  // The manual trigger acquires the same claim the sweep does. Without this it
  // could spend a provider call on a submission the sweep is already assessing,
  // or revive one that has exhausted its attempts.
  const result = await executeClaimedWorkflowAssessment(body.data.submissionId);

  switch (result.status) {
    case 'attempt_completed':
      if (result.recorded) {
        return Response.json({
          ok: true,
          attemptId: result.attemptId,
          sourceSubmissionId: result.submissionId,
          attemptNumber: result.attemptNumber,
          // Pinned literals: an assessment is never authoritative and always
          // requires human review.
          authority: 'non_authoritative',
          requiresHumanReview: true,
        }, { status: 201 });
      }
      // Reason codes only; never provider or intake prose.
      return Response.json({ ok: false, error: result.outcome }, { status: 422 });
    case 'nothing_claimable':
      // Already assessed, already claimed by a concurrent caller, or the
      // submission has exhausted its bounded attempts. No provider call.
      return Response.json({ ok: false, error: 'nothing_claimable' }, { status: 409 });
    case 'assessment_disabled':
      return Response.json({ ok: false, error: 'assessment_disabled' }, { status: 503 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'assessment_not_configured' }, { status: 503 });
    case 'claim_failed':
      console.error('[workflowAssessment] claim failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'claim_failed' }, { status: 503 });
    case 'attempt_finalization_failed':
      console.error('[workflowAssessment] attempt finalization failed', {
        attemptId: result.attemptId, reason: result.reason,
      });
      return Response.json({
        ok: false,
        error: 'attempt_finalization_failed',
        attemptId: result.attemptId,
        sourceSubmissionId: result.submissionId,
        attemptNumber: result.attemptNumber,
        assessmentRecorded: result.recorded,
      }, { status: 503 });
  }
}
