import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/documents/[id]/facts/region-assertions/route';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { recordRegionBoundAssertion } from '@/lib/server/regionBoundHumanAssertions';
import { headerEvidenceFixture, headerEvidenceFixtureId as id } from '@/lib/customerAdaptation/headerEvidenceFixtures';
import { produceCustomerHeaderEvidence } from '@/lib/customerAdaptation/headerEvidence';

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn() }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/server/regionBoundHumanAssertions', () => ({ recordRegionBoundAssertion: vi.fn(), loadRegionBoundAssertionRows: vi.fn() }));
vi.mock('@/lib/validator/revalidationRequests', () => ({ requestFactOverrideRevalidation: vi.fn() }));

function fixture() {
  const f = headerEvidenceFixture();
  const verified = produceCustomerHeaderEvidence(f.context, 0);
  if (verified.status !== 'verified') throw new Error('invalid fixture');
  const binding = verified.bindings[1]!;
  const pin = { version: 'customer_header_mapping_pin_v1' as const, organizationId: id(1), documentType: 'contract',
    revisionId: id(80), digest: 'c'.repeat(64), sourceSchemaIdentity: verified.sourceSchemaIdentity,
    physicalPageNumber: 1, columnIndex: 1, sourceLabel: binding.observedHeaderLabel,
    orderedObservationIds: [...binding.orderedObservationIds], pageRepresentationDigest: binding.pageRepresentationDigest };
  const page = f.page as unknown as Record<string, unknown> & {
    columns: { role: string }[];
    header_interpretation: { status: string };
    customer_header_mapping_pins?: (typeof pin & { extra?: string })[];
  };
  delete page.semantic_status;
  page.columns[0].role = 'description';
  page.columns[1].role = 'rate';
  page.header_interpretation.status = 'resolved_deterministically';
  page.customer_header_mapping_pins = [pin];
  page.rows = [{ row_index: 0, physical_page_number: 1, cells: [{ role: 'description', raw_text: 'Source row', source_refs: f.refs }] }];
  const tables = { documents: { data: f.context.document, error: null }, document_extractions: { data: [{ id: id(4), document_id: id(3),
    created_at: '2026-10-12T00:00:00.000Z', data: f.context.extraction.data }], error: null } };
  const admin = { from: (table: string) => {
    const response = tables[table as keyof typeof tables];
    const chain = { select: () => chain, eq: () => chain, is: () => chain, order: () => chain,
      maybeSingle: () => Promise.resolve(response), then: (resolve: (response: unknown) => unknown) => Promise.resolve(resolve(response)) };
    return chain;
  } };
  vi.mocked(getSupabaseAdmin).mockReturnValue(admin as never);
  const body = { factKey: 'contract_rate_row', value: { description: 'Source row', unit_type: 'EA', rate_amount: 10 },
    reason: 'Reviewed source', anchorKey: 'p1:row0', idempotencyKey: 'review-1', physicalPageNumber: 1,
    pageRepresentationDigest: binding.pageRepresentationDigest, sourceObservationIds: f.refs.map(ref => ref.observation_id),
    sourceRegion: { coordinate_space: 'pdf_user_unrotated', boxes: [{ x_min: 0, x_max: 145, y_min: 100, y_max: 110 }] },
    customerMappingEvidence: { extractionSnapshotId: id(99), mappingPins: [] } };
  return { f, pin, page, body };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getActorContext).mockResolvedValue({ ok: true, actor: { actorId: id(70), organizationId: id(1), displayName: null, email: null, role: 'member' } });
  vi.mocked(recordRegionBoundAssertion).mockResolvedValue({ status: 'recorded', assertionId: id(90), inserted: true });
});
describe('region assertion historical mapping provenance route', () => {
  it('records the exact persisted action-time snapshot and ignores applicant mapping provenance', async () => {
    const f = fixture();
    const response = await POST(new Request('http://localhost/api/documents/test/facts/region-assertions', {
      method: 'POST', body: JSON.stringify(f.body), headers: { 'Content-Type': 'application/json' } }) as NextRequest,
      { params: Promise.resolve({ id: id(3) }) });
    expect(response.status).toBe(201);
    expect(vi.mocked(recordRegionBoundAssertion).mock.calls[0]![1].customerMappingEvidence)
      .toEqual({ extractionSnapshotId: id(4), mappingPins: [f.pin] });
  });
  it('omits unknown mapping history instead of substituting applicant pins', async () => {
    const f = fixture(); delete f.page.customer_header_mapping_pins;
    const response = await POST(new Request('http://localhost/api/documents/test/facts/region-assertions', {
      method: 'POST', body: JSON.stringify(f.body), headers: { 'Content-Type': 'application/json' } }) as NextRequest,
      { params: Promise.resolve({ id: id(3) }) });
    expect(response.status).toBe(201);
    expect(vi.mocked(recordRegionBoundAssertion).mock.calls[0]![1]).not.toHaveProperty('customerMappingEvidence');
  });
});
