import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadPdfLayout } from '@/lib/extraction/pdf/extractText';

/**
 * Real-bytes preflight over the committed scanned Goodlettsville price sheet
 * (4 physical pages, no native text layer). No provider and no OCR run here.
 */
const FIXTURE = 'lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf';

function fixtureBytes(): ArrayBuffer {
  const bytes = readFileSync(FIXTURE);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('native layout preflight', () => {
  it('lets an explicitly relevant page pierce the evidence page cap without widening it', async () => {
    const layout = await loadPdfLayout(fixtureBytes(), { maxPages: 1, priorityPageNumbers: [3, 99, 0] });
    expect(layout.page_count).toBe(4);
    // Page 1 from the cap, page 3 from guidance; out-of-range guidance is ignored.
    expect(layout.pages.map((page) => page.page_number)).toEqual([1, 3]);
  });

  it('detects visible content with no text layer deterministically from the operator list', async () => {
    const first = await loadPdfLayout(fixtureBytes());
    const second = await loadPdfLayout(fixtureBytes());
    // This sheet has no text layer: its glyphs are outlined vector paths with a
    // few small embedded images. Visible content must still be detected.
    for (const page of first.pages) {
      expect(page.lines).toEqual([]);
      expect(page.visual_coverage?.vector_operator_count).toBeGreaterThanOrEqual(50);
    }
    expect(second.pages.map((page) => page.visual_coverage))
      .toEqual(first.pages.map((page) => page.visual_coverage));
  });
});
