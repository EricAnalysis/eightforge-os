import { describe, expect, it, vi } from 'vitest';
import { headerEvidenceFixture, headerEvidenceFixtureId as id } from '@/lib/customerAdaptation/headerEvidenceFixtures';
import { produceCustomerHeaderEvidence } from '@/lib/customerAdaptation/headerEvidence';
import { buildReviewedCustomerHeaderMappingRevision } from '@/lib/customerAdaptation/headerMapping';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { approveCustomerHeaderMapping, transitionCustomerHeaderMapping, loadActiveCustomerHeaderMappings } from './customerHeaderMappingLifecycle';
import type { ActorContext } from './getActorContext';

const actor: ActorContext = { actorId: id(9), organizationId: id(1), role: 'admin', email: null, displayName: null };
function setup() {
  const f = headerEvidenceFixture();
  const produced = produceCustomerHeaderEvidence(f.context, 0);
  if (produced.status !== 'verified') throw new Error('invalid fixture');
  const evidence = produced.bindings[1]!;
  const request = { targetRole: 'rate', supportingEvidence: evidence, supersedesRevisionId: null };
  const revision = buildReviewedCustomerHeaderMappingRevision({ domain: 'eightforge.reviewed-customer-header-mapping', schemaVersion: 2,
    organizationId: actor.organizationId, revisionId: id(20), scope: { interpretationBoundary: 'priced_schedule_assembly_header',
      documentType: evidence.documentType, sourceSchemaIdentity: evidence.sourceSchemaIdentity }, mappings: [{ sourceLabel: evidence.observedHeaderLabel,
      targetRole: 'rate', supportingEvidence: { ...evidence, orderedObservationIds: [...evidence.orderedObservationIds] } }],
    humanApproval: { actorId: actor.actorId, approvedAt: '2026-10-12T00:00:00.000Z' }, supersedesRevisionId: null });
  const { digest, ...envelope } = revision;
  const pointer = { organization_id: actor.organizationId, interpretation_boundary: revision.scope.interpretationBoundary,
    document_type: revision.scope.documentType, source_schema_identity: revision.scope.sourceSchemaIdentity,
    source_label: evidence.observedHeaderLabel, revision_id: revision.revisionId,
    customer_header_mapping_revisions: { revision_id: revision.revisionId, organization_id: actor.organizationId,
      digest, envelope_canonical_json: canonicalJson(envelope) } };
  const rows: Record<string, unknown> = { documents: f.context.document, projects: f.context.project,
    document_extractions: [f.context.extraction], extraction_source_artifacts: f.context.artifact, customer_header_mapping_active: [pointer] };
  const filters: Array<[string, string, unknown]> = [];
  let rpcError: { code: string } | null = null;
  let countOffset = 0;
  const from = vi.fn((table: string) => {
    const result = () => ({ data: rows[table], error: null, count: Array.isArray(rows[table]) ? rows[table].length + countOffset : null });
    const chain = { select: vi.fn(() => chain), eq: vi.fn((field: string, value: unknown) => { filters.push([table, field, value]); return chain; }),
      is: vi.fn(() => chain), order: vi.fn(async () => result()), maybeSingle: vi.fn(async () => result()), limit: vi.fn(async () => result()) };
    return chain;
  });
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    const recorded = name === 'approve_customer_header_mapping'
      ? JSON.parse(params.p_revision_envelope_canonical_json as string) : null;
    return { data: recorded ? [{ revision_id: recorded.revisionId, digest: hashCanonical(recorded), inserted: true }]
      : [{ event_id: id(30), occurred_at: '2026-10-12T00:01:00.000Z' }], error: rpcError };
  });
  return { f, request, pointer, rows, rpc, from, filters, setRpcError: (code: string) => { rpcError = { code }; },
    setCountOffset: (value: number) => { countOffset = value; },
    admin: { from, rpc } as unknown as NonNullable<Parameters<typeof approveCustomerHeaderMapping>[2]> };
}
describe('customer header mapping lifecycle authenticated adapter', () => {
  it.each(['member', 'viewer', null])('denies approval and transitions for role %s before evidence/storage reads', async role => {
    const s = setup(); const denied = { ...actor, role };
    expect(await approveCustomerHeaderMapping(denied, s.request, s.admin)).toMatchObject({ httpStatus: 403 });
    expect(await transitionCustomerHeaderMapping(denied, id(20), 'activate', { digest: 'a'.repeat(64) }, s.admin)).toMatchObject({ httpStatus: 403 });
    expect(s.from).not.toHaveBeenCalled(); expect(s.rpc).not.toHaveBeenCalled();
  });
  it.each(['owner', 'admin'])('approves verified evidence for %s with server identity, separate from activation', async role => {
    const s = setup();
    const result = await approveCustomerHeaderMapping({ ...actor, role }, s.request, s.admin);
    expect(result.status).toBe('approved');
    expect(s.rpc).toHaveBeenCalledTimes(1);
    const [name, params] = s.rpc.mock.calls[0]!;
    expect(name).toBe('approve_customer_header_mapping');
    expect(params.p_verified_extraction_data).toEqual(s.f.context.extraction.data);
    const envelope = JSON.parse(params.p_revision_envelope_canonical_json as string);
    expect(envelope.humanApproval.actorId).toBe(actor.actorId);
    expect(envelope.organizationId).toBe(actor.organizationId);
    expect(envelope.revisionId).not.toBe(id(20));
    expect(envelope.mappings).toHaveLength(1);
  });
  it('rejects stale or cross-tenant evidence and supplied approval metadata without calling RPC', async () => {
    for (const change of [{ supportingEvidence: { ...setup().request.supportingEvidence, extractionId: id(99) } },
      { supportingEvidence: { ...setup().request.supportingEvidence, organizationId: id(99) } }, { humanApproval: { actorId: id(99) } }]) {
      const s = setup(); expect((await approveCustomerHeaderMapping(actor, { ...s.request, ...change }, s.admin)).status).toBe('rejected');
      expect(s.rpc).not.toHaveBeenCalled();
    }
  });
  it('allows same actor to perform distinct activate and withdraw calls and rejects stale digest conflicts', async () => {
    const s = setup(); const body = { digest: 'a'.repeat(64) };
    expect((await transitionCustomerHeaderMapping(actor, id(20), 'activate', body, s.admin)).status).toBe('activated');
    expect((await transitionCustomerHeaderMapping(actor, id(20), 'withdraw', body, s.admin)).status).toBe('withdrawn');
    expect(s.rpc.mock.calls.map(call => call[1].p_action)).toEqual(['activate', 'withdraw']);
    s.setRpcError('40001');
    expect(await transitionCustomerHeaderMapping(actor, id(20), 'activate', body, s.admin)).toMatchObject({ httpStatus: 409 });
  });
  it('loads and freezes one explicit active snapshot with tenant/document scope filters', async () => {
    const s = setup(); const result = await loadActiveCustomerHeaderMappings({ organizationId: actor.organizationId, documentType: 'contract' }, s.admin);
    expect(result?.revisions[0]?.revisionId).toBe(id(20));
    expect(Object.isFrozen(result?.revisions[0]?.mappings)).toBe(true);
    expect(s.filters).toContainEqual(['customer_header_mapping_active', 'organization_id', actor.organizationId]);
    expect(s.filters).toContainEqual(['customer_header_mapping_active', 'document_type', 'contract']);
  });
  it('distinguishes no active mapping from ambiguous, corrupt or cross-tenant stored snapshots', async () => {
    const empty = setup(); empty.rows.customer_header_mapping_active = [];
    expect(await loadActiveCustomerHeaderMappings({ organizationId: actor.organizationId, documentType: 'contract' }, empty.admin)).toBeNull();
    for (const mode of ['duplicate', 'digest', 'tenant', 'scope', 'limit']) {
      const s = setup();
      if (mode === 'duplicate') s.rows.customer_header_mapping_active = [s.pointer, s.pointer];
      if (mode === 'digest') s.pointer.customer_header_mapping_revisions.digest = 'b'.repeat(64);
      if (mode === 'tenant') s.pointer.organization_id = id(99);
      if (mode === 'scope') s.pointer.source_label = 'Other';
      if (mode === 'limit') s.rows.customer_header_mapping_active = Array(1001).fill(s.pointer);
      await expect(loadActiveCustomerHeaderMappings({ organizationId: actor.organizationId, documentType: 'contract' }, s.admin)).rejects.toThrow();
    }
  });
  it('rejects a truncated response even when returned rows are individually valid', async () => {
    const s = setup(); s.setCountOffset(1);
    await expect(loadActiveCustomerHeaderMappings({ organizationId: actor.organizationId, documentType: 'contract' }, s.admin)).rejects.toThrow('snapshot_unavailable');
  });
});
