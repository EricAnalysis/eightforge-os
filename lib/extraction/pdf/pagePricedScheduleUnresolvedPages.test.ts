import { describe, expect, it } from 'vitest';

import type { PdfLayout, PdfLayoutLine, PdfToken } from '@/lib/extraction/pdf/extractText';
import { buildPdfLayoutObservationsLayer } from '@/lib/extraction/pdf/layoutObservationEvidence';
import {
  createPdfLayoutObservationIdentity,
  pdfLayoutPageRepresentationDigest,
  type PdfLayoutObservationIdentityContext,
} from '@/lib/extraction/pdf/layoutObservationIdentity';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * Durable unresolved evidence (Forgewing resolution layer B2). A page that
 * presents priced lines but produces no reconstructed page is recorded with its
 * reason and source-backed lines instead of disappearing. Every fixture is
 * synthetic.
 */

const CONTEXT: PdfLayoutObservationIdentityContext = {
  sourceDocumentId: 'document-b2',
  sourceArtifactId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const PAGE = 7;

type Spec = { x: number; text: string; width?: number };

function token(spec: Spec, y: number): PdfToken {
  const observation_identity = createPdfLayoutObservationIdentity({
    context: CONTEXT,
    physicalPageNumber: PAGE,
    sourceMethod: 'pdfjs',
    parser: 'pdfjs_text_content',
    parserObservationKey: `item:${spec.x}:${y}:${spec.text}`,
    pageRepresentationDigest: pdfLayoutPageRepresentationDigest(['page-b2']),
  });
  return {
    text: spec.text, x: spec.x, y, width: spec.width ?? Math.max(8, spec.text.length * 5), height: 10,
    source: 'pdfjs', observation_id: observation_identity.id, observation_identity,
  };
}

function line(y: number, specs: readonly Spec[]): PdfLayoutLine {
  const tokens = specs.map((spec) => token(spec, y));
  return {
    id: `line:p${PAGE}:y${y}`, page_number: PAGE, text: tokens.map((entry) => entry.text).join(' '),
    tokens, kind: 'table_candidate',
    x_min: Math.min(...tokens.map((entry) => entry.x)),
    x_max: Math.max(...tokens.map((entry) => entry.x + entry.width)),
    y,
  };
}

const header = (y: number) => line(y, [
  { x: 50, text: 'Description', width: 70 },
  { x: 200, text: 'Unit of Measure', width: 80 },
  { x: 300, text: 'Origin/ Destination', width: 90 },
  { x: 450, text: 'Cost', width: 30 },
]);
const priced = (y: number, description: string, amount: string) => line(y, [
  { x: 50, text: description, width: 100 },
  { x: 200, text: 'Widget', width: 60 },
  { x: 300, text: 'A to B', width: 100 },
  { x: 450, text: '$', width: 8 },
  { x: 470, text: amount, width: 40 },
]);
/** A priced line with no header anywhere on the page. */
const bare = (y: number, description: string, amount: string) => line(y, [
  { x: 50, text: description, width: 100 },
  { x: 450, text: '$', width: 8 },
  { x: 470, text: amount, width: 40 },
]);
const prose = (y: number) => line(y, [{ x: 50, text: 'This agreement is entered into by the parties', width: 300 }]);

function layoutOf(lines: readonly PdfLayoutLine[]): PdfLayout {
  return { page_count: PAGE, gaps: [], pages: [{ page_number: PAGE, width: 612, height: 792, lines: [...lines] }] };
}

const twoTables = () => [
  header(720),
  priced(700, 'Alpha service', '12.00'),
  priced(690, 'Beta service', '3.50'),
  header(600),
  priced(580, 'Gamma service', '7.00'),
  priced(560, 'Delta service', '9.00'),
];

describe('durable unresolved priced pages', () => {
  it('reads a page holding two qualifying priced tables one table per header, leaving nothing unresolved', () => {
    const result = buildPagePricedScheduleReconstruction({ layout: layoutOf(twoTables()) });
    // Current (v4) reconstruction semantics, stored under the historical
    // priced_schedule_reconstruction_v1 envelope key.
    expect(result.parser_version).toBe('priced_schedule_reconstruction_v5');
    expect(result.pages.map((entry) => [entry.header_y, entry.rows.length])).toEqual([[720, 2], [600, 2]]);
    expect(result.unresolved_pages).toBeUndefined();
  });

  it('records a page whose two qualifying headers share a line, with every priced line', () => {
    const sideBySide = [
      line(720, [{ x: 20, text: 'Description', width: 60 }, { x: 100, text: 'Unit', width: 25 }, { x: 160, text: 'Cost', width: 25 }]),
      line(720, [{ x: 320, text: 'Description', width: 60 }, { x: 400, text: 'Unit', width: 25 }, { x: 460, text: 'Cost', width: 25 }]),
      bare(700, 'Alpha service', '12.00'),
      bare(690, 'Beta service', '3.50'),
    ];
    const result = buildPagePricedScheduleReconstruction({ layout: layoutOf(sideBySide) });
    expect(result.pages).toEqual([]);
    expect(result.unresolved_pages).toHaveLength(1);
    const unresolved = result.unresolved_pages![0]!;
    expect(unresolved).toMatchObject({
      authority: 'non_authoritative_diagnostic',
      reason: 'multiple_priced_headers',
      physical_page_number: PAGE,
    });
    expect(unresolved.priced_lines.map((entry) => entry.raw_text)).toEqual([
      'Alpha service $ 12.00',
      'Beta service $ 3.50',
    ]);
    // Every token of every recorded line keeps its observation identity.
    for (const entry of [...unresolved.header_lines, ...unresolved.priced_lines]) {
      expect(entry.source_refs.length).toBeGreaterThan(0);
      expect(entry.source_refs.every((ref) => typeof ref.observation_id === 'string')).toBe(true);
    }
  });

  it('records a page whose later table header does not qualify, with both headers and every priced line', () => {
    const result = buildPagePricedScheduleReconstruction({ layout: layoutOf([
      header(720),
      priced(700, 'Alpha service', '12.00'),
      priced(690, 'Beta service', '3.50'),
      line(600, [
        { x: 50, text: 'UOM', width: 30 },
        { x: 200, text: 'Item / Service', width: 80 },
        { x: 450, text: 'Unit Price', width: 50 },
      ]),
      priced(580, 'Gamma service', '7.00'),
      priced(560, 'Delta service', '9.00'),
    ]) });
    // No row is read through the first header; nothing disappears either.
    expect(result.pages).toEqual([]);
    expect(result.unresolved_pages).toMatchObject([{
      authority: 'non_authoritative_diagnostic', reason: 'unresolved_later_header', physical_page_number: PAGE,
    }]);
    const unresolved = result.unresolved_pages![0]!;
    expect(unresolved.header_lines.map((entry) => entry.y)).toEqual([720, 600]);
    expect(unresolved.priced_lines).toHaveLength(4);
  });

  it('records a page whose header lines are all plausible but unresolved, choosing none', () => {
    const shortHeader = (y: number) => line(y, [
      { x: 50, text: 'Description', width: 70 },
      { x: 450, text: 'Cost', width: 30 },
    ]);
    const result = buildPagePricedScheduleReconstruction({ layout: layoutOf([
      shortHeader(720),
      bare(700, 'Alpha service', '12.00'),
      bare(690, 'Beta service', '3.50'),
      shortHeader(600),
      bare(580, 'Gamma service', '7.00'),
      bare(560, 'Delta service', '9.00'),
    ]) });
    expect(result.pages).toEqual([]);
    expect(result.unresolved_pages).toMatchObject([{
      reason: 'ambiguous_header_candidates',
      header_lines: [{ y: 720 }, { y: 600 }],
    }]);
    expect(result.unresolved_pages![0]!.priced_lines).toHaveLength(4);
  });

  it('records a headerless page with enough priced lines', () => {
    const result = buildPagePricedScheduleReconstruction({ layout: layoutOf([
      bare(700, 'Alpha service', '12.00'),
      bare(690, 'Beta service', '3.50'),
      bare(680, 'Gamma service', '7.00'),
    ]) });
    expect(result.unresolved_pages).toMatchObject([{ reason: 'header_not_found', header_lines: [] }]);
    expect(result.unresolved_pages![0]!.priced_lines).toHaveLength(3);
  });

  it('does not report a headerless page carrying only two priced lines', () => {
    const result = buildPagePricedScheduleReconstruction({ layout: layoutOf([
      bare(700, 'Subtotal', '12.00'),
      bare(690, 'Total', '15.50'),
    ]) });
    expect(result).toEqual({ parser_version: result.parser_version, pages: [] });
  });

  it('does not report prose that merely mentions amounts', () => {
    const sentence = (y: number, amount: string) => ({
      ...line(y, [{ x: 50, text: 'The contractor shall be paid', width: 160 }, { x: 212, text: amount, width: 40 }]),
      kind: 'text' as const,
    });
    const result = buildPagePricedScheduleReconstruction({ layout: layoutOf([
      sentence(700, '$5,000'), sentence(680, '$7,500'), sentence(660, '$9,000'),
    ]) });
    expect('unresolved_pages' in result).toBe(false);
  });

  it('leaves prose pages and reconstructed pages byte-identical', () => {
    const proseOnly = buildPagePricedScheduleReconstruction({ layout: layoutOf([prose(700), prose(680)]) });
    expect(Object.keys(proseOnly).sort()).toEqual(['pages', 'parser_version']);

    const table = buildPagePricedScheduleReconstruction({ layout: layoutOf([
      header(720),
      priced(700, 'Alpha service', '12.00'),
      priced(690, 'Beta service', '3.50'),
    ]) });
    expect(table.pages).toHaveLength(1);
    expect('unresolved_pages' in table).toBe(false);
  });

  it('never records unresolved pages for pinned spacing_only fixtures', () => {
    const result = buildPagePricedScheduleReconstruction({
      layout: layoutOf(twoTables()), continuationEvidence: 'spacing_only',
    });
    expect(result).toEqual({ parser_version: 'priced_schedule_reconstruction_v1', pages: [] });
  });

  it('materializes durable observations for unresolved lines without changing closure', () => {
    const lines = [prose(760), header(720), priced(700, 'Alpha service', '12.00'), priced(690, 'Beta service', '3.50'),
      line(600, [{ x: 50, text: 'UOM', width: 30 }, { x: 200, text: 'Item / Service', width: 80 }, { x: 450, text: 'Unit Price', width: 50 }]),
      priced(580, 'Gamma service', '7.00'), priced(560, 'Delta service', '9.00')];
    const layout = layoutOf(lines);
    const reconstruction = buildPagePricedScheduleReconstruction({ layout });
    const layer = buildPdfLayoutObservationsLayer({ layout, reconstruction, context: CONTEXT });

    const materialized = new Set(layer.observations.map((entry) => entry.id));
    const expected = lines.slice(1).flatMap((entry) => entry.tokens.map((item) => item.observation_id!));
    expect([...materialized].sort()).toEqual([...new Set(expected)].sort());
    // The prose line is not evidence for anything unresolved and is not persisted.
    expect(materialized.has(lines[0]!.tokens[0]!.observation_id!)).toBe(false);
    // Nothing became accepted or diagnostic pricing evidence.
    expect(layer.closure).toMatchObject({ status: 'not_applicable', accepted_ref_count: 0 });
  });
});
