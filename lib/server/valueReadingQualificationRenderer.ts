import { sha256Hex } from '@/lib/extraction/domain/hash';
import type { ValueReadingCropSpec } from '@/lib/server/valueReadingEngine';
import { valueReadingCropPixels } from '@/lib/server/valueReadingRegionRenderer';
import type { ValueReadingRegionImage } from '@/lib/valueReadingContract';

export type QualificationRenderTiming = Readonly<{
  stage: 'pdf_load' | 'page_load' | 'raster_render' | 'png_encode' | 'dispose';
  durationMs: number;
  physicalPageNumber: number | null;
}>;

/**
 * Qualification-only source-bound renderer. Retains PDF parsing/page resources
 * for one run; every call still paints and encodes the original crop afresh.
 * Historical and production renderers remain separate and unchanged.
 */
export function createValueReadingQualificationRenderer(
  sourceBytes: Uint8Array,
  options: Readonly<{ observe?: (timing: QualificationRenderTiming) => void }> = {},
): Readonly<{
  sourceSha256: string;
  render(spec: ValueReadingCropSpec): Promise<ValueReadingRegionImage | null>;
  dispose(): Promise<void>;
}> {
  // Own the verified bytes: neither callers nor pdf.js may mutate their identity.
  const source = new Uint8Array(sourceBytes);
  const sourceSha256 = sha256Hex(source);
  type PdfDocument = Awaited<ReturnType<(typeof import('pdfjs-dist/legacy/build/pdf.mjs'))['getDocument']>['promise']>;
  type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
  let document: PdfDocument | null = null;
  const pages = new Map<number, PdfPage>();
  let failed = false;
  let disposed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let disposal: Promise<void> | null = null;

  const observe = (stage: QualificationRenderTiming['stage'], started: number, page: number | null) => {
    // Profiling is observational and cannot change crop or qualification behavior.
    try { options.observe?.({ stage, durationMs: performance.now() - started, physicalPageNumber: page }); } catch { /* observation only */ }
  };

  const render = async (spec: ValueReadingCropSpec): Promise<ValueReadingRegionImage | null> => {
    if (disposed || failed || source.byteLength === 0 || spec.sourceArtifactId !== sourceSha256
      || !Number.isInteger(spec.physicalPageNumber) || spec.physicalPageNumber < 1) return null;
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const { createCanvas } = await import('@napi-rs/canvas');
      if (!document) {
        const started = performance.now();
        const loading = pdfjs.getDocument({ data: new Uint8Array(source), isEvalSupported: false });
        try {
          document = await loading.promise;
        } catch (error) {
          failed = true;
          await loading.destroy().catch(() => undefined);
          throw error;
        } finally {
          observe('pdf_load', started, spec.physicalPageNumber);
        }
      }
      if (spec.physicalPageNumber > document.numPages) return null;
      let page = pages.get(spec.physicalPageNumber);
      if (!page) {
        const started = performance.now();
        page = await document.getPage(spec.physicalPageNumber);
        pages.set(spec.physicalPageNumber, page);
        observe('page_load', started, spec.physicalPageNumber);
      }
      const viewport = page.getViewport({ scale: spec.scale });
      const rect = valueReadingCropPixels(spec, {
        widthPx: Math.floor(viewport.width), heightPx: Math.floor(viewport.height),
      });
      if (!rect) return null;
      const crop = createCanvas(rect.width, rect.height);
      const started = performance.now();
      await page.render({
        canvas: crop as unknown as HTMLCanvasElement,
        canvasContext: crop.getContext('2d') as unknown as CanvasRenderingContext2D,
        viewport,
        transform: [1, 0, 0, 1, -rect.x, -rect.y],
      }).promise;
      observe('raster_render', started, spec.physicalPageNumber);
      const encodeStarted = performance.now();
      const bytes = new Uint8Array(crop.toBuffer('image/png'));
      observe('png_encode', encodeStarted, spec.physicalPageNumber);
      return { mediaType: 'image/png', bytes };
    } catch {
      return null;
    }
  };

  return {
    sourceSha256,
    render(spec) {
      // A retained PDF page must not be rendered concurrently on two canvases.
      const pending = tail.then(() => render(spec));
      tail = pending;
      return pending;
    },
    dispose() {
      disposed = true;
      disposal ??= tail.then(async () => {
        pages.clear();
        if (document) {
          const started = performance.now();
          try { await document.destroy(); } finally {
            document = null;
            observe('dispose', started, null);
          }
        }
      });
      return disposal;
    },
  };
}
