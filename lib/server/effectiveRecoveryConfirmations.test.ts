import { describe, expect, it, vi } from 'vitest';

import {
  loadConfirmedRecoverySelections,
  resolveEffectiveRecoveryConfirmations,
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
  type RecoveryReadClient,
} from '@/lib/server/effectiveRecoveryConfirmations';
import { buildRecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';

const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ART = '33333333-3333-4333-8333-333333333333';
const ACTOR = '44444444-4444-4444-8444-444444444444';
const query = { organizationId: ORG, sourceDocumentId: DOC, sourceArtifactId: ART };

function proposalRow(index: number, page = 3) {
  return {
    id: `${index}${index}${index}${index}${index}${index}${index}${index}-1111-4111-8111-111111111111`,
    proposal_id: `forgewing-proposal-pricing-rate-cluster-${String(index).repeat(32)}`,
    proposal_digest_sha256: String(index).repeat(64),
    physical_page_number: page,
    page_representation_digest: 'e'.repeat(64),
  };
}

function reviewRow(proposal: ReturnType<typeof proposalRow>, overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    proposal_row_id: proposal.id,
    proposal_digest_sha256: proposal.proposal_digest_sha256,
    review_version: 1,
    reviewer_actor_id: ACTOR,
    disposition: 'accepted',
    confirmed_observation_id: 'pdf:layout-token:v1:aa',
    confirmed_raw_text: '$8.75',
    ...overrides,
  };
}

/** Minimal PostgREST-shaped stub: records the tables and filters it was asked for. */
function client(
  proposals: unknown[],
  reviews: unknown[],
  errors: Partial<Record<string, { message: string }>> = {},
): RecoveryReadClient & { calls: string[] } {
  const calls: string[] = [];
  const builder = (table: string) => {
    const result = {
      data: table === RECOVERY_PROPOSAL_TABLE ? proposals : reviews,
      error: errors[table] ?? null,
    };
    const self: Record<string, unknown> = {
      select: () => self,
      eq: (column: string) => { calls.push(`${table}.${column}`); return self; },
      in: (column: string) => { calls.push(`${table}.${column}`); return self; },
      then: (onfulfilled: (value: unknown) => unknown) => Promise.resolve(onfulfilled(result)),
    };
    return self;
  };
  return { from: (table: string) => builder(table) as never, calls } as never;
}

