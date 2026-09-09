import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordReview = vi.hoisted(() => vi.fn());
const readQueue = vi.hoisted(() => vi.fn());
const actorContext = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/forgewingRecoveryReview', () => ({
  recordForgewingRecoveryProposalReview: recordReview,
}));
vi.mock('@/lib/server/forgewingRecoveryReviewRead', () => ({
  readRecoveryReviewQueue: readQueue,
}));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: actorContext }));

import { GET, POST } from '@/app/api/internal/forgewing-recovery-review/route';

const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const PROPOSAL = `forgewing-proposal-pricing-rate-cluster-${'a'.repeat(32)}`;
const DIGEST = 'c'.repeat(64);

const body = (overrides: Record<string, unknown> = {}) => ({
  proposalId: PROPOSAL,
  proposalDigestSha256: DIGEST,
  disposition: 'accepted',
  confirmedObservationId: 'obs:unit',
  reviewerRationale: 'The currency-marked token is the unit rate.',
  ...overrides,
});

function post(payload: unknown): Request {
  return new Request('http://localhost/api/internal/forgewing-recovery-review', {
    method: 'POST',
    headers: { authorization: 'Bearer operator-session-jwt', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function get(documentId = DOC): Request {
  return new Request(
    `http://localhost/api/internal/forgewing-recovery-review?documentId=${documentId}`,
    { headers: { authorization: 'Bearer operator-session-jwt' } },
  );
}

describe('recovery review route', () => {
  beforeEach(() => {
    recordReview.mockReset();
    readQueue.mockReset();
    actorContext.mockReset();
    actorContext.mockResolvedValue({
      ok: true,
      actor: { actorId: ACTOR, organizationId: ORG, role: 'admin', email: 'op@example.test' },
    });
    recordReview.mockResolvedValue({
      ok: true, inserted: true,
      review: {
        reviewId: '55555555-5555-4555-8555-555555555555', reviewVersion: 1,
        disposition: 'accepted', confirmedObservationId: 'obs:unit', confirmedRawText: '$8.75',
      },
    });
    readQueue.mockResolvedValue({ status: 'ok', candidates: [] });
  });

  it('refuses an unauthenticated caller before reading or writing anything', async () => {
    actorContext.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    expect((await POST(post(body()))).status).toBe(401);
    expect((await GET(get())).status).toBe(401);
    expect(recordReview).not.toHaveBeenCalled();
    expect(readQueue).not.toHaveBeenCalled();
  });

  it('derives reviewer and organization from the session, not the body', async () => {
    await POST(post(body()));
    expect(recordReview).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL, proposalDigestSha256: DIGEST }),
      { actorId: ACTOR, organizationId: ORG },
    );
  });

  it('rejects a body that tries to supply reviewer or organization identity', async () => {
    for (const injected of [
      { reviewerActorId: ACTOR }, { organizationId: OTHER_ORG }, { reviewerEmail: 'x@y.test' },
    ]) {
      const response = await POST(post(body(injected)));
      expect(response.status).toBe(400);
    }
    expect(recordReview).not.toHaveBeenCalled();
  });

  it('rejects a body that tries to author a rate value', async () => {
    for (const injected of [
      { confirmedRawText: '$9.99' }, { proposedValue: '$9.99' }, { normalizedValue: '9.99' },
    ]) {
      expect((await POST(post(body(injected)))).status).toBe(400);
    }
    expect(recordReview).not.toHaveBeenCalled();
  });

  it('rejects a review that does not pin an exact proposal digest', async () => {
    expect((await POST(post(body({ proposalDigestSha256: 'latest' })))).status).toBe(400);
    expect((await POST(post(body({ proposalDigestSha256: undefined })))).status).toBe(400);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it('says reprocessing is required rather than implying the value changed', async () => {
    const response = await POST(post(body()));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, reviewState: 'accepted_awaiting_reprocess', reprocessRequired: true,
    });
  });

  it('does not claim reprocessing is required for rejected or deferred', async () => {
    for (const disposition of ['rejected', 'deferred'] as const) {
      recordReview.mockResolvedValue({
        ok: true, inserted: true,
        review: {
          reviewId: '55555555-5555-4555-8555-555555555555', reviewVersion: 1,
          disposition, confirmedObservationId: null, confirmedRawText: null,
        },
      });
      const payload = await (await POST(post({
        proposalId: PROPOSAL, proposalDigestSha256: DIGEST, disposition,
        reviewerRationale: 'Ambiguity is real; leave the row withheld.',
      }))).json();
      expect(payload).toMatchObject({ reprocessRequired: false, reviewState: disposition });
    }
  });

  it('returns 200 rather than 201 on an idempotent replay', async () => {
    recordReview.mockResolvedValue({
      ok: true, inserted: false,
      review: {
        reviewId: '55555555-5555-4555-8555-555555555555', reviewVersion: 1,
        disposition: 'accepted', confirmedObservationId: 'obs:unit', confirmedRawText: '$8.75',
      },
    });
    expect((await POST(post(body()))).status).toBe(200);
  });

  it('maps a refused write to 422 without leaking the database reason', async () => {
    recordReview.mockResolvedValue({ ok: false, code: 'write_failed' });
    const response = await POST(post(body()));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'review_not_recorded' });
  });

  it('scopes the queue read to the session organization', async () => {
    await GET(get());
    expect(readQueue).toHaveBeenCalledWith({ organizationId: ORG, sourceDocumentId: DOC });
  });

  it('requires a document id on the queue read', async () => {
    const response = await GET(new Request(
      'http://localhost/api/internal/forgewing-recovery-review',
      { headers: { authorization: 'Bearer operator-session-jwt' } },
    ));
    expect(response.status).toBe(400);
    expect(readQueue).not.toHaveBeenCalled();
  });
});
