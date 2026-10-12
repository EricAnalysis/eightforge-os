// Records a platform reviewer's triage of one improvement signal submission
// (B8.3c). Append-only and versioned; executes nothing.
//
// Identity comes from the authenticated session; the strict body has no
// reviewer field. Authority is the existing platform-review allowlist, checked
// here and again inside the seam.

import { getActorContext } from '@/lib/server/getActorContext';
import {
  improvementSignalTriageInputSchema,
  recordImprovementSignalTriage,
} from '@/lib/server/improvementSignalTriage';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }

  const body = improvementSignalTriageInputSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: 'invalid triage request' }, { status: 400 });

  const result = await recordImprovementSignalTriage(body.data,
    { actorId: actor.actor.actorId, email: actor.actor.email, role: actor.actor.role });
  switch (result.status) {
    case 'triage_recorded':
      return Response.json({ ok: true, ...result }, { status: 201 });
    case 'version_conflict':
      return Response.json({ ok: false, error: 'version_conflict', currentTriageVersion: result.currentTriageVersion }, { status: 409 });
    case 'submission_not_found':
      return Response.json({ ok: false, error: 'submission_not_found' }, { status: 404 });
    case 'input_invalid':
      return Response.json({ ok: false, error: 'invalid triage request', reason: result.reason }, { status: 400 });
    case 'reviewer_not_eligible':
      return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: result.reason }, { status: 403 });
    case 'reviewer_unresolved':
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'triage_not_configured' }, { status: 503 });
    default:
      console.error('[improvementSignalTriage] failed', { status: result.status, reason: result.reason });
      return Response.json({ ok: false, error: 'triage_failed' }, { status: 500 });
  }
}
