import type { RepositoryPlanRunRequest } from '@/lib/repositoryPlanRunWire';
import {
  createRepositoryPlanGenerationJob,
  readRepositoryPlanGenerationJob,
} from '@/lib/server/repositoryPlanGenerationJobs';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolveEffectiveReviewedSpecification } from '@/lib/workflowEffectiveReviewedSpecification';
import { buildWorkflowImplementationPlan } from '@/lib/workflowImplementationPlan';

type QueryResult = PromiseLike<{ data: unknown; error: unknown }>;
type Query = {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  maybeSingle(): QueryResult;
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
};
type AdminClient = Readonly<{
  from(table: string): Readonly<{ select(columns: string): Query }>;
  rpc: (name: string, args?: Record<string, unknown>) => QueryResult;
}>;

export type RepositoryPlanRunActor = Readonly<{
  actorId: string;
  email: string | null;
  role: string | null;
}>;

async function readTrustedPlan(pin: RepositoryPlanRunRequest, admin: AdminClient) {
  const assessment = await admin.from('workflow_assessments')
    .select('id, assessment_version, source_submission_id, assessment, authority, requires_human_review, created_at')
    .eq('id', pin.assessmentId).eq('assessment_version', pin.assessmentVersion).maybeSingle();
  if (assessment.error || assessment.data === null) return null;
  const review = await admin.from('workflow_assessment_reviews')
    .select('id, assessment_id, assessment_version, source_submission_id, review_version, reviewer_actor_id, overall_disposition, reviewer_summary, created_at')
    .eq('id', pin.reviewId).eq('review_version', pin.reviewVersion)
    .eq('assessment_id', pin.assessmentId).eq('assessment_version', pin.assessmentVersion).maybeSingle();
  if (review.error || review.data === null) return null;
  const steps = await admin.from('workflow_assessment_step_reviews')
    .select('id, review_id, assessment_step_id, proposed_classification, reviewed_classification, disposition, reviewer_notes, accepted_specification, created_at')
    .eq('review_id', pin.reviewId);
  if (steps.error || !Array.isArray(steps.data)) return null;
  const resolved = resolveEffectiveReviewedSpecification({ pin, assessmentRow: assessment.data,
    reviewRow: review.data, stepReviewRows: steps.data });
  if (!resolved.ok) return null;
  const planned = buildWorkflowImplementationPlan(resolved.artifact);
  return planned.ok ? planned.artifact : null;
}

/** Derives the immutable Plan V1 server-side, then queues only its exact identity. */
export async function createWorkflowRepositoryPlanRun(
  request: RepositoryPlanRunRequest,
  actor: RepositoryPlanRunActor,
  dependencies: Readonly<{ admin?: AdminClient }> = {},
) {
  const configuredAdmin = dependencies.admin ? null : getSupabaseAdmin();
  const admin: AdminClient | null = dependencies.admin
    ?? (configuredAdmin as unknown as AdminClient | null);
  if (!admin) return { ok: false, code: 'not_configured' } as const;
  try {
    const plan = await readTrustedPlan(request, admin);
    if (!plan) return { ok: false, code: 'invalid_pin' } as const;
    if (!plan.plannedSteps.some((step) => step.effectiveClassification === request.classification)) {
      return { ok: false, code: 'classification_not_present' } as const;
    }
    const created = await createRepositoryPlanGenerationJob({
      ...request,
      requestedByActorId: actor.actorId,
      implementationPlanV1DigestSha256: plan.digest.value,
    }, { control: admin });
    if (!created.ok) return { ok: false,
      code: created.code === 'not_configured' ? 'not_configured' : 'create_failed' } as const;
    return { ok: true, job: { jobId: created.jobId, status: created.status,
      classification: request.classification } } as const;
  } catch {
    return { ok: false, code: 'create_failed' } as const;
  }
}

/** Maps the private job row to the bounded operator status contract. */
export async function readWorkflowRepositoryPlanRun(
  jobId: string,
  dependencies: Readonly<{ admin?: AdminClient }> = {},
) {
  const configuredAdmin = dependencies.admin ? null : getSupabaseAdmin();
  const admin: AdminClient | null = dependencies.admin
    ?? (configuredAdmin as unknown as AdminClient | null);
  if (!admin) return { ok: false, code: 'not_configured' } as const;
  const read = await readRepositoryPlanGenerationJob(jobId, { control: admin });
  if (!read.ok) return { ok: false,
    code: read.code === 'not_found' ? 'not_found'
      : read.code === 'not_configured' ? 'not_configured' : 'read_failed' } as const;
  const row = read.job;
  const base = { jobId: row.job_id, classification: row.classification, status: row.job_status };
  if (row.job_status === 'failed') return { ok: true,
    job: { ...base, status: 'failed' as const, failureCode: row.failure_code ?? 'worker_failed' } } as const;
  if (row.job_status === 'succeeded') {
    if (!row.plan_v2_run_id || !row.plan_v2_digest_sha256 || !row.repository_commit_sha) {
      return { ok: false, code: 'read_failed' } as const;
    }
    return { ok: true, job: { ...base, status: 'succeeded' as const, result: {
      planV2RunId: row.plan_v2_run_id, planV2DigestSha256: row.plan_v2_digest_sha256,
      repositoryCommitSha: row.repository_commit_sha,
      providerCallCount: row.provider_call_count as 0 | 1,
    } } } as const;
  }
  return { ok: true, job: { ...base, status: row.job_status } } as const;
}
