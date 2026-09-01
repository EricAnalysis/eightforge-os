// app/api/internal/workflow-assessments/review-queue/route.ts
// Pending review queue for the operator surface.
//
// Read-only, and gated by the same owner/admin predicate that protects the
// write path: an operator who could not submit a review has no business
// enumerating the business processes awaiting one.
//
// Returns projection data only — assessment payloads are never sent to a list
// view, and no provider output is exposed. There is no POST here.

import { getActorContext } from '@/lib/server/getActorContext';
import { readWorkflowReviewQueue } from '@/lib/server/workflowAssessmentReviewRead';
import { resolveWorkflowReviewEligibility } from '@/lib/workflowReviewEligibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  }

  const eligibility = resolveWorkflowReviewEligibility(actor.actor.role);
  if (!eligibility.eligible) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible' }, { status: 403 });
  }

  const result = await readWorkflowReviewQueue();

  switch (result.status) {
    case 'ok':
      return Response.json({ ok: true, rows: result.rows }, { status: 200 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'review_not_configured' }, { status: 503 });
    case 'read_failed':
      console.error('[workflowReviewQueue] read failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'queue_unavailable' }, { status: 500 });
  }
}
