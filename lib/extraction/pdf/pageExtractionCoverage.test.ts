import { describe, expect, it } from 'vitest';

import {
  coverageAllowsRecovery,
  evaluatePageExtractionCoverage,
  finalizePageExtractionCoverage,
  omittedPageCoverage,
  selectPagesForOcr,
} from '@/lib/extraction/pdf/pageExtractionCoverage';
import type { PdfLayoutPage } from '@/lib/extraction/pdf/extractText';

function page(params: {
  tokens?: string[];
  imageCoverage?: number;
  imageCount?: number;
  vectorCount?: number;
}): PdfLayoutPage {
  const tokens = params.tokens ?? [];
  return {
    page_number: 1, width: 612, height: 792,
    visual_coverage: {
      image_operator_count: params.imageCount ?? (params.imageCoverage ? 1 : 0),
      approximate_image_coverage_ratio: params.imageCoverage ?? 0,
      vector_operator_count: params.vectorCount ?? 0,
    },
    lines: tokens.length ? [{
      id: 'line', page_number: 1, text: tokens.join(' '), kind: 'text', x_min: 10, x_max: 50, y: 700,
      tokens: tokens.map((text, index) => ({ text, x: 10 + index * 20, y: 700, width: 10, height: 10 })),
    }] : [],
  };
}

describe('page extraction coverage', () => {
  it('keeps a meaningful native page native-only despite an insignificant image', () => {
    const coverage = evaluatePageExtractionCoverage({
      page: page({ tokens: Array.from({ length: 14 }, (_, index) => `word${index}`), imageCoverage: 0.01 }),
      ocrEligible: true, expectedPricing: false,
    });
    expect(coverage.final_state).toBe('native_complete');
    expect(coverage.ocr.state).toBe('not_eligible');
  });

  it('requires OCR for an image-only page and a sparse native stamp over a large image', () => {
    expect(evaluatePageExtractionCoverage({
      page: page({ imageCoverage: 0.95 }), ocrEligible: true, expectedPricing: false,
    }).final_state).toBe('ocr_required');
    expect(evaluatePageExtractionCoverage({
      page: page({ tokens: ['DocuSign'], imageCoverage: 0.95 }), ocrEligible: true, expectedPricing: false,
    }).final_state).toBe('mixed_ocr_required');
  });

  it('does not let a header, footer, page number and stamp cover a scanned page', () => {
    const coverage = evaluatePageExtractionCoverage({
      page: page({
        tokens: ['Docusign', 'Envelope', 'ID:', 'C245A383', 'Page', '12', 'of', '49'],
        imageCoverage: 1,
      }),
      ocrEligible: true, expectedPricing: false,
    });
    expect(coverage.final_state).toBe('mixed_ocr_required');
    expect(coverage.reasons).toContain('native_text_sparse');
  });

  it('treats a searchable scan with a body of native text as native-complete', () => {
    const coverage = evaluatePageExtractionCoverage({
      page: page({ tokens: Array.from({ length: 60 }, (_, index) => `word${index}`), imageCoverage: 1 }),
      ocrEligible: true, expectedPricing: false,
    });
    expect(coverage.final_state).toBe('native_complete');
    expect(coverage.ocr.state).toBe('not_eligible');
  });

  it('requires OCR for vector-drawn content with no text layer, and not for a blank page', () => {
    expect(evaluatePageExtractionCoverage({
      page: page({ vectorCount: 400 }), ocrEligible: true, expectedPricing: false,
    }).final_state).toBe('ocr_required');
    expect(evaluatePageExtractionCoverage({
      page: page({ vectorCount: 3 }), ocrEligible: true, expectedPricing: false,
    }).final_state).toBe('empty_page');
  });

  it('records uncovered visual content explicitly when OCR is not eligible', () => {
    const coverage = evaluatePageExtractionCoverage({
      page: page({ imageCoverage: 1 }), ocrEligible: false, expectedPricing: false,
    });
    expect(coverage.final_state).toBe('uncertain');
    expect(coverage.ocr.state).toBe('not_eligible');
    expect(coverage.reasons).toContain('ocr_not_eligible_for_document');
    expect(coverageAllowsRecovery(coverage)).toBe(false);
  });

  it('uses operator pricing pages only as priority coverage guidance', () => {
    const coverage = evaluatePageExtractionCoverage({
      page: page({ tokens: ['Page', '107'] }), ocrEligible: true, expectedPricing: true,
    });
    expect(coverage.priority).toBe(true);
    expect(coverage.expected_evidence_types).toEqual(['pricing']);
    expect(coverage.final_state).toBe('mixed_ocr_required');
  });

  it('orders operator-expected pricing pages first and never selects a page outside the evidence selection', () => {
    const scanned = (pageNumber: number, expectedPricing: boolean) => evaluatePageExtractionCoverage({
      page: { ...page({ imageCoverage: 1 }), page_number: pageNumber }, ocrEligible: true, expectedPricing,
    });
    const selected = selectPagesForOcr([
      scanned(3, false),
      evaluatePageExtractionCoverage({
        page: { ...page({ tokens: Array.from({ length: 30 }, (_, index) => `w${index}`) }), page_number: 4 },
        ocrEligible: true, expectedPricing: false,
      }),
      scanned(9, true),
      omittedPageCoverage({ pageNumber: 220, expectedPricing: false }),
      scanned(1, false),
      scanned(7, true),
    ]);
    expect(selected.map((coverage) => coverage.page_number)).toEqual([7, 9, 1, 3]);
  });

  it('records operator guidance as inspection scope only, never as evidence', () => {
    const coverage = evaluatePageExtractionCoverage({
      page: page({}), ocrEligible: true, expectedPricing: true,
    });
    // An expected pricing page with no native text is not "complete" because
    // the operator named it: it requires OCR, stays non-recoverable until OCR
    // produces evidence, and the record carries no rate, row or value.
    expect(coverage.final_state).toBe('ocr_required');
    expect(coverageAllowsRecovery(coverage)).toBe(false);
    expect(coverageAllowsRecovery(finalizePageExtractionCoverage(coverage, 'abstained'))).toBe(false);
    expect(Object.keys(coverage).sort()).toEqual([
      'expected_evidence_types', 'final_state', 'native', 'ocr', 'page_number', 'priority',
      'reasons', 'visual',
    ]);
  });

  it('blocks recovery until required OCR produces evidence', () => {
    const required = evaluatePageExtractionCoverage({
      page: page({ imageCoverage: 1 }), ocrEligible: true, expectedPricing: true,
    });
    expect(coverageAllowsRecovery(required)).toBe(false);
    expect(coverageAllowsRecovery(finalizePageExtractionCoverage(required, 'failed'))).toBe(false);
    expect(coverageAllowsRecovery(finalizePageExtractionCoverage(required, 'produced'))).toBe(true);
  });
});
