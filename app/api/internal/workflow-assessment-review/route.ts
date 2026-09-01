// app/api/internal/workflow-assessment-review/route.ts
// Write path for recording an operator's review of one workflow assessment
// version.
//
// This route requires an authenticated operator session, NOT the internal cron
// secret. A review row is audit truth: "user X approved this specification" has
// to mean X was authenticated, not that whoever holds a shared secret supplied
// X's uuid. A falsely attributed review is worse than no reviewer identity at
// all, because the schema preserves it immutably.
//
// So identity is derived here, from the session, and the request body carries
// only the decision. The body schema is `.strict()` and has no reviewer field,
// which makes supplying one a 400 rather than something silently ignored.
//
// service_role remains the database execution mechanism beneath this, but it is
// never the identity. If no authenticated human can be resolved, this fails
// closed rather than recording the review under the service account.
//
// There is no GET: V1 has no read path, public or otherwise.
//
// Recording a review executes nothing. An `accepted` step is accepted system
// specification, not a deployed rule.

import { getActorContext } from '@/lib/server/getActorContext';
import { resolveWorkflowReviewEligibility } from '@/lib/workflowReviewEligibility';
import {
  recordWorkflowAssessmentReview,
  workflowAssessmentReviewInputSchema,
} from '@/lib/server/workflowAssessmentReview';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  // Identity first: nothing is parsed or written until an authenticated human
  // is established. getActorContext validates the bearer JWT through Supabase
  // Auth and resolves the matching user_profiles row, failing closed on a
  // missing token, an invalid session, or an absent profile.
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  }

  // Authentication proves who the actor is; this proves they were allowed to
  // review. Checked before the body is parsed, and again inside the seam: a
  // hidden button in a UI is convenience, this is the authority.
  const eligibility = resolveWorkflowReviewEligibility(actor.actor.role);
  if (!eligibility.eligible) {
    return Response.json(
      { ok: false, error: 'reviewer_not_eligible', reason: eligibility.reason },
      { status: 403 },
    );
  }

  const body = workflowAssessmentReviewInputSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return Response.json({ ok: false, error: 'invalid review request' }, { status: 400 });
  }

  const result = await recordWorkflowAssessmentReview(
    body.data,
    { actorId: actor.actor.actorId, role: actor.actor.role },
  );

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
    case 'reviewer_unresolved':
      // The identity path produced something unusable. Recording the review
      // would preserve a false attribution, so refuse.
      console.error('[workflowAssessmentReview] reviewer identity unresolved');
      return Response.json({ ok: false, error: 'reviewer_unresolved' }, { status: 403 });
    case 'reviewer_not_eligible':
      // The seam recheck disagreed with the route check. That should be
      // unreachable, so it is worth a log line rather than a silent 403.
      console.error('[workflowAssessmentReview] eligibility recheck failed', {
        reason: result.reason,
      });
      return Response.json({ ok: false, error: 'reviewer_not_eligible' }, { status: 403 });
    case 'specification_invalid':
      // Field paths only; never the reviewer's prose.
      return Response.json(
        { ok: false, error: 'specification_invalid', reason: result.reason },
        { status: 422 },
      );
    case 'input_invalid':
      return Response.json({ ok: false, error: 'invalid review request' }, { status: 400 });
    case 'duplicate_step_review':
      return Response.json({ ok: false, error: 'duplicate_step_review' }, { status: 422 });
    case 'review_rejected':
      // Reason codes describe structure (coverage, unknown step id), never the
      // reviewer's prose, so they are safe to return to an authenticated caller.
      return Response.json({ ok: false, error: 'review_rejected' }, { status: 422 });
    case 'persist_failed':
      console.error('[workflowAssessmentReview] persistence failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'review_not_recorded' }, { status: 500 });
  }
}
