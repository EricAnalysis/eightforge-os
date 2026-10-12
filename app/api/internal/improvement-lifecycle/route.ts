// Read-only: the recorded lifecycle, measurements, decisions and recurrence
// links of one improvement submission (B8.4d). Platform-review authority.

import { getActorContext } from '@/lib/server/getActorContext';
import { readImprovementLifecycle } from '@/lib/server/improvementLifecycleRead';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }
  const submissionId = new URL(request.url).searchParams.get('submissionId');
  const result = await readImprovementLifecycle({ submissionId },
    { email: actor.actor.email, role: actor.actor.role });
  if (result.status === 'ok') return Response.json({ ok: true, ...result.view });
  const status = { reviewer_not_eligible: 403, invalid_input: 400, not_configured: 503, read_failed: 502 }[result.status];
  return Response.json({ ok: false, error: result.status }, { status });
}
