import type { ExtractionGap } from '@/lib/extraction/types';
import {
  countUnsafeTextControls,
  stripUnsafeTextControls,
} from '@/lib/extraction/textSanitization';

export interface PdfToken {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
}

export interface PdfLayoutPage {
  page_number: number;
  lines: PdfLayoutLine[];
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

function classifyLine(text: string, tokens: PdfToken[]): PdfLayoutLine['kind'] {
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
  options?: { maxPages?: number },
): Promise<PdfLayout> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(bytes);
    const pdfDocument = await pdfjs.getDocument({ data }).promise;
    const maxPages = Math.min(pdfDocument.numPages, options?.maxPages ?? pdfDocument.numPages);
    const pages: PdfLayoutPage[] = [];

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let strippedControlCount = 0;
      let sanitizedTokenCount = 0;
      const items = (textContent.items ?? []) as Array<{
        str?: string;
        width?: number;
        height?: number;
        transform?: number[];
      }>;

      const tokens = items
        .map((item) => {
          const rawText = item.str ?? '';
          const removedControls = countUnsafeTextControls(rawText);
          if (removedControls > 0) {
            strippedControlCount += removedControls;
            sanitizedTokenCount += 1;
          }
          return {
            text: stripUnsafeTextControls(rawText).trim(),
            x: Array.isArray(item.transform) ? round(item.transform[4] ?? 0) : 0,
            y: Array.isArray(item.transform) ? round(item.transform[5] ?? 0) : 0,
            width: typeof item.width === 'number' ? round(item.width) : 0,
            height: typeof item.height === 'number' ? round(item.height) : 0,
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

      pages.push({
        page_number: pageNumber,
        lines,
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

function buildFallbackTextExtraction(fallbackText: string): PdfTextExtractionResult {
  const normalized = normalizeWhitespace(fallbackText);
  return {
    page_count: normalized ? 1 : 0,
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

export function buildPdfTextExtraction(params: {
  layout: PdfLayout;
  fallbackText?: string | null;
}): PdfTextExtractionResult {
  const blocksByPage = params.layout.pages.map((page) => {
    const blocks = buildTextBlocks(page);
    return {
      page_number: page.page_number,
      line_count: page.lines.length,
      plain_text_blocks: blocks,
    };
  });

  const combinedText = normalizeWhitespace(
    blocksByPage
      .flatMap((page) => page.plain_text_blocks.map((block) => block.text))
      .join('\n\n'),
  );

  if (!combinedText && params.fallbackText) {
    const fallback = buildFallbackTextExtraction(params.fallbackText);
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
  options?: { maxPages?: number; fallbackText?: string | null },
): Promise<PdfTextExtractionResult> {
  const layout = await loadPdfLayout(bytes, options);
  return buildPdfTextExtraction({
    layout,
    fallbackText: options?.fallbackText ?? null,
  });
}
