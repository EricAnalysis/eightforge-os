import { sha256Hex } from '@/lib/extraction/domain/hash';
import type { CanonicalBox } from '@/lib/extraction/geometry/canonicalPageFrame';
import type {
  ValueReadingCropSpec,
  ValueReadingRegionImage,
  ValueReadingRegionRenderer,
} from '@/lib/server/valueReadingEngine';

/**
 * Forgewing B4.5 region renderer. Draws exactly one priced line of one
 * verified source artifact and nothing else of the page:
 *
 *   stored source bytes
 *     -> SHA-256 must equal the artifact ledger's source_sha256
 *     -> pdf.js page at a fixed scale (canonical_v1 is the pdf.js viewport at scale 1)
 *     -> the line's canonical boxes, padded, as an integer pixel rectangle
 *     -> exactly those pixels, PNG-encoded
 *
 * The engine hashes the returned bytes into the request digest; this module
 * never reports a digest of its own. Any doubt (unknown artifact, changed
 * bytes, missing page, unprovable or oversized region) returns null, which the
 * engine records as `evidence_binding_failed / region_image_unavailable` before
 * any budget or provider is touched.
 */

export type ValueReadingCropPixels = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * The pixel rectangle for a crop, on a page rendered at `spec.scale`. Pure
 * and deterministic: the union of the canonical boxes, padded, scaled,
 * snapped outward to whole pixels and clipped to the page. Null when the
 * region is empty, not finite, or larger than one line may be.
 */
export function valueReadingCropPixels(
  spec: Pick<ValueReadingCropSpec, 'canonicalBoxes' | 'scale' | 'paddingPoints' | 'maxWidthPx' | 'maxHeightPx'>,
  page: Readonly<{ widthPx: number; heightPx: number }>,
): ValueReadingCropPixels | null {
  const boxes: readonly CanonicalBox[] = spec.canonicalBoxes;
  if (boxes.length === 0 || !(spec.scale > 0) || !(spec.paddingPoints >= 0)
    || !Number.isInteger(page.widthPx) || !Number.isInteger(page.heightPx) || page.widthPx <= 0 || page.heightPx <= 0) {
    return null;
  }
  const values = boxes.flatMap((box) => [box.x_min, box.x_max, box.y_min, box.y_max]);
  if (!values.every(Number.isFinite) || boxes.some((box) => box.coordinate_space !== 'canonical_v1')) return null;
  const xMin = Math.min(...boxes.map((box) => box.x_min)) - spec.paddingPoints;
  const xMax = Math.max(...boxes.map((box) => box.x_max)) + spec.paddingPoints;
  const yMin = Math.min(...boxes.map((box) => box.y_min)) - spec.paddingPoints;
  const yMax = Math.max(...boxes.map((box) => box.y_max)) + spec.paddingPoints;
  const left = Math.max(0, Math.floor(xMin * spec.scale));
  const top = Math.max(0, Math.floor(yMin * spec.scale));
  const right = Math.min(page.widthPx, Math.ceil(xMax * spec.scale));
  const bottom = Math.min(page.heightPx, Math.ceil(yMax * spec.scale));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0 || width > spec.maxWidthPx || height > spec.maxHeightPx) return null;
  return { x: left, y: top, width, height };
}

/** Renders the crop from source bytes already verified against the artifact. */
export async function renderValueReadingCrop(
  sourceBytes: Uint8Array,
  spec: ValueReadingCropSpec,
): Promise<ValueReadingRegionImage | null> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  // pdf.js may detach the buffer it is given; the caller's bytes stay intact.
  const loading = pdfjs.getDocument({ data: new Uint8Array(sourceBytes), isEvalSupported: false });
  const document = await loading.promise;
  try {
    if (!Number.isInteger(spec.physicalPageNumber) || spec.physicalPageNumber < 1
      || spec.physicalPageNumber > document.numPages) return null;
    const page = await document.getPage(spec.physicalPageNumber);
    const viewport = page.getViewport({ scale: spec.scale });
    const widthPx = Math.floor(viewport.width);
    const heightPx = Math.floor(viewport.height);
    const rect = valueReadingCropPixels(spec, { widthPx, heightPx });
    if (!rect) return null;
    const canvas = createCanvas(widthPx, heightPx);
    const context = canvas.getContext('2d');
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    // Copy exactly the rectangle's pixels: no resampling, no smoothing.
    const crop = createCanvas(rect.width, rect.height);
    crop.getContext('2d').putImageData(context.getImageData(rect.x, rect.y, rect.width, rect.height), 0, 0);
    return { mediaType: 'image/png', bytes: new Uint8Array(crop.toBuffer('image/png')) };
  } finally {
    await document.destroy();
  }
}

export type ValueReadingSourceClient = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        eq(column: string, value: unknown): {
          eq(column: string, value: unknown): {
            maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
          };
          maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
  storage: {
    from(bucket: string): {
      download(path: string): PromiseLike<{ data: Blob | null; error: unknown }>;
    };
  };
};

export const VALUE_READING_SOURCE_BUCKET = process.env.NEXT_PUBLIC_SUPABASE_DOCS_BUCKET || 'documents';

/**
 * Loads the stored source bytes for the crop's artifact, only if they still
 * hash to the artifact ledger's source_sha256 within the same organization
 * and document. Anything else is null: the image is never drawn from bytes the
 * extraction did not read.
 */
export async function loadVerifiedValueReadingSource(
  admin: ValueReadingSourceClient,
  spec: Pick<ValueReadingCropSpec, 'organizationId' | 'sourceDocumentId' | 'sourceArtifactId'>,
): Promise<Uint8Array | null> {
  const artifact = await admin.from('extraction_source_artifacts')
    .select('id, organization_id, source_document_id, source_sha256')
    .eq('id', spec.sourceArtifactId).eq('organization_id', spec.organizationId).maybeSingle();
  const artifactRow = artifact.data as { source_document_id?: unknown; source_sha256?: unknown } | null;
  if (artifact.error || !artifactRow || artifactRow.source_document_id !== spec.sourceDocumentId
    || typeof artifactRow.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifactRow.source_sha256)) return null;
  const document = await admin.from('documents').select('id, organization_id, storage_path')
    .eq('id', spec.sourceDocumentId).eq('organization_id', spec.organizationId).maybeSingle();
  const documentRow = document.data as { storage_path?: unknown } | null;
  if (document.error || typeof documentRow?.storage_path !== 'string' || !documentRow.storage_path) return null;
  const downloaded = await admin.storage.from(VALUE_READING_SOURCE_BUCKET).download(documentRow.storage_path);
  if (downloaded.error || !downloaded.data) return null;
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  return sha256Hex(bytes) === artifactRow.source_sha256 ? bytes : null;
}

/** The production renderer: verified bytes, then the exact crop. Never throws. */
export function createValueReadingRegionRenderer(
  loadSource: (spec: ValueReadingCropSpec) => Promise<Uint8Array | null>,
): ValueReadingRegionRenderer {
  return async (spec) => {
    try {
      const bytes = await loadSource(spec);
      return bytes ? await renderValueReadingCrop(bytes, spec) : null;
    } catch {
      return null;
    }
  };
}
