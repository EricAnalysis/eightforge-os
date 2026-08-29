import { describe, expect, it } from 'vitest';
import { buildContractValidationContext } from '@/lib/validator/projectValidator';
import { buildContractIntelligencePricingSourcePreparation } from '@/lib/contracts/analyzeContractIntelligence';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import {
  conflictingPhysicalPageCoordinate,
  physicalPageFromExtractorIteration,
} from '@/lib/extraction/provenance/physicalPageCoordinate';
import type { ContractUploadGuidanceRow } from '@/lib/contracts/contractUploadGuidance';
import type {
  ValidatorDocumentRow,
  ValidatorFactRecord,
  ValidatorLegacyExtractionRow,
  ValidatorTruthCategoryDocumentIds,
} from '@/lib/validator/shared';
import type { ContractAnalysisResult, ContractRateScheduleRow } from '@/lib/contracts/types';

const DOCUMENT_ID = '30000000-0000-4000-8000-000000000001';
const ARTIFACT_ID = '40000000-0000-4000-8000-000000000001';

/** Coordinate as it survives persistence: plain JSON, runtime brand stripped. */
function resolvedCoordinate(
  page: number,
  artifactLocalIndex = page - 1,
  artifactId = ARTIFACT_ID,
) {
  return physicalPageFromExtractorIteration({
    sourceArtifact: {
      id: opaqueIds.existingSourceArtifact(artifactId),
      source_document_id: DOCUMENT_ID,
    },
    physicalPageNumber: page,
    totalPhysicalPages: 4,
    sourceLayer: 'pdf_native_text',
    artifactLocalIndex,
  });
}

function persistedCoordinate(
  page: number,
  artifactLocalIndex = page - 1,
  artifactId = ARTIFACT_ID,
): unknown {
  return JSON.parse(JSON.stringify(resolvedCoordinate(page, artifactLocalIndex, artifactId)));
}

function legacyRow(params: {
  withCoordinates: boolean;
  page?: number;
  artifactLocalIndex?: number;
  pages?: readonly number[];
  coordinateArtifactId?: string;
  conflictingCoordinate?: boolean;
}): ValidatorLegacyExtractionRow {
  const page = params.page ?? 2;
  const pages = params.pages ?? [page];
  return {
    document_id: DOCUMENT_ID,
    data: {
      extraction: {
        text_preview: pages.map((entry) => `Hauling | CY | $${entry + 9}.00`).join('\n'),
        physical_page_provenance_v1: {
          capture_state: 'captured',
          source_artifact_id: ARTIFACT_ID,
          total_physical_pages: 4,
        },
        evidence_v1: {
          page_text: pages.map((entry, index) =>
            ({
              page_number: entry,
              text: `Hauling | CY | $${entry + 9}.00`,
              source_method: 'pdf_text',
              ...(params.withCoordinates
                ? {
                    physical_page_coordinate: params.conflictingCoordinate
                      ? JSON.parse(JSON.stringify(conflictingPhysicalPageCoordinate({
                          sourceDocumentId: DOCUMENT_ID,
                          sourceArtifactId: ARTIFACT_ID,
                          sourceLayer: 'pdf_native_text',
                          artifactLocalIndex: entry - 1,
                        })))
                      : persistedCoordinate(
                          entry,
                          index === 0 && params.artifactLocalIndex != null
                            ? params.artifactLocalIndex
                            : entry - 1,
                          params.coordinateArtifactId,
                        ),
                  }
                : {}),
            })),
        },
      },
    },
  } as unknown as ValidatorLegacyExtractionRow;
}

function contractDocument(
  persistedRows?: readonly ContractRateScheduleRow[],
  persistedEligibility?: ContractAnalysisResult['pricing_source_eligibility'],
): ValidatorDocumentRow {
  return {
    id: DOCUMENT_ID,
    name: 'contract.pdf',
    title: 'Contract',
    document_type: 'contract',
    intelligence_trace: persistedRows
      ? {
          contract_analysis: {
            rate_schedule_rows: persistedRows,
            ...(persistedEligibility
              ? { pricing_source_eligibility: persistedEligibility }
              : {}),
          },
        }
      : null,
  } as unknown as ValidatorDocumentRow;
}

const truthCategoryDocumentIds: ValidatorTruthCategoryDocumentIds = {
  contract_identity: [DOCUMENT_ID],
  pricing: [DOCUMENT_ID],
  compliance: [],
  amendments: [],
};

