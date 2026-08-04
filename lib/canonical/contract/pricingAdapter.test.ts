/**
 * Adapter proofs, driven by Golden Project (Williamson County) pricing shapes.
 *
 * Golden values appear ONLY in this test file. They define acceptance
 * scenarios; they are never imported by, or encoded into, canonical production
 * code. Proof 16 enforces that boundary by scanning the canonical sources.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import {
  adaptAssembledPricingRow,
  adaptAssembledPricingRows,
  CONTRACT_PRICING_ASSEMBLY_ADAPTER_ID,
} from '@/lib/canonical/contract/pricingAdapter';
import {
  buildCanonicalPricingSchedule,
  resolveCanonicalPricingRow,
} from '@/lib/canonical/contract/pricingResolution';
import { canonicalEvidenceRef } from '@/lib/canonical/truth/envelope';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import { buildTableCellGeometry } from '@/lib/extraction/tableGeometry';
import { parseAuthoredPricingDimensions } from '@/lib/contracts/pricingDimensions';

const GOLDEN_DOCUMENT_ID = 'golden-contract-document';

const GOLDEN_GOVERNING_DOCUMENT = {
  documentId: GOLDEN_DOCUMENT_ID,
  family: 'contract',
  title: 'Golden governing contract',
} as const;

const GOLDEN_RATE_SCHEDULE = {
  scheduleId: 'golden-schedule-1',
  scheduleName: 'Contract rate schedule',
} as const;

const ADAPTER_CONTEXT = {
  documentId: GOLDEN_DOCUMENT_ID,
  governingDocument: GOLDEN_GOVERNING_DOCUMENT,
  rateSchedule: GOLDEN_RATE_SCHEDULE,
};

/**
 * The Golden vegetative ROW-to-DMS 0–15 pricing row, in the shape the current
 * assembler emits. This is the row behind the known unmatched cross-document
 * rate scenario.
 */
function goldenVegetativeRow(
  overrides: Partial<ContractPricingAssemblyRow> = {},
): ContractPricingAssemblyRow {
  return {
    id: 'rate_row:golden:veg-row-dms-0-15',
    category: 'Vegetative Collect, Remove & Haul',
    description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
    route: 'ROW to DMS',
    distanceBand: '0 to 15 Miles',
    unit: 'Cubic Yard',
    rate: 6.9,
    page: 8,
    sourceAnchor: 'golden:anchor:rate-row-1',
    confidence: 'high',
    sourceKind: 'exhibit_a_table',
    sourceQuality: 'clean',
    authoredValueCorrection: false,
    rawText:
      'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
    ...overrides,
  };
}

function resolveGolden(
  overrides: Partial<ContractPricingAssemblyRow> = {},
  context: Parameters<typeof resolveCanonicalPricingRow>[1] = {},
) {
  const candidate = adaptAssembledPricingRow(goldenVegetativeRow(overrides), 0, ADAPTER_CONTEXT);
  return { candidate, row: resolveCanonicalPricingRow(candidate, context) };
}

