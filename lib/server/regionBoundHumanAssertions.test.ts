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

  it('passes action-time mapping provenance unchanged and omits the optional RPC argument for unknown history', async () => {
    const customerMappingEvidence = { extractionSnapshotId: '00000000-0000-4000-8000-000000000004', mappingPins: [{
      version: 'customer_header_mapping_pin_v1' as const, organizationId: '00000000-0000-4000-8000-000000000001',
      documentType: 'contract', revisionId: '00000000-0000-4000-8000-000000000080', digest: 'c'.repeat(64),
      sourceSchemaIdentity: `customer-header-schema-v1:${'d'.repeat(64)}`, physicalPageNumber: 2, columnIndex: 1,
      sourceLabel: 'Billing Rate', orderedObservationIds: [`pdf:layout-token:v1:${'e'.repeat(64)}`],
      pageRepresentationDigest: 'a'.repeat(64),
    }] };
    const { client, rpc } = rpcClient({ data: [{ assertion_id: 'a-4', inserted: true }], error: null });
    await recordRegionBoundAssertion(client, { ...INPUT, customerMappingEvidence });
    expect((rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_customer_mapping_evidence).toEqual(customerMappingEvidence);
    await recordRegionBoundAssertion(client, INPUT);
    expect((rpc.mock.calls[1] as unknown as [string, Record<string, unknown>])[1]).not.toHaveProperty('p_customer_mapping_evidence');
  });

  it('passes the server-verified source extraction only when there is one, keeping the old call shape (B8.4b)', async () => {
    const { client, rpc } = rpcClient({ data: [{ assertion_id: 'a-5', inserted: true }], error: null });
    await recordRegionBoundAssertion(client, { ...INPUT, sourceExtractionId: '00000000-0000-4000-8000-000000000004' });
    expect((rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_source_extraction_id)
      .toBe('00000000-0000-4000-8000-000000000004');
    // Old valid writes are byte-for-byte the pre-B8.4b call.
    await recordRegionBoundAssertion(client, INPUT);
    await recordRegionBoundAssertion(client, { ...INPUT, sourceExtractionId: null });
    for (const call of [rpc.mock.calls[1], rpc.mock.calls[2]]) {
      expect((call as unknown as [string, Record<string, unknown>])[1]).not.toHaveProperty('p_source_extraction_id');
    }
    // The pin is provenance, not request identity: the idempotency digest is unchanged.
    expect(regionAssertionRequestDigest({ ...INPUT, sourceExtractionId: '00000000-0000-4000-8000-000000000004' }))
      .toBe(regionAssertionRequestDigest(INPUT));
  });

  it('still records the correction, without provenance, when the database predates the pin (B8.4b)', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
      .mockResolvedValueOnce({ data: [{ assertion_id: 'a-6', inserted: true }], error: null });
    const client = { rpc, from: vi.fn() } as unknown as RegionAssertionClient;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordRegionBoundAssertion(client, { ...INPUT, sourceExtractionId: '00000000-0000-4000-8000-000000000004' }))
      .resolves.toEqual({ status: 'recorded', assertionId: 'a-6', inserted: true });
    expect((rpc.mock.calls[1] as unknown as [string, Record<string, unknown>])[1]).not.toHaveProperty('p_source_extraction_id');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    // Without a pin there is no retry: an undeployed schema stays "unavailable".
    const plain = rpcClient({ data: null, error: { code: '42883' } });
    await expect(recordRegionBoundAssertion(plain.client, INPUT)).resolves.toEqual({ status: 'unavailable' });
    expect(plain.rpc).toHaveBeenCalledOnce();
  });

  it('reads nothing, without failing validation, when the B3 columns are not deployed yet', async () => {
    const query = { in: () => query, eq: () => query, order: () => query,
      then: (resolve: (value: unknown) => unknown) => resolve({ data: null, error: { code: '42703', message: 'column does not exist' } }) };
    const client = { from: () => ({ select: () => query }), rpc: vi.fn() } as unknown as RegionAssertionClient;
    await expect(loadRegionBoundAssertionRows(client, ['doc-1'])).resolves.toEqual({ status: 'unavailable', rows: [] });
  });
});
