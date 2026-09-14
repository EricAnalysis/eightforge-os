import type { ExtractionGap } from '@/lib/extraction/types';
import {
  countUnsafeTextControls,
  stripUnsafeTextControls,
} from '@/lib/extraction/textSanitization';
import {
  createPdfLayoutObservationIdentity,
  pdfLayoutPageRepresentationDigest,
  type PdfLayoutObservationIdentity,
  type PdfLayoutObservationIdentityContext,
  type PdfLayoutObservationId,
} from '@/lib/extraction/pdf/layoutObservationIdentity';

export interface PdfToken {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  source?: 'pdfjs' | 'ocr_fallback';
  // OCR engine recognition confidence for this token, normalized to 0-1 (the
  // codebase's existing confidence scale, e.g. documentIntelligenceViewModel.ts's
  // 0.85/0.65 high/medium boundaries). Only populated for ocr_fallback tokens
  // sourced from Tesseract word-level output (see ocrGeometryLayout.ts);
  // undefined for native pdfjs text, which has no per-character OCR confidence.
  confidence?: number | null;
  /** Original OCR render-pixel geometry retained after canonical normalization. */
  ocr_source_geometry?: {
    bbox: { x0: number; y0: number; x1: number; y1: number };
    pixel_width: number;
    pixel_height: number;
  };
  /** Primitive source-observation identity assigned before downstream sorting/grouping. */
  observation_id?: PdfLayoutObservationId;
  observation_identity?: PdfLayoutObservationIdentity;
}

export interface PdfLayoutLine {
  id: string;
  page_number: number;
  text: string;
  tokens: PdfToken[];
  kind: 'text' | 'table_candidate' | 'form_candidate';
  x_min: number;
  x_max: number;
  y: number;
  source?: 'pdfjs' | 'ocr_fallback';
}

export interface PdfLayoutPage {
  page_number: number;
  width?: number;
  height?: number;
  lines: PdfLayoutLine[];
  source?: 'pdfjs' | 'ocr_fallback' | 'mixed';
  /** Cheap, deterministic pdf.js operator-list evidence used only for OCR admission. */
  visual_coverage?: {
    image_operator_count: number;
    approximate_image_coverage_ratio: number;
    /** Painted vector paths; outlined text renders visibly with no text layer. */
    vector_operator_count?: number;
  };
  /** Additive identity for the exact reconciled representation consumed downstream. */
  effective_representation_digest?: string;
}

export interface PdfLayout {
  page_count: number;
  pages: PdfLayoutPage[];
  gaps: ExtractionGap[];
}

export interface PdfTextBlock {
  id: string;
  page_number: number;
  text: string;
  line_start: number;
  line_end: number;
  nearby_text?: string;
}

export interface PdfTextExtractionResult {
  page_count: number;
  pages: Array<{
    page_number: number;
    line_count: number;
    plain_text_blocks: PdfTextBlock[];
  }>;
  combined_text: string;
  confidence: number;
  gaps: ExtractionGap[];
}

export interface PdfFallbackPageText {
  page_number: number;
  text: string;
}