// ── 1 ────────────────────────────────────────────────────────────────────────
describe('1. a clean resolved Golden row preserves its business fields', () => {
  it('preserves category, description, unit, rate and evidence', () => {
    const { row } = resolveGolden();

    assert.equal(row.category.value, 'Vegetative Collect, Remove & Haul');
    assert.equal(row.category.state, 'resolved');
    assert.equal(row.description.value, 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles');
    assert.equal(row.unit.value, 'Cubic Yard');
    assert.equal(row.rate.value, 6.9);
    assert.equal(row.rate.state, 'resolved');

    assert.equal(row.resolution.state, 'resolved');
    assert.equal(row.resolution.displayGroup, 'resolved_pricing');
    assert.equal(row.resolution.approval.eligible, true);
    assert.deepEqual(row.resolution.unresolvedReasons, []);

    assert.ok(row.rate.governingSource, 'rate carries a governing evidence reference');
    assert.equal(row.rate.governingSource?.page, 8);
    assert.equal(row.rate.governingSource?.sourceAnchor, 'golden:anchor:rate-row-1');
  });

  it('preserves the Golden route and distance band as conditional dimensions', () => {
    const { row } = resolveGolden();
    assert.equal(row.route.value, 'ROW to DMS');
    assert.equal(row.distanceBand.value, '0 to 15 Miles');
  });
});

// ── 2, 3 ─────────────────────────────────────────────────────────────────────
describe('2/3. incomplete and uncategorized rows are retained', () => {
  it('retains an incomplete row as a candidate rather than dropping it', () => {
    const candidates = adaptAssembledPricingRows(
      [goldenVegetativeRow({ unit: null, rate: null, description: '' })],
      ADAPTER_CONTEXT,
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.candidateId, 'rate_row:golden:veg-row-dms-0-15');
  });

  it('does not drop a row whose category failed to resolve', () => {
    const rows = [
      goldenVegetativeRow({ id: 'row-with-category' }),
      goldenVegetativeRow({ id: 'row-without-category', category: null }),
    ];
    const candidates = adaptAssembledPricingRows(rows, ADAPTER_CONTEXT);
    assert.equal(candidates.length, 2);
    assert.deepEqual(
      candidates.map((candidate) => candidate.candidateId),
      ['row-with-category', 'row-without-category'],
    );
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────
describe('4. a missing unit is never guessed', () => {
  it('records an absent unit as absent_from_source with a null value', () => {
    const { row } = resolveGolden({ unit: null });
    assert.equal(row.unit.value, null);
    assert.equal(row.unit.state, 'absent_from_source');
    assert.notEqual(row.unit.state, 'not_applicable');
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────
describe('5. a missing rate is not approval eligible', () => {
  it('blocks approval and reports the rate as unresolved', () => {
    const { row } = resolveGolden({ rate: null });
    assert.equal(row.rate.value, null);
    assert.equal(row.resolution.approval.eligible, false);
    assert.ok(row.resolution.approval.blockers.includes('rate_unresolved'));
    assert.equal(row.resolution.displayGroup, 'needs_review');
  });
});

// ── 6 ────────────────────────────────────────────────────────────────────────
describe('6. an extraction conflict enters needs_review', () => {
  it('detects a rate disagreement recorded in merge diagnostics', () => {
    const { row } = resolveGolden({
      mergeDiagnostics: [
        {
          droppedRowId: 'rate_row:golden:veg-row-dms-0-15:ocr-duplicate',
          droppedSourceKind: 'exhibit_a_table',
          droppedSourceAnchor: 'golden:anchor:rate-row-1b',
          droppedRate: 8.9,
          droppedDescription: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
          droppedQualityScore: 120,
          winningRowId: 'rate_row:golden:veg-row-dms-0-15',
          winningQualityScore: 180,
          reason: 'dedupe_key_collision',
          comparisonMethod: 'content_key',
        },
      ],
    });

    assert.equal(row.resolution.state, 'extraction_conflict');
    assert.equal(row.resolution.displayGroup, 'needs_review');
    assert.equal(row.rate.state, 'extraction_conflict');
    assert.equal(row.rate.value, 6.9, 'the observed reading is retained as provisional');
    assert.equal(row.resolution.approval.eligible, false);
  });

  it('treats an agreeing merge as a benign duplicate, not a conflict', () => {
    const { row } = resolveGolden({
      mergeDiagnostics: [
        {
          droppedRowId: 'duplicate',
          droppedSourceKind: 'exhibit_a_table',
          droppedSourceAnchor: 'golden:anchor:rate-row-1b',
          droppedRate: 6.9,
          droppedDescription: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
          droppedQualityScore: 120,
          winningRowId: 'rate_row:golden:veg-row-dms-0-15',
          winningQualityScore: 180,
          reason: 'dedupe_key_collision',
          comparisonMethod: 'content_key',
        },
      ],
    });
    assert.equal(row.resolution.state, 'resolved');
  });
});

// ── 7 ────────────────────────────────────────────────────────────────────────
describe('7. a precedence conflict enters needs_review', () => {
  it('downgrades the row when governing documents disagree', () => {
    const { row } = resolveGolden({}, {
      precedence: {
        governingDocumentId: GOLDEN_DOCUMENT_ID,
        family: 'contract',
        reason: 'amends_relationship',
        reasonDetail: null,
        supersededDocumentIds: ['golden-superseded-amendment'],
      },
      precedenceConflictEvidence: [
        canonicalEvidenceRef({
          documentId: 'golden-superseded-amendment',
          page: 2,
          sourceAnchor: 'golden:amendment:anchor-1',
        }),
      ],
    });

    assert.equal(row.resolution.state, 'precedence_conflict');
    assert.equal(row.resolution.displayGroup, 'needs_review');
    assert.equal(row.rate.state, 'precedence_conflict');
    assert.equal(row.resolution.approval.eligible, false);
    assert.ok(row.resolution.approval.blockers.includes('precedence_conflict'));
  });
});

// ── 8 ────────────────────────────────────────────────────────────────────────
describe('8. a non-pricing row enters excluded', () => {
  it('excludes a row bearing no pricing dimension at all', () => {
    const { candidate, row } = resolveGolden({
      category: null,
      unit: null,
      rate: null,
      quantity: null,
      totalAmount: null,
      description: 'Notes and general conditions paragraph',
      rawText: 'Notes and general conditions paragraph',
    });

    assert.equal(candidate.pricingContent, 'non_pricing');
    assert.equal(row.resolution.state, 'non_pricing');
    assert.equal(row.resolution.displayGroup, 'excluded');
    assert.equal(row.resolution.approval.eligible, false);
    assert.ok(row.resolution.approval.blockers.includes('no_pricing_content'));
  });

  it('does not exclude a row that still carries one pricing dimension', () => {
    const { candidate } = resolveGolden({ category: null, unit: null, rate: 6.9 });
    assert.equal(candidate.pricingContent, 'pricing');
  });
});

// ── 9 ────────────────────────────────────────────────────────────────────────
describe('9. an unresolved mapping enters needs_review', () => {
  it('reports observed-but-unmapped category as unresolved_mapping', () => {
    const { row } = resolveGolden({ category: null });
    assert.equal(row.category.state, 'unresolved_mapping');
    assert.equal(row.category.stateReason, 'category_not_mapped_from_observed_text');
    assert.equal(row.resolution.state, 'unresolved_mapping');
    assert.equal(row.resolution.displayGroup, 'needs_review');
    assert.equal(row.category.observedRaw != null, true, 'observed text is retained');
  });
});

// ── 10 ───────────────────────────────────────────────────────────────────────
describe('10. geometry and source anchors survive adaptation', () => {
  it('carries geometry into typed evidence references', () => {
    const { candidate, row } = resolveGolden({
      geometryRefs: [
        {
          text: '$6.90',
          geometry: buildTableCellGeometry({
            page_number: 8,
            table_id: 'golden:table:rate-schedule',
            row_index: 3,
            cell_index: 4,
            text: '$6.90',
            x_min: 0.62,
            x_max: 0.71,
            y_min: 0.44,
            y_max: 0.47,
            source_type: 'ocr_fallback',
            source_document_id: GOLDEN_DOCUMENT_ID,
          }),
        },
      ],
    });

    // Row anchor first, then geometry — deterministic order.
    assert.equal(candidate.evidence.length, 2);
    assert.equal(candidate.evidence[0]?.sourceAnchor, 'golden:anchor:rate-row-1');

    const geometryEvidence = candidate.evidence[1];
    assert.equal(geometryEvidence?.tableKey, 'golden:table:rate-schedule');
    assert.equal(geometryEvidence?.rowIndex, 3);
    assert.equal(geometryEvidence?.cellIndex, 4);
    assert.equal(geometryEvidence?.extractor, 'ocr_fallback');
    assert.equal(geometryEvidence?.boundingBox?.complete, true);
    assert.equal(geometryEvidence?.boundingBox?.x0, 0.62);
    assert.equal(geometryEvidence?.rawSpan, '$6.90');
    assert.equal(geometryEvidence?.recognitionConfidence, null);

    assert.equal(row.resolution.evidenceCompleteness.evidenceRefCount, 2);
    assert.equal(row.resolution.evidenceCompleteness.coreFieldsBacked, true);
  });

  it('reports evidence as incomplete when nothing locatable backs the row', () => {
    const { row } = resolveGolden({ page: null, sourceAnchor: null });
    assert.equal(row.resolution.evidenceCompleteness.hasLocatableEvidence, false);
    assert.equal(row.resolution.approval.eligible, false);
    assert.ok(row.resolution.approval.blockers.includes('evidence_incomplete'));
  });
});

// ── 11, 12, 13 ───────────────────────────────────────────────────────────────
describe('11/12/13. provenance fields survive honestly', () => {
  it('preserves merge diagnostics verbatim', () => {
    const diagnostic = {
      droppedRowId: 'dropped-row',
      droppedSourceKind: 'exhibit_a_text_recovery' as const,
      droppedSourceAnchor: 'golden:anchor:dropped',
      droppedRate: 6.9,
      droppedDescription: 'duplicate reading',
      droppedQualityScore: 90,
      winningRowId: 'rate_row:golden:veg-row-dms-0-15',
      winningQualityScore: 180,
      reason: 'trusted_coverage_suppression' as const,
      comparisonMethod: 'content_key' as const,
    };
    const { candidate, row } = resolveGolden({ mergeDiagnostics: [diagnostic] });

    assert.equal(candidate.mergeDiagnostics.length, 1);
    assert.equal(candidate.mergeDiagnostics[0]?.droppedRowId, 'dropped-row');
    assert.equal(candidate.mergeDiagnostics[0]?.reason, 'trusted_coverage_suppression');
    assert.equal(candidate.mergeDiagnostics[0]?.comparisonMethod, 'content_key');
    assert.equal(row.mergeDiagnostics.length, 1);
  });

  it('preserves authoredValueCorrection and blocks approval on it', () => {
    const { candidate, row } = resolveGolden({ authoredValueCorrection: true });
    assert.equal(candidate.authoredCorrection, true);
    assert.equal(row.authoredCorrection, true);
    assert.equal(row.resolution.state, 'requires_review');
    assert.equal(row.resolution.approval.eligible, false);
    assert.ok(row.resolution.approval.blockers.includes('authored_value_correction'));
  });

  it('preserves typed corrected dimensions as derived truth with exact span evidence', () => {
    const description = 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles';
    const { candidate, row } = resolveGolden({
      description,
      authoredValueCorrection: true,
      pricingDimensions: parseAuthoredPricingDimensions(description),
      pricingDimensionSources: { route: 'authored_correction', distance: 'authored_correction' },
    });

    assert.equal(candidate.pricingDimensions?.routeKind, 'row_to_dms');
    assert.equal(row.routeKind.value, 'row_to_dms');
    assert.equal(row.routeKind.state, 'derived');
    assert.equal(row.routeRawSpan.value, 'ROW to DMS');
    assert.equal(row.routeKind.governingSource?.rawSpan, 'ROW to DMS');
    assert.equal(row.distanceInterval.value?.minMiles, 0);
    assert.equal(row.distanceInterval.value?.maxMiles, 15);
    assert.equal(row.distanceInterval.state, 'derived');
    assert.equal(row.distanceRawExpression.value, '0 to 15 Miles');
    assert.equal(row.resolution.approval.eligible, false);
    assert.ok(row.resolution.approval.blockers.includes('authored_value_correction'));
  });

  it('keeps confidence null and preserves the upstream label without converting it', () => {
    const { candidate, row } = resolveGolden({ confidence: 'needs_review' });
    assert.equal(candidate.observedConfidence, null);
    assert.equal(candidate.extractionConfidenceLabel, 'needs_review');
    assert.equal(row.rate.confidence, null);
    assert.equal(row.category.confidence, null);
    assert.equal(row.description.confidence, null);
    assert.equal(row.resolution.state, 'resolved');
    assert.equal(row.resolution.approval.eligible, true);
  });

});

// ── 14 ───────────────────────────────────────────────────────────────────────
describe('14. source kind does not control approval eligibility', () => {
  const SOURCE_KINDS: readonly ContractPricingAssemblyRow['sourceKind'][] = [
    'canonical',
    'typed_fields',
    'exhibit_a_table',
    'exhibit_a_text_recovery',
    'tdot_appendix_b_stitched_table',
    'mdot_section_905_bid_schedule',
    'professional_services_table',
    'rate_schedule',
    'fallback',
  ];

  it('yields identical resolution for every source kind on identical content', () => {
    const outcomes = SOURCE_KINDS.map((sourceKind) => {
      const { row } = resolveGolden({ sourceKind });
      return {
        sourceKind,
        state: row.resolution.state,
        group: row.resolution.displayGroup,
        eligible: row.resolution.approval.eligible,
      };
    });

    for (const outcome of outcomes) {
      assert.equal(outcome.state, 'resolved', `state differed for ${outcome.sourceKind}`);
      assert.equal(outcome.group, 'resolved_pricing');
      assert.equal(outcome.eligible, true, `eligibility differed for ${outcome.sourceKind}`);
    }
    // ...and the value is still preserved as opaque provenance.
    const { candidate } = resolveGolden({ sourceKind: 'tdot_appendix_b_stitched_table' });
    assert.equal(candidate.sourceFamily.sourceKind, 'tdot_appendix_b_stitched_table');
    assert.equal(candidate.sourceFamily.adapterId, CONTRACT_PRICING_ASSEMBLY_ADAPTER_ID);
  });

  it('yields identical resolution for every source quality on identical content', () => {
    for (const sourceQuality of ['clean', 'partial', 'fallback', 'junk'] as const) {
      const { row } = resolveGolden({ sourceQuality });
      assert.equal(row.resolution.approval.eligible, true, `differed for ${sourceQuality}`);
    }
  });
});

// ── 15 ───────────────────────────────────────────────────────────────────────
describe('15. candidate and evidence ordering are deterministic', () => {
  it('produces byte-identical output across repeated adaptations', () => {
    const rows = [
      goldenVegetativeRow({ id: 'row-a' }),
      goldenVegetativeRow({ id: 'row-b', category: null }),
      goldenVegetativeRow({ id: 'row-c', rate: null, unit: null, category: null, rawText: undefined, description: '' }),
    ];
    const first = adaptAssembledPricingRows(rows, ADAPTER_CONTEXT);
    const second = adaptAssembledPricingRows(rows, ADAPTER_CONTEXT);
    assert.equal(JSON.stringify(first), JSON.stringify(second));

    assert.deepEqual(first.map((candidate) => candidate.candidateId), ['row-a', 'row-b', 'row-c']);
    assert.deepEqual(first.map((candidate) => candidate.ordinal), [0, 1, 2]);
  });

  it('keeps schedule coverage reconciled with candidate count', () => {
    const rows = [
      goldenVegetativeRow({ id: 'resolved-row' }),
      goldenVegetativeRow({ id: 'review-row', rate: null }),
      goldenVegetativeRow({
        id: 'excluded-row',
        category: null,
        unit: null,
        rate: null,
        description: 'General conditions paragraph',
        rawText: 'General conditions paragraph',
      }),
    ];
    const schedule = buildCanonicalPricingSchedule({
      scheduleId: GOLDEN_RATE_SCHEDULE.scheduleId,
      scheduleName: GOLDEN_RATE_SCHEDULE.scheduleName,
      rows: adaptAssembledPricingRows(rows, ADAPTER_CONTEXT).map((candidate) =>
        resolveCanonicalPricingRow(candidate),
      ),
    });

    assert.equal(schedule.coverage.candidateCount, 3);
    assert.equal(schedule.coverage.resolvedCount, 1);
    assert.equal(schedule.coverage.needsReviewCount, 1);
    assert.equal(schedule.coverage.excludedCount, 1);
    assert.equal(
      schedule.coverage.resolvedCount
      + schedule.coverage.needsReviewCount
      + schedule.coverage.excludedCount,
      schedule.coverage.candidateCount,
    );
  });

  it('does not let row order decide which document governs a schedule', () => {
    const resolve = (id: string, governingDocumentId: string) =>
      resolveCanonicalPricingRow(adaptAssembledPricingRow(goldenVegetativeRow({ id }), 0, {
        ...ADAPTER_CONTEXT,
        governingDocument: { documentId: governingDocumentId, family: 'contract', title: null },
      }));

    const agreeing = [resolve('row-a', 'contract-1'), resolve('row-b', 'contract-1')];
    assert.equal(
      buildCanonicalPricingSchedule({ rows: agreeing }).governingDocument?.documentId,
      'contract-1',
    );

    const disagreeing = [resolve('row-a', 'contract-1'), resolve('row-b', 'contract-2')];
    assert.equal(buildCanonicalPricingSchedule({ rows: disagreeing }).governingDocument, null);
    assert.equal(
      buildCanonicalPricingSchedule({ rows: [...disagreeing].reverse() }).governingDocument,
      null,
    );
  });
});

// ── 16 ───────────────────────────────────────────────────────────────────────
describe('16. canonical code contains no document- or page-specific rule', () => {
  const CANONICAL_SOURCES = [
    'lib/canonical/truth/envelope.ts',
    'lib/canonical/contract/pricing.ts',
    'lib/canonical/contract/pricingAdapter.ts',
    'lib/canonical/contract/pricingResolution.ts',
  ];

  /**
   * Tokens that would indicate Golden or other document-family assumptions
   * leaking into canonical code. `sourceKind` string LITERALS are included:
   * canonical code may carry the field, but must never name a value.
   */
  const FORBIDDEN_TOKENS = [
    'williamson',
    'aftermath',
    'goodlettsville',
    'tdot',
    'mdot',
    'appendix b',
    'exhibit a',
    'section 905',
    'allowed_categories',
    'expected_category_counts',
    'page_category_expectations',
    'vegetative',
    'cubic yard',
    'pickup truck',
    'pdf:table:p',
    '.pdf',
    'stitched',
    'bid_schedule',
  ];

  for (const relativePath of CANONICAL_SOURCES) {
    it(`keeps ${relativePath} free of document-specific tokens`, () => {
      const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8').toLowerCase();
      for (const token of FORBIDDEN_TOKENS) {
        assert.equal(
          source.includes(token),
          false,
          `${relativePath} must not reference '${token}'`,
        );
      }
    });

    it(`keeps ${relativePath} free of hardcoded page-number comparisons`, () => {
      const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8');
      // e.g. `page === 8`, `page == 11`, `row.page === 10`
      assert.equal(
        /\bpage\w*\s*===?\s*\d+/i.test(source),
        false,
        `${relativePath} must not compare a page to a literal number`,
      );
      // e.g. `rate !== 25`, `rate === 623`
      assert.equal(
        /\brate\w*\s*[!=]==?\s*\d+/i.test(source),
        false,
        `${relativePath} must not compare a rate to a literal number`,
      );
    });
  }
});
