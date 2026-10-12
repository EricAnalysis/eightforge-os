import { describe, expect, it, vi } from 'vitest';
import * as headerEvidence from './headerEvidence';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import type { PdfLayout, PdfToken } from '@/lib/extraction/pdf/extractText';
import { buildPdfLayoutObservationsLayer } from '@/lib/extraction/pdf/layoutObservationEvidence';
import { createPdfLayoutObservationIdentity, pdfLayoutPageRepresentationDigest } from '@/lib/extraction/pdf/layoutObservationIdentity';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { produceCustomerHeaderEvidence } from './headerEvidence';
import { buildReviewedCustomerHeaderMappingRevision } from './headerMapping';
import { CustomerHeaderMappingPinSchema, prepareCustomerHeaderMappingAssignments, readCustomerHeaderMappingPinsFromExtractionData } from './headerMappingConsumption';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Mutable<T> = T extends string | number | boolean | bigint | symbol | null | undefined ? T
  : T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
function mutableClone<T>(value: T): Mutable<T> { return structuredClone(value) as Mutable<T>; }
function fixture() {
  const sourceDocumentId = id(3), sourceArtifactId = id(5);
  const digest = pdfLayoutPageRepresentationDigest(['fresh page']);
  const specs: [number, [number, string, number][]][] = [
    [700, [[50, 'Plant', 45], [99, 'Description', 55], [200, 'Unit', 20], [440, 'Unit', 20], [463, 'Price', 25]]],
    [680, [[50, 'Alpha service', 80], [200, 'Widget', 30], [445, '$12.00', 35]]],
    [660, [[50, 'Beta service', 80], [200, 'Widget', 30], [445, '$3.50', 30]]],
  ];
  const layout: PdfLayout = { page_count: 7, gaps: [], pages: [{ page_number: 7, width: 612, height: 792,
    effective_representation_digest: digest, lines: specs.map(([y, entries]) => {
      const tokens = entries.map(([x, text, width], index): PdfToken => {
        const identity = createPdfLayoutObservationIdentity({ context: { sourceDocumentId, sourceArtifactId }, physicalPageNumber: 7,
          sourceMethod: 'pdfjs', parser: 'pdfjs_text_content', parserObservationKey: `${y}:${index}`, pageRepresentationDigest: digest });
        return { text, x, y, width, height: 10, source: 'pdfjs', observation_id: identity.id, observation_identity: identity };
      });
      return { id: `line:${y}`, page_number: 7, y, text: tokens.map(token => token.text).join(' '),
        kind: 'table_candidate', x_min: 50, x_max: 490, tokens };
    }) }] };
  const baseline = buildPagePricedScheduleReconstruction({ layout });
  const observations = buildPdfLayoutObservationsLayer({ layout, reconstruction: baseline, context: { sourceDocumentId, sourceArtifactId } });
  const data = { extraction: { content_layers_v1: { source_kind: 'pdf', pdf: { priced_schedule_reconstruction_v1: baseline,
    layout_observations_v1: observations, page_extraction_coverage_v1: { pages: [{ page_number: 7, page_representation_digest: digest }] } } } } };
  const evidence = produceCustomerHeaderEvidence({ actorOrganizationId: id(1),
    document: { id: sourceDocumentId, organization_id: id(1), project_id: id(2), document_type: 'contract' },
    project: { id: id(2), organization_id: id(1) }, extraction: { id: id(4), organization_id: id(1), document_id: sourceDocumentId, data },
    artifact: { id: sourceArtifactId, organization_id: id(1), source_document_id: sourceDocumentId, source_sha256: 'a'.repeat(64) } }, 0);
  if (evidence.status !== 'verified') throw new Error(JSON.stringify(evidence));
  const revision = buildReviewedCustomerHeaderMappingRevision({ domain: 'eightforge.reviewed-customer-header-mapping', schemaVersion: 2,
    organizationId: id(1), revisionId: id(6), scope: { interpretationBoundary: 'priced_schedule_assembly_header',
      documentType: 'contract', sourceSchemaIdentity: evidence.sourceSchemaIdentity },
    mappings: [{ sourceLabel: 'Plant Description', targetRole: 'description', supportingEvidence: mutableClone(evidence.bindings[0]!) }],
    humanApproval: { actorId: id(7), approvedAt: '2026-10-12T01:00:00Z' }, supersedesRevisionId: null });
  const mappingContext = { organizationId: id(1), documentType: 'contract', revisions: [revision] };
  const currentPageEvidence = { 7: { pageRepresentationDigest: digest, recoveryAllowed: true } };
  return { sourceDocumentId, sourceArtifactId, layout, baseline, observations, evidence, revision, mappingContext, currentPageEvidence };
}
function assignments(f: ReturnType<typeof fixture>, overrides: Partial<Parameters<typeof prepareCustomerHeaderMappingAssignments>[0]> = {}) {
  return prepareCustomerHeaderMappingAssignments({ reconstruction: f.baseline, observations: f.observations,
    mappingContext: f.mappingContext, sourceDocumentId: f.sourceDocumentId, sourceArtifactId: f.sourceArtifactId,
    currentPageEvidence: f.currentPageEvidence, ...overrides });
}
function apply(f: ReturnType<typeof fixture>, selected = assignments(f), overrides: Partial<Parameters<typeof buildPagePricedScheduleReconstruction>[0]> = {}) {
  return buildPagePricedScheduleReconstruction({ layout: f.layout, currentPageEvidence: f.currentPageEvidence, customerHeaderMappings: selected, ...overrides });
}

