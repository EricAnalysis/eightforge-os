import type { ExtractionGap } from '@/lib/extraction/types';
import {
  classifyLine,
  type PdfLayout,
  type PdfLayoutLine,
  type PdfLayoutPage,
  type PdfToken,
} from '@/lib/extraction/pdf/extractText';
import {
  canonicalIntersectionOverSmaller,
  ocrRenderBoxToCanonical,
  type CanonicalPageFrame,
} from '@/lib/extraction/geometry/canonicalPageFrame';
import {
  createPdfLayoutObservationIdentity,
  pdfLayoutPageRepresentationDigest,
  type PdfLayoutObservationIdentityContext,
} from '@/lib/extraction/pdf/layoutObservationIdentity';

export interface OcrGeometryWord {
  text: string;
  confidence?: number | null;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  /** Original Tesseract block/paragraph/line/word traversal path, before filtering. */
  parser_path?: string;
}

export interface OcrGeometryPage {
  page_number: number;
  width?: number | null;
  height?: number | null;
  /** Digest/config binding for the exact rendered OCR representation. */
  representation_key?: string;
  words: OcrGeometryWord[];
}

export interface OcrLayoutDiagnostics {
  pages_using_native_layout: number[];
  pages_using_ocr_derived_layout: number[];
  ocr_derived_line_count: number;
  ocr_derived_table_candidate_count: number;
  ocr_geometry_missing_pages: number[];
}

export interface OcrLayoutMergeResult {
  layout: PdfLayout;
  diagnostics: OcrLayoutDiagnostics;
  gaps: ExtractionGap[];
}

function buildGap(input: Omit<ExtractionGap, 'id' | 'source'>): ExtractionGap {
  return {
    id: `gap:${input.category}:${input.page ?? 'global'}`,
    source: 'pdf',
    ...input,
  };
}

function normalizeWordText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function wordToToken(
  word: OcrGeometryWord,
  params: {
    pageNumber: number;
    wordIndex: number;
    ocrWidth: number;
    ocrHeight: number;
    pageWidth: number;
    pageHeight: number;
    normalizeToPdf: boolean;
    pageRepresentationDigest: string | null;
    identityContext?: PdfLayoutObservationIdentityContext | null;
    canonicalFrame?: CanonicalPageFrame | null;
  },
): PdfToken | null {
  const text = normalizeWordText(word.text);
  const { x0, y0, x1, y1 } = word.bbox;
  if (!text || !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    return null;
  }
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  if (width === 0 && height === 0) return null;
  if (params.ocrWidth <= 0 || params.ocrHeight <= 0 || params.pageWidth <= 0 || params.pageHeight <= 0) {
    return null;
  }
  const scaleX = params.pageWidth / params.ocrWidth;
  const scaleY = params.pageHeight / params.ocrHeight;
  // Tesseract reports word confidence on a 0-100 scale; normalize to 0-1 here
  // so it's directly comparable against the codebase's existing 0.85/0.65
  // confidence-label convention instead of carrying a second scale downstream.
  const confidence = typeof word.confidence === 'number' && Number.isFinite(word.confidence)
    ? Math.max(0, Math.min(1, word.confidence / 100))
    : null;
  const observationIdentity = params.identityContext && params.pageRepresentationDigest
    ? createPdfLayoutObservationIdentity({
        context: params.identityContext,
        physicalPageNumber: params.pageNumber,
        sourceMethod: 'ocr_fallback',
        parser: 'tesseract_blocks',
        parserObservationKey: word.parser_path ?? `word:${params.wordIndex}`,
        pageRepresentationDigest: params.pageRepresentationDigest,
      })
    : null;
  // Derived, additive (E2): the render already embodies rotation and crop, so
  // only the render scale is removed. The pixel evidence below is untouched.
  const canonicalBbox = params.canonicalFrame
    ? ocrRenderBoxToCanonical(
        params.canonicalFrame,
        { x_min: x0, y_min: y0, x_max: x1, y_max: y1 },
        { pixelWidth: params.ocrWidth, pixelHeight: params.ocrHeight },
      )
    : null;
  return {
    text,
    // The layout space downstream of this function is PDF page points with a
    // bottom-left, Y-up origin. It is historical and unchanged by E2; canonical
    // geometry travels separately in `canonical_bbox`.
    x: Math.round((params.normalizeToPdf ? x0 * scaleX : x0) * 1000) / 1000,
    y: Math.round((params.normalizeToPdf ? params.pageHeight - (y1 * scaleY) : y0) * 1000) / 1000,
    width: Math.round((params.normalizeToPdf ? width * scaleX : width) * 1000) / 1000,
    height: Math.round((params.normalizeToPdf ? height * scaleY : height) * 1000) / 1000,
    source: 'ocr_fallback',
    confidence,
    ocr_source_geometry: {
      bbox: { x0, y0, x1, y1 },
      pixel_width: params.ocrWidth,
      pixel_height: params.ocrHeight,
    },
    ...(canonicalBbox ? { canonical_bbox: canonicalBbox } : {}),
    ...(observationIdentity
      ? { observation_id: observationIdentity.id, observation_identity: observationIdentity }
      : {}),
  };
}

