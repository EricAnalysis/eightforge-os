import { z } from 'zod';
import { buildApprovedEngineeringRequest } from '@/lib/approvedEngineeringRequest';
import { WorkflowEngineeringReviewEvidenceSchema } from '@/lib/workflowEngineeringReview';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { readWorkflowRepositoryPlanV2 } from '@/lib/server/workflowRepositoryPlanRead';

export const ApprovedEngineeringRequestPinSchema=z.object({planV2RunId:z.string().uuid(),planV2DigestSha256:z.string().regex(/^[a-f0-9]{64}$/),recommendationId:z.string().regex(/^rec_[a-f0-9]{64}$/),reviewId:z.string().uuid(),reviewVersion:z.number().int().positive()}).strict();
export async function readApprovedEngineeringRequest(pin:unknown,dependencies:{admin?:any,readPlan?:typeof readWorkflowRepositoryPlanV2}={}){
 const p=ApprovedEngineeringRequestPinSchema.safeParse(pin); if(!p.success)return {ok:false as const,code:'invalid_pin' as const};
 const admin=dependencies.admin??getSupabaseAdmin(); if(!admin)return {ok:false as const,code:'not_configured' as const};
 const plan=await (dependencies.readPlan??readWorkflowRepositoryPlanV2)({planV2RunId:p.data.planV2RunId,planV2DigestSha256:p.data.planV2DigestSha256},{admin});
 if(!plan.ok)return {ok:false as const,code:plan.code};
 try { const q=await admin.from('workflow_repository_plan_recommendation_reviews').select('*').eq('id',p.data.reviewId).eq('review_version',p.data.reviewVersion).eq('plan_v2_run_id',p.data.planV2RunId).eq('plan_v2_digest_sha256',p.data.planV2DigestSha256).eq('recommendation_id',p.data.recommendationId).maybeSingle();
  if(q.error||!q.data)return {ok:false as const,code:q.error?'read_failed' as const:'not_found' as const};
  const r=q.data; const review=WorkflowEngineeringReviewEvidenceSchema.safeParse({reviewId:r.id,reviewVersion:r.review_version,reviewerActorId:r.reviewer_actor_id,reviewRequestDigestSha256:r.review_request_digest_sha256,planV2RunId:r.plan_v2_run_id,planV2DigestSha256:r.plan_v2_digest_sha256,recommendationId:r.recommendation_id,disposition:r.disposition,capabilityScope:r.capability_scope,reviewerRationale:r.reviewer_rationale,modifiedScope:r.modified_scope,repositoryCommitSha:r.repository_commit_sha});
  if(!review.success)return {ok:false as const,code:'artifact_invalid' as const}; return buildApprovedEngineeringRequest(plan.planV2,review.data);
 } catch{return {ok:false as const,code:'read_failed' as const};}
}
