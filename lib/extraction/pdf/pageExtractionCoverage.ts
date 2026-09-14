import type { PdfLayoutPage } from '@/lib/extraction/pdf/extractText';

export const PAGE_EXTRACTION_COVERAGE_VERSION = 'page_extraction_coverage_v1' as const;

export type ExtractorCoverageState =
  | 'produced'
  | 'abstained'
  | 'not_eligible'
  | 'not_attempted'
  | 'failed';

export type PageExtractionFinalState =
  | 'native_complete'
  | 'ocr_required'
  | 'mixed_ocr_required'
  | 'ocr_complete'
  | 'empty_page'
  | 'uncertain'
  | 'coverage_failed';

export type PageExtractionCoverage = Readonly<{
  page_number: number;
  page_representation_digest?: string;
  expected_evidence_types: readonly ('pricing')[];
  priority: boolean;
  native: Readonly<{
    state: ExtractorCoverageState;
    token_count: number;
    word_count: number;
    character_count: number;
    line_count: number;
  }>;
  visual: Readonly<{
    state: ExtractorCoverageState;
    image_operator_count: number;
    approximate_image_coverage_ratio: number;
    vector_operator_count: number;
  }>;
  ocr: Readonly<{ state: ExtractorCoverageState }>;
  final_state: PageExtractionFinalState;
  reasons: readonly string[];
}>;

export type PageExtractionCoverageLayer = Readonly<{
  parser_version: typeof PAGE_EXTRACTION_COVERAGE_VERSION;
  /**
   * Which layout each consumer family reads. Priced-schedule evidence (and page
   * text) use the reconciled native+OCR representation in PDF points; the
   * structural text/table/form layers keep native precedence and OCR render
   * pixels. Recorded so the two are never mistaken for one representation.
   */
  representations: Readonly<{
    priced_schedule_evidence: 'reconciled_pdf_points';
    structural_layers: 'legacy_render_pixels';
  }>;
  /** Where the operator said pricing is expected. Inspection guidance, never evidence. */
  operator_guidance: Readonly<{
    state: 'absent' | 'loaded' | 'malformed' | 'unavailable';
    expected_pricing_pages: readonly number[];
  }>;
  pages: readonly PageExtractionCoverage[];
  performance: Readonly<{
    native_extraction_ms: number;
    preflight_ms: number;
    ocr_ms: number;
    total_through_reconciliation_ms: number;
    ocr_pages_attempted: number;
  }>;
}>;

/** Native text at or above either bound is meaningful on a page without large image content. */
const MEANINGFUL_NATIVE_WORD_MIN = 12;
const MEANINGFUL_NATIVE_CHARACTER_MIN = 80;
/**
 * Over a large image, native text only plausibly covers the page when it reads
 * like a body of text. A DocuSign envelope stamp, header, footer, or page
 * number over a scanned page is far below either bound.
 */
const IMAGE_PAGE_NATIVE_WORD_MIN = 40;
const IMAGE_PAGE_NATIVE_CHARACTER_MIN = 250;
const LARGE_IMAGE_COVERAGE_MIN = 0.5;
/** Painted paths on a page with no text layer: outlined text or a drawn table. */
const VECTOR_CONTENT_OPERATOR_MIN = 50;

function nativeMetrics(page: PdfLayoutPage) {
  const tokens = page.lines.flatMap((line) => line.tokens);
  const text = tokens.map((token) => token.text.trim()).filter(Boolean).join(' ');
  return {
    tokenCount: tokens.length,
    wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
    characterCount: text.length,
    lineCount: page.lines.length,
  };
}

