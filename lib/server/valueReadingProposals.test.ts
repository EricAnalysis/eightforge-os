import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  buildValueReadingProposal,
  cleanValueReadingRationale,
  isValueReadingProposalRow,
  loadValueReadingRecords,
  parseValueReadingProposalRow,
  recordValueReadingProposal,
  recordValueReadingReview,
  RECORD_VALUE_READING_PROPOSAL_RPC,
  RECORD_VALUE_READING_REVIEW_RPC,
  type ValueReadingClient,
  type ValueReadingProposalDraft,
} from '@/lib/server/valueReadingProposals';

const MIGRATION = readFileSync('supabase/migrations/20261004220000_forgewing_value_reading_proposals.sql', 'utf8');

function migrationParameters(fn: string): string[] {
  const start = MIGRATION.indexOf(`CREATE FUNCTION public.${fn}(`);
  const body = MIGRATION.slice(start, MIGRATION.indexOf(') RETURNS', start));
  return [...body.matchAll(/\b(p_[a-z0-9_]+)\b/g)].map((match) => match[1]!);
}

const DRAFT: ValueReadingProposalDraft = {
  binding: {
    organizationId: 'org-1', projectId: 'project-1', sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1',
    extractionSnapshotId: 'extraction-1', resolutionCaseId: 'case-1', physicalPageNumber: 8,
    pageRepresentationDigest: 'a'.repeat(64), factKey: 'contract_rate_row', anchorKey: 'p8:line:300',
    sourceObservationIds: ['obs-1', 'obs-2'],
    sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 440, x_max: 520, y_min: 300, y_max: 312 }] },
  },
  reading: { kind: 'value', rateRow: { description: ' Debris removal ', unit_type: 'CY', rate_amount: 14.5, category: null } },
  readingBasis: 'region_image',
  providerModel: null,
  promptTemplateId: 'priced_value_reading',
  promptTemplateVersion: 'v1',
  requestDigestSha256: 'b'.repeat(64),
  outputDigestSha256: 'c'.repeat(64),
  rationale: '  Rate cell\nreads $14.50.  ',
};

function rpcClient(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc, from: vi.fn() } as unknown as ValueReadingClient, rpc };
}

