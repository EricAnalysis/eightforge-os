import { describe, expect, it } from 'vitest';
import { produceCustomerHeaderEvidence, verifyCustomerHeaderEvidence, CustomerHeaderEvidenceBindingSchema,
  customerHeaderSchemaIdentity, type HeaderEvidenceContext } from './headerEvidence';
import { headerEvidenceFixture as fixture, headerEvidenceFixtureId as id } from './headerEvidenceFixtures';

function verified(context: HeaderEvidenceContext) {
  const result = produceCustomerHeaderEvidence(context, 0);
  expect(result.status).toBe('verified');
  if (result.status !== 'verified') throw new Error(JSON.stringify(result));
  return result;
}

describe('trusted customer header evidence', () => {
  it('binds real persisted observations and exact ordered column partitions without rewriting labels', () => {
    const f = fixture(); const result = verified(f.context);
    expect(result.bindings.map(binding => binding.observedHeaderLabel)).toEqual(['Customer Description', 'Billing Rate']);
    expect(result.bindings.map(binding => binding.orderedObservationIds)).toEqual(f.headerLabels.map(label => label.source_refs.map(ref => ref.observation_id)));
    expect(result.bindings[0]).toMatchObject({ organizationId: id(1), projectId: id(2), documentId: id(3), extractionId: id(4), sourceArtifactId: id(5), physicalPageNumber: 1 });
    for (const binding of result.bindings) expect(verifyCustomerHeaderEvidence(binding, f.context)).toEqual({ status: 'verified', binding });
  });
  it('keeps source-schema identity independent of documents, artifacts, extraction IDs, coordinates and interpreted roles', () => {
    const first = fixture(), second = fixture({ seed: 100, offset: 17 });
    (second.page.header_interpretation.labels[0] as unknown as Record<string, unknown>).role = 'rate';
    expect(verified(first.context).sourceSchemaIdentity).toBe(verified(second.context).sourceSchemaIdentity);
    expect(verified(first.context).bindings).not.toEqual(verified(second.context).bindings);
  });
  it.each([{ labels: ['Other Description', 'Billing Rate'] }, { labels: ['Billing Rate', 'Customer Description'] }, { source: 'ocr_fallback' as const }])('changes identity for changed source labels, ordering or method: %j', options => {
    expect(verified(fixture(options).context).sourceSchemaIdentity).not.toBe(verified(fixture().context).sourceSchemaIdentity);
  });
  it.each(['actor', 'document', 'project', 'extraction', 'artifact'])('rejects tenant mismatch at %s', target => {
    const f = fixture();
    if (target === 'actor') (f.context as { actorOrganizationId: string }).actorOrganizationId = id(99);
    else (f.context[target as 'document' | 'project' | 'extraction' | 'artifact'] as { organization_id: string }).organization_id = id(99);
    expect(produceCustomerHeaderEvidence(f.context, 0)).toEqual({ status: 'rejected', reason: 'tenant_mismatch' });
  });
  it.each(['project', 'extraction', 'artifact'])('rejects owner mismatch at %s', target => {
    const f = fixture();
    if (target === 'project') f.context.project.id = id(99);
    if (target === 'extraction') f.context.extraction.document_id = id(99);
    if (target === 'artifact') f.context.artifact.source_document_id = id(99);
    expect(produceCustomerHeaderEvidence(f.context, 0)).toEqual({ status: 'rejected', reason: 'ownership_mismatch' });
  });
  it.each(['inherited_header', 'header_semantics', 'table_segment'])('rejects unsupported %s authority', key => {
    const f = fixture(); (f.page as Record<string, unknown>)[key] = {};
    expect(produceCustomerHeaderEvidence(f.context, 0)).toEqual({ status: 'rejected', reason: 'unsupported_header' });
  });
  it.each(['missing', 'invalid', 'duplicate'])('requires one proven coverage page digest: %s', mode => {
    const f = fixture();
    if (mode === 'missing') f.pdf.page_extraction_coverage_v1.pages = [];
    if (mode === 'invalid') f.pdf.page_extraction_coverage_v1.pages[0]!.page_representation_digest = 'invalid';
    if (mode === 'duplicate') f.pdf.page_extraction_coverage_v1.pages.push({ ...f.pdf.page_extraction_coverage_v1.pages[0]! });
    expect(produceCustomerHeaderEvidence(f.context, 0)).toEqual({ status: 'rejected', reason: 'page_digest_unproven' });
  });
  it.each(['digest', 'missing_observation', 'geometry', 'observation_id', 'metadata', 'artifact', 'missing_provenance', 'wrong_provenance'])('rejects broken persisted evidence: %s', mode => {
    const f = fixture();
    const observation = f.layer.observations[0] as unknown as Record<string, any>;
    if (mode === 'digest') f.pdf.page_extraction_coverage_v1.pages[0]!.page_representation_digest = 'b'.repeat(64);
    if (mode === 'missing_observation') f.layer.observations.splice(0, 1);
    if (mode === 'geometry') f.refs[0]!.x_max += 1;
    if (mode === 'observation_id') observation.id = `pdf:layout-token:v1:${'c'.repeat(64)}`;
    if (mode === 'metadata') observation.metadata.parser_observation_key = 'other';
    if (mode === 'artifact') f.context.artifact.id = id(99);
    if (mode === 'missing_provenance') delete observation.physical_page_coordinate;
    if (mode === 'wrong_provenance') observation.physical_page_coordinate = { ...observation.physical_page_coordinate, sourceDocumentId: id(99) };
    expect(produceCustomerHeaderEvidence(f.context, 0)).toEqual({ status: 'rejected', reason: 'header_observations_unproven' });
  });
  it.each(['unclear', 'mixed', 'partition', 'duplicate', 'text', 'overlap', 'rows'])('rejects ambiguous or changed header structure: %s', mode => {
    const f = fixture();
    if (mode === 'unclear') f.page.header_interpretation.grouping_basis.clear = false;
    if (mode === 'mixed') f.refs[0]!.source = 'ocr_fallback';
    if (mode === 'partition') f.page.header_interpretation.source_refs = [...f.refs].reverse();
    if (mode === 'duplicate') f.headerLabels[1]!.source_refs[0]!.observation_id = f.refs[0]!.observation_id;
    if (mode === 'text') f.headerLabels[0]!.text += ' changed';
    if (mode === 'overlap') f.refs[1]!.x_min = f.refs[0]!.x_min;
    if (mode === 'rows') f.refs[1]!.y_min = 120;
    expect(produceCustomerHeaderEvidence(f.context, 0).status).toBe('rejected');
  });
  it('rejects duplicate physical-page candidates and absent headers', () => {
    const f = fixture();
    const pages = f.pdf.priced_schedule_reconstruction_v1.pages as Array<(typeof f.pdf.priced_schedule_reconstruction_v1.pages)[number]>;
    pages.push(pages[0]!);
    expect(produceCustomerHeaderEvidence(f.context, 0)).toEqual({ status: 'rejected', reason: 'ambiguous_header' });
    expect(produceCustomerHeaderEvidence(fixture().context, 9).status).toBe('rejected');
  });
  it('requires persisted column indices and boundaries to match the exact header order', () => {
    const badIndex = fixture(); Object.assign(badIndex.page.columns[1]!, { column_index: 0 });
    expect(produceCustomerHeaderEvidence(badIndex.context, 0)).toEqual({ status: 'rejected', reason: 'invalid_header_structure' });
    const badBoundary = fixture(); badBoundary.page.columns[1]!.x_min = 80;
    expect(produceCustomerHeaderEvidence(badBoundary.context, 0)).toEqual({ status: 'rejected', reason: 'invalid_header_structure' });
  });
  it('rejects typed binding tampering and extra applicant fields', () => {
    const f = fixture(), binding = verified(f.context).bindings[0]!;
    expect(CustomerHeaderEvidenceBindingSchema.safeParse({ ...binding, role: 'rate' }).success).toBe(false);
    expect(verifyCustomerHeaderEvidence({ ...binding, role: 'rate' }, f.context)).toEqual({ status: 'rejected', reason: 'invalid_binding' });
    for (const change of [{ observedHeaderLabel: 'Changed' }, { extractionId: id(99) }, { sourceSha256: 'c'.repeat(64) }, { orderedObservationIds: [...binding.orderedObservationIds].reverse() }]) {
      expect(verifyCustomerHeaderEvidence({ ...binding, ...change }, f.context)).toEqual({ status: 'rejected', reason: 'binding_mismatch' });
    }
  });
  it('rejects applicant schema extras and noncontiguous structure indices', () => {
    const structure = { sourceKind: 'pdf' as const, sourceMethod: 'pdfjs' as const, interpretationFamily: 'priced_schedule_assembly_header' as const,
      headerRows: 1 as const, columns: [{ columnIndex: 0, label: 'Description', columnSpan: 1 as const }, { columnIndex: 1, label: 'Rate', columnSpan: 1 as const }] };
    expect(() => customerHeaderSchemaIdentity({ ...structure, filename: 'customer.pdf' } as typeof structure)).toThrow();
    expect(() => customerHeaderSchemaIdentity({ ...structure, columns: [...structure.columns].reverse() })).toThrow();
  });
});
