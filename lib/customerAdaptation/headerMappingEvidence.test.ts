import { describe, expect, it } from 'vitest';
import { customerMappingEvidenceFromExtraction, CustomerMappingEvidenceSchema } from './headerMappingEvidence';
import { headerEvidenceFixture, headerEvidenceFixtureId as id } from './headerEvidenceFixtures';
import { produceCustomerHeaderEvidence } from './headerEvidence';
import { extractionDocumentDiagnostics } from '@/lib/server/documentDiagnosticsRead';
import { documentEvidenceAttention } from '@/lib/server/documentEvidenceAttention';
import { buildResolutionQueue } from '@/lib/resolution/resolutionCases';
import { buildFrictionReport } from '@/lib/resolution/frictionReport';
import type { HumanFactAssertionRow } from '@/lib/humanFactAssertions/regionBoundAssertions';

function fixture() {
  const source = headerEvidenceFixture();
  const produced = produceCustomerHeaderEvidence(source.context, 0);
  if (produced.status !== 'verified') throw new Error('invalid fixture');
  const binding = produced.bindings[1]!;
  const pin = { version: 'customer_header_mapping_pin_v1' as const, organizationId: id(1), documentType: 'contract',
    revisionId: id(80), digest: 'c'.repeat(64), sourceSchemaIdentity: produced.sourceSchemaIdentity,
    physicalPageNumber: 1, columnIndex: 1, sourceLabel: binding.observedHeaderLabel,
    orderedObservationIds: [...binding.orderedObservationIds], pageRepresentationDigest: binding.pageRepresentationDigest };
  const page = source.page as unknown as Record<string, unknown> & {
    columns: { role: string }[];
    header_interpretation: { status: string };
    customer_header_mapping_pins?: (typeof pin & { extra?: string })[];
  };
  delete page.semantic_status;
  page.columns[0].role = 'description';
  page.columns[1].role = 'rate';
  page.header_interpretation.status = 'resolved_deterministically';
  page.customer_header_mapping_pins = [pin];
  page.rejected_spines = [{ reason: 'ambiguous_rate_clusters', raw_text: 'Unreadable body', source_refs: source.refs }];
  const data = source.context.extraction.data;
  const input = { extractionData: data, extractionSnapshotId: id(4), organizationId: id(1),
    physicalPageNumber: 1, pageRepresentationDigest: binding.pageRepresentationDigest };
  return { ...source, page, pin, data, input };
}

