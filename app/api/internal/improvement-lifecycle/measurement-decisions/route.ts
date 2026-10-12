// Records a platform reviewer's decision on a completed measurement (B8.4c):
// resolved (only on a resolution candidate), recurred_confirmed (only on
// recurred) or deferred. Append-only and versioned. Identity comes from the
// authenticated session; the strict body has no reviewer field.

import { getActorContext } from '@/lib/server/getActorContext';
import { MeasurementDecisionInputSchema, recordMeasurementDecision } from '@/lib/server/improvementMeasurement';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const maxDuration = 30;

const STATUS: Readonly<Record<string, number>> = {
  reviewer_not_eligible: 403, invalid_input: 400, not_configured: 503, snapshot_not_found: 404,
  not_completed_measurement: 409, decision_not_allowed: 422, version_conflict: 409,
};

export async function POST(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }
  const body = MeasurementDecisionInputSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: 'invalid_input' }, { status: 400 });

  const result = await recordMeasurementDecision(body.data,
    { actorId: actor.actor.actorId, email: actor.actor.email, role: actor.actor.role });
  if (result.status === 'decided') return Response.json({ ok: true, ...result }, { status: 201 });
  const status = STATUS[result.status];
  if (status === undefined) console.error('[improvementMeasurement] decision failed', { status: result.status });
  return Response.json({ ok: false, error: result.status }, { status: status ?? 500 });
}