export function evaluatePageExtractionCoverage(params: {
  page: PdfLayoutPage;
  ocrEligible: boolean;
  expectedPricing: boolean;
}): PageExtractionCoverage {
  const metrics = nativeMetrics(params.page);
  const visual = params.page.visual_coverage ?? {
    image_operator_count: 0,
    approximate_image_coverage_ratio: 0,
  };
  const hasNative = metrics.tokenCount > 0;
  const meaningfulNative = metrics.characterCount >= MEANINGFUL_NATIVE_CHARACTER_MIN
    || metrics.wordCount >= MEANINGFUL_NATIVE_WORD_MIN;
  const imageBearing = visual.image_operator_count > 0;
  const largeImage = visual.approximate_image_coverage_ratio >= LARGE_IMAGE_COVERAGE_MIN;
  const vectorContent = (visual.vector_operator_count ?? 0) >= VECTOR_CONTENT_OPERATOR_MIN;
  // Native evidence covers the page when nothing visual could be carrying more
  // content than the text layer, or when the text layer is itself a body of
  // text over the image (a searchable scan).
  const nativeCoversPage = hasNative && (!largeImage
    || metrics.wordCount >= IMAGE_PAGE_NATIVE_WORD_MIN
    || metrics.characterCount >= IMAGE_PAGE_NATIVE_CHARACTER_MIN);
  const visualContentUncovered = hasNative
    ? !nativeCoversPage
    : imageBearing || vectorContent;
  // Operator guidance widens inspection: an expected pricing page is not
  // covered by a few native words. It never asserts that pricing exists.
  const expectedPricingUncovered = params.expectedPricing
    && !(nativeCoversPage && meaningfulNative);
  const requiresOcr = (params.ocrEligible || params.expectedPricing)
    && (visualContentUncovered || expectedPricingUncovered);
  const reasons: string[] = [];
  if (params.expectedPricing) reasons.push('operator_expected_pricing_evidence');
  if (!hasNative) reasons.push('native_text_absent');
  else if (!nativeCoversPage || !meaningfulNative) reasons.push('native_text_sparse');
  if (imageBearing) reasons.push(largeImage ? 'large_image_coverage' : 'image_content_present');
  if (!hasNative && vectorContent) reasons.push('vector_content_without_text_layer');

  let finalState: PageExtractionFinalState;
  if (requiresOcr) finalState = hasNative ? 'mixed_ocr_required' : 'ocr_required';
  else if (nativeCoversPage) finalState = 'native_complete';
  else if (!visualContentUncovered) finalState = params.expectedPricing ? 'uncertain' : 'empty_page';
  else {
    // Visual content exists, but OCR is not eligible for this document type.
    // The record stays explicit so absence is never inferred downstream.
    finalState = 'uncertain';
    reasons.push('ocr_not_eligible_for_document');
  }

  return {
    page_number: params.page.page_number,
    ...(params.page.effective_representation_digest
      ? { page_representation_digest: params.page.effective_representation_digest }
      : {}),
    expected_evidence_types: params.expectedPricing ? ['pricing'] : [],
    priority: params.expectedPricing,
    native: {
      state: hasNative ? 'produced' : 'abstained',
      token_count: metrics.tokenCount,
      word_count: metrics.wordCount,
      character_count: metrics.characterCount,
      line_count: metrics.lineCount,
    },
    visual: {
      state: imageBearing || vectorContent ? 'produced' : 'abstained',
      image_operator_count: visual.image_operator_count,
      approximate_image_coverage_ratio: visual.approximate_image_coverage_ratio,
      vector_operator_count: visual.vector_operator_count ?? 0,
    },
    ocr: { state: requiresOcr ? 'not_attempted' : 'not_eligible' },
    final_state: finalState,
    reasons,
  };
}

export function finalizePageExtractionCoverage(
  coverage: PageExtractionCoverage,
  outcome: 'produced' | 'abstained' | 'failed',
): PageExtractionCoverage {
  if (coverage.final_state !== 'ocr_required' && coverage.final_state !== 'mixed_ocr_required') {
    return coverage;
  }
  return {
    ...coverage,
    ocr: { state: outcome },
    final_state: outcome === 'produced' ? 'ocr_complete' : 'coverage_failed',
    reasons: outcome === 'produced'
      ? [...coverage.reasons, 'ocr_evidence_produced']
      : [...coverage.reasons, outcome === 'failed' ? 'ocr_failed' : 'ocr_abstained_without_evidence'],
  };
}

export function omittedPageCoverage(params: {
  pageNumber: number;
  expectedPricing: boolean;
}): PageExtractionCoverage {
  return {
    page_number: params.pageNumber,
    expected_evidence_types: params.expectedPricing ? ['pricing'] : [],
    priority: params.expectedPricing,
    native: { state: 'not_attempted', token_count: 0, word_count: 0, character_count: 0, line_count: 0 },
    visual: {
      state: 'not_attempted', image_operator_count: 0, approximate_image_coverage_ratio: 0,
      vector_operator_count: 0,
    },
    ocr: { state: 'not_attempted' },
    final_state: 'coverage_failed',
    reasons: ['page_skipped_due_evidence_limit'],
  };
}

/**
 * The exact pages OCR runs on: pages the preflight found incomplete and that
 * downstream layout actually carries, operator-expected pricing pages first,
 * then physical page order. A page outside the evidence selection is never
 * rendered, because nothing downstream could consume its OCR.
 */
export function selectPagesForOcr(
  coverages: Iterable<PageExtractionCoverage>,
): PageExtractionCoverage[] {
  return [...coverages]
    .filter((coverage) => coverage.final_state === 'ocr_required'
      || coverage.final_state === 'mixed_ocr_required')
    .sort((left, right) => Number(right.priority) - Number(left.priority)
      || left.page_number - right.page_number);
}

export function coverageAllowsRecovery(coverage: PageExtractionCoverage): boolean {
  return coverage.final_state === 'native_complete' || coverage.final_state === 'ocr_complete';
}
