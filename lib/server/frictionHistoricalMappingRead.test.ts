import { describe, expect, it, vi } from 'vitest';
import { readFrictionReport } from './frictionReportRead';
import { loadValueReadingRecords } from './valueReadingProposals';
import { headerEvidenceFixture, headerEvidenceFixtureId as id } from '@/lib/customerAdaptation/headerEvidenceFixtures';
import { produceCustomerHeaderEvidence } from '@/lib/customerAdaptation/headerEvidence';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));
vi.mock('./valueReadingProposals', async importOriginal => ({ ...await importOriginal<typeof import('./valueReadingProposals')>(), loadValueReadingRecords: vi.fn() }));

function fixture() {
  const f = headerEvidenceFixture(), produced = produceCustomerHeaderEvidence(f.context, 0);
  if (produced.status !== 'verified') throw new Error('invalid fixture');
  const binding = produced.bindings[1]!;
  const pin = { version: 'customer_header_mapping_pin_v1', organizationId: id(1), documentType: 'contract',
    revisionId: id(83), digest: 'c'.repeat(64), sourceSchemaIdentity: produced.sourceSchemaIdentity,
    physicalPageNumber: 1, columnIndex: 1, sourceLabel: binding.observedHeaderLabel,
    orderedObservationIds: [...binding.orderedObservationIds], pageRepresentationDigest: binding.pageRepresentationDigest };
  const page = f.page as unknown as Record<string, unknown> & {
    columns: { role: string }[];
    header_interpretation: { status: string };
    customer_header_mapping_pins?: (typeof pin & { extra?: string })[];
  };
  delete page.semantic_status;
  page.columns[0].role = 'description'; page.columns[1].role = 'rate';
  page.header_interpretation.status = 'resolved_deterministically';
  page.customer_header_mapping_pins = [pin];
  const historical = { id: id(4), organization_id: id(1), document_id: id(3), data: f.context.extraction.data as unknown as {
    extraction: { content_layers_v1: { pdf: {
      layout_observations_v1: { source_artifact_id: string };
      priced_schedule_reconstruction_v1: { pages: { customer_header_mapping_pins: (typeof pin)[] }[] };
    } } };
  } };
  const latest = structuredClone(historical);
  latest.id = id(7); latest.data.extraction.content_layers_v1.pdf.priced_schedule_reconstruction_v1.pages[0].customer_header_mapping_pins[0].revisionId = id(87);
  latest.data.extraction.content_layers_v1.pdf.priced_schedule_reconstruction_v1.pages[0].customer_header_mapping_pins[0].digest = 'd'.repeat(64);
  const proposal = { rowId: id(91), proposalId: `forgewing-proposal-value-reading-${'b'.repeat(64)}`,
    binding: { organizationId: id(1), sourceDocumentId: id(3), sourceArtifactId: id(5), extractionSnapshotId: id(4),
      physicalPageNumber: 1, pageRepresentationDigest: binding.pageRepresentationDigest }, reading: { kind: 'unreadable' }, createdAt: '2026-10-12T00:00:00Z' };
  const outcome = { id: id(92), organization_id: id(1), recovery_type: 'priced_value_reading', outcome_code: 'provider_failed',
    source_document_id: id(3), source_artifact_id: id(5), extraction_snapshot_id: id(4), physical_page_number: 1,
    page_representation_digest: binding.pageRepresentationDigest };
  vi.mocked(loadValueReadingRecords).mockResolvedValue({ proposals: [proposal], reviews: [] } as never);
  const tables: Record<string, unknown[]> = { documents: [{ id: id(3), organization_id: id(1), document_type: 'contract' }],
    document_extractions: [historical, latest], forgewing_recovery_generation_outcomes: [outcome] };
  const filters: { table: string; kind: string; column: string; value: unknown }[] = [];
  const admin = { from(table: string) { return { select() {
    const predicates: ((row: Record<string, unknown>) => boolean)[] = [];
    const chain = { eq(column: string, value: unknown) { filters.push({ table, kind: 'eq', column, value }); predicates.push(row => row[column] === value); return chain; },
      in(column: string, value: unknown[]) { filters.push({ table, kind: 'in', column, value }); predicates.push(row => value.includes(row[column])); return chain; },
      order() { filters.push({ table, kind: 'order', column: '', value: null }); return chain; }, limit() { return chain; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(resolve({ data: (tables[table] ?? []).filter(row => predicates.every(predicate => predicate(row as Record<string, unknown>))), error: null })); } };
    return chain;
  } }; } };
  return { tables, filters, admin: admin as never, pin, historical, latest, outcome };
}
describe('historical value-reading mapping provenance read', () => {
  it('uses request snapshot R3 while a newer preferred extraction has R7, scoped and read-only', async () => {
    const f = fixture(), result = await readFrictionReport({ organizationId: id(1) }, { admin: f.admin });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.report.customerMappingEvidence?.map(record => record.sourceKind)).toEqual(['value_reading_proposal', 'value_reading_outcome']);
    expect(result.report.customerMappingEvidence?.every(record => record.evidence.extractionSnapshotId === id(4)
      && record.evidence.mappingPins[0]?.revisionId === id(83))).toBe(true);
    expect(JSON.stringify(result.report.customerMappingEvidence)).not.toContain(id(87));
    expect(f.filters.filter(filter => filter.table === 'document_extractions')).toEqual([
      { table: 'document_extractions', kind: 'eq', column: 'organization_id', value: id(1) },
      { table: 'document_extractions', kind: 'in', column: 'document_id', value: [id(3)] },
      { table: 'document_extractions', kind: 'in', column: 'id', value: [id(4)] },
    ]);
    expect(result.report.forgewing.failed).toBe(1);
  });
  it.each(['missing', 'other_document', 'other_tenant', 'other_artifact', 'different_digest'])('keeps provenance unknown for %s instead of substituting current interpretation', async mode => {
    const f = fixture();
    if (mode === 'missing') f.tables.document_extractions = [f.latest];
    if (mode === 'other_document') f.historical.document_id = id(99);
    if (mode === 'other_tenant') f.historical.organization_id = id(99);
    if (mode === 'other_artifact') f.historical.data.extraction.content_layers_v1.pdf.layout_observations_v1.source_artifact_id = id(99);
    if (mode === 'different_digest') f.historical.data.extraction.content_layers_v1.pdf.priced_schedule_reconstruction_v1.pages[0].customer_header_mapping_pins[0].pageRepresentationDigest = 'e'.repeat(64);
    const result = await readFrictionReport({ organizationId: id(1) }, { admin: f.admin });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.report.customerMappingEvidence).toBeUndefined();
    expect(result.report.forgewing.failed).toBe(1);
  });
});
