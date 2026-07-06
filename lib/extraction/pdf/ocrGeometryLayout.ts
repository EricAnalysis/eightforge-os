import type { ExtractionGap } from '@/lib/extraction/types';
import {
  classifyLine,
  type PdfLayout,
  type PdfLayoutLine,
  type PdfLayoutPage,
  type PdfToken,
} from '@/lib/extraction/pdf/extractText';

export interface OcrGeometryWord {
  text: string;
  confidence?: number | null;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
}

export interface OcrGeometryPage {
  page_number: number;
  width?: number | null;
  height?: number | null;
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

function wordToToken(word: OcrGeometryWord): PdfToken | null {
  const text = normalizeWordText(word.text);
  const { x0, y0, x1, y1 } = word.bbox;
  if (!text || !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    return null;
  }
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  if (width === 0 && height === 0) return null;
  // Tesseract reports word confidence on a 0-100 scale; normalize to 0-1 here
  // so it's directly comparable against the codebase's existing 0.85/0.65
  // confidence-label convention instead of carrying a second scale downstream.
  const confidence = typeof word.confidence === 'number' && Number.isFinite(word.confidence)
    ? Math.max(0, Math.min(1, word.confidence / 100))
    : null;
  return {
    text,
    x: Math.round(x0 * 1000) / 1000,
    y: Math.round(y0 * 1000) / 1000,
    width: Math.round(width * 1000) / 1000,
    height: Math.round(height * 1000) / 1000,
    source: 'ocr_fallback',
    confidence,
  };
}

function lineCenter(token: PdfToken): number {
  return token.y + (token.height / 2);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

export function buildOcrLayoutPages(pages: OcrGeometryPage[]): PdfLayoutPage[] {
  return pages.map((page) => {
    const tokens = page.words
      .map(wordToToken)
      .filter((token): token is PdfToken => token != null)
      .sort((left, right) => lineCenter(left) - lineCenter(right) || left.x - right.x);

    const medianHeight = median(tokens.map((token) => token.height).filter((height) => height > 0));
    const tolerance = Math.max(8, medianHeight * 0.65);
    const buckets: Array<{ center: number; tokens: PdfToken[] }> = [];

    for (const token of tokens) {
      const center = lineCenter(token);
      const bucket = buckets.find((candidate) => Math.abs(candidate.center - center) <= tolerance);
      if (bucket) {
        bucket.tokens.push(token);
        bucket.center = (bucket.center + center) / 2;
      } else {
        buckets.push({ center, tokens: [token] });
      }
    }

    buckets.sort((left, right) => left.center - right.center);

    const lines = buckets
      .map((bucket, index) => {
        bucket.tokens.sort((left, right) => left.x - right.x);
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
          y: Math.round(bucket.center * 1000) / 1000,
          source: 'ocr_fallback',
        } satisfies PdfLayoutLine;
      })
      .filter((line) => line.text.length > 0);

    return {
      page_number: page.page_number,
      lines,
      source: 'ocr_fallback',
    };
  });
}

export function mergeOcrFallbackLayout(params: {
  nativeLayout: PdfLayout;
  ocrPages: OcrGeometryPage[];
  ocrTextPageNumbers?: number[];
}): OcrLayoutMergeResult {
  const ocrLayoutByPage = new Map(
    buildOcrLayoutPages(params.ocrPages).map((page) => [page.page_number, page] as const),
  );
  const ocrTextPageSet = new Set(params.ocrTextPageNumbers ?? []);
  const pagesUsingNative: number[] = [];
  const pagesUsingOcr: number[] = [];
  const geometryMissingPages: number[] = [];
  let ocrLineCount = 0;
  let ocrTableCandidateCount = 0;

  const pages = params.nativeLayout.pages.map((nativePage) => {
    if (nativePage.lines.length > 0) {
      pagesUsingNative.push(nativePage.page_number);
      return {
        ...nativePage,
        source: nativePage.source ?? 'pdfjs',
      } satisfies PdfLayoutPage;
    }

    const ocrPage = ocrLayoutByPage.get(nativePage.page_number);
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
