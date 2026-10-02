import { describe, expect, it } from 'vitest';
import type { PdfLayout, PdfToken } from './extractText';
import { buildHeaderRoleSelectionCandidates, buildPagePricedScheduleReconstruction } from './pagePricedScheduleReconstruction';
import { pricingAuthoritativePage } from './pricedScheduleAuthority';
import { buildRecoveryCandidateV2 } from '../recovery/recoveryCandidateV2';
import { buildContractRateScheduleRows, buildContractRateScheduleRowsWithDiagnostics } from '@/lib/contracts/contractRateScheduleRows';

const context = { sourceDocumentId: '11111111-1111-4111-8111-111111111111',
  sourceArtifactId: '22222222-2222-4222-8222-222222222222', pageRepresentationDigestByPage: { 7: 'a'.repeat(64) } };
const reviewId = '33333333-3333-4333-8333-333333333333';
const currentPageEvidence = { 7: { pageRepresentationDigest: 'a'.repeat(64), recoveryAllowed: true } };
function layout(resolved = false): PdfLayout {
  const specs: [number, [number, string, number][]][] = [
    [700, [[50, resolved ? 'Item' : 'Equipment', 45], [99, 'Description', 55], [200, 'Unit', 20], [440, 'Unit', 20], [463, 'Price', 25]]],
    [680, [[50, 'Alpha service', 80], [200, 'Widget', 30], [445, '$12.00', 35]]],
    [660, [[50, 'Beta service', 80], [200, 'Widget', 30], [445, '$3.50', 30]]],
  ];
  return { page_count: 7, gaps: [], pages: [{ page_number: 7, width: 612, height: 792,
    lines: specs.map(([y, entries]) => {
      const tokens = entries.map(([x, text, width], i): PdfToken => ({ text, x, y, width, height: 10,
        source: 'pdfjs', observation_id: `obs:${y}:${i}` as PdfToken['observation_id'] }));
      return { id: `line:${y}`, page_number: 7, y, text: tokens.map(t => t.text).join(' '),
        kind: 'table_candidate', x_min: 50, x_max: 490, tokens };
    }) }] };
}
function base() { return buildPagePricedScheduleReconstruction({ layout: layout(), recoveryCandidateBuildContext: context }); }
function reenter(candidate = base().recovery_candidates![0]!, options: Partial<Parameters<typeof buildPagePricedScheduleReconstruction>[0]> = {}) {
  return buildPagePricedScheduleReconstruction({ layout: layout(), currentPageEvidence,
    confirmedHeaderSelections: [{ candidate, reviewId }], ...options });
}

