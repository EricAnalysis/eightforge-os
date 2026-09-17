/**
 * Render decode inspection: whether every image a page paints actually decoded.
 *
 * pdf.js swallows image decoder failures. The failed image dependency resolves
 * to `null` in the page object pool, `page.render()` still succeeds, and the
 * canvas silently skips the image. OCR over that render reads only whatever
 * else is painted (a DocuSign stamp, a header), so a successful render is not
 * evidence that the page's visual content was seen.
 *
 * The coverage rule this supports is decoder-agnostic: a page whose painted
 * images did not all provably decode cannot establish OCR coverage. `decoder`
 * only records what failed ('jpx' today); nothing downstream branches on it.
 *
 * Only public pdf.js display APIs are used: `getOperatorList()`, `OPS`,
 * `page.objs` and `page.commonObjs`. If that surface is unavailable or cannot
 * be read, the result is `unverifiable`, never `clean`.
 */

export const RENDER_DECODE_INSPECTION_VERSION = 'render_decode_inspection_v1' as const;

export type RenderDecodeFailure = Readonly<{
  object_id: string;
  decoder: 'jpx' | 'unknown';
  message_class:
    | 'pdfjs_image_dependency_resolved_null'
    | 'pdfjs_inline_image_missing_data';
}>;

export type RenderDecodeInspection = Readonly<{
  version: typeof RENDER_DECODE_INSPECTION_VERSION;
  state: 'clean' | 'failed' | 'unverifiable';
  painted_image_count: number;
  decode_failures: readonly RenderDecodeFailure[];
  /** Present only when state is `unverifiable`. */
  unverifiable_reason?:
    | 'operator_list_unavailable'
    | 'object_pool_unavailable'
    | 'image_dependency_timeout'
    | 'inspection_threw';
}>;

type ObjectPool = Readonly<{
  has: (objId: string) => boolean;
  get: (objId: string, callback?: (data: unknown) => void) => unknown;
}>;

/**
 * Image data reaches the page object pool in its own worker message, after the
 * operator list that references it. A dependency is therefore awaited, never
 * read as missing just because it has not arrived yet.
 */
const IMAGE_DEPENDENCY_TIMEOUT_MS = 60_000;

function awaitDependency(pool: ObjectPool, objectId: string, timeoutMs: number):
  Promise<{ resolved: true; data: unknown } | { resolved: false }> {
  if (pool.has(objectId)) return Promise.resolve({ resolved: true, data: pool.get(objectId) });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ resolved: false }), timeoutMs);
    pool.get(objectId, (data) => {
      clearTimeout(timer);
      resolve({ resolved: true, data });
    });
  });
}

export type InspectablePdfPage = Readonly<{
  getOperatorList: () => Promise<{ fnArray?: readonly number[]; argsArray?: readonly unknown[] }>;
  objs?: ObjectPool;
  commonObjs?: ObjectPool;
}>;

function isObjectPool(value: unknown): value is ObjectPool {
  return value != null && typeof value === 'object'
    && typeof (value as ObjectPool).has === 'function'
    && typeof (value as ObjectPool).get === 'function';
}

function unverifiable(
  reason: NonNullable<RenderDecodeInspection['unverifiable_reason']>,
  paintedImageCount = 0,
): RenderDecodeInspection {
  return Object.freeze({
    version: RENDER_DECODE_INSPECTION_VERSION,
    state: 'unverifiable',
    painted_image_count: paintedImageCount,
    decode_failures: Object.freeze([]),
    unverifiable_reason: reason,
  });
}

/**
 * Inspects the images a page paints. Image data is decoded while the operator
 * list is built, so this runs before the page is rendered for OCR.
 */
