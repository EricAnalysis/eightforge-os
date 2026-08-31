// app/api/internal/workflow-assessment-review/route.ts
// Internal-only write path for recording an operator's review of one workflow
// assessment version.
//
// Internal for the same reason the assessment trigger is: reviews describe a
// visitor's business process and an operator's judgement of it. Neither is
// public, and there is no UI in V1 — this route is the seam the review surface
// will later sit on top of.
//
// There is no GET: V1 has no read path, public or otherwise.
//
// Recording a review executes nothing. An `accepted` step is accepted system
// specification, not a deployed rule.

import { timingSafeEqual } from 'node:crypto';

import {
  recordWorkflowAssessmentReview,
  workflowAssessmentReviewInputSchema,
} from '@/lib/server/workflowAssessmentReview';

export const runtime = 'nodejs';
export const maxDuration = 30;

function authorized(request: Request, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: 'review_not_configured' }, { status: 503 });
  }
  if (!authorized(request, secret)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // The schema is `.strict()` all the way down, so an unknown field — including
  // an attempt to supply overallDisposition — is rejected here. The overall
  // disposition is derived in the database and is not an input at any layer.
  const body = workflowAssessmentReviewInputSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return Response.json({ ok: false, error: 'invalid review request' }, { status: 400 });
  }

  const result = await recordWorkflowAssessmentReview(body.data);

  switch (result.status) {
    case 'review_recorded':
      return Response.json({
        ok: true,
        reviewId: result.reviewId,
        reviewVersion: result.reviewVersion,
        overallDisposition: result.overallDisposition,
        stepReviewCount: result.stepReviewCount,
        executable: result.executable,
      }, { status: 201 });
    case 'assessment_not_found':
      return Response.json({ ok: false, error: 'assessment_not_found' }, { status: 404 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'review_not_configured' }, { status: 503 });
    case 'input_invalid':
      return Response.json({ ok: false, error: 'invalid review request' }, { status: 400 });
    case 'duplicate_step_review':
      return Response.json({ ok: false, error: 'duplicate_step_review' }, { status: 422 });
    case 'review_rejected':
      // Reason codes describe structure (coverage, unknown step id), never the
      // reviewer's prose, so they are safe to return to an internal caller.
      return Response.json({ ok: false, error: 'review_rejected' }, { status: 422 });
    case 'persist_failed':
      console.error('[workflowAssessmentReview] persistence failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'review_not_recorded' }, { status: 500 });
  }
}
