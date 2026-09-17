import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSyntheticPdf, type SyntheticPage } from '@/lib/extraction/geometry/__fixtures__/syntheticPdf';
import {
  buildCanonicalPageFrame,
  canonicalBoxToViewportRect,
  canonicalFrameMatrix,
  canonicalIntersectionOverSmaller,
  canonicalIntersectionOverUnion,
  canonicalPointToPdfUser,
  clipCanonicalBox,
  isCanonicalBox,
  isCanonicalPageFrame,
  nativeTextRunCanonicalBox,
  normalizePageRotation,
  ocrRenderBoxToCanonical,
  pdfUserPointToCanonical,
  pdfUserUnrotatedBoxToCanonical,
  toCanonicalBox,
  type CanonicalBox,
  type CanonicalPageFrame,
} from '@/lib/extraction/geometry/canonicalPageFrame';

type PdfJsViewport = {
  width: number; height: number; transform: number[]; viewBox: number[]; rotation: number;
  convertToViewportPoint(x: number, y: number): [number, number];
};
type PdfJsPage = {
  view: number[]; rotate: number; userUnit: number;
  getViewport(params: { scale: number }): PdfJsViewport;
  getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }>;
  render(params: unknown): { promise: Promise<void> };
};

const STANDARD_FONT_DATA_URL = `${path.resolve('node_modules/pdfjs-dist/standard_fonts').split(path.sep).join('/')}/`;

async function openPage(page: SyntheticPage): Promise<PdfJsPage> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buildSyntheticPdf([page])),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  return await document.getPage(1) as unknown as PdfJsPage;
}

function frameOf(page: PdfJsPage): CanonicalPageFrame {
  const frame = buildCanonicalPageFrame({ view: page.view, rotation: page.rotate, userUnit: page.userUnit });
  if (!frame) throw new Error('frame');
  return frame;
}

const MEDIA = [0, 0, 612, 792] as const;
const CROP = [20, 30, 600, 780] as const;
const PAGE_VARIANTS = [0, 90, 180, 270].flatMap((rotate) => [
  { name: `rotate ${rotate}`, mediaBox: MEDIA, cropBox: undefined, rotate, origin: [0, 0] as const },
  { name: `rotate ${rotate} cropped`, mediaBox: MEDIA, cropBox: CROP, rotate, origin: [0, 0] as const },
  // A media box that does not start at the origin is the cropped-media-box case.
  { name: `rotate ${rotate} offset media box`, mediaBox: [100, 50, 712, 842] as const, cropBox: undefined, rotate, origin: [100, 50] as const },
]);

const RUNS: SyntheticPage['runs'] = [
  { text: 'Upright', x: 60, y: 700, fontSize: 12 },
  { text: 'Quarter turn', x: 300, y: 400, fontSize: 10, matrix: [0, 1, -1, 0] },
  { text: 'Skewed run', x: 120, y: 200, fontSize: 10, matrix: [1, 0, 0.35, 1] },
  { text: 'Angled 30', x: 350, y: 150, fontSize: 9, matrix: [0.866, 0.5, -0.5, 0.866] },
];

function runsAt(origin: readonly [number, number]): SyntheticPage['runs'] {
  return RUNS.map((run) => ({ ...run, x: run.x + origin[0], y: run.y + origin[1] }));
}

function expectClose(actual: readonly number[], expected: readonly number[], digits = 6) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, digits));
}

describe('canonical_frame_v1 construction', () => {
  it('normalizes rotation to 0/90/180/270 and rejects non-quarter turns', () => {
    expect(normalizePageRotation(-90)).toBe(270);
    expect(normalizePageRotation(450)).toBe(90);
    expect(normalizePageRotation(360)).toBe(0);
    expect(normalizePageRotation(45)).toBeNull();
    expect(normalizePageRotation('90')).toBeNull();
  });

  it('builds the viewer-visible frame with rotated dimensions and rejects empty boxes', () => {
    expect(buildCanonicalPageFrame({ view: [20, 30, 600, 780], rotation: 90 })).toMatchObject({
      coordinate_space: 'canonical_v1', view: [20, 30, 600, 780], rotation: 90, width: 750, height: 580,
    });
    expect(buildCanonicalPageFrame({ view: [600, 780, 20, 30], rotation: 0 })?.view).toEqual([20, 30, 600, 780]);
    expect(buildCanonicalPageFrame({ view: [0, 0, 0, 792], rotation: 0 })).toBeNull();
    expect(buildCanonicalPageFrame({ view: [0, 0, 612, 792], rotation: 33 })).toBeNull();
    expect(buildCanonicalPageFrame({ view: [0, 0, 612, 792], rotation: 0, userUnit: 2 }))
      .toMatchObject({ width: 1224, height: 1584 });
  });

  it('recognizes only well-formed persisted frames', () => {
    const frame = buildCanonicalPageFrame({ view: [0, 0, 612, 792], rotation: 270 })!;
    expect(isCanonicalPageFrame(JSON.parse(JSON.stringify(frame)))).toBe(true);
    expect(isCanonicalPageFrame({ ...frame, width: 612 })).toBe(false);
    expect(isCanonicalPageFrame({ ...frame, coordinate_space: 'pdf_user_unrotated' })).toBe(false);
  });
});

