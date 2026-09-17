import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCanonicalPageFrame,
  canonicalFrameMatrix,
  pdfUserPointToCanonical,
} from '@/lib/extraction/geometry/canonicalPageFrame';
import { loadPdfLayout } from '@/lib/extraction/pdf/extractText';
import { toViewportRect } from '@/lib/recovery/sourceGeometry';

/**
 * Rotated / cropped real-corpus qualification for canonical_v1.
 *
 * Provider-free and opt-in: native text parsing only, no OCR, no network, no
 * database. Each document is skipped unless its env var points at the source,
 * and a skipped run proves nothing. Paths are never committed.
 *
 *   E2_CUSTOM_TREE_PDF   rotated corpus: 46 pages at /Rotate 270
 *   E2_HORNER_PDF        page 173 rotated 90 with a non-zero crop offset
 *   E2_MDOT_PDF          rotated/skewed text runs
 *   E2_HILLSDALE_PDF     zero-rotation regression control
 */

type PdfJsPage = {
  view: number[]; rotate: number; userUnit: number;
  getViewport(params: { scale: number }): { width: number; height: number; transform: number[] };
};

const DOCUMENTS = [
  { name: 'Custom Tree', env: 'E2_CUSTOM_TREE_PDF', expectRotations: [270] },
  {
    name: 'Horner', env: 'E2_HORNER_PDF', expectRotations: null,
    // Measured, not assumed. The E1 audit recorded 'p173 rotated 90 with a crop
    // offset'; this source actually has a negative crop origin on p173 at
    // rotation 0, and the rotated-90 page is p175. Both are pinned.
    expectPages: [
      { pageNumber: 173, rotation: 0, nonZeroCropOrigin: true },
      { pageNumber: 175, rotation: 90, nonZeroCropOrigin: false },
    ],
  },
  { name: 'MDOT', env: 'E2_MDOT_PDF', expectRotations: null },
  { name: 'Hillsdale', env: 'E2_HILLSDALE_PDF', expectRotations: [0] },
] as const;

async function bytesOf(env: string): Promise<ArrayBuffer> {
  const file = await readFile(path.resolve(process.env[env]!.trim()));
  return new Uint8Array(file).buffer as ArrayBuffer;
}

