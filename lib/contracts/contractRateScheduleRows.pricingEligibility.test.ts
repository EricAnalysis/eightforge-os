import { describe, expect, it } from 'vitest';
import {
  buildContractIntelligencePricingSourcePreparation,
} from '@/lib/contracts/analyzeContractIntelligence';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import {
  conflictingPhysicalPageCoordinate,
  physicalPageFromExtractorIteration,
} from '@/lib/extraction/provenance/physicalPageCoordinate';
import type { EvidenceObject } from '@/lib/extraction/types';
import type { NormalizedNodeDocument } from '@/lib/pipeline/types';

const DOCUMENT_ID = '10000000-0000-4000-8000-000000000001';
const ARTIFACT_ID = '20000000-0000-4000-8000-000000000001';

function coordinate(page: number) {
  return physicalPageFromExtractorIteration({
    sourceArtifact: {
      id: opaqueIds.existingSourceArtifact(ARTIFACT_ID),
      source_document_id: DOCUMENT_ID,
    },
    physicalPageNumber: page,
    totalPhysicalPages: 6,
    sourceLayer: 'pdf_native_text',
    artifactLocalIndex: page - 1,
  });
}

function evidence(id: string, page: number, text: string, withProof = true): EvidenceObject {
  return {
    id,
    kind: 'text',
    source_type: 'pdf',
    source_document_id: DOCUMENT_ID,
    description: `Source observation ${id}`,
    text,
    location: { page },
    confidence: 1,
    weak: false,
    ...(withProof ? { physical_page_coordinate: coordinate(page) } : {}),
  };
}

function document(params?: {
  historical?: boolean;
  captureState?: string;
  noContainer?: boolean;
  evidence?: EvidenceObject[];
  machinePages?: number[];
}): NormalizedNodeDocument {
  const rows = [
    { row_id: 'inside', description: 'Eligible hauling', unit: 'CY', rate: 11, page: 2 },
    { row_id: 'outside', description: 'Diagnostic hauling', unit: 'CY', rate: 99, page: 5 },
  ];
  return {
    document_id: DOCUMENT_ID,
    document_type: 'contract',
    document_name: 'source.pdf',
    document_title: 'Source',
    family: 'contract',
    is_primary: true,
    extraction_data: params?.noContainer
      ? null
      : params?.historical
      ? { extraction: { physical_page_provenance_v1: { capture_state: 'legacy_pre_provenance' } } }
      : {
          extraction: {
            physical_page_provenance_v1: {
              capture_state: params?.captureState ?? 'captured',
              source_artifact_id: ARTIFACT_ID,
              total_physical_pages: 6,
            },
          },
        },
    typed_fields: { rate_table: rows },
    structured_fields: {},
    section_signals: { rate_section_pages: params?.machinePages ?? [] },
    text_preview: '',
    evidence: params?.evidence ?? [
      evidence('inside-evidence', 2, 'Eligible hauling | CY | $11.00'),
      evidence('outside-evidence', 5, 'Diagnostic hauling | CY | $99.00'),
    ],
    gaps: [],
    confidence: 1,
    content_layers: null,
    extracted_record: {},
    facts: [],
    fact_map: {},
  };
}

