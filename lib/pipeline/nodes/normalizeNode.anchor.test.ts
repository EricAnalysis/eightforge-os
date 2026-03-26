import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { extractNode } from '@/lib/pipeline/nodes/extractNode';
import { normalizeNode } from '@/lib/pipeline/nodes/normalizeNode';
import type { EvidenceObject } from '@/lib/extraction/types';

function makePdfEvidence(params: {
  id: string;
  documentId: string;
  page: number;
  text: string;
  label?: string;
}): EvidenceObject {
  return {
    id: params.id,
    kind: 'text',
    source_type: 'pdf',
    source_document_id: params.documentId,
    description: params.text,
    text: params.text,
    location: {
      page: params.page,
      label: params.label ?? params.text,
    },
    confidence: 0.9,
    weak: false,
  };
}

describe('normalizeNode anchor resolution', () => {
  it('attaches value_fallback evidence refs for contract facts when labels miss but text matches typed value', () => {
    const documentId = 'contract-anchor-test';
    const ev = makePdfEvidence({
      id: 'ev-random-label',
      documentId,
      page: 2,
      text: 'The contractor shall be Looks Great Services of MS, Inc. for debris removal.',
      label: 'Scope section',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'c.pdf',
      documentTitle: 'C',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'Looks Great Services of MS, Inc.',
          },
        },
        extraction: {
          text_preview: 'Looks Great Services',
          content_layers_v1: {
            pdf: {
              evidence: [ev],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const contractor = normalized.primaryDocument.fact_map.contractor_name;
    assert.ok(contractor);
    assert.equal(contractor.evidence_refs.length, 1);
    assert.equal(contractor.evidence_refs[0], 'ev-random-label');
    assert.equal(contractor.evidence_resolution, 'value_fallback');
    assert.equal(contractor.missing_source_context.length, 0);
  });

  it('attaches value_fallback for invoice amount when regex misses but amount appears in evidence', () => {
    const documentId = 'invoice-anchor-test';
    const ev = makePdfEvidence({
      id: 'ev-misc',
      documentId,
      page: 1,
      text: 'Please remit $9,800.00 within 30 days.',
      label: 'Payment terms',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'invoice',
      documentName: 'i.pdf',
      documentTitle: 'I',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            current_amount_due: 9800,
          },
        },
        extraction: {
          text_preview: 'invoice',
          content_layers_v1: {
            pdf: {
              evidence: [ev],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const billed = normalized.primaryDocument.fact_map.billed_amount;
    assert.ok(billed);
    assert.equal(billed.evidence_resolution, 'value_fallback');
    assert.ok(billed.evidence_refs.includes('ev-misc'));
  });

  it('prefers evidence-backed contract values over weak typed and heuristic fields', () => {
    const documentId = 'contract-evidence-priority-test';
    const contractorEvidence = makePdfEvidence({
      id: 'ev-contract-page-1',
      documentId,
      page: 1,
      text: 'Contractor: R & J Land Clearing LLC Letting Date: 8/26/2025 Contract Execution: 09/08/2025',
      label: 'Page 1',
    });
    const termEvidence = makePdfEvidence({
      id: 'ev-contract-page-10',
      documentId,
      page: 10,
      text: 'The date of availability for this contract is September 22, 2025. The completion date for this contract is September 21, 2026.',
      label: 'Page 10',
    });
    const totalBidEvidence = makePdfEvidence({
      id: 'ev-contract-page-106',
      documentId,
      page: 106,
      text: 'Total Amount Of Bid For Entire Project: $1,934,700.00',
      label: 'Page 106',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'dn12189513.pdf',
      documentTitle: 'DN12189513 CONTRACT',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name:
              'the Federal Government defining the extent of construction work to be undertaken in accordance with the submitted plans',
            contract_date: '8/26/2025',
            effective_date: '09/08/2025',
          },
        },
        extraction: {
          text_preview: 'Contractor: R & J Land Clearing LLC',
          evidence_v1: {
            structured_fields: {
              contractor_name: 'R & J Land Clearing LLC',
              contractor_name_source: 'heuristic',
              term_start_date: '2015-01-01',
              term_end_date: '2022-01-29',
              nte_amount: 143,
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [contractorEvidence, termEvidence, totalBidEvidence],
              tables: {
                tables: [],
              },
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.contractor_name?.value, 'R & J Land Clearing LLC');
    assert.equal(facts.executed_date?.value, '09/08/2025');
    assert.equal(facts.term_start_date?.value, 'September 22, 2025');
    assert.equal(facts.term_end_date?.value, 'September 21, 2026');
    assert.equal(facts.contract_ceiling?.value, 1934700);
    assert.ok(facts.contractor_name?.evidence_refs.includes('ev-contract-page-1'));
    assert.ok(facts.term_start_date?.evidence_refs.includes('ev-contract-page-10'));
    assert.ok(facts.term_end_date?.evidence_refs.includes('ev-contract-page-10'));
    assert.ok(facts.contract_ceiling?.evidence_refs.includes('ev-contract-page-106'));
  });

  it('keeps explicit contract ceiling evidence ahead of total bid fallback', () => {
    const documentId = 'contract-ceiling-precedence-test';
    const totalBidEvidence = makePdfEvidence({
      id: 'ev-contract-bid-total',
      documentId,
      page: 12,
      text: 'Total Amount Of Bid For Entire Project: $1,934,700.00',
      label: 'Page 12',
    });
    const explicitCeilingEvidence = makePdfEvidence({
      id: 'ev-contract-nte',
      documentId,
      page: 3,
      text: 'The maximum contract amount is $2,500,000.00 and is not to exceed that amount without written approval.',
      label: 'Page 3',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'nte-and-bid.pdf',
      documentTitle: 'NTE and Bid Contract',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            nte_amount: 2500000,
          },
        },
        extraction: {
          text_preview: 'NTE and bid contract',
          evidence_v1: {
            structured_fields: {
              nte_amount: 123,
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [totalBidEvidence, explicitCeilingEvidence],
              tables: {
                tables: [],
              },
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const contractCeiling = normalized.primaryDocument.fact_map.contract_ceiling;

    assert.equal(contractCeiling?.value, 2500000);
    assert.deepEqual(contractCeiling?.evidence_refs, ['ev-contract-nte']);
  });
});
