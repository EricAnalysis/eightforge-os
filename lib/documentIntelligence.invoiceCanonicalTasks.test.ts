import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildDocumentIntelligence } from './documentIntelligence';
import type { DocumentIntelligenceOutput } from './types/documentIntelligence';

describe('canonical invoice task generation', () => {
  it('emits one taskType:upload_payment_rec when payment recommendation is absent', () => {
    const intelligence = buildDocumentIntelligence({
      documentType: 'invoice',
      documentTitle: 'Invoice',
      documentName: 'invoice.pdf',
      projectName: 'Test Project',
      extractionData: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-1',
            vendor_name: 'Acme Co',
            invoice_date: '2026-03-01',
            current_amount_due: 500,
          },
        },
        extraction: { text_preview: '' },
      },
      relatedDocs: [],
    }) as DocumentIntelligenceOutput;

    const keys = intelligence.tasks.map((t) => t.dedupeKey).filter(Boolean);
    assert.equal(keys.filter((k) => k === 'taskType:upload_payment_rec').length, 1);
  });

  it('emits taskType:verify_invoice_amount when amounts disagree', () => {
    const intelligence = buildDocumentIntelligence({
      documentType: 'invoice',
      documentTitle: 'Invoice',
      documentName: 'invoice.pdf',
      projectName: 'Test Project',
      extractionData: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-1',
            vendor_name: 'Acme Co',
            current_amount_due: 1000,
          },
        },
        extraction: { text_preview: '' },
      },
      relatedDocs: [
        {
          id: 'pr-1',
          document_type: 'payment_rec',
          name: 'rec.pdf',
          title: 'Payment rec',
          extraction: {
            fields: {
              typed_fields: {
                net_recommended_amount: 900,
              },
            },
            extraction: { text_preview: '' },
          },
        },
      ],
    }) as DocumentIntelligenceOutput;

    const keys = intelligence.tasks.map((t) => t.dedupeKey).filter(Boolean);
    assert.equal(keys.filter((k) => k === 'taskType:verify_invoice_amount').length, 1);
  });

  it('does not emit duplicate machine keys for the same gap', () => {
    const intelligence = buildDocumentIntelligence({
      documentType: 'invoice',
      documentTitle: 'Invoice',
      documentName: 'invoice.pdf',
      projectName: 'Test Project',
      extractionData: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-1',
            vendor_name: 'Acme Co',
            current_amount_due: 100,
          },
        },
        extraction: { text_preview: '' },
      },
      relatedDocs: [],
    }) as DocumentIntelligenceOutput;

    const keys = intelligence.tasks.map((t) => t.dedupeKey).filter(Boolean);
    const uploadPay = keys.filter((k) => k === 'taskType:upload_payment_rec');
    assert.equal(uploadPay.length, 1);
  });
});
