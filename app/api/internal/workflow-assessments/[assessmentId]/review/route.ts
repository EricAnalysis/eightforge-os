// app/api/internal/workflow-assessments/[assessmentId]/review/route.ts
// The immutable review packet for one assessment.
//
// Read-only and eligibility-gated, like the queue. Returns what the user
// described, what Forgewing proposed, and any review already recorded against
// this exact version — enough for the surface to render proposed against
// reviewed, and nothing more.
//
// There is no POST, PATCH, or DELETE here: reviews are written through the
// separate immutable review-write seam, and assessments are never edited.

import { getActorContext } from '@/lib/server/getActorContext';
import { readWorkflowReviewPacket } from '@/lib/server/workflowAssessmentReviewRead';
import { resolveWorkflowReviewEligibility } from '@/lib/workflowReviewEligibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ assessmentId: string }> },
): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  }

  const eligibility = resolveWorkflowReviewEligibility(actor.actor.role);
  if (!eligibility.eligible) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible' }, { status: 403 });
  }

  const { assessmentId } = await context.params;
  if (!UUID.test(assessmentId ?? '')) {
    return Response.json({ ok: false, error: 'invalid_assessment_id' }, { status: 400 });
  }

  const result = await readWorkflowReviewPacket(assessmentId);

  switch (result.status) {
    case 'ok':
      return Response.json({ ok: true, packet: result.packet }, { status: 200 });
    case 'assessment_not_found':
      return Response.json({ ok: false, error: 'assessment_not_found' }, { status: 404 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'review_not_configured' }, { status: 503 });
    case 'read_failed':
      console.error('[workflowReviewPacket] read failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'packet_unavailable' }, { status: 500 });
  }
}
