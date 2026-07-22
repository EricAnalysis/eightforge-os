import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { completeEffectiveInvoiceLineCanonicalFields } from '@/lib/validator/effectiveInvoiceLineCompletion';

const WILLIAMSON_LINES = [
  ['1A', 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15'],
  ['1B', 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30'],
  ['1E', 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15'],
  ['1F', 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30'],
  ['5A', 'Tree Operations Hazardous Tree Removal 6-12 in'],
  ['6A', 'Tree Operations Hazardous Hanging Limb Removal >2" per tree'],
] as const;

describe('effective invoice-line canonical completion', () => {
  it('fills the canonical contract for all six Williamson 2026-002 lines', () => {
    const completed = WILLIAMSON_LINES.map(([lineCode, description], index) =>
      completeEffectiveInvoiceLineCanonicalFields({
        row: {
          id: `fact:invoice-2026-002:line:${index + 1}`,
          source_document_id: 'invoice-2026-002',
          invoice_id: 'invoice-row-2026-002',
          invoice_number: '2026-002',
          line_code: lineCode,
          line_description: description,
          billing_rate_key: lineCode,
          description_match_key: description.toLowerCase(),
          evidence_refs: [`invoice:page:1:line:${index + 1}`],
          raw_text: `${lineCode} ${description}`,
        },
        effectiveFactSource: 'legacy_typed_field',
      }),
    );

    assert.deepEqual(completed.map((line) => line.rate_code), [
      '1A', '1B', '1E', '1F', '5A', '6A',
    ]);
    assert.deepEqual(
      completed.map((line) => line.id),
      WILLIAMSON_LINES.map((_, index) => `fact:invoice-2026-002:line:${index + 1}`),
    );
    for (const [index, line] of completed.entries()) {
      assert.equal(line.billing_rate_key, WILLIAMSON_LINES[index]?.[0]);
      assert.equal(line.invoice_rate_key, `2026002::${WILLIAMSON_LINES[index]?.[0]}`);
      assert.equal(typeof line.canonical_category, 'string');
      assert.equal(typeof line.category_confidence, 'number');
      assert.deepEqual(line.evidence_refs, [`invoice:page:1:line:${index + 1}`]);
      assert.equal(line.raw_text, `${WILLIAMSON_LINES[index]?.[0]} ${WILLIAMSON_LINES[index]?.[1]}`);
      assert.deepEqual(
        {
          value: (line.line_code_resolution as Record<string, unknown>).value,
          source_field: (line.line_code_resolution as Record<string, unknown>).source_field,
          rate_code_origin: (line.line_code_resolution as Record<string, unknown>).rate_code_origin,
        },
        {
          value: WILLIAMSON_LINES[index]?.[0],
          source_field: 'line_code',
          rate_code_origin: 'system_derived',
        },
      );
    }
  });

  it('preserves every populated canonical field and evidence value exactly', () => {
    const evidenceRefs = ['invoice:page:2:line:7'];
    const existingResolution = {
      status: 'resolved',
      value: 'OPERATOR-RATE',
      source_field: 'rate_code',
      rate_code_origin: 'operator_asserted',
    };
    const row = {
      id: 'fact:invoice-doc:line:7',
      source_document_id: 'invoice-doc',
      invoice_id: 'invoice-row',
      invoice_number: 'INV-7',
      line_code: 'SOURCE-CODE',
      rate_code: 'OPERATOR-RATE',
      billing_rate_key: 'OPERATOR-BILLING-KEY',
      description_match_key: 'operator description key',
      invoice_rate_key: 'OPERATOR-INVOICE-KEY',
      canonical_category: 'operator_category',
      category_confidence: 0.777,
      line_code_resolution: existingResolution,
      evidence_refs: evidenceRefs,
      raw_text: 'exact operator evidence text',
    };

    const completed = completeEffectiveInvoiceLineCanonicalFields({
      row,
      effectiveFactSource: 'human_review',
    });

    assert.deepEqual(completed, row);
    assert.strictEqual(completed.evidence_refs, evidenceRefs);
    assert.strictEqual(completed.line_code_resolution, existingResolution);
  });

  it('preserves an asserted rate code and records operator provenance when resolution is missing', () => {
    const completed = completeEffectiveInvoiceLineCanonicalFields({
      row: {
        id: 'fact:invoice-doc:line:1',
        invoice_number: 'INV-1',
        line_code: 'EXTRACTED-1A',
        rate_code: 'OPERATOR-1A',
        description: 'Vegetative debris haul',
      },
      effectiveFactSource: 'human_review',
    });

    assert.equal(completed.rate_code, 'OPERATOR-1A');
    assert.deepEqual(
      {
        value: (completed.line_code_resolution as Record<string, unknown>).value,
        source_field: (completed.line_code_resolution as Record<string, unknown>).source_field,
        rate_code_origin: (completed.line_code_resolution as Record<string, unknown>).rate_code_origin,
        effective_fact_source: (completed.line_code_resolution as Record<string, unknown>).effective_fact_source,
      },
      {
        value: 'OPERATOR-1A',
        source_field: 'rate_code',
        rate_code_origin: 'operator_asserted',
        effective_fact_source: 'human_review',
      },
    );
  });

  it('uses existing quantity-leak rejection and raw-text recovery when deriving rate_code', () => {
    const completed = completeEffectiveInvoiceLineCanonicalFields({
      row: {
        id: 'fact:invoice-doc:line:1',
        invoice_number: '2026-002',
        line_code: '43894',
        quantity: 43894,
        raw_text: '1A Vegetative debris collection and haul',
      },
      effectiveFactSource: 'legacy_typed_field',
    });
    const resolution = completed.line_code_resolution as Record<string, unknown>;

    assert.equal(completed.line_code, '43894');
    assert.equal(completed.rate_code, '1A');
    assert.equal(resolution.source_field, 'raw_text');
    assert.equal(resolution.rate_code_origin, 'system_derived');
    assert.deepEqual(resolution.rejected_candidates, [{
      source_field: 'line_code',
      value: '43894',
      reason: 'matches_quantity',
    }]);
  });
});
