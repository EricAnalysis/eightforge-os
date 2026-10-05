import {
  CONTRACT_RATE_ROW_FACT_KEY,
  type HumanFactAssertionRow,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import type {
  ValueReadingProposalRecord,
  ValueReadingReviewRecord,
} from '@/lib/server/valueReadingProposals';

/**
 * Value-reading lifecycle and operator telemetry (Forgewing B4.2), derived
 * only from durable records: the immutable proposals, their rejected/deferred
 * reviews, the human fact assertions that cite them, and the current page
 * representation digests. Nothing here is stored, and nothing here comes from
 * a frontend event. Pure and deterministic for any input order.
 */

export type ValueReadingState = 'pending' | 'used' | 'used_edited' | 'rejected' | 'deferred' | 'stale';

export type ValueReadingLifecycle = Readonly<{
  proposalId: string;
  state: ValueReadingState;
  /** True only for a current, unreviewed, unused reading of a value: what may be offered. */
  offerable: boolean;
  /** The latest active assertion that cited this proposal, when used. */
  usedByAssertionId: string | null;
  latestReviewId: string | null;
}>;

/** documentId -> physical page -> current page representation digest. */
export type CurrentPageDigests = ReadonlyMap<string, ReadonlyMap<number, string>>;

const AI_ORIGINS = new Set(['ai_proposed_operator_approved', 'ai_proposed_operator_modified']);

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function byTimeThenId<T>(at: (entry: T) => string, id: (entry: T) => string) {
  return (left: T, right: T) => time(at(left)) - time(at(right)) || id(left).localeCompare(id(right), 'en-US');
}

function activeCitations(assertions: readonly HumanFactAssertionRow[], proposal: ValueReadingProposalRecord) {
  return assertions
    .filter((row) => row.forgewing_proposal_id === proposal.proposalId
      && row.organization_id === proposal.binding.organizationId
      && row.status === 'active' && row.review_origin != null && AI_ORIGINS.has(row.review_origin))
    .sort(byTimeThenId((row) => row.asserted_at, (row) => row.id));
}

/**
 * State precedence: used / used_edited (an operator assertion cited it) >
 * rejected > stale (the page it read is no longer the current representation)
 * > deferred > pending.
 */
export function deriveValueReadingLifecycle(params: Readonly<{
  proposals: readonly ValueReadingProposalRecord[];
  reviews: readonly ValueReadingReviewRecord[];
  assertions: readonly HumanFactAssertionRow[];
  currentPageDigests: CurrentPageDigests;
}>): ValueReadingLifecycle[] {
  return [...params.proposals]
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId, 'en-US'))
    .map((proposal) => {
      const citations = activeCitations(params.assertions, proposal);
      const used = citations.at(-1) ?? null;
      const latestReview = params.reviews
        .filter((review) => review.proposalRowId === proposal.rowId)
        .sort((left, right) => left.reviewVersion - right.reviewVersion)
        .at(-1) ?? null;
      const current = params.currentPageDigests.get(proposal.binding.sourceDocumentId)
        ?.get(proposal.binding.physicalPageNumber) ?? null;
      const stale = current !== proposal.binding.pageRepresentationDigest;
      const state: ValueReadingState = used
        ? (used.review_origin === 'ai_proposed_operator_approved' ? 'used' : 'used_edited')
        : latestReview?.disposition === 'rejected' ? 'rejected'
          : stale ? 'stale'
            : latestReview?.disposition === 'deferred' ? 'deferred'
              : 'pending';
      return {
        proposalId: proposal.proposalId,
        state,
        offerable: state === 'pending' && proposal.reading.kind === 'value',
        usedByAssertionId: used?.id ?? null,
        latestReviewId: latestReview?.id ?? null,
      };
    });
}

export type ValueReadingTelemetryOutcome =
  | 'forgewing_used_unchanged'
  | 'forgewing_used_then_edited'
  | 'forgewing_rejected'
  | 'suggestion_ignored'
  | 'operator_entered_without_suggestion';