function normalizeWhitespace(value: string): string {
  return stripUnsafeTextControls(value)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function buildGap(input: Omit<ExtractionGap, 'id' | 'source'> & { source?: ExtractionGap['source'] }): ExtractionGap {
  return {
    id: `gap:${input.category}:${input.page ?? input.sheet ?? 'global'}:${input.row ?? '0'}`,
    source: input.source ?? 'pdf',
    ...input,
  };
}

export function classifyLine(text: string, tokens: PdfToken[]): PdfLayoutLine['kind'] {
  const normalized = text.trim();
  if (!normalized) return 'text';

  const colonIndex = normalized.indexOf(':');
  if (colonIndex > 1 && colonIndex < 42 && normalized.length < 120) {
    return 'form_candidate';
  }

  const numericTokens = tokens.filter((token) => /[$]?\d/.test(token.text)).length;
  const gapCount = tokens.slice(1).filter((token, index) => {
    const previous = tokens[index];
    return token.x - (previous.x + previous.width) > Math.max(18, previous.width * 1.6);
  }).length;
  if ((tokens.length >= 3 && numericTokens >= 1 && gapCount >= 1) || (tokens.length >= 4 && gapCount >= 2)) {
    return 'table_candidate';
  }

  return 'text';
}

function blockNearbyText(lines: PdfLayoutLine[], start: number, end: number): string | undefined {
  const previous = lines[Math.max(0, start - 1)]?.text?.trim();
  const next = lines[Math.min(lines.length - 1, end + 1)]?.text?.trim();
  const nearby = [previous, next].filter(Boolean).join(' | ').trim();
  return nearby || undefined;
}

function buildTextBlocks(page: PdfLayoutPage): PdfTextBlock[] {
  const blocks: PdfTextBlock[] = [];
  let currentStart = -1;
  let currentLines: string[] = [];

  const flush = (endIndex: number) => {
    if (currentStart === -1 || currentLines.length === 0) return;
    const text = normalizeWhitespace(currentLines.join('\n'));
    if (text) {
      blocks.push({
        id: `pdf:text:p${page.page_number}:b${blocks.length + 1}`,
        page_number: page.page_number,
        text,
        line_start: currentStart,
        line_end: endIndex,
        nearby_text: blockNearbyText(page.lines, currentStart, endIndex),
      });
    }
    currentStart = -1;
    currentLines = [];
  };

  page.lines.forEach((line, index) => {
    if (line.kind !== 'text') {
      flush(index - 1);
      return;
    }

    if (currentStart === -1) {
      currentStart = index;
      currentLines.push(line.text);
      return;
    }

    const previousLine = page.lines[index - 1];
    const adjacent = previousLine && previousLine.kind === 'text';
    if (!adjacent) {
      flush(index - 1);
      currentStart = index;
      currentLines = [line.text];
      return;
    }

    currentLines.push(line.text);
  });

  flush(page.lines.length - 1);
  return blocks;
}

export async function loadPdfLayout(
  bytes: ArrayBuffer,
  options?: {
    maxPages?: number;
    /** Explicitly relevant physical pages may pierce maxPages without expanding the whole cap. */
    priorityPageNumbers?: readonly number[];
    observationIdentity?: PdfLayoutObservationIdentityContext | null;
  },
): Promise<PdfLayout> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(bytes);
    const pdfDocument = await pdfjs.getDocument({ data }).promise;
    const maxPages = Math.min(pdfDocument.numPages, options?.maxPages ?? pdfDocument.numPages);
    const pageNumbers = new Set(Array.from({ length: maxPages }, (_, index) => index + 1));
    for (const pageNumber of options?.priorityPageNumbers ?? []) {
      if (Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pdfDocument.numPages) {
        pageNumbers.add(pageNumber);
      }
    }
    const pages: PdfLayoutPage[] = [];

    for (const pageNumber of [...pageNumbers].sort((left, right) => left - right)) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const [textContent, operatorList] = await Promise.all([
        page.getTextContent(),
        page.getOperatorList(),
      ]);
      let strippedControlCount = 0;
      let sanitizedTokenCount = 0;
      const items = (textContent.items ?? []) as Array<{
        str?: string;
        width?: number;
        height?: number;
        transform?: number[];
      }>;
      const pageRepresentationDigest = options?.observationIdentity
        ? pdfLayoutPageRepresentationDigest(items.map((item) => ({
            text: item.str ?? '',
            width: item.width ?? null,
            height: item.height ?? null,
            transform: item.transform ?? null,
          })))
        : null;

      const tokens = items
        .map((item, itemIndex) => {
          const rawText = item.str ?? '';
          const removedControls = countUnsafeTextControls(rawText);
          if (removedControls > 0) {
            strippedControlCount += removedControls;
            sanitizedTokenCount += 1;
          }
          const observationIdentity = options?.observationIdentity && pageRepresentationDigest
            ? createPdfLayoutObservationIdentity({
                context: options.observationIdentity,
                physicalPageNumber: pageNumber,
                sourceMethod: 'pdfjs',
                parser: 'pdfjs_text_content',
                parserObservationKey: `item:${itemIndex}`,
                pageRepresentationDigest,
              })
            : null;
          return {
            text: stripUnsafeTextControls(rawText).trim(),
            x: Array.isArray(item.transform) ? round(item.transform[4] ?? 0) : 0,
            y: Array.isArray(item.transform) ? round(item.transform[5] ?? 0) : 0,
            width: typeof item.width === 'number' ? round(item.width) : 0,
            height: typeof item.height === 'number' ? round(item.height) : 0,
            source: 'pdfjs' as const,
            ...(observationIdentity
              ? { observation_id: observationIdentity.id, observation_identity: observationIdentity }
              : {}),
          };
        })
        .filter((token) => token.text.length > 0);

      if (
        strippedControlCount > 0 &&
        (process.env.EIGHTFORGE_PDF_EXTRACT_DEBUG === '1' || process.env.EIGHTFORGE_OCR_DEBUG === '1')
      ) {
        console.log('[pdf-extract][sanitize-layout]', {
          pageNumber,
          sanitized_token_count: sanitizedTokenCount,
          stripped_control_count: strippedControlCount,
        });
      }

      tokens.sort((left, right) => (right.y - left.y) || (left.x - right.x));

      const lineBuckets: Array<{ y: number; tokens: PdfToken[] }> = [];
      for (const token of tokens) {
        const bucket = lineBuckets.find((candidate) => Math.abs(candidate.y - token.y) <= 2);
        if (bucket) {
          bucket.tokens.push(token);
        } else {
          lineBuckets.push({ y: token.y, tokens: [token] });
        }
      }

      lineBuckets.sort((left, right) => right.y - left.y);

      const lines = lineBuckets.map((bucket, index) => {
        bucket.tokens.sort((left, right) => left.x - right.x);
        const text = bucket.tokens.map((token) => token.text).join(' ').trim();
        return {
          id: `pdf:line:p${pageNumber}:${index + 1}`,
          page_number: pageNumber,
          text,
          tokens: bucket.tokens,
          kind: classifyLine(text, bucket.tokens),
          x_min: bucket.tokens[0]?.x ?? 0,
          x_max: (bucket.tokens.at(-1)?.x ?? 0) + (bucket.tokens.at(-1)?.width ?? 0),
          y: bucket.y,
        } satisfies PdfLayoutLine;
      }).filter((line) => line.text.length > 0);

      // PDF image drawing is a unit square transformed by the active CTM. The
      // determinant therefore gives its rendered area in page coordinates.
      // Summing and clamping is intentionally approximate: this is an admission
      // signal, never extracted truth or geometry evidence.
      const ops = (pdfjs as unknown as { OPS?: Record<string, number> }).OPS ?? {};
      const imageOps = new Set([
        ops.paintImageXObject,
        ops.paintInlineImageXObject,
        ops.paintImageMaskXObject,
        ops.paintImageXObjectRepeat,
        ops.paintImageMaskXObjectRepeat,
      ].filter((value): value is number => typeof value === 'number'));
      // Current pdf.js folds the painting operator into constructPath, so path
      // construction is the portable signal for outlined glyphs and drawn tables.
      const vectorPaintOps = new Set([
        ops.constructPath,
        ops.fill,
        ops.eoFill,
        ops.stroke,
        ops.fillStroke,
        ops.eoFillStroke,
        ops.closeStroke,
        ops.closeFillStroke,
        ops.closeEOFillStroke,
      ].filter((value): value is number => typeof value === 'number'));
      type Matrix = [number, number, number, number, number, number];
      const multiply = (left: Matrix, right: Matrix): Matrix => [
        left[0] * right[0] + left[2] * right[1],
        left[1] * right[0] + left[3] * right[1],
        left[0] * right[2] + left[2] * right[3],
        left[1] * right[2] + left[3] * right[3],
        left[0] * right[4] + left[2] * right[5] + left[4],
        left[1] * right[4] + left[3] * right[5] + left[5],
      ];
      let ctm: Matrix = [1, 0, 0, 1, 0, 0];
      const stack: Matrix[] = [];
      let imageOperatorCount = 0;
      let imageArea = 0;
      let vectorOperatorCount = 0;
      const fnArray = operatorList.fnArray ?? [];
      const argsArray = operatorList.argsArray ?? [];
      for (let index = 0; index < fnArray.length; index += 1) {
        const fn = fnArray[index];
        if (fn === ops.save) stack.push([...ctm] as Matrix);
        else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
        else if (fn === ops.paintFormXObjectBegin) {
          // A form XObject draws through its own matrix; scanned PDFs commonly
          // wrap the full-page image in one. Its end restores the outer CTM.
          stack.push([...ctm] as Matrix);
          const matrix = (argsArray[index] as unknown[] | undefined)?.[0];
          if (Array.isArray(matrix) && matrix.length >= 6
            && matrix.slice(0, 6).every((value) => typeof value === 'number')) {
            ctm = multiply(ctm, matrix.slice(0, 6) as Matrix);
          }
        } else if (fn === ops.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
        else if (fn === ops.transform) {
          const args = argsArray[index] as unknown[] | undefined;
          if (args && args.length >= 6 && args.slice(0, 6).every((value) => typeof value === 'number')) {
            ctm = multiply(ctm, args.slice(0, 6) as Matrix);
          }
        } else if (imageOps.has(fn)) {
          imageOperatorCount += 1;
          imageArea += Math.abs((ctm[0] * ctm[3]) - (ctm[1] * ctm[2]));
        } else if (vectorPaintOps.has(fn)) {
          vectorOperatorCount += 1;
        }
      }
      const pageArea = Math.max(1, viewport.width * viewport.height);

      pages.push({
        page_number: pageNumber,
        width: viewport.width,
        height: viewport.height,
        lines,
        visual_coverage: {
          image_operator_count: imageOperatorCount,
          approximate_image_coverage_ratio: round(Math.min(1, imageArea / pageArea)),
          vector_operator_count: vectorOperatorCount,
        },
        ...(pageRepresentationDigest ? { effective_representation_digest: pageRepresentationDigest } : {}),
      });
    }

    const gaps: ExtractionGap[] = [];
    if (pages.every((page) => page.lines.length === 0)) {
      gaps.push(buildGap({
        category: 'missing_pdf_text_layer',
        severity: 'warning',
        message: 'PDF pages did not yield a reliable text layer.',
      }));
    }

    return {
      page_count: pdfDocument.numPages,
      pages,
      gaps,
    };
  } catch (error) {
    return {
      page_count: 0,
      pages: [],
      gaps: [
        buildGap({
          category: 'pdf_layout_parse_failed',
          severity: 'critical',
          message: error instanceof Error ? error.message : 'Unable to parse PDF layout.',
        }),
      ],
    };
  }
}

