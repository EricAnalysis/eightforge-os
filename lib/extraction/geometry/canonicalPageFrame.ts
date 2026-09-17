/**
 * Canonical page geometry contract (Extraction Evidence V2, E2).
 *
 * `canonical_frame_v1` is the one coordinate language every extractor and
 * viewer consumer converts into:
 *
 * - page box: the viewer-visible crop box (pdf.js `page.view`)
 * - rotation: the page's /Rotate applied
 * - origin: top-left, +X right, +Y down
 * - units: PDF points (times the page UserUnit, exactly as a pdf.js viewport
 *   at scale 1 reports them)
 * - boxes are clipped to the canonical page bounds
 *
 * It is therefore identical to a pdf.js `page.getViewport({ scale: 1 })`
 * coordinate space, and this module reproduces that viewport transform as pure
 * math so extraction, reconciliation and the viewer share one implementation.
 *
 * E2 is additive normalization only. Source geometry keeps its historical
 * meaning and is never rewritten: native pdf.js boxes stay `pdf_user_unrotated`
 * and OCR boxes stay `ocr_render_px`, because those values participate in
 * recovery candidate digests, proposal IDs/digests, reviewed confirmation
 * binding and layout-observation exact-match checks. Canonical boxes are a
 * derived view carried beside that evidence, never inside an identity-bearing
 * structure. Binding identity to canonical geometry is deferred to the
 * versioned identity work (E9 / RecoveryCandidateV3).
 *
 * Every box crossing an extraction/viewer boundary carries an explicit
 * `coordinate_space`. Nothing here infers a space from a source layer,
 * extractor name or field presence.
 */

export const CANONICAL_FRAME_VERSION = 'canonical_frame_v1' as const;

export type GeometryCoordinateSpace = 'canonical_v1' | 'pdf_user_unrotated' | 'ocr_render_px';

export type PageRotation = 0 | 90 | 180 | 270;

/** [a, b, c, d, e, f] affine matrix mapping (x, y) to (a*x + c*y + e, b*x + d*y + f). */
export type AffineMatrix = readonly [number, number, number, number, number, number];

export type CanonicalPageFrame = Readonly<{
  frame_version: typeof CANONICAL_FRAME_VERSION;
  coordinate_space: 'canonical_v1';
  /** Viewer-visible page box in PDF user space: [x0, y0, x1, y1], normalized so x0 <= x1, y0 <= y1. */
  view: readonly [number, number, number, number];
  rotation: PageRotation;
  user_unit: number;
  /** Canonical page width/height after rotation. */
  width: number;
  height: number;
}>;

export type AxisAlignedBox = Readonly<{
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
}>;

export type CanonicalBox = AxisAlignedBox & Readonly<{ coordinate_space: 'canonical_v1' }>;

/** Historical native evidence: PDF user space, bottom-left origin, /Rotate and crop not applied. */
export type PdfUserUnrotatedBox = AxisAlignedBox & Readonly<{ coordinate_space: 'pdf_user_unrotated' }>;

/** Historical OCR evidence: top-left pixels of a render of the viewer-visible, rotated page. */
export type OcrRenderPxBox = AxisAlignedBox & Readonly<{
  coordinate_space: 'ocr_render_px';
  pixel_width: number;
  pixel_height: number;
}>;

export type TaggedGeometryBox = CanonicalBox | PdfUserUnrotatedBox | OcrRenderPxBox;

export type ViewportRect = Readonly<{ left: number; top: number; width: number; height: number }>;

const PRECISION = 1000;

function round(value: number): number {
  const rounded = Math.round(value * PRECISION) / PRECISION;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function finite(...values: readonly number[]): boolean {
  return values.every((value) => typeof value === 'number' && Number.isFinite(value));
}

export function normalizePageRotation(rotation: unknown): PageRotation | null {
  if (typeof rotation !== 'number' || !Number.isInteger(rotation) || rotation % 90 !== 0) return null;
  return (((rotation % 360) + 360) % 360) as PageRotation;
}

export function buildCanonicalPageFrame(input: Readonly<{
  view: readonly number[];
  rotation: unknown;
  userUnit?: number;
}>): CanonicalPageFrame | null {
  const rotation = normalizePageRotation(input.rotation);
  const userUnit = input.userUnit ?? 1;
  if (rotation === null || input.view.length !== 4 || !finite(...input.view, userUnit) || userUnit <= 0) {
    return null;
  }
  const [ax, ay, bx, by] = input.view as [number, number, number, number];
  const view = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] as const;
  const boxWidth = (view[2] - view[0]) * userUnit;
  const boxHeight = (view[3] - view[1]) * userUnit;
  if (boxWidth <= 0 || boxHeight <= 0) return null;
  const quarterTurn = rotation === 90 || rotation === 270;
  return Object.freeze({
    frame_version: CANONICAL_FRAME_VERSION,
    coordinate_space: 'canonical_v1',
    view: Object.freeze(view),
    rotation,
    user_unit: userUnit,
    width: quarterTurn ? boxHeight : boxWidth,
    height: quarterTurn ? boxWidth : boxHeight,
  });
}

