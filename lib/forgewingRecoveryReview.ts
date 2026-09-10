import { z } from 'zod';

import { RECOVERY_PROPOSAL_ID_PATTERN } from '@/lib/forgewingRecoveryProposal';

/**
 * Immutable human review of a recovery proposal.
 *
 * The review is the only authority that can authorize a deterministic
 * reconstruction re-entry. It pins an exact proposal digest -- never "the
 * newest proposal for this page" -- and it selects among observations rather
 * than authoring a value.
 *
 * V1 boundary: `modified` means the reviewer chose a different already-observed
 * eligible token from the same evidence bundle. Arbitrary human-authored rate
 * values are deliberately out of scope: Forgewing V1 cannot represent one, and
 * admitting one here would introduce a value-authoring path that no evidence
 * anchor could back. That remains future scope.
 */

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const observationId = z.string().min(1).max(200).refine((value) => value.trim() === value);
const candidateId = z.string().regex(/^recovery-candidate-v2-[a-f0-9]{64}$/);
const rationale = z.string().trim().min(1).max(4_000);

const pin = {
  proposalId: z.string().regex(RECOVERY_PROPOSAL_ID_PATTERN),
  proposalDigestSha256: digest,
};

export const RECOVERY_REVIEW_DISPOSITIONS = ['accepted', 'modified', 'rejected', 'deferred'] as const;
export const RecoveryReviewDispositionSchema = z.enum(RECOVERY_REVIEW_DISPOSITIONS);
export type RecoveryReviewDisposition = z.infer<typeof RecoveryReviewDispositionSchema>;

const RecoveryProposalReviewInputV1Schema = z.discriminatedUnion('disposition', [
  // Accept confirms the observation Forgewing selected. The observation id is
  // still required and still checked against the pinned proposal, so an accept
  // cannot silently confirm something the reviewer was not shown.
  z.object({ ...pin, disposition: z.literal('accepted'),
    confirmedObservationId: observationId, reviewerRationale: rationale }).strict(),
  z.object({ ...pin, disposition: z.literal('modified'),
    confirmedObservationId: observationId, reviewerRationale: rationale }).strict(),
  z.object({ ...pin, disposition: z.literal('rejected'), reviewerRationale: rationale }).strict(),
  z.object({ ...pin, disposition: z.literal('deferred'), reviewerRationale: rationale }).strict(),
]);
const RecoveryProposalReviewInputV2Schema = z.discriminatedUnion('disposition', [
  z.object({ ...pin, disposition: z.literal('accepted'),
    confirmedCandidateId: candidateId, reviewerRationale: rationale }).strict(),
  z.object({ ...pin, disposition: z.literal('modified'),
    confirmedCandidateId: candidateId, reviewerRationale: rationale }).strict(),
  z.object({ ...pin, disposition: z.literal('rejected'), reviewerRationale: rationale }).strict(),
  z.object({ ...pin, disposition: z.literal('deferred'), reviewerRationale: rationale }).strict(),
]);
export const RecoveryProposalReviewInputSchema = z.union([
  RecoveryProposalReviewInputV1Schema,
  RecoveryProposalReviewInputV2Schema,
]);
export type RecoveryProposalReviewInput = z.infer<typeof RecoveryProposalReviewInputSchema>;

export const RecoveryProposalReviewEvidenceSchema = z.object({
  reviewId: z.string().uuid(),
  reviewVersion: z.number().int().positive(),
  proposalRowId: z.string().uuid(),
  ...pin,
  reviewerActorId: z.string().uuid(),
  reviewRequestDigestSha256: digest,
  disposition: RecoveryReviewDispositionSchema,
  confirmedObservationId: observationId.nullable(),
  confirmedCandidateId: candidateId.nullable().optional(),
  /**
   * Read out of the pinned proposal's evidence server-side, never supplied.
   *
   * Bounded by the candidate contract's `composedRawText`, not by the V1
   * observation `rawText` cap: a continuation candidate composes a whole
   * wrapped description. A tighter bound here would reject the receipt for a
   * review the database had already committed, leaving a persisted review the
   * server could never acknowledge -- and no retry could clear it, because
   * idempotency returns that same row.
   */
  confirmedRawText: z.string().min(1).max(4_000).nullable(),
  reviewerRationale: rationale,
}).strict().superRefine((value, ctx) => {
  const approving = value.disposition === 'accepted' || value.disposition === 'modified';
  const selectionCount = Number(value.confirmedObservationId !== null)
    + Number(value.confirmedCandidateId != null);
  if ((approving && selectionCount !== 1) || (!approving && selectionCount !== 0)
    || approving !== (value.confirmedRawText !== null)) {
    ctx.addIssue({ code: 'custom', message: 'recovery review confirmation coherence mismatch' });
  }
});
export type RecoveryProposalReviewEvidence = z.infer<typeof RecoveryProposalReviewEvidenceSchema>;

/** Whether a review authorizes reconstruction re-entry at all. */
export function reviewAuthorizesReentry(
  review: Pick<RecoveryProposalReviewEvidence, 'disposition'>,
): boolean {
  return review.disposition === 'accepted' || review.disposition === 'modified';
}
