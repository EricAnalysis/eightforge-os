import { z } from 'zod';

import { RECOVERY_PROPOSAL_ID_PATTERN } from '@/lib/forgewingRecoveryProposal';

/**
 * A human-confirmed recovery selection.
 *
 * This is NOT a canonical fact and NOT an extracted value. It is deterministic
 * input authorization: it says that a named human, reviewing an exact proposal,
 * confirmed that one already-observed token is the rate for one previously
 * abstained-on spine. Reconstruction may then resolve that abstention itself,
 * by its own rules, and emit an ordinary priced row.
 *
 * It is not executable, carries no rule and no expression, and nothing
 * downstream reads it: it is consumed during reconstruction, before the
 * ordinary pipeline begins.
 */

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const observationId = z.string().min(1).max(200).refine((value) => value.trim() === value);

export const ConfirmedRecoverySchema = z.object({
  organizationId: z.string().uuid(),
  sourceDocumentId: z.string().uuid(),
  sourceArtifactId: z.string().uuid(),
  physicalPageNumber: z.number().int().positive(),
  /** Present when the proposal captured it; observation identity carries it regardless. */
  pageRepresentationDigest: digest.nullable(),

  // Exact pins. Authority is never "the newest review of the newest proposal".
  proposalId: z.string().regex(RECOVERY_PROPOSAL_ID_PATTERN),
  proposalDigestSha256: digest,
  reviewId: z.string().uuid(),
  reviewVersion: z.number().int().positive(),
  reviewDisposition: z.enum(['accepted', 'modified']),
  reviewerActorId: z.string().uuid(),

  confirmedObservationId: observationId,
  /** Authored text of the confirmed observation, as the proposal recorded it. */
  confirmedRawText: z.string().min(1).max(200),

  authority: z.literal('human_confirmed'),
  executable: z.literal(false),
  purpose: z.literal('reconstruction_reentry'),
}).strict();
export type ConfirmedRecovery = z.infer<typeof ConfirmedRecoverySchema>;

/**
 * Why an otherwise reviewed proposal produced no confirmation.
 *
 * Every one of these is a fail-closed outcome: the row stays withheld and the
 * operator is told why. None of them ever softens into a guess.
 */
export const RECOVERY_CONFIRMATION_DIAGNOSTICS = [
  /** More than one accepted/modified review pins the same proposal. */
  'ambiguous_recovery_authority',
  /** The review receipt did not satisfy the confirmation contract. */
  'incoherent_recovery_confirmation',
  /**
   * A prior confirmation names an observation this reprocessing did not
   * produce -- typically because the page representation digest changed, which
   * changes observation identity. Never rebound by text.
   */
  'confirmed_recovery_unbound',
] as const;
export type RecoveryConfirmationDiagnosticCode =
  (typeof RECOVERY_CONFIRMATION_DIAGNOSTICS)[number];

export const RecoveryConfirmationDiagnosticSchema = z.object({
  code: z.enum(RECOVERY_CONFIRMATION_DIAGNOSTICS),
  proposalId: z.string().min(1),
  proposalDigestSha256: digest,
  reviewId: z.string().uuid().nullable(),
  sourceDocumentId: z.string().uuid(),
  sourceArtifactId: z.string().uuid(),
  physicalPageNumber: z.number().int().positive(),
  expectedObservationId: observationId.nullable(),
  recoveryApplied: z.literal(false),
}).strict();
export type RecoveryConfirmationDiagnostic = z.infer<typeof RecoveryConfirmationDiagnosticSchema>;
