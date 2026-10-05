import { describe, expect, it } from 'vitest';

import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import type { PdfLayout, PdfLayoutLine, PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * v3 cross-page reuse of a proven header/layout signature. A page with no
 * header of its own may read its rows under the header printed on the
 * immediately preceding page, only when its own geometry proves the same
 * layout. Every fixture is synthetic.
 */

const DESCRIPTION_X = 50;
const UNIT_X = 200;
const CURRENCY_X = 450;
const AMOUNT_X = 470;

type Spec = { x: number; text: string; width?: number };

function line(page: number, y: number, specs: readonly Spec[]): PdfLayoutLine {
  const tokens: PdfToken[] = specs.map((spec, index) => ({
    text: spec.text, x: spec.x, y, width: spec.width ?? Math.max(8, spec.text.length * 5), height: 10,
    source: 'pdfjs', observation_id: `obs:p${page}:${y}:${index}` as PdfToken['observation_id'],
  }));
  return {
    id: `line:p${page}:y${y}`, page_number: page, text: tokens.map((token) => token.text).join(' '), tokens,
    kind: 'table_candidate', x_min: Math.min(...tokens.map((token) => token.x)),
    x_max: Math.max(...tokens.map((token) => token.x + token.width)), y,
  };
}

const header = (page: number, y = 720) => line(page, y, [
  { x: DESCRIPTION_X, text: 'Description', width: 70 },
  { x: UNIT_X, text: 'Unit', width: 30 },
  { x: CURRENCY_X, text: 'Unit Price', width: 60 },
]);
const priced = (page: number, y: number, description: string, amount: string, rateX = CURRENCY_X) => line(page, y, [
  { x: DESCRIPTION_X, text: description, width: 100 },
  { x: UNIT_X, text: 'Ton', width: 20 },
  { x: rateX, text: '$', width: 8 },
  { x: rateX + 20, text: amount, width: 40 },
]);
const body = (page: number, top: number, names: readonly string[]) =>
  names.map((name, index) => priced(page, top - index * 20, `${name} service`, `${index + 1}.00`));
const page = (pageNumber: number, lines: readonly PdfLayoutLine[]): PdfLayoutPage =>
  ({ page_number: pageNumber, width: 612, height: 792, lines: [...lines] });
const layoutOf = (pages: readonly PdfLayoutPage[]): PdfLayout =>
  ({ page_count: Math.max(...pages.map((entry) => entry.page_number)), gaps: [], pages: [...pages] });
const reconstruct = (pages: readonly PdfLayoutPage[]) => buildPagePricedScheduleReconstruction({ layout: layoutOf(pages) });

const sourcePage = () => page(7, [header(7), ...body(7, 700, ['Alpha', 'Beta', 'Gamma'])]);
const continuation = (pageNumber: number, names = ['Delta', 'Epsilon', 'Zeta']) => page(pageNumber, body(pageNumber, 760, names));

describe('proven header signature reuse across continuation pages', () => {
  it('B1: reads the next headerless page under the proven header, with full provenance', () => {
    const result = reconstruct([sourcePage(), continuation(8)]);
    const [own, inherited] = result.pages;
    expect(own!.inherited_header).toBeUndefined();
    expect(own!.rows.every((row) => row.inherited_header === undefined)).toBe(true);
    expect(inherited!.physical_page_number).toBe(8);
    expect(inherited!.rows.map((row) => row.cells.map((cell) => [cell.role, cell.raw_text]))).toEqual([
      [['description', 'Delta service'], ['unit', 'Ton'], ['rate', '$ 1.00']],
      [['description', 'Epsilon service'], ['unit', 'Ton'], ['rate', '$ 2.00']],
      [['description', 'Zeta service'], ['unit', 'Ton'], ['rate', '$ 3.00']],
    ]);
    expect(inherited!.inherited_header).toMatchObject({
      status: 'carried', source_page: 7, carried_from_page: 7, continuation_page: 8,
      source_header_observation_ids: ['obs:p7:720:0', 'obs:p7:720:1', 'obs:p7:720:2'],
      proof: { priced_lines: 3, rate_markers_in_rate_column: 3, rows_published: 3, rows_withheld: 0 },
    });
    expect(inherited!.inherited_header!.signature_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(inherited!.rows.every((row) => row.inherited_header === inherited!.inherited_header)).toBe(true);
    // The page is no longer unresolved: it reads deterministically.
    expect(result.unresolved_pages).toBeUndefined();
    // Canonical rows stay distinguishable.
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: result });
    expect(rows.filter((row) => row.inherited_header).map((row) => [row.page, row.description, row.inherited_header!.source_page]))
      .toEqual([[8, 'Delta service', 7], [8, 'Epsilon service', 7], [8, 'Zeta service', 7]]);
    expect(rows.filter((row) => !row.inherited_header).map((row) => row.page)).toEqual([7, 7, 7]);
  });

  it('B2: chains page by page through proven pages and stops at the first break', () => {
    const contradicting = page(9, [
      ...body(9, 760, ['Eta', 'Theta']),
      // One rate marker in the description column: the page contradicts the carried layout.
      priced(9, 720, 'Iota service', '9.00', DESCRIPTION_X + 110),
    ]);
    const result = reconstruct([sourcePage(), continuation(8), contradicting, continuation(10, ['Kappa', 'Lambda', 'Mu'])]);
    expect(result.pages.map((entry) => [entry.physical_page_number, entry.inherited_header?.carried_from_page])).toEqual([[7, undefined], [8, 7]]);
    // The contradicting page inherits nothing, not even its compatible rows, and stays unresolved.
    // The chain is broken, so the next page is not read either.
    expect(result.unresolved_pages!.map((entry) => [entry.physical_page_number, entry.reason, entry.priced_lines.length])).toEqual([
      [9, 'header_not_found', 3], [10, 'header_not_found', 3],
    ]);
  });

  it('B3: carries the same signature down a proven chain', () => {
    const result = reconstruct([sourcePage(), continuation(8), continuation(9, ['Eta', 'Theta', 'Iota'])]);
    expect(result.pages.map((entry) => [entry.physical_page_number, entry.inherited_header?.source_page, entry.inherited_header?.carried_from_page]))
      .toEqual([[7, undefined, undefined], [8, 7, 7], [9, 7, 8]]);
    expect(result.pages[1]!.inherited_header!.signature_digest).toBe(result.pages[2]!.inherited_header!.signature_digest);
  });

  it('B4: never reuses across a gap: only the immediately following physical page', () => {
    const result = reconstruct([sourcePage(), page(8, [line(8, 700, [{ x: DESCRIPTION_X, text: 'This page is prose.', width: 200 }])]), continuation(9)]);
    expect(result.pages.map((entry) => entry.physical_page_number)).toEqual([7]);
    expect(result.unresolved_pages!.map((entry) => [entry.physical_page_number, entry.reason])).toEqual([[9, 'header_not_found']]);
    // Nor when the next physical page is absent from the layout.
    const skipped = reconstruct([sourcePage(), continuation(9)]);
    expect(skipped.pages.map((entry) => entry.physical_page_number)).toEqual([7]);
  });

  it('B5: never reuses onto a page with header evidence of its own', () => {
    // Two qualifying headers: still a multi-table page, never read under a third.
    const twoTables = page(8, [header(8, 760), ...body(8, 740, ['Delta', 'Epsilon']), header(8, 660), ...body(8, 640, ['Zeta', 'Eta'])]);
    expect(reconstruct([sourcePage(), twoTables]).unresolved_pages).toMatchObject([{ physical_page_number: 8, reason: 'multiple_priced_headers' }]);
    // Plausible but unresolved header candidates: still ambiguous.
    const short = (y: number) => line(8, y, [{ x: DESCRIPTION_X, text: 'Description', width: 70 }, { x: CURRENCY_X, text: 'Cost', width: 30 }]);
    const ambiguous = page(8, [short(760), ...body(8, 740, ['Delta', 'Epsilon']), short(680), ...body(8, 660, ['Zeta', 'Eta'])]);
    expect(reconstruct([sourcePage(), ambiguous]).unresolved_pages).toMatchObject([{ physical_page_number: 8, reason: 'ambiguous_header_candidates' }]);
    // Its own (different) header: read under its own header, never the carried one.
    const own = page(8, [line(8, 760, [{ x: DESCRIPTION_X, text: 'Description', width: 70 }, { x: UNIT_X, text: 'Units', width: 30 },
      { x: CURRENCY_X, text: 'Rate', width: 30 }]), ...body(8, 740, ['Delta', 'Epsilon'])]);
    const ownResult = reconstruct([sourcePage(), own]).pages[1]!;
    expect(ownResult.inherited_header).toBeUndefined();
    expect(ownResult.header_raw_text).toBe('Description Units Rate');
  });

  it('B6: a structurally unresolved page offers no signature', () => {
    // "Plant Description" is unknown: the page is structure only, so nothing is proven to carry.
    const unresolvedSource = page(7, [line(7, 720, [{ x: DESCRIPTION_X, text: 'Plant Description', width: 90 },
      { x: UNIT_X, text: 'Unit', width: 30 }, { x: CURRENCY_X, text: 'Unit Price', width: 60 }]), ...body(7, 700, ['Alpha', 'Beta', 'Gamma'])]);
    const result = reconstruct([unresolvedSource, continuation(8)]);
    expect(result.pages[0]!.semantic_status).toBe('unresolved');
    expect(result.pages.some((entry) => entry.inherited_header)).toBe(false);
  });

  it('B7: row integrity still applies on an inherited page, and withheld rows do not refuse the proof', () => {
    const wrapped = page(8, [
      priced(8, 760, 'Delta service and', '1.00'),
      line(8, 750, [{ x: DESCRIPTION_X, text: 'disposal', width: 50 }]),
      priced(8, 740, 'Epsilon service', '2.00'),
      priced(8, 720, 'Zeta service', '3.00'),
      priced(8, 700, 'Eta service', '4.00'),
    ]);
    const inherited = reconstruct([sourcePage(), wrapped]).pages[1]!;
    expect(inherited.inherited_header!.proof).toMatchObject({ rows_published: 2, rows_withheld: 2 });
    expect(inherited.rejected_spines.map((entry) => entry.reason)).toEqual(['ambiguous_row_continuation', 'ambiguous_row_continuation']);
    expect(inherited.unassigned_lines.map((entry) => entry.raw_text)).toEqual(['disposal']);
  });

  it('B8: the frozen spacing_only path never reuses a header', () => {
    const frozen = buildPagePricedScheduleReconstruction({ layout: layoutOf([sourcePage(), continuation(8)]), continuationEvidence: 'spacing_only' });
    expect(frozen.pages.map((entry) => entry.physical_page_number)).toEqual([7]);
  });
});