describe('preserved header role selection', () => {
  it('offers only qualifying v2 role maps with bound header evidence and row count', () => {
    const result = base();
    expect(result.pages[0]?.semantic_status).toBe('unresolved');
    expect(result.recovery_candidates).toHaveLength(1);
    expect(result.recovery_candidates![0]!.headerRoleSelection).toMatchObject({
      parserVersion: 'priced_schedule_reconstruction_v2', structuralRowCount: 2,
      labels: [{ text: 'Equipment Description', role: 'description' }, { text: 'Unit', role: 'unit' }, { text: 'Unit Price', role: 'rate' }],
    });
    expect(buildHeaderRoleSelectionCandidates({ ...result, parser_version: 'priced_schedule_reconstruction_v1' }, context)).toEqual([]);
    const page = result.pages[0]!;
    for (const changed of [
      { ...page, columns: [] },
      { ...page, header_interpretation: { ...page.header_interpretation!, options_limit_exceeded: true } },
      { ...page, header_interpretation: { ...page.header_interpretation!, options: page.header_interpretation!.options!.map(o => ({ ...o, kind: 'label_grouping' as const })) } },
      { ...page, header_interpretation: { ...page.header_interpretation!, options: page.header_interpretation!.options!.map(o => ({ ...o, qualifies: false })) } },
    ]) expect(buildHeaderRoleSelectionCandidates({ ...result, pages: [changed] }, context)).toEqual([]);
    expect(buildPagePricedScheduleReconstruction({ layout: layout(), continuationEvidence: 'spacing_only', recoveryCandidateBuildContext: context }).recovery_candidates).toEqual([]);
  });

  it('applies a receipt through normal admission, preserving original interpretation and authored values', () => {
    const before = base();
    const after = reenter();
    expect(after.pages[0]?.header_interpretation).toEqual(before.pages[0]?.header_interpretation);
    expect(after.pages[0]?.semantic_status).toBeUndefined();
    expect(after.pages[0]?.header_semantics).toEqual({ status: 'human_selected', candidate_id: before.recovery_candidates![0]!.candidateId, review_id: reviewId });
    expect(after.pages[0]?.rows).toHaveLength(2);
    expect(after.pages[0]?.rows.map(row => row.header_semantics)).toEqual([after.pages[0]?.header_semantics, after.pages[0]?.header_semantics]);
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: after });
    expect(rows.map(row => [row.description, row.unit, row.rate])).toEqual([['Alpha service', 'Widget', 12], ['Beta service', 'Widget', 3.5]]);
    expect(rows.map(row => row.header_semantics)).toEqual([after.pages[0]?.header_semantics, after.pages[0]?.header_semantics]);
    expect(after.recovery_diagnostics).toEqual([]);
  });

  it('does not change no-confirmation output and does not accept a candidate without its review receipt', () => {
    const params = { layout: layout() };
    expect(buildPagePricedScheduleReconstruction({ ...params, confirmedHeaderSelections: [] })).toEqual(buildPagePricedScheduleReconstruction(params));
    const result = buildPagePricedScheduleReconstruction({ ...params, currentPageEvidence,
      confirmedRecoveryCandidates: base().recovery_candidates });
    expect(result.pages[0]?.semantic_status).toBe('unresolved');
    expect(result.recovery_diagnostics?.[0]?.reason).toBe('confirmed_recovery_not_applied');
  });

  it('rejects invalid receipts, missing pages and altered evidence even when candidate identity is unchanged', () => {
    const candidate = base().recovery_candidates![0]!;
    expect(reenter(candidate, { confirmedHeaderSelections: [{ candidate, reviewId: 'not-a-review' }] }).recovery_diagnostics)
      .toMatchObject([{ reason: 'confirmed_recovery_not_applied' }]);
    expect(reenter(candidate, { layout: { page_count: 7, gaps: [], pages: [] } }).recovery_diagnostics)
      .toMatchObject([{ reason: 'confirmed_recovery_unbound', physical_page_number: null }]);
    const altered = { ...candidate, evidence: candidate.evidence.map((e, i) => i ? e : { ...e, boundingBox: { ...e.boundingBox, xMin: -10 } }) };
    expect(reenter(altered).recovery_diagnostics).toMatchObject([{ reason: 'confirmed_header_option_not_offered' }]);
  });

  it('retains header provenance through authority projection and still withholds malformed ruling authority', () => {
    const after = reenter(), page = after.pages[0]!;
    expect(pricingAuthoritativePage(page, after.parser_version)?.rows[0]?.header_semantics).toEqual(page.header_semantics);
    const corrupt = { ...after, pages: [{ ...page, ruling_line_resolution_digest: 'f'.repeat(64) }] };
    const output = buildContractRateScheduleRowsWithDiagnostics({ rateTable: null, pricedScheduleReconstruction: corrupt });
    expect(output.rows).toEqual([]);
    expect(output.diagnostics).toMatchObject([{ code: 'ruling_line_pricing_authority_withheld', issue: 'missing_ruling_evidence' }]);
  });

  it('withholds stale or untrusted evidence', () => {
    expect(reenter(undefined, { currentPageEvidence: { 7: { ...currentPageEvidence[7], pageRepresentationDigest: 'b'.repeat(64) } } }).recovery_diagnostics)
      .toMatchObject([{ reason: 'confirmed_recovery_evidence_changed' }]);
    expect(reenter(undefined, { currentPageEvidence: { 7: { ...currentPageEvidence[7], recoveryAllowed: false } } }).recovery_diagnostics)
      .toMatchObject([{ reason: 'confirmed_recovery_not_applied', blocked_by: 'coverage_not_trusted' }]);
  });

  it('withholds changed/removed options, resolved pages and conflicting confirmations', () => {
    const original = base().recovery_candidates![0]!;
    const changed = buildRecoveryCandidateV2({ ...original, headerRoleSelection: { ...original.headerRoleSelection!, optionId: 'removed-option' } })!;
    expect(reenter(changed).recovery_diagnostics).toMatchObject([{ reason: 'confirmed_header_option_not_offered' }]);
    const changedMap = buildRecoveryCandidateV2({ ...original, headerRoleSelection: { ...original.headerRoleSelection!,
      labels: original.headerRoleSelection!.labels.map((l, i) => i === 1 ? { ...l, role: 'origin_destination' as const } : l) } })!;
    expect(reenter(changedMap).recovery_diagnostics).toMatchObject([{ reason: 'confirmed_header_option_not_offered' }]);
    expect(reenter(original, { layout: layout(true) }).recovery_diagnostics).toMatchObject([{ reason: 'confirmed_header_option_not_offered' }]);
    const conflict = reenter(original, { confirmedHeaderSelections: [{ candidate: original, reviewId }, { candidate: changed, reviewId }] });
    expect(conflict.pages[0]?.semantic_status).toBe('unresolved');
    expect(conflict.recovery_diagnostics?.map(d => d.reason)).toEqual(['ambiguous_recovery_confirmation', 'ambiguous_recovery_confirmation']);
  });
});
