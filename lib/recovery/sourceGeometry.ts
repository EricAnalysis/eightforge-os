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
}>;

export type ViewportRect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

/**
 * The sole persisted-source-space to rendered-viewport conversion.
 *
 * Native PDF observations use bottom-left, Y-up point coordinates. OCR uses
 * top-left render pixels, but Phase 14 has no persisted render dimensions, so
 * OCR fails closed unless its exact source dimensions are supplied. Rotated
 * pages likewise fail closed until a corpus fixture can falsify rotation math.
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
    || box.boundingBox.yMin >= box.boundingBox.yMax
    || (page.rotation ?? 0) % 360 !== 0) return null;

  if (box.sourceLayer === 'pdf_native_text') {
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

  if (!page.ocrPixelWidth || !page.ocrPixelHeight
    || !Number.isFinite(page.ocrPixelWidth) || !Number.isFinite(page.ocrPixelHeight)
    || page.ocrPixelWidth <= 0 || page.ocrPixelHeight <= 0
    || box.boundingBox.xMin < 0 || box.boundingBox.yMin < 0
    || box.boundingBox.xMax > page.ocrPixelWidth
    || box.boundingBox.yMax > page.ocrPixelHeight) return null;
  const xScale = page.viewportWidth / page.ocrPixelWidth;
  const yScale = page.viewportHeight / page.ocrPixelHeight;
  return {
    left: box.boundingBox.xMin * xScale,
    top: box.boundingBox.yMin * yScale,
    width: (box.boundingBox.xMax - box.boundingBox.xMin) * xScale,
    height: (box.boundingBox.yMax - box.boundingBox.yMin) * yScale,
  };
}
