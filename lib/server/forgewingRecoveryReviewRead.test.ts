import { describe, expect, it } from 'vitest';

import type { RecoveryReadClient } from '@/lib/server/effectiveRecoveryConfirmations';
import { readRecoveryReviewQueue } from '@/lib/server/forgewingRecoveryReviewRead';

const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ROW = '66666666-6666-4666-8666-666666666666';
const query = { organizationId: ORG, sourceDocumentId: DOC };

const proposal = {
  id: ROW,
  proposal_id: `forgewing-proposal-pricing-rate-cluster-${'a'.repeat(32)}`,
  proposal_digest_sha256: 'c'.repeat(64),
  physical_page_number: 3,
  recovery_reason: 'ambiguous_rate_clusters',
  selected_observation_id: 'obs:unit',
  proposed_value: '$8.75',
  reason_category: 'explicit_currency_marker',
  certainty: 0.82,
  evidence: [
    { observationId: 'obs:unit', rawText: '$8.75', sourceLayer: 'pdf_native_text',
      boundingBox: { xMin: 1, xMax: 2, yMin: 3, yMax: 4 }, eligible: true },
    { observationId: 'obs:extended', rawText: '$52.50', sourceLayer: 'pdf_native_text',
      boundingBox: { xMin: 5, xMax: 6, yMin: 3, yMax: 4 }, eligible: true },
    { observationId: 'obs:description', rawText: 'Gamma service', sourceLayer: 'pdf_native_text',
      boundingBox: { xMin: 0, xMax: 1, yMin: 3, yMax: 4 }, eligible: false },
  ],
  created_at: '2026-09-09T00:00:00.000Z',
};

const v2CandidateId = `recovery-candidate-v2-${'d'.repeat(64)}`;
const v2Proposal = {
  ...proposal,
  id: '88888888-8888-4888-8888-888888888888',
  proposal_id: `forgewing-proposal-recovery-v2-${'e'.repeat(64)}`,
  proposal_version: 2,
  recovery_type: 'pricing_rate_multi_observation_cluster',
  selected_observation_id: null,
  selected_candidate_id: v2CandidateId,
  // The persisted shape, as record_forgewing_recovery_proposal_v2 stores it:
  // orderedObservationIds / rawTexts / evidence are one ordered membership
  // expressed three ways, and "$" precedes "8.75" because that is the order the
  // composed text was built in -- not alphabetical order of the ids.
  recovery_candidates: [{
    candidateId: v2CandidateId,
    recoveryType: 'pricing_rate_multi_observation_cluster',
    targetRowIdentity: 'row:unit-rate',
    composedRawText: '$ 8.75',
    orderedObservationIds: ['obs:dollar', 'obs:amount'],
    rawTexts: ['$', '8.75'],
    evidence: [
      { observationId: 'obs:dollar', rawText: '$', sourceLayer: 'pdf_native_text',
        boundingBox: { xMin: 1, xMax: 2, yMin: 3, yMax: 4 } },
      { observationId: 'obs:amount', rawText: '8.75', sourceLayer: 'pdf_native_text',
        boundingBox: { xMin: 2, xMax: 3, yMin: 3, yMax: 4 } },
    ],
  }],
};

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    proposal_row_id: ROW,
    review_version: 1,
    disposition: 'accepted',
    confirmed_observation_id: 'obs:unit',
    created_at: '2026-09-09T01:00:00.000Z',
    ...overrides,
  };
}

function client(proposals: unknown[], reviews: unknown[]): RecoveryReadClient {
  const builder = (table: string) => {
    const result = {
      data: table === 'forgewing_recovery_proposals' ? proposals : reviews,
      error: null,
    };
    const self: Record<string, unknown> = {
      select: () => self, eq: () => self, in: () => self,
      then: (onfulfilled: (value: unknown) => unknown) => Promise.resolve(onfulfilled(result)),
    };
    return self;
  };
  return { from: (table: string) => builder(table) as never } as never;
}

describe('recovery review queue read', () => {
  it('offers only eligible monetary observations as selectable', async () => {
    const result = await readRecoveryReviewQueue(query, { admin: client([proposal], []) });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const candidate = result.candidates[0]!;
    expect(candidate.selectableObservations.map((entry) => entry.observationId))
      .toEqual(['obs:extended', 'obs:unit']);
    // The description token is shown as evidence but can never be selected.
    expect(candidate.evidence).toHaveLength(3);
    expect(candidate.selectableObservations.find((entry) => entry.proposed)?.observationId)
      .toBe('obs:unit');
  });

  it('reads pending review when nothing has been decided', async () => {
    const result = await readRecoveryReviewQueue(query, { admin: client([proposal], []) });
    expect(result.status === 'ok' && result.candidates[0]!.reviewState).toBe('pending_review');
  });

  it('returns each V2 candidate as one whole selectable recovery', async () => {
    const result = await readRecoveryReviewQueue(query, { admin: client([v2Proposal], []) });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.candidates[0]).toMatchObject({
      proposalVersion: 2,
      recoveryType: 'pricing_rate_multi_observation_cluster',
      selectableObservations: [],
    });
    expect(result.candidates[0]!.selectableCandidates).toEqual([
      expect.objectContaining({
        candidateId: v2CandidateId,
        composedRawText: '$ 8.75',
        proposed: true,
        observations: [
          expect.objectContaining({ observationId: 'obs:dollar', rawText: '$' }),
          expect.objectContaining({ observationId: 'obs:amount', rawText: '8.75' }),
        ],
      }),
    ]);
  });

  it('distinguishes an accepted review from an applied recovery', async () => {
    const result = await readRecoveryReviewQueue(query, { admin: client([proposal], [review()]) });
    // Never "applied": only a reprocess can put the value in the data.
    expect(result.status === 'ok' && result.candidates[0]!.reviewState)
      .toBe('accepted_awaiting_reprocess');
  });

  it('reports rejected and deferred without a confirmation', async () => {
    for (const disposition of ['rejected', 'deferred'] as const) {
      const result = await readRecoveryReviewQueue(query, {
        admin: client([proposal], [review({ disposition, confirmed_observation_id: null })]),
      });
      expect(result.status === 'ok' && result.candidates[0]!.reviewState).toBe(disposition);
      expect(result.status === 'ok' && result.candidates[0]!.latestReview!.confirmedObservationId)
        .toBeNull();
    }
  });

  it('surfaces ambiguous authority rather than showing the newest as authoritative', async () => {
    const result = await readRecoveryReviewQueue(query, {
      admin: client([proposal], [
        review(),
        review({ id: '77777777-7777-4777-8777-777777777777', review_version: 2, disposition: 'modified',
          confirmed_observation_id: 'obs:extended' }),
      ]),
    });
    expect(result.status === 'ok' && result.candidates[0]!.reviewState).toBe('ambiguous_authority');
    // The newest is still shown, for navigation only.
    expect(result.status === 'ok' && result.candidates[0]!.latestReview!.reviewVersion).toBe(2);
  });

  it('returns nothing for a document with no proposals', async () => {
    const result = await readRecoveryReviewQueue(query, { admin: client([], []) });
    expect(result).toEqual({ status: 'ok', candidates: [] });
  });

  it('reports not_configured rather than an empty queue', async () => {
    await expect(readRecoveryReviewQueue(query, { admin: null }))
      .resolves.toEqual({ status: 'not_configured' });
  });
});
