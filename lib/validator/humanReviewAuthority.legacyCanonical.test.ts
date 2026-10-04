import { describe, expect, it } from 'vitest';

import { isCanonicalAuthorityEstablished } from '@/lib/canonical/authority/canonicalExecutionContext';
import {
  CONTRACT_DOCUMENT_ID,
  buildComparisonSourceSnapshot,
  invoiceLineRow,
  pricingAssemblyRow,
} from '@/lib/canonical/comparison/__fixtures__/authorityComparisonFixtures';
import { sourceFromInput } from '@/lib/canonical/publication/publishProjectTruthShadow';
import { adaptProjectTruthPublicationSource } from '@/lib/canonical/publication/projectTruthShadowAdapter';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import { applyHumanReviewedPricing } from '@/lib/humanFactAssertions/humanReviewSupersession';
import {
  CONTRACT_RATE_ROW_FACT_KEY,
  resolveRegionBoundAssertions,
  type CurrentDocumentEvidence,
  type HumanFactAssertionRow,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  buildRateScheduleItemsWithHumanReview,
  buildValidatorInputFromSourceSnapshot,
  executeProjectValidation,
  type ValidatorSourceSnapshot,
} from '@/lib/validator/projectValidator';
import {
  RULE_HUMAN_REVIEW_MACHINE_ROW_WITHHELD,
  RULE_HUMAN_REVIEWED_VALUE_HELD,
} from '@/lib/validator/rulePacks/humanReviewIntegrity';
import type { ValidatorFactRecord, ValidatorFindingResult } from '@/lib/validator/shared';

/**
 * Forgewing resolution layer B3.1. An effective HUMAN_REVIEWED rate row is
 * final authority for its physical source target in BOTH authority modes:
 * - the machine row for the same observations is superseded, never
 *   double-counted;
 * - unrelated rows stay;
 * - original machine and OCR values stay in provenance;
 * - the receipt survives into the Validator and Project Truth.
 */

const PAGE = 8;
const DIGEST = 'a'.repeat(64);
const REVIEWED_OBSERVATIONS = ['obs-p8-desc', 'obs-p8-rate'];

const EVIDENCE: ReadonlyMap<string, CurrentDocumentEvidence> = new Map([[CONTRACT_DOCUMENT_ID, {
  pageRepresentationDigestByPage: new Map([[PAGE, DIGEST], [9, 'c'.repeat(64)]]),
  reconstructionRowObservationIds: new Map([
    [`${PAGE}:0`, REVIEWED_OBSERVATIONS],
    ['9:0', ['obs-p9-desc', 'obs-p9-rate']],
  ]),
}]]);

/** A machine row built by reconstruction, identified exactly as production names it. */
function machineRow(rowId: string, description: string, rate: number, page: number): ContractPricingAssemblyRow {
  return {
    ...pricingAssemblyRow({ rowId, description, unit: 'cubic yard', rate, category: 'transport', page }),
    id: rowId,
    sourceDocumentId: CONTRACT_DOCUMENT_ID,
    sourceKind: 'rate_schedule',
    authoredValueCorrection: false,
    rawText: `${description} | cubic yard | $ ${rate}`,
  };
}

// The OCR misread the rate; extraction priced the line at 15.00. The operator read 12.50.
const MISREAD = () => machineRow(`page_priced_schedule:p${PAGE}:r0`, 'HAUL 0-15 MILES', 15, PAGE);
const UNRELATED = () => machineRow('page_priced_schedule:p9:r0', 'HAUL 15-30 MILES', 20, 9);

