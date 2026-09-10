import {
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
  type RecoveryReadClient,
} from '@/lib/server/effectiveRecoveryConfirmations';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/**
 * Read seam for the operator recovery review surface.
 *
 * Strictly read-only, and deliberately narrow: it returns what a reviewer needs
 * to decide -- the source page, why the row was withheld, the observations they
 * may choose between, and what Forgewing suggested -- and nothing else.
 *
 * Review state is derived from the rows, never stored. `reviewState` describes
 * where a proposal stands, and it is careful to distinguish "a human accepted
 * this" from "the recovery is in the data": only reprocessing can do the
 * second, so an accepted proposal reads as awaiting reprocess until an
 * extraction has actually consumed it.
 */

export type RecoveryReviewState =
  | 'pending_review'
  | 'accepted_awaiting_reprocess'
  | 'rejected'
  | 'deferred'
  /** Two approving reviews. Authority is ambiguous, so nothing is applied. */
  | 'ambiguous_authority';

export type RecoveryReviewCandidateObservation = Readonly<{
  observationId: string;
  rawText: string;
  sourceLayer: 'pdf_native_text' | 'ocr';
  boundingBox: Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;
  /** True for the observation Forgewing selected. */
  proposed: boolean;
}>;

export type RecoveryReviewCandidateSelection = Readonly<{
  candidateId: string;
  recoveryType: 'pricing_rate_multi_observation_cluster' | 'priced_schedule_continuation_attribution';
  targetRowIdentity: string;
  composedRawText: string;
  observations: readonly RecoveryReviewCandidateObservation[];
  proposed: boolean;
}>;

export type RecoveryReviewCandidate = Readonly<{
  proposalId: string;
  proposalDigestSha256: string;
  proposalVersion: 1 | 2;
  recoveryType: 'pricing_rate_single_observation'
    | 'pricing_rate_multi_observation_cluster'
    | 'priced_schedule_continuation_attribution';
  physicalPageNumber: number;
  /** The deterministic reason the row was never emitted. */
  recoveryReason: string;
  proposedValue: string;
  reasonCategory: string;
  certainty: number;
  /** Only eligible monetary observations; a reviewer may select any of them. */
  selectableObservations: readonly RecoveryReviewCandidateObservation[];
  selectableCandidates: readonly RecoveryReviewCandidateSelection[];
  /** Every cited observation, including context tokens, for display. */
  evidence: readonly RecoveryReviewCandidateObservation[];
  reviewState: RecoveryReviewState;
  latestReview: Readonly<{
    reviewId: string;
    reviewVersion: number;
    disposition: string;
    confirmedObservationId: string | null;
    confirmedCandidateId: string | null;
    createdAt: string;
  }> | null;
  createdAt: string;
}>;

export type RecoveryReviewQueueResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>
  | Readonly<{ status: 'ok'; candidates: readonly RecoveryReviewCandidate[] }>;

