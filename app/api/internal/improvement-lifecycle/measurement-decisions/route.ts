// Records a platform reviewer's decision on a completed measurement (B8.4c):
// resolved (only on a resolution candidate), recurred_confirmed (only on
// recurred) or deferred. Append-only and versioned. Identity comes from the
// authenticated session; the strict body has no reviewer field.
//
// B8.4d: a recurred_confirmed decision then re-submits the current signal for
// the same problem as a linked successor. The decision stands whatever that
// outcome is; a failed successor can be retried on its own route.

import { getActorContext } from '@/lib/server/getActorContext';
import { MeasurementDecisionInputSchema, recordMeasurementDecision } from '@/lib/server/improvementMeasurement';
import { recordRecurrenceSuccessor } from '@/lib/server/improvementRecurrence';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const maxDuration = 300;

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

  const reviewer = { actorId: actor.actor.actorId, email: actor.actor.email, role: actor.actor.role };
  const result = await recordMeasurementDecision(body.data, reviewer);
  if (result.status === 'decided') {
    const successor = body.data.decision === 'recurred_confirmed'
      ? await recordRecurrenceSuccessor({ decisionId: result.decisionId }, reviewer) : null;
    return Response.json({ ok: true, ...result, ...(successor ? { successor } : {}) }, { status: 201 });
  }
  const status = STATUS[result.status];
  if (status === undefined) console.error('[improvementMeasurement] decision failed', { status: result.status });
  return Response.json({ ok: false, error: result.status }, { status: status ?? 500 });
}
