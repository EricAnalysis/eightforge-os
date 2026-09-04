import { readWorkflowImplementationPlan } from '@/lib/server/workflowImplementationPlanRead';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const QUERY_KEYS = ['assessmentVersion', 'reviewId', 'reviewVersion'] as const;
type Failure = Extract<Awaited<ReturnType<typeof readWorkflowImplementationPlan>>, { ok: false }>;
const FAILURE_STATUS: Record<Failure['code'], number> = {
  unauthorized: 401,
  reviewer_not_eligible: 403,
  not_configured: 503,
  invalid_pin: 400,
  assessment_not_found: 404,
  review_not_found: 404,
  invalid_json: 422,
  invalid_evidence: 422,
  assessment_pin_mismatch: 422,
  review_pin_mismatch: 422,
  source_submission_mismatch: 422,
  step_review_parent_mismatch: 422,
  duplicate_step_review: 422,
  orphan_step_review: 422,
  missing_step_review: 422,
  classification_mismatch: 422,
  incoherent_disposition: 422,
  proposal_not_composable: 422,
  invalid_specification: 422,
  overall_disposition_mismatch: 422,
  plan_not_composable: 500,
  read_failed: 500,
};

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function version(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 2147483647 ? parsed : null;
}

/** Only the caller's complete immutable identity crosses the trusted read seam. */
export async function GET(
  request: Request,
  context: { params: Promise<{ assessmentId: string }> },
): Promise<Response> {
  try {
    if (request.body !== null) return json({ ok: false, error: 'invalid_pin' }, 400);
    const query = new URL(request.url).searchParams;
    if (Array.from(query.keys()).some((key) => !QUERY_KEYS.includes(key as typeof QUERY_KEYS[number]))
      || QUERY_KEYS.some((key) => query.getAll(key).length !== 1)) {
      return json({ ok: false, error: 'invalid_pin' }, 400);
    }
    const assessmentVersion = version(query.get('assessmentVersion'));
    const reviewVersion = version(query.get('reviewVersion'));
    if (assessmentVersion === null || reviewVersion === null) {
      return json({ ok: false, error: 'invalid_pin' }, 400);
    }
    const { assessmentId } = await context.params;
    const result = await readWorkflowImplementationPlan(request, {
      assessmentId, assessmentVersion, reviewId: query.get('reviewId'), reviewVersion,
    });
    return result.ok
      ? json({ ok: true, plan: result.artifact }, 200)
      : json({ ok: false, error: result.code }, FAILURE_STATUS[result.code]);
  } catch {
    return json({ ok: false, error: 'read_failed' }, 500);
  }
}
