import { describe, expect, it, vi } from 'vitest';

import { classifyDocumentFamily } from '@/lib/ai/instructor/classifyDocumentFamily';
import { maybeAssistTypedExtraction } from '@/lib/ai/instructor/extractionAssist';
import type { ExtractionGap } from '@/lib/extraction/types';

function mockClient(responses: Array<unknown | Error>) {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });

  return {
    client: {
      chat: {
        completions: {
          create,
        },
      },
    },
    create,
  };
}

describe('Instructor classification assist', () => {
  it('keeps deterministic classification when document type is already strong', async () => {
    const createClient = vi.fn();
    const result = await classifyDocumentFamily({
      documentType: 'contract',
      fileName: 'upload.pdf',
      title: 'Uploaded file',
      mimeType: 'application/pdf',
      textPreview: 'Some text',
      createClient,
    });

    expect(result.source).toBe('deterministic');
    expect(result.family).toBe('contract');
    expect(result.detected_document_type).toBe('contract');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('retries malformed model output before accepting a valid structured classification', async () => {
    const { client, create } = mockClient([
      { family: 'invoice' },
      {
        family: 'invoice',
        detected_document_type: 'invoice',
        confidence: 0.91,
        reasons: ['Amount due and vendor layout match an invoice.'],
      },
    ]);

    const result = await classifyDocumentFamily({
      documentType: null,
      fileName: 'upload.pdf',
      title: null,
      mimeType: 'application/pdf',
      textPreview: 'Current amount due $12,500 from Acme Debris LLC.',
      client,
    });

    expect(result.source).toBe('instructor');
    expect(result.family).toBe('invoice');
    expect(result.detected_document_type).toBe('invoice');
    expect(result.attempts).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('Instructor extraction assist', () => {
  it('skips extraction assist when extraction confidence is already strong', async () => {
    const { client, create } = mockClient([]);
    const result = await maybeAssistTypedExtraction({
      detectedDocumentType: 'invoice',
      currentTypedFields: {
        schema_type: 'invoice',
        invoice_number: 'INV-100',
        invoice_date: '2026-03-20',
        vendor_name: 'Acme Debris LLC',
        line_items: [],
        total_amount: 1200,
        payment_terms: null,
        po_number: null,
      },
      extractionConfidence: 0.91,
      gaps: [],
      textPreview: 'Invoice INV-100 from Acme Debris LLC total amount due $1,200.',
      client,
    });

    expect(result.snapshot).toBeNull();
    expect(result.mergedTypedFields?.schema_type).toBe('invoice');
    expect(create).not.toHaveBeenCalled();
  });

  it('retries malformed extraction output and merges only missing fields', async () => {
    const importantGaps: ExtractionGap[] = [
      {
        id: 'gap:plain_text_missing:1',
        category: 'plain_text_missing',
        severity: 'warning',
        message: 'Plain text blocks were sparse.',
        source: 'pdf',
      },
    ];
    const { client, create } = mockClient([
      { typed_fields: { schema_type: 'invoice' } },
      {
        typed_fields: {
          schema_type: 'invoice',
          invoice_number: 'INV-200',
          vendor_name: 'Acme Debris LLC',
          total_amount: 2450,
        },
        confidence: 0.82,
        reasons: ['Invoice number and total were visible in the preview.'],
      },
    ]);

    const result = await maybeAssistTypedExtraction({
      detectedDocumentType: 'invoice',
      currentTypedFields: {
        schema_type: 'invoice',
        invoice_number: 'INV-KEEP',
        invoice_date: null,
        vendor_name: null,
        line_items: [],
        total_amount: null,
        payment_terms: null,
        po_number: null,
      },
      extractionConfidence: 0.44,
      gaps: importantGaps,
      textPreview: 'Acme Debris LLC Current amount due $2,450.00.',
      client,
    });

    expect(result.snapshot?.status).toBe('applied');
    expect(result.snapshot?.attempts).toBe(2);
    expect(result.snapshot?.merged_field_keys).toContain('vendor_name');
    expect(result.snapshot?.merged_field_keys).toContain('total_amount');
    expect(result.mergedTypedFields).toMatchObject({
      schema_type: 'invoice',
      invoice_number: 'INV-KEEP',
      vendor_name: 'Acme Debris LLC',
      total_amount: 2450,
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('fails visibly when every extraction-assist attempt is malformed', async () => {
    const { client, create } = mockClient([
      { typed_fields: { schema_type: 'contract' } },
      new Error('provider timeout'),
      { typed_fields: { schema_type: 'invoice', invoice_number: 'INV-1' } },
    ]);

    const result = await maybeAssistTypedExtraction({
      detectedDocumentType: 'contract',
      currentTypedFields: null,
      extractionConfidence: 0.31,
      gaps: [
        {
          id: 'gap:missing_pdf_text_layer:1',
          category: 'missing_pdf_text_layer',
          severity: 'critical',
          message: 'Missing PDF text layer.',
          source: 'pdf',
        },
      ],
      textPreview: 'Emergency debris removal agreement after OCR recovery.',
      client,
    });

    expect(result.snapshot?.status).toBe('failed');
    expect(result.snapshot?.typed_fields).toBeNull();
    expect(result.mergedTypedFields).toBeNull();
    expect(result.snapshot?.warnings.length).toBeGreaterThan(0);
    expect(create).toHaveBeenCalledTimes(3);
  });
});