describe('effective recovery confirmation resolver', () => {
  it('resolves one accepted review into an exact-pinned confirmation', async () => {
    const proposal = proposalRow(1);
    const result = await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([proposal], [reviewRow(proposal)]),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0]).toMatchObject({
      confirmedObservationId: 'pdf:layout-token:v1:aa',
      confirmedRawText: '$8.75',
      proposalDigestSha256: proposal.proposal_digest_sha256,
      reviewVersion: 1,
      reviewDisposition: 'accepted',
      authority: 'human_confirmed',
      executable: false,
      purpose: 'reconstruction_reentry',
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('resolves a modified review the same way', async () => {
    const proposal = proposalRow(1);
    const result = await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([proposal], [reviewRow(proposal, {
        disposition: 'modified',
        confirmed_observation_id: 'pdf:layout-token:v1:bb',
        confirmed_raw_text: '$52.50',
      })]),
    });
    expect(result.status === 'ok' && result.confirmations[0]).toMatchObject({
      reviewDisposition: 'modified', confirmedObservationId: 'pdf:layout-token:v1:bb',
    });
  });

  it('yields nothing for rejected and deferred reviews', async () => {
    const proposal = proposalRow(1);
    for (const disposition of ['rejected', 'deferred']) {
      const result = await resolveEffectiveRecoveryConfirmations(query, {
        admin: client([proposal], [reviewRow(proposal, {
          disposition, confirmed_observation_id: null, confirmed_raw_text: null,
        })]),
      });
      expect(result.status === 'ok' && result.confirmations).toEqual([]);
      // A reviewer saying no is the system working, not a diagnostic.
      expect(result.status === 'ok' && result.diagnostics).toEqual([]);
    }
  });

  it('yields nothing for an unreviewed proposal', async () => {
    const result = await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([proposalRow(1)], []),
    });
    expect(result.status === 'ok' && result.confirmations).toEqual([]);
    expect(result.status === 'ok' && result.diagnostics).toEqual([]);
  });

  it('refuses to pick the latest when two approving reviews disagree', async () => {
    const proposal = proposalRow(1);
    const result = await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([proposal], [
        reviewRow(proposal),
        reviewRow(proposal, {
          id: '77777777-7777-4777-8777-777777777777', review_version: 2,
          disposition: 'modified', confirmed_observation_id: 'pdf:layout-token:v1:bb',
          confirmed_raw_text: '$52.50',
        }),
      ]),
    });
    expect(result.status === 'ok' && result.confirmations).toEqual([]);
    expect(result.status === 'ok' && result.diagnostics[0]).toMatchObject({
      code: 'ambiguous_recovery_authority', recoveryApplied: false,
    });
  });

  it('fails closed when an approving review carries no confirmation', async () => {
    const proposal = proposalRow(1);
    const result = await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([proposal], [reviewRow(proposal, {
        confirmed_observation_id: null, confirmed_raw_text: null,
      })]),
    });
    expect(result.status === 'ok' && result.confirmations).toEqual([]);
    expect(result.status === 'ok' && result.diagnostics[0]?.code)
      .toBe('incoherent_recovery_confirmation');
  });

  it('fails closed when a review pins a different proposal digest', async () => {
    const proposal = proposalRow(1);
    const result = await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([proposal], [reviewRow(proposal, { proposal_digest_sha256: '9'.repeat(64) })]),
    });
    expect(result.status === 'ok' && result.confirmations).toEqual([]);
    expect(result.status === 'ok' && result.diagnostics[0]?.code)
      .toBe('incoherent_recovery_confirmation');
  });

  it('scopes every read to the exact organization, document and artifact', async () => {
    const proposal = proposalRow(1);
    const admin = client([proposal], [reviewRow(proposal)]);
    await resolveEffectiveRecoveryConfirmations(query, { admin });
    expect(admin.calls).toEqual([
      `${RECOVERY_PROPOSAL_TABLE}.organization_id`,
      `${RECOVERY_PROPOSAL_TABLE}.source_document_id`,
      `${RECOVERY_PROPOSAL_TABLE}.source_artifact_id`,
      `${RECOVERY_REVIEW_TABLE}.organization_id`,
      `${RECOVERY_REVIEW_TABLE}.proposal_row_id`,
    ]);
  });

  it('orders confirmations independently of row order', async () => {
    const first = proposalRow(1);
    const second = proposalRow(2);
    const rows = [
      reviewRow(second, { id: '88888888-8888-4888-8888-888888888888',
        confirmed_observation_id: 'pdf:layout-token:v1:bb', confirmed_raw_text: '$52.50' }),
      reviewRow(first),
    ];
    const forward = await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([first, second], rows),
    });
    const reversed = await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([second, first], [...rows].reverse()),
    });
    expect(forward).toEqual(reversed);
    expect(forward.status === 'ok' && forward.confirmations.map((c) => c.confirmedObservationId))
      .toEqual(['pdf:layout-token:v1:aa', 'pdf:layout-token:v1:bb']);
  });

  it('reports read failures rather than returning a partial confirmation set', async () => {
    const proposal = proposalRow(1);
    await expect(resolveEffectiveRecoveryConfirmations(query, {
      admin: client([proposal], [reviewRow(proposal)], {
        [RECOVERY_REVIEW_TABLE]: { message: 'denied' },
      }),
    })).resolves.toEqual({ status: 'read_failed', reason: 'denied' });
  });

  it('reports not_configured rather than silently confirming nothing', async () => {
    await expect(resolveEffectiveRecoveryConfirmations(query, { admin: null }))
      .resolves.toEqual({ status: 'not_configured' });
  });

  it('makes no provider call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const proposal = proposalRow(1);
    await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([proposal], [reviewRow(proposal)]),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('resolves one exact V2 candidate while preserving the V1 confirmation channel', async () => {
    const candidate = buildRecoveryCandidateV2({
      recoveryType: 'priced_schedule_continuation_attribution',
      sourceDocumentId: DOC, sourceArtifactId: ART, physicalPageNumber: 3,
      pageRepresentationDigest: 'e'.repeat(64), targetRowIdentity: 'page_priced_schedule:p3:r1',
      orderedObservationIds: ['obs:fragment'], rawTexts: ['Disposal'],
      composedRawText: 'Inert Debris Removal and Disposal',
      evidence: [{ observationId: 'obs:fragment', sourceLayer: 'pdf_native_text',
        rawText: 'Disposal', boundingBox: { xMin: 1, xMax: 2, yMin: 3, yMax: 4 } }],
    })!;
    const proposal = {
      ...proposalRow(1),
      proposal_id: `forgewing-proposal-recovery-v2-${'1'.repeat(64)}`,
      proposal_version: 2,
      recovery_type: 'priced_schedule_continuation_attribution',
      recovery_candidates: [candidate],
    };
    const result = await resolveEffectiveRecoveryConfirmations(query, {
      admin: client([proposal], [reviewRow(proposal, {
        confirmed_observation_id: null,
        confirmed_candidate_id: candidate.candidateId,
        confirmed_raw_text: candidate.composedRawText,
      })]),
    });
    expect(result.status === 'ok' && result.confirmations).toEqual([]);
    expect(result.status === 'ok' && result.candidateConfirmations?.[0]?.confirmedCandidate)
      .toEqual(candidate);
  });

  it('carries the reviewed page digest to reconstruction, and a legacy null digest as null', async () => {
    const reviewed = proposalRow(1);
    const legacyBase = proposalRow(2);
    const legacy = { ...legacyBase, page_representation_digest: null };
    const selections = await loadConfirmedRecoverySelections(query, {
      admin: client([reviewed, legacy], [
        reviewRow(reviewed),
        { ...reviewRow(legacyBase), id: '66666666-6666-4666-8666-666666666666',
          confirmed_observation_id: 'pdf:layout-token:v1:bb', confirmed_raw_text: '$52.50' },
      ]),
    });
    expect(selections.confirmedRateObservations).toEqual([
      { observation_id: 'pdf:layout-token:v1:aa', confirmed_raw_text: '$8.75',
        page_representation_digest: 'e'.repeat(64) },
      { observation_id: 'pdf:layout-token:v1:bb', confirmed_raw_text: '$52.50',
        page_representation_digest: null },
    ]);
  });
});
