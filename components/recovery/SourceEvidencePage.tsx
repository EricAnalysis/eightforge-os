'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { toViewportRect } from '@/lib/recovery/sourceGeometry';
import { visualSourceEvidenceIdentity,
  type VisualSourceEvidence, type VisualSourceBox } from '@/lib/recovery/visualSourceEvidence';

const PDF_WORKER_SRC = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();
const PDF_WASM_BASE_URL = '/vendor/pdfjs/wasm/';
type PdfViewport = { width: number; height: number; rotation?: number };
type PdfPage = {
  getViewport: (params: { scale: number }) => PdfViewport;
  render: (params: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport;
    canvas: HTMLCanvasElement }) => { promise: Promise<void>; cancel: () => void };
};
const ROLE_STYLE = {
  candidate_member: { label: 'Candidate fragment', stroke: 'var(--ef-purple-glow)', dash: undefined },
  target_row_context: { label: 'Selected target row', stroke: 'var(--ef-success)', dash: '8 3' },
  alternative_candidate: { label: 'Alternate target row', stroke: 'var(--ef-warning)', dash: '2 4' },
} as const;

export function SourceEvidencePage({ sourceUrl, evidence, unbound = false,
  selectedObservationIds = [], hoveredObservationId = null, onHoverObservation,
  onToggleObservation }: {
  sourceUrl: string; evidence: VisualSourceEvidence;
  /**
   * Server-derived. True when the persisted evidence no longer closes over the
   * source identity it claims. There is no browser-side freshness check here on
   * purpose: nothing the browser holds is authoritative about the current page
   * representation, and re-deriving one would mean re-extracting.
   */
  unbound?: boolean;
  selectedObservationIds?: readonly string[]; hoveredObservationId?: string | null;
  onHoverObservation?: (id: string | null) => void; onToggleObservation?: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pageGeometry, setPageGeometry] = useState<{ viewport: PdfViewport; scale: number;
    pageWidthPoints: number; pageHeightPoints: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeMember, setActiveMember] = useState(0);
  const evidenceIdentity = visualSourceEvidenceIdentity(evidence);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel: () => void } | null = null;
    setError(null); setPageGeometry(null);
    (async () => {
      try {
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        const response = await fetch(sourceUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error('Source PDF could not be loaded.');
        const document = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()),
          wasmUrl: PDF_WASM_BASE_URL }).promise;
        const page = await document.getPage(evidence.physicalPageNumber) as unknown as PdfPage;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = 1.15;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Source PDF canvas is unavailable.');
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        renderTask = page.render({ canvasContext: context, viewport, canvas });
        await renderTask.promise;
        if (!cancelled) setPageGeometry({ viewport, scale, pageWidthPoints: baseViewport.width,
          pageHeightPoints: baseViewport.height });
      } catch (nextError) {
        if (!cancelled && (nextError as { name?: string })?.name !== 'RenderingCancelledException') {
          setError(nextError instanceof Error ? nextError.message : 'Source PDF could not be rendered.');
        }
      }
    })();
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [evidence.physicalPageNumber, sourceUrl]);

  const rendered = useMemo(() => pageGeometry && !unbound ? evidence.boxes.map((box) => ({ box,
    rect: toViewportRect(box, { viewportWidth: pageGeometry.viewport.width,
      viewportHeight: pageGeometry.viewport.height, scale: pageGeometry.scale,
      rotation: pageGeometry.viewport.rotation, pageWidthPoints: pageGeometry.pageWidthPoints,
      pageHeightPoints: pageGeometry.pageHeightPoints }) })) : [],
  [evidence.boxes, pageGeometry, unbound]);
  const geometryUnavailable = rendered.some((entry) => entry.rect === null);
  useEffect(() => { setActiveMember(0); }, [evidenceIdentity]);
  useEffect(() => {
    const container = scrollRef.current;
    const page = pageRef.current;
    const active = rendered[activeMember]?.rect;
    if (!container || !page || !active) return;
    container.scrollTo({
      left: Math.max(0, page.offsetLeft + active.left + active.width / 2 - container.clientWidth / 2),
      top: Math.max(0, page.offsetTop + active.top + active.height / 2 - container.clientHeight / 2),
      behavior: 'smooth',
    });
  }, [activeMember, rendered]);
  if (error) return <div className="p-6 text-sm text-[var(--ef-critical)]">{error}</div>;

  return <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-black/25 p-5"
    data-testid="source-pdf-panel">
    <div className="mb-3 flex flex-wrap items-center gap-3 text-[10px] text-[var(--ef-text-muted)]">
      {(Object.keys(ROLE_STYLE) as Array<keyof typeof ROLE_STYLE>).map((role) => <span key={role}
        className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-5 border-2"
          style={{ borderColor: ROLE_STYLE[role].stroke, borderStyle: role === 'candidate_member'
            ? 'solid' : role === 'alternative_candidate' ? 'dotted' : 'dashed' }} />{ROLE_STYLE[role].label}</span>)}
      {evidence.boxes.length > 1 ? <span className="ml-auto inline-flex items-center gap-2">
        <button type="button" aria-label="Previous evidence member" onClick={() => setActiveMember((value) =>
          (value - 1 + evidence.boxes.length) % evidence.boxes.length)}>←</button>
        Member {activeMember + 1} of {evidence.boxes.length}
        <button type="button" aria-label="Next evidence member" onClick={() => setActiveMember((value) =>
          (value + 1) % evidence.boxes.length)}>→</button></span> : null}
    </div>
    {unbound ? <p className="mb-3 text-xs text-[var(--ef-critical)]" data-testid="source-evidence-unbound">
      Source evidence is unbound: the persisted evidence no longer closes over this source. No highlights are shown.</p>
      : geometryUnavailable ? <p className="mb-3 text-xs text-[var(--ef-warning)]" data-testid="source-geometry-unavailable">
        Exact geometry is unavailable for this source layer. No approximate highlight was drawn.</p> : null}
    <div ref={pageRef} className="relative mx-auto bg-white shadow-2xl" style={{ width: pageGeometry?.viewport.width ?? 612,
      height: pageGeometry?.viewport.height ?? 792 }}><canvas ref={canvasRef} className="block"
        aria-label={`Source page ${evidence.physicalPageNumber}`} />
      {pageGeometry ? <svg className="absolute inset-0 h-full w-full"
        viewBox={`0 0 ${pageGeometry.viewport.width} ${pageGeometry.viewport.height}`}
        aria-label="Candidate source observation overlays">{rendered.map(({ box, rect }, index) => rect
          ? <EvidenceRect key={`${box.role}:${box.observationId}`} box={box} rect={rect} active={index === activeMember}
              selected={selectedObservationIds.includes(box.observationId)} hovered={hoveredObservationId === box.observationId}
              onHover={onHoverObservation} onToggle={onToggleObservation} /> : null)}</svg>
        : <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-xs text-white">
          Rendering physical page {evidence.physicalPageNumber}…</div>}</div>
  </div>;
}

