import { resolveCanonicalObservationBoxes } from '@/lib/extraction/pdf/layoutObservationEvidence';
import type { DiagnosticVisualSourceEvidence, VisualSourceBox } from '@/lib/recovery/visualSourceEvidence';

/**
 * Builds the page evidence a diagnostic or review case shows on the source
 * page, from the persisted extraction. Shared by the document diagnostics read
 * and the resolution queue so both draw the same boxes for the same refs.
 * Pure: it reads only what it is given.
 */

/** A source ref as reconstruction persists it on lines, spines and cells. */
export type DiagnosticSourceRef = Readonly<{ observation_id?: string; text: string;
  x_min: number; x_max: number; y_min: number; y_max: number;
  source?: 'pdfjs' | 'ocr_fallback' }>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const row = record(entry); return row ? [row] : [];
  });
}

/** Reads persisted source refs exactly as the diagnostics read always has. */
export function parseDiagnosticSourceRefs(value: unknown): DiagnosticSourceRef[] {
  return records(value).map((ref) => ({
    observation_id: typeof ref.observation_id === 'string' ? ref.observation_id : undefined,
    text: String(ref.text ?? ''), x_min: Number(ref.x_min), x_max: Number(ref.x_max),
    y_min: Number(ref.y_min), y_max: Number(ref.y_max),
    source: ref.source === 'ocr_fallback' ? 'ocr_fallback' as const : 'pdfjs' as const,
  }));
}

export function diagnosticSourceBoxes(
  refs: readonly DiagnosticSourceRef[],
  page: number,
  canonicalSidecar?: unknown,
): VisualSourceBox[] {
  const drawn = refs.flatMap((ref, memberIndex) => ref.observation_id ? [{
    observationId: ref.observation_id,
    rawText: ref.text,
    role: 'candidate_member' as const,
    boundingBox: { xMin: ref.x_min, xMax: ref.x_max, yMin: ref.y_min, yMax: ref.y_max },
    sourceLayer: ref.source === 'ocr_fallback' ? 'ocr' as const : 'pdf_native_text' as const,
    sourceCoordinateSpace: ref.source === 'ocr_fallback'
      ? 'ocr_render_px' as const : 'pdf_user_unrotated' as const,
    memberIndex,
  }] : []);
  // Canonical geometry is adopted only for a ref whose source box still
  // matches the one the sidecar was derived from.
  const canonical = resolveCanonicalObservationBoxes(canonicalSidecar, drawn.map((box) => ({
    observationId: box.observationId, physicalPageNumber: page, boundingBox: box.boundingBox,
  })));
  return drawn.map((box) => {
    const canonicalBoundingBox = canonical.get(box.observationId);
    return canonicalBoundingBox ? { ...box, canonicalBoundingBox } : box;
  });
}

export function exactOcrPageGeometry(
  observationsLayer: Record<string, unknown> | null,
  page: number,
  pageRepresentationDigest: string,
): Readonly<{ width: number; height: number }> | null {
  const matches = records(observationsLayer?.source_page_geometries).filter((entry) =>
    entry.source_layer === 'ocr'
    && entry.physical_page_number === page
    && entry.page_representation_digest === pageRepresentationDigest);
  if (matches.length !== 1) return null;
  const width = Number(matches[0]!.pixel_width);
  const height = Number(matches[0]!.pixel_height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height } : null;
}

/** The layout observation layer of a persisted extraction blob (`document_extractions.data`). */
export function layoutObservationsLayerOf(extractionData: unknown): Record<string, unknown> | null {
  const extraction = record(record(extractionData)?.extraction);
  return record(record(record(extraction?.content_layers_v1)?.pdf)?.layout_observations_v1);
}

/** The source artifact the observations were read from, as the diagnostics read resolves it. */
export function sourceArtifactIdOf(extractionData: unknown): string | null {
  const extraction = record(record(extractionData)?.extraction);
  const observations = layoutObservationsLayerOf(extractionData);
  const provenance = record(extraction?.physical_page_provenance_v1);
  return typeof observations?.source_artifact_id === 'string'
    ? observations.source_artifact_id
    : typeof provenance?.source_artifact_id === 'string' ? provenance.source_artifact_id : null;
}

/**
 * Page evidence for one identified item on one page of the current
 * extraction. Without a source artifact the page cannot be shown, so the
 * result is null. An empty box list shows the page with nothing highlighted.
 */
export function pageVisualEvidence(params: Readonly<{
  evidenceId: string;
  summary: string;
  extractionData: unknown;
  sourceDocumentId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  refs: readonly DiagnosticSourceRef[];
}>): DiagnosticVisualSourceEvidence | null {
  const sourceArtifactId = sourceArtifactIdOf(params.extractionData);
  if (!sourceArtifactId) return null;
  const layer = layoutObservationsLayerOf(params.extractionData);
  const ocr = exactOcrPageGeometry(layer, params.physicalPageNumber, params.pageRepresentationDigest);
  return {
    kind: 'diagnostic',
    diagnosticId: params.evidenceId,
    summary: params.summary,
    sourceArtifactId,
    sourceDocumentId: params.sourceDocumentId,
    physicalPageNumber: params.physicalPageNumber,
    pageRepresentationDigest: params.pageRepresentationDigest,
    ...(ocr ? { ocrPixelWidth: ocr.width, ocrPixelHeight: ocr.height } : {}),
    boxes: diagnosticSourceBoxes(params.refs, params.physicalPageNumber, layer?.canonical_geometry_v1),
  };
}

/** One document's current pages, as a page-level frame for evidence that cites a page but no observation. */
export type DocumentPageFrames = Readonly<{
  sourceDocumentId: string;
  sourceArtifactId: string;
  pages: ReadonlyMap<number, Readonly<{ pageRepresentationDigest: string; ocrPixelWidth?: number; ocrPixelHeight?: number }>>;
}>;

export function documentPageFrames(params: Readonly<{
  extractionData: unknown;
  sourceDocumentId: string;
  /** The current, verified per-page digests (the coverage layer's). */
  pageRepresentationDigestByPage: ReadonlyMap<number, string>;
}>): DocumentPageFrames | null {
  const sourceArtifactId = sourceArtifactIdOf(params.extractionData);
  if (!sourceArtifactId) return null;
  const layer = layoutObservationsLayerOf(params.extractionData);
  const pages = new Map<number, { pageRepresentationDigest: string; ocrPixelWidth?: number; ocrPixelHeight?: number }>();
  for (const [page, digest] of params.pageRepresentationDigestByPage) {
    const ocr = exactOcrPageGeometry(layer, page, digest);
    pages.set(page, { pageRepresentationDigest: digest, ...(ocr ? { ocrPixelWidth: ocr.width, ocrPixelHeight: ocr.height } : {}) });
  }
  return { sourceDocumentId: params.sourceDocumentId, sourceArtifactId, pages };
}

/** The page alone, nothing highlighted. Null when the page is not a current, verified page. */
export function pageFrameVisual(
  frames: DocumentPageFrames | undefined,
  page: number | null,
  evidenceId: string,
  summary: string,
): DiagnosticVisualSourceEvidence | null {
  if (!frames || page == null) return null;
  const frame = frames.pages.get(page);
  if (!frame) return null;
  return {
    kind: 'diagnostic',
    diagnosticId: evidenceId,
    summary,
    sourceArtifactId: frames.sourceArtifactId,
    sourceDocumentId: frames.sourceDocumentId,
    physicalPageNumber: page,
    ...frame,
    boxes: [],
  };
}
