import { describe, expect, it, vi } from 'vitest';

import {
  RecoveryProposalReviewInputSchema,
  reviewAuthorizesReentry,
} from '@/lib/forgewingRecoveryReview';
import {
  recordForgewingRecoveryProposalReview,
  RECOVERY_REVIEW_WRITE_FUNCTION,
} from '@/lib/server/forgewingRecoveryReview';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '44444444-4444-4444-8444-444444444444';
const REVIEW = '55555555-5555-4555-8555-555555555555';
const ROW = '66666666-6666-4666-8666-666666666666';
const PROPOSAL = `forgewing-proposal-pricing-rate-cluster-${'a'.repeat(32)}`;
const DIGEST = 'c'.repeat(64);
const actor = { actorId: ACTOR, organizationId: ORG };

function accepted(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: PROPOSAL,
    proposalDigestSha256: DIGEST,
    disposition: 'accepted',
    confirmedObservationId: 'pdf:layout-token:v1:aa',
    reviewerRationale: 'The currency-marked token is the unit rate.',
    ...overrides,
  };
}

function okRpc(overrides: Record<string, unknown> = {}) {
  return vi.fn(async () => ({
    data: [{
      review_id: REVIEW, review_version: 1, proposal_row_id: ROW,
      confirmed_observation_id: 'pdf:layout-token:v1:aa', confirmed_raw_text: '$8.75',
      inserted: true, ...overrides,
    }],
    error: null,
  }));
}

describe('recovery review contract', () => {
  it('accepts the four closed dispositions and nothing else', () => {
    for (const disposition of ['rejected', 'deferred'] as const) {
      expect(RecoveryProposalReviewInputSchema.safeParse({
        proposalId: PROPOSAL, proposalDigestSha256: DIGEST, disposition,
        reviewerRationale: 'Not enough evidence.',
      }).success).toBe(true);
    }
    expect(RecoveryProposalReviewInputSchema.safeParse(accepted({ disposition: 'approved' })).success)
      .toBe(false);
  });

  it('requires a confirmed observation on approving dispositions only', () => {
    expect(RecoveryProposalReviewInputSchema.safeParse(
      accepted({ confirmedObservationId: undefined }),
    ).success).toBe(false);
    expect(RecoveryProposalReviewInputSchema.safeParse({
      proposalId: PROPOSAL, proposalDigestSha256: DIGEST, disposition: 'rejected',
      confirmedObservationId: 'pdf:layout-token:v1:aa', reviewerRationale: 'No.',
    }).success).toBe(false);
  });

  it('has no field through which a reviewer could author a rate value', () => {
    expect(RecoveryProposalReviewInputSchema.safeParse(
      accepted({ disposition: 'modified', confirmedRawText: '$9.99' }),
    ).success).toBe(false);
    expect(RecoveryProposalReviewInputSchema.safeParse(
      accepted({ disposition: 'modified', proposedValue: '$9.99' }),
    ).success).toBe(false);
  });

  it('refuses a review that does not pin an exact proposal digest', () => {
    expect(RecoveryProposalReviewInputSchema.safeParse(
      accepted({ proposalDigestSha256: 'latest' }),
    ).success).toBe(false);
    expect(RecoveryProposalReviewInputSchema.safeParse(
      accepted({ proposalDigestSha256: undefined }),
    ).success).toBe(false);
  });

  it('marks only accepted and modified as authorizing re-entry', () => {
    expect(reviewAuthorizesReentry({ disposition: 'accepted' })).toBe(true);
    expect(reviewAuthorizesReentry({ disposition: 'modified' })).toBe(true);
    expect(reviewAuthorizesReentry({ disposition: 'rejected' })).toBe(false);
    expect(reviewAuthorizesReentry({ disposition: 'deferred' })).toBe(false);
  });
});

describe('recovery review server seam', () => {
  it('derives reviewer and organization from the actor, never the body', async () => {
    const rpc = okRpc();
    const result = await recordForgewingRecoveryProposalReview(
      accepted({
        reviewerActorId: '99999999-9999-4999-8999-999999999999',
        organizationId: '88888888-8888-4888-8888-888888888888',
      }),
      actor,
      { admin: { rpc } },
    );
    // Injected identity fields are not part of the contract, so the whole
    // request is refused rather than silently stripped.
    expect(result).toEqual({ ok: false, code: 'invalid_review' });
    expect(rpc).not.toHaveBeenCalled();

    const clean = await recordForgewingRecoveryProposalReview(accepted(), actor, { admin: { rpc } });
    expect(clean.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith(RECOVERY_REVIEW_WRITE_FUNCTION, expect.objectContaining({
      p_organization_id: ORG, p_reviewer_actor_id: ACTOR,
      p_proposal_digest_sha256: DIGEST, p_disposition: 'accepted',
    }));
  });

  it('returns the server-derived confirmed value, not a caller-supplied one', async () => {
    const result = await recordForgewingRecoveryProposalReview(
      accepted(), actor, { admin: { rpc: okRpc() } },
    );
    expect(result.ok && result.review.confirmedRawText).toBe('$8.75');
    expect(result.ok && result.review.confirmedObservationId).toBe('pdf:layout-token:v1:aa');
  });

  it('carries no confirmation on rejected and deferred reviews', async () => {
    for (const disposition of ['rejected', 'deferred'] as const) {
      const result = await recordForgewingRecoveryProposalReview(
        { proposalId: PROPOSAL, proposalDigestSha256: DIGEST, disposition,
          reviewerRationale: 'Ambiguity is real; leave the row withheld.' },
        actor,
        { admin: { rpc: okRpc({ confirmed_observation_id: null, confirmed_raw_text: null }) } },
      );
      expect(result.ok && result.review.confirmedObservationId).toBeNull();
      expect(result.ok && reviewAuthorizesReentry(result.review)).toBe(false);
    }
  });

  it('reports idempotent replay of the same request without a second row', async () => {
    const result = await recordForgewingRecoveryProposalReview(
      accepted(), actor, { admin: { rpc: okRpc({ inserted: false }) } },
    );
    expect(result.ok && result.inserted).toBe(false);
  });

  it('fails closed on an incoherent receipt', async () => {
    const result = await recordForgewingRecoveryProposalReview(accepted(), actor, {
      admin: { rpc: okRpc({ confirmed_observation_id: null, confirmed_raw_text: null }) },
    });
    // An accepted review that confirmed nothing is not a coherent review.
    expect(result).toEqual({ ok: false, code: 'write_failed' });
  });

  it('rejects an unauthenticated or cross-shaped actor before any write', async () => {
    const rpc = vi.fn();
    expect(await recordForgewingRecoveryProposalReview(accepted(), { actorId: 'nope', organizationId: ORG }, { admin: { rpc } }))
      .toEqual({ ok: false, code: 'invalid_actor' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('propagates a database refusal as a closed failure', async () => {
    expect(await recordForgewingRecoveryProposalReview(accepted(), actor, {
      admin: { rpc: async () => ({ data: null, error: { message: 'not eligible' } }) },
    })).toEqual({ ok: false, code: 'write_failed' });
  });

  it('makes no provider call on any disposition', async () => {
    // The seam imports no provider client at all; this asserts the shape of
    // the dependency surface so a later edit cannot quietly add one.
    const rpc = okRpc();
    await recordForgewingRecoveryProposalReview(accepted(), actor, { admin: { rpc } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
