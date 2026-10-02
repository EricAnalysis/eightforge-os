import { describe, expect, it } from 'vitest';
import { buildContractRateScheduleRows, buildContractRateScheduleRowsWithDiagnostics } from '@/lib/contracts/contractRateScheduleRows';
import { pricingAuthoritativeRow, pricingAuthorityDiagnostics } from '@/lib/extraction/pdf/pricedScheduleAuthority';
import { buildPdfLayoutObservationsLayer, resolvePdfLayoutObservationEvidence, resolvePdfLayoutObservationEvidenceByRow } from '@/lib/extraction/pdf/layoutObservationEvidence';
import { buildRulingLineInput, type RulingLineRule } from '@/lib/extraction/pdf/rulingLineEvidence';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { createPdfLayoutObservationIdentity } from '@/lib/extraction/pdf/layoutObservationIdentity';
import type { PdfLayout, PdfToken } from '@/lib/extraction/pdf/extractText';
import type { PagePricedScheduleReconstruction, PricedScheduleCell, PricedScheduleCellSourceRef, PricedSchedulePage } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

const context = { sourceDocumentId: 'document-a', sourceArtifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
function evidence() {
  const initial = buildRulingLineInput({ sourceSha256: 'a'.repeat(64), renderSha256: 'b'.repeat(64),
    physicalPageNumber: 7, width: 500, height: 200, rgba: new Uint8Array(500 * 200 * 4) }).evidence;
  const rules: RulingLineRule[] = ['h1', 'h2', 'v1', 'v2'].map((id) => ({ id, axis: id.startsWith('h') ? 'h' : 'v',
    start: 0, end: 100, slope: 0, intercept: 10, thickness: 1, residual: 0, runCount: 1, runInkDensity: 1,
    fittedInkContinuity: 1, grid: true, junctionIds: [] }));
  const grids = [{ ruleIds: rules.map(rule => rule.id), horizontal: 2, vertical: 2 }];
  const { evidence_digest: _digest, ...old } = initial;
  const bound = { ...old, rules, grids, geometry_digest: hashCanonical({ detector_version: old.detector_version,
    width: old.width, height: old.height, rules, grids }) };
  return { ...bound, evidence_digest: hashCanonical(bound) };
}
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
    header_raw_text: 'Description Unit Rate', header_y: 120,
    columns: ['description', 'unit', 'rate', null].map((role) => ({ role: role as PricedScheduleCell['role'] | null,
      header_text: role ?? 'Notes', x_min: null, x_max: null })), rejected_spines: [], unassigned_lines: [],
    rows: [{ row_index: 6, physical_page_number: 7, cells, raw_text: cells.map((c) => c.raw_text).join(' | '),
      x_min: 0, x_max: 280, y_min: 100, y_max: 110 }] };
  const enriched: PricedSchedulePage = { ...base,
    rows: [{ ...base.rows[0]!, cells: [cell('description', [0, 3]), ...cells.slice(1)],
      unresolved_role_cells: [{ ...cell('description', [4]), role: null, column_index: 3, header_text: 'Notes' }],
      raw_text: 'Construction demolition debris reduction of vegetative debris | Cubic Yard | $12.00 | 50 miles', x_max: 480 }],
    ruling_line_evidence: evidence(),
    ruling_line_resolutions: [3, 4].map((i) => ({ source_ref: refs[i]!, row_index: 6, column_index: i === 3 ? 0 : 3, rule_ids: ['h1', 'h2', 'v1', 'v2'] })) };
  const signed = { ...enriched, ruling_line_resolution_digest: hashCanonical({ evidence_digest: enriched.ruling_line_evidence!.evidence_digest,
    resolutions: enriched.ruling_line_resolutions }) };
  const layout: PdfLayout = { page_count: 7, gaps: [], pages: [{ page_number: 7,
    lines: [{ id: 'line', page_number: 7, text: words.join(' '), tokens, kind: 'table_candidate', x_min: 0, x_max: 480, y: 100, source: 'pdfjs' }] }] };
  const reconstruction = (page: PricedSchedulePage): PagePricedScheduleReconstruction => ({ parser_version: 'priced_schedule_reconstruction_v2', pages: [page] });
  return { base, enriched: signed, refs, layout, reconstruction };
}

