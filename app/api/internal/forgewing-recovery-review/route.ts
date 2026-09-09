// app/api/internal/forgewing-recovery-review/route.ts
//
// Read and write path for operator review of Forgewing recovery proposals.
//
// Identity is derived from the authenticated session, never from the body. The
// request schema is `.strict()` and has no reviewer, organization, or value
// field, so supplying one is a 400 rather than something silently ignored: a
// review row is immutable audit truth, and a falsely attributed one is worse
// than none.
//
// Nothing here calls a provider. Accept, modify, reject and defer are all
// database writes; no Forgewing task runs and no proposal is regenerated.
//
// Recording a review changes no canonical output. It authorizes a later
// deterministic reprocess, which is a separate, explicit operator action.

import { getActorContext } from '@/lib/server/getActorContext';
import { RecoveryProposalReviewInputSchema } from '@/lib/forgewingRecoveryReview';
import { recordForgewingRecoveryProposalReview } from '@/lib/server/forgewingRecoveryReview';
import { readRecoveryReviewQueue } from '@/lib/server/forgewingRecoveryReviewRead';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  }
  const sourceDocumentId = new URL(request.url).searchParams.get('documentId');
  if (!sourceDocumentId) {
    return Response.json({ ok: false, error: 'documentId is required' }, { status: 400 });
  }
  // Organization comes from the session, so a document id alone can never
  // reach another tenant's proposals.
  const result = await readRecoveryReviewQueue({
    organizationId: actor.actor.organizationId,
    sourceDocumentId,
  });
  switch (result.status) {
    case 'ok':
      return Response.json({ ok: true, candidates: result.candidates });
    case 'not_configured':
      return Response.json({ ok: false, error: 'recovery_review_not_configured' }, { status: 503 });
    case 'read_failed':
      console.error('[forgewingRecoveryReview] queue read failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'recovery_review_read_failed' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  }

  const body = RecoveryProposalReviewInputSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return Response.json({ ok: false, error: 'invalid review request' }, { status: 400 });
  }

  const result = await recordForgewingRecoveryProposalReview(body.data, {
    actorId: actor.actor.actorId,
    organizationId: actor.actor.organizationId,
  });
  if (result.ok) {
    return Response.json({
      ok: true,
      reviewId: result.review.reviewId,
      reviewVersion: result.review.reviewVersion,
      disposition: result.review.disposition,
      confirmedObservationId: result.review.confirmedObservationId,
      // Deliberately explicit. An accepted review has changed no canonical
      // output; only a reprocess can do that.
      reviewState: result.review.disposition === 'accepted' || result.review.disposition === 'modified'
        ? 'accepted_awaiting_reprocess'
        : result.review.disposition,
      reprocessRequired: result.review.disposition === 'accepted'
        || result.review.disposition === 'modified',
    }, { status: result.inserted ? 201 : 200 });
  }
  switch (result.code) {
    case 'invalid_review':
      return Response.json({ ok: false, error: 'invalid review request' }, { status: 400 });
    case 'invalid_actor':
      console.error('[forgewingRecoveryReview] reviewer identity unresolved');
      return Response.json({ ok: false, error: 'reviewer_unresolved' }, { status: 403 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'recovery_review_not_configured' }, { status: 503 });
    case 'write_failed':
      // The database refuses a review that does not pin an existing proposal,
      // confirms an ineligible observation, or crosses a tenant boundary.
      console.error('[forgewingRecoveryReview] review not recorded');
      return Response.json({ ok: false, error: 'review_not_recorded' }, { status: 422 });
  }
}
