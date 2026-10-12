// Re-submits the current friction signal for a confirmed recurrence as a
// linked successor submission (B8.4d). Idempotent per decision; history is
// never edited. Platform-review authority; identity from the session.

import { getActorContext } from '@/lib/server/getActorContext';
import { RecurrenceSuccessorInputSchema, recordRecurrenceSuccessor } from '@/lib/server/improvementRecurrence';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const maxDuration = 300;

const STATUS: Readonly<Record<string, number>> = {
  reviewer_not_eligible: 403, invalid_input: 400, not_configured: 503, decision_not_found: 404,
  not_current_recurrence: 409, signal_not_current: 409, successor_repeats_submission: 409, read_failed: 502,
};

export async function POST(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }
  const body = RecurrenceSuccessorInputSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: 'invalid_input' }, { status: 400 });
  const result = await recordRecurrenceSuccessor(body.data,
    { actorId: actor.actor.actorId, email: actor.actor.email, role: actor.actor.role });
  if (result.status === 'recorded') return Response.json({ ok: true, ...result }, { status: result.inserted ? 201 : 200 });
  const status = STATUS[result.status];
  if (status === undefined) console.error('[improvementRecurrence] successor failed', { status: result.status });
  return Response.json({ ok: false, error: result.status }, { status: status ?? 500 });
}
