'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type {
  DocumentAnchorCaptureMode,
  DocumentFactAnchorRecord,
} from '@/lib/documentFactAnchors';
import type {
  DocumentEvidenceAnchor,
  DocumentFact,
} from '@/lib/documentIntelligenceViewModel';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF_WORKER_SRC = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

type PdfViewportLike = {
  width: number;
  height: number;
  scale: number;
  rotation: number;
  rawDims?: {
    pageWidth: number;
    pageHeight: number;
    pageX: number;
    pageY: number;
  };
};

type PdfRenderTaskLike = {
  promise: Promise<void>;
  cancel: () => void;
};

const canvasRenderTasks = new WeakMap<HTMLCanvasElement, PdfRenderTaskLike>();

type PdfPageLike = {
  getViewport: (params: { scale: number }) => PdfViewportLike;
  getTextContent: () => Promise<unknown>;
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
    canvas?: HTMLCanvasElement;
  }) => PdfRenderTaskLike;
};

type PdfDocumentLike = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
};

type CaptureRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeRect(rect: CaptureRect): CaptureRect {
  const x = rect.width >= 0 ? rect.x : rect.x + rect.width;
  const y = rect.height >= 0 ? rect.y : rect.y + rect.height;
  return {
    x,
    y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

function summarizeQuote(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 180) return trimmed;
  return `${trimmed.slice(0, 177)}...`;
}

function pageRangeLabel(startPage: number | null, endPage: number | null): string {
  if (startPage == null) return 'No pages selected';
  if (endPage != null && endPage !== startPage) return `pages ${startPage}-${endPage}`;
  return `page ${startPage}`;
}

function anchorPageLabel(anchor: DocumentEvidenceAnchor): string {
  return pageRangeLabel(anchor.startPage ?? anchor.pageNumber, anchor.endPage ?? anchor.pageNumber);
}

async function renderPdfPageToCanvas(params: {
  page: PdfPageLike;
  scale: number;
  canvas: HTMLCanvasElement;
}): Promise<{ width: number; height: number; viewport: PdfViewportLike } | null> {
  const viewport = params.page.getViewport({ scale: params.scale });
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
  const task = params.page.render({
    canvasContext: context,
    viewport,
    canvas: params.canvas,
  });
  canvasRenderTasks.set(params.canvas, task);

  try {
    await task.promise;
    return { width: viewport.width, height: viewport.height, viewport };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'RenderingCancelledException'
    ) {
      return null;
    }
    throw error;
  } finally {
    if (canvasRenderTasks.get(params.canvas) === task) {
      canvasRenderTasks.delete(params.canvas);
    }
  }
}

async function renderPdfPage(params: {
  pdf: PdfDocumentLike;
  pageNumber: number;
  scale: number;
  canvas: HTMLCanvasElement;
}): Promise<{ width: number; height: number } | null> {
  const page = await params.pdf.getPage(params.pageNumber);
  const rendered = await renderPdfPageToCanvas({
    page,
    scale: params.scale,
    canvas: params.canvas,
  });
  return rendered ? { width: rendered.width, height: rendered.height } : null;
}

