import { describe, expect, it } from 'vitest';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { pricingAuthoritativeRow } from '@/lib/extraction/pdf/pricedScheduleAuthority';
import { buildPdfLayoutObservationsLayer, resolvePdfLayoutObservationEvidence } from '@/lib/extraction/pdf/layoutObservationEvidence';
import { createPdfLayoutObservationIdentity } from '@/lib/extraction/pdf/layoutObservationIdentity';
import type { PdfLayout, PdfToken } from '@/lib/extraction/pdf/extractText';
import type { PagePricedScheduleReconstruction, PricedScheduleCell, PricedScheduleCellSourceRef, PricedSchedulePage } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

const context = { sourceDocumentId: 'document-a', sourceArtifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
function fixture() {
  const words = ['Construction demolition debris', 'Cubic Yard', '$12.00', 'reduction of vegetative debris', '50 miles'];
  const tokens: PdfToken[] = words.map((text, index) => {
    const identity = createPdfLayoutObservationIdentity({ context, physicalPageNumber: 7,
      sourceMethod: 'pdfjs', parser: 'pdfjs_text_content', parserObservationKey: `item:${index}`,
      pageRepresentationDigest: 'a'.repeat(64) });
    return { text, x: index * 100, y: 100, width: 80, height: 10, source: 'pdfjs',
      observation_id: identity.id, observation_identity: identity };
  });
  const refs: PricedScheduleCellSourceRef[] = tokens.map((token) => ({
    observation_id: token.observation_id, text: token.text, source: token.source,
    x_min: token.x, x_max: token.x + token.width, y_min: token.y, y_max: token.y + token.height,
  }));
  const cell = (role: PricedScheduleCell['role'], indexes: number[]): PricedScheduleCell => {
    const source_refs = indexes.map((i) => refs[i]!);
    return { role, source_refs, raw_text: source_refs.map((ref) => ref.text).join(' '),
      x_min: Math.min(...source_refs.map((ref) => ref.x_min)), x_max: Math.max(...source_refs.map((ref) => ref.x_max)),
      y_min: 100, y_max: 110 };
  };
  const cells = [cell('description', [0]), cell('unit', [1]), cell('rate', [2])];
  const base: PricedSchedulePage = { status: 'reconstructed', physical_page_number: 7,
    header_raw_text: 'Description Unit Rate', header_y: 120, columns: [], rejected_spines: [], unassigned_lines: [],
    rows: [{ row_index: 6, physical_page_number: 7, cells, raw_text: cells.map((c) => c.raw_text).join(' | '),
      x_min: 0, x_max: 280, y_min: 100, y_max: 110 }] };
  const enriched: PricedSchedulePage = { ...base,
    rows: [{ ...base.rows[0]!, cells: [cell('description', [0, 3]), ...cells.slice(1)],
      unresolved_role_cells: [{ ...cell('description', [4]), role: null, column_index: 3, header_text: 'Notes' }],
      raw_text: 'Construction demolition debris reduction of vegetative debris | Cubic Yard | $12.00 | 50 miles', x_max: 480 }],
    ruling_line_resolutions: [3, 4].map((i) => ({ source_ref: refs[i]!, row_index: 6, column_index: i === 3 ? 0 : 3, rule_ids: ['h1', 'h2', 'v1', 'v2'] })) };
  const layout: PdfLayout = { page_count: 7, gaps: [], pages: [{ page_number: 7,
    lines: [{ id: 'line', page_number: 7, text: words.join(' '), tokens, kind: 'table_candidate', x_min: 0, x_max: 480, y: 100, source: 'pdfjs' }] }] };
  const reconstruction = (page: PricedSchedulePage): PagePricedScheduleReconstruction => ({ parser_version: 'priced_schedule_reconstruction_v1', pages: [page] });
  return { base, enriched, refs, layout, reconstruction };
}

describe('ruling structure cannot promote pricing authority', () => {
  it('restores every pricing field and accepted anchor while preserving enriched structure and durable observations', () => {
    const f = fixture(), original = structuredClone(f.enriched);
    const oldLayer = buildPdfLayoutObservationsLayer({ layout: f.layout, reconstruction: f.reconstruction(f.base), context });
    const layer = buildPdfLayoutObservationsLayer({ layout: f.layout, reconstruction: f.reconstruction(f.enriched), context });
    const pricing = (page: PricedSchedulePage, persisted: unknown) => buildContractRateScheduleRows({ rateTable: null,
      pricedScheduleReconstruction: f.reconstruction(page), pricedScheduleLayoutObservations: persisted,
      pricedScheduleObservationContext: { ...context, totalPhysicalPages: 7 } });
    const before = pricing(f.base, oldLayer), after = pricing(f.enriched, layer);
    expect(before[0]!.canonical_category).toBe('construction_demolition');
    // This deliberately untagged control proves the added text would reclassify.
    expect(pricing({ ...f.enriched, ruling_line_resolutions: undefined }, layer)[0]!.canonical_category).toBe('management_reduction');
    expect(after).toEqual(before);
    expect(layer.observations).toHaveLength(5);
    expect(layer.closure.accepted_ref_count).toBe(3);
    expect(layer.observations.map((o) => o.id)).toContain(f.refs[3]!.observation_id);
    const accepted = resolvePdfLayoutObservationEvidence({ reconstruction: f.reconstruction(f.enriched), persistedLayer: layer,
      context: { ...context, totalPhysicalPages: 7 } });
    expect(accepted?.map((o) => o.id)).toEqual(before[0]!.source_anchor_ids);
    expect(after[0]!.pricing_cell_evidence?.flatMap((c) => c.source_observation_ids)).not.toContain(f.refs[3]!.observation_id);
    expect(f.enriched).toEqual(original);
    expect(f.enriched.rows[0]!.cells[0]!.raw_text).toContain('reduction of vegetative debris');
    expect(f.enriched.rows[0]!.raw_text).toContain('50 miles');
  });

  it('does not treat materialized, identity-bound rule evidence as reviewed promotion', () => {
    const f = fixture();
    const projected = pricingAuthoritativeRow(f.enriched, f.enriched.rows[0]!)!;
    expect(projected.cells).toEqual(f.base.rows[0]!.cells);
    expect(projected.raw_text).toBe(f.base.rows[0]!.raw_text);
    expect(projected.x_max).toBe(280);
    expect(pricingAuthoritativeRow(f.enriched, projected)).toEqual(projected);
  });

  it('keeps ordinary and unaffected rows byte-equivalent', () => {
    const f = fixture();
    expect(pricingAuthoritativeRow(f.base, f.base.rows[0]!)).toBe(f.base.rows[0]);
    const unaffected = { ...f.base.rows[0]!, row_index: 9 };
    expect(pricingAuthoritativeRow(f.enriched, unaffected)).toBe(unaffected);
  });

  it('guards every role, including unit and rate, rather than assuming additions are descriptions', () => {
    const f = fixture();
    for (const index of [1, 2]) {
      const page = { ...f.base, ruling_line_resolutions: [{ source_ref: f.refs[index]!, row_index: 6, column_index: index, rule_ids: ['h1'] }] };
      const row = pricingAuthoritativeRow(page, page.rows[0]!)!;
      expect(row.cells.some((c) => c.role === (index === 1 ? 'unit' : 'rate'))).toBe(false);
      if (index === 2) expect(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: f.reconstruction(page) })).toEqual([]);
    }
  });

  it('cannot promote a rule observation by restating its box or row index', () => {
    const f = fixture();
    const page = { ...f.enriched, ruling_line_resolutions: f.enriched.ruling_line_resolutions!.map((r) => ({ ...r, row_index: 99, source_ref: { ...r.source_ref, x_min: -20 } })) };
    expect(pricingAuthoritativeRow(page, page.rows[0]!)!.cells).toEqual(f.base.rows[0]!.cells);
  });

  it('abstains when excluded evidence supplied a structured amount even if marker ink remains', () => {
    const f = fixture(), rate = f.base.rows[0]!.cells[2]!;
    const page: PricedSchedulePage = { ...f.base,
      rows: [{ ...f.base.rows[0]!, cells: [...f.base.rows[0]!.cells.slice(0, 2), { ...rate,
        source_refs: [f.refs[2]!, f.refs[3]!], structured_rate: { derivation: 'structured_numeric_rate',
          amount_text: '12.00', amount_source_ref: f.refs[2]!, marker_source_ref: f.refs[3]! } }] }],
      ruling_line_resolutions: [{ source_ref: f.refs[2]!, row_index: 6, column_index: 2, rule_ids: ['h1'] }] };
    expect(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: f.reconstruction(page) })).toEqual([]);
  });

  it('fails closed for incomplete or duplicate provenance instead of promoting words', () => {
    const f = fixture();
    for (const resolutions of [{}, [], [null], [f.enriched.ruling_line_resolutions![0], f.enriched.ruling_line_resolutions![0]]]) {
      const page = { ...f.enriched, ruling_line_resolutions: resolutions } as unknown as PricedSchedulePage;
      expect(pricingAuthoritativeRow(page, page.rows[0]!)).toBeNull();
      expect(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: f.reconstruction(page) })).toEqual([]);
      expect(() => buildPdfLayoutObservationsLayer({ layout: f.layout, reconstruction: f.reconstruction(page), context })).not.toThrow();
    }
    const missing = { ...f.enriched, ruling_line_resolutions: undefined, ruling_line_evidence: {} } as PricedSchedulePage;
    expect(pricingAuthoritativeRow(missing, missing.rows[0]!)).toBeNull();
  });
});
