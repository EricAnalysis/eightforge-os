import {
  buildCanonicalPageFrame,
  canonicalBoxToViewportRect,
  toCanonicalBox,
  type CanonicalPageFrame,
  type GeometryCoordinateSpace,
} from '@/lib/extraction/geometry/canonicalPageFrame';
import type { VisualSourceBox } from '@/lib/recovery/visualSourceEvidence';

export type SourcePageGeometry = Readonly<{
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  rotation?: number;
  pageWidthPoints: number;
  pageHeightPoints: number;
  ocrPixelWidth?: number;
  ocrPixelHeight?: number;
  /** The rendered page's own view box, from the pdf.js viewport. */
  viewBox?: readonly number[];
  userUnit?: number;
}>;

export type ViewportRect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

/**
 * The historical (v1) coordinate space of persisted visual evidence.
 *
 * v1 evidence carries no coordinate-space tag, so the space comes from the
 * layer contract it was written under: native boxes are bottom-left PDF user
 * space, OCR boxes are top-left render pixels. This function is the single
 * place that mapping is allowed to happen, and only for untagged historical
 * records. New evidence carries its space explicitly.
 */
export function historicalV1CoordinateSpace(
  sourceLayer: VisualSourceBox['sourceLayer'],
): Exclude<GeometryCoordinateSpace, 'canonical_v1'> {
  return sourceLayer === 'ocr' ? 'ocr_render_px' : 'pdf_user_unrotated';
}

function frameOf(page: SourcePageGeometry): CanonicalPageFrame | null {
  if (!page.viewBox) return null;
  return buildCanonicalPageFrame({
    view: page.viewBox,
    rotation: page.rotation ?? 0,
    userUnit: page.userUnit ?? 1,
  });
}

/**
 * The sole persisted-source-space to rendered-viewport conversion.
 *
 * Canonical (canonical_v1) geometry is preferred and needs no OCR side lookup.
 * Historical v1 evidence stays renderable: its box is converted from its own
 * space through the page's canonical frame, which is what makes rotated and
 * cropped pages work. Without a frame the conversion keeps the pre-E2
 * behaviour, including failing closed on rotation and on OCR without exact
 * render dimensions.
 */
export function toViewportRect(
  box: VisualSourceBox,
  page: SourcePageGeometry,
): ViewportRect | null {
  const values = [
    box.boundingBox.xMin, box.boundingBox.xMax,
    box.boundingBox.yMin, box.boundingBox.yMax,
    page.viewportWidth, page.viewportHeight, page.scale,
    page.pageWidthPoints, page.pageHeightPoints,
  ];
  if (values.some((value) => !Number.isFinite(value))
    || page.scale <= 0 || page.pageWidthPoints <= 0 || page.pageHeightPoints <= 0
    || box.boundingBox.xMin >= box.boundingBox.xMax
    || box.boundingBox.yMin >= box.boundingBox.yMax) return null;

  const frame = frameOf(page);
  if (frame && box.canonicalBoundingBox) {
    return canonicalBoxToViewportRect(frame, box.canonicalBoundingBox, page.scale);
  }

  const space = box.sourceCoordinateSpace ?? historicalV1CoordinateSpace(box.sourceLayer);
  if (space === 'ocr_render_px') {
    if (!page.ocrPixelWidth || !page.ocrPixelHeight
      || !Number.isFinite(page.ocrPixelWidth) || !Number.isFinite(page.ocrPixelHeight)
      || page.ocrPixelWidth <= 0 || page.ocrPixelHeight <= 0
      || box.boundingBox.xMin < 0 || box.boundingBox.yMin < 0
      || box.boundingBox.xMax > page.ocrPixelWidth
      || box.boundingBox.yMax > page.ocrPixelHeight) return null;
    if (frame) {
      const canonical = toCanonicalBox(frame, {
        coordinate_space: 'ocr_render_px',
        x_min: box.boundingBox.xMin, x_max: box.boundingBox.xMax,
        y_min: box.boundingBox.yMin, y_max: box.boundingBox.yMax,
        pixel_width: page.ocrPixelWidth, pixel_height: page.ocrPixelHeight,
      });
      return canonical ? canonicalBoxToViewportRect(frame, canonical, page.scale) : null;
    }
    if ((page.rotation ?? 0) % 360 !== 0) return null;
    const xScale = page.viewportWidth / page.ocrPixelWidth;
    const yScale = page.viewportHeight / page.ocrPixelHeight;
    return {
      left: box.boundingBox.xMin * xScale,
      top: box.boundingBox.yMin * yScale,
      width: (box.boundingBox.xMax - box.boundingBox.xMin) * xScale,
      height: (box.boundingBox.yMax - box.boundingBox.yMin) * yScale,
    };
  }

  if (frame) {
    const [x0, y0, x1, y1] = frame.view;
    // Native evidence outside the viewer-visible box is not visible evidence.
    if (box.boundingBox.xMin < x0 || box.boundingBox.yMin < y0
      || box.boundingBox.xMax > x1 || box.boundingBox.yMax > y1) return null;
    const canonical = toCanonicalBox(frame, {
      coordinate_space: 'pdf_user_unrotated',
      x_min: box.boundingBox.xMin, x_max: box.boundingBox.xMax,
      y_min: box.boundingBox.yMin, y_max: box.boundingBox.yMax,
    });
    return canonical ? canonicalBoxToViewportRect(frame, canonical, page.scale) : null;
  }

  if ((page.rotation ?? 0) % 360 !== 0) return null;
  if (box.boundingBox.xMin < 0 || box.boundingBox.yMin < 0
    || box.boundingBox.xMax > page.pageWidthPoints
    || box.boundingBox.yMax > page.pageHeightPoints) return null;
  return {
    left: box.boundingBox.xMin * page.scale,
    top: (page.pageHeightPoints - box.boundingBox.yMax) * page.scale,
    width: (box.boundingBox.xMax - box.boundingBox.xMin) * page.scale,
    height: (box.boundingBox.yMax - box.boundingBox.yMin) * page.scale,
  };
}
