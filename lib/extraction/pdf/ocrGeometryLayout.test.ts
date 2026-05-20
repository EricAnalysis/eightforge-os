import { describe, expect, it } from 'vitest';

import { buildPdfTableExtraction } from '@/lib/extraction/pdf/extractTables';
import type { PdfLayout, PdfLayoutLine } from '@/lib/extraction/pdf/extractText';
import {
  buildOcrLayoutPages,
  mergeOcrFallbackLayout,
  type OcrGeometryWord,
} from '@/lib/extraction/pdf/ocrGeometryLayout';

function word(text: string, x: number, y: number, width = Math.max(20, text.length * 8)): OcrGeometryWord {
  return {
    text,
    confidence: 90,
    bbox: {
      x0: x,
      y0: y,
      x1: x + width,
      y1: y + 12,
    },
  };
}

function nativeLine(text: string): PdfLayoutLine {
  return {
    id: 'pdf:line:p1:1',
    page_number: 1,
    text,
    tokens: [{ text, x: 10, y: 10, width: text.length * 5, height: 12, source: 'pdfjs' }],
    kind: 'text',
    x_min: 10,
    x_max: 10 + text.length * 5,
    y: 10,
    source: 'pdfjs',
  };
}

function emptyNativeLayout(pageCount = 1): PdfLayout {
  return {
    page_count: pageCount,
    gaps: [],
    pages: Array.from({ length: pageCount }, (_, index) => ({
      page_number: index + 1,
      lines: [],
    })),
  };
}

describe('OCR geometry layout recovery', () => {
  it('groups OCR words into PdfLayoutLine rows by y-coordinate and reading order', () => {
    const pages = buildOcrLayoutPages([{
      page_number: 8,
      words: [
        word('Rate', 420, 90),
        word('Description', 120, 90),
        word('Category', 20, 90),
        word('$6.90', 420, 118),
        word('Cubic', 320, 118),
        word('Vegetative', 20, 118),
        word('Yard', 370, 119),
      ],
    }]);

    expect(pages).toHaveLength(1);
    expect(pages[0]?.lines).toHaveLength(2);
    expect(pages[0]?.lines[0]?.text).toBe('Category Description Rate');
    expect(pages[0]?.lines[1]?.text).toBe('Vegetative Cubic Yard $6.90');
    expect(pages[0]?.lines[0]?.source).toBe('ocr_fallback');
    expect(pages[0]?.lines[1]?.tokens.every((token) => token.source === 'ocr_fallback')).toBe(true);
  });

  it('uses OCR layout only when the native page is empty', () => {
    const merged = mergeOcrFallbackLayout({
      nativeLayout: emptyNativeLayout(2),
      ocrPages: [{
        page_number: 2,
        words: [word('Category', 10, 20), word('Rate', 200, 20)],
      }],
      ocrTextPageNumbers: [2],
    });

    expect(merged.layout.pages[0]?.lines).toHaveLength(0);
    expect(merged.layout.pages[1]?.lines[0]?.text).toBe('Category Rate');
    expect(merged.diagnostics.pages_using_ocr_derived_layout).toEqual([2]);
    expect(merged.diagnostics.ocr_derived_line_count).toBe(1);
  });

  it('does not override native layout when native lines exist', () => {
    const merged = mergeOcrFallbackLayout({
      nativeLayout: {
        page_count: 1,
        gaps: [],
        pages: [{ page_number: 1, lines: [nativeLine('Native PDF text')] }],
      },
      ocrPages: [{
        page_number: 1,
        words: [word('OCR', 10, 20), word('text', 50, 20)],
      }],
      ocrTextPageNumbers: [1],
    });

    expect(merged.layout.pages[0]?.lines[0]?.text).toBe('Native PDF text');
    expect(merged.diagnostics.pages_using_native_layout).toEqual([1]);
    expect(merged.diagnostics.pages_using_ocr_derived_layout).toEqual([]);
  });

  it('emits a diagnostic warning when OCR text exists but geometry is missing', () => {
    const merged = mergeOcrFallbackLayout({
      nativeLayout: emptyNativeLayout(1),
      ocrPages: [],
      ocrTextPageNumbers: [1],
    });

    expect(merged.diagnostics.ocr_geometry_missing_pages).toEqual([1]);
    expect(merged.gaps.some((gap) => gap.category === 'ocr_geometry_missing' && gap.page === 1)).toBe(true);
  });

  it('lets buildPdfTableExtraction consume OCR-derived Exhibit A style rows', () => {
    const merged = mergeOcrFallbackLayout({
      nativeLayout: emptyNativeLayout(1),
      ocrPages: [{
        page_number: 1,
        words: [
          word('EXHIBIT', 20, 20),
          word('A', 85, 20),
          word('Category', 20, 50),
          word('Description', 180, 50),
          word('Unit', 500, 50),
          word('Rate', 620, 50),
          word('Vegetative', 20, 80),
          word('0-15', 180, 80),
          word('Miles', 230, 80),
          word('from', 280, 80),
          word('ROW', 325, 80),
          word('to', 370, 80),
          word('DMS', 400, 80),
          word('Cubic', 500, 80),
          word('Yard', 560, 80),
          word('$6.90', 680, 80),
          word('Vegetative', 20, 108),
          word('16-30', 180, 108),
          word('Miles', 230, 108),
          word('from', 280, 108),
          word('ROW', 325, 108),
          word('to', 370, 108),
          word('DMS', 400, 108),
          word('Cubic', 500, 108),
          word('Yard', 560, 108),
          word('$7.90', 680, 108),
        ],
      }],
      ocrTextPageNumbers: [1],
    });

    const result = buildPdfTableExtraction({ layout: merged.layout });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.headers).toEqual(['Category', 'Description', 'Unit', 'Rate']);
    expect(result.tables[0]?.rows).toHaveLength(2);
    expect(result.tables[0]?.rows[0]?.cells.map((cell) => cell.text)).toEqual([
      'Vegetative',
      '0-15 Miles from ROW to DMS',
      'Cubic Yard',
      '$6.90',
    ]);
  });
});