function buildFallbackTextExtraction(
  fallbackText: string,
  physicalPageCount: number,
): PdfTextExtractionResult {
  const normalized = normalizeWhitespace(fallbackText);
  return {
    // The text is locationless and represented as one synthetic evidence page,
    // but the artifact's physical length remains the parser-derived layout count.
    page_count: physicalPageCount,
    pages: normalized
      ? [{
          page_number: 1,
          line_count: 1,
          plain_text_blocks: [{
            id: 'pdf:text:fallback:1',
            page_number: 1,
            text: normalized,
            line_start: 0,
            line_end: 0,
          }],
        }]
      : [],
    combined_text: normalized,
    confidence: normalized ? 0.35 : 0,
    gaps: normalized
      ? [
          buildGap({
            category: 'fallback_text_only',
            severity: 'warning',
            message: 'Only fallback text was available; location metadata is limited.',
          }),
        ]
      : [
          buildGap({
            category: 'missing_text',
            severity: 'critical',
            message: 'No PDF text could be extracted.',
          }),
        ],
  };
}

function buildFallbackPageTextExtraction(
  fallbackPages: PdfFallbackPageText[],
  layoutPageCount: number,
): PdfTextExtractionResult {
  const pages = fallbackPages
    .map((page) => {
      const normalized = normalizeWhitespace(page.text);
      if (!normalized) return null;
      return {
        page_number: page.page_number,
        line_count: 1,
        plain_text_blocks: [{
          id: `pdf:text:fallback:${page.page_number}`,
          page_number: page.page_number,
          text: normalized,
          line_start: 0,
          line_end: 0,
        }],
      };
    })
    .filter((page): page is PdfTextExtractionResult['pages'][number] => page != null);

  const combinedText = normalizeWhitespace(
    pages.flatMap((page) => page.plain_text_blocks.map((block) => block.text)).join('\n\n'),
  );

  return {
    page_count: layoutPageCount > 0 ? layoutPageCount : pages.length,
    pages,
    combined_text: combinedText,
    confidence: combinedText ? 0.35 : 0,
    gaps: combinedText
      ? [
          buildGap({
            category: 'fallback_text_only',
            severity: 'warning',
            message: 'Only fallback text was available; location metadata is limited.',
          }),
        ]
      : [
          buildGap({
            category: 'missing_text',
            severity: 'critical',
            message: 'No PDF text could be extracted.',
          }),
        ],
  };
}

