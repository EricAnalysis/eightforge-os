'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentEvidenceAnchor } from '@/lib/documentIntelligenceViewModel';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// Turbopack-safe worker URL (no `?url` default export, no CDN).
// Uses the installed pdfjs-dist worker module directly.
const PDF_WORKER_SRC = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();

const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

type PdfRenderTaskLike = {
  promise: Promise<void>;
  cancel: () => void;
};

const canvasRenderTasks = new WeakMap<HTMLCanvasElement, PdfRenderTaskLike>();

type PdfDocumentLike = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<{
    getViewport: (params: { scale: number }) => { width: number; height: number };
    render: (params: {
      canvasContext: CanvasRenderingContext2D;
      viewport: { width: number; height: number };
      canvas?: HTMLCanvasElement;
    }) => PdfRenderTaskLike;
  }>;
};

async function renderPdfPage(params: {
  pdf: PdfDocumentLike;
  pageNumber: number;
  scale: number;
  canvas: HTMLCanvasElement;
}): Promise<{ width: number; height: number } | null> {
  const page = await params.pdf.getPage(params.pageNumber);
  const viewport = page.getViewport({ scale: params.scale });
  const context = params.canvas.getContext('2d');
  if (!context) return null;

  const previousTask = canvasRenderTasks.get(params.canvas);
  if (previousTask) {
    try {
      previousTask.cancel();
    } catch {
      // ignore
    }
  }

  const ratio = window.devicePixelRatio || 1;
  params.canvas.width = Math.ceil(viewport.width * ratio);
  params.canvas.height = Math.ceil(viewport.height * ratio);
  params.canvas.style.width = `${viewport.width}px`;
  params.canvas.style.height = `${viewport.height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const task = page.render({ canvasContext: context, viewport, canvas: params.canvas });
  canvasRenderTasks.set(params.canvas, task);

  try {
    await task.promise;
    return { width: viewport.width, height: viewport.height };
  } catch (error) {
    // pdf.js throws RenderingCancelledException when we cancel an in-flight render.
    if (error && typeof error === 'object' && 'name' in error && error.name === 'RenderingCancelledException') {
      return null;
    }
    throw error;
  } finally {
    if (canvasRenderTasks.get(params.canvas) === task) {
      canvasRenderTasks.delete(params.canvas);
    }
  }
}

function Thumbnail({
  pdf,
  pageNumber,
  active,
  markerCount,
  onSelect,
}: {
  pdf: PdfDocumentLike;
  pageNumber: number;
  active: boolean;
  markerCount: number;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!canvasRef.current) return;
      const rendered = await renderPdfPage({
        pdf,
        pageNumber,
        scale: 0.22,
        canvas: canvasRef.current,
      });
      if (!cancelled && rendered == null) {
        canvasRef.current.style.display = 'none';
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber]);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-xl border p-2 text-left transition ${
        active ? 'border-[#3B82F6]/40 bg-[#3B82F6]/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.05]'
      }`}
    >
      <canvas ref={canvasRef} className="mx-auto block rounded bg-white shadow-sm" />
      <div className="mt-2 flex items-center justify-between text-[11px]">
        <span className="font-medium text-[#E5EDF7]">Page {pageNumber}</span>
        {markerCount > 0 ? (
          <span className="rounded border border-[#7FA6FF]/25 px-1.5 py-0.5 text-[#7FA6FF]">
            {markerCount}
          </span>
        ) : null}
      </div>
    </button>
  );
}

function overlayStroke(active: boolean): string {
  return active ? '#60A5FA' : '#F59E0B';
}

