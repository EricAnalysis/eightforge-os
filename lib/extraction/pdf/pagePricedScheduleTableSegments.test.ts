import { describe, expect, it } from 'vitest';

import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import type { PdfLayout, PdfLayoutLine, PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  buildPagePricedScheduleReconstruction,
  type PricedScheduleRow,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * v4 same-page table segments. A page printing more than one independently
 * qualifying priced-table header is read one table per header: each segment
 * only against its own header, each failing closed on its own. Every fixture is
 * synthetic.
 */

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

/** Description | Unit | Unit Price, at the usual positions. */
const headerA = (page: number, y: number) => line(page, y, [
  { x: 50, text: 'Description', width: 70 },
  { x: 200, text: 'Unit', width: 30 },
  { x: 450, text: 'Unit Price', width: 60 },
]);
/** A row under header A: description at 50, unit at 200, rate at 450. */
const rowA = (page: number, y: number, description: string, unit: string, amount: string) => line(page, y, [
  { x: 50, text: description, width: 100 },
  { x: 200, text: unit, width: 30 },
  { x: 450, text: '$', width: 8 },
  { x: 470, text: amount, width: 40 },
]);
/** The same roles in another order: Unit | Description | Rate. */
const headerB = (page: number, y: number) => line(page, y, [
  { x: 50, text: 'Unit', width: 30 },
  { x: 200, text: 'Description', width: 70 },
  { x: 450, text: 'Rate', width: 30 },
]);
/** A row under header B: unit at 50, description at 200. */
const rowB = (page: number, y: number, unit: string, description: string, amount: string) => line(page, y, [
  { x: 50, text: unit, width: 30 },
  { x: 200, text: description, width: 100 },
  { x: 450, text: '$', width: 8 },
  { x: 470, text: amount, width: 40 },
]);

const page = (pageNumber: number, lines: readonly PdfLayoutLine[]): PdfLayoutPage =>
  ({ page_number: pageNumber, width: 612, height: 792, lines: [...lines] });
const layoutOf = (pages: readonly PdfLayoutPage[]): PdfLayout =>
  ({ page_count: Math.max(...pages.map((entry) => entry.page_number)), gaps: [], pages: [...pages] });
const reconstruct = (pages: readonly PdfLayoutPage[]) => buildPagePricedScheduleReconstruction({ layout: layoutOf(pages) });
const roles = (row: PricedScheduleRow) => row.cells.map((cell) => [cell.role, cell.raw_text]);

describe('same-page table segments (v4)', () => {
  it('1: reads two identical qualifying headers as two tables, with unique row indexes and segment provenance', () => {
    const result = reconstruct([page(10, [
      headerA(10, 720),
      rowA(10, 700, 'Alpha service', 'Ton', '1.00'),
      rowA(10, 680, 'Beta service', 'Ton', '2.00'),
      headerA(10, 600),
      rowA(10, 580, 'Gamma service', 'Load', '3.00'),
      rowA(10, 560, 'Delta service', 'Load', '4.00'),
    ])]);
    expect(result.unresolved_pages).toBeUndefined();
    expect(result.pages.map((entry) => [entry.physical_page_number, entry.header_y, entry.rows.map((row) => row.row_index)]))
      .toEqual([[10, 720, [0, 1]], [10, 600, [2, 3]]]);
    expect(result.pages.map((entry) => entry.table_segment)).toEqual([
      { status: 'same_page_segment', segment_index: 0, segment_count: 2, header_y: 720,
        header_observation_ids: ['obs:p10:720:0', 'obs:p10:720:1', 'obs:p10:720:2'], lower_boundary_y: 600 },
      { status: 'same_page_segment', segment_index: 1, segment_count: 2, header_y: 600,
        header_observation_ids: ['obs:p10:600:0', 'obs:p10:600:1', 'obs:p10:600:2'], lower_boundary_y: null },
    ]);
    // Every row names the segment, and the header, that governed it.
    for (const entry of result.pages) {
      expect(entry.rows.every((row) => row.table_segment === entry.table_segment)).toBe(true);
      expect(entry.columns.flatMap((column) => column.header_source_refs ?? []).every((ref) => ref.y_min === entry.header_y))
        .toBe(true);
    }
    expect(result.pages[1]!.rows.map(roles)).toEqual([
      [['description', 'Gamma service'], ['unit', 'Load'], ['rate', '$ 3.00']],
      [['description', 'Delta service'], ['unit', 'Load'], ['rate', '$ 4.00']],
    ]);
    // Canonical rate rows stay distinct and carry the segment.
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: result });
    expect(rows.map((row) => [row.row_id, row.description, row.table_segment?.segment_index])).toEqual([
      ['page_priced_schedule:p10:r0', 'Alpha service', 0], ['page_priced_schedule:p10:r1', 'Beta service', 0],
      ['page_priced_schedule:p10:r2', 'Gamma service', 1], ['page_priced_schedule:p10:r3', 'Delta service', 1],
    ]);
  });

  it('2 + 4: a second header with a different column order governs its own rows only', () => {
    const result = reconstruct([page(10, [
      headerA(10, 720),
      rowA(10, 700, 'Alpha service', 'Ton', '1.00'),
      rowA(10, 680, 'Beta service', 'Ton', '2.00'),
      headerB(10, 600),
      rowB(10, 580, 'Load', 'Gamma service', '3.00'),
      rowB(10, 560, 'Load', 'Delta service', '4.00'),
    ])]);
    expect(result.pages.map((entry) => entry.columns.map((column) => [column.header_text, column.role]))).toEqual([
      [['Description', 'description'], ['Unit', 'unit'], ['Unit Price', 'rate']],
      [['Unit', 'unit'], ['Description', 'description'], ['Rate', 'rate']],
    ]);
    // Read through header A, "Load" would be the description. Under its own header it is the unit.
    expect(result.pages[1]!.rows.map(roles)).toEqual([
      [['unit', 'Load'], ['description', 'Gamma service'], ['rate', '$ 3.00']],
      [['unit', 'Load'], ['description', 'Delta service'], ['rate', '$ 4.00']],
    ]);
    expect(result.pages[0]!.rows.map(roles)).toEqual([
      [['description', 'Alpha service'], ['unit', 'Ton'], ['rate', '$ 1.00']],
      [['description', 'Beta service'], ['unit', 'Ton'], ['rate', '$ 2.00']],
    ]);
  });

  it('3: a second header with different supported labels, including a supporting role, keeps its own roles', () => {
    const result = reconstruct([page(10, [
      headerA(10, 720),
      rowA(10, 700, 'Alpha service', 'Ton', '1.00'),
      rowA(10, 680, 'Beta service', 'Ton', '2.00'),
      line(10, 600, [
        { x: 50, text: 'Personnel Description', width: 110 },
        { x: 200, text: 'Units', width: 30 },
        { x: 300, text: 'Category', width: 50 },
        { x: 450, text: 'Rate', width: 30 },
      ]),
      line(10, 580, [{ x: 50, text: 'Foreman', width: 60 }, { x: 200, text: 'Hour', width: 30 },
        { x: 300, text: 'Labor', width: 30 }, { x: 450, text: '$', width: 8 }, { x: 470, text: '55.00', width: 40 }]),
      line(10, 560, [{ x: 50, text: 'Laborer', width: 60 }, { x: 200, text: 'Hour', width: 30 },
        { x: 300, text: 'Labor', width: 30 }, { x: 450, text: '$', width: 8 }, { x: 470, text: '35.00', width: 40 }]),
    ])]);
    const second = result.pages[1]!;
    expect(second.columns.map((column) => [column.header_text, column.role])).toEqual([
      ['Personnel Description', 'description'], ['Units', 'unit'], ['Category', 'category'], ['Rate', 'rate'],
    ]);
    expect(second.rows.map(roles)).toEqual([
      [['description', 'Foreman'], ['unit', 'Hour'], ['rate', '$ 55.00']],
      [['description', 'Laborer'], ['unit', 'Hour'], ['rate', '$ 35.00']],
    ]);
    // The supporting column stays on the role-less path, as on any single-table page.
    expect(second.rows.map((row) => row.unresolved_role_cells?.map((cell) => cell.raw_text))).toEqual([['Labor'], ['Labor']]);
  });

  it('5: a later header that does not qualify still ends the only qualifying table and fails the page closed', () => {
    const result = reconstruct([page(10, [
      headerA(10, 720),
      rowA(10, 700, 'Alpha service', 'Ton', '1.00'),
      rowA(10, 680, 'Beta service', 'Ton', '2.00'),
      line(10, 600, [{ x: 50, text: 'UOM', width: 30 }, { x: 200, text: 'Item / Service', width: 80 },
        { x: 450, text: 'Unit Price', width: 50 }]),
      rowA(10, 580, 'Each', 'Gamma service', '3.00'),
      rowA(10, 560, 'Each', 'Delta service', '4.00'),
    ])]);
    expect(result.pages).toEqual([]);
    expect(result.unresolved_pages).toMatchObject([{ reason: 'unresolved_later_header', physical_page_number: 10 }]);
    expect(result.unresolved_pages![0]!.table_segment).toBeUndefined();
  });

  it('6: an unsafe segment fails closed alone; its rows are never read under another segment\'s header', () => {
    const result = reconstruct([page(10, [
      headerA(10, 760),
      rowA(10, 740, 'Alpha service', 'Ton', '1.00'),
      rowA(10, 720, 'Beta service', 'Ton', '2.00'),
      headerB(10, 640),
      rowB(10, 620, 'Load', 'Gamma service', '3.00'),
      rowB(10, 600, 'Load', 'Delta service', '4.00'),
      // Inside the second segment: a header that does not qualify, above priced lines of its own.
      line(10, 520, [{ x: 50, text: 'UOM', width: 30 }, { x: 200, text: 'Item / Service', width: 80 },
        { x: 450, text: 'Unit Price', width: 50 }]),
      rowB(10, 500, 'Each', 'Epsilon service', '5.00'),
      rowB(10, 480, 'Each', 'Zeta service', '6.00'),
    ])]);
    // The first segment is unaffected.
    expect(result.pages.map((entry) => [entry.table_segment?.segment_index, entry.rows.map((row) => row.row_index)]))
      .toEqual([[0, [0, 1]]]);
    expect(result.pages[0]!.rows.map((row) => row.raw_text)).toEqual(['Alpha service | Ton | $ 1.00', 'Beta service | Ton | $ 2.00']);
    // The second segment is recorded whole, with its own reason, header lines and priced lines only.
    expect(result.unresolved_pages).toHaveLength(1);
    const unresolved = result.unresolved_pages![0]!;
    expect(unresolved).toMatchObject({ reason: 'unresolved_later_header', physical_page_number: 10,
      table_segment: { segment_index: 1, segment_count: 2, header_y: 640, lower_boundary_y: null } });
    expect(unresolved.header_lines.map((entry) => entry.y)).toEqual([640, 520]);
    expect(unresolved.priced_lines.map((entry) => entry.y)).toEqual([620, 600, 500, 480]);
  });

  it('6b: the bottom segment\'s header carries to a headerless next page; a failed bottom segment carries nothing', () => {
    const continuation = page(11, [
      rowB(11, 760, 'Load', 'Eta service', '7.00'),
      rowB(11, 740, 'Load', 'Theta service', '8.00'),
      rowB(11, 720, 'Load', 'Iota service', '9.00'),
    ]);
    const two = page(10, [
      headerA(10, 720), rowA(10, 700, 'Alpha service', 'Ton', '1.00'), rowA(10, 680, 'Beta service', 'Ton', '2.00'),
      headerB(10, 600), rowB(10, 580, 'Load', 'Gamma service', '3.00'), rowB(10, 560, 'Load', 'Delta service', '4.00'),
    ]);
    const result = reconstruct([two, continuation]);
    const inherited = result.pages.find((entry) => entry.physical_page_number === 11)!;
    expect(inherited.inherited_header).toMatchObject({ source_page: 10, carried_from_page: 10, continuation_page: 11,
      source_header_observation_ids: ['obs:p10:600:0', 'obs:p10:600:1', 'obs:p10:600:2'] });
    expect(inherited.table_segment).toBeUndefined();
    expect(inherited.rows.map(roles)[0]).toEqual([['unit', 'Load'], ['description', 'Eta service'], ['rate', '$ 7.00']]);

    const failedBottom = page(10, [
      headerA(10, 760), rowA(10, 740, 'Alpha service', 'Ton', '1.00'), rowA(10, 720, 'Beta service', 'Ton', '2.00'),
      headerB(10, 640), rowB(10, 620, 'Load', 'Gamma service', '3.00'), rowB(10, 600, 'Load', 'Delta service', '4.00'),
      line(10, 520, [{ x: 50, text: 'UOM', width: 30 }, { x: 200, text: 'Item / Service', width: 80 },
        { x: 450, text: 'Unit Price', width: 50 }]),
      rowB(10, 500, 'Each', 'Epsilon service', '5.00'), rowB(10, 480, 'Each', 'Zeta service', '6.00'),
    ]);
    const refused = reconstruct([failedBottom, continuation]);
    expect(refused.pages.some((entry) => entry.physical_page_number === 11)).toBe(false);
    expect(refused.unresolved_pages!.map((entry) => [entry.physical_page_number, entry.reason])).toEqual([
      [10, 'unresolved_later_header'], [11, 'header_not_found'],
    ]);
  });

  it('7: a single-header page carries no segment provenance and is read as before', () => {
    const result = reconstruct([page(10, [
      headerA(10, 720), rowA(10, 700, 'Alpha service', 'Ton', '1.00'), rowA(10, 680, 'Beta service', 'Ton', '2.00'),
    ])]);
    expect(result.pages).toHaveLength(1);
    expect('table_segment' in result.pages[0]!).toBe(false);
    expect(result.pages[0]!.rows.every((row) => !('table_segment' in row))).toBe(true);
    expect(result.pages[0]!.rows.map((row) => row.row_index)).toEqual([0, 1]);
  });

  it('8: the frozen spacing_only path never segments', () => {
    const frozen = buildPagePricedScheduleReconstruction({ layout: layoutOf([page(10, [
      headerA(10, 720), rowA(10, 700, 'Alpha service', 'Ton', '1.00'), rowA(10, 680, 'Beta service', 'Ton', '2.00'),
      headerA(10, 600), rowA(10, 580, 'Gamma service', 'Load', '3.00'), rowA(10, 560, 'Delta service', 'Load', '4.00'),
    ])]), continuationEvidence: 'spacing_only' });
    expect(frozen).toEqual({ parser_version: 'priced_schedule_reconstruction_v1', pages: [] });
  });

  it('two qualifying headers on one line cannot be split and still fail closed', () => {
    const shared = (y: number) => [
      line(10, y, [{ x: 20, text: 'Description', width: 60 }, { x: 100, text: 'Unit', width: 25 }, { x: 160, text: 'Rate', width: 25 }]),
      line(10, y, [{ x: 320, text: 'Description', width: 60 }, { x: 400, text: 'Unit', width: 25 }, { x: 460, text: 'Rate', width: 25 }]),
    ];
    const result = reconstruct([page(10, [
      ...shared(720),
      line(10, 700, [{ x: 20, text: 'Alpha', width: 40 }, { x: 100, text: 'Ton', width: 20 }, { x: 160, text: '$', width: 8 },
        { x: 170, text: '1.00', width: 25 }]),
      line(10, 680, [{ x: 20, text: 'Beta', width: 40 }, { x: 100, text: 'Ton', width: 20 }, { x: 160, text: '$', width: 8 },
        { x: 170, text: '2.00', width: 25 }]),
    ])]);
    expect(result.pages).toEqual([]);
    expect(result.unresolved_pages).toMatchObject([{ reason: 'multiple_priced_headers', physical_page_number: 10 }]);
  });
});
