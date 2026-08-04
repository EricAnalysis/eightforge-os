/**
 * Real-fixture pricing boundary parity — EVALUATION ONLY.
 *
 * Executes the genuine extraction path on real corpus PDFs and measures every
 * boundary from source tables through canonical resolution.
 *
 * These tests read fixtures from an external corpus root that is NOT part of
 * the repository. When the root is absent every case is skipped with an
 * explicit message rather than silently passing — an absent fixture must never
 * read as a green result.
 *
 * Runtime is minutes, not seconds (real OCR). Run explicitly:
 *   npx vitest run lib/evaluation/canonicalPricingRealFixtureParity --testTimeout=1800000
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'vitest';

import { extractDocument } from '@/lib/server/documentExtraction';
import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import { adaptContractRateScheduleFragments } from '@/lib/operationalTables/adapters/contractRateScheduleFragmentAdapter';
import { assembleCanonicalOperationalTableRows } from '@/lib/operationalTables/canonicalOperationalTableRowAssembler';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { assembleContractPricingRows } from '@/lib/contracts/contractPricingAssembly';
import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
import {
  runPricingBoundaries,
  summarizeBoundaryReport,
  type PricingBoundaryReport,
} from '@/lib/evaluation/canonicalPricingBoundaryHarness';
import goldenTransportArtifact from '@/lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json';
import goldenFiveRowDifferential from '@/lib/evaluation/fixtures/goldenPricingFiveRowDifferential.json';

const GOLDEN_CORPUS_ROOT = process.env.GOLDEN_CORPUS_ROOT?.trim()
  ? resolve(process.env.GOLDEN_CORPUS_ROOT)
  : null;
const TRAINING_CORPUS_ROOT = GOLDEN_CORPUS_ROOT ? dirname(GOLDEN_CORPUS_ROOT) : null;

const FIXTURES = {
  golden: {
    id: 'golden',
    label: 'Golden Project (Williamson County)',
    path: GOLDEN_CORPUS_ROOT
      ? join(GOLDEN_CORPUS_ROOT, 'Williamson Co TN Fern 0126_Williamson Co TN Aftermath Fern 0126_Contract and Price Sheet_1.pdf')
      : null,
    documentType: 'contract',
    scheduleKind: 'unit_rate' as const,
    sourceFamily: 'contract' as const,
  },
  goodlettsville: {
    id: 'goodlettsville',
    label: 'Goodlettsville price sheet',
    // Byte-identical to the corpus copy (sha256 a9a0e653…); use the in-repo one.
    path: 'lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf',
    documentType: 'price_sheet',
    scheduleKind: 'price_sheet' as const,
    sourceFamily: 'price_sheet' as const,
  },
  tdot: {
    id: 'tdot',
    label: 'TDOT SWC 820 contract #89633',
    path: TRAINING_CORPUS_ROOT
      ? join(TRAINING_CORPUS_ROOT, 'TDOT', 'SWC 820 - Fern - Contract #89633 PHILLIPS HEAVY INC- PJ.pdf')
      : null,
    documentType: 'contract',
    scheduleKind: 'unit_rate' as const,
    sourceFamily: 'contract' as const,
  },
  mdot: {
    id: 'mdot',
    label: 'MDOT executed contractor agreement',
    path: TRAINING_CORPUS_ROOT
      ? join(TRAINING_CORPUS_ROOT, 'MDOT', '310225302000_Executed_Contractor.pdf')
      : null,
    documentType: 'contract',
    scheduleKind: 'unit_rate' as const,
    sourceFamily: 'contract' as const,
  },
} as const;

type FixtureSpec = (typeof FIXTURES)[keyof typeof FIXTURES];

function contentLayerTables(
  payload: Awaited<ReturnType<typeof extractDocument>>,
): PdfTable[] {
  const layers = payload.extraction.content_layers_v1 as
    | { pdf?: { tables?: { tables?: PdfTable[] } } }
    | undefined;
  return layers?.pdf?.tables?.tables ?? [];
}

async function runFixture(spec: FixtureSpec): Promise<PricingBoundaryReport> {
  if (!spec.path) throw new Error(`Fixture path is unavailable for ${spec.id}; configure GOLDEN_CORPUS_ROOT`);
  const bytes = readFileSync(spec.path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const payload = await extractDocument(
    {
      id: `${spec.id}-contract`,
      title: spec.label,
      name: `${spec.id}.pdf`,
      document_type: spec.documentType,
      storage_path: spec.path,
    },
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    'application/pdf',
    `${spec.id}.pdf`,
  );

  const tables = contentLayerTables(payload);
  const sourceTableRows = tables.reduce((total, table) => total + (table.rows?.length ?? 0), 0);

  // PRODUCTION PATH. `runDocumentPipeline` is what `processDocument` calls, so
  // `contractAnalysis.rate_schedule_rows` here is the genuine boundary-2 output
  // rather than a hand-assembled approximation of it.
  const pipeline = runDocumentPipeline({
    documentId: `${spec.id}-contract`,
    documentType: spec.documentType,
    documentName: `${spec.id}.pdf`,
    documentTitle: spec.label,
    projectName: null,
    // extractNode reads `extractionData.extraction.content_layers_v1`, so the
    // WHOLE payload is the input — not `payload.extraction`.
    extractionData: payload as unknown as Record<string, unknown>,
    relatedDocs: [],
  });
  const rateScheduleRows = pipeline.contractAnalysis?.rate_schedule_rows ?? [];

  // Reference-only comparison: the hand-assembled canonical-operational route
  // used by `goodlettsvillePriceSheet.test.ts`, which omits `pdfTables`. Kept
  // to expose configuration sensitivity, never used for the reported counts.
  const adapted = adaptContractRateScheduleFragments({
    document_id: `${spec.id}-contract`,
    source_family: spec.sourceFamily,
    tables,
    schedule_kind: spec.scheduleKind,
  });
  const assembly = assembleCanonicalOperationalTableRows({
    document_id: `${spec.id}-contract`,
    source_family: spec.sourceFamily,
    fragments: adapted.fragments,
  });
  const referenceRowsNoPdfTables = buildContractRateScheduleRows({
    documentType: spec.documentType,
    rateTable: [],
    canonicalRateScheduleAssembly: assembly,
  });
  console.log(
    `[fixture:${spec.id}:configSensitivity]`,
    JSON.stringify({
      productionPipelineRateRows: rateScheduleRows.length,
      referenceNoPdfTablesRateRows: referenceRowsNoPdfTables.length,
      referenceNoPdfTablesAssembled: assembleContractPricingRows(referenceRowsNoPdfTables).length,
    }),
  );

  const report = runPricingBoundaries({
    fixtureId: spec.id,
    documentId: `${spec.id}-contract`,
    rateScheduleRows,
    sourceTables: tables.length,
    sourceTableRows,
  });

  console.log(`[fixture:${spec.id}] sha256=${sha256}`);
  console.log(`[fixture:${spec.id}]`, summarizeBoundaryReport(report));
  console.log(
    `[fixture:${spec.id}:rejections]`,
    JSON.stringify(
      report.rejections.slice(0, 40).map((rejection) => ({
        reason: rejection.reason,
        boundary: rejection.boundary,
        fn: rejection.rejectingFunction,
        page: rejection.rawValues.page,
        unit: rejection.rawValues.unit,
        rate: rejection.rawValues.rate,
        category: rejection.rawValues.category,
        description: (rejection.rawValues.description ?? '').slice(0, 70),
      })),
    ),
  );
  console.log(
    `[fixture:${spec.id}:resolvedRows]`,
    JSON.stringify(
      report.schedule.rows.slice(0, 60).map((row) => ({
        group: row.resolution.displayGroup,
        state: row.resolution.state,
        eligible: row.resolution.approval.eligible,
        category: row.category.value,
        categoryState: row.category.state,
        description: (row.description.value ?? '').slice(0, 60),
        unit: row.unit.value,
        rate: row.rate.value,
        route: row.route.value,
        distanceBand: row.distanceBand.value,
        page: row.rate.governingSource?.page ?? null,
        anchor: row.rate.governingSource?.sourceAnchor ?? null,
        evidenceCount: row.resolution.evidenceCompleteness.evidenceRefCount,
        blockers: row.resolution.approval.blockers,
      })),
    ),
  );

  return report;
}

function describeFixture(spec: FixtureSpec): void {
  const available = spec.path != null && existsSync(spec.path);

  describe(`${spec.label}`, () => {
    if (!available) {
      it.skip(`SKIPPED — fixture unavailable (${spec.path ?? 'GOLDEN_CORPUS_ROOT not configured'})`, () => {
        /* intentionally skipped; absence is reported, never treated as a pass */
      });
      return;
    }

    it('runs every pricing boundary and reconciles the ledger', async () => {
      const report = await runFixture(spec);

      // No canonical loss: every emitted assembler row becomes a candidate.
      assert.equal(
        report.counts.canonicalCandidates,
        report.counts.assemblerOutputs,
        'the canonical adapter must never drop an emitted row',
      );

      // Coverage reconciles.
      const { candidateCount, resolvedCount, needsReviewCount, excludedCount } =
        report.schedule.coverage;
      assert.equal(resolvedCount + needsReviewCount + excludedCount, candidateCount);

      // The rejection ledger must account for every input row exactly once.
      assert.equal(
        report.counts.assemblerOutputs
        + report.counts.rowsMergedOrDeduped
        + report.counts.rowsSilentlyLost,
        report.counts.rateScheduleRows,
        'every input row must be emitted, suppressed, or attributed as lost',
      );

      if (spec.id === 'golden') {
        const expected = [
          { rate: 6.9, description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles', route: 'ROW to DMS', distance: '0 to 15 Miles' },
          { rate: 3.25, description: 'DMS to Final Disposal 0 to 15 Miles', route: 'DMS to Final Disposal', distance: '0 to 15 Miles' },
          { rate: 5.4, description: 'DMS to Final Disposal 60+ Miles', route: 'DMS to Final Disposal', distance: '60+ Miles' },
        ] as const;
        for (const item of expected) {
          const assemblyRow = report.assemblyRows.find((row) =>
            row.authoredValueCorrection && row.rate === item.rate && row.description === item.description);
          assert.ok(assemblyRow, `Golden authored-correction row ${item.rate} must survive assembly`);
          assert.equal(assemblyRow.route, item.route);
          assert.equal(assemblyRow.distanceBand, item.distance);
          assert.equal(assemblyRow.unit, 'Cubic Yard');
          assert.ok(assemblyRow.sourceAnchor);
          assert.ok((assemblyRow.geometryRefs?.length ?? 0) > 0 || assemblyRow.sourceAnchor);
          const canonicalRow = report.schedule.rows.find((row) => row.rowId === assemblyRow.id);
          assert.ok(canonicalRow);
          assert.equal(canonicalRow.route.value, item.route);
          assert.equal(canonicalRow.route.state, 'derived');
          assert.equal(canonicalRow.distanceBand.value, item.distance);
          assert.equal(canonicalRow.distanceBand.state, 'derived');
          assert.equal(canonicalRow.resolution.approval.eligible, false);
          assert.ok(canonicalRow.resolution.approval.blockers.includes('authored_value_correction'));
        }
        const actualArtifactRows = report.assemblyRows
            .filter((row) => row.authoredValueCorrection && expected.some((item) => item.rate === row.rate && item.description === row.description))
            .map((row) => ({
              id: row.id, category: row.category, description: row.description,
              route: row.route, distanceBand: row.distanceBand,
              pricingDimensions: row.pricingDimensions,
              pricingDimensionSources: row.pricingDimensionSources,
              unit: row.unit, rate: row.rate, page: row.page,
              sourceAnchor: row.sourceAnchor, confidence: row.confidence,
              sourceKind: row.sourceKind, sourceQuality: row.sourceQuality,
              authoredValueCorrection: row.authoredValueCorrection,
              rawText: row.rawText,
              evidenceRefs: (row.geometryRefs ?? []).map((ref) =>
                `${ref.geometry.row_id}:cell:${ref.geometry.cell_index}`),
            }));
        assert.equal(goldenTransportArtifact.sourcePdfSha256, '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f');
        assert.deepEqual(actualArtifactRows, goldenTransportArtifact.rows);

        const actualFiveRowAfter = goldenFiveRowDifferential.rows.map((expectedRow) => {
          const assemblyRow = report.assemblyRows.find((row) => row.id === expectedRow.id);
          assert.ok(assemblyRow, `five-row differential assembly row ${expectedRow.id}`);
          const canonicalRow = report.schedule.rows.find((row) => row.rowId === expectedRow.id);
          assert.ok(canonicalRow, `five-row differential canonical row ${expectedRow.id}`);
          return {
            description: assemblyRow.description,
            route: assemblyRow.route,
            distanceBand: assemblyRow.distanceBand,
            authoredValueCorrection: assemblyRow.authoredValueCorrection,
            displayGroup: canonicalRow.resolution.displayGroup,
            approvalEligible: canonicalRow.resolution.approval.eligible,
            blockers: canonicalRow.resolution.approval.blockers,
          };
        });
        assert.deepEqual(actualFiveRowAfter, goldenFiveRowDifferential.rows.map((row) => row.after));
        assert.deepEqual({
          rateScheduleRows: report.counts.rateScheduleRows,
          assemblerOutputs: report.counts.assemblerOutputs,
          resolved: report.schedule.coverage.resolvedCount,
          needsReview: report.schedule.coverage.needsReviewCount,
          excluded: report.schedule.coverage.excludedCount,
          mergedOrDeduped: report.counts.rowsMergedOrDeduped,
          silentlyLost: report.counts.rowsSilentlyLost,
          approvalEligible: report.schedule.rows.filter((row) => row.resolution.approval.eligible).length,
        }, goldenFiveRowDifferential.aggregateAfterRevision);
      }
    }, 1_800_000);
  });
}

describe('canonical pricing — real fixture parity', () => {
  describeFixture(FIXTURES.golden);
  describeFixture(FIXTURES.goodlettsville);
  describeFixture(FIXTURES.tdot);
  describeFixture(FIXTURES.mdot);
});
