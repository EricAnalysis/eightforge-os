import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { pipelineResultToIntelligence, runDocumentPipeline } from '@/lib/pipeline/documentPipeline';

describe('pipeline cross-document grounding (persisted canonical path)', () => {
  it('contract with Exhibit A section_signals carries strict rate refs and single_document scope', () => {
    const result = runDocumentPipeline({
      documentId: 'doc-contract-1',
      documentType: 'contract',
      documentTitle: 'Services Agreement',
      documentName: 'contract.pdf',
      projectName: 'Proj',
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'Acme Debris LLC',
            nte_amount: 2_500_000,
          },
        },
        extraction: {
          text_preview: '',
          evidence_v1: {
            structured_fields: {
              contractor_name: 'Acme Debris LLC',
              nte_amount: 2_500_000,
            },
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [14, 15],
              rate_section_label: 'Exhibit A — Unit Pricing',
              unit_price_structure_present: true,
              time_and_materials_present: false,
            },
          },
        },
      },
      relatedDocs: [],
    });
    const intel = pipelineResultToIntelligence(result);
    const rates = intel.decisions.find((d) => d.rule_id === 'contract_rate_schedule_confirmed');
    assert.ok(rates);
    assert.equal(rates?.reconciliation_scope, 'single_document');
    const refs = rates?.source_refs ?? [];
    assert.ok(refs.some((r) => r.includes('evidence_v1.section_signals.rate_section_pages')));
  });

  it('invoice linked to contract with ceiling breach emits cross_document xrefs on both sides', () => {
    const result = runDocumentPipeline({
      documentId: 'doc-inv-1',
      documentType: 'invoice',
      documentTitle: 'Pay app',
      documentName: 'inv.pdf',
      projectName: 'P1',
      extractionData: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-1',
            vendor_name: 'Acme Debris LLC',
            current_amount_due: 1_000_000,
          },
        },
        extraction: { text_preview: '' },
      },
      relatedDocs: [
        {
          id: 'contract-ceiling-1',
          document_type: 'contract',
          name: 'c.pdf',
          title: 'Contract',
          extraction: {
            fields: { typed_fields: { vendor_name: 'Acme Debris LLC', nte_amount: 500_000 } },
            extraction: {
              text_preview: '',
              evidence_v1: {
                structured_fields: { nte_amount: 500_000 },
                section_signals: { rate_section_present: true, rate_section_pages: [2] },
              },
            },
          },
        },
      ],
    });
    const intel = pipelineResultToIntelligence(result);
    const ceiling = intel.decisions.find((d) => d.rule_id === 'invoice_contract_ceiling_exceeded');
    assert.ok(ceiling);
    assert.equal(ceiling?.reconciliation_scope, 'cross_document');
    const srefs = ceiling?.source_refs ?? [];
    assert.ok(srefs.some((r) => r.includes('xref:scope:primary_document:fact:billed_amount')));
    assert.ok(srefs.some((r) => r.includes('contract-ceiling-1') && r.includes('contract_ceiling')));
  });

  it('invoice vs payment recommendation mismatch includes cross_document xrefs', () => {
    const result = runDocumentPipeline({
      documentId: 'doc-inv-pay',
      documentType: 'invoice',
      documentTitle: 'Pay app',
      documentName: 'inv.pdf',
      projectName: 'P1',
      extractionData: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-P',
            vendor_name: 'Acme Debris LLC',
            current_amount_due: 10_000,
          },
        },
        extraction: { text_preview: '' },
      },
      relatedDocs: [
        {
          id: 'payrec-1',
          document_type: 'payment_recommendation',
          name: 'pr.pdf',
          title: 'Pay rec',
          extraction: {
            fields: { typed_fields: { approved_amount: 9_500, invoice_number: 'INV-P' } },
            extraction: { text_preview: '' },
          },
        },
      ],
    });
    const intel = pipelineResultToIntelligence(result);
    const mismatch = intel.decisions.find((d) => d.rule_id === 'invoice_payment_recommendation_mismatch');
    assert.ok(mismatch);
    assert.equal(mismatch?.reconciliation_scope, 'cross_document');
    const srefs = mismatch?.source_refs ?? [];
    assert.ok(srefs.some((r) => r.includes('billed_amount')));
    assert.ok(srefs.some((r) => r.includes('payrec-1') && r.includes('approved_amount')));
  });

  it('invoice linked to contract within ceiling does not emit ceiling exceeded', () => {
    const result = runDocumentPipeline({
      documentId: 'doc-inv-2',
      documentType: 'invoice',
      documentTitle: 'Pay app',
      documentName: 'inv.pdf',
      projectName: 'P1',
      extractionData: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-2',
            vendor_name: 'Acme Debris LLC',
            current_amount_due: 400_000,
          },
        },
        extraction: { text_preview: '' },
      },
      relatedDocs: [
        {
          id: 'contract-ok',
          document_type: 'contract',
          name: 'c.pdf',
          title: 'Contract',
          extraction: {
            fields: { typed_fields: { vendor_name: 'Acme Debris LLC', nte_amount: 2_500_000 } },
            extraction: {
              text_preview: '',
              evidence_v1: {
                structured_fields: { nte_amount: 2_500_000 },
                section_signals: { rate_section_present: true, rate_section_pages: [1] },
              },
            },
          },
        },
      ],
    });
    const intel = pipelineResultToIntelligence(result);
    assert.equal(
      intel.decisions.some((d) => d.rule_id === 'invoice_contract_ceiling_exceeded'),
      false,
    );
  });

  it('ticket export linked to invoice flags row-level quantity mismatch with cross_document scope', () => {
    const result = runDocumentPipeline({
      documentId: 'doc-ticket-1',
      documentType: 'ticket',
      documentTitle: 'Export',
      documentName: 'tickets.xlsx',
      projectName: 'P1',
      extractionData: {
        fields: {
          typed_fields: {
            contractor_name: 'Acme',
          },
        },
        extraction: {
          text_preview: '',
          content_layers_v1: {
            spreadsheet: {
              detected_sheets: {
                sheets: [{ name: 'Tickets', classification: 'ticket_export' }],
              },
              normalized_ticket_export: {
                summary: {
                  row_count: 1,
                  missing_quantity_rows: 0,
                  missing_rate_rows: 0,
                },
                rows: [
                  {
                    id: 'nr1',
                    sheet_key: 'tickets',
                    sheet_name: 'Tickets',
                    row_number: 2,
                    ticket_id: 'TK-1',
                    quantity: 40,
                    unit: null,
                    rate: 12,
                    invoice_number: 'INV-1',
                    contract_line_item: 'LINE-01',
                    evidence_ref: 'ev:row:1',
                    field_evidence_ids: { quantity: 'ev:cell:qty', rate: 'ev:cell:rate' },
                    column_headers: {
                      quantity: 'Qty',
                      rate: 'Rate',
                      contract_line_item: 'Line',
                      ticket_id: 'Ticket',
                      invoice_number: 'Invoice',
                      unit: 'Unit',
                    },
                    confidence: 0.9,
                    missing_fields: [],
                  },
                ],
              },
              evidence: [
                {
                  id: 'ev:cell:qty',
                  kind: 'sheet_cell',
                  source_type: 'xlsx',
                  source_document_id: 'doc-ticket-1',
                  description: 'qty',
                  text: '40',
                  location: { sheet: 'Tickets', row: 2 },
                  confidence: 0.9,
                  weak: false,
                },
                {
                  id: 'ev:row:1',
                  kind: 'sheet_row',
                  source_type: 'xlsx',
                  source_document_id: 'doc-ticket-1',
                  description: 'row',
                  location: { sheet: 'Tickets', row: 2 },
                  confidence: 0.9,
                  weak: false,
                },
              ],
            },
          },
        },
      },
      relatedDocs: [
        {
          id: 'invoice-rows-1',
          document_type: 'invoice',
          name: 'inv.pdf',
          title: 'Invoice',
          extraction: {
            fields: {
              typed_fields: {
                line_items: [{ code: 'LINE-01', quantity: 38 }],
              },
            },
            extraction: { text_preview: '' },
          },
        },
      ],
    });
    const intel = pipelineResultToIntelligence(result);
    const mismatch = intel.decisions.find((d) => d.rule_id === 'volume_cross_check');
    assert.ok(mismatch);
    assert.equal(mismatch?.reconciliation_scope, 'cross_document');
    const refs = mismatch?.source_refs ?? [];
    assert.ok(refs.some((r) => r.includes('invoice-rows-1') && r.includes('line_items')));
  });
});
