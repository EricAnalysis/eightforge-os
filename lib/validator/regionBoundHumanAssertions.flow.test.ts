import { describe, expect, it } from 'vitest';

import { adaptAssembledPricingRows } from '@/lib/canonical/contract/pricingAdapter';
import { buildCanonicalPricingSchedule, resolveCanonicalPricingRow } from '@/lib/canonical/contract/pricingResolution';
import { projectCanonicalRateScheduleItems } from '@/lib/canonical/authority/canonicalValidatorProjection';
import {
  CONTRACT_RATE_ROW_FACT_KEY,
  describeHumanReviewedValue,
  resolveRegionBoundAssertions,
  reviewedContractPricingRows,
  type HumanFactAssertionRow,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  buildFactsByDocumentId,
  buildInvoiceLineToRateMap,
  buildRateScheduleItems,
  labelHumanReviewedRateEvidence,
  resolveRegionAssertionsForSnapshot,
} from '@/lib/validator/projectValidator';
import type { ValidatorDocumentRow, ValidatorLegacyExtractionRow } from '@/lib/validator/shared';

/**
 * Forgewing resolution layer B3. A region-bound human-reviewed value is found
 * against the current extraction (upstream), and reaches the Validator's facts,
 * legacy pricing, canonical truth and invoice matching with its human-reviewed
 * provenance intact (downstream). Every fixture is synthetic.
 */

const ORG = 'org-b3';
const CONTRACT = 'contract-b3';
const INVOICE = 'invoice-b3';
const PAGE = 8;
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

