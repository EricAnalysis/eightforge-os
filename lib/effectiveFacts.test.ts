import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  collapseEffectiveFactRecords,
  type EffectiveFactRecord,
} from '@/lib/effectiveFacts';

function fact(params: Partial<EffectiveFactRecord> & Pick<EffectiveFactRecord, 'document_id' | 'key' | 'value' | 'source'>): EffectiveFactRecord {
  return {
    ...params,
    evidence: params.evidence ?? [{
      source_document_id: params.document_id,
      field_name: params.key,
    }],
  };
}

describe('effective fact resolution', () => {
  it('manual overrides replace stale machine scalar values and keep evidence', () => {
    const [resolved] = collapseEffectiveFactRecords([
      fact({
        document_id: 'invoice-doc-1',
        key: 'vendor_name',
        value: 'Stale Machine Vendor',
        source: 'legacy_typed_field',
      }),
      fact({
        document_id: 'invoice-doc-1',
        key: 'contractor_name',
        value: 'Corrected Vendor',
        source: 'human_override',
      }),
    ]);

    assert.equal(resolved?.key, 'contractor_name');
    assert.equal(resolved?.value, 'Corrected Vendor');
    assert.equal(resolved?.source, 'human_override');
    assert.equal(resolved?.evidence?.length, 1);
  });

  it('collapses reviewed rate table rows over stale machine rows by stable row identity', () => {
    const [resolved] = collapseEffectiveFactRecords([
      fact({
        document_id: 'contract-doc-1',
        key: 'rate_table',
        source: 'normalized_row',
        value: [{
          rate_code: '6A',
          description: 'Monitor tower',
          rate_amount: 80,
        }],
      }),
      fact({
        document_id: 'contract-doc-1',
        key: 'rate_table',
        source: 'human_review',
        value: [{
          rate_code: '6A',
          description: 'Monitor tower',
          rate_amount: 75,
        }],
      }),
    ]);

    assert.equal(resolved?.key, 'rate_table');
    assert.deepEqual(resolved?.value, [{
      rate_code: '6A',
      description: 'Monitor tower',
      rate_amount: 75,
    }]);
    assert.equal(resolved?.evidence?.length, 2);
  });

  it('collapses reviewed invoice lines over stale machine rows and preserves evidence', () => {
    const [resolved] = collapseEffectiveFactRecords([
      fact({
        document_id: 'invoice-doc-2',
        key: 'invoice_lines',
        source: 'normalized_row',
        value: [{
          invoice_number: 'INV-001',
          line_number: '4',
          rate_code: '1F',
          unit_price: 916,
          quantity: 916,
        }],
        evidence: [{
          source_document_id: 'invoice-doc-2',
          field_name: 'invoice_lines',
          source_label: 'machine invoice extraction',
          page_number: 3,
        }],
      }),
      fact({
        document_id: 'invoice-doc-2',
        key: 'invoice_line_items',
        source: 'human_review',
        value: [{
          invoice_number: 'INV-001',
          line_number: '4',
          rate_code: '1F',
          unit_price: 14.5,
          quantity: 916,
        }],
        evidence: [{
          source_document_id: 'invoice-doc-2',
          field_name: 'invoice_line_items',
          source_label: 'reviewed invoice line',
          page_number: 3,
        }],
      }),
    ]);

    assert.equal(resolved?.key, 'invoice_line_items');
    assert.deepEqual(resolved?.value, [{
      invoice_number: 'INV-001',
      line_number: '4',
      rate_code: '1F',
      unit_price: 14.5,
      quantity: 916,
    }]);
    assert.deepEqual(resolved?.evidence?.map((item) => (item as { source_label?: string }).source_label), [
      'reviewed invoice line',
      'machine invoice extraction',
    ]);
  });
});
