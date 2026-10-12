import { z } from 'zod';

import { ApprovedEngineeringRequestPinSchema, readApprovedEngineeringRequest } from '@/lib/server/approvedEngineeringRequestRead';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

/**
 * Human attestation that an approved engineering request shipped (B8.4b).
 * Trusted server only; platform-review authority, checked at the route and
 * again here.
 *
 * A person names the exact merge commit. Nothing is inferred from Linear
 * status, PR titles or branch names, and the attestation proves nothing about
 * deployment: the worker proves that separately by git ancestry. The request
 * must be the current approved (accepted or modified) review of a
 * triage-sourced Plan V2; an assessment-sourced request has no originating
 * friction and is refused as not measurable. The event is append-only: a
 * second attestation of the same commit returns the first, and a different
 * commit is refused.
 */

export const RECORD_IMPROVEMENT_FIX_ATTESTATION_FUNCTION = 'record_improvement_fix_attestation' as const;

export const ImprovementFixAttestationInputSchema = ApprovedEngineeringRequestPinSchema.extend({
  fixCommitSha: z.string().regex(/^[a-f0-9]{40}$/, 'full lowercase 40-character commit SHA'),
}).strict();
export type ImprovementFixAttestationInput = z.infer<typeof ImprovementFixAttestationInputSchema>;

export type SessionDerivedAttester = Readonly<{ actorId: string; email: string | null; role: string | null }>;

export type ImprovementFixAttestationResult =
  | Readonly<{ status: 'attested'; eventId: string; inserted: boolean; recordedAt: string;
    engineeringRequestDigestSha256: string; fixCommitSha: string }>
  | Readonly<{ status: 'reviewer_not_eligible' | 'invalid_input' | 'not_configured' | 'request_not_found'
    | 'request_not_approved' | 'review_superseded' | 'not_measurable_source' | 'conflicting_attestation'
    | 'attestation_failed' }>;

type Admin = Readonly<{ rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }>;

const ReceiptSchema = z.object({
  event_id: z.string().uuid(), inserted: z.boolean(), recorded_at: z.string().min(1),
}).strict();

type FailureStatus = Exclude<ImprovementFixAttestationResult['status'], 'attested'>;
const ERROR_STATUS: Readonly<Record<string, FailureStatus>> = {
  P0002: 'request_not_found', B8401: 'request_not_approved', B8402: 'review_superseded',
  B8403: 'not_measurable_source', B8404: 'conflicting_attestation', '22023': 'invalid_input',
};

export async function recordImprovementFixAttestation(
  input: unknown,
  attester: SessionDerivedAttester,
  dependencies: Readonly<{ admin?: Admin | null; readApproved?: typeof readApprovedEngineeringRequest }> = {},
): Promise<ImprovementFixAttestationResult> {
  if (!resolveWorkflowPlatformReviewAccess(attester).allowed) return { status: 'reviewer_not_eligible' };
  const parsed = ImprovementFixAttestationInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid_input' };
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() : dependencies.admin;
  if (!admin) return { status: 'not_configured' };

  const { fixCommitSha, ...pin } = parsed.data;
  // The approved request is rebuilt from its exact pin, as Linear projection
  // does; its digest is what the attestation binds to.
  const approved = await (dependencies.readApproved ?? readApprovedEngineeringRequest)(pin, { admin });
  if (!approved.ok) {
    return approved.code === 'not_approved' ? { status: 'request_not_approved' }
      : approved.code === 'not_found' ? { status: 'request_not_found' } : { status: 'attestation_failed' };
  }
  const digest = approved.request.digest.value;

  let result: { data: unknown; error: unknown };
  try {
    result = await admin.rpc(RECORD_IMPROVEMENT_FIX_ATTESTATION_FUNCTION, {
      p_engineering_review_id: pin.reviewId, p_engineering_review_version: pin.reviewVersion,
      p_engineering_request_digest_sha256: digest, p_fix_commit_sha: fixCommitSha, p_attested_by: attester.actorId,
    });
  } catch { return { status: 'attestation_failed' }; }
  if (result.error) {
    const code = (result.error as { code?: unknown }).code;
    return { status: (typeof code === 'string' && ERROR_STATUS[code]) || 'attestation_failed' };
  }
  const receipt = ReceiptSchema.safeParse(Array.isArray(result.data) ? result.data[0] : result.data);
  if (!receipt.success) return { status: 'attestation_failed' };
  return { status: 'attested', eventId: receipt.data.event_id, inserted: receipt.data.inserted,
    recordedAt: receipt.data.recorded_at, engineeringRequestDigestSha256: digest, fixCommitSha };
}
