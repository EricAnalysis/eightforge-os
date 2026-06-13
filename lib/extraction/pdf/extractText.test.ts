import { describe, expect, it } from 'vitest';

import { buildPdfTextExtraction, type PdfLayout } from '@/lib/extraction/pdf/extractText';

describe('buildPdfTextExtraction fallback pages', () => {
  it('preserves OCR fallback page numbers when layout text is empty', () => {
    const layout: PdfLayout = {
      page_count: 15,
      pages: Array.from({ length: 15 }, (_, index) => ({
        page_number: index + 1,
        lines: [],
      })),
      gaps: [],
    };

    const result = buildPdfTextExtraction({
      layout,
      fallbackText: 'collapsed fallback text',
      fallbackPages: [
        { page_number: 1, text: 'Contract cover page' },
        { page_number: 8, text: 'EXHIBIT A Emergency Debris Removal Unit Rates' },
        { page_number: 9, text: 'Category Description Unit Rate' },
      ],
    });

    expect(result.page_count).toBe(15);
    expect(result.pages.map((page) => page.page_number)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(
      result.pages
        .filter((page) => page.plain_text_blocks.length > 0)
        .map((page) => page.page_number),
    ).toEqual([1, 8, 9]);
    expect(result.combined_text).toContain('Emergency Debris Removal Unit Rates');
  });

  it('falls back to a synthetic single page only when page-scoped fallback text is unavailable', () => {
    const layout: PdfLayout = {
      page_count: 12,
      pages: Array.from({ length: 12 }, (_, index) => ({
        page_number: index + 1,
        lines: [],
      })),
      gaps: [],
    };

    const result = buildPdfTextExtraction({
      layout,
      fallbackText: 'combined OCR text only',
    });

    expect(result.pages.map((page) => page.page_number)).toEqual([1]);
    expect(result.combined_text).toBe('combined OCR text only');
  });

  it('merges page-scoped OCR fallback into empty pages even when later pages have native text', () => {
    const layout: PdfLayout = {
      page_count: 4,
      pages: [
        { page_number: 1, lines: [] },
        { page_number: 2, lines: [] },
        {
          page_number: 3,
          lines: [{
            text: 'EXHIBIT A native body text',
            kind: 'text',
            x_min: 10,
            x_max: 130,
            y: 10,
          }],
        },
        { page_number: 4, lines: [] },
      ],
      gaps: [],
    };

    const result = buildPdfTextExtraction({
      layout,
      fallbackPages: [
        { page_number: 1, text: 'THIS AGREEMENT is between Lee County and Crowder-Gulf Joint Venture, Inc.' },
        { page_number: 2, text: 'This Agreement shall commence immediately upon the execution of all parties and shall continue for a five (5) year period.' },
      ],
    });

    expect(result.pages.find((page) => page.page_number === 1)?.plain_text_blocks[0]?.text).toContain(
      'Crowder-Gulf Joint Venture, Inc.',
    );
    expect(result.pages.find((page) => page.page_number === 2)?.plain_text_blocks[0]?.text).toContain(
      'five (5) year period',
    );
    expect(result.pages.find((page) => page.page_number === 3)?.plain_text_blocks[0]?.text).toContain(
      'EXHIBIT A native body text',
    );
    expect(result.combined_text).toContain('Crowder-Gulf Joint Venture, Inc.');
    expect(result.combined_text).toContain('EXHIBIT A native body text');
  });
});
