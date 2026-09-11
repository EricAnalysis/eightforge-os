import type { ConfirmedRateObservation }
  from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import type { RecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  ConfirmedRecoverySchema,
  ConfirmedRecoveryV2Schema,
  type ConfirmedRecovery,
  type ConfirmedRecoveryV2,
  type RecoveryConfirmationDiagnostic,
} from '@/lib/forgewingConfirmedRecovery';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/**
 * The single business-logic seam between human review and reconstruction.
 *
 * Given one exact source processing identity, this resolves which already-
 * observed tokens a human has confirmed as rates. It is the ONLY place that
 * turns "a review exists" into "reconstruction may resolve this abstention".
 * No extractor, route, or component may decide that for itself.
 *
 * Determinism rules, all fail-closed:
 *
 *   - A proposal with no accepted/modified review yields nothing.
 *   - A proposal with exactly one accepted/modified review yields exactly one
 *     confirmation, carrying both pins.
 *   - A proposal with more than one accepted/modified review yields NOTHING and
 *     a diagnostic. Reviews are immutable and append-only, so two approving
 *     reviews mean two answers; picking the newest would be a latest-wins
 *     authority, which this deliberately refuses.
 *   - Rejected and deferred reviews are never read as approving, and a proposal
 *     whose only reviews are rejected or deferred yields nothing silently --
 *     that is the reviewer's decision working, not a failure.
 *
 * The output is ordered by confirmed observation id so a caller's behaviour
 * cannot depend on database row order.
 */

/**
 * Table names, restated rather than imported: importing the write seams to
 * reuse a constant would hand this read-only resolver the ability to record a
 * proposal or a review. The companion test asserts these match the canonical
 * constants, so a rename fails loudly.
 */
export const RECOVERY_PROPOSAL_TABLE = 'forgewing_recovery_proposals' as const;
export const RECOVERY_REVIEW_TABLE = 'forgewing_recovery_proposal_reviews' as const;

export type EffectiveRecoveryConfirmationQuery = Readonly<{
  organizationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
}>;

export type EffectiveRecoveryConfirmations = Readonly<{
  confirmations: readonly ConfirmedRecovery[];
  candidateConfirmations?: readonly ConfirmedRecoveryV2[];
  diagnostics: readonly RecoveryConfirmationDiagnostic[];
}>;

export type EffectiveRecoveryConfirmationResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>
  | (Readonly<{ status: 'ok' }> & EffectiveRecoveryConfirmations);

