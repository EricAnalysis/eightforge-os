import { describe, expect, it } from 'vitest';

import { categoryReviewTargets } from '@/lib/contracts/categoryReview';
import { assembleContractPricingRows } from '@/lib/contracts/contractPricingAssembly';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import type { PagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { reviewRequiredValueTargets } from '@/lib/humanFactAssertions/regionBoundAssertions';
import { buildResolutionActionRequest } from '@/lib/resolution/resolutionActionRequest';
import { buildResolutionQueue, type ResolutionCase } from '@/lib/resolution/resolutionCases';
import { ALLOWED_RATE_CATEGORIES } from '@/lib/validator/rateTaxonomy';

/**
 * Category review (Forgewing generalization). A priced row whose category
 * deterministic extraction refused to guess stays in front of a person; the
 * case never guesses, never changes the row, and never makes it pricing
 * authority. Synthetic rows only.
 */

const DOC = '00000000-0000-4000-8000-0000000000d1';
const DIGEST = 'e'.repeat(64);
type Source = 'pdfjs' | 'ocr_fallback';

function cell(role: string, id: string, text: string, x: number, y: number, source: Source) {
  return { role, raw_text: text, x_min: x, x_max: x + 40, y_min: y, y_max: y + 10,
    source_refs: [{ observation_id: id, text, x_min: x, x_max: x + 40, y_min: y, y_max: y + 10, source }] };
}
function row(index: number, description: string, unit: string, rate: string, rateSource: Source = 'pdfjs') {
  const y = 600 - index * 20;
  return { row_index: index, physical_page_number: 4, raw_text: `${description} | ${unit} | ${rate}`,
    x_min: 10, x_max: 300, y_min: y, y_max: y + 10,
    cells: [cell('description', `d${index}`, description, 10, y, 'pdfjs'), cell('unit', `u${index}`, unit, 120, y, 'pdfjs'),
      cell('rate', `r${index}`, rate, 220, y, rateSource)] };
}

function extraction(rows: ReturnType<typeof row>[]) {
  const reconstruction = { parser_version: 'priced_schedule_reconstruction_v3', pages: [{
    physical_page_number: 4, status: 'reconstructed', semantic_status: 'resolved', header_raw_text: 'Description Unit Rate',
    header_y: 620, columns: [], rejected_spines: [], unassigned_lines: [], rows }] } as unknown as PagePricedScheduleReconstruction;
  return { reconstruction, data: { extraction: { content_layers_v1: { pdf: {
    page_extraction_coverage_v1: { pages: [{ page_number: 4, page_representation_digest: DIGEST }] },
    priced_schedule_reconstruction_v1: reconstruction,
  } } } } };
}

const vegetative = () => row(0, 'Vegetative Collect, Remove & Haul ROW to DMS', 'Cubic Yard', '$8.50');
const uncategorised = () => row(1, 'Mobilization of crews', 'Lump Sum', '$1,200.00');
const scannedUncategorised = () => row(2, 'Permit fee', 'Lump Sum', '$95.00', 'ocr_fallback');

function queue(data: unknown, effectiveAnchors: string[] = []) {
  return buildResolutionQueue({
    projectId: 'p', documents: [{ id: DOC, title: 'Contract' }], issues: [], evidence: [], recoveryProposals: [],
    forgewingEnabled: false,
    reviewedValuesByDocument: new Map([[DOC, { history: [], held: [], entryTargets: [],
      effective: effectiveAnchors.map((anchorKey) => ({ anchorKey })) as never }]]),
    evidenceAttentionByDocument: new Map([[DOC, { diagnostics: [], withheldTargets: [],
      reviewRequiredTargets: reviewRequiredValueTargets(data, DOC), categoryReviewTargets: categoryReviewTargets(data, DOC) }]]),
  });
}
const enterOf = (entry: ResolutionCase) => entry.actions.find((action) => action.kind === 'enter_reviewed_value')!;

describe('category review', () => {
  it('1: keeps a native priced row with no category visible through a case, instead of a silent drop from pricing', () => {
    const { data, reconstruction } = extraction([vegetative(), uncategorised()]);
    // Pricing really does drop it today: no category, so no operator row.
    const priced = assembleContractPricingRows(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: reconstruction }));
    expect(priced.map((entry) => entry.description)).not.toContain('Mobilization of crews');

    const [target] = categoryReviewTargets(data, DOC);
    expect(target).toMatchObject({ reason: 'no_category_evidence', pricingState: 'excluded_from_pricing', rateWithheld: false,
      current: { description: 'Mobilization of crews', unit: 'Lump Sum', rate: 1200 }, sourceObservationIds: ['d1', 'u1', 'r1'],
      pageRepresentationDigest: DIGEST, physicalPageNumber: 4 });
    const cases = queue(data).cases;
    expect(cases.map((entry) => entry.kind)).toEqual(['category_review']);
    expect(cases[0]).toMatchObject({ tier: 'missing_authoritative_value', originalSourceText: 'Mobilization of crews | Lump Sum | $1,200.00' });
    expect(cases[0]!.actions.map((action) => action.kind)).toEqual(['enter_reviewed_value', 'record_disposition', 'open_document']);
  });

  it('confirms a category only through the typed reviewed row, from the allowed categories, chosen by a person', () => {
    const { data } = extraction([uncategorised()]);
    const [entry] = queue(data).cases;
    const enter = enterOf(entry!);
    expect(enter.kind === 'enter_reviewed_value' && enter.category).toEqual({ required: true, options: ALLOWED_RATE_CATEGORIES });
    expect(enter.kind === 'enter_reviewed_value' && enter.currentValue).toEqual({ description: 'Mobilization of crews', unitType: 'Lump Sum', rate: 1200 });
    const value = { description: 'Mobilization of crews', unitType: 'Lump Sum', rate: '1200.00' };
    expect(buildResolutionActionRequest(entry!, { kind: 'enter_reviewed_value', value, reason: 'Printed in section 2', idempotencyKey: 'k' }))
      .toEqual({ ok: false, reason: 'Choose the category this row belongs to.' });
    expect(buildResolutionActionRequest(entry!, { kind: 'enter_reviewed_value', value: { ...value, category: 'C&D' },
      reason: 'r', idempotencyKey: 'k' }).ok).toBe(false);
    const saved = buildResolutionActionRequest(entry!, { kind: 'enter_reviewed_value', value: { ...value, category: 'Personnel' },
      reason: 'Crew mobilization is personnel', idempotencyKey: 'k' });
    expect(saved.ok && saved.request.body).toMatchObject({ factKey: 'contract_rate_row', anchorKey: enter.target.anchorKey,
      value: { description: 'Mobilization of crews', unit_type: 'Lump Sum', rate_amount: 1200, category: 'Personnel' } });
  });

  it('2: does not open a second case for a scanned row with no category: its value case also requires the category', () => {
    const { data } = extraction([scannedUncategorised()]);
    expect(categoryReviewTargets(data, DOC)).toMatchObject([{ rateWithheld: true }]);
    const cases = queue(data).cases;
    expect(cases.map((entry) => entry.kind)).toEqual(['review_required_value']);
    expect(cases[0]!.alsoUnresolved).toEqual(['category']);
    expect(cases[0]!.problem).toContain('category is also unresolved');
    const enter = enterOf(cases[0]!);
    expect(enter.kind === 'enter_reviewed_value' && enter.category?.required).toBe(true);
  });

  it('3: lets distinct unresolved facts of different rows coexist, one case per row decision', () => {
    const { data } = extraction([vegetative(), uncategorised(), scannedUncategorised()]);
    const cases = queue(data).cases;
    expect(cases.map((entry) => [entry.kind, entry.alsoUnresolved ?? []]).sort()).toEqual([
      ['category_review', []], ['review_required_value', ['category']]]);
    const anchors = cases.map((entry) => entry.sourceRefs.anchorKey);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('4: needs no category inference: a row naming no category word is reviewed, not guessed', () => {
    const { data } = extraction([row(0, 'Item C-14 allowance', 'Each', '$450.00')]);
    const [target] = categoryReviewTargets(data, DOC);
    expect(target?.reason).toBe('no_category_evidence');
  });

  it('5: leaves rows with a valid category unchanged and opens nothing for them', () => {
    const { data, reconstruction } = extraction([vegetative()]);
    expect(categoryReviewTargets(data, DOC)).toEqual([]);
    expect(queue(data).cases).toEqual([]);
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: reconstruction });
    expect(assembleContractPricingRows(rows).map((entry) => [entry.category, entry.rate]))
      .toEqual([['Vegetative Collect, Remove & Haul', 8.5]]);
  });

  it('6: never makes a row pricing authority: rows and pricing are identical with or without the case', () => {
    const { data, reconstruction } = extraction([vegetative(), uncategorised()]);
    const before = JSON.stringify(assembleContractPricingRows(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: reconstruction })));
    expect(queue(data).cases).toHaveLength(1);
    const after = JSON.stringify(assembleContractPricingRows(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: reconstruction })));
    expect(after).toBe(before);
    // The case closes only on a person's effective review of that exact row.
    const anchor = categoryReviewTargets(data, DOC)[0]!.anchorKey;
    expect(queue(data, [anchor]).cases).toEqual([]);
  });
});
