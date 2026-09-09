import { RepositoryPlanRunCreatedResponseSchema, RepositoryPlanRunRequestSchema } from '@/lib/repositoryPlanRunWire';
import { getActorContext } from '@/lib/server/getActorContext';
import { createWorkflowRepositoryPlanRun } from '@/lib/server/workflowRepositoryPlanRuns';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const failureStatus: Record<string, number> = {
  reviewer_not_eligible: 403,
  invalid_pin: 400,
  classification_not_present: 400,
  not_configured: 503,
  create_failed: 500,
};

function response(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return response({ ok: false, error: 'unauthorized' }, actor.status);
  if (!resolveWorkflowPlatformReviewAccess(actor.actor).allowed) {
    return response({ ok: false, error: 'reviewer_not_eligible' }, 403);
  }

  const parsed = RepositoryPlanRunRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response({ ok: false, error: 'invalid_request' }, 400);

  try {
    const result = await createWorkflowRepositoryPlanRun(parsed.data, {
      actorId: actor.actor.actorId,
      email: actor.actor.email,
      role: actor.actor.role,
    });
    if (!result.ok) {
      return response({ ok: false, error: result.code }, failureStatus[result.code] ?? 500);
    }
    const body = RepositoryPlanRunCreatedResponseSchema.safeParse({
      ok: true,
      job: { jobId: result.job.jobId, status: 'pending', classification: result.job.classification },
    });
    return body.success
      ? response(body.data, 201)
      : response({ ok: false, error: 'create_failed' }, 500);
  } catch {
    return response({ ok: false, error: 'create_failed' }, 500);
  }
}
