import { RepositoryPlanRunReadResponseSchema } from '@/lib/repositoryPlanRunWire';
import { getActorContext } from '@/lib/server/getActorContext';
import { readWorkflowRepositoryPlanRun } from '@/lib/server/workflowRepositoryPlanRuns';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function boundedJob(job: Record<string, unknown>): unknown {
  const base = { jobId: job.jobId, classification: job.classification, status: job.status };
  if (job.status === 'failed') return { ...base, failureCode: job.failureCode };
  if (job.status === 'succeeded') return { ...base, result: job.result };
  return base;
}

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return response({ ok: false, error: 'unauthorized' }, actor.status);
  if (!resolveWorkflowPlatformReviewAccess(actor.actor).allowed) {
    return response({ ok: false, error: 'reviewer_not_eligible' }, 403);
  }
  if (request.body !== null || new URL(request.url).searchParams.size !== 0) {
    return response({ ok: false, error: 'invalid_job_id' }, 400);
  }
  const { jobId } = await context.params;
  if (!UUID.test(jobId)) return response({ ok: false, error: 'invalid_job_id' }, 400);

  try {
    const result = await readWorkflowRepositoryPlanRun(jobId);
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : result.code === 'not_configured' ? 503 : 500;
      return response({ ok: false, error: result.code }, status);
    }
    const body = RepositoryPlanRunReadResponseSchema.safeParse({
      ok: true,
      job: boundedJob(result.job as unknown as Record<string, unknown>),
    });
    return body.success
      ? response(body.data, 200)
      : response({ ok: false, error: 'read_failed' }, 500);
  } catch {
    return response({ ok: false, error: 'read_failed' }, 500);
  }
}
