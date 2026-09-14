import { describe, expect, it } from 'vitest';

import type { PdfLayout, PdfLayoutLine, PdfToken } from '@/lib/extraction/pdf/extractText';
import { mergeOcrFallbackLayout, type OcrGeometryWord } from '@/lib/extraction/pdf/ocrGeometryLayout';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * A priced schedule must reconstruct identically whether its evidence arrived
 * as native PDF text or as OCR words over a 2x render. Synthetic geometry only.
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const RENDER_SCALE = 2;

function nativeLine(y: number, specs: ReadonlyArray<{ x: number; text: string; width: number }>): PdfLayoutLine {
  const tokens: PdfToken[] = specs.map((spec) => ({
    text: spec.text, x: spec.x, y, width: spec.width, height: 8, source: 'pdfjs',
  }));
  return {
    id: `line:y${y}`, page_number: 1, text: tokens.map((token) => token.text).join(' '),
    tokens, kind: 'table_candidate', x_min: tokens[0]!.x,
    x_max: tokens.at(-1)!.x + tokens.at(-1)!.width, y,
  };
}

/** Realistic, non-overlapping line pitch: 8pt glyphs on a 15pt baseline grid. */
const LINES: readonly PdfLayoutLine[] = [
  // Single-word header labels: OCR delivers words, and each header token is a
  // header cell. Multi-word labels are covered by the fail-closed test below.
  nativeLine(700, [
    { x: 50, text: 'Description', width: 70 },
    { x: 200, text: 'Unit', width: 30 },
    { x: 300, text: 'Route', width: 40 },
    { x: 450, text: 'Cost', width: 30 },
  ]),
  nativeLine(685, [{ x: 50, text: 'Gamma service with a very long', width: 100 }]),
  nativeLine(670, [
    { x: 200, text: 'Widget', width: 60 },
    { x: 300, text: 'Yard to Depot', width: 100 },
    { x: 450, text: '$', width: 8 },
    { x: 470, text: '12.00', width: 40 },
  ]),
  nativeLine(655, [{ x: 50, text: 'authored description', width: 100 }]),
  nativeLine(570, [
    { x: 50, text: 'Delta service', width: 100 },
    { x: 200, text: 'Widget', width: 60 },
    { x: 300, text: 'Depot to Site', width: 100 },
    { x: 450, text: '$', width: 8 },
    { x: 470, text: '3.50', width: 40 },
  ]),
];

/** Renders every native token as Tesseract-style words in top-left render pixels. */
function ocrWords(lines: readonly PdfLayoutLine[]): OcrGeometryWord[] {
  return lines.flatMap((line) => line.tokens.flatMap((token) => {
    const words = token.text.split(/\s+/);
    const wordWidth = token.width / words.length;
    return words.map((text, index) => {
      const x0 = (token.x + index * wordWidth) * RENDER_SCALE;
      // Tesseract boxes vary slightly per word on one visual line.
      const jitter = index % 2;
      const y1 = (PAGE_HEIGHT - token.y) * RENDER_SCALE + jitter;
      return {
        text,
        bbox: { x0, y0: y1 - token.height * RENDER_SCALE - jitter, x1: x0 + wordWidth * RENDER_SCALE - 2, y1 },
      };
    });
  }));
}

function rowsOf(layout: PdfLayout) {
  const page = buildPagePricedScheduleReconstruction({ layout }).pages[0];
  return page?.rows.map((row) => Object.fromEntries(row.cells.map((cell) => [cell.role, cell.raw_text]))) ?? null;
}

describe('OCR-normalized priced schedule reconstruction', () => {
  it('reconstructs the same rows, in the same order, from OCR render pixels as from native text', () => {
    const native = rowsOf({
      page_count: 1, gaps: [],
      pages: [{ page_number: 1, width: PAGE_WIDTH, height: PAGE_HEIGHT, lines: [...LINES] }],
    });
    const merged = mergeOcrFallbackLayout({
      nativeLayout: {
        page_count: 1, gaps: [],
        pages: [{ page_number: 1, width: PAGE_WIDTH, height: PAGE_HEIGHT, lines: [] }],
      },
      ocrPages: [{
        page_number: 1,
        width: PAGE_WIDTH * RENDER_SCALE,
        height: PAGE_HEIGHT * RENDER_SCALE,
        words: ocrWords(LINES),
      }],
      representation: 'reconciled_pdf_points',
    });

    expect(native).toHaveLength(2);
    expect(native![0]!.description).toBe('Gamma service with a very long authored description');
    expect(rowsOf(merged.layout)).toEqual(native);
  });

  it('keeps every OCR source reference in original render pixels for source verification', () => {
    const merged = mergeOcrFallbackLayout({
      nativeLayout: {
        page_count: 1, gaps: [],
        pages: [{ page_number: 1, width: PAGE_WIDTH, height: PAGE_HEIGHT, lines: [] }],
      },
      ocrPages: [{
        page_number: 1, width: PAGE_WIDTH * RENDER_SCALE, height: PAGE_HEIGHT * RENDER_SCALE,
        words: ocrWords(LINES),
      }],
      representation: 'reconciled_pdf_points',
    });
    const page = buildPagePricedScheduleReconstruction({ layout: merged.layout }).pages[0]!;
    const rate = page.rows[0]!.cells.find((cell) => cell.role === 'rate')!;
    const amount = rate.source_refs.find((ref) => ref.text === '12.00')!;
    expect(amount.source).toBe('ocr_fallback');
    expect(amount.x_min).toBe(470 * RENDER_SCALE);
    // Top-left render pixels: the box top is above its bottom.
    expect(amount.y_min).toBeLessThan(amount.y_max);
    expect(amount.y_max).toBeCloseTo((PAGE_HEIGHT - 670) * RENDER_SCALE, 0);
  });

  it('fails closed, never guessing, when OCR splits a multi-word header label into words', () => {
    const splitHeader = [
      nativeLine(700, [
        { x: 50, text: 'Description', width: 70 },
        { x: 200, text: 'Unit of Measure', width: 80 },
        { x: 300, text: 'Route', width: 40 },
        { x: 450, text: 'Cost', width: 30 },
      ]),
      ...LINES.slice(1),
    ];
    const merged = mergeOcrFallbackLayout({
      nativeLayout: {
        page_count: 1, gaps: [],
        pages: [{ page_number: 1, width: PAGE_WIDTH, height: PAGE_HEIGHT, lines: [] }],
      },
      ocrPages: [{
        page_number: 1, width: PAGE_WIDTH * RENDER_SCALE, height: PAGE_HEIGHT * RENDER_SCALE,
        words: ocrWords(splitHeader),
      }],
      representation: 'reconciled_pdf_points',
    });
    // "Unit" and "Measure" both name the unit column: an ambiguous header is
    // refused. Grouping OCR words into header cells is a separate, unapproved
    // reconstruction change, not coordinate normalization.
    expect(buildPagePricedScheduleReconstruction({ layout: merged.layout }).pages).toEqual([]);
  });
});