describe.each(PAGE_VARIANTS)('canonical frame against the pdf.js viewport: $name', (variant) => {
  it('reproduces the pdf.js scale-1 viewport transform and dimensions exactly', async () => {
    const page = await openPage({ mediaBox: variant.mediaBox, cropBox: variant.cropBox, rotate: variant.rotate, runs: runsAt(variant.origin) });
    const viewport = page.getViewport({ scale: 1 });
    const frame = frameOf(page);
    expectClose(canonicalFrameMatrix(frame), viewport.transform, 9);
    expect(frame.width).toBeCloseTo(viewport.width, 9);
    expect(frame.height).toBeCloseTo(viewport.height, 9);
  }, 60_000);

  it('round-trips user-space points and maps the visible crop box onto the canonical page', async () => {
    const page = await openPage({ mediaBox: variant.mediaBox, cropBox: variant.cropBox, rotate: variant.rotate, runs: runsAt(variant.origin) });
    const viewport = page.getViewport({ scale: 1 });
    const frame = frameOf(page);
    const [x0, y0, x1, y1] = frame.view;
    for (const [x, y] of [[x0, y0], [x1, y1], [x0, y1], [x1, y0], [(x0 + x1) / 2 + 13, (y0 + y1) / 2 - 7]]) {
      const canonical = pdfUserPointToCanonical(frame, x!, y!);
      expectClose(canonical, viewport.convertToViewportPoint(x!, y!), 9);
      expectClose(canonicalPointToPdfUser(frame, canonical[0], canonical[1]), [x!, y!], 9);
    }
    const whole = pdfUserUnrotatedBoxToCanonical(frame, { x_min: x0, y_min: y0, x_max: x1, y_max: y1 });
    expect(whole).toEqual({ coordinate_space: 'canonical_v1', x_min: 0, y_min: 0, x_max: frame.width, y_max: frame.height });
  }, 60_000);

  it('maps native text runs, including rotated and skewed runs, to bounded canonical quads', async () => {
    const page = await openPage({ mediaBox: variant.mediaBox, cropBox: variant.cropBox, rotate: variant.rotate, runs: runsAt(variant.origin) });
    const viewport = page.getViewport({ scale: 1 });
    const frame = frameOf(page);
    const items = (await page.getTextContent()).items.filter((item) => item.str?.trim());
    expect(items.map((item) => item.str)).toEqual(RUNS.map((run) => run.text));
    for (const item of items) {
      const box = nativeTextRunCanonicalBox(frame, {
        transform: item.transform!, width: item.width!, height: item.height!,
      })!;
      // Independent oracle: the same parallelogram converted by pdf.js itself.
      const [a, b, c, d, e, f] = item.transform!;
      const ab = Math.hypot(a!, b!);
      const cd = Math.hypot(c!, d!);
      const dir = [a! / ab, b! / ab];
      const up = [c! / cd, d! / cd];
      const corners = [[0, 0], [item.width!, 0], [0, item.height!], [item.width!, item.height!]]
        .map(([w, h]) => viewport.convertToViewportPoint(
          e! + dir[0]! * w! + up[0]! * h!, f! + dir[1]! * w! + up[1]! * h!));
      const expected = {
        x_min: Math.max(0, Math.min(...corners.map((point) => point[0]))),
        y_min: Math.max(0, Math.min(...corners.map((point) => point[1]))),
        x_max: Math.min(frame.width, Math.max(...corners.map((point) => point[0]))),
        y_max: Math.min(frame.height, Math.max(...corners.map((point) => point[1]))),
      };
      expectClose([box.x_min, box.y_min, box.x_max, box.y_max],
        [expected.x_min, expected.y_min, expected.x_max, expected.y_max], 2);
      expect(box.x_min).toBeGreaterThanOrEqual(0);
      expect(box.y_min).toBeGreaterThanOrEqual(0);
      expect(box.x_max).toBeLessThanOrEqual(frame.width);
      expect(box.y_max).toBeLessThanOrEqual(frame.height);
      expect(box.x_max).toBeGreaterThan(box.x_min);
      expect(box.y_max).toBeGreaterThan(box.y_min);
    }
  }, 60_000);
});