function EvidenceRect({ box, rect, active, selected, hovered, onHover, onToggle }: {
  box: VisualSourceBox; rect: { left: number; top: number; width: number; height: number };
  active: boolean; selected: boolean; hovered: boolean; onHover?: (id: string | null) => void;
  onToggle?: (id: string) => void;
}) {
  const style = ROLE_STYLE[box.role];
  return <rect data-testid={`bbox-${box.observationId}`} data-role={box.role} data-member-index={box.memberIndex}
    data-selected={selected ? 'true' : 'false'} x={rect.left} y={rect.top} width={rect.width} height={rect.height}
    fill={style.stroke} fillOpacity={selected ? 0.34 : hovered || active ? 0.22 : 0.1} stroke={style.stroke}
    strokeDasharray={style.dash} strokeOpacity={selected || hovered || active ? 1 : 0.7}
    strokeWidth={selected ? 2.4 : hovered || active ? 2 : 1.2} role={onToggle ? 'button' : 'img'}
    tabIndex={onToggle ? 0 : undefined} aria-label={`${style.label}: ${box.rawText}`}
    onMouseEnter={() => onHover?.(box.observationId)} onMouseLeave={() => onHover?.(null)}
    onClick={() => onToggle?.(box.observationId)} onKeyDown={(event) => {
      if (onToggle && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onToggle(box.observationId); }
    }} className={onToggle ? 'cursor-pointer outline-none focus:stroke-[var(--ef-text-primary)]' : undefined} />;
}
