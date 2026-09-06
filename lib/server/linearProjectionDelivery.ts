import { z } from 'zod';

import { buildLinearCapabilityProjection, LinearProjectionEvidenceBindingSchema } from '@/lib/linearCapabilityProjection';
import { repositoryContentEvidenceId } from '@/lib/repositoryPlanContent';
import { readApprovedEngineeringRequest } from '@/lib/server/approvedEngineeringRequestRead';
import { configuredLinearClient, type LinearClient } from '@/lib/server/linearClient';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { readWorkflowRepositoryPlanV2 } from '@/lib/server/workflowRepositoryPlanRead';
import { resolveWorkflowPlatformReviewAccess, type WorkflowPlatformReviewer } from '@/lib/server/workflowPlatformReviewAccess';

export const CLAIM_LINEAR_PROJECTION_FUNCTION = 'claim_linear_projection_delivery' as const;
export const CONFIRM_LINEAR_PROJECTION_FUNCTION = 'confirm_linear_projection_delivery' as const;
export const FAIL_LINEAR_PROJECTION_FUNCTION = 'fail_linear_projection_delivery' as const;

export const LinearProjectionDeliveryInputSchema = z.object({
  planV2RunId: z.string().uuid(),
  planV2DigestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recommendationId: z.string().regex(/^rec_[a-f0-9]{64}$/),
  reviewId: z.string().uuid(),
  reviewVersion: z.number().int().positive(),
  evidenceBindings: z.array(LinearProjectionEvidenceBindingSchema).max(20),
}).strict();
export type LinearProjectionDeliveryInput = z.infer<typeof LinearProjectionDeliveryInputSchema>;

type Admin = Readonly<{ rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }>;
type Configuration = Readonly<{ projectId: string; client: LinearClient }>;
type Dependencies = Readonly<{
  admin?: Admin;
  configuration?: Configuration | null;
  readApproved?: typeof readApprovedEngineeringRequest;
  readPlan?: typeof readWorkflowRepositoryPlanV2;
}>;

const claimReceipt = z.object({
  correlation_id: z.string().uuid(),
  claim_token: z.string().uuid(),
  claim_status: z.enum(['acquired', 'recovered', 'busy', 'existing_projected']),
  linear_issue_id: z.string().nullable(),
  linear_issue_identifier: z.string().nullable(),
}).strict();

export type LinearProjectionDeliveryResult =
  | Readonly<{ status: 'projected'; correlationId: string; issue: { id: string; identifier: string }; recovered: boolean }>
  | Readonly<{ status: 'in_progress'; correlationId: string }>
  | Readonly<{ status: 'reviewer_not_eligible' | 'invalid_input' | 'approval_not_eligible'
    | 'evidence_invalid' | 'projection_not_configured' | 'claim_failed'
    | 'projection_failed' | 'confirmation_failed' }>;

async function markFailed(admin: Admin, correlationId: string, claimToken: string, code: string): Promise<boolean> {
  try {
    const result = await admin.rpc(FAIL_LINEAR_PROJECTION_FUNCTION, {
      p_correlation_id: correlationId, p_claim_token: claimToken, p_failure_code: code,
    });
    return !result.error;
  } catch { return false; }
}

/** One manual bounded delivery attempt. There is no loop, timer, daemon, or automatic retry. */
export async function projectApprovedEngineeringRequestToLinear(
  input: unknown,
  reviewer: WorkflowPlatformReviewer,
  dependencies: Dependencies = {},
): Promise<LinearProjectionDeliveryResult> {
  if (!resolveWorkflowPlatformReviewAccess(reviewer).allowed) return { status: 'reviewer_not_eligible' };
  const parsed = LinearProjectionDeliveryInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid_input' };
  const pin = { planV2RunId: parsed.data.planV2RunId, planV2DigestSha256: parsed.data.planV2DigestSha256,
    recommendationId: parsed.data.recommendationId, reviewId: parsed.data.reviewId,
    reviewVersion: parsed.data.reviewVersion };
  const admin = dependencies.admin ?? getSupabaseAdmin();
  if (!admin) return { status: 'projection_not_configured' };
  const approved = await (dependencies.readApproved ?? readApprovedEngineeringRequest)(pin, { admin: admin as never });
  if (!approved.ok) return { status: 'approval_not_eligible' };
  const plan = await (dependencies.readPlan ?? readWorkflowRepositoryPlanV2)(
    { planV2RunId: pin.planV2RunId, planV2DigestSha256: pin.planV2DigestSha256 }, { admin: admin as never });
  if (!plan.ok) return { status: 'approval_not_eligible' };
  const classification = plan.planV2.guidance.classification;
  if (parsed.data.evidenceBindings.some((binding) => binding.evidenceRef !== repositoryContentEvidenceId({
    commitSha: binding.commitSha, classification, filePath: binding.filePath, blobSha: binding.blobSha,
  }))) return { status: 'evidence_invalid' };
  const built = buildLinearCapabilityProjection(approved.request, parsed.data.evidenceBindings);
  if (!built.ok) return { status: 'evidence_invalid' };
  const configuration = dependencies.configuration === undefined
    ? configuredLinearClient() : dependencies.configuration;
  if (!configuration) return { status: 'projection_not_configured' };

  let claimResult: { data: unknown; error: unknown };
  try {
    claimResult = await admin.rpc(CLAIM_LINEAR_PROJECTION_FUNCTION, {
      p_engineering_request_digest_sha256: approved.request.digest.value,
      p_projection_digest_sha256: built.projection.digest.value,
      p_plan_v2_run_id: pin.planV2RunId,
      p_review_id: pin.reviewId,
      p_recommendation_id: pin.recommendationId,
      p_repository_commit_sha: approved.request.source.repositoryCommitSha,
      p_linear_project_id: configuration.projectId,
    });
  } catch { return { status: 'claim_failed' }; }
  const row = Array.isArray(claimResult.data) ? claimResult.data[0] : claimResult.data;
  const receipt = claimResult.error ? null : claimReceipt.safeParse(row);
  if (!receipt?.success) return { status: 'claim_failed' };
  const claim = receipt.data;
  if (claim.claim_status === 'busy') return { status: 'in_progress', correlationId: claim.correlation_id };
  if (claim.claim_status === 'existing_projected') {
    if (!claim.linear_issue_id || !claim.linear_issue_identifier) return { status: 'claim_failed' };
    return { status: 'projected', correlationId: claim.correlation_id,
      issue: { id: claim.linear_issue_id, identifier: claim.linear_issue_identifier }, recovered: true };
  }

  let issue: { id: string; identifier: string } | null = null;
  try {
    if (claim.claim_status === 'recovered') {
      issue = await configuration.client.findProjectedIssueByIdempotencyKey(built.projection.idempotencyKey);
    }
    issue ??= await configuration.client.createIssue(built.projection);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,120}$/.test(error.message)
      ? error.message : 'linear_unavailable';
    await markFailed(admin, claim.correlation_id, claim.claim_token, code);
    return { status: 'projection_failed' };
  }
  try {
    const confirmed = await admin.rpc(CONFIRM_LINEAR_PROJECTION_FUNCTION, {
      p_correlation_id: claim.correlation_id, p_claim_token: claim.claim_token,
      p_linear_issue_id: issue.id, p_linear_issue_identifier: issue.identifier,
    });
    if (confirmed.error) return { status: 'confirmation_failed' };
  } catch { return { status: 'confirmation_failed' }; }
  return { status: 'projected', correlationId: claim.correlation_id, issue,
    recovered: claim.claim_status === 'recovered' };
}