describe('Phase 3A pricing observation eligibility', () => {
  it('keeps all observations visible while only authoritative proof enters rows', () => {
    const result = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document(),
      operatorRateSchedulePageRanges: [{ start: 2, end: 2 }],
      operatorRateSchedulePageHints: [2],
    });

    expect(result.rows.map((row) => row.rate)).toEqual([11]);
    expect(result.eligibility.scope.kind).toBe('authoritative');
    expect(result.eligibility.observationCount).toBe(2);
    expect(result.eligibility.canonicalEligibleCount).toBe(1);
    expect(result.eligibility.diagnosticOnlyCount).toBe(1);
    expect(result.eligibility.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ observationId: 'inside-evidence', reason: 'authoritative_scope_match' }),
      expect.objectContaining({ observationId: 'outside-evidence', reason: 'authoritative_scope_miss' }),
    ]));
  });

  it('does not widen valid operator authority when machine detection is empty or broader', () => {
    for (const machinePages of [[], [2, 5]]) {
      const result = buildContractIntelligencePricingSourcePreparation({
        primaryDocument: document({ machinePages }),
        operatorRateSchedulePageRanges: [{ start: 2, end: 2 }],
      });
      expect(result.rows.map((row) => row.rate)).toEqual([11]);
    }
  });

  it('keeps machine-only and no-scope modern observations diagnostic-only', () => {
    for (const machinePages of [[2], []]) {
      const result = buildContractIntelligencePricingSourcePreparation({
        primaryDocument: document({ machinePages }),
        operatorRateSchedulePageRanges: null,
      });
      expect(result.rows).toEqual([]);
      expect(result.eligibility.diagnosticOnlyCount).toBe(2);
      expect(result.eligibility.scope.kind).toBe(machinePages.length ? 'provisional' : 'no_scope');
    }
  });

  it('fails closed for blocked scope without accepting the resolved subset', () => {
    const result = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document(),
      operatorRateSchedulePageRanges: [{ start: 2, end: 7 }],
    });
    expect(result.rows).toEqual([]);
    expect(result.eligibility.scope).toMatchObject({
      kind: 'blocked',
      blockedReason: 'operator_range_out_of_bounds',
    });
  });

  it('fails closed for malformed and partially unresolved operator guidance', () => {
    const malformed = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document(),
      operatorRateSchedulePageRanges: [{ start: 2, end: Number.NaN }],
    });
    expect(malformed.rows).toEqual([]);
    expect(malformed.eligibility.scope.blockedReason).toBe('operator_range_malformed');

    const partial = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document(),
      operatorRateSchedulePageRanges: [{ start: 2, end: 3 }],
    });
    expect(partial.rows).toEqual([]);
    expect(partial.eligibility.scope).toMatchObject({
      kind: 'blocked',
      blockedReason: 'operator_range_unresolved_pages',
      blockedPages: [3],
    });
  });

  it('retains conflicting modern provenance as diagnostic-only', () => {
    const conflictedEvidence = evidence('conflicted', 2, 'Eligible hauling | CY | $11.00');
    conflictedEvidence.physical_page_coordinate = conflictingPhysicalPageCoordinate({
      sourceDocumentId: DOCUMENT_ID,
      sourceArtifactId: ARTIFACT_ID,
      sourceLayer: 'pdf_native_text',
      artifactLocalIndex: 1,
    });
    const result = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document({ evidence: [conflictedEvidence] }),
      operatorRateSchedulePageRanges: [{ start: 2, end: 2 }],
    });
    expect(result.rows).toEqual([]);
    expect(result.eligibility.observations[0]).toMatchObject({
      eligibility: 'diagnostic_only',
      reason: 'provenance_conflict',
    });
  });

  it('does not launder a modern raw page without proven coordinates into eligibility', () => {
    const result = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document({
        evidence: [evidence('unproven', 2, 'Eligible hauling | CY | $11.00', false)],
      }),
      operatorRateSchedulePageRanges: [{ start: 2, end: 2 }],
    });
    expect(result.rows).toEqual([]);
    expect(result.eligibility.observations[0]).toMatchObject({
      eligibility: 'diagnostic_only',
      reason: 'provenance_unresolved',
    });
  });

  it('preserves true pre-provenance pricing through explicit legacy compatibility', () => {
    const result = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document({ historical: true }),
      operatorRateSchedulePageRanges: null,
    });
    expect(result.rows.map((row) => row.rate)).toEqual([11, 99]);
    expect(result.eligibility.provenanceDisposition).toBe('legacy_pre_provenance');
    expect(result.eligibility.legacyCompatibilityCount).toBe(2);
    expect(new Set(result.eligibility.observations.map((entry) => entry.reason)))
      .toEqual(new Set(['legacy_compatibility']));
  });

  // ── Capture-state discrimination (Fix 1) ─────────────────────────────────
  it('never reads a missing provenance container as historical evidence', () => {
    const result = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document({ noContainer: true }),
      operatorRateSchedulePageRanges: null,
    });
    // Behaviour for pre-declaration records is preserved deliberately...
    expect(result.rows.map((row) => row.rate)).toEqual([11, 99]);
    // ...but the record must not claim these are pre-provenance.
    expect(result.eligibility.provenanceDisposition).toBe('unknown');
    expect(result.eligibility.legacyCompatibilityCount).toBe(0);
    expect(new Set(result.eligibility.observations.map((entry) => entry.reason)))
      .toEqual(new Set(['provenance_capture_unknown']));
  });

  it('treats a non-paginated source as its own topology, not as legacy compatibility', () => {
    const result = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document({ captureState: 'not_applicable_non_paginated' }),
      // Page ranges are meaningless for a source without pages; supplying them
      // must not blank the rows, and must not be recorded as a scope miss.
      operatorRateSchedulePageRanges: [{ start: 2, end: 2 }],
    });
    expect(result.rows.map((row) => row.rate)).toEqual([11, 99]);
    expect(result.eligibility.provenanceDisposition).toBe('not_applicable_non_paginated');
    expect(result.eligibility.pageScopeApplicable).toBe(false);
    expect(result.eligibility.legacyCompatibilityCount).toBe(0);
    expect(new Set(result.eligibility.observations.map((entry) => entry.reason)))
      .toEqual(new Set(['non_paginated_source']));
  });

  it('fails closed when a paginated source declares failed capture', () => {
    const result = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document({ captureState: 'capture_failed' }),
      operatorRateSchedulePageRanges: [{ start: 2, end: 2 }],
    });
    expect(result.rows).toEqual([]);
    expect(result.eligibility.canonicalOutcome).toBe('zero_rows_capture_failed');
    expect(new Set(result.eligibility.observations.map((entry) => entry.reason)))
      .toEqual(new Set(['provenance_capture_failed']));
  });

  it('fails closed on an unrecognized declared state rather than defaulting open', () => {
    const result = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document({ captureState: 'something_a_newer_writer_emits' }),
      operatorRateSchedulePageRanges: [{ start: 2, end: 2 }],
    });
    expect(result.rows).toEqual([]);
    expect(result.eligibility.provenanceDisposition).toBe('capture_failed');
  });

  // ── Zero-row explanation (Fix 2 diagnostic) ──────────────────────────────
  it('explains why canonical assembly received nothing instead of implying defect', () => {
    const cases = [
      [null as never, 'zero_rows_scope_absent'],
      [[{ start: 2, end: 7 }], 'zero_rows_scope_blocked'],
    ] as const;
    for (const [ranges, outcome] of cases) {
      const result = buildContractIntelligencePricingSourcePreparation({
        primaryDocument: document({ machinePages: [] }),
        operatorRateSchedulePageRanges: ranges,
      });
      expect(result.rows).toEqual([]);
      expect(result.eligibility.canonicalOutcome).toBe(outcome);
    }
    const present = buildContractIntelligencePricingSourcePreparation({
      primaryDocument: document(),
      operatorRateSchedulePageRanges: [{ start: 2, end: 2 }],
    });
    expect(present.eligibility.canonicalOutcome).toBe('canonical_rows_present');
  });
});