describe('active customer mappings at deterministic interpretation', () => {
  it('abstains from unsupported structural schemas and rejected pin shapes without failing extraction', () => {
    const f = fixture();
    const schemaProducer = vi.spyOn(headerEvidence, 'customerHeaderSchemaIdentity').mockImplementationOnce(() => {
      throw new Error('unsupported_header_shape');
    });
    try { expect(apply(f, assignments(f))).toEqual(f.baseline); }
    finally { schemaProducer.mockRestore(); }
    const rejectedPin = CustomerHeaderMappingPinSchema.safeParse({});
    const pinParser = vi.spyOn(CustomerHeaderMappingPinSchema, 'safeParse').mockReturnValueOnce(rejectedPin);
    try { expect(apply(f, assignments(f))).toEqual(f.baseline); }
    finally { pinParser.mockRestore(); }
  });
  it('bounds pin evidence without normalizing exact labels', () => {
    const pin = assignments(fixture())[0]!.pins[0]!;
    expect(CustomerHeaderMappingPinSchema.safeParse(pin).success).toBe(true);
    for (const field of ['documentType', 'sourceLabel']) {
      expect(CustomerHeaderMappingPinSchema.safeParse({ ...pin, [field]: ' '.repeat(2) }).success).toBe(false);
      expect(CustomerHeaderMappingPinSchema.safeParse({ ...pin, [field]: 'x'.repeat(513) }).success).toBe(false);
    }
    expect(CustomerHeaderMappingPinSchema.safeParse({ ...pin,
      orderedObservationIds: Array.from({ length: 201 }, (_, index) => `pdf:layout-token:v1:${index.toString(16).padStart(64, '0')}`) }).success).toBe(false);
  });
  it('uses fresh exact schema evidence, preserving authored text and normal pricing admission', () => {
    const f = fixture(), selected = assignments(f), mapped = apply(f, selected);
    expect(selected).toHaveLength(1);
    expect(mapped.pages[0]?.semantic_status).toBeUndefined();
    expect(mapped.pages[0]?.header_interpretation).toEqual(f.baseline.pages[0]?.header_interpretation);
    expect(mapped.pages[0]?.customer_header_mapping_pins).toMatchObject([{ revisionId: f.revision.revisionId,
      digest: f.revision.digest, sourceSchemaIdentity: f.evidence.sourceSchemaIdentity, sourceLabel: 'Plant Description' }]);
    expect(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: mapped }).map(row =>
      [row.description, row.unit, row.rate])).toEqual([['Alpha service', 'Widget', 12], ['Beta service', 'Widget', 3.5]]);
    expect(readCustomerHeaderMappingPinsFromExtractionData({ extraction: { content_layers_v1: { pdf: {
      priced_schedule_reconstruction_v1: mapped } } } })).toEqual(mapped.pages[0]!.customer_header_mapping_pins);
    expect(Object.isFrozen(selected[0]!.pins[0]!.orderedObservationIds)).toBe(true);
  });
  it('leaves absent/empty mapping output exactly unchanged', () => {
    const f = fixture();
    expect(assignments(f, { mappingContext: { ...f.mappingContext, revisions: [] } })).toEqual([]);
    expect(apply(f, [])).toEqual(f.baseline);
    expect(buildPagePricedScheduleReconstruction({ layout: f.layout })).toEqual(f.baseline);
  });
  it('rejects wrong tenant, document type, altered digest and duplicate snapshot identity', () => {
    const f = fixture();
    for (const mappingContext of [{ ...f.mappingContext, organizationId: id(99) }, { ...f.mappingContext, documentType: 'invoice' },
      { ...f.mappingContext, revisions: [{ ...f.revision, digest: 'b'.repeat(64) }] },
      { ...f.mappingContext, revisions: [f.revision, f.revision] }]) expect(assignments(f, { mappingContext })).toEqual([]);
  });
  it('does not apply stale or untrusted page evidence or frozen legacy behavior', () => {
    const f = fixture(), selected = assignments(f);
    expect(assignments(f, { currentPageEvidence: { 7: { pageRepresentationDigest: 'b'.repeat(64), recoveryAllowed: true } } })).toEqual([]);
    expect(assignments(f, { currentPageEvidence: { 7: { pageRepresentationDigest: f.currentPageEvidence[7].pageRepresentationDigest, recoveryAllowed: false } } })).toEqual([]);
    expect(apply(f, selected, { currentPageEvidence: {} })).toEqual(f.baseline);
    expect(apply(f, selected, { continuationEvidence: 'spacing_only' })).toEqual(buildPagePricedScheduleReconstruction({ layout: f.layout, continuationEvidence: 'spacing_only' }));
  });
  it('rejects ambiguous label overlaps, duplicate role results and changed source labels', () => {
    const f = fixture();
    const { digest, ...envelope } = mutableClone(f.revision);
    expect(digest).toBe(f.revision.digest);
    const second = buildReviewedCustomerHeaderMappingRevision({ ...envelope, revisionId: id(8) });
    expect(assignments(f, { mappingContext: { ...f.mappingContext, revisions: [f.revision, second] } })).toEqual([]);
    const wrongRole = buildReviewedCustomerHeaderMappingRevision({ ...envelope,
      mappings: [{ ...envelope.mappings[0]!, targetRole: 'unit' }] });
    expect(apply(f, assignments(f, { mappingContext: { ...f.mappingContext, revisions: [wrongRole] } }))).toEqual(f.baseline);
    const changed = mutableClone(f.baseline);
    changed.pages[0]!.columns[0]!.header_text = 'Other Description';
    expect(assignments(f, { reconstruction: changed })).toEqual([]);
  });
  it('does not reuse human-selected, inherited or segmented headers or conflicting current assignments', () => {
    const f = fixture();
    for (const key of ['header_semantics', 'inherited_header', 'table_segment']) {
      const reconstruction = mutableClone(f.baseline); Object.assign(reconstruction.pages[0]!, { [key]: {} });
      expect(assignments(f, { reconstruction })).toEqual([]);
    }
    const selected = assignments(f);
    expect(apply(f, [selected[0]!, selected[0]!])).toEqual(f.baseline);
    const changed = mutableClone(selected); changed[0]!.columns[0]!.orderedObservationIds.reverse();
    expect(apply(f, changed)).toEqual(f.baseline);
  });
  it('never carries mapped roles into a headerless following page', () => {
    const f = fixture(), selected = assignments(f);
    const next = structuredClone(f.layout.pages[0]!); next.page_number = 8; next.lines = next.lines.slice(1);
    const layout = { ...f.layout, page_count: 8, pages: [...f.layout.pages, next] };
    const mapped = apply(f, selected, { layout });
    expect(mapped.pages[0]?.customer_header_mapping_pins).toHaveLength(1);
    expect(mapped.pages.some(page => page.inherited_header)).toBe(false);
  });
  it('fails closed when persisted mapping pins acquire competing page, column or source scope', () => {
    const f = fixture(), mapped = apply(f);
    const data = { extraction: { content_layers_v1: { pdf: { priced_schedule_reconstruction_v1: mapped } } } };
    for (const mode of ['duplicate_page', 'duplicate_column', 'inherited_header', 'header_semantics', 'table_segment', 'label', 'observations', 'source_schema']) {
      const broken = mutableClone(data), reconstruction = broken.extraction.content_layers_v1.pdf.priced_schedule_reconstruction_v1;
      const page = reconstruction.pages[0]!;
      if (mode === 'duplicate_page') (reconstruction.pages as unknown[]).push(structuredClone(reconstruction.pages[0]!));
      else if (mode === 'duplicate_column') page.customer_header_mapping_pins!.push({ ...page.customer_header_mapping_pins![0]! });
      else if (['inherited_header', 'header_semantics', 'table_segment'].includes(mode)) Object.assign(page, { [mode]: {} });
      else if (mode === 'label') page.columns[0]!.header_text = 'Other';
      else if (mode === 'observations') page.customer_header_mapping_pins![0]!.orderedObservationIds.reverse();
      else {
        const second = { ...page.customer_header_mapping_pins![0]!, columnIndex: 1, sourceLabel: page.columns[1]!.header_text,
          orderedObservationIds: page.columns[1]!.header_source_refs!.map(ref => ref.observation_id!),
          sourceSchemaIdentity: 'customer-header-schema-v1:' + 'a'.repeat(64) };
        page.customer_header_mapping_pins!.push(second);
      }
      expect(readCustomerHeaderMappingPinsFromExtractionData(broken), mode).toEqual([]);
    }
  });
});
