'use client';

import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import type { ForgewingLabelLinkageReviewPacket } from
  '@/lib/evaluation/forgewing/labelledPricingLinkageReview';

const PDF_WORKER_SRC = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();
const PDF_WASM_BASE_URL = '/vendor/pdfjs/wasm/';

type PacketLabel = ForgewingLabelLinkageReviewPacket['labels'][number];
type Observation = PacketLabel['modern_pdf_layout_token_observations'][number];

type PdfPage = {
  getViewport: (params: { scale: number }) => { width: number; height: number };
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
    canvas: HTMLCanvasElement;
  }) => { promise: Promise<void>; cancel: () => void };
};

export function A3LinkagePdfPage({
  sourceUrl,
  pageNumber,
  pageWidth,
  pageHeight,
  observations,
  selectedObservationIds,
  hoveredObservationId,
  onHoverObservation,
  onToggleObservation,
}: {
  sourceUrl: string;
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  observations: readonly Observation[];
  selectedObservationIds: readonly string[];
  hoveredObservationId: string | null;
  onHoverObservation: (id: string | null) => void;
  onToggleObservation: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel: () => void } | null = null;
    (async () => {
      try {
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        const response = await fetch(sourceUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error('Source PDF could not be loaded.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const document = await pdfjs.getDocument({ data: bytes, wasmUrl: PDF_WASM_BASE_URL }).promise;
        const page = await document.getPage(pageNumber) as unknown as PdfPage;
        const nextViewport = page.getViewport({ scale: 1.15 });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Source PDF canvas is unavailable.');
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(nextViewport.width * ratio);
        canvas.height = Math.ceil(nextViewport.height * ratio);
        canvas.style.width = `${nextViewport.width}px`;
        canvas.style.height = `${nextViewport.height}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        renderTask = page.render({ canvasContext: context, viewport: nextViewport, canvas });
        await renderTask.promise;
        if (!cancelled) setViewport(nextViewport);
      } catch (nextError) {
        if (!cancelled && (nextError as { name?: string })?.name !== 'RenderingCancelledException') {
          setError(nextError instanceof Error ? nextError.message : 'Source PDF could not be rendered.');
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pageNumber, sourceUrl]);

  if (error) {
    return <div className="p-6 text-sm text-[var(--ef-critical)]">{error}</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-black/25 p-5" data-testid="source-pdf-panel">
      <div
        className="relative mx-auto bg-white shadow-2xl"
        style={{ width: viewport?.width ?? pageWidth, height: viewport?.height ?? pageHeight }}
      >
        <canvas ref={canvasRef} className="block" aria-label={`TDOT source page ${pageNumber}`} />
        {viewport ? (
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${pageWidth} ${pageHeight}`}
            preserveAspectRatio="none"
            aria-label="Candidate source observation overlays"
          >
            {observations.map((observation) => {
              const selected = selectedObservationIds.includes(observation.observation_id);
              const hovered = hoveredObservationId === observation.observation_id;
              return (
                <rect
                  key={observation.observation_id}
                  data-testid={`bbox-${observation.observation_id}`}
                  data-selected={selected ? 'true' : 'false'}
                  x={observation.bbox.x_min}
                  y={observation.bbox.y_min}
                  width={observation.bbox.x_max - observation.bbox.x_min}
                  height={observation.bbox.y_max - observation.bbox.y_min}
                  fill="var(--ef-purple-primary)"
                  fillOpacity={selected ? 0.34 : hovered ? 0.22 : 0.1}
                  stroke="var(--ef-purple-glow)"
                  strokeOpacity={selected || hovered ? 1 : 0.55}
                  strokeWidth={selected ? 2.4 : hovered ? 2 : 1.2}
                  role="button"
                  tabIndex={0}
                  aria-label={`Toggle source observation ${observation.raw_text}`}
                  onMouseEnter={() => onHoverObservation(observation.observation_id)}
                  onMouseLeave={() => onHoverObservation(null)}
                  onClick={() => onToggleObservation(observation.observation_id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onToggleObservation(observation.observation_id);
                    }
                  }}
                  className="cursor-pointer outline-none focus:stroke-[var(--ef-text-primary)]"
                />
              );
            })}
          </svg>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-xs text-white">
            Rendering physical page {pageNumber}…
          </div>
        )}
      </div>
    </div>
  );
}