export async function inspectPageImageDecoding(
  page: InspectablePdfPage,
  ops: Readonly<Record<string, number>> | undefined,
  options: Readonly<{ dependencyTimeoutMs?: number }> = {},
): Promise<RenderDecodeInspection> {
  try {
    if (!ops || typeof page.getOperatorList !== 'function') {
      return unverifiable('operator_list_unavailable');
    }
    const byReference = new Set([ops.paintImageXObject, ops.paintImageXObjectRepeat]
      .filter((value): value is number => typeof value === 'number'));
    const inline = new Set([ops.paintInlineImageXObject, ops.paintInlineImageXObjectGroup,
      ops.paintImageMaskXObject, ops.paintImageMaskXObjectGroup, ops.paintImageMaskXObjectRepeat]
      .filter((value): value is number => typeof value === 'number'));
    if (byReference.size === 0) return unverifiable('operator_list_unavailable');

    const operatorList = await page.getOperatorList();
    const fnArray = operatorList?.fnArray;
    const argsArray = operatorList?.argsArray;
    if (!Array.isArray(fnArray) || !Array.isArray(argsArray)) {
      return unverifiable('operator_list_unavailable');
    }

    let paintedImageCount = 0;
    const failures = new Map<string, RenderDecodeFailure>();
    const referenced = new Map<string, ObjectPool>();
    for (let index = 0; index < fnArray.length; index += 1) {
      const fn = fnArray[index];
      const args = argsArray[index] as unknown[] | null | undefined;
      if (!byReference.has(fn) && !inline.has(fn)) continue;
      paintedImageCount += 1;
      const payload = args?.[0];
      if (typeof payload === 'string') {
        // Document-wide cached images live in commonObjs under a `g_` prefix.
        const pool = payload.startsWith('g_') ? page.commonObjs : page.objs;
        if (!isObjectPool(pool)) return unverifiable('object_pool_unavailable', paintedImageCount);
        referenced.set(payload, pool);
      } else if (byReference.has(fn)) {
        // A by-reference paint must name its object; anything else is unreadable.
        return unverifiable('operator_list_unavailable', paintedImageCount);
      } else if (payload == null) {
        // Inline images and masks carry their decoded data in the arguments.
        const objectId = `inline:${index}`;
        failures.set(objectId, Object.freeze({
          object_id: objectId, decoder: 'unknown', message_class: 'pdfjs_inline_image_missing_data',
        }));
      }
    }

    const timeoutMs = options.dependencyTimeoutMs ?? IMAGE_DEPENDENCY_TIMEOUT_MS;
    const dependencies = await Promise.all([...referenced.entries()].map(async ([objectId, pool]) =>
      [objectId, await awaitDependency(pool, objectId, timeoutMs)] as const));
    // A dependency that never arrived is not proof of a failed decode, and it
    // is certainly not proof of a clean one.
    if (dependencies.some(([, dependency]) => !dependency.resolved)) {
      return unverifiable('image_dependency_timeout', paintedImageCount);
    }
    for (const [objectId, dependency] of dependencies) {
      if (dependency.resolved && dependency.data == null) {
        failures.set(objectId, Object.freeze({
          object_id: objectId, decoder: 'unknown', message_class: 'pdfjs_image_dependency_resolved_null',
        }));
      }
    }

    return Object.freeze({
      version: RENDER_DECODE_INSPECTION_VERSION,
      state: failures.size > 0 ? 'failed' : 'clean',
      painted_image_count: paintedImageCount,
      decode_failures: Object.freeze([...failures.values()]
        .sort((left, right) => left.object_id.localeCompare(right.object_id, 'en-US'))),
    });
  } catch {
    return unverifiable('inspection_threw');
  }
}

/**
 * Names the decoder conservatively, for the audit record only. A failure is
 * `jpx` only when every image dictionary on the extracted single page uses
 * JPXDecode; anything ambiguous, mixed or unreadable stays `unknown`.
 */
export async function classifyDecodeFailures(
  document: Readonly<{ extractPages?: (pageInfos: unknown[]) => Promise<Uint8Array | null> }>,
  pageNumber: number,
  inspection: RenderDecodeInspection,
): Promise<RenderDecodeInspection> {
  if (inspection.state !== 'failed' || typeof document.extractPages !== 'function') return inspection;
  let decoder: RenderDecodeFailure['decoder'] = 'unknown';
  try {
    const bytes = await document.extractPages([{ document: null, includePages: [pageNumber - 1] }]);
    if (bytes && bytes.length > 0) {
      const text = Buffer.from(bytes).toString('latin1');
      const imageDictionaries = [...text.matchAll(
        /<<(?:(?!<<|>>)[\s\S])*\/Subtype\s*\/Image(?:(?!>>)[\s\S])*>>/g,
      )].map((match) => match[0]);
      if (imageDictionaries.length > 0
        && imageDictionaries.every((dictionary) => /\/JPXDecode\b/.test(dictionary))) {
        decoder = 'jpx';
      }
    }
  } catch {
    decoder = 'unknown';
  }
  return Object.freeze({
    ...inspection,
    decode_failures: Object.freeze(inspection.decode_failures.map((failure) =>
      failure.message_class === 'pdfjs_inline_image_missing_data'
        ? failure
        : Object.freeze({ ...failure, decoder }))),
  });
}