export type ValueReadingTelemetryEvent = Readonly<{
  outcome: ValueReadingTelemetryOutcome;
  documentId: string;
  anchorKey: string;
  at: string;
  assertionId: string | null;
  proposalId: string | null;
  reviewId: string | null;
}>;

/**
 * One event per durable record:
 * - an active reviewed rate row citing a proposal: used unchanged or edited,
 *   as the database derived it;
 * - a rejection review: rejected;
 * - an active reviewed rate row entered without a proposal: suggestion
 *   ignored when a reading of a value for that exact anchor and page
 *   representation existed and was neither rejected, deferred nor already used at the
 *   time; otherwise entered without a suggestion.
 * Withdrawals and deferrals are not outcomes.
 */
export function deriveValueReadingTelemetry(params: Readonly<{
  proposals: readonly ValueReadingProposalRecord[];
  reviews: readonly ValueReadingReviewRecord[];
  assertions: readonly HumanFactAssertionRow[];
}>): ValueReadingTelemetryEvent[] {
  const proposalByRowId = new Map(params.proposals.map((proposal) => [proposal.rowId, proposal]));
  const proposalById = new Map(params.proposals.map((proposal) => [proposal.proposalId, proposal]));
  const events: ValueReadingTelemetryEvent[] = [];

  for (const review of params.reviews) {
    const proposal = proposalByRowId.get(review.proposalRowId);
    if (!proposal || review.disposition !== 'rejected') continue;
    events.push({
      outcome: 'forgewing_rejected', documentId: proposal.binding.sourceDocumentId,
      anchorKey: proposal.binding.anchorKey, at: review.createdAt,
      assertionId: null, proposalId: proposal.proposalId, reviewId: review.id,
    });
  }

  for (const row of params.assertions) {
    if (row.source_binding !== 'region_bound' || row.status !== 'active'
      || row.fact_key !== CONTRACT_RATE_ROW_FACT_KEY || !row.source_document_id || !row.anchor_key) continue;
    const base = { documentId: row.source_document_id, anchorKey: row.anchor_key, at: row.asserted_at, assertionId: row.id };
    if (row.forgewing_proposal_id) {
      const proposal = proposalById.get(row.forgewing_proposal_id);
      if (!proposal || !row.review_origin || !AI_ORIGINS.has(row.review_origin)) continue;
      events.push({
        ...base,
        outcome: row.review_origin === 'ai_proposed_operator_approved'
          ? 'forgewing_used_unchanged' : 'forgewing_used_then_edited',
        proposalId: proposal.proposalId, reviewId: null,
      });
      continue;
    }
    if (row.review_origin !== 'operator_entered') continue;
    const assertedAt = time(row.asserted_at);
    const shown = params.proposals
      .filter((proposal) => proposal.reading.kind === 'value'
        && proposal.binding.organizationId === row.organization_id
        && proposal.binding.sourceDocumentId === row.source_document_id
        && proposal.binding.anchorKey === row.anchor_key
        && proposal.binding.pageRepresentationDigest === row.page_representation_digest
        && time(proposal.createdAt) <= assertedAt
        && !params.reviews.some((review) => review.proposalRowId === proposal.rowId
          && (review.disposition === 'rejected' || review.disposition === 'deferred') && time(review.createdAt) <= assertedAt)
        // A suggestion already used is no longer offered.
        && !activeCitations(params.assertions, proposal).some((cited) => time(cited.asserted_at) < assertedAt))
      .sort(byTimeThenId((proposal) => proposal.createdAt, (proposal) => proposal.proposalId));
    const suggestion = shown.at(-1) ?? null;
    events.push({
      ...base,
      outcome: suggestion ? 'suggestion_ignored' : 'operator_entered_without_suggestion',
      proposalId: suggestion?.proposalId ?? null, reviewId: null,
    });
  }

  return events.sort((left, right) => time(left.at) - time(right.at)
    || (left.assertionId ?? left.reviewId ?? '').localeCompare(right.assertionId ?? right.reviewId ?? '', 'en-US'));
}
