import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSyntheticPdf, type SyntheticTextRun } from '@/lib/extraction/geometry/__fixtures__/syntheticPdf';
import {
  buildCanonicalPageFrame,
  canonicalIntersectionOverUnion,
  nativeTextRunCanonicalBox,
  ocrRenderBoxToCanonical,
  type CanonicalBox,
} from '@/lib/extraction/geometry/canonicalPageFrame';

/**
 * Cross-extractor alignment: native pdf.js geometry and render-pixel geometry
 * of the same visible glyphs must land in the same canonical frame.
 *
 * The render-pixel side is the ink bounding box of each run in a pdf.js render
 * at the production OCR scale (2x, viewer rotation applied), which is exactly
 * the coordinate space OCR word boxes are reported in. No OCR engine or
 * provider runs; the ink box is a deterministic stand-in for a word box.
 */

const STANDARD_FONT_DATA_URL = `${path.resolve('node_modules/pdfjs-dist/standard_fonts').split(path.sep).join('/')}/`;
const RENDER_SCALE = 2;

const RUNS: readonly SyntheticTextRun[] = [
  { text: 'HAULING', x: 80, y: 690, fontSize: 18 },
  { text: 'UNIT 42.50', x: 330, y: 520, fontSize: 16 },
  { text: 'ROTATED', x: 480, y: 250, fontSize: 16, matrix: [0, 1, -1, 0] },
  { text: 'SKEWED', x: 120, y: 160, fontSize: 16, matrix: [1, 0, 0.3, 1] },
];

const PAGES = [0, 90, 180, 270].flatMap((rotate) => [
  { name: `rotate ${rotate}`, cropBox: undefined, rotate },
  { name: `rotate ${rotate} cropped`, cropBox: [20, 30, 600, 780] as const, rotate },
]);

async function renderRun(run: SyntheticTextRun, page: (typeof PAGES)[number]) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buildSyntheticPdf([{
      mediaBox: [0, 0, 612, 792], cropBox: page.cropBox, rotate: page.rotate, runs: [run],
    }])),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const pdfPage = await document.getPage(1);
  const frame = buildCanonicalPageFrame({ view: pdfPage.view, rotation: pdfPage.rotate, userUnit: pdfPage.userUnit })!;
  const item = (await pdfPage.getTextContent()).items.find((entry) => 'str' in entry && entry.str.trim()) as
    { transform: number[]; width: number; height: number };
  const native = nativeTextRunCanonicalBox(frame, item)!;

  // Production OCR render: getViewport({ scale: 2 }), floored pixel dimensions.
  const viewport = pdfPage.getViewport({ scale: RENDER_SCALE });
  const width = Math.floor(viewport.width);
  const height = Math.floor(viewport.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  await pdfPage.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  const pixels = context.getImageData(0, 0, width, height).data;
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (pixels[offset]! < 128 && pixels[offset + 1]! < 128 && pixels[offset + 2]! < 128) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
      }
    }
  }
  expect(x1).toBeGreaterThan(x0);
  const ocr = ocrRenderBoxToCanonical(frame, { x_min: x0, y_min: y0, x_max: x1, y_max: y1 },
    { pixelWidth: width, pixelHeight: height })!;
  // The pre-E2 reconciliation implicitly assumed an unrotated, uncropped page.
  const implicitFrame = buildCanonicalPageFrame({ view: [0, 0, 612, 792], rotation: 0 })!;
  const implicitNative = nativeTextRunCanonicalBox(implicitFrame, item);
  return { frame, native, ocr, implicitNative };
}

function center(box: CanonicalBox): [number, number] {
  return [(box.x_min + box.x_max) / 2, (box.y_min + box.y_max) / 2];
}

describe.each(PAGES)('native and render-pixel geometry align in canonical_v1: $name', (page) => {
  it.each(RUNS)('aligns "$text"', async (run) => {
    const { native, ocr, implicitNative } = await renderRun(run, page);
    // Native boxes span baseline to font size, ink boxes span actual glyph
    // extents (all-caps, no descenders), so they are not identical; they must
    // still overlap substantially and share a center within a few points.
    expect(canonicalIntersectionOverUnion(native, ocr)).toBeGreaterThanOrEqual(0.6);
    const [nativeX, nativeY] = center(native);
    const [ocrX, ocrY] = center(ocr);
    expect(Math.hypot(nativeX - ocrX, nativeY - ocrY)).toBeLessThanOrEqual(3);
    if (page.rotate !== 0 || page.cropBox) {
      // Negative control: the implicit unrotated frame misplaces the same glyphs.
      const implicitIou = implicitNative ? canonicalIntersectionOverUnion(implicitNative, ocr) : 0;
      expect(implicitIou).toBeLessThan(page.rotate === 0 ? 0.6 : 0.1);
    }
  }, 60_000);
});