export function isCanonicalPageFrame(value: unknown): value is CanonicalPageFrame {
  if (value == null || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  if (frame.frame_version !== CANONICAL_FRAME_VERSION || frame.coordinate_space !== 'canonical_v1'
    || !Array.isArray(frame.view) || typeof frame.user_unit !== 'number') return false;
  const rebuilt = buildCanonicalPageFrame({
    view: frame.view as number[], rotation: frame.rotation, userUnit: frame.user_unit,
  });
  return rebuilt !== null && rebuilt.rotation === frame.rotation
    && rebuilt.width === frame.width && rebuilt.height === frame.height
    && rebuilt.view.every((entry, index) => entry === (frame.view as number[])[index]);
}

/**
 * PDF user space -> canonical_v1. Mirrors pdf.js `PageViewport` at scale 1,
 * offset 0, without `dontFlip`.
 */
export function canonicalFrameMatrix(frame: CanonicalPageFrame): AffineMatrix {
  const [x0, y0, x1, y1] = frame.view;
  const scale = frame.user_unit;
  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;
  const [a, b, c, d] = frame.rotation === 0 ? [1, 0, 0, -1]
    : frame.rotation === 90 ? [0, 1, 1, 0]
      : frame.rotation === 180 ? [-1, 0, 0, 1]
        : [0, -1, -1, 0];
  const offsetX = (a === 0 ? Math.abs(centerY - y0) : Math.abs(centerX - x0)) * scale;
  const offsetY = (a === 0 ? Math.abs(centerX - x0) : Math.abs(centerY - y0)) * scale;
  return [
    a * scale, b * scale, c * scale, d * scale,
    offsetX - a * scale * centerX - c * scale * centerY,
    offsetY - b * scale * centerX - d * scale * centerY,
  ];
}

function apply(matrix: AffineMatrix, x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

export function pdfUserPointToCanonical(frame: CanonicalPageFrame, x: number, y: number): [number, number] {
  return apply(canonicalFrameMatrix(frame), x, y);
}

export function canonicalPointToPdfUser(frame: CanonicalPageFrame, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = canonicalFrameMatrix(frame);
  const determinant = a * d - b * c;
  return [(d * (x - e) - c * (y - f)) / determinant, (a * (y - f) - b * (x - e)) / determinant];
}

function aabb(points: readonly (readonly [number, number])[]): AxisAlignedBox {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return { x_min: Math.min(...xs), y_min: Math.min(...ys), x_max: Math.max(...xs), y_max: Math.max(...ys) };
}

/**
 * Clips to the canonical page bounds. Returns null only when the box lies
 * wholly outside the page; a box that merely touches an edge survives with
 * zero extent on that axis.
 */
export function clipCanonicalBox(frame: CanonicalPageFrame, box: AxisAlignedBox): CanonicalBox | null {
  if (!finite(box.x_min, box.y_min, box.x_max, box.y_max)
    || box.x_min > box.x_max || box.y_min > box.y_max) return null;
  const x_min = Math.max(0, box.x_min);
  const y_min = Math.max(0, box.y_min);
  const x_max = Math.min(frame.width, box.x_max);
  const y_max = Math.min(frame.height, box.y_max);
  if (x_min > x_max || y_min > y_max) return null;
  return Object.freeze({
    coordinate_space: 'canonical_v1',
    x_min: round(x_min), y_min: round(y_min), x_max: round(x_max), y_max: round(y_max),
  });
}

/**
 * A pdf.js text item (`transform`, `width`, `height`) -> canonical AABB.
 *
 * The run is the parallelogram spanned from its baseline origin by `width`
 * along the text direction (transform a,b) and `height` along the glyph up
 * vector (transform c,d). This handles rotated and skewed runs; the quad is
 * mapped through the page frame and its axis-aligned bounds are taken. The box
 * starts at the baseline, as the legacy native box always did.
 */
export function nativeTextRunCanonicalBox(
  frame: CanonicalPageFrame,
  item: Readonly<{ transform: readonly number[]; width: number; height: number }>,
): CanonicalBox | null {
  if (item.transform.length < 6 || !finite(...item.transform.slice(0, 6), item.width, item.height)) return null;
  const [a, b, c, d, e, f] = item.transform as [number, number, number, number, number, number];
  const directionLength = Math.hypot(a, b);
  const direction: [number, number] = directionLength > 0 ? [a / directionLength, b / directionLength] : [1, 0];
  const upLength = Math.hypot(c, d);
  const up: [number, number] = upLength > 0 ? [c / upLength, d / upLength] : [-direction[1], direction[0]];
  const width = Math.max(0, item.width);
  const height = Math.max(0, item.height);
  const matrix = canonicalFrameMatrix(frame);
  const corners = [
    [e, f],
    [e + direction[0] * width, f + direction[1] * width],
    [e + up[0] * height, f + up[1] * height],
    [e + direction[0] * width + up[0] * height, f + direction[1] * width + up[1] * height],
  ].map(([x, y]) => apply(matrix, x!, y!));
  return clipCanonicalBox(frame, aabb(corners));
}

export function pdfUserUnrotatedBoxToCanonical(
  frame: CanonicalPageFrame,
  box: AxisAlignedBox,
): CanonicalBox | null {
  if (!finite(box.x_min, box.y_min, box.x_max, box.y_max)
    || box.x_min > box.x_max || box.y_min > box.y_max) return null;
  const matrix = canonicalFrameMatrix(frame);
  return clipCanonicalBox(frame, aabb([
    apply(matrix, box.x_min, box.y_min), apply(matrix, box.x_max, box.y_min),
    apply(matrix, box.x_min, box.y_max), apply(matrix, box.x_max, box.y_max),
  ]));
}

/**
 * OCR render pixels -> canonical. The render is of the viewer-visible,
 * rotated page, so rotation and crop are already embodied in the pixels and
 * only the render scale is removed.
 */
export function ocrRenderBoxToCanonical(
  frame: CanonicalPageFrame,
  box: AxisAlignedBox,
  render: Readonly<{ pixelWidth: number; pixelHeight: number }>,
): CanonicalBox | null {
  if (!finite(render.pixelWidth, render.pixelHeight) || render.pixelWidth <= 0 || render.pixelHeight <= 0) {
    return null;
  }
  const scaleX = frame.width / render.pixelWidth;
  const scaleY = frame.height / render.pixelHeight;
  return clipCanonicalBox(frame, {
    x_min: box.x_min * scaleX, x_max: box.x_max * scaleX,
    y_min: box.y_min * scaleY, y_max: box.y_max * scaleY,
  });
}

/** Dispatches strictly on the box's explicit coordinate-space tag. */
export function toCanonicalBox(frame: CanonicalPageFrame, box: TaggedGeometryBox): CanonicalBox | null {
  switch (box.coordinate_space) {
    case 'canonical_v1':
      return clipCanonicalBox(frame, box);
    case 'pdf_user_unrotated':
      return pdfUserUnrotatedBoxToCanonical(frame, box);
    case 'ocr_render_px':
      return ocrRenderBoxToCanonical(frame, box, { pixelWidth: box.pixel_width, pixelHeight: box.pixel_height });
    default:
      return null;
  }
}

export function isCanonicalBox(value: unknown): value is CanonicalBox {
  if (value == null || typeof value !== 'object') return false;
  const box = value as Record<string, unknown>;
  return box.coordinate_space === 'canonical_v1'
    && typeof box.x_min === 'number' && typeof box.y_min === 'number'
    && typeof box.x_max === 'number' && typeof box.y_max === 'number'
    && finite(box.x_min, box.y_min, box.x_max, box.y_max)
    && box.x_min <= box.x_max && box.y_min <= box.y_max;
}

/**
 * canonical_v1 -> a pdf.js viewport rendered at `scale` over the same page
 * (same view box and rotation). Fails closed for a box outside the frame or
 * without positive area, never drawing an approximate highlight.
 */
export function canonicalBoxToViewportRect(
  frame: CanonicalPageFrame,
  box: CanonicalBox,
  scale: number,
): ViewportRect | null {
  if (!isCanonicalBox(box) || !finite(scale) || scale <= 0
    || box.x_min >= box.x_max || box.y_min >= box.y_max
    || box.x_min < 0 || box.y_min < 0 || box.x_max > frame.width || box.y_max > frame.height) return null;
  return {
    left: box.x_min * scale,
    top: box.y_min * scale,
    width: (box.x_max - box.x_min) * scale,
    height: (box.y_max - box.y_min) * scale,
  };
}

function intersectionArea(left: CanonicalBox, right: CanonicalBox): number {
  const width = Math.max(0, Math.min(left.x_max, right.x_max) - Math.max(left.x_min, right.x_min));
  const height = Math.max(0, Math.min(left.y_max, right.y_max) - Math.max(left.y_min, right.y_min));
  return width * height;
}

function area(box: CanonicalBox): number {
  return Math.max(0, box.x_max - box.x_min) * Math.max(0, box.y_max - box.y_min);
}

/** Intersection over the smaller box's area; both boxes must be canonical_v1. */
export function canonicalIntersectionOverSmaller(left: CanonicalBox, right: CanonicalBox): number {
  if (left.coordinate_space !== 'canonical_v1' || right.coordinate_space !== 'canonical_v1') return 0;
  const smaller = Math.min(area(left), area(right));
  return smaller > 0 ? intersectionArea(left, right) / smaller : 0;
}

export function canonicalIntersectionOverUnion(left: CanonicalBox, right: CanonicalBox): number {
  if (left.coordinate_space !== 'canonical_v1' || right.coordinate_space !== 'canonical_v1') return 0;
  const intersection = intersectionArea(left, right);
  const union = area(left) + area(right) - intersection;
  return union > 0 ? intersection / union : 0;
}
