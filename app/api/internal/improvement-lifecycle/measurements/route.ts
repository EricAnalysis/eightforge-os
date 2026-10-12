// Measures one deployed fix against its originating friction under
// friction_measurement_v1 and records an immutable snapshot (B8.4c). Closes
// nothing. Identity comes from the authenticated session; authority is the
// existing platform-review allowlist, checked here and again inside the seam.

import { getActorContext } from '@/lib/server/getActorContext';
import { MeasureImprovementInputSchema, measureImprovement } from '@/lib/server/improvementMeasurement';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const maxDuration = 300;

const STATUS: Readonly<Record<string, number>> = {
  reviewer_not_eligible: 403, invalid_input: 400, not_configured: 503, deployment_not_found: 404,
  window_not_open: 409, not_measurable_problem: 422, already_completed: 409, read_failed: 502,
};

export async function POST(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }
  const body = MeasureImprovementInputSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: 'invalid_input' }, { status: 400 });

  const result = await measureImprovement(body.data,
    { actorId: actor.actor.actorId, email: actor.actor.email, role: actor.actor.role });
  if (result.status === 'recorded') return Response.json({ ok: true, ...result }, { status: 201 });
  const status = STATUS[result.status];
  if (status === undefined) console.error('[improvementMeasurement] measurement failed', { status: result.status });
  return Response.json({ ok: false, error: result.status }, { status: status ?? 500 });
}
