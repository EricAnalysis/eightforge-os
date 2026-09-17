import { describe, expect, it } from 'vitest';

import { buildSyntheticPdf, type SyntheticPage } from '@/lib/extraction/geometry/__fixtures__/syntheticPdf';
import { loadPdfLayout, type PdfLayout } from '@/lib/extraction/pdf/extractText';
import { mergeOcrFallbackLayout, type OcrGeometryWord } from '@/lib/extraction/pdf/ocrGeometryLayout';

/**
 * Native/OCR reconciliation across rotation and crop.
 *
 * Before E2 the duplicate test compared native raw user-space boxes against OCR
 * boxes flipped through the rotated page height. On a rotated or cropped page
 * those are different frames, so OCR that merely restated the native text was
 * admitted a second time. Both sides are now normalized into canonical_v1
 * first. The admission rule is unchanged.
 */

const RENDER_SCALE = 2;
const RUNS: SyntheticPage['runs'] = [
  { text: 'Vegetative', x: 80, y: 700, fontSize: 12 },
  { text: 'Debris', x: 200, y: 700, fontSize: 12 },
];

const VARIANTS = [
  { name: 'rotate 0', cropBox: undefined, rotate: 0 },
  { name: 'rotate 90 with crop offset', cropBox: [20, 30, 600, 780] as const, rotate: 90 },
  { name: 'rotate 180', cropBox: undefined, rotate: 180 },
  { name: 'rotate 270', cropBox: undefined, rotate: 270 },
];

async function nativeLayout(variant: (typeof VARIANTS)[number]): Promise<PdfLayout> {
  return loadPdfLayout(buildSyntheticPdf([{
    mediaBox: [0, 0, 612, 792], cropBox: variant.cropBox, rotate: variant.rotate, runs: RUNS,
  }]), { observationIdentity: { sourceDocumentId: 'document-a', sourceArtifactId: 'artifact-a' } });
}

/** OCR words exactly where the rendered page shows each native token. */
function ocrEchoOf(layout: PdfLayout): { words: OcrGeometryWord[]; width: number; height: number } {
  const page = layout.pages[0]!;
  const frame = page.canonical_frame!;
  const words = page.lines.flatMap((line) => line.tokens).map((token) => ({
    text: token.text,
    confidence: 90,
    bbox: {
      x0: token.canonical_bbox!.x_min * RENDER_SCALE, y0: token.canonical_bbox!.y_min * RENDER_SCALE,
      x1: token.canonical_bbox!.x_max * RENDER_SCALE, y1: token.canonical_bbox!.y_max * RENDER_SCALE,
    },
  }));
  return { words, width: frame.width * RENDER_SCALE, height: frame.height * RENDER_SCALE };
}

function mergedTexts(layout: PdfLayout, ocr: ReturnType<typeof ocrEchoOf>) {
  const merged = mergeOcrFallbackLayout({
    nativeLayout: layout,
    ocrPages: [{ page_number: 1, width: ocr.width, height: ocr.height, words: ocr.words }],
    ocrTextPageNumbers: [1],
    representation: 'reconciled_pdf_points',
  });
  const page = merged.layout.pages[0]!;
  return {
    source: page.source,
    texts: page.lines.flatMap((line) => line.tokens.map((token) => token.text)).sort(),
  };
}

describe.each(VARIANTS)('native/OCR reconciliation in canonical_v1: $name', (variant) => {
  it('drops OCR that restates native text at the same visible position', async () => {
    const layout = await nativeLayout(variant);
    expect(layout.pages[0]!.canonical_frame).toBeDefined();
    const result = mergedTexts(layout, ocrEchoOf(layout));
    expect(result.texts).toEqual(['Debris', 'Vegetative']);
    expect(result.source).toBe('pdfjs');
  }, 60_000);

  it('still admits OCR text that sits somewhere the native layer has nothing', async () => {
    const layout = await nativeLayout(variant);
    const echo = ocrEchoOf(layout);
    const stamp: OcrGeometryWord = {
      text: 'APPROVED', confidence: 88,
      bbox: { x0: echo.width * 0.6, y0: echo.height * 0.8, x1: echo.width * 0.8, y1: echo.height * 0.84 },
    };
    const result = mergedTexts(layout, { ...echo, words: [...echo.words, stamp] });
    expect(result.texts).toEqual(['APPROVED', 'Debris', 'Vegetative']);
    expect(result.source).toBe('mixed');
  }, 60_000);

  it('keeps native precedence when the page has no canonical frame to compare in', async () => {
    const layout = await nativeLayout(variant);
    const echo = ocrEchoOf(layout);
    const page = layout.pages[0]!;
    const { canonical_frame: _frame, ...unframedPage } = page;
    const result = mergedTexts({ ...layout, pages: [unframedPage] }, echo);
    expect(result.texts).toEqual(['Debris', 'Vegetative']);
    expect(result.source).toBe('pdfjs');
  }, 60_000);
});
