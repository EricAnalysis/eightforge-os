import { describe, expect, it, vi } from 'vitest';

import { classifyDocumentFamily } from '@/lib/ai/instructor/classifyDocumentFamily';
import { maybeAssistTypedExtraction } from '@/lib/ai/instructor/extractionAssist';
import type { ExtractionGap } from '@/lib/extraction/types';
import type { InvoiceExtraction } from '@/lib/types/extractionSchemas';

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

function invoiceExtraction(overrides: Partial<InvoiceExtraction>): InvoiceExtraction {
  return {
    schema_type: 'invoice',
    invoice_number: null,
    invoice_status: null,
    invoice_date: null,
    period_start: null,
    period_end: null,
    period_through: null,
    vendor_name: null,
    client_name: null,
    line_items: [],
    line_item_count: null,
    subtotal_amount: null,
    total_amount: null,
    payment_terms: null,
    po_number: null,
    ...overrides,
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

  it('ignores the model client and routes deterministically while model-assist is disabled', async () => {
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

    expect(result.source).toBe('fallback');
    expect(result.family).toBe('generic');
    expect(result.detected_document_type).toBeNull();
    expect(result.attempts).toBe(0);
    expect(result.model).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(result.warnings).toContain(
      'Model-assisted document classification is disabled; deterministic routing only.',
    );
  });
});

describe('Instructor extraction assist', () => {
  it('skips extraction assist when extraction confidence is already strong', async () => {
    const { client, create } = mockClient([]);
    const result = await maybeAssistTypedExtraction({
      detectedDocumentType: 'invoice',
      currentTypedFields: invoiceExtraction({
        invoice_number: 'INV-100',
        invoice_date: '2026-03-20',
        vendor_name: 'Acme Debris LLC',
        total_amount: 1200,
      }),
      extractionConfidence: 0.91,
      gaps: [],
      textPreview: 'Invoice INV-100 from Acme Debris LLC total amount due $1,200.',
      client,
    });

    expect(result.snapshot).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('retries malformed extraction output and records it as non-authoritative evidence, never merged', async () => {
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
      currentTypedFields: invoiceExtraction({
        invoice_number: 'INV-KEEP',
      }),
      extractionConfidence: 0.44,
      gaps: importantGaps,
      textPreview: 'Acme Debris LLC Current amount due $2,450.00.',
      client,
    });

    expect(result.snapshot?.status).toBe('recorded');
    expect(result.snapshot?.authority).toBe('non_authoritative');
    expect(result.snapshot?.attempts).toBe(2);
    expect(result.snapshot?.merged_field_keys).toEqual([]);
    // invoice_number is already present deterministically, so it is not proposed.
    expect(result.snapshot?.proposed_field_keys).toEqual(['vendor_name', 'total_amount', 'current_amount_due']);
    expect(result.snapshot?.typed_fields).toMatchObject({
      schema_type: 'invoice',
      invoice_number: 'INV-200',
      vendor_name: 'Acme Debris LLC',
      total_amount: 2450,
    });
    expect(result).not.toHaveProperty('mergedTypedFields');
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
    expect(result.snapshot?.warnings.length).toBeGreaterThan(0);
    expect(create).toHaveBeenCalledTimes(3);
  });
});

describe('Instructor enablement', () => {
  it('is explicit opt-in: an OpenAI key alone never enables the assist', async () => {
    const { isInstructorEnabled } = await import('@/lib/ai/instructor/client');
    const saved = { key: process.env.OPENAI_API_KEY, flag: process.env.EIGHTFORGE_INSTRUCTOR_ENABLED };
    try {
      process.env.OPENAI_API_KEY = 'sk-test-not-real';
      for (const flag of [undefined, '', '0', 'true', 'yes', ' 1']) {
        if (flag === undefined) delete process.env.EIGHTFORGE_INSTRUCTOR_ENABLED;
        else process.env.EIGHTFORGE_INSTRUCTOR_ENABLED = flag;
        expect(`${String(flag)}:${isInstructorEnabled()}`).toBe(`${String(flag)}:false`);
      }
      process.env.EIGHTFORGE_INSTRUCTOR_ENABLED = '1';
      expect(isInstructorEnabled()).toBe(true);
      delete process.env.OPENAI_API_KEY;
      expect(isInstructorEnabled()).toBe(false);
    } finally {
      if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
      if (saved.flag === undefined) delete process.env.EIGHTFORGE_INSTRUCTOR_ENABLED;
      else process.env.EIGHTFORGE_INSTRUCTOR_ENABLED = saved.flag;
    }
  });
});