describe('ruling structure cannot promote pricing authority', () => {
  it.each(['priced_schedule_reconstruction_v1', 'priced_schedule_reconstruction_v2'] as const)(
    'keeps valid %s records readable without rewriting historical metadata', (parser_version) => {
      const f = fixture(), page = { ...f.enriched, ...(parser_version.endsWith('v1') ? { ruling_line_resolution_digest: undefined } : {}) };
      const original = structuredClone(page), reconstruction = { ...f.reconstruction(page), parser_version };
      const result = buildContractRateScheduleRowsWithDiagnostics({ rateTable: null, pricedScheduleReconstruction: reconstruction });
      expect(result.diagnostics).toEqual([]);
      expect(result.rows).toEqual(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: f.reconstruction(f.base) }));
      expect(page).toEqual(original);
    });

  it.each([
    ['missing_resolutions', (page: PricedSchedulePage) => ({ ...page, ruling_line_resolutions: undefined })],
    ['malformed_resolutions', (page: PricedSchedulePage) => ({ ...page, ruling_line_resolutions: {} })],
    ['duplicate_resolution', (page: PricedSchedulePage) => ({ ...page, ruling_line_resolutions: [...page.ruling_line_resolutions!, page.ruling_line_resolutions![0]] })],
    ['inconsistent_resolution', (page: PricedSchedulePage) => ({ ...page, ruling_line_resolutions: page.ruling_line_resolutions!.map(r => ({ ...r, column_index: 99 })) })],
    ['missing_resolution_digest', (page: PricedSchedulePage) => ({ ...page, ruling_line_resolution_digest: undefined })],
    ['resolution_digest_mismatch', (page: PricedSchedulePage) => ({ ...page, ruling_line_resolutions: page.ruling_line_resolutions!.slice(0, 1) })],
    ['malformed_ruling_evidence', (page: PricedSchedulePage) => ({ ...page, ruling_line_evidence: { ...page.ruling_line_evidence!, physical_page_number: 8 } })],
    ['evidence_digest_mismatch', (page: PricedSchedulePage) => ({ ...page, ruling_line_evidence: { ...page.ruling_line_evidence!, render_sha256: 'c'.repeat(64) } })],
  ] as const)('emits a source/page/parser-bound diagnostic for %s without pricing', (issue, corrupt) => {
    const f = fixture(), page = corrupt(f.enriched) as PricedSchedulePage, original = structuredClone(page);
    const result = buildContractRateScheduleRowsWithDiagnostics({ rateTable: null, pricedScheduleReconstruction: f.reconstruction(page),
      pricedScheduleObservationContext: { ...context, totalPhysicalPages: 7 } });
    expect(result.rows).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'ruling_line_pricing_authority_withheld', issue,
      parser_version: 'priced_schedule_reconstruction_v2', physical_page_number: 7, page_index: 0,
      reconstruction_path: 'content_layers_v1.pdf.priced_schedule_reconstruction_v1', affected_row_indexes: [6],
      source_document_id: context.sourceDocumentId, source_artifact_id: context.sourceArtifactId,
      source_sha256: 'a'.repeat(64), pricing_withheld: true });
    expect(page).toEqual(original);
    expect(resolvePdfLayoutObservationEvidenceByRow({ reconstruction: f.reconstruction(page), persistedLayer: {},
      context: { ...context, totalPhysicalPages: 7 } })).toEqual([]);
  });

  it('validates the whole page before row binding, preserving anchors across several ruling resolutions', () => {
    const f = fixture(), another = { ...f.base.rows[0]!, row_index: 8,
      cells: f.base.rows[0]!.cells.map(c => ({ ...c, source_refs: c.source_refs.map(r => ({ ...r, observation_id: undefined, y_min: 150, y_max: 160 })) })) };
    const page = { ...f.enriched, rows: [...f.enriched.rows, another] };
    const result = buildContractRateScheduleRowsWithDiagnostics({ rateTable: null, pricedScheduleReconstruction: f.reconstruction(page),
      pricedScheduleLayoutObservations: buildPdfLayoutObservationsLayer({ layout: f.layout, reconstruction: f.reconstruction(page), context }),
      pricedScheduleObservationContext: { ...context, totalPhysicalPages: 7 } });
    expect(result.diagnostics).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.source_anchor_ids).toHaveLength(3);
    expect(result.rows[0]!.source_anchor_ids).not.toContain(f.refs[3]!.observation_id);
  });

  it.each(['null-cell', 'object-refs', 'duplicate-row', 'null-amount-ref', 'invalid-marker-ref'])(
    'diagnoses inconsistent target reconstruction (%s) rather than throwing or pricing', (shape) => {
      const f = fixture(), page = structuredClone(f.enriched);
      if (shape === 'null-cell') (page.rows[0]!.cells as unknown[])[0] = null;
      if (shape === 'object-refs') Object.assign(page.rows[0]!.cells[0]!, { source_refs: {} });
      if (shape === 'duplicate-row') Object.assign(page, { rows: [...page.rows, page.rows[0]] });
      if (shape === 'null-amount-ref' || shape === 'invalid-marker-ref') Object.assign(page.rows[0]!.cells[2]!, {
        structured_rate: { derivation: 'structured_numeric_rate', amount_text: '12.00',
          amount_source_ref: shape === 'null-amount-ref' ? null : f.refs[2],
          ...(shape === 'invalid-marker-ref' ? { marker_source_ref: {} } : {}) },
      });
      const result = buildContractRateScheduleRowsWithDiagnostics({ rateTable: null, pricedScheduleReconstruction: f.reconstruction(page) });
      expect(result.rows).toEqual([]);
      expect(result.diagnostics[0]!.issue).toBe('inconsistent_resolution');
    });

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
    expect(pricing({ ...f.enriched, ruling_line_resolutions: undefined, ruling_line_evidence: undefined,
      ruling_line_resolution_digest: undefined }, layer)[0]!.canonical_category).toBe('management_reduction');
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

  it('retains known diagnostic source identity without granting observation-binding authority', () => {
    const f = fixture(), page = { ...f.enriched, ruling_line_resolutions: undefined };
    const result = buildContractRateScheduleRowsWithDiagnostics({ rateTable: null,
      pricedScheduleReconstruction: f.reconstruction(page), pricedScheduleObservationContext: null,
      pricedScheduleDiagnosticContext: { sourceDocumentId: context.sourceDocumentId } });
    expect(result.rows).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ source_document_id: context.sourceDocumentId,
      source_artifact_id: null, issue: 'missing_resolutions' });
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
      const page = { ...f.base, ruling_line_evidence: f.enriched.ruling_line_evidence,
        ruling_line_resolutions: [{ source_ref: f.refs[index]!, row_index: 6, column_index: index, rule_ids: ['h1'] }] };
      expect(pricingAuthoritativeRow(page, page.rows[0]!)).toBeNull();
      expect(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: f.reconstruction(page) })).toEqual([]);
    }
  });

  it('cannot promote a rule observation by restating its box or row index', () => {
    const f = fixture();
    const page = { ...f.enriched, ruling_line_resolutions: f.enriched.ruling_line_resolutions!.map((r) => ({ ...r, row_index: 99, source_ref: { ...r.source_ref, x_min: -20 } })) };
    expect(pricingAuthoritativeRow(page, page.rows[0]!)).toBeNull();
    expect(pricingAuthorityDiagnostics(f.reconstruction(page))[0]!.issue).toBe('inconsistent_resolution');
  });

  it('abstains when excluded evidence supplied a structured amount even if marker ink remains', () => {
    const f = fixture(), rate = f.base.rows[0]!.cells[2]!;
    const page: PricedSchedulePage = { ...f.base, ruling_line_evidence: f.enriched.ruling_line_evidence,
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
