import { z } from 'zod';

import { RepositoryClassificationSchema } from '@/lib/repositoryPlanEvidence';
import { createForgewingEngineeringWorkerClient } from '@/lib/server/forgewingEngineeringWorkerClient';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const CREATE_REPOSITORY_PLAN_JOB_RPC = 'create_workflow_repository_plan_generation_job' as const;
export const READ_REPOSITORY_PLAN_JOB_RPC = 'read_workflow_repository_plan_generation_job' as const;
export const CLAIM_REPOSITORY_PLAN_JOB_RPC = 'claim_workflow_repository_plan_generation_job' as const;
export const READ_REPOSITORY_PLAN_SOURCE_RPC = 'read_workflow_repository_plan_generation_source' as const;
export const BEGIN_REPOSITORY_PLAN_PROVIDER_RPC = 'begin_workflow_repository_plan_provider_call' as const;
export const SUCCEED_REPOSITORY_PLAN_JOB_RPC = 'succeed_workflow_repository_plan_generation_job' as const;
export const FAIL_REPOSITORY_PLAN_JOB_RPC = 'fail_workflow_repository_plan_generation_job' as const;

type RpcClient = Readonly<{
  rpc: (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const exactIdentity = z.object({
  assessmentId: z.string().uuid(), assessmentVersion: z.number().int().positive(),
  reviewId: z.string().uuid(), reviewVersion: z.number().int().positive(),
  classification: RepositoryClassificationSchema,
  implementationPlanV1DigestSha256: digest,
}).strict();

export const CreateRepositoryPlanGenerationJobSchema = exactIdentity.extend({
  requestedByActorId: z.string().uuid(),
}).strict();

const createReceipt = z.object({
  job_id: z.string().uuid(), job_status: z.literal('pending'), created_at: z.string(),
}).strict();
const claimReceipt = z.object({
  job_id: z.string().uuid(), claim_token: z.string().uuid(),
  claim_status: z.enum(['acquired', 'recovered_pre_provider']),
  assessment_id: z.string().uuid(), assessment_version: z.number().int().positive(),
  review_id: z.string().uuid(), review_version: z.number().int().positive(),
  classification: RepositoryClassificationSchema,
  implementation_plan_v1_digest_sha256: digest,
}).strict();
const readReceipt = z.object({
  job_id: z.string().uuid(), assessment_id: z.string().uuid(), assessment_version: z.number().int().positive(),
  review_id: z.string().uuid(), review_version: z.number().int().positive(),
  classification: RepositoryClassificationSchema,
  implementation_plan_v1_digest_sha256: digest,
  authority: z.literal('non_authoritative'), purpose: z.literal('repository_plan_generation'),
  requires_human_review: z.literal(true),
  job_status: z.enum(['pending', 'claimed', 'succeeded', 'failed']),
  provider_call_count: z.number().int().min(0).max(1),
  plan_v2_run_id: z.string().uuid().nullable(), plan_v2_digest_sha256: digest.nullable(),
  repository_commit_sha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  failure_code: z.string().regex(/^[a-z0-9_]{1,120}$/).nullable(),
  created_at: z.string(), updated_at: z.string(), completed_at: z.string().nullable(),
}).strict();
const sourceReceipt = z.object({
  assessment_row: z.object({}).passthrough(),
  review_row: z.object({}).passthrough(),
  step_review_rows: z.array(z.object({}).passthrough()),
}).strict();

function one(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

export type RepositoryPlanJobFailure = Readonly<{
  ok: false; code: 'invalid_input' | 'not_configured' | 'not_found' | 'database_failed' | 'invalid_receipt';
}>;

export async function createRepositoryPlanGenerationJob(input: unknown,
  dependencies: Readonly<{ control?: RpcClient }> = {}) {
  const parsed = CreateRepositoryPlanGenerationJobSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_input' } as const;
  const control = dependencies.control ?? getSupabaseAdmin();
  if (!control) return { ok: false, code: 'not_configured' } as const;
  try {
    const result = await control.rpc(CREATE_REPOSITORY_PLAN_JOB_RPC, {
      p_assessment_id: parsed.data.assessmentId, p_assessment_version: parsed.data.assessmentVersion,
      p_review_id: parsed.data.reviewId, p_review_version: parsed.data.reviewVersion,
      p_classification: parsed.data.classification, p_requested_by_actor_id: parsed.data.requestedByActorId,
      p_implementation_plan_v1_digest_sha256: parsed.data.implementationPlanV1DigestSha256,
    });
    if (result.error) return { ok: false, code: 'database_failed' } as const;
    const receipt = createReceipt.safeParse(one(result.data));
    return receipt.success ? { ok: true, jobId: receipt.data.job_id,
      status: receipt.data.job_status, createdAt: receipt.data.created_at } as const
      : { ok: false, code: 'invalid_receipt' } as const;
  } catch { return { ok: false, code: 'database_failed' } as const; }
}

export async function readRepositoryPlanGenerationJob(jobId: unknown,
  dependencies: Readonly<{ control?: RpcClient }> = {}) {
  const parsed = z.string().uuid().safeParse(jobId);
  if (!parsed.success) return { ok: false, code: 'invalid_input' } as const;
  const control = dependencies.control ?? getSupabaseAdmin();
  if (!control) return { ok: false, code: 'not_configured' } as const;
  try {
    const result = await control.rpc(READ_REPOSITORY_PLAN_JOB_RPC, { p_job_id: parsed.data });
    if (result.error) return { ok: false, code: 'database_failed' } as const;
    const row = one(result.data);
    if (row === undefined || row === null) return { ok: false, code: 'not_found' } as const;
    const receipt = readReceipt.safeParse(row);
    return receipt.success ? { ok: true, job: receipt.data } as const
      : { ok: false, code: 'invalid_receipt' } as const;
  } catch { return { ok: false, code: 'database_failed' } as const; }
}

export async function claimRepositoryPlanGenerationJob(worker: RpcClient | null =
  createForgewingEngineeringWorkerClient()) {
  if (!worker) return { ok: false, code: 'not_configured' } as const;
  try {
    const result = await worker.rpc(CLAIM_REPOSITORY_PLAN_JOB_RPC);
    if (result.error) return { ok: false, code: 'database_failed' } as const;
    const row = one(result.data);
    if (row === undefined || row === null) return { ok: true, job: null } as const;
    const receipt = claimReceipt.safeParse(row);
    return receipt.success ? { ok: true, job: receipt.data } as const
      : { ok: false, code: 'invalid_receipt' } as const;
  } catch { return { ok: false, code: 'database_failed' } as const; }
}

const claimMutation = z.object({ jobId: z.string().uuid(), claimToken: z.string().uuid() }).strict();

async function workerMutation(rpc: string, args: Record<string, unknown>,
  worker: RpcClient | null) {
  if (!worker) return { ok: false, code: 'not_configured' } as const;
  try {
    const result = await worker.rpc(rpc, args);
    return result.error ? { ok: false, code: 'database_failed' } as const : { ok: true } as const;
  } catch { return { ok: false, code: 'database_failed' } as const; }
}

export async function readRepositoryPlanGenerationSource(worker: RpcClient | null,
  jobId: unknown, claimToken: unknown) {
  const parsed = claimMutation.safeParse({ jobId, claimToken });
  if (!parsed.success) return { ok: false, code: 'invalid_input' } as const;
  if (!worker) return { ok: false, code: 'not_configured' } as const;
  try {
    const result = await worker.rpc(READ_REPOSITORY_PLAN_SOURCE_RPC,
      { p_job_id: parsed.data.jobId, p_claim_token: parsed.data.claimToken });
    if (result.error) return { ok: false, code: 'database_failed' } as const;
    const receipt = sourceReceipt.safeParse(one(result.data));
    return receipt.success ? { ok: true, source: receipt.data } as const
      : { ok: false, code: 'invalid_receipt' } as const;
  } catch { return { ok: false, code: 'database_failed' } as const; }
}

export async function beginRepositoryPlanProviderCall(worker: RpcClient | null,
  jobId: unknown, claimToken: unknown) {
  const parsed = claimMutation.safeParse({ jobId, claimToken });
  if (!parsed.success) return { ok: false, code: 'invalid_input' } as const;
  return workerMutation(BEGIN_REPOSITORY_PLAN_PROVIDER_RPC,
    { p_job_id: parsed.data.jobId, p_claim_token: parsed.data.claimToken }, worker);
}

export async function succeedRepositoryPlanGenerationJob(worker: RpcClient | null,
  jobId: unknown, claimToken: unknown, planV2RunId: unknown) {
  const parsed = claimMutation.extend({ planV2RunId: z.string().uuid() }).strict()
    .safeParse({ jobId, claimToken, planV2RunId });
  if (!parsed.success) return { ok: false, code: 'invalid_input' } as const;
  return workerMutation(SUCCEED_REPOSITORY_PLAN_JOB_RPC, {
    p_job_id: parsed.data.jobId, p_claim_token: parsed.data.claimToken,
    p_plan_v2_run_id: parsed.data.planV2RunId,
  }, worker);
}

export async function failRepositoryPlanGenerationJob(worker: RpcClient | null,
  jobId: unknown, claimToken: unknown, failureCode: unknown) {
  const parsed = claimMutation.extend({ failureCode: z.string().regex(/^[a-z0-9_]{1,120}$/) }).strict()
    .safeParse({ jobId, claimToken, failureCode });
  if (!parsed.success) return { ok: false, code: 'invalid_input' } as const;
  return workerMutation(FAIL_REPOSITORY_PLAN_JOB_RPC, {
    p_job_id: parsed.data.jobId, p_claim_token: parsed.data.claimToken,
    p_failure_code: parsed.data.failureCode,
  }, worker);
}
