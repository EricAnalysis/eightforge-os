import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { CanonicalOperationalTableRow } from './canonicalOperationalTableRowAssembler';
import { buildCanonicalOperationalRateDiff } from './canonicalOperationalRateDiff';

function row(params: Partial<CanonicalOperationalTableRow> & {
  row_id: string;
  document_id: string;
  source_family: string;
}): CanonicalOperationalTableRow {
  return {
    row_id: params.row_id,
    document_id: params.document_id,
    source_family: params.source_family,
    source_table_key: params.source_table_key ?? 'table-1',
    source_document_family: params.source_document_family ?? params.source_family,
    assembly_semantic_mode: params.assembly_semantic_mode ?? (params.source_family === 'invoice' ? 'transactional' : 'schedule_definition'),
    row_role: params.row_role ?? (params.source_family === 'invoice' ? 'line_item' : 'unit_rate_definition'),
    category: params.category,
    description: params.description,
    unit: params.unit,
    unit_price: params.unit_price,
    mileage_tier: params.mileage_tier,
    site_type: params.site_type,
    service_item: params.service_item,
    confidence_penalties: params.confidence_penalties,
    ocr_normalization_actions: params.ocr_normalization_actions,
    ambiguity_flags: params.ambiguity_flags,
    raw_candidate_values: params.raw_candidate_values,
    warnings: params.warnings ?? [],
    confidence: params.confidence ?? 1,
    evidence_refs: params.evidence_refs ?? [{
      document_id: params.document_id,
      page_number: 1,
      table_key: params.source_table_key ?? 'table-1',
      row_index: 1,
      cell_index: 1,
      raw_text: params.description ?? params.row_id,
      field_assigned: 'description',
      confidence: 1,
    }],
    raw_fragments: params.raw_fragments ?? [],
  };
}