describe.each(DOCUMENTS)('canonical geometry over real source: $name', (document) => {
  const configured = Boolean(process.env[document.env]?.trim());

  it.skipIf(!configured)('frames every page exactly as the pdf.js viewport does', async () => {
    const bytes = await bytesOf(document.env);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const rotations = new Map<number, number>();
    let croppedPages = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber) as unknown as PdfJsPage;
      const frame = buildCanonicalPageFrame({
        view: page.view, rotation: page.rotate, userUnit: page.userUnit,
      });
      expect(frame, `page ${pageNumber} frame`).not.toBeNull();
      const viewport = page.getViewport({ scale: 1 });
      expect(frame!.width).toBeCloseTo(viewport.width, 6);
      expect(frame!.height).toBeCloseTo(viewport.height, 6);
      canonicalFrameMatrix(frame!).forEach((value, index) =>
        expect(value).toBeCloseTo(viewport.transform[index]!, 6));
      rotations.set(frame!.rotation, (rotations.get(frame!.rotation) ?? 0) + 1);
      if (frame!.view[0] !== 0 || frame!.view[1] !== 0) croppedPages += 1;
    }
    const expectPages = (document as {
      expectPages?: readonly { pageNumber: number; rotation: number; nonZeroCropOrigin: boolean }[];
    }).expectPages ?? [];
    for (const expected of expectPages) {
      const page = await pdf.getPage(expected.pageNumber) as unknown as PdfJsPage;
      const frame = buildCanonicalPageFrame({
        view: page.view, rotation: page.rotate, userUnit: page.userUnit,
      })!;
      const viewport = page.getViewport({ scale: 1 });
      expect(frame.rotation, `page ${expected.pageNumber} rotation`).toBe(expected.rotation);
      expect(frame.view[0] !== 0 || frame.view[1] !== 0,
        `page ${expected.pageNumber} crop origin`).toBe(expected.nonZeroCropOrigin);
      expect(frame.width).toBeCloseTo(viewport.width, 6);
      expect(frame.height).toBeCloseTo(viewport.height, 6);
      console.log(`[E2 corpus] ${document.name}: page ${expected.pageNumber} `
        + `frame=${JSON.stringify(frame)}`);
    }
    if (document.expectRotations) {
      expect([...rotations.keys()].sort()).toEqual([...document.expectRotations]);
    }
    console.log(`[E2 corpus] ${document.name}: pages=${pdf.numPages} `
      + `rotations=${JSON.stringify([...rotations.entries()].sort())} cropped_origin_pages=${croppedPages}`);
  }, 600_000);

  it.skipIf(!configured)('gives every native token a bounded canonical box in reading order', async () => {
    const layout = await loadPdfLayout(await bytesOf(document.env));
    const pagesWithText = layout.pages.filter((page) => page.lines.length > 0);
    expect(layout.pages.every((page) => page.canonical_frame)).toBe(true);
    let tokenCount = 0;
    let canonicalCount = 0;
    let reorderedPages = 0;
    for (const page of pagesWithText) {
      const frame = page.canonical_frame!;
      expect(frame).toBeDefined();
      const tokens = page.lines.flatMap((line) => line.tokens);
      tokenCount += tokens.length;
      for (const token of tokens) {
        const box = token.canonical_bbox;
        expect(box, `page ${page.page_number} token ${token.text}`).toBeDefined();
        canonicalCount += 1;
        expect(box!.x_min).toBeGreaterThanOrEqual(0);
        expect(box!.y_min).toBeGreaterThanOrEqual(0);
        expect(box!.x_max).toBeLessThanOrEqual(frame.width);
        expect(box!.y_max).toBeLessThanOrEqual(frame.height);
        expect(box!.x_max).toBeGreaterThanOrEqual(box!.x_min);
        expect(box!.y_max).toBeGreaterThanOrEqual(box!.y_min);
      }
      // Every run's own origin must land inside its canonical box: the box is
      // the quad's bounds and the origin is one of its corners. This holds for
      // upright, rotated and skewed runs alike.
      const axis = frame.rotation === 0 || frame.rotation === 180 ? 'x' : 'y';
      const sign = frame.rotation === 0 || frame.rotation === 90 ? 1 : -1;
      for (const line of page.lines) {
        const origins = line.tokens.map((token) => {
          const [x, y] = pdfUserPointToCanonical(frame, token.x, token.y);
          const box = token.canonical_bbox!;
          const clipped = box.x_min === 0 || box.y_min === 0
            || box.x_max === frame.width || box.y_max === frame.height;
          if (!clipped) {
            expect(x, `page ${page.page_number} origin x in box`).toBeGreaterThanOrEqual(box.x_min - 0.6);
            expect(x).toBeLessThanOrEqual(box.x_max + 0.6);
            expect(y, `page ${page.page_number} origin y in box`).toBeGreaterThanOrEqual(box.y_min - 0.6);
            expect(y).toBeLessThanOrEqual(box.y_max + 0.6);
          }
          return sign * (axis === 'x' ? x : y);
        });
        // Tokens are held in user-space reading order, and rotation maps that
        // direction onto a known canonical axis and sign (+X, +Y, -X, -Y for
        // /Rotate 0, 90, 180, 270). Origins must advance monotonically along it.
        const monotonic = origins.every((value, index) =>
          index === 0 || value >= origins[index - 1]! - 0.5);
        if (!monotonic) reorderedPages += 1;
        expect(monotonic, `page ${page.page_number} line ${line.id} canonical reading order`).toBe(true);
      }
    }
    expect(canonicalCount).toBe(tokenCount);
    // A scanned source (Custom Tree) has no native text at all; its evidence is
    // OCR, covered by the viewer mapping test below.
    console.log(`[E2 corpus] ${document.name}: text_pages=${pagesWithText.length} `
      + `tokens=${tokenCount} canonical=${canonicalCount} lines_out_of_canonical_order=${reorderedPages}`);
  }, 600_000);

  it.skipIf(!configured)('renders historical v1 visual evidence on every page, rotated or not', async () => {
    const bytes = await bytesOf(document.env);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const scale = 1.15;
    const renderScale = 2;
    let rendered = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber) as unknown as PdfJsPage;
      const frame = buildCanonicalPageFrame({
        view: page.view, rotation: page.rotate, userUnit: page.userUnit,
      })!;
      const viewport = page.getViewport({ scale });
      const geometry = {
        viewportWidth: viewport.width, viewportHeight: viewport.height, scale,
        rotation: page.rotate, pageWidthPoints: frame.width, pageHeightPoints: frame.height,
        viewBox: page.view, userUnit: page.userUnit,
        ocrPixelWidth: Math.floor(frame.width * renderScale),
        ocrPixelHeight: Math.floor(frame.height * renderScale),
      };
      // A historical OCR word box a quarter of the way down the rendered page.
      const ocrRect = toViewportRect({
        observationId: 'obs', rawText: 'x', role: 'candidate_member', memberIndex: 0,
        sourceLayer: 'ocr',
        boundingBox: {
          xMin: geometry.ocrPixelWidth * 0.2, xMax: geometry.ocrPixelWidth * 0.4,
          yMin: geometry.ocrPixelHeight * 0.25, yMax: geometry.ocrPixelHeight * 0.28,
        },
      }, geometry);
      expect(ocrRect, 'ocr rect on page ' + pageNumber).not.toBeNull();
      expect(ocrRect!.left + ocrRect!.width).toBeLessThanOrEqual(viewport.width + 0.001);
      expect(ocrRect!.top + ocrRect!.height).toBeLessThanOrEqual(viewport.height + 0.001);
      // A historical native box, in this page's own user space.
      const [vx0, vy0, vx1, vy1] = frame.view;
      const nativeRect = toViewportRect({
        observationId: 'obs', rawText: 'x', role: 'candidate_member', memberIndex: 0,
        sourceLayer: 'pdf_native_text',
        boundingBox: {
          xMin: vx0 + (vx1 - vx0) * 0.2, xMax: vx0 + (vx1 - vx0) * 0.4,
          yMin: vy0 + (vy1 - vy0) * 0.5, yMax: vy0 + (vy1 - vy0) * 0.52,
        },
      }, geometry);
      expect(nativeRect, 'native rect on page ' + pageNumber).not.toBeNull();
      expect(nativeRect!.left + nativeRect!.width).toBeLessThanOrEqual(viewport.width + 0.001);
      expect(nativeRect!.top + nativeRect!.height).toBeLessThanOrEqual(viewport.height + 0.001);
      rendered += 1;
    }
    console.log(`[E2 corpus] ${document.name}: viewer_pages_rendered=${rendered}`);
  }, 600_000);
});