/**
 * Line grouping runs in the OCR engine's own top-left render space, where its
 * tolerances were established. Normalization changes only the coordinates
 * handed downstream, never which words share a line.
 */
function sourceLineCenter(token: PdfToken): number {
  const bbox = token.ocr_source_geometry?.bbox;
  return bbox ? (bbox.y0 + bbox.y1) / 2 : token.y + (token.height / 2);
}

function sourceHeight(token: PdfToken): number {
  const bbox = token.ocr_source_geometry?.bbox;
  return bbox ? Math.max(0, bbox.y1 - bbox.y0) : token.height;
}

function sourceX(token: PdfToken): number {
  return token.ocr_source_geometry?.bbox.x0 ?? token.x;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

export function buildOcrLayoutPages(
  pages: OcrGeometryPage[],
  identityContext?: PdfLayoutObservationIdentityContext | null,
  targetPages?: ReadonlyMap<number, PdfLayoutPage>,
): PdfLayoutPage[] {
  return pages.flatMap((page) => {
    const targetPage = targetPages?.get(page.page_number);
    // Direct callers without a target layout retain the legacy coordinate
    // scale. Merge callers always supply the native PDF page dimensions.
    const ocrWidth = page.width ?? targetPage?.width ?? 1;
    const ocrHeight = page.height ?? targetPage?.height ?? 1;
    const pageWidth = targetPage?.width ?? page.width ?? ocrWidth;
    const pageHeight = targetPage?.height ?? page.height ?? ocrHeight;
    const normalizeToPdf = Boolean(targetPage?.width && targetPage?.height && page.width && page.height);
    // Canonical geometry needs the page's own frame; without it OCR evidence
    // carries pixel geometry only and canonical consumers fail closed.
    const canonicalFrame = page.width && page.height ? targetPage?.canonical_frame ?? null : null;
    const pageRepresentationDigest = identityContext
      ? pdfLayoutPageRepresentationDigest({
          representation_key: page.representation_key ?? null,
          words: page.words.map((word) => ({
            parser_path: word.parser_path ?? null,
            text: word.text,
            confidence: word.confidence ?? null,
            bbox: word.bbox,
          })),
        })
      : null;
    const tokens = page.words
      .map((word, wordIndex) => wordToToken(word, {
        pageNumber: page.page_number,
        wordIndex,
        ocrWidth,
        ocrHeight,
        pageWidth,
        pageHeight,
        normalizeToPdf,
        pageRepresentationDigest,
        identityContext,
        canonicalFrame,
      }))
      .filter((token): token is PdfToken => token != null)
      .sort((left, right) => sourceLineCenter(left) - sourceLineCenter(right)
        || sourceX(left) - sourceX(right));

    const medianHeight = median(tokens.map(sourceHeight).filter((height) => height > 0));
    const tolerance = Math.max(8, medianHeight * 0.65);
    const buckets: Array<{ center: number; tokens: PdfToken[] }> = [];

    for (const token of tokens) {
      const center = sourceLineCenter(token);
      const bucket = buckets.find((candidate) => Math.abs(candidate.center - center) <= tolerance);
      if (bucket) {
        bucket.tokens.push(token);
        bucket.center = (bucket.center + center) / 2;
      } else {
        buckets.push({ center, tokens: [token] });
      }
    }

    buckets.sort((left, right) => left.center - right.center);
    // A line's position leaves in the same space as its tokens: bottom-left
    // PDF points when normalized, legacy render pixels otherwise.
    // Native pdf.js tokens on one visual line share a baseline, and
    // reconstruction groups tokens by that shared value. A normalized OCR line
    // therefore gives every word the line's baseline (its lowest source edge in
    // PDF points); each word's exact render box stays in ocr_source_geometry.
    const baselineFor = (bucketTokens: readonly PdfToken[]) => pageHeight
      - (Math.max(...bucketTokens.map((token) => token.ocr_source_geometry?.bbox.y1 ?? 0))
        * (pageHeight / ocrHeight));
    const lineY = (bucket: Readonly<{ center: number; tokens: readonly PdfToken[] }>) => normalizeToPdf
      ? baselineFor(bucket.tokens)
      : bucket.center;

    const lines = buckets
      .map((bucket, index) => {
        bucket.tokens.sort((left, right) => sourceX(left) - sourceX(right));
        if (normalizeToPdf) {
          const baseline = Math.round(baselineFor(bucket.tokens) * 1000) / 1000;
          bucket.tokens = bucket.tokens.map((token) => ({ ...token, y: baseline }));
        }
        const text = bucket.tokens.map((token) => token.text).join(' ').trim();
        const first = bucket.tokens[0];
        const last = bucket.tokens.at(-1);
        return {
          id: `pdf:ocr-line:p${page.page_number}:${index + 1}`,
          page_number: page.page_number,
          text,
          tokens: bucket.tokens,
          kind: classifyLine(text, bucket.tokens),
          x_min: first?.x ?? 0,
          x_max: last ? last.x + last.width : 0,
          y: Math.round(lineY(bucket) * 1000) / 1000,
          source: 'ocr_fallback',
        } satisfies PdfLayoutLine;
      })
      .filter((line) => line.text.length > 0);

    return {
      page_number: page.page_number,
      width: pageWidth,
      height: pageHeight,
      lines,
      source: 'ocr_fallback',
      ...(canonicalFrame ? { canonical_frame: canonicalFrame } : {}),
      ...(pageRepresentationDigest ? { effective_representation_digest: pageRepresentationDigest } : {}),
    };
  });
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Duplicate-detection overlap, compared only in canonical_v1.
 *
 * Before E2 this compared native raw user-space boxes against OCR boxes that
 * had been flipped through the *rotated* page height: two different coordinate
 * frames, which disagreed on any rotated or cropped page. Both sides are now
 * normalized into the page's canonical frame first. The admission rule itself
 * is unchanged (half of the smaller box), and a token without canonical
 * geometry is never treated as a duplicate.
 */
function overlaps(left: PdfToken, right: PdfToken): boolean {
  if (!left.canonical_bbox || !right.canonical_bbox) return false;
  return canonicalIntersectionOverSmaller(left.canonical_bbox, right.canonical_bbox) >= 0.5;
}

function effectiveDigest(page: PdfLayoutPage): string | undefined {
  return page.effective_representation_digest
    ?? page.lines.flatMap((line) => line.tokens)
      .find((token) => token.observation_identity)?.observation_identity?.page_representation_digest;
}

/**
 * Two layout representations are produced from the same native layout and OCR
 * geometry, because their consumers were built on different coordinate spaces:
 *
 * - `reconciled_pdf_points` (priced-schedule reconstruction, layout
 *   observations, recovery candidates): OCR geometry normalized into
 *   bottom-left PDF points, and non-duplicate OCR admitted onto pages that also
 *   carry native text, so a stamp or header cannot discard an OCR table.
 * - `legacy_render_pixels` (default; structural table, text and form layers):
 *   unchanged merge semantics. Native pages win whole, and OCR-only pages keep
 *   top-left render pixels, which the OCR table geometry heuristics depend on.
 */
export type OcrLayoutRepresentation = 'reconciled_pdf_points' | 'legacy_render_pixels';

export function mergeOcrFallbackLayout(params: {
  nativeLayout: PdfLayout;
  ocrPages: OcrGeometryPage[];
  ocrTextPageNumbers?: number[];
  observationIdentity?: PdfLayoutObservationIdentityContext | null;
  representation?: OcrLayoutRepresentation;
}): OcrLayoutMergeResult {
  const reconciled = params.representation === 'reconciled_pdf_points';
  const nativeByPage = new Map(params.nativeLayout.pages.map((page) => [page.page_number, page] as const));
  const ocrLayoutByPage = new Map(
    buildOcrLayoutPages(params.ocrPages, params.observationIdentity, reconciled ? nativeByPage : undefined)
      .map((page) => [page.page_number, page] as const),
  );
  const ocrTextPageSet = new Set(params.ocrTextPageNumbers ?? []);
  const pagesUsingNative: number[] = [];
  const pagesUsingOcr: number[] = [];
  const geometryMissingPages: number[] = [];
  let ocrLineCount = 0;
  let ocrTableCandidateCount = 0;

  const pages = params.nativeLayout.pages.map((nativePage) => {
    const ocrPage = ocrLayoutByPage.get(nativePage.page_number);
    // Native and OCR evidence may share a page only once both are in PDF points.
    // Without exact page and render dimensions, native precedence is kept.
    const ocrSource = params.ocrPages.find((page) => page.page_number === nativePage.page_number);
    // Mixed admission needs one shared frame for both extractors. Without the
    // canonical frame there is no honest duplicate test, so native wins whole
    // rather than admitting OCR that may restate the native text.
    const normalizable = Boolean(nativePage.width && nativePage.height
      && ocrSource?.width && ocrSource?.height && nativePage.canonical_frame);
    if (reconciled && normalizable
      && nativePage.lines.length > 0 && ocrPage && ocrPage.lines.length > 0) {
      const nativeTokens = nativePage.lines.flatMap((line) => line.tokens);
      const admittedOcrLines = ocrPage.lines.flatMap((line) => {
        const tokens = line.tokens.filter((ocrToken) => !nativeTokens.some((nativeToken) =>
          normalizedText(nativeToken.text) === normalizedText(ocrToken.text) && overlaps(nativeToken, ocrToken)));
        if (tokens.length === 0) return [];
        const text = tokens.map((token) => token.text).join(' ').trim();
        return [{
          ...line,
          text,
          tokens,
          kind: classifyLine(text, tokens),
          x_min: tokens[0]?.x ?? 0,
          x_max: (tokens.at(-1)?.x ?? 0) + (tokens.at(-1)?.width ?? 0),
        } satisfies PdfLayoutLine];
      });
      if (admittedOcrLines.length > 0) {
        pagesUsingNative.push(nativePage.page_number);
        pagesUsingOcr.push(nativePage.page_number);
        ocrLineCount += admittedOcrLines.length;
        ocrTableCandidateCount += admittedOcrLines.filter((line) => line.kind === 'table_candidate').length;
        const nativeDigest = effectiveDigest(nativePage) ?? null;
        const ocrDigest = effectiveDigest(ocrPage) ?? null;
        return {
          ...nativePage,
          lines: [...nativePage.lines, ...admittedOcrLines]
            .sort((left, right) => (right.y - left.y) || (left.x_min - right.x_min)),
          source: 'mixed',
          ...(params.observationIdentity ? {
            effective_representation_digest: pdfLayoutPageRepresentationDigest({
              representation: 'mixed_native_ocr_v1', native_digest: nativeDigest, ocr_digest: ocrDigest,
            }),
          } : {}),
        } satisfies PdfLayoutPage;
      }
    }

    if (nativePage.lines.length > 0) {
      pagesUsingNative.push(nativePage.page_number);
      return {
        ...nativePage,
        source: nativePage.source ?? 'pdfjs',
      } satisfies PdfLayoutPage;
    }

    if (ocrPage && ocrPage.lines.length > 0) {
      pagesUsingOcr.push(nativePage.page_number);
      ocrLineCount += ocrPage.lines.length;
      ocrTableCandidateCount += ocrPage.lines.filter((line) => line.kind === 'table_candidate').length;
      return ocrPage;
    }

    if (ocrTextPageSet.has(nativePage.page_number)) {
      geometryMissingPages.push(nativePage.page_number);
    }

    return nativePage;
  });

  const gaps = [...params.nativeLayout.gaps];
  for (const page of geometryMissingPages) {
    gaps.push(buildGap({
      category: 'ocr_geometry_missing',
      severity: 'warning',
      page,
      message: 'OCR fallback text exists for this page, but no OCR word geometry was available.',
    }));
  }

  return {
    layout: {
      ...params.nativeLayout,
      pages,
      gaps,
    },
    diagnostics: {
      pages_using_native_layout: pagesUsingNative,
      pages_using_ocr_derived_layout: pagesUsingOcr,
      ocr_derived_line_count: ocrLineCount,
      ocr_derived_table_candidate_count: ocrTableCandidateCount,
      ocr_geometry_missing_pages: geometryMissingPages,
    },
    gaps,
  };
}