describe('canonical conversions', () => {
  const upright = buildCanonicalPageFrame({ view: [0, 0, 612, 792], rotation: 0 })!;
  const quarter = buildCanonicalPageFrame({ view: [20, 30, 600, 780], rotation: 90 })!;

  it('maps a native user-space box on an unrotated page by flipping Y only', () => {
    expect(pdfUserUnrotatedBoxToCanonical(upright, { x_min: 10, x_max: 30, y_min: 100, y_max: 112 }))
      .toEqual({ coordinate_space: 'canonical_v1', x_min: 10, x_max: 30, y_min: 680, y_max: 692 });
  });

  it('maps a native user-space box on a rotated, cropped page', () => {
    // rotate 90 sends user +Y to canonical +X and user +X to canonical +Y, offset by the crop origin.
    expect(pdfUserUnrotatedBoxToCanonical(quarter, { x_min: 120, x_max: 140, y_min: 230, y_max: 242 }))
      .toEqual({ coordinate_space: 'canonical_v1', x_min: 200, x_max: 212, y_min: 100, y_max: 120 });
  });

  it('removes only the render scale from OCR pixels, because the render embodies rotation and crop', () => {
    const render = { pixelWidth: quarter.width * 2, pixelHeight: quarter.height * 2 };
    expect(ocrRenderBoxToCanonical(quarter, { x_min: 400, x_max: 424, y_min: 200, y_max: 240 }, render))
      .toEqual({ coordinate_space: 'canonical_v1', x_min: 200, x_max: 212, y_min: 100, y_max: 120 });
    expect(ocrRenderBoxToCanonical(quarter, { x_min: 1, x_max: 2, y_min: 1, y_max: 2 },
      { pixelWidth: 0, pixelHeight: 10 })).toBeNull();
  });

  it('dispatches strictly on the explicit coordinate-space tag', () => {
    expect(toCanonicalBox(quarter, {
      coordinate_space: 'pdf_user_unrotated', x_min: 120, x_max: 140, y_min: 230, y_max: 242,
    })).toEqual(toCanonicalBox(quarter, {
      coordinate_space: 'ocr_render_px', x_min: 400, x_max: 424, y_min: 200, y_max: 240,
      pixel_width: quarter.width * 2, pixel_height: quarter.height * 2,
    }));
    expect(toCanonicalBox(quarter, { coordinate_space: 'unknown' } as never)).toBeNull();
  });

  it('clips to canonical bounds and rejects boxes wholly outside the page', () => {
    expect(clipCanonicalBox(upright, { x_min: -10, x_max: 20, y_min: 780, y_max: 800 }))
      .toEqual({ coordinate_space: 'canonical_v1', x_min: 0, x_max: 20, y_min: 780, y_max: 792 });
    expect(clipCanonicalBox(upright, { x_min: 700, x_max: 720, y_min: 10, y_max: 20 })).toBeNull();
    expect(clipCanonicalBox(upright, { x_min: 20, x_max: 10, y_min: 10, y_max: 20 })).toBeNull();
    // Native geometry outside the crop box (clipped away by the viewer) is not visible evidence.
    expect(pdfUserUnrotatedBoxToCanonical(quarter, { x_min: 0, x_max: 10, y_min: 0, y_max: 10 })).toBeNull();
  });

  it('converts canonical boxes to a viewer rectangle at any scale and fails closed off-page', () => {
    const box: CanonicalBox = { coordinate_space: 'canonical_v1', x_min: 200, x_max: 212, y_min: 100, y_max: 120 };
    const rect = canonicalBoxToViewportRect(quarter, box, 1.15)!;
    expectClose([rect.left, rect.top, rect.width, rect.height], [230, 115, 13.8, 23], 9);
    expect(canonicalBoxToViewportRect(quarter, { ...box, y_max: quarter.height + 1 }, 1)).toBeNull();
    expect(canonicalBoxToViewportRect(quarter, { ...box, x_max: box.x_min }, 1)).toBeNull();
    expect(isCanonicalBox({ ...box, coordinate_space: 'ocr_render_px' })).toBe(false);
  });

  it('computes overlap only between canonical boxes', () => {
    const left: CanonicalBox = { coordinate_space: 'canonical_v1', x_min: 0, x_max: 10, y_min: 0, y_max: 10 };
    const right: CanonicalBox = { coordinate_space: 'canonical_v1', x_min: 5, x_max: 15, y_min: 0, y_max: 10 };
    expect(canonicalIntersectionOverSmaller(left, right)).toBe(0.5);
    expect(canonicalIntersectionOverUnion(left, right)).toBeCloseTo(1 / 3, 9);
    expect(canonicalIntersectionOverSmaller(left, { ...right, coordinate_space: 'pdf_user_unrotated' } as never)).toBe(0);
  });
});