describe('value-reading proposals (B4.2)', () => {
  it('builds one immutable, non-authoritative proposal per exact content', () => {
    const proposal = buildValueReadingProposal(DRAFT)!;
    expect(proposal).toMatchObject({
      proposalVersion: 3, authority: 'non_authoritative', requiresHumanReview: true,
      reading: { kind: 'value', rateRow: { description: 'Debris removal', unit_type: 'CY', rate_amount: 14.5, category: null } },
      rationale: 'Rate cell reads $14.50.',
    });
    expect(proposal.proposalId).toBe(`forgewing-proposal-value-reading-${proposal.proposalDigestSha256}`);
    expect(buildValueReadingProposal(DRAFT)).toEqual(proposal);
    expect(buildValueReadingProposal({ ...DRAFT, outputDigestSha256: 'd'.repeat(64) })!.proposalDigestSha256)
      .not.toBe(proposal.proposalDigestSha256);
    expect(buildValueReadingProposal({ ...DRAFT, binding: { ...DRAFT.binding, anchorKey: 'p8:line:301' } })!
      .proposalDigestSha256).not.toBe(proposal.proposalDigestSha256);
  });

  it('represents an unreadable reading, which proposes no value', () => {
    expect(buildValueReadingProposal({ ...DRAFT, reading: { kind: 'unreadable' } })!.reading).toEqual({ kind: 'unreadable' });
  });

  it('refuses drafts outside the contract', () => {
    const bad: ValueReadingProposalDraft[] = [
      { ...DRAFT, reading: { kind: 'value', rateRow: { description: 'x', unit_type: 'CY', rate_amount: Number.NaN, category: null } } },
      { ...DRAFT, requestDigestSha256: 'nope' },
      { ...DRAFT, rationale: ' \n ' },
      { ...DRAFT, binding: { ...DRAFT.binding, sourceObservationIds: [] } },
      { ...DRAFT, binding: { ...DRAFT.binding, sourceObservationIds: ['obs-1', 'obs-1'] } },
      { ...DRAFT, binding: { ...DRAFT.binding, physicalPageNumber: 0 } },
      { ...DRAFT, binding: { ...DRAFT.binding, sourceRegion: { coordinate_space: 'source', boxes: [] } } },
      { ...DRAFT, readingBasis: 'region_text' as never },
    ];
    for (const draft of bad) expect(buildValueReadingProposal(draft)).toBeNull();
  });

  it('cleans a rationale to one short line', () => {
    expect(cleanValueReadingRationale('a\u0000b\n\tc ')).toBe('a b c');
    expect(cleanValueReadingRationale('x'.repeat(900))).toHaveLength(500);
  });

  it('records through the record function with exactly its parameters', async () => {
    const proposal = buildValueReadingProposal(DRAFT)!;
    const { client, rpc } = rpcClient({ data: [{ proposal_row_id: 'row-1', inserted: true }], error: null });
    await expect(recordValueReadingProposal(client, proposal))
      .resolves.toEqual({ status: 'recorded', proposalRowId: 'row-1', inserted: true });
    const [fn, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fn).toBe(RECORD_VALUE_READING_PROPOSAL_RPC);
    expect(Object.keys(args)).toEqual(migrationParameters(RECORD_VALUE_READING_PROPOSAL_RPC));
    expect(args).toMatchObject({ p_reading_outcome: 'value', p_provider_model: null, p_proposal_id: proposal.proposalId });
    await expect(recordValueReadingProposal(rpcClient({ data: null, error: { code: '23505' } }).client, proposal))
      .resolves.toEqual({ status: 'collision' });
  });

  it('reviews only as rejected or deferred, never as an approval', async () => {
    const { client, rpc } = rpcClient({ data: [{ review_id: 'r-1', review_version: 1, inserted: true }], error: null });
    const input = {
      organizationId: 'org-1', reviewerActorId: 'actor-1', proposalId: 'p', proposalDigestSha256: 'd'.repeat(64),
      disposition: 'rejected' as const, rationale: 'Reads the wrong row', idempotencyKey: 'k',
    };
    await expect(recordValueReadingReview(client, input)).resolves.toMatchObject({ status: 'recorded', reviewId: 'r-1' });
    const [fn, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fn).toBe(RECORD_VALUE_READING_REVIEW_RPC);
    expect(Object.keys(args)).toEqual(migrationParameters(RECORD_VALUE_READING_REVIEW_RPC));
    await expect(recordValueReadingReview(client, { ...input, disposition: 'accepted' as never }))
      .resolves.toMatchObject({ status: 'rejected' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('parses stored rows strictly and tells recovery readers to skip them', () => {
    const row = {
      id: 'row-1', proposal_id: `forgewing-proposal-value-reading-${'e'.repeat(64)}`, proposal_digest_sha256: 'e'.repeat(64),
      proposal_version: 3, recovery_type: 'priced_value_reading', organization_id: 'org-1', project_id: 'project-1',
      source_document_id: 'doc-1', source_artifact_id: 'artifact-1', extraction_snapshot_id: 'extraction-1',
      resolution_case_id: 'case-1', physical_page_number: 8, page_representation_digest: 'a'.repeat(64),
      fact_key: 'contract_rate_row', anchor_key: 'p8:line:300', source_observation_ids: ['obs-1'],
      source_region: DRAFT.binding.sourceRegion, reading_outcome: 'value',
      proposed_rate_row: { description: 'Debris removal', unit_type: 'CY', rate_amount: 14.5, category: null },
      reading_basis: 'region_image', provider_model: null, rationale: 'Reads $14.50', authority: 'non_authoritative',
      created_at: '2026-10-04T00:00:00Z',
    };
    expect(parseValueReadingProposalRow(row)).toMatchObject({ rowId: 'row-1', reading: { kind: 'value' }, providerModel: null });
    expect(parseValueReadingProposalRow({ ...row, authority: 'authoritative' })).toBeNull();
    expect(parseValueReadingProposalRow({ ...row, proposal_version: 2 })).toBeNull();
    expect(isValueReadingProposalRow(row)).toBe(true);
    expect(isValueReadingProposalRow({ proposal_version: 2, recovery_type: 'pricing_rate_multi_observation_cluster' })).toBe(false);
    expect(isValueReadingProposalRow({ proposal_version: 1, recovery_type: 'pricing_rate_single_observation' })).toBe(false);
  });

  it('loads proposals of one organization with their reviews', async () => {
    const tables: string[] = [];
    const filters: Array<[string, unknown]> = [];
    const result = (table: string) => table === 'forgewing_recovery_proposals'
      ? { data: [{ ...{ id: 'row-1', proposal_id: `forgewing-proposal-value-reading-${'e'.repeat(64)}`,
        proposal_digest_sha256: 'e'.repeat(64), proposal_version: 3, recovery_type: 'priced_value_reading',
        organization_id: 'org-1', project_id: 'project-1', source_document_id: 'doc-1', source_artifact_id: 'artifact-1',
        extraction_snapshot_id: 'extraction-1', resolution_case_id: 'case-1', physical_page_number: 8,
        page_representation_digest: 'a'.repeat(64), fact_key: 'contract_rate_row', anchor_key: 'p8:line:300',
        source_observation_ids: ['obs-1'], source_region: DRAFT.binding.sourceRegion, reading_outcome: 'unreadable',
        proposed_rate_row: null, reading_basis: 'region_image', provider_model: null, rationale: 'r',
        authority: 'non_authoritative', created_at: '2026-10-04T00:00:00Z' } }], error: null }
      : { data: [{ id: 'rv-1', proposal_row_id: 'row-1', review_version: 1, reviewer_actor_id: 'a', disposition: 'rejected',
        created_at: '2026-10-04T00:01:00Z' }, { id: 'rv-2', proposal_row_id: 'row-1', review_version: 2,
        reviewer_actor_id: 'a', disposition: 'accepted', created_at: '2026-10-04T00:02:00Z' }], error: null };
    const client = {
      rpc: vi.fn(),
      from(table: string) {
        tables.push(table);
        const query = {
          eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
          in: (column: string, value: unknown) => { filters.push([column, value]); return query; },
          then: (resolve: (value: unknown) => unknown) => resolve(result(table)),
        };
        return { select: () => query };
      },
    } as unknown as ValueReadingClient;
    const records = await loadValueReadingRecords(client, { organizationId: 'org-1', documentIds: ['doc-1'] });
    expect(records.proposals).toHaveLength(1);
    // Only rejected and deferred are value-reading reviews.
    expect(records.reviews.map((review) => review.id)).toEqual(['rv-1']);
    expect(tables).toEqual(['forgewing_recovery_proposals', 'forgewing_recovery_proposal_reviews']);
    expect(filters).toContainEqual(['proposal_version', 3]);
    expect(filters).toContainEqual(['organization_id', 'org-1']);
  });
});