function contextFor(params: {
  withCoordinates: boolean;
  page?: number;
  artifactLocalIndex?: number;
  pages?: readonly number[];
  coordinateArtifactId?: string;
  conflictingCoordinate?: boolean;
  operatorPageRanges?: unknown;
  machinePages?: readonly number[];
  guidanceDocumentId?: string;
  persistedRows?: readonly ContractRateScheduleRow[];
  persistedEligibility?: ContractAnalysisResult['pricing_source_eligibility'];
  humanOverride?: boolean;
}) {
  const contractUploadGuidance = params.operatorPageRanges == null
    ? null
    : {
        document_id: params.guidanceDocumentId ?? DOCUMENT_ID,
        rate_schedule_page_ranges: params.operatorPageRanges,
      } as ContractUploadGuidanceRow;
  return buildContractValidationContext({
    documents: [contractDocument(params.persistedRows, params.persistedEligibility)],
    factsByDocumentId: new Map<string, ValidatorFactRecord[]>((params.humanOverride || params.machinePages)
      ? [[DOCUMENT_ID, [
        ...(params.humanOverride ? [{
          id: 'human-override-fact',
          document_id: DOCUMENT_ID,
          key: 'rate_schedule_present',
          value: true,
          source: 'human_override',
          field_type: null,
          evidence: [],
        } satisfies ValidatorFactRecord] : []),
        ...(params.machinePages ? [{
          id: 'machine-pages-fact',
          document_id: DOCUMENT_ID,
          key: 'rate_schedule_pages',
          value: [...params.machinePages],
          source: 'legacy_section_signal',
          field_type: null,
          evidence: [],
        } satisfies ValidatorFactRecord] : []),
      ]]]
      : []),
    legacyRowsByDocumentId: new Map([[DOCUMENT_ID, legacyRow(params)]]),
    truthCategoryDocumentIds,
    contractUploadGuidance,
  } as never);
}

function pipelinePreparationFor(params: {
  pages: readonly number[];
  operatorPageRanges: unknown;
  machinePages?: readonly number[];
  withCoordinates?: boolean;
  coordinateArtifactId?: string;
  conflictingCoordinate?: boolean;
}) {
  return buildContractIntelligencePricingSourcePreparation({
    primaryDocument: {
      document_id: DOCUMENT_ID,
      document_type: 'contract',
      family: 'contract',
      extraction_data: {
        extraction: {
          physical_page_provenance_v1: {
            capture_state: 'captured',
            source_artifact_id: ARTIFACT_ID,
            total_physical_pages: 4,
          },
        },
      },
      evidence: params.pages.map((page) => ({
        id: `pipeline:p${page}`,
        kind: 'text',
        source_type: 'pdf',
        location: { page },
        text: `Hauling | CY | $${page + 9}.00`,
        ...(params.withCoordinates === false
          ? {}
          : {
              physical_page_coordinate: params.conflictingCoordinate
                ? conflictingPhysicalPageCoordinate({
                    sourceDocumentId: DOCUMENT_ID,
                    sourceArtifactId: ARTIFACT_ID,
                    sourceLayer: 'pdf_native_text',
                    artifactLocalIndex: page - 1,
                  })
                : resolvedCoordinate(page, page - 1, params.coordinateArtifactId),
            }),
      })),
      fact_map: {},
      section_signals: { rate_section_pages: params.machinePages ?? [] },
      typed_fields: { rate_table: [] },
      extracted_record: {},
      content_layers: null,
    } as never,
    operatorRateSchedulePageRanges: params.operatorPageRanges as never,
  });
}