/**
 * Plain text that would be emitted from layout lines with `kind === 'text'` only
 * (excludes `table_candidate` / `form_candidate`). Used for diagnostics when
 * `buildPdfTextExtraction` falls back to full-string or page evidence text.
 */
export function computeLayoutPlainCombinedText(layout: PdfLayout): string {
  const chunks: string[] = [];
  for (const page of layout.pages) {
    for (const block of buildTextBlocks(page)) {
      if (block.text) chunks.push(block.text);
    }
  }
  return normalizeWhitespace(chunks.join('\n\n'));
}

export function buildPdfTextExtraction(params: {
  layout: PdfLayout;
  fallbackText?: string | null;
  fallbackPages?: PdfFallbackPageText[] | null;
}): PdfTextExtractionResult {
  const fallbackPagesByNumber = new Map(
    (params.fallbackPages ?? []).map((page) => [page.page_number, normalizeWhitespace(page.text)] as const),
  );
  const blocksByPage = params.layout.pages.map((page) => {
    const blocks = buildTextBlocks(page);
    const fallbackText = fallbackPagesByNumber.get(page.page_number);
    const mergedBlocks =
      blocks.length === 0 && fallbackText
        ? [{
          id: `pdf:text:fallback:${page.page_number}`,
          page_number: page.page_number,
          text: fallbackText,
          line_start: 0,
          line_end: 0,
        }]
        : blocks;
    return {
      page_number: page.page_number,
      line_count: page.lines.length,
      plain_text_blocks: mergedBlocks,
    };
  });

  const combinedText = normalizeWhitespace(
    blocksByPage
      .flatMap((page) => page.plain_text_blocks.map((block) => block.text))
      .join('\n\n'),
  );

  if (!combinedText && params.fallbackPages && params.fallbackPages.length > 0) {
    const fallback = buildFallbackPageTextExtraction(params.fallbackPages, params.layout.page_count);
    return {
      ...fallback,
      gaps: [...params.layout.gaps, ...fallback.gaps],
    };
  }

  if (!combinedText && params.fallbackText) {
    const fallback = buildFallbackTextExtraction(
      params.fallbackText,
      params.layout.page_count,
    );
    return {
      ...fallback,
      gaps: [...params.layout.gaps, ...fallback.gaps],
    };
  }

  const populatedPages = blocksByPage.filter((page) => page.plain_text_blocks.length > 0).length;
  const confidence = combinedText
    ? Math.min(0.97, 0.45 + (populatedPages * 0.08) + (combinedText.length > 1500 ? 0.16 : 0.08))
    : 0;

  const gaps = [...params.layout.gaps];
  if (!combinedText) {
    gaps.push(buildGap({
      category: 'plain_text_missing',
      severity: 'warning',
      message: 'Plain text blocks could not be separated from the PDF layout.',
    }));
  }

  return {
    page_count: params.layout.page_count,
    pages: blocksByPage,
    combined_text: combinedText,
    confidence,
    gaps,
  };
}

export async function extractText(
  bytes: ArrayBuffer,
  options?: {
    maxPages?: number;
    fallbackText?: string | null;
    fallbackPages?: PdfFallbackPageText[] | null;
    observationIdentity?: PdfLayoutObservationIdentityContext | null;
  },
): Promise<PdfTextExtractionResult> {
  const layout = await loadPdfLayout(bytes, options);
  return buildPdfTextExtraction({
    layout,
    fallbackText: options?.fallbackText ?? null,
    fallbackPages: options?.fallbackPages ?? null,
  });
}
