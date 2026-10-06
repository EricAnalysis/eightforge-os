import { describe, expect, it } from 'vitest';

import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import type { PdfLayout, PdfLayoutLine, PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import {
  reviewRequiredValueTargets,
  withheldPricedLineTargets,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import { buildResolutionQueue, type AttentionDiagnostic } from '@/lib/resolution/resolutionCases';
import { extractionDocumentDiagnostics } from '@/lib/server/documentDiagnosticsRead';

/**
 * v4 integration with the generalized evidence-attention path (Forgewing
 * generalization phases 1-2). The shape of Golden p10 under fixed v4, built by
 * the real reconstruction from synthetic tokens: a native top segment, and a
 * scanned bottom segment that admits rows and rejects bundles for
 * ambiguous_rate_clusters and ambiguous_row_continuation. Every rejected
 * bundle must reach a withheld-line case through the shared selector, and
 * every admitted scanned rate a review-required case, with no priced-schedule
 * specific selector or queue. Synthetic tokens only.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const ARTIFACT = '00000000-0000-4000-8000-0000000000f1';
const DIGEST = 'c'.repeat(64);
type Source = 'pdfjs' | 'ocr_fallback';
type Spec = { x: number; text: string; width?: number };

function line(y: number, specs: readonly Spec[], source: Source): PdfLayoutLine {
  const tokens: PdfToken[] = specs.map((spec, index) => ({
    text: spec.text, x: spec.x, y, width: spec.width ?? Math.max(8, spec.text.length * 5), height: 10, source,
    observation_id: `obs:p10:${y}:${index}` as PdfToken['observation_id'],
  }));
  return { id: `line:p10:y${y}`, page_number: 10, text: tokens.map((t) => t.text).join(' '), tokens, kind: 'table_candidate',
    x_min: Math.min(...tokens.map((t) => t.x)), x_max: Math.max(...tokens.map((t) => t.x + t.width)), y };
}
const header = (y: number, source: Source) => line(y, [
  { x: 50, text: 'Description', width: 70 }, { x: 200, text: 'Unit', width: 30 }, { x: 450, text: 'Unit Price', width: 60 }], source);
const row = (y: number, description: string, unit: string, amounts: string[], source: Source) => line(y, [
  { x: 50, text: description, width: 100 }, { x: 200, text: unit, width: 30 },
  ...amounts.flatMap((amount, index) => [{ x: 450 + index * 70, text: '$', width: 8 }, { x: 465 + index * 70, text: amount, width: 40 }]),
], source);

const lines = [
  header(720, 'pdfjs'),
  row(700, 'Alpha service', 'Ton', ['1.00'], 'pdfjs'),
  row(680, 'Beta service', 'Ton', ['2.00'], 'pdfjs'),
  header(600, 'ocr_fallback'),
  row(580, 'Gamma service', 'Load', ['3.00'], 'ocr_fallback'),
  row(560, 'Delta service', 'Load', ['4.00'], 'ocr_fallback'),
  row(540, 'Epsilon service', 'Load', ['5.00', '5.50'], 'ocr_fallback'),
  row(520, 'Zeta service', 'Load', ['6.00'], 'ocr_fallback'),
  line(510, [{ x: 50, text: 'orphan fragment', width: 100 }], 'ocr_fallback'),
  row(500, 'Eta service', 'Load', ['7.00'], 'ocr_fallback'),
  row(480, 'Theta service', 'Load', ['8.00'], 'ocr_fallback'),
];

function extraction() {
  const page: PdfLayoutPage = { page_number: 10, width: 612, height: 792, lines };
  const layout: PdfLayout = { page_count: 10, gaps: [], pages: [page] };
  const reconstruction = buildPagePricedScheduleReconstruction({ layout });
  const observations = lines.flatMap((entry) => entry.tokens.map((token) => ({
    id: String(token.observation_id), physical_page_number: 10, raw_text: token.text, source_method: token.source,
    metadata: { page_representation_digest: DIGEST },
  })));
  return { reconstruction, data: { extraction: { content_layers_v1: { pdf: {
    page_extraction_coverage_v1: { pages: [{ page_number: 10, page_representation_digest: DIGEST }] },
    layout_observations_v1: { source_artifact_id: ARTIFACT, observations },
    priced_schedule_reconstruction_v1: reconstruction,
  } } } } };
}

function attentionOf(data: Record<string, unknown>): AttentionDiagnostic[] {
  return extractionDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC, extraction: data,
    extractionSnapshotId: '00000000-0000-4000-8000-0000000000e1', occurredAt: '2026-10-06T00:00:00.000Z' })
    .map((diagnostic) => ({
      diagnosticId: diagnostic.diagnosticId, code: diagnostic.code, attention: diagnostic.attention,
      recoverability: diagnostic.recoverability, recoveryType: diagnostic.recoveryType, severity: diagnostic.severity,
      summary: diagnostic.summary, physicalPageNumber: diagnostic.scope.physicalPageNumber,
      observationIds: diagnostic.evidenceRefs.flatMap((ref) => (ref.kind === 'observation' ? [ref.observationId] : [])),
      visual: null, recoveryProposalId: diagnostic.recoveryProposalId,
    }));
}

describe('v4 table segments reach the generalized evidence-attention path', () => {
  it('reconstructs the Golden p10 shape: a scanned segment that admits rows and rejects bundles', () => {
    const { reconstruction } = extraction();
    expect(reconstruction.parser_version).toBe('priced_schedule_reconstruction_v4');
    expect(reconstruction.pages.map((page) => page.table_segment?.segment_index)).toEqual([0, 1]);
    expect(reconstruction.pages[1]!.rejected_spines.map((spine) => spine.reason)).toEqual(
      ['ambiguous_rate_clusters', 'ambiguous_row_continuation', 'ambiguous_row_continuation']);
  });

  it('gives every rejected bundle a withheld-line case, and every admitted scanned rate a review-required case', () => {
    const { data, reconstruction } = extraction();
    const withheld = withheldPricedLineTargets(data, DOC);
    expect(withheld.map((target) => [target.unresolvedReason, target.rawText])).toEqual(
      reconstruction.pages[1]!.rejected_spines.map((spine) => [spine.reason, spine.raw_text]));
    const scanned = reviewRequiredValueTargets(data, DOC);
    // The admitted bottom-segment rows were read from the scan; the native top segment needs no review.
    expect(scanned.map((target) => [target.basis, target.candidateRateRaw])).toEqual(
      reconstruction.pages[1]!.rows.map((row) => ['scanned_source', row.cells.find((cell) => cell.role === 'rate')!.raw_text]));

    const queue = buildResolutionQueue({
      projectId: 'p', documents: [{ id: DOC, title: 'Contract' }], issues: [], evidence: [], recoveryProposals: [],
      forgewingEnabled: false,
      reviewedValuesByDocument: new Map([[DOC, { history: [], effective: [], held: [], entryTargets: [] }]]),
      evidenceAttentionByDocument: new Map([[DOC, { diagnostics: attentionOf(data), withheldTargets: withheld,
        reviewRequiredTargets: scanned }]]),
    });
    const byKind = (kind: string) => queue.cases.filter((entry) => entry.kind === kind);
    expect(byKind('withheld_priced_line').map((entry) => entry.diagnostic?.code).sort()).toEqual(
      ['ambiguous_rate_clusters', 'ambiguous_row_continuation', 'ambiguous_row_continuation']);
    // Every withheld bundle binds to its exact observations, so a person can review its value.
    for (const entry of byKind('withheld_priced_line')) {
      expect(entry.actions.map((action) => action.kind)).toEqual(['enter_reviewed_value', 'record_disposition', 'open_document']);
    }
    expect(byKind('review_required_value')).toHaveLength(reconstruction.pages[1]!.rows.length);
    // The same observations never appear twice: a rejected bundle is not also a review-required row.
    const anchors = queue.cases.flatMap((entry) => entry.sourceRefs.anchorKey ? [entry.sourceRefs.anchorKey] : []);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('keeps every scanned rate out of pricing even with a complete unit: missing unit is not the only protection', () => {
    const { reconstruction } = extraction();
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: reconstruction });
    const scanned = rows.filter((row) => row.rate_authority?.status === 'review_required');
    expect(scanned.length).toBe(reconstruction.pages[1]!.rows.length);
    expect(scanned.every((row) => row.unit === 'Load' && row.rate == null && row.rate_amount == null
      && row.confidence === 'needs_review')).toBe(true);
    // Native rows are unchanged.
    expect(rows.filter((row) => row.unit === 'Ton').map((row) => row.rate)).toEqual([1, 2]);
  });
});