describe('buildCanonicalOperationalRateDiff', () => {
  it('matches invoice rows to contract schedule rows without relying on rate codes', () => {
    const diff = buildCanonicalOperationalRateDiff({
      project_id: 'project-1',
      invoice_document_id: 'invoice-1',
      contract_document_id: 'contract-1',
      generated_at: '2026-05-13T12:00:00.000Z',
      invoice_rows: [
        row({
          row_id: 'invoice:r1',
          document_id: 'invoice-1',
          source_family: 'invoice',
          description: 'Collect remove and haul 0-15 miles from ROW to DMS',
          unit: 'CY',
          unit_price: 7.25,
          mileage_tier: '0-15',
          site_type: 'ROW_to_DMS',
          category: 'Vegetative',
        }),
      ],
      contract_rows: [
        row({
          row_id: 'contract:r9',
          document_id: 'contract-1',
          source_family: 'contract',
          description: 'Vegetative debris collection 0-15 Miles from ROW to DMS',
          unit: 'Cubic Yard',
          unit_price: 6.9,
          mileage_tier: '0-15',
          site_type: 'ROW_to_DMS',
          category: 'Vegetative',
        }),
      ],
    });

    assert.equal(diff.project_id, 'project-1');
    assert.equal(diff.rows.length, 1);
    assert.equal(diff.rows[0]?.contract_row_id, 'contract:r9');
    assert.equal(diff.rows[0]?.variance_status, 'exceeds_ceiling');
    assert.equal(diff.rows[0]?.variance, 0.35);
    assert.ok((diff.rows[0]?.match_confidence ?? 0) >= 0.8);
    assert.ok(diff.rows[0]?.match_reasons.some((reason) => reason.includes('unit compatible')));
    assert.ok((diff.rows[0]?.invoice_evidence_refs.length ?? 0) > 0);
    assert.ok((diff.rows[0]?.contract_evidence_refs.length ?? 0) > 0);
  });

  it('keeps ambiguous high-confidence candidates explicit', () => {
    const diff = buildCanonicalOperationalRateDiff({
      invoice_document_id: 'invoice-1',
      contract_document_id: 'contract-1',
      invoice_rows: [
        row({
          row_id: 'invoice:r1',
          document_id: 'invoice-1',
          source_family: 'invoice',
          description: 'Vegetative debris haul 16-30 miles from ROW to DMS',
          unit: 'CY',
          unit_price: 7.9,
          mileage_tier: '16-30',
          site_type: 'ROW_to_DMS',
          category: 'Vegetative',
        }),
      ],
      contract_rows: [
        row({
          row_id: 'contract:a',
          document_id: 'contract-1',
          source_family: 'contract',
          description: 'Vegetative debris haul 16-30 miles from ROW to DMS',
          unit: 'Cubic Yard',
          unit_price: 7.9,
          mileage_tier: '16-30',
          site_type: 'ROW_to_DMS',
          category: 'Vegetative',
        }),
        row({
          row_id: 'contract:b',
          document_id: 'contract-1',
          source_family: 'contract',
          description: 'Vegetative debris haul 16-30 miles from ROW to DMS',
          unit: 'CY',
          unit_price: 8.1,
          mileage_tier: '16-30',
          site_type: 'ROW_to_DMS',
          category: 'Vegetative',
        }),
      ],
    });

    assert.equal(diff.rows[0]?.variance_status, 'ambiguous_match');
    assert.equal(diff.rows[0]?.contract_row_id, null);
    assert.equal(diff.rows[0]?.candidate_matches.length, 2);
    assert.ok(diff.rows[0]?.mismatch_reasons.some((reason) => reason.includes('ambiguous')));
    assert.equal(diff.summary.ambiguous_rows, 1);
  });

  it('surfaces no match and passthrough statuses without inventing rates', () => {
    const diff = buildCanonicalOperationalRateDiff({
      invoice_document_id: 'invoice-1',
      contract_document_id: 'contract-1',
      invoice_rows: [
        row({
          row_id: 'invoice:no-match',
          document_id: 'invoice-1',
          source_family: 'invoice',
          description: 'Emergency bridge repair',
          unit: 'EA',
          unit_price: 100,
          category: 'Bridge',
        }),
        row({
          row_id: 'invoice:pass',
          document_id: 'invoice-1',
          source_family: 'invoice',
          description: 'Disposal tipping fee',
          unit: 'TON',
          unit_price: undefined,
          category: 'Final Disposal',
        }),
      ],
      contract_rows: [
        row({
          row_id: 'contract:pass',
          document_id: 'contract-1',
          source_family: 'contract',
          row_role: 'passthrough_rate',
          description: 'Disposal tipping fee',
          unit: 'TON',
          unit_price: undefined,
          category: 'Final Disposal',
        }),
      ],
    });

    assert.equal(diff.rows.find((entry) => entry.invoice_row_id === 'invoice:no-match')?.variance_status, 'no_contract_match');
    assert.equal(diff.rows.find((entry) => entry.invoice_row_id === 'invoice:pass')?.variance_status, 'passthrough');
    assert.equal(diff.summary.unmatched_rows, 1);
    assert.equal(diff.summary.passthrough_rows, 1);
  });

  it('matches Williamson-style ROW to DMS mileage tiers and flags low-confidence contract rows', () => {
    const diff = buildCanonicalOperationalRateDiff({
      invoice_document_id: 'williamson-invoice',
      contract_document_id: 'williamson-contract',
      invoice_rows: [
        row({
          row_id: 'invoice:1B',
          document_id: 'williamson-invoice',
          source_family: 'invoice',
          description: 'Vegetative Collect Remove Haul 31-60 Miles from ROW to DMS',
          unit: 'CY',
          unit_price: 16,
          mileage_tier: '31-60',
          site_type: 'ROW_to_DMS',
          category: 'Vegetative',
        }),
      ],
      contract_rows: [
        row({
          row_id: 'contract:r5',
          document_id: 'williamson-contract',
          source_family: 'contract',
          row_role: 'mileage_tier_rate',
          description: 'Vegetative Collect, Remove & Haul 31-60 Miles from ROW to DMS',
          unit: undefined,
          unit_price: 15.5,
          mileage_tier: '31-60',
          site_type: 'ROW_to_DMS',
          confidence: 0.84,
          confidence_penalties: ['ocr-derived row', 'missing unit'],
        }),
      ],
    });

    assert.equal(diff.rows[0]?.contract_row_id, 'contract:r5');
    assert.equal(diff.rows[0]?.variance_status, 'low_confidence_contract_match');
    assert.equal(diff.rows[0]?.variance, 0.5);
    assert.ok(diff.rows[0]?.mismatch_reasons.includes('missing contract unit'));
    assert.ok(diff.rows[0]?.mismatch_reasons.some((reason) => reason.includes('below 0.85')));
    assert.equal(diff.summary.low_confidence_matches, 1);
  });

  it('penalizes OCR-normalized contract rates without treating them as authoritative', () => {
    const diff = buildCanonicalOperationalRateDiff({
      invoice_document_id: 'williamson-invoice',
      contract_document_id: 'williamson-contract',
      invoice_rows: [
        row({
          row_id: 'invoice:gnd',
          document_id: 'williamson-invoice',
          source_family: 'invoice',
          description: 'G&D Collect Remove Haul 31-60 Miles from ROW to DMS',
          unit: 'CY',
          unit_price: 8.9,
          mileage_tier: '31-60',
          site_type: 'ROW_to_DMS',
        }),
      ],
      contract_rows: [
        row({
          row_id: 'contract:ocr-normalized',
          document_id: 'williamson-contract',
          source_family: 'contract',
          description: 'G&D Collect, Remove & Haul 31-60 Miles from ROW to DMS',
          unit: 'CY',
          unit_price: 8.9,
          mileage_tier: '31-60',
          site_type: 'ROW_to_DMS',
          confidence: 0.84,
          ocr_normalization_actions: ['$890 -> 8.90'],
        }),
      ],
    });

    assert.equal(diff.rows[0]?.variance_status, 'low_confidence_contract_match');
    assert.ok(diff.rows[0]?.mismatch_reasons.includes('contract rate has OCR normalization action'));
    assert.ok(diff.rows[0]?.candidate_matches[0]?.quality_flags.includes('ocr-normalized contract rate'));
  });

  it('excludes ambiguous contract rows when a non-ambiguous candidate exists', () => {
    const diff = buildCanonicalOperationalRateDiff({
      invoice_document_id: 'invoice-1',
      contract_document_id: 'contract-1',
      invoice_rows: [
        row({
          row_id: 'invoice:r1',
          document_id: 'invoice-1',
          source_family: 'invoice',
          description: 'Management Reduction Compacting Vegetative Debris',
          unit: 'CY',
          unit_price: 1.5,
          category: 'Management',
        }),
      ],
      contract_rows: [
        row({
          row_id: 'contract:ambiguous',
          document_id: 'contract-1',
          source_family: 'contract',
          description: 'Management Reduction Compacting Vegetative Debris',
          unit: 'CY',
          unit_price: 1.5,
          category: 'Management',
          ambiguity_flags: ['ambiguous OCR rate cell'],
          raw_candidate_values: ['$1.00', '$1.50'],
        }),
        row({
          row_id: 'contract:clean',
          document_id: 'contract-1',
          source_family: 'contract',
          description: 'Management Reduction Compacting Vegetative Debris',
          unit: 'CY',
          unit_price: 1.5,
          category: 'Management',
        }),
      ],
    });

    assert.equal(diff.rows[0]?.contract_row_id, 'contract:clean');
    assert.equal(diff.rows[0]?.variance_status, 'within_ceiling');
    assert.equal(diff.rows[0]?.candidate_matches.some((candidate) => candidate.contract_row_id === 'contract:ambiguous'), false);
  });

  it('never silently selects an ambiguous contract row when it is the only candidate', () => {
    const diff = buildCanonicalOperationalRateDiff({
      invoice_document_id: 'invoice-1',
      contract_document_id: 'contract-1',
      invoice_rows: [
        row({
          row_id: 'invoice:r1',
          document_id: 'invoice-1',
          source_family: 'invoice',
          description: 'Management Reduction Compacting Vegetative Debris',
          unit: 'CY',
          unit_price: 1.5,
          category: 'Management',
        }),
      ],
      contract_rows: [
        row({
          row_id: 'contract:ambiguous',
          document_id: 'contract-1',
          source_family: 'contract',
          description: 'Management Reduction Compacting Vegetative Debris',
          unit: 'CY',
          unit_price: 1.5,
          category: 'Management',
          ambiguity_flags: ['ambiguous OCR rate cell'],
          raw_candidate_values: ['$1.00', '$1.50'],
        }),
      ],
    });

    assert.equal(diff.rows[0]?.contract_row_id, null);
    assert.equal(diff.rows[0]?.variance_status, 'ambiguous_match');
    assert.ok(diff.rows[0]?.mismatch_reasons.includes('best candidate has ambiguity flags'));
  });

  it('supports DMS to FDS matching when contract tiers are available', () => {
    const diff = buildCanonicalOperationalRateDiff({
      invoice_document_id: 'invoice-1',
      contract_document_id: 'contract-1',
      invoice_rows: [
        row({
          row_id: 'invoice:3B',
          document_id: 'invoice-1',
          source_family: 'invoice',
          description: 'Final Disposal 31-60 Miles from DMS to FDS',
          unit: 'CY',
          unit_price: 4.5,
          mileage_tier: '31-60',
          site_type: 'DMS_to_FDS',
          category: 'Final Disposal',
        }),
      ],
      contract_rows: [
        row({
          row_id: 'contract:3B',
          document_id: 'contract-1',
          source_family: 'contract',
          description: 'Final Disposal 31-60 Miles from DMS to Final Disposal',
          unit: 'Cubic Yard',
          unit_price: 4.25,
          mileage_tier: '31-60',
          site_type: 'DMS_to_FDS',
          category: 'Final Disposal',
        }),
      ],
    });

    assert.equal(diff.rows[0]?.contract_row_id, 'contract:3B');
    assert.equal(diff.rows[0]?.variance_status, 'exceeds_ceiling');
    assert.equal(diff.rows[0]?.variance, 0.25);
    assert.ok(diff.rows[0]?.match_reasons.some((reason) => reason.includes('site flow aligned')));
  });

  it('finds Williamson invoice candidates when recovered contract evidence exists', () => {
    const diff = buildCanonicalOperationalRateDiff({
      invoice_document_id: 'williamson-invoice',
      contract_document_id: 'williamson-contract',
      invoice_rows: [
        row({
          row_id: 'invoice:1A',
          document_id: 'williamson-invoice',
          source_family: 'invoice',
          description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
          unit: 'CY',
          unit_price: 6.9,
          mileage_tier: '0-15',
          site_type: 'ROW_to_DMS',
          category: 'Vegetative',
        }),
        row({
          row_id: 'invoice:5A',
          document_id: 'williamson-invoice',
          source_family: 'invoice',
          description: 'Tree Operations Hazardous Tree Removal 6-12 in',
          unit: 'TREE',
          unit_price: 95,
          category: 'Tree Operations',
        }),
        row({
          row_id: 'invoice:3C',
          document_id: 'williamson-invoice',
          source_family: 'invoice',
          description: 'Final Disposal Mulch DMS to FDS 31-60 miles',
          unit: 'CY',
          unit_price: 4.25,
          mileage_tier: '31-60',
          site_type: 'DMS_to_FDS',
          category: 'Final Disposal',
        }),
      ],
      contract_rows: [
        row({
          row_id: 'contract:1A',
          document_id: 'williamson-contract',
          source_family: 'contract',
          row_role: 'mileage_tier_rate',
          description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods 0-15 Miles from ROW to DMS',
          unit: 'CY',
          unit_price: 6.9,
          mileage_tier: '0-15',
          site_type: 'ROW_to_DMS',
          category: 'Vegetative',
        }),
        row({
          row_id: 'contract:5A',
          document_id: 'williamson-contract',
          source_family: 'contract',
          description: 'Tree Operations Hazardous Tree Removal 6-12 inch',
          unit: 'Tree',
          unit_price: 95,
          category: 'Tree Operations',
        }),
        row({
          row_id: 'contract:3C',
          document_id: 'williamson-contract',
          source_family: 'contract',
          row_role: 'mileage_tier_rate',
          description: 'Final Disposal 31-60 Miles from DMS to Final Disposal',
          unit: 'Cubic Yard',
          unit_price: 4.25,
          mileage_tier: '31-60',
          site_type: 'DMS_to_FDS',
          category: 'Final Disposal',
        }),
      ],
    });

    assert.deepEqual(diff.rows.map((entry) => entry.contract_row_id), ['contract:1A', 'contract:5A', 'contract:3C']);
    assert.equal(diff.summary.matched_rows, 3);
    assert.ok(diff.rows.every((entry) => entry.variance_status === 'within_ceiling'));
  });
});