export function DocumentSourceViewer({
  signedUrl,
  fileExt,
  filename,
  anchors,
  activeAnchor,
  pageMarkerCounts,
  focusToken,
}: {
  signedUrl: string | null;
  fileExt: string;
  filename: string;
  anchors: DocumentEvidenceAnchor[];
  activeAnchor: DocumentEvidenceAnchor | null;
  pageMarkerCounts: Record<number, number>;
  focusToken: number;
}) {
  const [pdf, setPdf] = useState<PdfDocumentLike | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(1.2);
  const [showOverlays, setShowOverlays] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerScrollRef = useRef<HTMLDivElement | null>(null);
  const renderRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    if (fileExt !== 'pdf' || !signedUrl) {
      setPdf(null);
      setLoading(false);
      setPageSize(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setPageSize(null);

    (async () => {
      try {
        // pdf.js requires an explicit workerSrc in Next.js client bundles.
        // Use the locally bundled worker URL (no CDN, avoids dynamic-import fake worker failures).
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        const response = await fetch(signedUrl);
        if (!response.ok) throw new Error('Unable to load PDF for viewing.');
        const bytes = await response.arrayBuffer();
        const document = await pdfjs.getDocument({
          data: new Uint8Array(bytes),
        }).promise;
        if (cancelled) return;
        setPdf(document as unknown as PdfDocumentLike);
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Unable to render PDF.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileExt, signedUrl]);

  useEffect(() => {
    if (!pdf) return;
    const fallback = anchors[0]?.pageNumber ?? 1;
    const raw = activeAnchor?.pageNumber ?? fallback;
    const targetPage = Math.min(Math.max(1, raw), pdf.numPages);
    setCurrentPage(targetPage);
  }, [pdf, activeAnchor?.pageNumber, activeAnchor?.id, anchors, focusToken]);

  useEffect(() => {
    viewerScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [activeAnchor?.id, currentPage, focusToken]);

  useEffect(() => {
    const nextRequest = renderRequestRef.current + 1;
    renderRequestRef.current = nextRequest;
    (async () => {
      if (!pdf || !canvasRef.current) return;
      const rendered = await renderPdfPage({
        pdf,
        pageNumber: currentPage,
        scale: zoom,
        canvas: canvasRef.current,
      });
      if (renderRequestRef.current === nextRequest) setPageSize(rendered);
    })();
  }, [pdf, currentPage, zoom]);

  const currentPageAnchors = useMemo(
    () => anchors.filter((anchor) => anchor.pageNumber === currentPage),
    [anchors, currentPage],
  );

  const overlayAnchors = useMemo(() => {
    const seen = new Set<string>();
    return currentPageAnchors.filter((anchor) => {
      if (anchor.geometry == null) return false;
      if (seen.has(anchor.id)) return false;
      seen.add(anchor.id);
      return true;
    });
  }, [currentPageAnchors]);

  const missingGeometryCount = useMemo(
    () => currentPageAnchors.filter((anchor) => anchor.geometry == null).length,
    [currentPageAnchors],
  );

  if (!signedUrl) {
    return (
      <div className="flex min-h-[720px] items-center justify-center rounded-2xl border border-white/10 bg-[#0B1220] p-8 text-center text-sm text-[#8FA1BC]">
        File preview is unavailable for this document.
      </div>
    );
  }

  if (IMAGE_TYPES.has(fileExt)) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0B1220]">
        <div className="border-b border-white/8 px-5 py-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
            Source Viewer
          </p>
          <p className="mt-1 text-[12px] text-[#8FA1BC]">Image preview for {filename}.</p>
        </div>
        <div className="p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={signedUrl} alt={filename} className="max-h-[760px] w-full rounded-xl object-contain" />
        </div>
      </div>
    );
  }

  if (fileExt !== 'pdf') {
    return (
      <div className="flex min-h-[720px] items-center justify-center rounded-2xl border border-white/10 bg-[#0B1220] p-8 text-center text-sm text-[#8FA1BC]">
        Inline preview is not available for this file type. Use the file actions in the header to open or download it.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0B1220]">
      <div className="border-b border-white/8 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
              Source Viewer
            </p>
            <p className="mt-1 text-[12px] text-[#8FA1BC]">
              Page navigation, zoom, and anchor overlays for the selected fact. Thumbnail badges count evidence anchors across all extracted facts (per page).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => setZoom((value) => Math.max(0.6, Number((value - 0.15).toFixed(2))))}
              className="rounded border border-white/10 px-2 py-1 text-[#D9E3F3]"
            >
              -
            </button>
            <span className="min-w-14 text-center text-[#D9E3F3]">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => setZoom((value) => Math.min(2.4, Number((value + 0.15).toFixed(2))))}
              className="rounded border border-white/10 px-2 py-1 text-[#D9E3F3]"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setShowOverlays((value) => !value)}
              aria-label={showOverlays ? 'Evidence overlays visible' : 'Evidence overlays hidden'}
              className="rounded border border-white/10 px-2 py-1 text-[#D9E3F3]"
            >
              {showOverlays ? 'Hide overlays' : 'Show overlays'}
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-[640px] items-center justify-center text-sm text-[#8FA1BC]">Loading PDF...</div>
      ) : error ? (
        <div className="flex min-h-[640px] items-center justify-center px-8 text-center text-sm text-red-300">
          {error}
        </div>
      ) : pdf ? (
        <div className="grid gap-0 xl:grid-cols-[220px_minmax(0,1fr)]">
          <div className="max-h-[840px] overflow-y-auto border-r border-white/8 p-3">
            <div className="space-y-3">
              {Array.from({ length: pdf.numPages }, (_, index) => index + 1).map((pageNumber) => (
                <Thumbnail
                  key={pageNumber}
                  pdf={pdf}
                  pageNumber={pageNumber}
                  active={pageNumber === currentPage}
                  markerCount={pageMarkerCounts[pageNumber] ?? 0}
                  onSelect={() => setCurrentPage(pageNumber)}
                />
              ))}
            </div>
          </div>

          <div ref={viewerScrollRef} className="min-h-[840px] overflow-auto bg-[#050A14] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8FA1BC]">
              <span>Page {currentPage} of {pdf.numPages}</span>
              <span>
                {currentPageAnchors.length} anchor{currentPageAnchors.length === 1 ? '' : 's'} for this fact on this page
                {missingGeometryCount > 0 ? ` | ${missingGeometryCount} without region geometry (page focus)` : ''}
              </span>
            </div>

            <div className="relative inline-block rounded-xl border border-white/10 bg-white shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
              <canvas ref={canvasRef} className="block rounded-xl" />
              {showOverlays && pageSize ? (
                <svg
                  key={`${currentPage}-${focusToken}-${activeAnchor?.id ?? 'none'}-${showOverlays ? 'on' : 'off'}`}
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
                  preserveAspectRatio="none"
                >
                  {overlayAnchors.map((anchor) => {
                    const geometry = anchor.geometry;
                    if (!geometry) return null;
                    const scaleX = pageSize.width / (geometry.layoutWidth ?? pageSize.width);
                    const scaleY = pageSize.height / (geometry.layoutHeight ?? pageSize.height);
                    const points = geometry.polygon
                      .map((point) => `${point[0] * scaleX},${point[1] * scaleY}`)
                      .join(' ');
                    const active = activeAnchor?.id === anchor.id;
                    return (
                      <polygon
                        key={anchor.id}
                        points={points}
                        fill={active ? 'rgba(59,130,246,0.22)' : 'rgba(245,158,11,0.16)'}
                        stroke={overlayStroke(active)}
                        strokeWidth={active ? 2.5 : 1.5}
                      />
                    );
                  })}
                </svg>
              ) : null}
            </div>

            {activeAnchor ? (
              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[#F5F7FA]">
                    {activeAnchor.pageNumber ? `Active anchor on page ${activeAnchor.pageNumber}` : 'Active anchor'}
                  </p>
                  <span className="text-[11px] text-[#7FA6FF]">{activeAnchor.matchType}</span>
                </div>
                {activeAnchor.snippet ? (
                  <p className="mt-2 text-[12px] leading-relaxed text-[#D9E3F3]">{activeAnchor.snippet}</p>
                ) : null}
                {!activeAnchor.geometry ? (
                  <p className="mt-2 text-[11px] text-[#8FA1BC]">
                    This anchor does not include region geometry yet, so the viewer is focused to the source page instead.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
