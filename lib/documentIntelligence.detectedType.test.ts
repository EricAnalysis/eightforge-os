import { describe, expect, it } from 'vitest';

import { buildDocumentIntelligence } from '@/lib/documentIntelligence';

describe('document intelligence detected document type fallback', () => {
  it('uses extraction detected_document_type when the document row type is missing', () => {
    const intelligence = buildDocumentIntelligence({
      documentType: null,
      documentTitle: 'Upload',
      documentName: 'upload.pdf',
      projectName: 'Proj',
      extractionData: {
        fields: {
          detected_document_type: 'invoice',
          typed_fields: {
            schema_type: 'invoice',
            invoice_number: 'INV-42',
            vendor_name: 'Acme Debris LLC',
            total_amount: 9800,
            line_items: [],
            payment_terms: null,
            po_number: null,
            invoice_date: null,
          },
        },
        extraction: {
          text_preview: 'Invoice INV-42 total amount due $9,800.00',
        },
      },
      relatedDocs: [],
    });

    expect(intelligence.classification.family).toBe('invoice');
  });
});
