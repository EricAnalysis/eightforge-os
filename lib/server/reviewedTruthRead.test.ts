import { describe, expect, it } from 'vitest';

import { readProjectReviewedTruth } from '@/lib/server/reviewedTruthRead';

/** Reviewed truth for Ask and investigation context comes only from human_fact_assertions. Synthetic rows. */

const ORG = 'org-1';
const DIGEST = 'a'.repeat(64);

function assertion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1', organization_id: ORG, source_document_id: 'doc-1', fact_key: 'contract_rate_row',
    asserted_value: { description: 'Haul', unit_type: 'TON', rate_amount: 8.75 }, source_binding: 'region_bound',
    supersedes_assertion_id: null, actor_id: 'op', reason: 'read it', asserted_at: '2026-10-06T00:00:00Z', status: 'active',
    source_artifact_id: null, physical_page_number: 2,
    source_region: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] },
    page_representation_digest: DIGEST, parser_version: null, source_observation_ids: ['o1'], original_source_text: 'Haul $8.7S',
    anchor_key: 'p2:priced_line:x', review_origin: 'operator_entered', forgewing_proposal_id: null, ...overrides,
  };
}

function client(params: { assertions: unknown[]; extractionDigest?: string; assertionError?: { code: string } }) {
  const reads: string[] = [];
  const query = (table: string) => {
    const result = table === 'human_fact_assertions'
      ? { data: params.assertionError ? null : params.assertions, error: params.assertionError ?? null }
      : { data: [{ document_id: 'doc-1', created_at: 'now', data: { extraction: { content_layers_v1: { pdf: {
        page_extraction_coverage_v1: { pages: [{ page_number: 2, page_representation_digest: params.extractionDigest ?? DIGEST }] },
        layout_observations_v1: { observations: [{ id: 'o1', raw_text: 'Haul', physical_page_number: 2 }] },
      } } } } }], error: null };
    const chain = { in: () => chain, eq: () => chain, is: () => chain, order: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
    return chain;
  };
  return { reads, admin: { from(table: string) { return { select: () => { reads.push(table); return query(table); } }; }, rpc: async () => ({ data: null, error: null }) } as never };
}

describe('readProjectReviewedTruth', () => {
  it('reads no extraction when no document has a review', async () => {
    const { admin, reads } = client({ assertions: [] });
    await expect(readProjectReviewedTruth(admin, { organizationId: ORG, documentIds: ['doc-1'] }))
      .resolves.toEqual({ status: 'ok', effective: [], held: [] });
    expect(reads).toEqual(['human_fact_assertions']);
  });

  it('applies a current review and holds one whose page representation changed', async () => {
    const current = await readProjectReviewedTruth(client({ assertions: [assertion()] }).admin, { organizationId: ORG, documentIds: ['doc-1'] });
    expect(current.effective).toMatchObject([{ documentId: 'doc-1', anchorKey: 'p2:priced_line:x', assertionId: 'a1',
      value: { rate_amount: 8.75 } }]);
    const moved = await readProjectReviewedTruth(client({ assertions: [assertion()], extractionDigest: 'b'.repeat(64) }).admin,
      { organizationId: ORG, documentIds: ['doc-1'] });
    expect(moved.effective).toEqual([]);
    expect(moved.held).toMatchObject([{ anchorKey: 'p2:priced_line:x', reason: 'page_representation_changed' }]);
  });

  it('never reads another organization’s review', async () => {
    const result = await readProjectReviewedTruth(client({ assertions: [assertion({ organization_id: 'other' })] }).admin,
      { organizationId: ORG, documentIds: ['doc-1'] });
    expect(result).toEqual({ status: 'ok', effective: [], held: [] });
  });

  it('reports an undeployed store as unavailable, not as no reviews', async () => {
    const result = await readProjectReviewedTruth(client({ assertions: [], assertionError: { code: '42P01' } }).admin,
      { organizationId: ORG, documentIds: ['doc-1'] });
    expect(result.status).toBe('unavailable');
  });
});