type SelectResult = { data: unknown; error: { message?: string } | null };
type QueryBuilder = {
  select(columns: string): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  in(column: string, values: readonly unknown[]): QueryBuilder;
  then<R>(onfulfilled: (value: SelectResult) => R): PromiseLike<R>;
};
export type RecoveryReadClient = { from(table: string): QueryBuilder };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** The empty result an unconfigured or proposal-free document produces. */
export const NO_RECOVERY_CONFIRMATIONS: EffectiveRecoveryConfirmations = Object.freeze({
  confirmations: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

export async function resolveEffectiveRecoveryConfirmations(
  query: EffectiveRecoveryConfirmationQuery,
  dependencies: Readonly<{ admin?: RecoveryReadClient | null }> = {},
): Promise<EffectiveRecoveryConfirmationResult> {
  const admin = dependencies.admin === undefined
    ? (getSupabaseAdmin() as unknown as RecoveryReadClient | null)
    : dependencies.admin;
  if (!admin) return { status: 'not_configured' };

  const proposalRead: SelectResult = await admin
    .from(RECOVERY_PROPOSAL_TABLE)
    .select('id, proposal_id, proposal_digest_sha256, physical_page_number, page_representation_digest, proposal_version, recovery_type, recovery_candidates')
    .eq('organization_id', query.organizationId)
    .eq('source_document_id', query.sourceDocumentId)
    .eq('source_artifact_id', query.sourceArtifactId);
  if (proposalRead.error) {
    return { status: 'read_failed', reason: proposalRead.error.message ?? 'proposal_read_failed' };
  }
  const proposals = (Array.isArray(proposalRead.data) ? proposalRead.data : [])
    .filter(isRecord)
    .flatMap((row) => {
      const id = row.id;
      const proposalId = row.proposal_id;
      const digest = row.proposal_digest_sha256;
      const page = row.physical_page_number;
      if (typeof id !== 'string' || typeof proposalId !== 'string'
        || typeof digest !== 'string' || typeof page !== 'number') return [];
      return [{
        id,
        proposalId,
        proposalDigestSha256: digest,
        physicalPageNumber: page,
        pageRepresentationDigest:
          typeof row.page_representation_digest === 'string' ? row.page_representation_digest : null,
        proposalVersion: row.proposal_version === 2 ? 2 as const : 1 as const,
        recoveryType: typeof row.recovery_type === 'string' ? row.recovery_type : null,
        recoveryCandidates: row.recovery_candidates,
      }];
    });
  if (proposals.length === 0) return { status: 'ok', ...NO_RECOVERY_CONFIRMATIONS };

  const reviewRead: SelectResult = await admin
    .from(RECOVERY_REVIEW_TABLE)
    .select('id, proposal_row_id, proposal_digest_sha256, review_version, reviewer_actor_id, disposition, confirmed_observation_id, confirmed_candidate_id, confirmed_raw_text')
    .eq('organization_id', query.organizationId)
    .in('proposal_row_id', proposals.map((entry) => entry.id));
  if (reviewRead.error) {
    return { status: 'read_failed', reason: reviewRead.error.message ?? 'review_read_failed' };
  }

  const approvingByProposal = new Map<string, Record<string, unknown>[]>();
  for (const row of (Array.isArray(reviewRead.data) ? reviewRead.data : []).filter(isRecord)) {
    // Rejected and deferred never reach the confirmation path at all.
    if (row.disposition !== 'accepted' && row.disposition !== 'modified') continue;
    const key = row.proposal_row_id;
    if (typeof key !== 'string') continue;
    approvingByProposal.set(key, [...(approvingByProposal.get(key) ?? []), row]);
  }

  const confirmations: ConfirmedRecovery[] = [];
  const candidateConfirmations: ConfirmedRecoveryV2[] = [];
  const diagnostics: RecoveryConfirmationDiagnostic[] = [];
  for (const proposal of proposals) {
    const approving = approvingByProposal.get(proposal.id) ?? [];
    if (approving.length === 0) continue;
    const base = {
      proposalId: proposal.proposalId,
      proposalDigestSha256: proposal.proposalDigestSha256,
      sourceDocumentId: query.sourceDocumentId,
      sourceArtifactId: query.sourceArtifactId,
      physicalPageNumber: proposal.physicalPageNumber,
      recoveryApplied: false as const,
    };
    if (approving.length > 1) {
      diagnostics.push({
        ...base, code: 'ambiguous_recovery_authority',
        reviewId: null, expectedObservationId: null,
      });
      continue;
    }
    const review = approving[0]!;
    if (proposal.proposalVersion === 2) {
      const candidate = (Array.isArray(proposal.recoveryCandidates)
        ? proposal.recoveryCandidates : []).find((entry) =>
          isRecord(entry) && entry.candidateId === review.confirmed_candidate_id);
      const parsedV2 = ConfirmedRecoveryV2Schema.safeParse({
        organizationId: query.organizationId,
        sourceDocumentId: query.sourceDocumentId,
        sourceArtifactId: query.sourceArtifactId,
        physicalPageNumber: proposal.physicalPageNumber,
        pageRepresentationDigest: proposal.pageRepresentationDigest,
        proposalId: proposal.proposalId,
        proposalDigestSha256: proposal.proposalDigestSha256,
        reviewId: review.id,
        reviewVersion: review.review_version,
        reviewDisposition: review.disposition,
        reviewerActorId: review.reviewer_actor_id,
        confirmedCandidate: candidate,
        authority: 'human_confirmed',
        executable: false,
        purpose: 'reconstruction_reentry',
      });
      if (!parsedV2.success || review.proposal_digest_sha256 !== proposal.proposalDigestSha256) {
        diagnostics.push({ ...base, code: 'incoherent_recovery_confirmation',
          reviewId: typeof review.id === 'string' ? review.id : null,
          expectedObservationId: null });
      } else {
        candidateConfirmations.push(parsedV2.data);
      }
      continue;
    }
    const parsed = ConfirmedRecoverySchema.safeParse({
      organizationId: query.organizationId,
      sourceDocumentId: query.sourceDocumentId,
      sourceArtifactId: query.sourceArtifactId,
      physicalPageNumber: proposal.physicalPageNumber,
      pageRepresentationDigest: proposal.pageRepresentationDigest,
      proposalId: proposal.proposalId,
      proposalDigestSha256: proposal.proposalDigestSha256,
      reviewId: review.id,
      reviewVersion: review.review_version,
      reviewDisposition: review.disposition,
      reviewerActorId: review.reviewer_actor_id,
      confirmedObservationId: review.confirmed_observation_id,
      confirmedRawText: review.confirmed_raw_text,
      authority: 'human_confirmed',
      executable: false,
      purpose: 'reconstruction_reentry',
    });
    if (!parsed.success || review.proposal_digest_sha256 !== proposal.proposalDigestSha256) {
      diagnostics.push({
        ...base, code: 'incoherent_recovery_confirmation',
        reviewId: typeof review.id === 'string' ? review.id : null,
        expectedObservationId: null,
      });
      continue;
    }
    confirmations.push(parsed.data);
  }

  confirmations.sort((left, right) =>
    left.confirmedObservationId.localeCompare(right.confirmedObservationId, 'en-US'));
  candidateConfirmations.sort((left, right) =>
    left.confirmedCandidate.candidateId.localeCompare(
      right.confirmedCandidate.candidateId, 'en-US'));
  diagnostics.sort((left, right) =>
    left.proposalId.localeCompare(right.proposalId, 'en-US') || left.code.localeCompare(right.code, 'en-US'));
  return {
    status: 'ok',
    confirmations: Object.freeze(confirmations),
    ...(candidateConfirmations.length > 0
      ? { candidateConfirmations: Object.freeze(candidateConfirmations) }
      : {}),
    diagnostics: Object.freeze(diagnostics),
  };
}

/**
 * The single entry point a processing pipeline uses.
 *
 * Both extraction pipelines call this and nothing else, so "an accepted
 * recovery exists" is decided in exactly one place. A resolver failure yields
 * an empty set: an unavailable review database must leave reconstruction
 * behaving exactly as it did before recovery existed, never admit a row.
 */
export async function loadConfirmedRateObservations(
  query: EffectiveRecoveryConfirmationQuery,
  dependencies: Readonly<{
    admin?: RecoveryReadClient | null;
    resolve?: typeof resolveEffectiveRecoveryConfirmations;
  }> = {},
): Promise<readonly ConfirmedRateObservation[]> {
  const resolved = await (dependencies.resolve ?? resolveEffectiveRecoveryConfirmations)(
    query,
    { admin: dependencies.admin },
  );
  if (resolved.status !== 'ok') {
    if (resolved.status === 'read_failed') {
      console.warn('[forgewingRecovery] confirmation resolve failed; proceeding unconfirmed', {
        sourceDocumentId: query.sourceDocumentId, reason: resolved.reason,
      });
    }
    return Object.freeze([]);
  }
  for (const diagnostic of resolved.diagnostics) {
    console.warn('[forgewingRecovery] confirmed recovery not applied', diagnostic);
  }
  return Object.freeze(resolved.confirmations.map((confirmation) => Object.freeze({
    observation_id: confirmation.confirmedObservationId as ConfirmedRateObservation['observation_id'],
    confirmed_raw_text: confirmation.confirmedRawText,
  })));
}

/**
 * The single entry point a processing pipeline uses once V2 exists.
 *
 * Same rules as `loadConfirmedRateObservations`, widened to carry candidate
 * confirmations alongside V1 observation confirmations. A resolver failure
 * still yields empty sets in both, so an unavailable review database leaves
 * reconstruction behaving exactly as it did before recovery existed.
 */
export async function loadConfirmedRecoverySelections(
  query: EffectiveRecoveryConfirmationQuery,
  dependencies: Readonly<{
    admin?: RecoveryReadClient | null;
    resolve?: typeof resolveEffectiveRecoveryConfirmations;
  }> = {},
): Promise<Readonly<{
  confirmedRateObservations: readonly ConfirmedRateObservation[];
  confirmedRecoveryCandidates: readonly RecoveryCandidateV2[];
}>> {
  const resolved = await (dependencies.resolve ?? resolveEffectiveRecoveryConfirmations)(
    query, { admin: dependencies.admin },
  );
  if (resolved.status !== 'ok') {
    if (resolved.status === 'read_failed') {
      console.warn('[forgewingRecovery] confirmation resolve failed; proceeding unconfirmed', {
        sourceDocumentId: query.sourceDocumentId, reason: resolved.reason,
      });
    }
    return { confirmedRateObservations: Object.freeze([]), confirmedRecoveryCandidates: Object.freeze([]) };
  }
  // A fail-closed resolution is only useful if an operator can see it. This is
  // the V2 path's only reporting seam; without it an ambiguous authority would
  // withhold a row in silence.
  for (const diagnostic of resolved.diagnostics) {
    console.warn('[forgewingRecovery] confirmed recovery not applied', diagnostic);
  }
  return {
    confirmedRateObservations: Object.freeze(resolved.confirmations
      .filter((confirmation): confirmation is ConfirmedRecovery => !('confirmedCandidate' in confirmation))
      .map((confirmation) => Object.freeze({
        observation_id: confirmation.confirmedObservationId as ConfirmedRateObservation['observation_id'],
        confirmed_raw_text: confirmation.confirmedRawText,
      }))),
    confirmedRecoveryCandidates: Object.freeze(
      (resolved.candidateConfirmations ?? []).map((confirmation) => confirmation.confirmedCandidate)),
  };
}

export function hasConfirmedRecoverySelections(
  selections: Readonly<{
    confirmedRateObservations: readonly unknown[];
    confirmedRecoveryCandidates: readonly unknown[];
  }> | null | undefined,
): boolean {
  return Boolean(selections
    && (selections.confirmedRateObservations.length > 0
      || selections.confirmedRecoveryCandidates.length > 0));
}
