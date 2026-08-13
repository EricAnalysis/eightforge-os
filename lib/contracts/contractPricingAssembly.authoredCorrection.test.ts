import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  analyzeContractIntelligence,
  buildContractIntelligenceRateScheduleRows,
  buildContractRateScheduleSourceEntries,
  buildContractPricingSelectedCategoryOverrides,
} from '@/lib/contracts/analyzeContractIntelligence';
import {
  assembleContractPricingRows,
  assembleContractPricingRowsWithCandidates,
} from '@/lib/contracts/contractPricingAssembly';
import type { ContractRateScheduleRow } from '@/lib/contracts/types';
import type { NormalizedNodeDocument } from '@/lib/pipeline/types';
import { physicalPageFromExtractorIteration } from '@/lib/extraction/provenance/physicalPageCoordinate';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';

describe('contract pricing authored correction provenance', () => {
  it('wires the reviewed pricing scope resolver into contract intelligence', () => {
    const source = readFileSync('lib/contracts/analyzeContractIntelligence.ts', 'utf8');
    expect(source).toContain("from '@/lib/contracts/pricingSourceScope'");
    expect(source).toMatch(/\bresolvePricingSourceScope\s*\(/);
    expect(source).toMatch(/\bclassifyPageEligibility\s*\(/);
  });

  it('carries page provenance to source entries without changing pricing output or order', () => {
    const coordinate = physicalPageFromExtractorIteration({
      sourceArtifact: {
        id: opaqueIds.existingSourceArtifact('00000000-0000-4000-8000-000000000123'),
        source_document_id: 'contract-doc',
      },
      physicalPageNumber: 3,
      totalPhysicalPages: 5,
      sourceLayer: 'pdf_native_text',
      artifactLocalIndex: 2,
    });
    const baseEvidence = {
      id: 'contract-doc:legacy:text:3',
      kind: 'text' as const,
      source_type: 'pdf' as const,
      description: 'Rate schedule source',
      text: 'Hauling service | Cubic Yard | $14.00',
      location: { page: 3 },
      confidence: 0.9,
      weak: false,
      source_document_id: 'contract-doc',
    };
    const withoutProvenance = buildContractRateScheduleSourceEntries([baseEvidence]);
    const withProvenance = buildContractRateScheduleSourceEntries([{
      ...baseEvidence,
      physical_page_coordinate: coordinate,
    }]);

    expect(withProvenance).toEqual([{
      id: baseEvidence.id,
      page: 3,
      text: `${baseEvidence.text} ${baseEvidence.description}`,
      physicalPageCoordinate: coordinate,
    }]);
    expect(withoutProvenance.map(({ physicalPageCoordinate: _coordinate, ...entry }) => entry))
      .toEqual(withProvenance.map(({ physicalPageCoordinate: _coordinate, ...entry }) => entry));

    const document = {
      document_id: 'contract-doc',
      document_type: 'contract',
      document_name: 'contract.pdf',
      document_title: 'Contract',
      family: 'contract',
      is_primary: true,
      extraction_data: null,
      typed_fields: { rate_table: [] },
      structured_fields: {},
      section_signals: { rate_section_pages: [3] },
      text_preview: baseEvidence.text,
      evidence: [baseEvidence],
      gaps: [],
      confidence: 0.9,
      content_layers: null,
      extracted_record: {},
      facts: [],
      fact_map: {},
    } satisfies NormalizedNodeDocument;
    const baseline = buildContractIntelligenceRateScheduleRows({ primaryDocument: document });
    const threaded = buildContractIntelligenceRateScheduleRows({
      primaryDocument: {
        ...document,
        evidence: [{ ...baseEvidence, physical_page_coordinate: coordinate }],
      },
    });

    expect(threaded).toEqual(baseline);
    expect(threaded).toHaveLength(baseline.length);
    expect(threaded.map((row) => row.row_id)).toEqual(baseline.map((row) => row.row_id));
  });

  it('retains an analyzer-rescued category in the single coordinated selected view', () => {
    const structuralRow: ContractRateScheduleRow = {
      row_id: 'synthetic-tree-rescue-row',
      source_kind: undefined,
      category: null,
      source_category: 'Tree',
      material_type: 'Tree',
      canonical_category: null,
      category_confidence: null,
      description: 'Tree removal service',
      unit: 'Tree',
      unit_type: 'Tree',
      rate: 95,
      rate_amount: 95,
      page: 9,
      source_anchor_ids: ['synthetic:tree:1'],
      rate_raw: '$95.00',
    };
    const sourceScope = {
      documentId: 'synthetic-human-override-contract',
      sourceVersionIdentity: 'fixture-version-1',
    } as const;
    const selectedCategoryBySourceRow = buildContractPricingSelectedCategoryOverrides(
      [structuralRow],
      sourceScope,
      'authoritative_rate_schedule',
    );
    const result = assembleContractPricingRowsWithCandidates(
      [structuralRow],
      sourceScope,
      { selectedCategoryBySourceRow },
    );

    assert.deepEqual(result.selectedRows.map(({ id, category, unit, rate }) => ({
      id, category, unit, rate,
    })), [{
      id: 'synthetic-tree-rescue-row',
      category: 'Tree Operations',
      unit: 'Tree',
      rate: 95,
    }]);
    assert.deepEqual([...result.candidatesBySourceRow.values()], [[]]);
  });

  it('stamps the existing Williamson correction without changing its output values', () => {
    const [assembled] = assembleContractPricingRows([
      {
        row_id: 'exhibit_a_table:corrected',
        source_kind: 'exhibit_a_table',
        category: 'Vegetative Collect, Remove & Haul',
        description: 'from Rural Areas ROW to DMS 0 to 15 Miles',
        unit: 'Cubic Yard',
        rate: 18.8,
        page: 8,
        source_anchor_ids: [],
        rate_raw:
          'Vegetative Collect, Remove & Haul | from Rural Areas ROW to DMS 0 to 15 Miles | Cubic Yard | $18.80',
        material_type: 'Vegetative Collect, Remove & Haul',
        unit_type: 'Cubic Yard',
        rate_amount: 18.8,
      },
    ]);

    assert.equal(assembled?.rate, 13.5);
    assert.equal(assembled?.authoredValueCorrection, true);
  });

  it('does not stamp an ordinary Exhibit A row', () => {
    const [assembled] = assembleContractPricingRows([
      {
        row_id: 'exhibit_a_table:legitimate',
        source_kind: 'exhibit_a_table',
        category: 'Final Disposal',
        source_category: 'Final Disposal',
        canonical_category: 'final_disposal',
        description: 'Tipping Fee - Vegetative Debris',
        unit: 'Actual Cost',
        rate: null,
        page: 9,
        source_anchor_ids: ['pdf:table:p9:t33:r1'],
        rate_raw: 'Final Disposal | Tipping Fee - Vegetative Debris | Actual Cost | Passthrough',
        material_type: 'Final Disposal',
        unit_type: 'Actual Cost',
        rate_amount: null,
      },
    ]);

    assert.equal(assembled?.description, 'Tipping Fee - Vegetative Debris');
    assert.equal(assembled?.rate, null);
    assert.equal(assembled?.authoredValueCorrection, false);
  });

  it('persists only the correction flag alongside the original extracted row values', () => {
    const document = {
      document_id: 'contract-doc',
      document_type: 'contract',
      document_name: 'contract.pdf',
      document_title: 'Contract',
      family: 'contract',
      is_primary: true,
      extraction_data: null,
      typed_fields: {
        vendor_name: 'Test Vendor',
        rate_table: [
          {
            row_id: 'exhibit_a_table:corrected',
            source_kind: 'exhibit_a_table',
            category: 'Vegetative Collect, Remove & Haul',
            description: 'from Rural Areas ROW to DMS 0 to 15 Miles',
            unit: 'Cubic Yard',
            rate: 18.8,
            rate_amount: 18.8,
            page: 8,
            rate_raw:
              'Vegetative Collect, Remove & Haul | from Rural Areas ROW to DMS 0 to 15 Miles | Cubic Yard | $18.80',
          },
        ],
      },
      structured_fields: {},
      section_signals: {
        rate_section_present: true,
        rate_section_pages: [8],
      },
      text_preview: 'Exhibit A rate schedule.',
      evidence: [],
      gaps: [],
      confidence: 1,
      content_layers: null,
      extracted_record: {},
      facts: [],
      fact_map: {},
    } satisfies NormalizedNodeDocument;
    const sourceScope = {
      documentId: document.document_id,
      sourceVersionIdentity: 'test-source-version',
    } as const;
    const structuralRateScheduleRows = buildContractIntelligenceRateScheduleRows({
      primaryDocument: document,
    });
    const pricingAssembly = assembleContractPricingRowsWithCandidates(
      structuralRateScheduleRows,
      sourceScope,
    );

    const analysis = analyzeContractIntelligence({
      primaryDocument: document,
      relatedDocuments: [],
      pricingAssembly: {
        sourceScope,
        candidateInputRole: 'authoritative_rate_schedule',
        structuralRateScheduleRows,
        candidatesBySourceRow: pricingAssembly.candidatesBySourceRow,
      },
    });
    const persisted = analysis?.rate_schedule_rows?.[0];

    assert.equal(persisted?.rate, 18.8);
    assert.equal(persisted?.authoredValueCorrection, true);
  });
});
