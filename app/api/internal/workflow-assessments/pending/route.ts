// app/api/internal/workflow-assessments/pending/route.ts
// Discoverable intake work awaiting assessment.
//
// This is the production connection that was missing: intake persisted
// submissions and nothing could find them. It is a read, gated by the same
// platform-review predicate as the rest of the surface.
//
// It deliberately does NOT run assessments. Anonymous submission must never
// cause provider spend, so the boundary is preserved: this answers whether work
// exists, and the separate secret-gated trigger performs one bounded run. The
// assessment task itself remains feature-flagged and provider-disabled by
// default, so discovering work here cannot start anything on its own.
//
// No POST: nothing here mutates or executes.

import { getActorContext } from '@/lib/server/getActorContext';
import { readPendingWorkflowAssessments } from '@/lib/server/workflowAssessmentPending';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  }

  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json(
      { ok: false, error: 'reviewer_not_eligible', reason: access.reason },
      { status: 403 },
    );
  }

  const result = await readPendingWorkflowAssessments();

  switch (result.status) {
    case 'ok':
      return Response.json({
        ok: true,
        pending: result.pending,
        // Pinned, not computed from a flag: reading this list runs nothing.
        triggered: false,
      }, { status: 200 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'not_configured' }, { status: 503 });
    case 'read_failed':
      console.error('[workflowAssessmentPending] read failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'pending_unavailable' }, { status: 500 });
  }
}