let sequence = 0;
function assertion(overrides: Partial<HumanFactAssertionRow> = {}): HumanFactAssertionRow {
  sequence += 1;
  return {
    id: `assertion-${String(sequence).padStart(3, '0')}`,
    organization_id: ORG,
    source_document_id: CONTRACT,
    fact_key: CONTRACT_RATE_ROW_FACT_KEY,
    asserted_value: { description: 'Debris removal', unit_type: 'CY', rate_amount: 14.5 },
    source_binding: 'region_bound',
    supersedes_assertion_id: null,
    actor_id: 'operator-1',
    reason: 'Rate cell OCR damaged; value read from source',
    asserted_at: `2026-10-04T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    status: 'active',
    source_artifact_id: 'artifact-b3',
    physical_page_number: PAGE,
    source_region: { coordinate_space: 'source', boxes: [{ x_min: 440, x_max: 520, y_min: 300, y_max: 312 }] },
    page_representation_digest: DIGEST,
    parser_version: 'priced_schedule_reconstruction_v2',
    source_observation_ids: ['obs-unpriced-1', 'obs-unpriced-2'],
    original_source_text: 'sia 50',
    anchor_key: 'p8:line:300',
    review_origin: 'operator_entered',
    forgewing_proposal_id: null,
    ...overrides,
  };
}

/** The persisted extraction blob, as the Validator already loads it. */
function extraction(documentId: string, digest: string | null): ValidatorLegacyExtractionRow {
  return {
    document_id: documentId,
    created_at: '2026-10-04T10:00:00.000Z',
    data: {
      extraction: {
        content_layers_v1: {
          pdf: {
            page_extraction_coverage_v1: {
              pages: digest ? [{ page_number: PAGE, page_representation_digest: digest }] : [],
            },
            priced_schedule_reconstruction_v1: {
              parser_version: 'priced_schedule_reconstruction_v2',
              pages: [{
                physical_page_number: PAGE, header_raw_text: 'Description Unit Rate', header_y: 700,
                columns: [], rejected_spines: [], unassigned_lines: [],
                rows: [{
                  row_index: 0, physical_page_number: PAGE, raw_text: 'Hauling | TON | $8.75',
                  x_min: 50, x_max: 520, y_min: 600, y_max: 612,
                  cells: [{ role: 'rate', raw_text: '$8.75', x_min: 450, x_max: 520, y_min: 600, y_max: 612,
                    source_refs: [{ observation_id: 'obs-priced', text: '$8.75', x_min: 450, x_max: 520, y_min: 600, y_max: 612 }] }],
                }],
              }],
            },
          },
        },
      },
    },
  };
}

function currentFor(digest: string | null) {
  return new Map([[CONTRACT, extraction(CONTRACT, digest)]]);
}

const DOCUMENTS: ValidatorDocumentRow[] = [
  { id: CONTRACT, project_id: 'project-b3', organization_id: ORG, title: 'Contract', name: 'contract.pdf',
    document_type: 'contract', created_at: '2026-10-01T00:00:00.000Z' },
  { id: INVOICE, project_id: 'project-b3', organization_id: ORG, title: 'Invoice', name: 'invoice.pdf',
    document_type: 'invoice', created_at: '2026-10-01T00:00:00.000Z' },
];

describe('B3 upstream: region-bound assertions against the current extraction', () => {
  it('is found when the reviewed page representation is unchanged after reprocessing', () => {
    const row = assertion();
    const result = resolveRegionAssertionsForSnapshot({ rows: [row], legacyRowsByDocumentId: currentFor(DIGEST) });
    expect(result.held).toEqual([]);
    expect(result.effective).toHaveLength(1);
    expect(result.effective[0]!.provenance).toMatchObject({
      authority: 'human_reviewed', assertionId: row.id, physicalPageNumber: PAGE,
      originalSourceText: 'sia 50', reviewOrigin: 'operator_entered', chainAssertionIds: [row.id],
    });
  });

  it('fails closed when the page representation changed: held for re-review, never reapplied', () => {
    const row = assertion();
    const result = resolveRegionAssertionsForSnapshot({ rows: [row], legacyRowsByDocumentId: currentFor(OTHER_DIGEST) });
    expect(result.effective).toEqual([]);
    expect(result.held).toMatchObject([{ reason: 'page_representation_changed', assertionIds: [row.id] }]);
  });

  it('fails closed when the current page representation is unknown', () => {
    const result = resolveRegionAssertionsForSnapshot({ rows: [assertion()], legacyRowsByDocumentId: currentFor(null) });
    expect(result.effective).toEqual([]);
    expect(result.held[0]!.reason).toBe('page_representation_unverifiable');
  });

  it('applies a re-review made against the new representation, keeping the old one as history', () => {
    const first = assertion();
    const rereview = assertion({ supersedes_assertion_id: first.id, page_representation_digest: OTHER_DIGEST,
      asserted_value: { description: 'Debris removal', unit_type: 'CY', rate_amount: 14.75 } });
    const result = resolveRegionAssertionsForSnapshot({
      rows: [rereview, first], legacyRowsByDocumentId: currentFor(OTHER_DIGEST),
    });
    expect(result.held).toEqual([]);
    expect(result.effective[0]!.value).toMatchObject({ rate_amount: 14.75 });
    expect(result.effective[0]!.provenance.chainAssertionIds).toEqual([first.id, rereview.id]);
  });

  it('never makes a superseded or withdrawn assertion canonical, and deletes no history', () => {
    const first = assertion();
    const withdrawal = assertion({ supersedes_assertion_id: first.id, status: 'withdrawn', asserted_value: null });
    const rows = [first, withdrawal];
    const result = resolveRegionAssertionsForSnapshot({ rows, legacyRowsByDocumentId: currentFor(DIGEST) });
    expect(result.effective).toEqual([]);
    expect(result.held).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it('fails closed on competing active assertions for one target', () => {
    const left = assertion();
    const right = assertion({ asserted_value: { description: 'Debris removal', unit_type: 'CY', rate_amount: 99 } });
    const result = resolveRegionAssertionsForSnapshot({ rows: [left, right], legacyRowsByDocumentId: currentFor(DIGEST) });
    expect(result.effective).toEqual([]);
    expect(result.held).toMatchObject([{ reason: 'ambiguous_competing_assertions', assertionIds: [left.id, right.id] }]);
  });

  it('fails closed when two reviewed rows claim the same source observation', () => {
    const left = assertion({ anchor_key: 'p8:line:300' });
    const right = assertion({ anchor_key: 'p8:line:301', source_observation_ids: ['obs-unpriced-2'] });
    const result = resolveRegionAssertionsForSnapshot({ rows: [left, right], legacyRowsByDocumentId: currentFor(DIGEST) });
    expect(result.effective).toEqual([]);
    expect(result.held.map((entry) => entry.reason)).toEqual(['ambiguous_competing_assertions', 'ambiguous_competing_assertions']);
  });

  it('fails closed on competing document-field values across anchors', () => {
    const fieldRow = (anchor: string, value: string) => assertion({
      fact_key: 'billed_amount', asserted_value: value, anchor_key: anchor, source_observation_ids: [],
    });
    const result = resolveRegionAssertionsForSnapshot({
      rows: [fieldRow('p8:total', '1200.00'), fieldRow('p8:footer', '1250.00')],
      legacyRowsByDocumentId: currentFor(DIGEST),
    });
    expect(result.effective).toEqual([]);
    expect(result.held[0]!.reason).toBe('ambiguous_competing_assertions');
  });

  it('holds a reviewed rate row that cites no source observation: its target cannot be bound', () => {
    const result = resolveRegionAssertionsForSnapshot({
      rows: [assertion({ source_observation_ids: [] })], legacyRowsByDocumentId: currentFor(DIGEST),
    });
    expect(result.effective).toEqual([]);
    expect(result.held[0]!.reason).toBe('source_observations_required');
  });

  it('ignores rows that are not complete region-bound assertions', () => {
    const result = resolveRegionBoundAssertions({
      rows: [
        assertion({ source_binding: 'domain_assertion' }),
        assertion({ page_representation_digest: 'not-a-digest' }),
        assertion({ source_region: { coordinate_space: 'source', boxes: [] } }),
      ],
      currentEvidenceByDocumentId: new Map(),
    });
    expect(result).toEqual({ effective: [], held: [] });
  });
});

describe('B3 downstream: the human-reviewed value reaches every consumer with its provenance', () => {
  const row = assertion();
  const { effective } = resolveRegionAssertionsForSnapshot({ rows: [row], legacyRowsByDocumentId: currentFor(DIGEST) });
  const assembled = reviewedContractPricingRows({ effective, rateDocumentIds: new Set([CONTRACT]) });

  it('enters pricing assembly as a human-reviewed row, keeping the original OCR as observed raw', () => {
    expect(assembled).toHaveLength(1);
    expect(assembled[0]).toMatchObject({
      id: `human_fact_assertion:${row.id}`, sourceDocumentId: CONTRACT, rate: 14.5, unit: 'CY',
      description: 'Debris removal', page: PAGE, sourceKind: 'human_reviewed_assertion',
      authoredValueCorrection: false, rawText: 'sia 50',
      humanReview: { status: 'human_reviewed', assertion_id: row.id, review_origin: 'operator_entered' },
    });
  });

  it('contributes nothing for a document that is not a rate source in this execution', () => {
    expect(reviewedContractPricingRows({ effective, rateDocumentIds: new Set(['other-document']) })).toEqual([]);
  });

  it('reaches legacy Validator pricing labeled human-reviewed', () => {
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map(), rateDocumentIds: [CONTRACT],
      contractValidationContext: null, assembledContractPricingRows: assembled,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source_document_id: CONTRACT, rate_amount: 14.5, unit_type: 'CY',
      record_id: `human_fact_assertion:${row.id}` });
    expect(items[0]!.human_review).toMatchObject({ status: 'human_reviewed', assertion_id: row.id });
  });

  it('is additive: a reviewed row never suppresses a document\'s fallback rate rows', () => {
    const factRows = [{ description: 'Hauling', unit_type: 'TON', rate_amount: 8.75 },
      { description: 'Stump grinding', unit_type: 'EA', rate_amount: 45 }];
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map([[CONTRACT, [{ id: 'fact-rate-table', document_id: CONTRACT, key: 'rate_table',
        value: factRows, source: 'normalized_row', field_type: null, evidence: [] }]]]),
      rateDocumentIds: [CONTRACT], contractValidationContext: null, assembledContractPricingRows: assembled,
    });
    expect(items.map((item) => item.rate_amount).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([8.75, 14.5, 45]);
    expect(items.filter((item) => item.human_review != null)).toHaveLength(1);
  });

  it('reaches canonical truth as operator-corrected, not as an unreviewed machine reading', () => {
    const candidates = adaptAssembledPricingRows(assembled, {
      governingDocument: { documentId: CONTRACT, family: null, title: null },
    });
    const resolved = candidates.map((candidate) => resolveCanonicalPricingRow(candidate));
    expect(resolved[0]!.sourceFamily.humanReview).toMatchObject({ assertion_id: row.id });
    expect(resolved[0]!.rate).toMatchObject({ value: 14.5, state: 'resolved', observedRaw: 'sia 50' });
    expect(resolved[0]!.rate.operatorReview).toMatchObject({ status: 'corrected', actorId: 'operator-1' });
    // Not quarantined as an authored row.
    expect(resolved[0]!.authoredCorrection).toBe(false);
    const items = projectCanonicalRateScheduleItems([buildCanonicalPricingSchedule({ rows: resolved })]);
    expect(items[0]!.human_review).toMatchObject({ assertion_id: row.id });
    expect(items[0]!.authored_unverified).toBe(false);
  });

  it('is matched to the invoice line it prices, carrying its receipt', () => {
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map(), rateDocumentIds: [CONTRACT],
      contractValidationContext: null, assembledContractPricingRows: assembled,
    });
    const map = buildInvoiceLineToRateMap(
      [{ id: 'line-1', description: 'Debris removal', unit: 'CY', unit_price: 14.5 }], items);
    expect(map.get('line-1')?.human_review?.assertion_id).toBe(row.id);
  });

  it('wins over a machine fact for a document field, labeled human-reviewed with page evidence', () => {
    const fieldRow = assertion({ source_document_id: INVOICE, fact_key: 'billed_amount', asserted_value: 1250,
      anchor_key: 'p8:total', source_observation_ids: [], original_source_text: '1,2S0.00' });
    const resolution = resolveRegionAssertionsForSnapshot({
      rows: [fieldRow], legacyRowsByDocumentId: new Map([[INVOICE, extraction(INVOICE, DIGEST)]]),
    });
    const { factsByDocumentId } = buildFactsByDocumentId({
      documents: DOCUMENTS,
      factRows: [{ id: 'machine-fact', document_id: INVOICE, field_key: 'billed_amount',
        field_value_number: 1200, field_value_text: null, field_value_date: null, field_value_boolean: null,
        status: 'active', field_type: 'number' } as never],
      legacyRowsByDocumentId: new Map(),
      overrideRows: [],
      reviewRows: [],
      regionAssertions: resolution.effective,
    });
    const fact = factsByDocumentId.get(INVOICE)!.find((entry) => entry.key === 'billed_amount')!;
    expect(fact).toMatchObject({ source: 'human_assertion', value: 1250 });
    expect(fact.evidence[0]).toMatchObject({ source_page: PAGE, record_id: `human_fact_assertion:${fieldRow.id}` });
    expect(fact.evidence[0]!.note).toContain('Human-reviewed value: 1250');
    expect(fact.evidence[0]!.note).toContain('extraction read "1,2S0.00"');
  });

  it('labels rate evidence in any rule pack as human-reviewed, leaving other evidence untouched', () => {
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map(), rateDocumentIds: [CONTRACT],
      contractValidationContext: null, assembledContractPricingRows: assembled,
    });
    const evidence = (recordId: string) => ({
      id: `e-${recordId}`, finding_id: 'f-1', evidence_type: 'rate_schedule', source_document_id: CONTRACT,
      source_page: null, fact_id: null, record_id: recordId, field_name: 'rate_amount', field_value: '14.5',
      note: 'Matched governing contract schedule line.', created_at: '2026-10-04T00:00:00.000Z',
    });
    const [labeled] = labelHumanReviewedRateEvidence([{
      evidence: [evidence(`human_fact_assertion:${row.id}`), evidence('machine-row-1')],
    } as never], items);
    const [reviewed, machine] = (labeled as unknown as { evidence: ReturnType<typeof evidence>[] }).evidence;
    expect(reviewed!.note).toBe(`Human-reviewed contract rate (operator entered on page ${PAGE}; extraction read "sia 50"; `
      + `assertion ${row.id}). Matched governing contract schedule line.`);
    expect(reviewed!.source_page).toBe(PAGE);
    expect(machine).toEqual(evidence('machine-row-1'));
  });

  it('shows the Forgewing suggestion beside the operator value when they differ', () => {
    const label = describeHumanReviewedValue({
      value: { description: 'Debris removal', unit_type: 'CY', rate_amount: 325 },
      provenance: effective[0]!.provenance,
      forgewingSuggestedValue: { description: 'Debris removal', unit_type: 'CY', rate_amount: 320 },
    });
    expect(label).toContain('Forgewing suggested Debris removal · CY · 320; operator entered Debris removal · CY · 325');
    expect(label).toContain('extraction read "sia 50"');
  });
});
