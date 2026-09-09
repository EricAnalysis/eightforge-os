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
const rationale = z.string().trim().min(1).max(4_000);

const pin = {
  proposalId: z.string().regex(RECOVERY_PROPOSAL_ID_PATTERN),
  proposalDigestSha256: digest,
};

export const RECOVERY_REVIEW_DISPOSITIONS = ['accepted', 'modified', 'rejected', 'deferred'] as const;
export const RecoveryReviewDispositionSchema = z.enum(RECOVERY_REVIEW_DISPOSITIONS);
export type RecoveryReviewDisposition = z.infer<typeof RecoveryReviewDispositionSchema>;

export const RecoveryProposalReviewInputSchema = z.discriminatedUnion('disposition', [
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
  /** Read out of the pinned proposal's evidence server-side, never supplied. */
  confirmedRawText: z.string().min(1).max(200).nullable(),
  reviewerRationale: rationale,
}).strict().superRefine((value, ctx) => {
  const approving = value.disposition === 'accepted' || value.disposition === 'modified';
  if (approving !== (value.confirmedObservationId !== null)
    || (value.confirmedObservationId !== null) !== (value.confirmedRawText !== null)) {
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