async function renderTextLayer(params: {
  page: PdfPageLike;
  scale: number;
  container: HTMLDivElement;
}): Promise<{ width: number; height: number } | null> {
  const viewport = params.page.getViewport({ scale: params.scale });
  params.container.replaceChildren();
  params.container.style.width = `${viewport.width}px`;
  params.container.style.height = `${viewport.height}px`;

  const TextLayerCtor = (
    pdfjs as unknown as {
      TextLayer?: new (params: {
        textContentSource: unknown;
        container: HTMLDivElement;
        viewport: PdfViewportLike;
      }) => { render: () => Promise<void> };
    }
  ).TextLayer;

  if (!TextLayerCtor) {
    return { width: viewport.width, height: viewport.height };
  }

  const textContent = await params.page.getTextContent();
  const textLayer = new TextLayerCtor({
    textContentSource: textContent,
    container: params.container,
    viewport,
  });
  await textLayer.render();
  return { width: viewport.width, height: viewport.height };
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
      if (!cancelled && rendered == null && canvasRef.current) {
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
        active
          ? 'border-[#3B82F6]/40 bg-[#3B82F6]/10'
          : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.05]'
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
  fact,
  anchors,
  activeAnchor,
  pageMarkerCounts,
  focusToken,
  captureMode,
  rateScheduleAnchor,
  rateSchedulePages,
  onCancelCapture,
  onCreateAnchor,
  onCreateRateScheduleAnchor,
}: {
  signedUrl: string | null;
  fileExt: string;
  filename: string;
  fact: DocumentFact | null;
  anchors: DocumentEvidenceAnchor[];
  activeAnchor: DocumentEvidenceAnchor | null;
  pageMarkerCounts: Record<number, number>;
  focusToken: number;
  captureMode: DocumentAnchorCaptureMode | null;
  rateScheduleAnchor: DocumentEvidenceAnchor | null;
  rateSchedulePages: string | null;
  onCancelCapture: () => void;
  onCreateAnchor: (input: {
    fieldKey: string;
    overrideId?: string | null;
    anchorType: 'text' | 'region';
    pageNumber: number;
    snippet?: string | null;
    quoteText?: string | null;
    rectJson?: Record<string, unknown> | null;
    anchorJson?: Record<string, unknown> | null;
  }) => Promise<
    | { ok: true; anchor: DocumentFactAnchorRecord }
    | { ok: false; error: string }
  >;
  onCreateRateScheduleAnchor: (input: {
    startPage: number;
    endPage: number;
    rectJson?: Record<string, unknown> | null;
  }) => Promise<
    | { ok: true; anchor: DocumentFactAnchorRecord }
    | { ok: false; error: string }
  >;
}) {
  const [pdf, setPdf] = useState<PdfDocumentLike | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(1.2);
  const [showOverlays, setShowOverlays] = useState(true);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [savingAnchor, setSavingAnchor] = useState(false);
  const [regionDraft, setRegionDraft] = useState<CaptureRect | null>(null);
  const [rateScheduleDraft, setRateScheduleDraft] = useState<{
    startPage: number | null;
    endPage: number | null;
  }>({
    startPage: null,
    endPage: null,
  });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerScrollRef = useRef<HTMLDivElement | null>(null);
  const pageSurfaceRef = useRef<HTMLDivElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const renderRequestRef = useRef(0);
  const regionPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const rawActiveOverrideId = fact?.overrideHistory.find((item) => item.isActive)?.id ?? null;
  const activeOverrideId =
    typeof rawActiveOverrideId === 'string' &&
    rawActiveOverrideId.trim().length > 0 &&
    rawActiveOverrideId.trim().toLowerCase() !== 'null' &&
    rawActiveOverrideId.trim().toLowerCase() !== 'undefined'
      ? rawActiveOverrideId.trim()
      : null;

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
    const fallback = anchors[0]?.startPage ?? anchors[0]?.pageNumber ?? 1;
    const raw = activeAnchor?.startPage ?? activeAnchor?.pageNumber ?? fallback;
    const targetPage = Math.min(Math.max(1, raw), pdf.numPages);
    setCurrentPage(targetPage);
  }, [pdf, activeAnchor?.pageNumber, activeAnchor?.startPage, activeAnchor?.id, anchors, focusToken]);

  useEffect(() => {
    viewerScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [activeAnchor?.id, currentPage, focusToken]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && captureMode) {
        onCancelCapture();
        setCaptureError(null);
        setRegionDraft(null);
        setRateScheduleDraft({ startPage: null, endPage: null });
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [captureMode, onCancelCapture]);

  useEffect(() => {
    if (captureMode !== 'rate_schedule') {
      setRateScheduleDraft({ startPage: null, endPage: null });
      return;
    }

    setRateScheduleDraft((current) => {
      if (current.startPage != null || current.endPage != null) {
        return current;
      }
      return {
        startPage: rateScheduleAnchor?.startPage ?? rateScheduleAnchor?.pageNumber ?? currentPage,
        endPage: rateScheduleAnchor?.endPage ?? rateScheduleAnchor?.pageNumber ?? currentPage,
      };
    });
    setCaptureError(null);
    setRegionDraft(null);
  }, [
    captureMode,
    currentPage,
    rateScheduleAnchor?.endPage,
    rateScheduleAnchor?.pageNumber,
    rateScheduleAnchor?.startPage,
  ]);

  useEffect(() => {
    const nextRequest = renderRequestRef.current + 1;
    renderRequestRef.current = nextRequest;

    (async () => {
      if (!pdf || !canvasRef.current || !textLayerRef.current) return;
      try {
        const page = await pdf.getPage(currentPage);
        const rendered = await renderPdfPageToCanvas({
          page,
          scale: zoom,
          canvas: canvasRef.current,
        });
        if (!rendered || renderRequestRef.current !== nextRequest) return;
        const textRendered = await renderTextLayer({
          page,
          scale: zoom,
          container: textLayerRef.current,
        });
        if (!textRendered || renderRequestRef.current !== nextRequest) return;
        setPageSize({ width: rendered.width, height: rendered.height });
        setCaptureError(null);
      } catch (nextError) {
        if (renderRequestRef.current === nextRequest) {
          setError(nextError instanceof Error ? nextError.message : 'Unable to render PDF page.');
        }
      }
    })();
  }, [pdf, currentPage, zoom]);

  const currentPageAnchors = useMemo(
    () =>
      anchors.filter((anchor) => {
        const startPage = anchor.startPage ?? anchor.pageNumber;
        const endPage = anchor.endPage ?? anchor.pageNumber;
        return (
          startPage != null &&
          endPage != null &&
          currentPage >= startPage &&
          currentPage <= endPage
        );
      }),
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

  const saveAnchor = async (input: {
    anchorType: 'text' | 'region';
    pageNumber: number;
    snippet?: string | null;
    quoteText?: string | null;
    rectJson?: Record<string, unknown> | null;
    anchorJson?: Record<string, unknown> | null;
  }) => {
    if (!fact) {
      setCaptureError('Select a fact before attaching evidence.');
      return;
    }

    setSavingAnchor(true);
    setCaptureError(null);
    const result = await onCreateAnchor({
      fieldKey: fact.fieldKey,
      overrideId: activeOverrideId,
      anchorType: input.anchorType,
      pageNumber: input.pageNumber,
      snippet: input.snippet ?? null,
      quoteText: input.quoteText ?? null,
      rectJson: input.rectJson ?? null,
      anchorJson: input.anchorJson ?? null,
    });
    setSavingAnchor(false);

    if (!result.ok) {
      setCaptureError(result.error);
      return;
    }

    setCaptureError(null);
    setRegionDraft(null);
  };

  const saveRateScheduleAnchor = async (input: {
    startPage: number;
    endPage: number;
    rectJson?: Record<string, unknown> | null;
  }) => {
    setSavingAnchor(true);
    setCaptureError(null);
    const result = await onCreateRateScheduleAnchor({
      startPage: Math.min(input.startPage, input.endPage),
      endPage: Math.max(input.startPage, input.endPage),
      rectJson: input.rectJson ?? null,
    });
    setSavingAnchor(false);

    if (!result.ok) {
      setCaptureError(result.error);
      return;
    }

    setCaptureError(null);
    setRegionDraft(null);
  };

  const saveRateSchedulePageRange = async () => {
    if (captureMode !== 'rate_schedule') return;
    if (rateScheduleDraft.startPage == null || rateScheduleDraft.endPage == null) {
      setCaptureError('Set both the start page and end page before saving the rate schedule.');
      return;
    }
    await saveRateScheduleAnchor({
      startPage: rateScheduleDraft.startPage,
      endPage: rateScheduleDraft.endPage,
    });
  };

  const handleTextSelectionCapture = async () => {
    if (captureMode !== 'text' || !textLayerRef.current || !pageSurfaceRef.current || !pageSize) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const commonContainer =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : (range.commonAncestorContainer as HTMLElement | null);

    if (!commonContainer || !textLayerRef.current.contains(commonContainer)) return;

    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    if (rects.length === 0) return;

    const surfaceRect = pageSurfaceRef.current.getBoundingClientRect();
    const relativeRects = rects
      .map((rect) => ({
        x: clamp(rect.left - surfaceRect.left, 0, surfaceRect.width),
        y: clamp(rect.top - surfaceRect.top, 0, surfaceRect.height),
        width: Math.min(rect.width, surfaceRect.width),
        height: Math.min(rect.height, surfaceRect.height),
      }))
      .filter((rect) => rect.width > 0 && rect.height > 0);

    if (relativeRects.length === 0) return;

    const left = Math.min(...relativeRects.map((rect) => rect.x));
    const top = Math.min(...relativeRects.map((rect) => rect.y));
    const right = Math.max(...relativeRects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...relativeRects.map((rect) => rect.y + rect.height));
    const quoteText = selection.toString().trim();
    if (!quoteText) return;

    await saveAnchor({
      anchorType: 'text',
      pageNumber: currentPage,
      snippet: summarizeQuote(quoteText),
      quoteText,
      rectJson: {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        layoutWidth: pageSize.width,
        layoutHeight: pageSize.height,
      },
      anchorJson: {
        rects: relativeRects,
        source: 'text_selection',
      },
    });

    selection.removeAllRanges();
  };

  const handleRegionPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((captureMode !== 'region' && captureMode !== 'rate_schedule') || !pageSurfaceRef.current || !pageSize) {
      return;
    }
    const bounds = pageSurfaceRef.current.getBoundingClientRect();
    const startX = clamp(event.clientX - bounds.left, 0, pageSize.width);
    const startY = clamp(event.clientY - bounds.top, 0, pageSize.height);
    regionPointerStartRef.current = { x: startX, y: startY };
    setRegionDraft({ x: startX, y: startY, width: 0, height: 0 });
    setCaptureError(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleRegionPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      (captureMode !== 'region' && captureMode !== 'rate_schedule') ||
      !regionPointerStartRef.current ||
      !pageSurfaceRef.current ||
      !pageSize
    ) {
      return;
    }
    const bounds = pageSurfaceRef.current.getBoundingClientRect();
    const nextX = clamp(event.clientX - bounds.left, 0, pageSize.width);
    const nextY = clamp(event.clientY - bounds.top, 0, pageSize.height);
    setRegionDraft({
      x: regionPointerStartRef.current.x,
      y: regionPointerStartRef.current.y,
      width: nextX - regionPointerStartRef.current.x,
      height: nextY - regionPointerStartRef.current.y,
    });
  };

  const handleRegionPointerUp = async (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((captureMode !== 'region' && captureMode !== 'rate_schedule') || !regionPointerStartRef.current || !pageSize) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    const normalized = normalizeRect(regionDraft ?? {
      x: regionPointerStartRef.current.x,
      y: regionPointerStartRef.current.y,
      width: 0,
      height: 0,
    });
    regionPointerStartRef.current = null;

    if (normalized.width < 8 || normalized.height < 8) {
      setRegionDraft(null);
      setCaptureError('Draw a larger region to create an anchor.');
      return;
    }

    if (captureMode === 'rate_schedule') {
      if (rateScheduleDraft.startPage == null || rateScheduleDraft.endPage == null) {
        setRegionDraft(null);
        setCaptureError('Set both the start page and end page before drawing a rate schedule region.');
        return;
      }
      const rangeStart = Math.min(rateScheduleDraft.startPage, rateScheduleDraft.endPage);
      const rangeEnd = Math.max(rateScheduleDraft.startPage, rateScheduleDraft.endPage);
      if (currentPage < rangeStart || currentPage > rangeEnd) {
        setRegionDraft(null);
        setCaptureError('Draw the table region on a page that falls within the selected schedule range.');
        return;
      }
      await saveRateScheduleAnchor({
        startPage: rangeStart,
        endPage: rangeEnd,
        rectJson: {
          ...normalized,
          layoutWidth: pageSize.width,
          layoutHeight: pageSize.height,
          pageNumber: currentPage,
        },
      });
      return;
    }

    await saveAnchor({
      anchorType: 'region',
      pageNumber: currentPage,
      snippet: `Region anchor on page ${currentPage}`,
      rectJson: {
        ...normalized,
        layoutWidth: pageSize.width,
        layoutHeight: pageSize.height,
      },
      anchorJson: {
        source: 'region_drag',
      },
    });
  };

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
      <style jsx global>{`
        .ef-pdf-text-layer {
          position: absolute;
          inset: 0;
          overflow: hidden;
          line-height: 1;
        }

        .ef-pdf-text-layer span,
        .ef-pdf-text-layer br {
          position: absolute;
          transform-origin: 0 0;
          white-space: pre;
          color: transparent;
          cursor: text;
        }

        .ef-pdf-text-layer::selection,
        .ef-pdf-text-layer span::selection {
          background: rgba(59, 130, 246, 0.32);
          color: transparent;
        }
      `}</style>

      <div className="border-b border-white/8 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
              Source Viewer
            </p>
            <p className="mt-1 text-[12px] text-[#8FA1BC]">
              Page navigation, zoom, and anchor overlays for the selected fact. Thumbnail badges count all current fact anchors on each page.
            </p>
            {rateSchedulePages ? (
              <p className="mt-2 text-[11px] text-[#8FA1BC]">
                Effective rate schedule: {rateSchedulePages}
              </p>
            ) : null}
            {captureMode ? (
              <p className="mt-2 text-[11px] text-amber-100">
                {captureMode === 'text'
                  ? 'Capture mode: select text in the PDF to create a text anchor.'
                  : captureMode === 'region'
                    ? 'Capture mode: drag on the PDF to create a region anchor.'
                    : 'Capture mode: mark the schedule start/end pages, then save the range or drag a table region.'}
              </p>
            ) : null}
            {captureMode === 'rate_schedule' ? (
              <p className="mt-2 text-[11px] text-[#CFE4FF]">
                Draft schedule: {pageRangeLabel(rateScheduleDraft.startPage, rateScheduleDraft.endPage)}
              </p>
            ) : null}
            {captureError ? (
              <p className="mt-2 text-[11px] text-red-200">{captureError}</p>
            ) : null}
            {savingAnchor ? (
              <p className="mt-2 text-[11px] text-[#CFE4FF]">Saving anchor...</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {captureMode ? (
              <button
                type="button"
                onClick={() => {
                  onCancelCapture();
                  setCaptureError(null);
                  setRegionDraft(null);
                  setRateScheduleDraft({ startPage: null, endPage: null });
                }}
                className="rounded border border-amber-400/30 px-2 py-1 text-amber-100"
              >
                Cancel capture
              </button>
            ) : null}
            {captureMode === 'rate_schedule' ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setRateScheduleDraft((current) => ({ ...current, startPage: currentPage }))
                  }
                  className="rounded border border-[#3B82F6]/20 px-2 py-1 text-[#CFE4FF]"
                >
                  Set start
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setRateScheduleDraft((current) => ({ ...current, endPage: currentPage }))
                  }
                  className="rounded border border-[#3B82F6]/20 px-2 py-1 text-[#CFE4FF]"
                >
                  Set end
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void saveRateSchedulePageRange();
                  }}
                  className="rounded border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-2 py-1 text-[#CFE4FF]"
                >
                  Save schedule
                </button>
              </>
            ) : null}
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
              <span>
                Page {currentPage} of {pdf.numPages}
              </span>
              <span>
                {currentPageAnchors.length} anchor{currentPageAnchors.length === 1 ? '' : 's'} for this fact on this page
                {missingGeometryCount > 0
                  ? ` | ${missingGeometryCount} without region geometry (page focus)`
                  : ''}
              </span>
            </div>

            <div
              ref={pageSurfaceRef}
              className="relative inline-block rounded-xl border border-white/10 bg-white shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
            >
              <canvas ref={canvasRef} className="block rounded-xl" />
              <div
                ref={textLayerRef}
                className={`ef-pdf-text-layer ${
                  captureMode === 'text'
                    ? 'pointer-events-auto select-text'
                    : 'pointer-events-none select-none'
                }`}
                onMouseUp={() => {
                  void handleTextSelectionCapture();
                }}
              />
              {(captureMode === 'region' || captureMode === 'rate_schedule') && pageSize ? (
                <div
                  className="absolute inset-0 cursor-crosshair"
                  onPointerDown={handleRegionPointerDown}
                  onPointerMove={handleRegionPointerMove}
                  onPointerUp={(event) => {
                    void handleRegionPointerUp(event);
                  }}
                  onPointerCancel={() => {
                    regionPointerStartRef.current = null;
                    setRegionDraft(null);
                  }}
                />
              ) : null}
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
                  {regionDraft && (captureMode === 'region' || captureMode === 'rate_schedule') ? (
                    <rect
                      x={normalizeRect(regionDraft).x}
                      y={normalizeRect(regionDraft).y}
                      width={normalizeRect(regionDraft).width}
                      height={normalizeRect(regionDraft).height}
                      fill="rgba(59,130,246,0.12)"
                      stroke="#60A5FA"
                      strokeDasharray="6 4"
                      strokeWidth={1.5}
                    />
                  ) : null}
                </svg>
              ) : null}
            </div>

            {activeAnchor ? (
              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[#F5F7FA]">
                    {activeAnchor.pageNumber || activeAnchor.startPage
                      ? `Active anchor on ${anchorPageLabel(activeAnchor)}`
                      : 'Active anchor'}
                  </p>
                  <span className="text-[11px] text-[#7FA6FF]">{activeAnchor.matchType}</span>
                </div>
                {activeAnchor.snippet ? (
                  <p className="mt-2 text-[12px] leading-relaxed text-[#D9E3F3]">
                    {activeAnchor.snippet}
                  </p>
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
