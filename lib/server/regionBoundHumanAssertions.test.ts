import { describe, expect, it, vi } from 'vitest';

import {
  loadRegionBoundAssertionRows,
  recordRegionBoundAssertion,
  regionAssertionRequestDigest,
  type RecordRegionAssertionInput,
  type RegionAssertionClient,
} from '@/lib/server/regionBoundHumanAssertions';

const INPUT: RecordRegionAssertionInput = {
  organizationId: 'org-1', actorId: 'actor-1', sourceDocumentId: 'doc-1', factKey: 'contract_rate_row',
  assertedValue: { description: 'Hauling', unit_type: 'TON', rate_amount: 8.75 }, status: 'active',
  reason: 'OCR damaged', sourceArtifactId: null, physicalPageNumber: 2,
  sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 0, x_max: 1, y_min: 0, y_max: 1 }] },
  pageRepresentationDigest: 'a'.repeat(64), parserVersion: null, sourceObservationIds: ['o1'],
  originalSourceText: '8.7S', anchorKey: 'p2:a', supersedesAssertionId: null, idempotencyKey: 'k-1',
};

function rpcClient(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc, from: vi.fn() } as unknown as RegionAssertionClient, rpc };
}

describe('region-bound assertion server adapter (B3)', () => {
  it('always records manual entry as operator_entered with no Forgewing proposal', async () => {
    const { client, rpc } = rpcClient({ data: [{ assertion_id: 'a-1', inserted: true }], error: null });
    await expect(recordRegionBoundAssertion(client, INPUT))
      .resolves.toEqual({ status: 'recorded', assertionId: 'a-1', inserted: true });
    const args = (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(args).toMatchObject({ p_review_origin: 'operator_entered', p_forgewing_proposal_id: null });
    expect(args.p_request_digest_sha256).toBe(regionAssertionRequestDigest(INPUT));
  });

  it('cites a proposal only as ai_proposed and never chooses the stored origin (B4.2)', async () => {
    const proposalId = `forgewing-proposal-value-reading-${'b'.repeat(64)}`;
    const { client, rpc } = rpcClient({ data: [{ assertion_id: 'a-3', inserted: true }], error: null });
    await recordRegionBoundAssertion(client, { ...INPUT, forgewingProposalId: proposalId });
    const args = (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(args).toMatchObject({ p_review_origin: 'ai_proposed', p_forgewing_proposal_id: proposalId });
    expect(String(args.p_review_origin)).not.toMatch(/approved|modified/);
    // Without a proposal, unchanged Core behaviour.
    await recordRegionBoundAssertion(client, { ...INPUT, forgewingProposalId: null });
    expect((rpc.mock.calls[1] as unknown as [string, Record<string, unknown>])[1])
      .toMatchObject({ p_review_origin: 'operator_entered', p_forgewing_proposal_id: null });
  });

  it('reports a proposal that does not bind, and writes nothing (B4.2)', async () => {
    const proposalId = `forgewing-proposal-value-reading-${'b'.repeat(64)}`;
    const refused = rpcClient({ data: null, error: { code: '23514', message: 'cited proposal is stale for this page representation' } });
    await expect(recordRegionBoundAssertion(refused.client, { ...INPUT, forgewingProposalId: proposalId }))
      .resolves.toEqual({ status: 'proposal_not_bound', reason: 'cited proposal is stale for this page representation' });
    // The same code without a cited proposal stays a plain refusal.
    await expect(recordRegionBoundAssertion(refused.client, INPUT))
      .resolves.toEqual({ status: 'rejected', reason: 'cited proposal is stale for this page representation' });
  });

  it('sends no value for a withdrawal', async () => {
    const { client, rpc } = rpcClient({ data: [{ assertion_id: 'a-2', inserted: true }], error: null });
    await recordRegionBoundAssertion(client, { ...INPUT, status: 'withdrawn', supersedesAssertionId: 'a-1' });
    expect((rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_asserted_value).toBeNull();
  });

  it('maps a stale chain head, an undeployed schema and other refusals', async () => {
    await expect(recordRegionBoundAssertion(rpcClient({ data: null, error: { code: '40001' } }).client, INPUT))
      .resolves.toEqual({ status: 'stale_chain_head' });
    await expect(recordRegionBoundAssertion(rpcClient({ data: null, error: { code: '42883' } }).client, INPUT))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(recordRegionBoundAssertion(rpcClient({ data: null, error: { code: '42501', message: 'nope' } }).client, INPUT))
      .resolves.toEqual({ status: 'rejected', reason: 'nope' });
  });

  it('keys idempotency to organization, actor and client key only', () => {
    expect(regionAssertionRequestDigest(INPUT)).toBe(regionAssertionRequestDigest({ ...INPUT, reason: 'other' }));
    expect(regionAssertionRequestDigest(INPUT)).not.toBe(regionAssertionRequestDigest({ ...INPUT, actorId: 'actor-2' }));
    expect(regionAssertionRequestDigest(INPUT)).not.toBe(regionAssertionRequestDigest({ ...INPUT, idempotencyKey: 'k-2' }));
  });

  it('reads nothing, without failing validation, when the B3 columns are not deployed yet', async () => {
    const query = { in: () => query, eq: () => query, order: () => query,
      then: (resolve: (value: unknown) => unknown) => resolve({ data: null, error: { code: '42703', message: 'column does not exist' } }) };
    const client = { from: () => ({ select: () => query }), rpc: vi.fn() } as unknown as RegionAssertionClient;
    await expect(loadRegionBoundAssertionRows(client, ['doc-1'])).resolves.toEqual({ status: 'unavailable', rows: [] });
  });
});
