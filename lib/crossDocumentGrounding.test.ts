import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildDocumentIntelligence } from './documentIntelligence';
import type { DocumentIntelligenceOutput } from './types/documentIntelligence';

describe('cross-document grounding and reconciliation scope', () => {
  it('contract with Exhibit A signals uses strict evidence_v1 refs (no text_preview inference on confirm)', () => {
    const intelligence = buildDocumentIntelligence({
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
          text_preview: 'Compensation shall be based on unit prices in Exhibit A.',
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
    }) as DocumentIntelligenceOutput;

    const rates = intelligence.decisions.find((d) => d.rule_id === 'contract_governing_rates_confirmed');
    assert.ok(rates);
    assert.equal(rates?.reconciliation_scope, 'single_document');
    const refs = rates?.source_refs ?? [];
    assert.ok(refs.some((r) => r.includes('evidence_v1.section_signals.rate_section_pages')));
    assert.ok(!refs.some((r) => r.startsWith('inference:text_preview')));
  });

  it('emits inference-only risk when rate keywords appear without evidence_v1 section signals', () => {
    const intelligence = buildDocumentIntelligence({
      documentType: 'contract',
      documentTitle: 'Unit rate agreement',
      documentName: 'contract.pdf',
      projectName: 'Proj',
      extractionData: {
        fields: {
          typed_fields: { vendor_name: 'Beta Co' },
        },
        extraction: {
          text_preview: 'Contractor shall use the attached rate schedule for vegetative debris per cubic yard.',
          evidence_v1: {
            structured_fields: { contractor_name: 'Beta Co' },
            section_signals: {
              rate_section_present: false,
              unit_price_structure_present: false,
              time_and_materials_present: false,
            },
          },
        },
      },
      relatedDocs: [],
    }) as DocumentIntelligenceOutput;

    const risk = intelligence.decisions.find((d) => d.rule_id === 'contract_rate_schedule_inference_only');
    assert.ok(risk, 'expected rate inference risk for unit-rate model without section signals');
    assert.equal(risk?.reconciliation_scope, 'single_document');
  });

  it('invoice linked to contract marks ceiling comparison as cross_document with xref ids', () => {
    const intelligence = buildDocumentIntelligence({
      documentType: 'invoice',
      documentTitle: 'Pay app',
      documentName: 'inv.pdf',
      projectName: 'P1',
      extractionData: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-1',
            vendor_name: 'Acme Debris LLC',
            current_amount_due: 5000,
            g702_contract_sum: 2_500_000,
          },
        },
        extraction: { text_preview: '' },
      },
      relatedDocs: [
        {
          id: 'contract-xyz',
          document_type: 'contract',
          name: 'c.pdf',
          title: 'Contract',
          extraction: {
            fields: { typed_fields: { vendor_name: 'Acme Debris LLC', nte_amount: 2_500_000 } },
            extraction: { text_preview: '' },
          },
        },
      ],
    }) as DocumentIntelligenceOutput;

    const ceilingCmp = intelligence.comparisons?.find((c) => c.check.includes('G702'));
    assert.ok(ceilingCmp);
    assert.equal(ceilingCmp?.reconciliation_scope, 'cross_document');
    assert.ok((ceilingCmp?.source_refs_left ?? []).some((r) => r.includes('contract-xyz')));
    assert.ok((ceilingCmp?.source_refs_right ?? []).length > 0);
  });

  it('invoice vs contract ceiling mismatch carries cross_document decision refs', () => {
    const intelligence = buildDocumentIntelligence({
      documentType: 'invoice',
      documentTitle: 'Pay app',
      documentName: 'inv.pdf',
      projectName: 'P1',
      extractionData: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-1',
            vendor_name: 'Acme Debris LLC',
            current_amount_due: 5000,
            g702_contract_sum: 99_000_000,
          },
        },
        extraction: { text_preview: '' },
      },
      relatedDocs: [
        {
          id: 'contract-ceiling',
          document_type: 'contract',
          name: 'c.pdf',
          title: 'Contract',
          extraction: {
            fields: { typed_fields: { vendor_name: 'Acme Debris LLC', nte_amount: 30_000_000 } },
            extraction: { text_preview: '' },
          },
        },
      ],
    }) as DocumentIntelligenceOutput;

    const mismatch = intelligence.decisions.find((d) => d.rule_id === 'invoice_contract_ceiling_mismatch');
    assert.ok(mismatch);
    assert.equal(mismatch?.reconciliation_scope, 'cross_document');
    assert.ok((mismatch?.source_refs ?? []).some((r) => r.includes('contract-ceiling')));
  });

  it('ticket export vs linked invoice detects row-level quantity mismatch', () => {
    const intelligence = buildDocumentIntelligence({
      documentType: 'ticket',
      documentTitle: 'Export',
      documentName: 'tickets.xlsx',
      projectName: 'P1',
      extractionData: {
        fields: {
          typed_fields: {
            contractor_name: 'Acme',
            line_items: [
              { code: 'LINE-01', quantity: 40 },
            ],
          },
        },
        extraction: { text_preview: '' },
      },
      relatedDocs: [
        {
          id: 'invoice-rows',
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
    }) as DocumentIntelligenceOutput;

    const cmp = intelligence.comparisons?.find((c) => c.check.includes('Ticket export line'));
    assert.ok(cmp);
    assert.equal(cmp?.status, 'mismatch');
    assert.equal(cmp?.reconciliation_scope, 'cross_document');

    const dec = intelligence.decisions.find((d) => d.type === 'volume_cross_check');
    assert.ok(dec);
    assert.equal(dec?.reconciliation_scope, 'cross_document');
  });
});