describe('validator synthetic reconstruction carries physical page provenance', () => {
  it.each([
    ['equivalent', [2, 3]],
    ['broader', [2, 3, 4]],
    ['narrower', [2]],
    ['disjoint', [4]],
    ['absent', []],
  ])('matches pipeline authoritative classification when machine detection is %s', (
    _case,
    machinePages,
  ) => {
    const operatorPageRanges = [{ start: 2, end: 3 }];
    const pipeline = pipelinePreparationFor({
      pages: [2, 3, 4],
      operatorPageRanges,
      machinePages,
    }).eligibility;
    const validator = contextFor({
      withCoordinates: true,
      pages: [2, 3, 4],
      operatorPageRanges,
      machinePages,
    })?.analysis.pricing_source_eligibility;
    const classification = (eligibility: typeof pipeline | undefined) => ({
      scope: eligibility?.scope,
      canonicalOutcome: eligibility?.canonicalOutcome,
      observations: eligibility?.observations.map((entry) => ({
        physicalPageNumber: entry.physicalPageNumber,
        eligibility: entry.eligibility,
        reason: entry.reason,
      })),
    });

    expect(classification(validator)).toEqual(classification(pipeline));
    expect(validator?.scope.kind).toBe('authoritative');
    expect(validator?.observations.map((entry) => entry.reason)).toEqual([
      'authoritative_scope_match',
      'authoritative_scope_match',
      'authoritative_scope_miss',
    ]);
  });

  it.each([
    ['no guidance', null, 'no_scope', null],
    ['malformed', [null], 'blocked', 'operator_range_malformed'],
    ['out of bounds', [{ start: 2, end: 5 }], 'blocked', 'operator_range_out_of_bounds'],
    ['partially unresolved', [{ start: 2, end: 3 }], 'blocked', 'operator_range_unresolved_pages'],
  ])('matches pipeline fail-closed scope for %s', (
    _case,
    operatorPageRanges,
    expectedKind,
    expectedBlockedReason,
  ) => {
    const pipeline = pipelinePreparationFor({ pages: [2], operatorPageRanges }).eligibility;
    const validator = contextFor({
      withCoordinates: true,
      pages: [2],
      operatorPageRanges,
    })?.analysis.pricing_source_eligibility;

    expect(validator?.scope.kind).toBe(pipeline.scope.kind);
    expect(validator?.scope.blockedReason).toBe(pipeline.scope.blockedReason);
    expect(validator?.canonicalOutcome).toBe(pipeline.canonicalOutcome);
    expect(validator?.scope.kind).toBe(expectedKind);
    expect(validator?.scope.blockedReason).toBe(expectedBlockedReason);
  });

  it('matches pipeline rejection for a coordinate bound to the wrong source artifact', () => {
    const coordinateArtifactId = '40000000-0000-4000-8000-000000000099';
    const operatorPageRanges = [{ start: 2, end: 2 }];
    const pipeline = pipelinePreparationFor({
      pages: [2],
      operatorPageRanges,
      coordinateArtifactId,
    }).eligibility;
    const validator = contextFor({
      withCoordinates: true,
      pages: [2],
      operatorPageRanges,
      coordinateArtifactId,
    })?.analysis.pricing_source_eligibility;

    expect(validator?.scope.kind).toBe(pipeline.scope.kind);
    expect(validator?.canonicalOutcome).toBe(pipeline.canonicalOutcome);
    expect(validator?.observations.map((entry) => entry.reason))
      .toEqual(pipeline.observations.map((entry) => entry.reason));
  });

  it('matches pipeline rejection for conflicting physical-page provenance', () => {
    const operatorPageRanges = [{ start: 2, end: 2 }];
    const pipeline = pipelinePreparationFor({
      pages: [2],
      operatorPageRanges,
      conflictingCoordinate: true,
    }).eligibility;
    const validator = contextFor({
      withCoordinates: true,
      pages: [2],
      operatorPageRanges,
      conflictingCoordinate: true,
    })?.analysis.pricing_source_eligibility;

    expect(validator?.scope.kind).toBe(pipeline.scope.kind);
    expect(validator?.canonicalOutcome).toBe(pipeline.canonicalOutcome);
    expect(validator?.observations.map((entry) => entry.reason)).toEqual(['provenance_conflict']);
    expect(validator?.observations.map((entry) => entry.reason))
      .toEqual(pipeline.observations.map((entry) => entry.reason));
  });

  it('rehydrates persisted coordinates instead of degrading every observation to unproven', () => {
    const eligibility = contextFor({ withCoordinates: true })?.analysis.pricing_source_eligibility;

    expect(eligibility).toBeDefined();
    expect(eligibility?.provenanceDisposition).toBe('captured');
    // The proof survived the bridge: the page is known and artifact-bound.
    expect(eligibility?.observations.map((entry) => entry.physicalPageNumber)).toEqual([2]);
    expect(eligibility?.observations.map((entry) => entry.reason))
      .not.toContain('provenance_unresolved');
  });

  it('explains a zero-row reconstruction by cause rather than leaving it unexplained', () => {
    const eligibility = contextFor({ withCoordinates: true })?.analysis.pricing_source_eligibility;

    // No operator guidance reaches this reconstruction, so scope is legitimately
    // absent. That is a different statement from "proof was missing", and the
    // record has to say which one it was.
    expect(eligibility?.scope.kind).toBe('no_scope');
    expect(eligibility?.canonicalOutcome).toBe('zero_rows_scope_absent');
  });

  it('still reports unproven observations when no coordinate was persisted', () => {
    const eligibility = contextFor({ withCoordinates: false })?.analysis.pricing_source_eligibility;

    expect(eligibility?.observations.map((entry) => entry.physicalPageNumber)).toEqual([null]);
    // Per-observation, the missing proof is named exactly.
    expect(eligibility?.observations.map((entry) => entry.reason)).toEqual(['provenance_unresolved']);
    // At source level the absent scope still dominates: no proof, however good,
    // could have produced canonical rows without a scope to be inside of.
    expect(eligibility?.canonicalOutcome).toBe('zero_rows_scope_absent');
  });

  it('uses persisted operator page ranges as authoritative validator scope', () => {
    const context = contextFor({
      withCoordinates: true,
      operatorPageRanges: [{ start: 2, end: 2 }],
    });
    const eligibility = context?.analysis.pricing_source_eligibility;

    expect(eligibility?.scope.kind).toBe('authoritative');
    expect(eligibility?.scope.authoritativePages).toEqual([2]);
    expect(eligibility?.observations.map((entry) => entry.reason))
      .toEqual(['authoritative_scope_match']);
    expect(eligibility?.canonicalEligibleCount).toBe(1);
    expect(eligibility?.diagnosticOnlyCount).toBe(0);
    expect(eligibility?.canonicalOutcome).toBe('canonical_rows_present');
    expect(context?.analysis.rate_schedule_rows?.map((row) => row.rate)).toEqual([11]);
  });

  it.each([
    ['null member', [null]],
    ['non-array object', { start: 2, end: 2 }],
    ['reversed range', [{ start: 3, end: 2 }]],
  ])('fails closed for malformed persisted guidance: %s', (_case, operatorPageRanges) => {
    const eligibility = contextFor({
      withCoordinates: true,
      operatorPageRanges,
    })?.analysis.pricing_source_eligibility;

    expect(eligibility?.scope).toMatchObject({
      kind: 'blocked',
      blockedReason: 'operator_range_malformed',
    });
    expect(eligibility?.canonicalOutcome).toBe('zero_rows_scope_blocked');
  });

  it('does not apply guidance persisted for a different document', () => {
    const eligibility = contextFor({
      withCoordinates: true,
      operatorPageRanges: [{ start: 2, end: 2 }],
      guidanceDocumentId: '30000000-0000-4000-8000-000000000099',
    })?.analysis.pricing_source_eligibility;

    expect(eligibility?.scope.kind).toBe('no_scope');
    expect(eligibility?.canonicalOutcome).toBe('zero_rows_scope_absent');
  });

  it('records match and mismatch when modern persisted and reconstructed rows coexist', () => {
    const reconstructedContext = contextFor({
      withCoordinates: true,
      operatorPageRanges: [{ start: 2, end: 2 }],
    });
    const reconstructed = reconstructedContext?.analysis.rate_schedule_rows ?? [];
    const persistedEligibility = reconstructedContext?.analysis.pricing_source_eligibility;
    const matching = contextFor({
      withCoordinates: true,
      operatorPageRanges: [{ start: 2, end: 2 }],
      persistedRows: reconstructed,
      persistedEligibility,
      humanOverride: true,
    });
    const mismatchingRows = reconstructed.map((row) => ({ ...row, rate: 99, rate_amount: 99 }));
    const mismatching = contextFor({
      withCoordinates: true,
      operatorPageRanges: [{ start: 2, end: 2 }],
      persistedRows: mismatchingRows,
      persistedEligibility,
      humanOverride: true,
    });

    expect(matching?.analysis.pricing_reconstruction_parity).toEqual({
      status: 'match',
      persisted_row_count: 1,
      reconstructed_row_count: 1,
    });
    expect(mismatching?.analysis.pricing_reconstruction_parity).toEqual({
      status: 'mismatch',
      persisted_row_count: 1,
      reconstructed_row_count: 1,
    });
    expect(mismatching?.analysis.rate_schedule_rows?.map((row) => row.rate)).toEqual([99]);
  });

  it('rejects a coordinate whose artifact-local index disagrees with its owning page row', () => {
    const eligibility = contextFor({
      withCoordinates: true,
      page: 2,
      artifactLocalIndex: 2,
    })?.analysis.pricing_source_eligibility;

    expect(eligibility?.observations.map((entry) => entry.physicalPageNumber)).toEqual([null]);
    expect(eligibility?.observations.map((entry) => entry.reason)).toEqual(['provenance_unresolved']);
  });

  it('derives the local index from physical page identity rather than sparse array position', () => {
    const eligibility = contextFor({
      withCoordinates: true,
      page: 4,
      artifactLocalIndex: 3,
    })?.analysis.pricing_source_eligibility;

    expect(eligibility?.observations.map((entry) => entry.physicalPageNumber)).toEqual([4]);
  });
});