let sequence = 0;
function assertion(overrides: Partial<HumanFactAssertionRow> = {}): HumanFactAssertionRow {
  sequence += 1;
  return {
    id: `b31-assertion-${sequence}`,
    organization_id: 'fixture-org',
    source_document_id: CONTRACT_DOCUMENT_ID,
    fact_key: CONTRACT_RATE_ROW_FACT_KEY,
    asserted_value: { description: 'HAUL 0-15 MILES', unit_type: 'cubic yard', rate_amount: 12.5, category: 'transport' },
    source_binding: 'region_bound',
    supersedes_assertion_id: null,
    actor_id: 'operator-1',
    reason: 'OCR misread the rate cell; read 12.50 from the source page',
    asserted_at: `2026-10-04T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    status: 'active',
    source_artifact_id: null,
    physical_page_number: PAGE,
    source_region: { coordinate_space: 'source', boxes: [{ x_min: 40, x_max: 520, y_min: 300, y_max: 312 }] },
    page_representation_digest: DIGEST,
    parser_version: 'priced_schedule_reconstruction_v2',
    source_observation_ids: REVIEWED_OBSERVATIONS,
    original_source_text: 'HAUL 0-15 MILES $ 1S.00',
    anchor_key: `p${PAGE}:priced_line:haul-0-15`,
    review_origin: 'operator_entered',
    forgewing_proposal_id: null,
    ...overrides,
  };
}

/** Production composition: resolve, apply at the shared seam, build legacy pricing, freeze the snapshot. */
function snapshotWith(rows: readonly HumanFactAssertionRow[], options: {
  machineRows?: readonly ContractPricingAssemblyRow[];
  factsByDocumentId?: Map<string, ValidatorFactRecord[]>;
} = {}): ValidatorSourceSnapshot {
  const resolution = resolveRegionBoundAssertions({ rows, currentEvidenceByDocumentId: EVIDENCE });
  const priced = applyHumanReviewedPricing({
    machineRows: options.machineRows ?? [MISREAD(), UNRELATED()],
    effective: resolution.effective,
    rateDocumentIds: new Set([CONTRACT_DOCUMENT_ID]),
    currentEvidenceByDocumentId: EVIDENCE,
  });
  const legacy = buildRateScheduleItemsWithHumanReview({
    factsByDocumentId: options.factsByDocumentId ?? new Map(),
    rateDocumentIds: [CONTRACT_DOCUMENT_ID],
    contractValidationContext: null,
    assembledContractPricingRows: priced.rows,
    humanReviewGate: priced.gate,
  });
  const base = buildComparisonSourceSnapshot({
    projectId: 'fixture-b31',
    legacyRateScheduleItems: legacy.items,
    assembledContractPricingRows: priced.rows,
    invoiceLines: [invoiceLineRow({ unit_price: 12.5, line_total: 5000 })],
  });
  return {
    ...base,
    baseFactLookups: {
      ...base.baseFactLookups,
      ...(legacy.withheld.length > 0 ? { humanReviewFallbackWithheldRows: legacy.withheld } : {}),
    },
    heldRegionAssertions: resolution.held,
    humanReviewWithheldRows: priced.withheld,
  };
}

function run(snapshot: ValidatorSourceSnapshot, authorityMode: 'legacy' | 'canonical') {
  const input = buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode });
  const executed = executeProjectValidation(input).result;
  const result = { ...executed, findings: executed.findings as unknown as ValidatorFindingResult[] };
  const publication = adaptProjectTruthPublicationSource(sourceFromInput({
    projectId: input.project.id, runId: 'run-b31', triggerSource: 'manual', inputsSnapshotHash: 'hash-b31',
    validatorInput: input, effectiveResult: executed, persistedFindings: executed.findings,
  }));
  const projectTruthRows = publication.registryWithoutTransactions.contractPricing.flatMap((schedule) => schedule.rows);
  return { input, result, projectTruthRows };
}

const haul015 = (rate: number | null) => rate === 12.5 || rate === 15;

describe.each(['legacy', 'canonical'] as const)('B3.1 human-reviewed pricing authority — %s mode', (mode) => {
  it('prices the physical line exactly once, at the human-reviewed value', () => {
    const { input } = run(snapshotWith([assertion()]), mode);
    if (mode === 'canonical') expect(isCanonicalAuthorityEstablished(input.projectTruthAuthority!)).toBe(true);
    const line = input.factLookups.rateScheduleItems.filter((item) => haul015(item.rate_amount));
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ rate_amount: 12.5 });
    expect(line[0]!.human_review).toMatchObject({ status: 'human_reviewed', assertion_id: expect.any(String) });
  });

  it('keeps unrelated machine rows', () => {
    const { input } = run(snapshotWith([assertion()]), mode);
    expect(input.factLookups.rateScheduleItems.map((item) => item.rate_amount)).toContain(20);
  });

  it('shows the reviewed row, and not the superseded machine row, in Project Truth', () => {
    const { projectTruthRows } = run(snapshotWith([assertion()]), mode);
    const rates = projectTruthRows.map((row) => row.rate.value);
    expect(rates).toContain(12.5);
    expect(rates).not.toContain(15);
    expect(rates).toContain(20);
    const reviewed = projectTruthRows.find((row) => row.rate.value === 12.5)!;
    expect(reviewed.sourceFamily.humanReview).toMatchObject({ status: 'human_reviewed' });
    expect(reviewed.rate.operatorReview.status).toBe('corrected');
    // The original OCR reading is retained as the observed raw value.
    expect(reviewed.rate.observedRaw).toBe('HAUL 0-15 MILES $ 1S.00');
  });

  it('validates the invoice against the reviewed value, labeled human-reviewed', () => {
    const reviewed = run(snapshotWith([assertion()]), mode);
    const control = run(snapshotWith([]), mode);
    const matched = reviewed.input.invoiceLineToRateMap.get('invoice-line-1');
    expect(matched?.rate_amount).toBe(12.5);
    expect(matched?.human_review?.status).toBe('human_reviewed');
    // Without the review the line is not priced at the reviewed value.
    expect(control.input.invoiceLineToRateMap.get('invoice-line-1')?.rate_amount ?? null).not.toBe(12.5);
    // Every piece of evidence that rests on the reviewed row says so.
    const reviewedEvidence = reviewed.result.findings.flatMap((finding) => finding.evidence)
      .filter((entry) => entry.record_id === matched!.record_id);
    expect(reviewedEvidence.length).toBeGreaterThan(0);
    for (const entry of reviewedEvidence) expect(entry.note).toMatch(/^Human-reviewed contract rate/);
    // A human-reviewed row is never quarantined as authored.
    expect(reviewed.result.findings.filter((finding) => finding.rule_id === 'FINANCIAL_AUTHORED_RATE_ROW_UNVERIFIED')).toEqual([]);
  });

  it('keeps the superseded machine values and the OCR reading in provenance', () => {
    const { input } = run(snapshotWith([assertion()]), mode);
    const receipt = input.factLookups.rateScheduleItems.find((item) => item.rate_amount === 12.5)!.human_review!;
    expect(receipt.original_source_text).toBe('HAUL 0-15 MILES $ 1S.00');
    expect(receipt.superseded_machine_rows).toEqual([expect.objectContaining({
      row_id: `page_priced_schedule:p${PAGE}:r0`, rate: 15, physical_page_number: PAGE,
    })]);
  });

  it.each([
    ['superseded', () => {
      const first = assertion();
      return [first, assertion({ supersedes_assertion_id: first.id, status: 'withdrawn', asserted_value: null })];
    }],
    ['withdrawn', () => {
      const first = assertion();
      return [first, assertion({ supersedes_assertion_id: first.id, status: 'withdrawn', asserted_value: null })];
    }],
    ['stale', () => [assertion({ page_representation_digest: 'b'.repeat(64) })]],
    ['competing', () => [assertion(), assertion({ asserted_value: { description: 'HAUL 0-15 MILES', unit_type: 'cubic yard', rate_amount: 13 } })]],
  ])('a %s assertion suppresses nothing: the machine row prices the line', (_label, rows) => {
    const { input, result } = run(snapshotWith(rows()), mode);
    const line = input.factLookups.rateScheduleItems.filter((item) => haul015(item.rate_amount));
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ rate_amount: 15 });
    expect(line[0]!.human_review ?? null).toBeNull();
    if (_label === 'stale' || _label === 'competing') {
      expect(result.findings.some((finding) => finding.rule_id === RULE_HUMAN_REVIEWED_VALUE_HELD)).toBe(true);
    }
  });

  it('withholds, and reports, a machine row on the same page that cannot be proven distinct', () => {
    const geometryOnly: ContractPricingAssemblyRow = {
      ...machineRow('exhibit_a_table:row-3', 'HAUL 0-15 MILES', 15, PAGE),
    };
    const { input, result } = run(snapshotWith([assertion()], { machineRows: [geometryOnly, UNRELATED()] }), mode);
    expect(input.factLookups.rateScheduleItems.filter((item) => haul015(item.rate_amount)))
      .toEqual([expect.objectContaining({ rate_amount: 12.5 })]);
    const finding = result.findings.find((entry) => entry.rule_id === RULE_HUMAN_REVIEW_MACHINE_ROW_WITHHELD);
    expect(finding?.evidence[0]).toMatchObject({ record_id: 'exhibit_a_table:row-3', source_page: PAGE });
  });
});

describe('B3.1 legacy fallback rows, which never enter assembly', () => {
  const persisted = (rowId: string, observations: string[], rate: number, description: string) => ({
    row_id: rowId, description, unit_type: 'cubic yard', rate_amount: rate, page: PAGE,
    source_kind: 'page_priced_schedule',
    pricing_cell_evidence: [{ source_cell_role: 'rate', source_observation_ids: observations, authored_raw_text: `$ ${rate}` }],
  });
  const facts = (entries: unknown[]) => new Map([[CONTRACT_DOCUMENT_ID, [{
    id: 'fact-rate-table', document_id: CONTRACT_DOCUMENT_ID, key: 'rate_table', value: entries,
    source: 'normalized_row', field_type: null, evidence: [],
  } as ValidatorFactRecord]]]);

  it('supersedes the same physical line, keeps unrelated rows, withholds unprovable ones (legacy pricing)', () => {
    const snapshot = snapshotWith([assertion()], {
      // No machine assembled rows for the contract: legacy falls back to facts.rate_table.
      machineRows: [],
      factsByDocumentId: facts([
        persisted('legacy:p8:r0', REVIEWED_OBSERVATIONS, 15, 'HAUL 0-15 MILES'),
        persisted('legacy:p9:r0', ['obs-p9-desc'], 20, 'HAUL 15-30 MILES'),
        // A regex scrape of the text: no page, no observations.
        { material_type: null, unit: 'per cubic yard', rate_amount: 15, rate_raw: '$15.00 per cubic yard' },
      ]),
    });
    const { input, result } = run(snapshot, 'legacy');
    const rates = input.factLookups.rateScheduleItems.map((item) => item.rate_amount).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(rates).toEqual([12.5, 20]);
    const receipt = input.factLookups.rateScheduleItems.find((item) => item.rate_amount === 12.5)!.human_review!;
    expect(receipt.superseded_machine_rows).toEqual([expect.objectContaining({ row_id: 'legacy:p8:r0', rate: 15 })]);
    const withheld = result.findings.filter((entry) => entry.rule_id === RULE_HUMAN_REVIEW_MACHINE_ROW_WITHHELD);
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!.evidence[0]!.field_value).toContain('$15.00 per cubic yard');
  });
});
