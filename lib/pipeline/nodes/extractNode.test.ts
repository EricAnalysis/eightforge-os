import { describe, expect, it } from 'vitest';

import { extractNode } from '@/lib/pipeline/nodes/extractNode';

describe('extract node family routing', () => {
  it('uses instructor classification family when document_type is missing', () => {
    const result = extractNode({
      documentId: 'doc-1',
      documentType: null,
      documentName: 'upload.pdf',
      documentTitle: 'Upload',
      projectName: 'Proj',
      extractionData: {
        fields: {
          detected_document_type: 'contract',
        },
        extraction: {
          text_preview: 'Emergency debris removal agreement',
          ai_assist_v1: {
            classification: {
              family: 'contract',
              detected_document_type: 'contract',
            },
          },
        },
      },
      relatedDocs: [],
    });

    expect(result.primaryDocument.family).toBe('contract');
  });

  it('rehydrates pdf text-block evidence before falling back to weak legacy page text', () => {
    const result = extractNode({
      documentId: 'doc-2',
      documentType: 'contract',
      documentName: 'contract.pdf',
      documentTitle: 'Contract',
      projectName: 'Proj',
      extractionData: {
        extraction: {
          text_preview: 'Master services agreement',
          evidence_v1: {
            page_text: [{
              page_number: 2,
              text: 'Legacy page text fallback that should not win',
              source_method: 'pdf_text',
            }],
          },
          content_layers_v1: {
            pdf: {
              confidence: 0.82,
              evidence: [],
              text: {
                confidence: 0.82,
                combined_text: 'Master services agreement\nCompensation and term provisions',
                pages: [{
                  page_number: 2,
                  line_count: 4,
                  plain_text_blocks: [{
                    id: 'pdf:text:block:2:1',
                    page_number: 2,
                    text: 'Compensation and term provisions',
                    line_start: 3,
                    line_end: 4,
                    nearby_text: 'Master services agreement',
                  }],
                }],
              },
            },
          },
        },
      },
      relatedDocs: [],
    });

    expect(result.primaryDocument.evidence).toHaveLength(1);
    expect(result.primaryDocument.evidence[0]).toMatchObject({
      id: 'pdf:text:block:2:1',
      kind: 'text',
      description: 'PDF text block on page 2',
      text: 'Compensation and term provisions',
      confidence: 0.82,
      weak: false,
      location: {
        page: 2,
        nearby_text: 'Master services agreement',
      },
      metadata: expect.objectContaining({
        source_document_id: 'doc-2',
        source_extraction_path: 'pdf_content_layers',
        line_start: 3,
        line_end: 4,
      }),
    });
    expect(result.primaryDocument.evidence[0]?.id).not.toContain(':legacy:text:');
  });

  it('still falls back to weak legacy page text when pdf content-layer evidence is truly empty', () => {
    const result = extractNode({
      documentId: 'doc-3',
      documentType: 'contract',
      documentName: 'empty.pdf',
      documentTitle: 'Empty',
      projectName: 'Proj',
      extractionData: {
        extraction: {
          text_preview: '',
          evidence_v1: {
            page_text: [{
              page_number: 1,
              text: 'Only page-level fallback text remains',
              source_method: 'pdf_text',
            }],
          },
          content_layers_v1: {
            pdf: {
              confidence: 0,
              evidence: [],
              text: {
                confidence: 0,
                combined_text: '',
                pages: [{
                  page_number: 1,
                  line_count: 0,
                  plain_text_blocks: [],
                }],
              },
            },
          },
        },
      },
      relatedDocs: [],
    });

    expect(result.primaryDocument.evidence).toHaveLength(1);
    expect(result.primaryDocument.evidence[0]).toMatchObject({
      id: 'doc-3:legacy:text:1',
      kind: 'text',
      text: 'Only page-level fallback text remains',
      confidence: 0.55,
      weak: true,
      metadata: expect.objectContaining({
        source_document_id: 'doc-3',
        source_extraction_path: 'legacy_evidence_v1_page_text',
      }),
    });
  });

  it('treats explicit transaction_data spreadsheets as spreadsheet-family documents', () => {
    const result = extractNode({
      documentId: 'doc-4',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query',
      projectName: 'Proj',
      extractionData: {
        fields: {
          detected_document_type: 'transaction_data',
        },
        extraction: {
          text_preview: 'ticket_query\nTransaction # | Invoice # | Unit Rate',
          ai_assist_v1: {
            classification: {
              family: 'spreadsheet',
              detected_document_type: 'transaction_data',
            },
          },
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              workbook: {
                sheet_count: 1,
              },
              normalized_transaction_data: {
                row_count: 12,
                rollups: {
                  total_extended_cost: 1200,
                  distinct_invoice_numbers: ['INV-100'],
                },
              },
            },
          },
        },
      },
      relatedDocs: [],
    });

    expect(result.primaryDocument.family).toBe('spreadsheet');
    expect(result.primaryDocument.extracted_record).toMatchObject({
      source_kind: 'xlsx',
      transaction_row_count: 12,
      total_extended_cost: 1200,
      distinct_invoice_number_count: 1,
    });
  });
});