type SelectResult = { data: unknown; error: { message?: string } | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function observations(
  evidence: unknown,
  selectedObservationId: string,
  eligibleOnly: boolean,
): RecoveryReviewCandidateObservation[] {
  return (Array.isArray(evidence) ? evidence : [])
    .filter(isRecord)
    .flatMap((entry) => {
      const observationId = entry.observationId;
      const rawText = entry.rawText;
      const box = entry.boundingBox;
      const eligible = entry.eligible === true;
      if (typeof observationId !== 'string' || typeof rawText !== 'string' || !isRecord(box)) return [];
      if (eligibleOnly && !eligible) return [];
      return [{
        observationId,
        rawText,
        sourceLayer: entry.sourceLayer === 'ocr' ? 'ocr' as const : 'pdf_native_text' as const,
        boundingBox: {
          xMin: Number(box.xMin), xMax: Number(box.xMax),
          yMin: Number(box.yMin), yMax: Number(box.yMax),
        },
        proposed: observationId === selectedObservationId,
      }];
    })
    .sort((left, right) => left.observationId.localeCompare(right.observationId, 'en-US'));
}

/**
 * Projects a candidate's members in the candidate's own authored order.
 *
 * `orderedObservationIds` is load-bearing, not incidental: it is what the
 * candidate id is a digest over, and it is the order the composed text was
 * built in. Re-sorting here -- alphabetically or otherwise -- would show a
 * reviewer "8.75 $" for a candidate whose authored text is "$ 8.75", so the
 * ordered ids drive the projection and the evidence array is only a lookup.
 *
 * A candidate whose ordered ids do not fully resolve against its own evidence
 * is dropped rather than rendered short. A reviewer confirms a candidate whole;
 * being shown part of one is being shown a different candidate.
 */
function candidateSelections(
  value: unknown,
  selectedCandidateId: string,
): RecoveryReviewCandidateSelection[] {
  return (Array.isArray(value) ? value : []).filter(isRecord).flatMap((candidate) => {
    const orderedObservationIds = candidate.orderedObservationIds;
    if (typeof candidate.candidateId !== 'string'
      || (candidate.recoveryType !== 'pricing_rate_multi_observation_cluster'
        && candidate.recoveryType !== 'priced_schedule_continuation_attribution')
      || typeof candidate.targetRowIdentity !== 'string'
      || typeof candidate.composedRawText !== 'string'
      || !Array.isArray(orderedObservationIds)
      || orderedObservationIds.length === 0) return [];

    const byId = new Map<string, RecoveryReviewCandidateObservation>();
    for (const entry of observations(candidate.evidence, '', false)) {
      byId.set(entry.observationId, entry);
    }
    const members = orderedObservationIds.flatMap((id) =>
      typeof id === 'string' && byId.has(id) ? [byId.get(id)!] : []);
    if (members.length !== orderedObservationIds.length) return [];

    return [{
      candidateId: candidate.candidateId,
      recoveryType: candidate.recoveryType as RecoveryReviewCandidateSelection['recoveryType'],
      targetRowIdentity: candidate.targetRowIdentity,
      composedRawText: candidate.composedRawText,
      observations: members,
      proposed: candidate.candidateId === selectedCandidateId,
    }];
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId, 'en-US'));
}

export async function readRecoveryReviewQueue(
  query: Readonly<{ organizationId: string; sourceDocumentId: string }>,
  dependencies: Readonly<{ admin?: RecoveryReadClient | null }> = {},
): Promise<RecoveryReviewQueueResult> {
  const admin = dependencies.admin === undefined
    ? (getSupabaseAdmin() as unknown as RecoveryReadClient | null)
    : dependencies.admin;
  if (!admin) return { status: 'not_configured' };

  const proposalRead: SelectResult = await admin
    .from(RECOVERY_PROPOSAL_TABLE)
    .select('id, proposal_id, proposal_digest_sha256, proposal_version, recovery_type, physical_page_number, recovery_reason, selected_observation_id, selected_candidate_id, proposed_value, reason_category, certainty, evidence, recovery_candidates, created_at')
    .eq('organization_id', query.organizationId)
    .eq('source_document_id', query.sourceDocumentId);
  if (proposalRead.error) {
    return { status: 'read_failed', reason: proposalRead.error.message ?? 'proposal_read_failed' };
  }
  const proposals = (Array.isArray(proposalRead.data) ? proposalRead.data : []).filter(isRecord);
  if (proposals.length === 0) return { status: 'ok', candidates: [] };

  const reviewRead: SelectResult = await admin
    .from(RECOVERY_REVIEW_TABLE)
    .select('id, proposal_row_id, review_version, disposition, confirmed_observation_id, confirmed_candidate_id, created_at')
    .eq('organization_id', query.organizationId)
    .in('proposal_row_id', proposals.map((row) => row.id));
  if (reviewRead.error) {
    return { status: 'read_failed', reason: reviewRead.error.message ?? 'review_read_failed' };
  }
  const reviewsByProposal = new Map<string, Record<string, unknown>[]>();
  for (const row of (Array.isArray(reviewRead.data) ? reviewRead.data : []).filter(isRecord)) {
    const key = row.proposal_row_id;
    if (typeof key !== 'string') continue;
    reviewsByProposal.set(key, [...(reviewsByProposal.get(key) ?? []), row]);
  }

  const candidates = proposals.flatMap((row): RecoveryReviewCandidate[] => {
    const proposalId = row.proposal_id;
    const digest = row.proposal_digest_sha256;
    const selectedObservationId = row.selected_observation_id;
    const selectedCandidateId = row.selected_candidate_id;
    const proposalVersion = row.proposal_version === 2 ? 2 as const : 1 as const;
    if (typeof row.id !== 'string' || typeof proposalId !== 'string'
      || typeof digest !== 'string'
      || (proposalVersion === 1 && typeof selectedObservationId !== 'string')
      || (proposalVersion === 2 && typeof selectedCandidateId !== 'string')) return [];

    const reviews = [...(reviewsByProposal.get(row.id) ?? [])]
      .sort((left, right) => Number(left.review_version) - Number(right.review_version));
    const approving = reviews.filter((entry) =>
      entry.disposition === 'accepted' || entry.disposition === 'modified');
    // Newest is shown for navigation; it is never what grants authority. The
    // confirmation resolver reads the rows itself and refuses ambiguity.
    const latest = reviews.at(-1) ?? null;
    const reviewState: RecoveryReviewState = approving.length > 1
      ? 'ambiguous_authority'
      : approving.length === 1
        ? 'accepted_awaiting_reprocess'
        : latest?.disposition === 'rejected'
          ? 'rejected'
          : latest?.disposition === 'deferred'
            ? 'deferred'
            : 'pending_review';

    // Resolved once. Two continuation candidates for the same withheld line
    // cite that line's own tokens, so the union is deduplicated by observation
    // identity: evidence is what the reviewer is shown, and showing one token
    // twice misrepresents how much source backs the decision.
    const selectableCandidates = proposalVersion === 2
      ? candidateSelections(row.recovery_candidates, selectedCandidateId as string)
      : [];
    const candidateEvidence = [...new Map(selectableCandidates
      .flatMap((candidate) => candidate.observations)
      .map((entry) => [entry.observationId, entry])).values()];

    return [{
      proposalId,
      proposalDigestSha256: digest,
      proposalVersion,
      recoveryType: proposalVersion === 2
        && (row.recovery_type === 'pricing_rate_multi_observation_cluster'
          || row.recovery_type === 'priced_schedule_continuation_attribution')
        ? row.recovery_type
        : 'pricing_rate_single_observation',
      physicalPageNumber: Number(row.physical_page_number),
      recoveryReason: typeof row.recovery_reason === 'string' ? row.recovery_reason : 'unknown',
      proposedValue: typeof row.proposed_value === 'string' ? row.proposed_value : '',
      reasonCategory: typeof row.reason_category === 'string' ? row.reason_category : 'unknown',
      certainty: Number(row.certainty),
      selectableObservations: proposalVersion === 1
        ? observations(row.evidence, selectedObservationId as string, true) : [],
      selectableCandidates,
      evidence: proposalVersion === 1
        ? observations(row.evidence, selectedObservationId as string, false)
        : candidateEvidence,
      reviewState,
      latestReview: latest && typeof latest.id === 'string' ? {
        reviewId: latest.id,
        reviewVersion: Number(latest.review_version),
        disposition: String(latest.disposition),
        confirmedObservationId: typeof latest.confirmed_observation_id === 'string'
          ? latest.confirmed_observation_id
          : null,
        confirmedCandidateId: typeof latest.confirmed_candidate_id === 'string'
          ? latest.confirmed_candidate_id
          : null,
        createdAt: String(latest.created_at),
      } : null,
      createdAt: String(row.created_at),
    }];
  });

  candidates.sort((left, right) =>
    left.physicalPageNumber - right.physicalPageNumber
    || left.proposalId.localeCompare(right.proposalId, 'en-US'));
  return { status: 'ok', candidates };
}
