// Improvement signal triage queue (B8.3c). Read-only.
//
// Platform-wide, gated by the existing platform-review allowlist: the
// submissions are tenant-derived but allowlisted (B8.3a), and the owner
// approved platform reviewers seeing exactly that metadata.

import { getActorContext } from '@/lib/server/getActorContext';
import { readImprovementSignalTriageQueue } from '@/lib/server/improvementSignalTriage';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }

  const result = await readImprovementSignalTriageQueue();
  switch (result.status) {
    case 'ok':
      return Response.json({ ok: true, rows: result.rows }, { status: 200 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'triage_not_configured' }, { status: 503 });
    case 'read_failed':
      console.error('[improvementSignalTriageQueue] read failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'queue_unavailable' }, { status: 500 });
  }
}
