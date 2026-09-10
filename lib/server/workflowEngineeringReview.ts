import { z } from 'zod';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { WorkflowEngineeringReviewEvidenceSchema, WorkflowEngineeringReviewInputSchema,
  type WorkflowEngineeringReviewInput } from '@/lib/workflowEngineeringReview';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolveWorkflowPlatformReviewAccess, type WorkflowPlatformReviewer } from '@/lib/server/workflowPlatformReviewAccess';

export const WORKFLOW_ENGINEERING_REVIEW_WRITE_FUNCTION = 'record_workflow_repository_plan_recommendation_review' as const;
type Actor = WorkflowPlatformReviewer & Readonly<{ id: string }>;
type RpcClient = { rpc(name: string,args: Record<string,unknown>): PromiseLike<{data:unknown;error:unknown}> };
const receipt = z.object({review_id:z.string().uuid(),review_version:z.number().int().positive(),repository_commit_sha:z.string().regex(/^[a-f0-9]{40}$/),inserted:z.boolean()}).strict();
export async function recordWorkflowEngineeringReview(input: unknown, actor: Actor, dependencies: {admin?:RpcClient} = {}) {
  const access = resolveWorkflowPlatformReviewAccess(actor);
  if (!access.allowed) return {ok:false as const,code:'reviewer_not_eligible' as const};
  const parsed = WorkflowEngineeringReviewInputSchema.safeParse(input);
  if (!parsed.success || !z.string().uuid().safeParse(actor.id).success) return {ok:false as const,code:'invalid_review' as const};
  const value: WorkflowEngineeringReviewInput = parsed.data;
  const requestDigest = hashCanonical({reviewerActorId:actor.id,...value});
  const admin = dependencies.admin ?? getSupabaseAdmin();
  if (!admin) return {ok:false as const,code:'not_configured' as const};
  const result = await admin.rpc(WORKFLOW_ENGINEERING_REVIEW_WRITE_FUNCTION,{
    p_plan_v2_run_id:value.planV2RunId,p_plan_v2_digest_sha256:value.planV2DigestSha256,
    p_recommendation_id:value.recommendationId,p_reviewer_actor_id:actor.id,p_disposition:value.disposition,
    p_capability_scope:'capabilityScope' in value?value.capabilityScope:null,
    p_reviewer_rationale:value.reviewerRationale,p_modified_scope:'modifiedScope' in value?JSON.parse(canonicalJson(value.modifiedScope)):null,
    p_review_request_digest_sha256:requestDigest});
  if (result.error) return {ok:false as const,code:'write_failed' as const};
  const row=receipt.safeParse(Array.isArray(result.data)?result.data[0]:result.data);
  if(!row.success) return {ok:false as const,code:'write_failed' as const};
  const evidence=WorkflowEngineeringReviewEvidenceSchema.safeParse({reviewId:row.data.review_id,reviewVersion:row.data.review_version,
    reviewerActorId:actor.id,reviewRequestDigestSha256:requestDigest,planV2RunId:value.planV2RunId,
    planV2DigestSha256:value.planV2DigestSha256,recommendationId:value.recommendationId,disposition:value.disposition,
    capabilityScope:'capabilityScope' in value?value.capabilityScope:null,reviewerRationale:value.reviewerRationale,
    modifiedScope:'modifiedScope' in value?value.modifiedScope:null,repositoryCommitSha:row.data.repository_commit_sha});
  return evidence.success?{ok:true as const,review:evidence.data,inserted:row.data.inserted}:{ok:false as const,code:'write_failed' as const};
}
