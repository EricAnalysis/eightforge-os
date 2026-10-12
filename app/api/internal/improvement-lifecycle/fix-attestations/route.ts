// Records a platform reviewer's attestation of the exact merge commit that
// shipped an approved, triage-sourced engineering request (B8.4b).
// Append-only. Proves nothing about deployment; the worker proves that by git
// ancestry. Identity comes from the authenticated session; the strict body has
// no attester field. Authority is the existing platform-review allowlist,
// checked here and again inside the seam.

import { getActorContext } from '@/lib/server/getActorContext';
import {
  ImprovementFixAttestationInputSchema,
  recordImprovementFixAttestation,
} from '@/lib/server/improvementLifecycle';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const maxDuration = 30;

const STATUS: Readonly<Record<string, number>> = {
  reviewer_not_eligible: 403, invalid_input: 400, not_configured: 503, request_not_found: 404,
  request_not_approved: 409, review_superseded: 409, not_measurable_source: 422, conflicting_attestation: 409,
};

export async function POST(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }

  const body = ImprovementFixAttestationInputSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: 'invalid_input' }, { status: 400 });

  const result = await recordImprovementFixAttestation(body.data,
    { actorId: actor.actor.actorId, email: actor.actor.email, role: actor.actor.role });
  if (result.status === 'attested') {
    return Response.json({ ok: true, ...result }, { status: result.inserted ? 201 : 200 });
  }
  const status = STATUS[result.status];
  if (status === undefined) console.error('[improvementLifecycle] attestation failed', { status: result.status });
  return Response.json({ ok: false, error: result.status }, { status: status ?? 500 });
}
