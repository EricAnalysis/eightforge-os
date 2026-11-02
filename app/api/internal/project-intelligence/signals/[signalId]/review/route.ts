// A person's disposition of one stored product signal. Platform-gated, scoped to the
// reviewer's own organization, and append-only. It records the review and nothing
// else: it routes no work, and changes no truth, rule or configuration.

import { z } from 'zod';

import { getActorContext } from '@/lib/server/getActorContext';
import { recordSignalReview, SIGNAL_REVIEW_DISPOSITIONS } from '@/lib/server/projectIntelligenceRecords';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ disposition: z.enum(SIGNAL_REVIEW_DISPOSITIONS) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ signalId: string }> }): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: 'invalid_disposition' }, { status: 400 });
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const { signalId } = await params;
  const result = await recordSignalReview(admin, {
    organizationId: actor.actor.organizationId, signalId, reviewerActorId: actor.actor.actorId, disposition: body.data.disposition,
  });
  if (result.status === 'recorded') return Response.json({ ok: true, reviewId: result.reviewId, reviewVersion: result.reviewVersion });
  if (result.status === 'signal_not_found') return Response.json({ ok: false, error: 'signal_not_found' }, { status: 404 });
  if (result.status === 'version_conflict') return Response.json({ ok: false, error: 'review_conflict' }, { status: 409 });
  return Response.json({ ok: false, error: 'review_not_recorded' }, { status: 500 });
}
