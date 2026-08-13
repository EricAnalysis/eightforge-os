import { describe, expect, it } from 'vitest';
import { buildContractValidationContext } from '@/lib/validator/projectValidator';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import { physicalPageFromExtractorIteration } from '@/lib/extraction/provenance/physicalPageCoordinate';
import type {
  ValidatorDocumentRow,
  ValidatorFactRecord,
  ValidatorLegacyExtractionRow,
  ValidatorTruthCategoryDocumentIds,
} from '@/lib/validator/shared';

const DOCUMENT_ID = '30000000-0000-4000-8000-000000000001';
const ARTIFACT_ID = '40000000-0000-4000-8000-000000000001';

/** Coordinate as it survives persistence: plain JSON, runtime brand stripped. */
function persistedCoordinate(page: number, artifactLocalIndex = page - 1): unknown {
  return JSON.parse(JSON.stringify(physicalPageFromExtractorIteration({
    sourceArtifact: {
      id: opaqueIds.existingSourceArtifact(ARTIFACT_ID),
      source_document_id: DOCUMENT_ID,
    },
    physicalPageNumber: page,
    totalPhysicalPages: 4,
    sourceLayer: 'pdf_native_text',
    artifactLocalIndex,
  })));
}

function legacyRow(params: {
  withCoordinates: boolean;
  page?: number;
  artifactLocalIndex?: number;
}): ValidatorLegacyExtractionRow {
  const page = params.page ?? 2;
  return {
    document_id: DOCUMENT_ID,
    data: {
      extraction: {
        text_preview: 'Hauling per Cubic Yard $11.00',
        physical_page_provenance_v1: {
          capture_state: 'captured',
          source_artifact_id: ARTIFACT_ID,
          total_physical_pages: 4,
        },
        evidence_v1: {
          page_text: [
            {
              page_number: page,
              text: 'Hauling | CY | $11.00',
              source_method: 'pdf_text',
              ...(params.withCoordinates
                ? {
                    physical_page_coordinate: persistedCoordinate(
                      page,
                      params.artifactLocalIndex ?? page - 1,
                    ),
                  }
                : {}),
            },
          ],
        },
      },
    },
  } as unknown as ValidatorLegacyExtractionRow;
}

function contractDocument(): ValidatorDocumentRow {
  return {
    id: DOCUMENT_ID,
    name: 'contract.pdf',
    title: 'Contract',
    document_type: 'contract',
    intelligence_trace: null,
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
}) {
  return buildContractValidationContext({
    documents: [contractDocument()],
    factsByDocumentId: new Map<string, ValidatorFactRecord[]>(),
    legacyRowsByDocumentId: new Map([[DOCUMENT_ID, legacyRow(params)]]),
    truthCategoryDocumentIds,
  } as never);
}

describe('validator synthetic reconstruction carries physical page provenance', () => {
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
