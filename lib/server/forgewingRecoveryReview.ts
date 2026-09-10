import { z } from 'zod';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  RecoveryProposalReviewEvidenceSchema,
  RecoveryProposalReviewInputSchema,
  type RecoveryProposalReviewEvidence,
  type RecoveryProposalReviewInput,
} from '@/lib/forgewingRecoveryReview';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/**
 * Records one immutable recovery review.
 *
 * Reviewer identity and organization come from the verified actor context, not
 * from the request body: a browser may say which proposal it is reviewing and
 * what it decided, never who decided it or which tenant it belongs to.
 *
 * This seam makes zero provider calls. Accept, modify, reject and defer are
 * database writes; no Forgewing task runs, and no proposal is regenerated.
 */

export const RECOVERY_REVIEW_WRITE_FUNCTION =
  'record_forgewing_recovery_proposal_review' as const;
export const RECOVERY_REVIEW_V2_WRITE_FUNCTION =
  'record_forgewing_recovery_proposal_review_v2' as const;

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export type RecoveryReviewActor = Readonly<{ actorId: string; organizationId: string }>;

export type RecordRecoveryReviewResult =
  | Readonly<{ ok: true; review: RecoveryProposalReviewEvidence; inserted: boolean }>
  | Readonly<{ ok: false; code: 'invalid_review' | 'invalid_actor' | 'not_configured' | 'write_failed' }>;

const receipt = z.object({
  review_id: z.string().uuid(),
  review_version: z.number().int().positive(),
  proposal_row_id: z.string().uuid(),
  confirmed_observation_id: z.string().min(1).nullable().optional(),
  confirmed_candidate_id: z.string().min(1).nullable().optional(),
  confirmed_raw_text: z.string().min(1).nullable(),
  inserted: z.boolean(),
}).strict();

export async function recordForgewingRecoveryProposalReview(
  input: unknown,
  actor: RecoveryReviewActor,
  dependencies: Readonly<{ admin?: RpcClient | null }> = {},
): Promise<RecordRecoveryReviewResult> {
  const uuid = z.string().uuid();
  if (!uuid.safeParse(actor?.actorId).success || !uuid.safeParse(actor?.organizationId).success) {
    return { ok: false, code: 'invalid_actor' };
  }
  const parsed = RecoveryProposalReviewInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid_review' };
  const value: RecoveryProposalReviewInput = parsed.data;

  // The request digest covers the reviewer as well as the decision, so two
  // reviewers reaching the same conclusion are two reviews, and one reviewer
  // retrying is idempotent.
  const requestDigest = hashCanonical({
    reviewerActorId: actor.actorId,
    organizationId: actor.organizationId,
    ...value,
  });
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() : dependencies.admin;
  if (!admin) return { ok: false, code: 'not_configured' };

  const v2 = value.proposalId.startsWith('forgewing-proposal-recovery-v2-');
  const result = await admin.rpc(v2 ? RECOVERY_REVIEW_V2_WRITE_FUNCTION : RECOVERY_REVIEW_WRITE_FUNCTION, {
    p_organization_id: actor.organizationId,
    p_proposal_id: value.proposalId,
    p_proposal_digest_sha256: value.proposalDigestSha256,
    p_reviewer_actor_id: actor.actorId,
    p_disposition: value.disposition,
    ...(v2
      ? { p_confirmed_candidate_id:
          'confirmedCandidateId' in value ? value.confirmedCandidateId : null }
      : { p_confirmed_observation_id:
          'confirmedObservationId' in value ? value.confirmedObservationId : null }),
    p_reviewer_rationale: value.reviewerRationale,
    p_review_request_digest_sha256: requestDigest,
  });
  if (result.error) return { ok: false, code: 'write_failed' };
  const row = receipt.safeParse(Array.isArray(result.data) ? result.data[0] : result.data);
  if (!row.success) return { ok: false, code: 'write_failed' };

  const evidence = RecoveryProposalReviewEvidenceSchema.safeParse({
    reviewId: row.data.review_id,
    reviewVersion: row.data.review_version,
    proposalRowId: row.data.proposal_row_id,
    proposalId: value.proposalId,
    proposalDigestSha256: value.proposalDigestSha256,
    reviewerActorId: actor.actorId,
    reviewRequestDigestSha256: requestDigest,
    disposition: value.disposition,
    confirmedObservationId: row.data.confirmed_observation_id ?? null,
    ...(v2 ? { confirmedCandidateId: row.data.confirmed_candidate_id ?? null } : {}),
    confirmedRawText: row.data.confirmed_raw_text,
    reviewerRationale: value.reviewerRationale,
  });
  return evidence.success
    ? { ok: true, review: evidence.data, inserted: row.data.inserted }
    : { ok: false, code: 'write_failed' };
}