describe('historical customer mapping evidence (B8.2d)', () => {
  it('binds actual interpretation revision and schema to the exact persisted snapshot without configuration lookup', () => {
    const f = fixture();
    expect(customerMappingEvidenceFromExtraction(f.input)).toEqual({ extractionSnapshotId: id(4), mappingPins: [f.pin] });
    expect(CustomerMappingEvidenceSchema.safeParse({ extractionSnapshotId: id(4), mappingPins: [f.pin], activeRevision: id(99) }).success).toBe(false);
  });
  it('omits unknown, invalid, foreign tenant, wrong page and wrong digest pins', () => {
    const f = fixture();
    for (const patch of [{ organizationId: id(99) }, { physicalPageNumber: 2 }, { pageRepresentationDigest: 'b'.repeat(64) }, { extractionSnapshotId: 'unknown' }]) {
      expect(customerMappingEvidenceFromExtraction({ ...f.input, ...patch })).toBeUndefined();
    }
    f.page.customer_header_mapping_pins![0]!.extra = 'untrusted';
    expect(customerMappingEvidenceFromExtraction(f.input)).toBeUndefined();
  });
  it('retains manual action pins only when all reviewed observations belong to one interpreted row', () => {
    const f = fixture(), rowId = `pdf:layout-token:v1:${'e'.repeat(64)}`;
    f.page.rows = [{ cells: [{ source_refs: [{ observation_id: rowId }] }] }];
    expect(customerMappingEvidenceFromExtraction({ ...f.input, sourceObservationIds: [rowId] })).toBeDefined();
    expect(customerMappingEvidenceFromExtraction({ ...f.input, sourceObservationIds: [rowId, 'other-table-row'] })).toBeUndefined();
    expect(customerMappingEvidenceFromExtraction({ ...f.input, sourceObservationIds: [] })).toBeUndefined();
    f.page.rows = [{ cells: [{ source_refs: [{ observation_id: rowId }] }] }, { cells: [{ source_refs: [{ observation_id: 'different-row' }] }] }];
    expect(customerMappingEvidenceFromExtraction({ ...f.input, sourceObservationIds: [rowId, 'different-row'] })).toBeUndefined();
  });
  it('includes unresolved role cells of the same interpreted row while excluding a different row', () => {
    const f = fixture(), resolvedId = `pdf:layout-token:v1:${'e'.repeat(64)}`, unresolvedId = `pdf:layout-token:v1:${'f'.repeat(64)}`;
    f.page.rows = [{ cells: [{ source_refs: [{ observation_id: resolvedId }] }],
      unresolved_role_cells: [{ source_refs: [{ observation_id: unresolvedId }] }] }];
    expect(customerMappingEvidenceFromExtraction({ ...f.input, sourceObservationIds: [resolvedId, unresolvedId] }))
      .toEqual({ extractionSnapshotId: id(4), mappingPins: [f.pin] });
    f.page.rows = [{ cells: [{ source_refs: [{ observation_id: resolvedId }] }] },
      { cells: [], unresolved_role_cells: [{ source_refs: [{ observation_id: unresolvedId }] }] }];
    expect(customerMappingEvidenceFromExtraction({ ...f.input, sourceObservationIds: [resolvedId, unresolvedId] })).toBeUndefined();
  });
  it('preserves diagnostic identities and no-pin outputs while carrying pins through attention and resolution', () => {
    const f = fixture();
    const params = { organizationId: id(1), sourceDocumentId: id(3), extraction: f.data as Record<string, unknown>,
      extractionSnapshotId: id(4), occurredAt: '2026-10-12T00:00:00.000Z', proposals: [] };
    const mapped = extractionDocumentDiagnostics(params);
    delete f.page.customer_header_mapping_pins;
    const baseline = extractionDocumentDiagnostics(params);
    expect(mapped.map(value => value.diagnosticId)).toEqual(baseline.map(value => value.diagnosticId));
    expect(baseline.every(value => !('customerMappingEvidence' in value.sourceIdentity))).toBe(true);
    expect(mapped.filter(value => value.scope.physicalPageNumber === 1).every(value => value.sourceIdentity.customerMappingEvidence)).toBe(true);
    f.page.customer_header_mapping_pins = [f.pin];
    const attention = documentEvidenceAttention({ organizationId: id(1), documentId: id(3),
      extraction: { id: id(4), created_at: params.occurredAt, data: f.data as Record<string, unknown> } });
    const queue = buildResolutionQueue({ projectId: id(2), documents: [{ id: id(3), name: 'Contract' }],
      issues: [], evidence: [], reviewedValuesByDocument: new Map(), recoveryProposals: [], forgewingEnabled: false,
      evidenceAttentionByDocument: new Map([[id(3), attention]]) });
    expect(queue.cases.length).toBeGreaterThan(0);
    expect(queue.cases.filter(value => value.sourceRefs.diagnosticId).every(value => value.sourceRefs.customerMappingEvidence)).toBe(true);
  });
  it('keeps case and explicit assertion evidence tenant-local and outside signals/prefills', () => {
    const f = fixture(), evidence = customerMappingEvidenceFromExtraction(f.input)!;
    const assertion = { id: id(90), organization_id: id(1), source_document_id: id(3), fact_key: 'contract_rate_row',
      source_binding: 'region_bound', status: 'active', review_origin: 'operator_entered', customer_mapping_evidence: evidence } as HumanFactAssertionRow;
    const input = { organizationId: id(1), documentTypeById: new Map([[id(3), 'contract']]),
      projects: [], assertions: [assertion], telemetry: [], outcomes: [] };
    const report = buildFrictionReport(input);
    expect(report.customerMappingEvidence).toEqual([{ sourceKind: 'human_fact_assertion', sourceId: id(90), evidence }]);
    expect(JSON.stringify(report.signals)).not.toContain(f.pin.revisionId);
    expect(JSON.stringify(report.signals)).not.toContain(f.pin.sourceLabel);
    const without = buildFrictionReport({ ...input, assertions: [{ ...assertion, customer_mapping_evidence: undefined }] });
    expect('customerMappingEvidence' in without).toBe(false);
    expect(report.signals).toEqual(without.signals);
    expect(buildFrictionReport({ ...input, assertions: [{ ...assertion, customer_mapping_evidence: { ...evidence,
      mappingPins: [{ ...f.pin, organizationId: id(99) }] } }] }).customerMappingEvidence).toBeUndefined();
  });
});
