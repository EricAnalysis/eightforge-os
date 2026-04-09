import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import { extractInvoiceTypedFields } from '@/lib/invoices/invoiceParser';
import { extractNode } from '@/lib/pipeline/nodes/extractNode';
import { normalizeNode } from '@/lib/pipeline/nodes/normalizeNode';
import type { EvidenceObject } from '@/lib/extraction/types';
import { parseContractEvidenceV1 } from '@/lib/server/documentEvidencePipelineV1';

function makePdfEvidence(params: {
  id: string;
  documentId: string;
  page: number;
  text: string;
  label?: string;
  nearbyText?: string;
  value?: string | null;
}): EvidenceObject {
  return {
    id: params.id,
    kind: 'text',
    source_type: 'pdf',
    source_document_id: params.documentId,
    description: params.text,
    text: params.text,
    ...(typeof params.value === 'string' ? { value: params.value } : {}),
    location: {
      page: params.page,
      label: params.label ?? params.text,
      ...(typeof params.nearbyText === 'string' ? { nearby_text: params.nearbyText } : {}),
    },
    confidence: 0.9,
    weak: false,
  };
}

function makeRateTable(params: {
  id: string;
  page: number;
  rowStart: number;
  unitContext: string;
  descriptionA: string;
  descriptionB: string;
}): Record<string, unknown> {
  return {
    id: params.id,
    page_number: params.page,
    headers: ['County A', 'County B'],
    header_context: [
      'UNIT RATE PRICE FORM: DOT (EMERG03)',
      params.unitContext,
    ],
    rows: [
      {
        id: `${params.id}:r1`,
        page_number: params.page,
        row_index: 1,
        cells: [
          { column_index: 0, text: `${params.rowStart}. ${params.descriptionA}` },
          { column_index: 1, text: '6.90' },
          { column_index: 2, text: '7.10' },
        ],
        raw_text: `${params.rowStart}. ${params.descriptionA} 6.90 7.10`,
      },
      {
        id: `${params.id}:r2`,
        page_number: params.page,
        row_index: 2,
        cells: [
          { column_index: 0, text: `${params.rowStart + 1}. ${params.descriptionB}` },
          { column_index: 1, text: '8.90' },
          { column_index: 2, text: '9.10' },
        ],
        raw_text: `${params.rowStart + 1}. ${params.descriptionB} 8.90 9.10`,
      },
    ],
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

  it('grounds billed amount from the invoice totals section when Williamson cover totals and line groups are visible', () => {
    const documentId = 'invoice-williamson-cover';
    const text = [
      'INVOICE',
      'Invoice Number: 2026-002',
      'Invoice Date: 04/03/2026',
      'Vendor: Aftermath Disaster Recovery, Inc.',
      'Bill To: Williamson County, Tennessee',
      'Service Period: 02/23/2026 through 03/18/2026',
      '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894 CYD $6.90 $302,868.60',
      '1B Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 12,250 CYD $7.90 $96,775.00',
      '1E Vegetative Collect Remove Haul Rural Areas ROW to DMS 3,099 CYD $13.50 $41,836.50',
      '1F Vegetative Collect Remove Haul Rural Areas ROW to DMS 916 CYD $14.50 $13,282.00',
      '5A Tree Operations Hazardous Tree Removal 5 EA $95.00 $475.00',
      '6A Tree Operations Hazardous Hanging Limb Removal 994 EA $80.00 $79,520.00',
      'Subtotal $534,757.10',
      'TOTAL $534,757.10',
    ].join('\n');

    const contentLayers = {
      pdf: {
        evidence: [] as EvidenceObject[],
        forms: {
          fields: [
            {
              id: 'form:williamson:number',
              page_number: 1,
              label: 'Invoice Number',
              value: '2026-002',
              confidence: 0.95,
            },
            {
              id: 'form:williamson:period',
              page_number: 1,
              label: 'Service Period',
              value: '02/23/2026 through 03/18/2026',
              confidence: 0.95,
            },
          ],
        },
        tables: {
          tables: [
            {
              id: 'table:williamson:lines',
              page_number: 1,
              headers: ['Code', 'Description', 'Qty', 'Unit', 'Unit Price', 'Amount'],
              header_context: [],
              confidence: 0.94,
              rows: [
                {
                  id: 'table:williamson:lines:r1',
                  page_number: 1,
                  row_index: 1,
                    cells: [
                      { column_index: 0, text: '1A' },
                      { column_index: 1, text: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS' },
                      { column_index: 2, text: '43,894.00' },
                      { column_index: 3, text: 'CYD' },
                      { column_index: 4, text: '6.90' },
                      { column_index: 5, text: '302,868.60' },
                    ],
                    raw_text: '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894.00 CYD 6.90 302,868.60',
                  },
                {
                  id: 'table:williamson:lines:r2',
                  page_number: 1,
                  row_index: 2,
                    cells: [
                      { column_index: 0, text: '1B' },
                      { column_index: 1, text: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS' },
                      { column_index: 2, text: '12,250.00' },
                      { column_index: 3, text: 'CYD' },
                      { column_index: 4, text: '7.90' },
                      { column_index: 5, text: '96,775.00' },
                    ],
                    raw_text: '1B Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 12,250.00 CYD 7.90 96,775.00',
                  },
                {
                  id: 'table:williamson:lines:r3',
                  page_number: 1,
                  row_index: 3,
                    cells: [
                      { column_index: 0, text: '1E' },
                      { column_index: 1, text: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS' },
                      { column_index: 2, text: '3,099.00' },
                      { column_index: 3, text: 'CYD' },
                      { column_index: 4, text: '13.50' },
                      { column_index: 5, text: '41,836.50' },
                    ],
                    raw_text: '1E Vegetative Collect Remove Haul Rural Areas ROW to DMS 3,099.00 CYD 13.50 41,836.50',
                  },
                {
                  id: 'table:williamson:lines:r4',
                  page_number: 1,
                  row_index: 4,
                    cells: [
                      { column_index: 0, text: '1F' },
                      { column_index: 1, text: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS' },
                      { column_index: 2, text: '916.00' },
                      { column_index: 3, text: 'CYD' },
                      { column_index: 4, text: '14.50' },
                      { column_index: 5, text: '13,282.00' },
                    ],
                    raw_text: '1F Vegetative Collect Remove Haul Rural Areas ROW to DMS 916.00 CYD 14.50 13,282.00',
                  },
                {
                  id: 'table:williamson:lines:r5',
                  page_number: 1,
                  row_index: 5,
                    cells: [
                      { column_index: 0, text: '5A' },
                      { column_index: 1, text: 'Tree Operations Hazardous Tree Removal' },
                      { column_index: 2, text: '5.00' },
                      { column_index: 3, text: 'EA' },
                      { column_index: 4, text: '95.00' },
                      { column_index: 5, text: '475.00' },
                    ],
                    raw_text: '5A Tree Operations Hazardous Tree Removal 5.00 EA 95.00 475.00',
                  },
                {
                  id: 'table:williamson:lines:r6',
                  page_number: 1,
                  row_index: 6,
                    cells: [
                      { column_index: 0, text: '6A' },
                      { column_index: 1, text: 'Tree Operations Hazardous Hanging Limb Removal' },
                      { column_index: 2, text: '994.00' },
                      { column_index: 3, text: 'EA' },
                      { column_index: 4, text: '80.00' },
                      { column_index: 5, text: '79,520.00' },
                    ],
                    raw_text: '6A Tree Operations Hazardous Hanging Limb Removal 994.00 EA 80.00 79,520.00',
                  },
              ],
            },
            {
              id: 'table:williamson:totals',
              page_number: 1,
              headers: ['Label', 'Amount'],
              header_context: [],
              confidence: 0.93,
              rows: [
                {
                  id: 'table:williamson:totals:r1',
                  page_number: 1,
                  row_index: 1,
                  cells: [
                    { column_index: 0, text: 'Subtotal' },
                    { column_index: 1, text: '$534,757.10' },
                  ],
                  raw_text: 'Subtotal $534,757.10',
                },
                {
                  id: 'table:williamson:totals:r2',
                  page_number: 1,
                  row_index: 2,
                  cells: [
                    { column_index: 0, text: 'TOTAL' },
                    { column_index: 1, text: '$534,757.10' },
                  ],
                  raw_text: 'TOTAL $534,757.10',
                },
              ],
            },
          ],
        },
      },
    };

    const typed = extractInvoiceTypedFields({
      text,
      contentLayers,
    });

    const extracted = extractNode({
      documentId,
      documentType: 'invoice',
      documentName: 'williamson-2026-002.pdf',
      documentTitle: 'Williamson Invoice 2026-002',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: typed,
        },
        extraction: {
          text_preview: text,
          content_layers_v1: contentLayers,
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const billed = normalized.primaryDocument.fact_map.billed_amount;
    const lineItemCount = normalized.primaryDocument.fact_map.line_item_count;

    assert.ok(billed);
    assert.equal(billed.value, 534757.1);
    assert.ok(billed.evidence_refs.includes('table:williamson:totals:r2'));
    assert.equal(lineItemCount?.value, 6);
    assert.equal(normalized.primaryDocument.fact_map.invoice_number?.value, '2026-002');
    assert.equal(normalized.primaryDocument.fact_map.period_through?.value, '2026-03-18');
    assert.equal(normalized.primaryDocument.fact_map.line_item_support_present?.value, true);
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

  it('normalizes EMERG03 front-matter facts from pages 1 and 2 without later-page fallback noise', () => {
    const documentId = 'emerg03-front-matter-test';
    const pages = [
      {
        page_number: 1,
        text: [
          'CONTRACT NO. EMERG03',
          'VENDOR NO. NM-00123',
          'THIS AGREEMENT is made and entered into by and between the New Mexico Department of Transportation and Stampede Ventures, Inc.',
          'Agreement Date: 8/12/2024',
          'ACKNOWLEDGMENT',
          'STATE OF NEW MEXICO',
          'COUNTY OF SANTA FE',
          'Subscribed and sworn before me this 15th day of August, 2024.',
        ].join('\n'),
        source_method: 'pdf_text' as const,
      },
      {
        page_number: 2,
        text: [
          'TERM 1.B',
          'The effective date of this Agreement is 8/12/2024.',
          'This Agreement shall remain in effect for a period not to exceed 6 months from the effective date.',
          'The total amount payable to the Contractor under this Agreement, inclusive of gross receipts tax and all authorized work, shall not exceed $30,000,000.00.',
        ].join('\n'),
        source_method: 'pdf_text' as const,
      },
    ];
    const parsed = parseContractEvidenceV1({ pages });
    const evidence = pages.map((page) =>
      makePdfEvidence({
        id: `ev-emerg03-front-${page.page_number}`,
        documentId,
        page: page.page_number,
        text: page.text,
        label: `Page ${page.page_number}`,
      }),
    );

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'emerg03-front-matter.pdf',
      documentTitle: 'EMERG03 Front Matter',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {},
        },
        extraction: {
          text_preview: pages.map((page) => page.text).join('\n\n'),
          evidence_v1: {
            structured_fields: parsed.structured_fields,
            section_signals: parsed.section_signals,
          },
          content_layers_v1: {
            pdf: {
              evidence,
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.match(String(facts.contractor_name?.value ?? ''), /^Stampede Ventures, Inc\.?$/);
    assert.equal(facts.owner_name?.value, 'New Mexico Department of Transportation');
    assert.equal(facts.executed_date?.value, '8/12/2024');
    assert.equal(facts.term_start_date?.value, '2024-08-12');
    assert.equal(facts.term_end_date?.value, '2025-02-12');
    assert.equal(facts.expiration_date?.value, '2025-02-12');
    assert.equal(facts.contract_ceiling?.value, 30000000);
  });

  it('ignores structured_fields contractor_name when it is NTE / sum prose so typed or evidence wins', () => {
    const documentId = 'contractor-prose-skip';
    const page1Text = [
      'CONTRACT NO. EMERG03',
      'THIS AGREEMENT is made and entered into by and between the New Mexico Department of Transportation and Stampede Ventures, Inc.',
    ].join('\n');
    const evidence = makePdfEvidence({
      id: 'ev-contractor-block',
      documentId,
      page: 1,
      text: page1Text,
      label: 'Page 1',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'contractor-prose.pdf',
      documentTitle: 'Contractor prose skip',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'Stampede Ventures, Inc.',
          },
        },
        extraction: {
          text_preview: page1Text,
          evidence_v1: {
            structured_fields: {
              contractor_name: 'in sum of Thirty Million Dollars',
              contractor_name_source: 'heuristic',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [evidence],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const contractor = normalized.primaryDocument.fact_map.contractor_name;
    assert.match(String(contractor?.value ?? ''), /^Stampede Ventures, Inc\.?$/);
  });

  it('does not use contract/vendor codes as contractor_name when typed vendor has the legal entity', () => {
    const documentId = 'contractor-code-vs-typed-vendor';
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'code-vs-vendor.pdf',
      documentTitle: 'Code vs vendor',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'Stampede Ventures, Inc.',
          },
        },
        extraction: {
          text_preview: 'CONTRACT NO. EMERG03',
          evidence_v1: {
            structured_fields: {
              contractor_name: 'EMERG03',
              contractor_name_source: 'heuristic',
            },
          },
          content_layers_v1: {
            pdf: { evidence: [] },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const contractor = normalized.primaryDocument.fact_map.contractor_name;
    assert.match(String(contractor?.value ?? ''), /^Stampede Ventures, Inc\.?$/);
  });

  it('ranks legal-entity contractor over insurance certificate-holder noise when label order favors early pages', () => {
    const documentId = 'emerg03-cert-noise';
    const certNoise = makePdfEvidence({
      id: 'ev-p1-cert-holder',
      documentId,
      page: 1,
      text: 'ACORD CERTIFICATE OF LIABILITY INSURANCE',
      label: 'Contractor',
      value: 'THE CERTIFICATE HOLDER. OTHER',
    });
    const contractBlock = makePdfEvidence({
      id: 'ev-p11-stampede',
      documentId,
      page: 11,
      text:
        'THIS AGREEMENT is made and entered into by and between the New Mexico Department of Transportation and Stampede Ventures, Inc.',
      label: 'Contractor',
      value: 'Stampede Ventures, Inc.',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'emerg03.pdf',
      documentTitle: 'EMERG03',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {},
        },
        extraction: {
          text_preview: 'EMERG03',
          evidence_v1: {
            structured_fields: {
              contractor_name: 'THE CERTIFICATE HOLDER. OTHER',
              contractor_name_source: 'heuristic',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [certNoise, contractBlock],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const contractor = normalized.primaryDocument.fact_map.contractor_name;
    assert.match(String(contractor?.value ?? ''), /^Stampede Ventures, Inc\.?$/);
    assert.ok(contractor?.evidence_refs.includes('ev-p11-stampede'));
  });

  it('rejects placeholder prime-contractor fields so the actual contractor label wins', () => {
    const documentId = 'emerg03-prime-contractor-placeholder';
    const placeholder = makePdfEvidence({
      id: 'ev-prime-contractor-placeholder',
      documentId,
      page: 53,
      text: 'Prime Contractor ___________________________________________________________',
      label: 'Prime Contractor',
      value: '___________________________________________________________',
    });
    const actualContractor = makePdfEvidence({
      id: 'ev-prime-contractor-stampede',
      documentId,
      page: 11,
      text: 'Contractor: Stampede Ventures, Inc.',
      label: 'Contractor',
      value: 'Stampede Ventures, Inc.',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'emerg03-prime-contractor.pdf',
      documentTitle: 'EMERG03 prime contractor',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'THE CERTIFICATE HOLDER. OTHER',
          },
        },
        extraction: {
          text_preview: [placeholder.text, actualContractor.text].join('\n\n'),
          evidence_v1: {
            structured_fields: {
              contractor_name: 'in  sum of Thirty Million Dollars',
              contractor_name_source: 'heuristic',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [placeholder, actualContractor],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const contractor = normalized.primaryDocument.fact_map.contractor_name;
    assert.equal(contractor?.value, 'Stampede Ventures, Inc.');
    assert.ok(contractor?.evidence_refs.includes('ev-prime-contractor-stampede'));
  });

  it('strips Contractor: prefix from evidence lines so the fact value is the legal name only', () => {
    const documentId = 'contractor-prefix-strip';
    const ev = makePdfEvidence({
      id: 'ev-contractor-colon-line',
      documentId,
      page: 1,
      text: 'Contractor: Acme Works LLC',
      label: 'Contractor: Acme Works LLC',
    });
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'prefix.pdf',
      documentTitle: 'Prefix',
      projectName: null,
      extractionData: {
        fields: { typed_fields: {} },
        extraction: {
          text_preview: 'x',
          evidence_v1: { structured_fields: {} },
          content_layers_v1: { pdf: { evidence: [ev] } },
        },
      },
      relatedDocs: [],
    });
    const normalized = normalizeNode(extracted);
    assert.equal(normalized.primaryDocument.fact_map.contractor_name?.value, 'Acme Works LLC');
  });

  it('treats BAFO response pages as solicitation responses and does not invent executed or term dates', () => {
    const documentId = 'ncdot-bafo-response';
      const page1 = [
        'STATE OF NORTH CAROLINA REQUEST FOR BEST AND FINAL OFFER Department of Public Safety NO. 19-IFB-1545027233-PTW',
        'Issue Date: August 7, 2025',
        'NOTICE TO VENDOR: Offers submitted in response to this Best and Final Offer (BAFO) for the furnishing and delivering the goods and services described herein will be received until August 13, 2025.',
        'Using Agency: NC Emergency Management',
        'VENDOR: EMAIL: CrowderGulf, LLC jramsay@crowdergulf.com',
        'TYPE OR PRINT NAME & TITLE OF PERSON SIGNING: Ashley Ramsay-Naile, President',
        'DATE:',
        'Offer valid for ninety (90) calendar days from date of opening unless otherwise stated here.',
        'ACCEPTANCE OF OFFER: If the State accepts any or all parts of this offer, an authorized representative of the Agency shall affix his/her signature.',
        'Vendor shall engage in PPDR work only with a written right of entry and hold harmless document executed by the private property owner.',
      ].join(' ');
    const page1Evidence = makePdfEvidence({
      id: 'ev-ncdot-bafo-page-1',
      documentId,
      page: 1,
      text: page1,
      label: 'Page 1',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'ncdot-bafo.pdf',
      documentTitle: 'NCDOT BAFO',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'Contract awarded this day of 20',
            contract_date: 'August 13, 2025',
            effective_date: 'August 7, 2025',
          },
        },
        extraction: {
          text_preview: page1,
          evidence_v1: {
            structured_fields: {
              owner_name: 'NC Emergency Management See page 2 for Submission Instructions Requisition No.',
              contractor_name: 'Offers submitted in response to this Best and Final Offer (BAFO) for furnishing and delivering goods and services',
              contractor_name_source: 'heuristic',
              expiration_date: '2025-08-13',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [page1Evidence],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.contractor_name?.value, 'CrowderGulf, LLC');
    assert.equal(facts.owner_name?.value, 'State of North Carolina, Department of Public Safety');
    assert.equal(facts.executed_date?.value, null);
    assert.equal(facts.term_start_date?.value, null);
    assert.equal(facts.term_end_date?.value, null);
    assert.equal(facts.expiration_date?.value, null);
  });

  it('derives term_end_date and expiration from N days from fully executed when no explicit end date exists', () => {
    const documentId = 'williamson-duration-term';
    const page2 = [
      'This agreement defines the work scope.',
      'The contract is effective for a period of ninety (90) days from the date it is fully executed.',
    ].join(' ');
    const ev = makePdfEvidence({
      id: 'ev-will-term-p2',
      documentId,
      page: 2,
      text: page2,
      label: 'Page 2',
    });
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'williamson.pdf',
      documentTitle: 'Williamson',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            contract_date: '3/15/2025',
          },
        },
        extraction: {
          text_preview: page2,
          evidence_v1: { structured_fields: {} },
          content_layers_v1: { pdf: { evidence: [ev] } },
        },
      },
      relatedDocs: [],
    });
    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.executed_date?.value, '3/15/2025');
    assert.equal(facts.term_end_date?.value, '2025-06-13');
    assert.equal(facts.expiration_date?.value, '2025-06-13');
    assert.equal(facts.term_end_date?.derivation_status, 'calculated');
    assert.ok(facts.term_end_date?.evidence_refs.includes('ev-will-term-p2'));
  });

  it('derives Williamson OCR-style term dates from the executed-date clause and rejects malformed expiration junk', () => {
    const documentId = 'williamson-ocr-duration-term';
    const frontMatter = makePdfEvidence({
      id: 'ev-will-ocr-front',
      documentId,
      page: 1,
      text: [
        'WHEREAS, the State of Tennessee declared a state of emergency on January 22, 2026.',
        'WHEREAS, the President approved an emergency declaration for Tennessee on January 24, 2026.',
        'THIS CONTRACT is entered into by Williamson County, Tennessee and Aftermath Disaster Recovery, Inc. on this 9 day of February, 2026, and is executed as evidenced by the undersigned.',
      ].join(' '),
      label: 'Page 1',
    });
    const ocrTermClause = makePdfEvidence({
      id: 'ev-will-ocr-term',
      documentId,
      page: 2,
      text:
        '2. Term. This Contract shall be effective for a period ofiingty (90) days | begining on the date itis filly execited. County shall automatically teFminate at the and of the term.',
      label: 'Page 2',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'williamson-ocr.pdf',
      documentTitle: 'Williamson OCR',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            contract_date: 'January 22, 2026',
            effective_date: 'January 24, 2026',
          },
        },
        extraction: {
          text_preview: [frontMatter.text, ocrTermClause.text].join('\n\n'),
          evidence_v1: {
            structured_fields: {
              owner_name: 'WILLIAMSON COUNTY, TENNESSEE',
              expiration_date: '13-1-199',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [frontMatter, ocrTermClause],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.executed_date?.value, '2026-02-09');
    assert.equal(facts.term_start_date?.value, '2026-02-09');
    assert.equal(facts.term_end_date?.value, '2026-05-10');
    assert.equal(facts.expiration_date?.value, '2026-05-10');
    assert.ok(facts.executed_date?.evidence_refs.includes('ev-will-ocr-front'));
    assert.ok(facts.term_end_date?.evidence_refs.includes('ev-will-ocr-term'));
  });

  it('derives Bentonville term dates when the effective date is defined as the executed signature-page date', () => {
    const documentId = 'bentonville-effective-inherits-executed';
    const termClause = makePdfEvidence({
      id: 'ev-bentonville-term',
      documentId,
      page: 1,
      text: [
        '3. CONTRACT TERM.',
        'The term for this Contract shall be six (6) months, commencing on the effective date of this Contract.',
      ].join(' '),
      nearbyText:
        'a. Effective Date: The Effective Date of this Contract shall be defined as the executed date on the Signature Page of this Contract.',
      label: 'Page 1',
    });
    const signaturePage = makePdfEvidence({
      id: 'ev-bentonville-signature',
      documentId,
      page: 9,
      text: 'CITY OF BENTONVILLE, ARKANSAS SIGNATURE PAGE The Parties hereto have caused this Contract to be executed this',
      nearbyText: 'September 13, 2024 | By: __________',
      label: 'Page 9',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'bentonville.pdf',
      documentTitle: 'Bentonville',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            contract_date: 'September 13, 2024',
            effective_date: 'September 24, 1965',
          },
        },
        extraction: {
          text_preview: [termClause.text, termClause.location.nearby_text, signaturePage.text].join('\n\n'),
          evidence_v1: {
            structured_fields: {
              executed_date: 'September 13, 2024',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [termClause, signaturePage],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.executed_date?.value, 'September 13, 2024');
    assert.equal(facts.term_start_date?.value, '2024-09-13');
    assert.equal(facts.term_end_date?.value, '2025-03-13');
    assert.equal(facts.expiration_date?.value, '2025-03-13');
    assert.ok(facts.term_start_date?.evidence_refs.includes('ev-bentonville-term'));
    assert.equal(
      facts.term_start_date?.derivation_dependency?.anchor_inheritance,
      'effective_date_inherits_executed_date',
    );
    assert.ok(facts.term_end_date?.evidence_refs.includes('ev-bentonville-term'));
  });

  it('keeps TDOT executed and effective dates distinct on the live runtime path and prefers estimated liability over duration noise', () => {
    const documentId = 'tdot-live-runtime-dates';
    const termClause = makePdfEvidence({
      id: 'ev-tdot-term-clause',
      documentId,
      page: 1,
      text: [
        'B.1 TERM OF CONTRACT.',
        'This Contract shall be effective on February 9, 2026 ("Effective Date") and extend for a period of twelve (12) months after the Effective Date ("Term").',
      ].join(' '),
      label: 'Page 1',
    });
    const liabilityPage = makePdfEvidence({
      id: 'ev-tdot-estimated-liability',
      documentId,
      page: 2,
      text: [
        'Estimated Liability ($100,000,000.00)',
        'Compensation shall be based on the attached price schedule.',
        'Purchase Order issued by the State is required for payment.',
      ].join(' '),
      label: 'Page 2',
    });
    const signaturePage = makePdfEvidence({
      id: 'ev-tdot-signature',
      documentId,
      page: 22,
      text: [
        'IN WITNESS WHEREOF, the parties have executed this Contract as of the date last below written.',
        'CONTRACTOR SIGNATURE',
      ].join(' '),
      nearbyText: 'Gerry Arvidson, President | Date: 2/6/2026',
      label: 'Page 22',
    });
    const attestationPage = makePdfEvidence({
      id: 'ev-tdot-attestation',
      documentId,
      page: 23,
      text: 'Attachment A DATE OF ATTESTATION 2/6/2026',
      label: 'Page 23',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'tdot-swc-820-89633.pdf',
      documentTitle: 'TDOT SWC 820 #89633',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'PHILLIPS HEAVY INC',
            effective_date: 'February 9, 2026',
            nte_amount: 12,
          },
        },
        extraction: {
          text_preview: [
            termClause.text,
            liabilityPage.text,
            signaturePage.text,
            signaturePage.location.nearby_text,
            attestationPage.text,
          ].join('\n\n'),
          evidence_v1: {
            structured_fields: {
              effective_date: 'February 9, 2026',
            },
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [2],
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [termClause, liabilityPage, signaturePage, attestationPage],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.executed_date?.value, '2/6/2026');
    assert.equal(facts.term_start_date?.value, '2026-02-09');
    assert.equal(
      facts.term_start_date?.derivation_dependency?.anchor_inheritance,
      'term_start_follows_explicit_effective_date',
    );
    assert.equal(facts.term_end_date?.value, null);
    assert.equal(facts.expiration_date?.value, null);
    assert.equal(facts.contract_ceiling?.value, 100000000);
    assert.ok(facts.executed_date?.evidence_refs.includes('ev-tdot-signature'));
    assert.ok(facts.term_start_date?.evidence_refs.includes('ev-tdot-term-clause'));
    assert.ok(facts.contract_ceiling?.evidence_refs.includes('ev-tdot-estimated-liability'));
    assert.equal(normalized.extracted.executedDate, '2/6/2026');
    assert.equal(normalized.extracted.notToExceedAmount, 100000000);
  });



  it('marks term dates upstream_missing when executed-relative clause exists but executed_date was not extracted', () => {
    const documentId = 'missing-executed-upstream-missing';
    const page2 =
      'The contract is effective for a period of ninety (90) days from the date it is fully executed.';
    const ev = makePdfEvidence({
      id: 'ev-term-no-exec',
      documentId,
      page: 2,
      text: page2,
      label: 'Page 2',
    });
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'noexec.pdf',
      documentTitle: 'NoExec',
      projectName: null,
      extractionData: {
        fields: { typed_fields: {} },
        extraction: {
          text_preview: page2,
          evidence_v1: { structured_fields: {} },
          content_layers_v1: { pdf: { evidence: [ev] } },
        },
      },
      relatedDocs: [],
    });
    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.executed_date?.value, null);
    assert.equal(facts.executed_date?.derivation_status, 'upstream_missing');
    assert.equal(facts.term_end_date?.value, null);
    assert.equal(facts.term_end_date?.derivation_status, 'upstream_missing');
    assert.equal(facts.term_end_date?.derivation_dependency?.source_field, 'executed_date');
    assert.equal(facts.term_start_date?.derivation_status, 'upstream_missing');
    assert.equal(facts.expiration_date?.derivation_status, 'upstream_missing');
    assert.ok(
      (facts.term_end_date?.missing_source_context?.[0] ?? '').toLowerCase().includes('executed'),
    );
  });

  it('emits a hard warning when completed contract extraction still has no canonical facts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const documentId = 'williamson-null-canonical-warning';

    try {
      const extracted = extractNode({
        documentId,
        documentType: 'contract',
        documentName: 'williamson-null.pdf',
        documentTitle: 'Williamson Null Canonical',
        projectName: null,
        extractionData: {
          status: 'completed',
          extraction: {
            mode: 'ocr_recovery',
            text_preview: '',
            metadata: {
              extraction_mode: 'ocr_recovery',
              ocr_trigger_reason: 'pdf_parse_full_weak_contract_like',
              ocr_pages_attempted: 4,
              ocr_confidence_avg: 87.5,
              canonical_persisted: false,
              gate_context: {
                contract_like: true,
                full_weak: true,
                meaningful_pdf_text: false,
                fallback_allowed: true,
                fallback_reason: 'ocr_recovery_attempted_but_empty',
              },
            },
            evidence_v1: {
              structured_fields: {},
              section_signals: {
                rate_section_present: false,
                rate_section_pages: [],
                rate_items_detected: 0,
                unit_price_structure_present: false,
              },
            },
          },
          fields: {
            typed_fields: {},
          },
        },
        relatedDocs: [],
      });

      const normalized = normalizeNode(extracted);
      const metadata = normalized.extracted.canonical_persistence as Record<string, unknown>;

      assert.equal(metadata.canonical_persisted, false);
      assert.deepEqual(metadata.present_canonical_facts, []);
      assert.equal(metadata.extraction_mode, 'ocr_recovery');
      assert.equal(metadata.ocr_pages_attempted, 4);
      assert.equal(warn.mock.calls.length, 1);
      assert.equal(warn.mock.calls[0]?.[0], '[normalizeNode] canonical persistence missing');
      assert.deepEqual(warn.mock.calls[0]?.[1], metadata);
    } finally {
      warn.mockRestore();
    }
  });

  it('derives term end from duration + execution anchor when clause and executed_date are on different pages', () => {
    const documentId = 'cross-page-executed-duration';
    const page1 = makePdfEvidence({
      id: 'ev-exec-only-p1',
      documentId,
      page: 1,
      text: 'Contract Execution Date: 9/15/2025',
      label: 'Page 1',
    });
    const page2 = makePdfEvidence({
      id: 'ev-duration-only-p2',
      documentId,
      page: 2,
      text: 'This provision runs ninety (90) days from the date it is fully executed.',
      label: 'Page 2',
    });
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'cross-page.pdf',
      documentTitle: 'Cross page',
      projectName: null,
      extractionData: {
        fields: { typed_fields: {} },
        extraction: {
          text_preview: '',
          evidence_v1: { structured_fields: { executed_date: '2025-09-15' } },
          content_layers_v1: { pdf: { evidence: [page1, page2] } },
        },
      },
      relatedDocs: [],
    });
    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.executed_date?.value, '9/15/2025');
    assert.equal(facts.term_end_date?.value, '2025-12-14');
    assert.equal(facts.expiration_date?.value, '2025-12-14');
  });

  it('uses pdf.text.pages plain_text_blocks for executed-relative duration when evidence blobs omit the clause', () => {
    const documentId = 'haystack-from-pdf-layer';
    const ev = makePdfEvidence({
      id: 'ev-unrelated',
      documentId,
      page: 1,
      text: 'DocuSign certificate metadata and routing.',
      label: 'Page 1',
    });
    const clause =
      'Effective for a period of ninety (90) days from the date it is fully executed.';
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'layer.pdf',
      documentTitle: 'Layer',
      projectName: null,
      extractionData: {
        fields: { typed_fields: {} },
        extraction: {
          text_preview: '',
          evidence_v1: {
            structured_fields: { executed_date: '2025-09-15' },
          },
          content_layers_v1: {
            pdf: {
              evidence: [ev],
              text: {
                pages: [
                  {
                    page_number: 2,
                    plain_text_blocks: [{ text: clause }],
                  },
                ],
              },
            },
          },
        },
      },
      relatedDocs: [],
    });
    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.term_end_date?.value, '2025-12-14');
    assert.equal(facts.term_start_date?.value, '2025-09-15');
  });

  it('derives NMDOT contract dates from front-matter ordinal date and effective-date clause while rejecting wage-table noise', () => {
    const documentId = 'nmdot-front-matter-dates';
    const frontMatter = makePdfEvidence({
      id: 'ev-nmdot-front-matter',
      documentId,
      page: 1,
      text: [
        'VENDOR NO. 0000168801',
        'New Mexico Department of Transportation',
        'Contract',
        'THIS CONTRACT, made this _ day of ______._ 20 __,_ between the NEW MEXICO',
        'DEPARTMENT OF TRANSPORTATION ("Department") and Stampede Ventures, Inc.',
      ].join('\n'),
      label: 'Page 1',
      nearbyText: 'Rev. 6-03 CONTRACT NO. EMERG03 | 12th August 24',
    });
    const termClause = makePdfEvidence({
      id: 'ev-nmdot-term-clause',
      documentId,
      page: 2,
      text: [
        '1. Effective Date and Term.',
        'A. The Contract is effective as of the date the last party executes the Contract.',
        'B. The term of the Contract is not to exceed six months from the effective date, absent prior approval from the Department of Finance and Administration.',
      ].join(' '),
      label: 'Page 2',
    });
    const notaryNoise = makePdfEvidence({
      id: 'ev-nmdot-notary-noise',
      documentId,
      page: 1,
      text: [
        'ACKNOWLEDGMENT',
        'STATE OF Colorado )',
        'COUNTY OF El Paso )',
        'The foregoing instrument was acknowledged before me this 6th day of August , 20£1.__',
      ].join('\n'),
      label: 'Page 1',
    });
    const wageNoise = makePdfEvidence({
      id: 'ev-nmdot-wage-noise',
      documentId,
      page: 63,
      text: [
        'STREET, HIGHWAY, UTILITY & LIGHT ENGINEERING',
        'Effective January 1, 2024',
        'Trade Classification Base Rate Fringe Rate',
      ].join('\n'),
      label: 'Page 63',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'EMERG03_FE.pdf',
      documentTitle: 'EMERG03_FE',
      projectName: 'nmdot',
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'THE CERTIFICATE HOLDER. OTHER',
            effective_date: '13-1-28',
            contract_date: 'OCTOBER 23, 2027',
            expiration_date: '13-1-199',
          },
        },
        extraction: {
          text_preview: [frontMatter.text, termClause.text, wageNoise.text].join('\n\n'),
          evidence_v1: {
            structured_fields: {
              owner_name: 'OF El Paso )',
              executed_date: null,
              term_start_date: null,
              term_end_date: null,
              expiration_date: '13-1-199',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [frontMatter, termClause, notaryNoise, wageNoise],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.owner_name?.value, 'New Mexico Department of Transportation');
    assert.equal(facts.executed_date?.value, '2024-08-12');
    assert.equal(facts.term_start_date?.value, '2024-08-12');
    assert.equal(facts.term_end_date?.value, '2025-02-12');
    assert.equal(facts.expiration_date?.value, '2025-02-12');
    assert.ok(facts.executed_date?.evidence_refs.includes('ev-nmdot-front-matter'));
    assert.ok(facts.owner_name?.evidence_refs.includes('ev-nmdot-front-matter'));
  });

  it('rejects malformed partial contract dates instead of persisting junk canonical facts', () => {
    const documentId = 'reject-malformed-partial-dates';
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'bad-dates.pdf',
      documentTitle: 'Bad Dates',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            effective_date: '13-1-28',
            contract_date: '13-1-199',
            expiration_date: '13-1-199',
          },
        },
        extraction: {
          text_preview: 'Contract terms reference the work, but no valid calendar dates were extracted.',
          evidence_v1: {
            structured_fields: {
              executed_date: '13-1-199',
              term_start_date: '13-1-199',
              term_end_date: '13-1-199',
              expiration_date: '13-1-199',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.executed_date?.value, null);
    assert.equal(facts.term_start_date?.value, null);
    assert.equal(facts.term_end_date?.value, null);
    assert.equal(facts.expiration_date?.value, null);
    assert.equal(facts.executed_date?.evidence_refs.length, 0);
    assert.equal(facts.expiration_date?.derivation_status, 'upstream_missing');
  });

  it('normalizes ordinal day-of contract execution dates without producing fallback junk', () => {
    const documentId = 'ordinal-day-of-contract-date';
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'ordinal.pdf',
      documentTitle: 'Ordinal Date',
      projectName: null,
      extractionData: {
        fields: { typed_fields: {} },
        extraction: {
          text_preview: 'Agreement Date: 28th day of August, 2025',
          evidence_v1: {
            structured_fields: {
              executed_date: '28th day of August, 2025',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [
                makePdfEvidence({
                  id: 'ev-ordinal-day-of',
                  documentId,
                  page: 1,
                  text: 'Agreement Date: 28th day of August, 2025',
                  label: 'Page 1',
                }),
              ],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    assert.equal(normalized.primaryDocument.fact_map.executed_date?.value, '2025-08-28');
  });

  it('prefers extracted multi-page rate tables over weaker fallback schedule signals', () => {
    const documentId = 'contract-rate-table-precedence-test';
    const page32Evidence = makePdfEvidence({
      id: 'ev-rate-page-32',
      documentId,
      page: 32,
      text: 'Attachment B UNIT RATE PRICE FORM: DOT (EMERG03)',
      label: 'Page 32',
    });
    const page33Evidence = makePdfEvidence({
      id: 'ev-rate-page-33',
      documentId,
      page: 33,
      text: 'Continuation of Attachment B unit rates',
      label: 'Page 33',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'emerg03-contract.pdf',
      documentTitle: 'EMERG03 Contract',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {},
        },
        extraction: {
          text_preview: 'Attachment B UNIT RATE PRICE FORM: DOT (EMERG03)',
          evidence_v1: {
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [1],
              rate_items_detected: 2,
              unit_price_structure_present: true,
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [page32Evidence, page33Evidence],
              tables: {
                tables: [
                  {
                    id: 'pdf:table:p32:t1',
                    page_number: 32,
                    headers: ['County A', 'County B'],
                    header_context: [
                      'UNIT RATE PRICE FORM: DOT (EMERG03)',
                      'Work consists of all labor and equipment $ Per Cubic Yard',
                    ],
                    rows: [
                      {
                        id: 'pdf:table:p32:t1:r1',
                        page_number: 32,
                        row_index: 1,
                        cells: [
                          { column_index: 0, text: '1. Vegetative Debris Removal' },
                          { column_index: 1, text: '6.90' },
                          { column_index: 2, text: '7.10' },
                        ],
                        raw_text: '1. Vegetative Debris Removal 6.90 7.10',
                      },
                      {
                        id: 'pdf:table:p32:t1:r2',
                        page_number: 32,
                        row_index: 2,
                        cells: [
                          { column_index: 0, text: '2. Mixed C&D Debris' },
                          { column_index: 1, text: '8.90' },
                          { column_index: 2, text: '9.10' },
                        ],
                        raw_text: '2. Mixed C&D Debris 8.90 9.10',
                      },
                    ],
                  },
                  {
                    id: 'pdf:table:p33:t2',
                    page_number: 33,
                    headers: ['County A', 'County B'],
                    header_context: [
                      'UNIT RATE PRICE FORM: DOT (EMERG03)',
                      'Work consists of all labor and equipment $ Per Ton',
                    ],
                    rows: [
                      {
                        id: 'pdf:table:p33:t2:r1',
                        page_number: 33,
                        row_index: 1,
                        cells: [
                          { column_index: 0, text: '3. White Goods Removal' },
                          { column_index: 1, text: '12.50' },
                          { column_index: 2, text: '12.80' },
                        ],
                        raw_text: '3. White Goods Removal 12.50 12.80',
                      },
                      {
                        id: 'pdf:table:p33:t2:r2',
                        page_number: 33,
                        row_index: 2,
                        cells: [
                          { column_index: 0, text: '4. Hazardous Limb Removal' },
                          { column_index: 1, text: '85.00' },
                          { column_index: 2, text: '88.00' },
                        ],
                        raw_text: '4. Hazardous Limb Removal 85.00 88.00',
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.rate_schedule_present?.value, true);
    assert.equal(facts.rate_row_count?.value, 4);
    assert.equal(facts.rate_schedule_pages?.value, 'pages 32, 33');
  });

  it('fills repeated weak continuation gaps inside an extracted rate schedule span', () => {
    const documentId = 'contract-rate-gap-fill-test';
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'emerg03-gap-fill.pdf',
      documentTitle: 'EMERG03 Gap Fill',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {},
        },
        extraction: {
          text_preview: 'Attachment B UNIT RATE PRICE FORM: DOT (EMERG03)',
          evidence_v1: {
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [1],
              rate_items_detected: 2,
              unit_price_structure_present: true,
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [
                makePdfEvidence({
                  id: 'ev-gap-rate-page-32',
                  documentId,
                  page: 32,
                  text: 'Attachment B UNIT RATE PRICE FORM: DOT (EMERG03)',
                }),
              ],
              text: {
                pages: [
                  {
                    page_number: 32,
                    line_count: 80,
                    plain_text_blocks: [{ text: 'Attachment B UNIT RATE PRICE FORM: DOT (EMERG03)' }],
                  },
                  {
                    page_number: 33,
                    line_count: 78,
                    plain_text_blocks: [{ text: 'Continuation of Attachment B unit rates' }],
                  },
                  {
                    page_number: 34,
                    line_count: 10,
                    plain_text_blocks: [{ text: 'Docusign Envelope ID: weak raster continuation page' }],
                  },
                  {
                    page_number: 35,
                    line_count: 82,
                    plain_text_blocks: [{ text: 'Attachment B continued rates and units' }],
                  },
                  {
                    page_number: 36,
                    line_count: 9,
                    plain_text_blocks: [{ text: 'Docusign Envelope ID: weak raster continuation page' }],
                  },
                  {
                    page_number: 37,
                    line_count: 79,
                    plain_text_blocks: [{ text: 'Attachment B continued rates and units' }],
                  },
                ],
              },
              tables: {
                tables: [
                  makeRateTable({
                    id: 'pdf:table:p32:t1',
                    page: 32,
                    rowStart: 1,
                    unitContext: 'Work consists of all labor and equipment $ Per Cubic Yard',
                    descriptionA: 'Vegetative Debris Removal',
                    descriptionB: 'Mixed C&D Debris',
                  }),
                  makeRateTable({
                    id: 'pdf:table:p33:t1',
                    page: 33,
                    rowStart: 3,
                    unitContext: 'Work consists of all labor and equipment $ Per Ton',
                    descriptionA: 'White Goods Removal',
                    descriptionB: 'Hazardous Limb Removal',
                  }),
                  makeRateTable({
                    id: 'pdf:table:p35:t1',
                    page: 35,
                    rowStart: 5,
                    unitContext: 'Work consists of all labor and equipment $ Per Day',
                    descriptionA: 'Roadway Clearance',
                    descriptionB: 'Traffic Control',
                  }),
                  makeRateTable({
                    id: 'pdf:table:p37:t1',
                    page: 37,
                    rowStart: 7,
                    unitContext: 'Work consists of all labor and equipment $ Per Linear Foot',
                    descriptionA: 'Ditch Reestablishment',
                    descriptionB: 'Pipe Cleaning',
                  }),
                ],
              },
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.rate_row_count?.value, 8);
    assert.equal(facts.rate_schedule_pages?.value, 'pages 32, 33, 34, 35, 36, 37');
  });

  it('does not fill an isolated weak page when the continuation pattern is not repeated', () => {
    const documentId = 'contract-rate-gap-guardrail-test';
    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'isolated-gap.pdf',
      documentTitle: 'Isolated Gap Contract',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {},
        },
        extraction: {
          text_preview: 'Attachment B UNIT RATE PRICE FORM: DOT (EMERG03)',
          evidence_v1: {
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [1],
              rate_items_detected: 2,
              unit_price_structure_present: true,
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [],
              text: {
                pages: [
                  {
                    page_number: 20,
                    line_count: 72,
                    plain_text_blocks: [{ text: 'Attachment B rate schedule page 20' }],
                  },
                  {
                    page_number: 21,
                    line_count: 10,
                    plain_text_blocks: [{ text: 'Docusign Envelope ID: weak page' }],
                  },
                  {
                    page_number: 22,
                    line_count: 74,
                    plain_text_blocks: [{ text: 'Attachment B rate schedule page 22' }],
                  },
                ],
              },
              tables: {
                tables: [
                  makeRateTable({
                    id: 'pdf:table:p20:t1',
                    page: 20,
                    rowStart: 1,
                    unitContext: 'Work consists of all labor and equipment $ Per Cubic Yard',
                    descriptionA: 'Vegetative Debris Removal',
                    descriptionB: 'Mixed C&D Debris',
                  }),
                  makeRateTable({
                    id: 'pdf:table:p22:t1',
                    page: 22,
                    rowStart: 3,
                    unitContext: 'Work consists of all labor and equipment $ Per Ton',
                    descriptionA: 'White Goods Removal',
                    descriptionB: 'Hazardous Limb Removal',
                  }),
                ],
              },
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.rate_schedule_pages?.value, 'pages 20, 22');
  });

  it('resolves Lee contractor and signature-block execution date over weak structured fragments and stale historical dates', () => {
    const documentId = 'lee-contractor-and-executed-date';
    const frontMatter = makePdfEvidence({
      id: 'ev-lee-front-matter',
      documentId,
      page: 1,
      text: [
        'THIS AGREEMENT (“Agreement”) is made and entered into by and between Lee | County, a political subdivision of the State of Florida, hereinafter referred to as the i "County" and Crowder-Gulf Joint Venture, Inc., a Florida corporation authorized to i do business in the State of Florida, whose address is 5629 Commerce Blvd E, Mobile, | AL 36619, and whose federal tax identification number is 01-0626019, hereinafter | referred to as ?Vendor." ;',
        'WITNESSETH',
      ].join(' '),
      label: 'Page 1',
    });
    const signaturePage = makePdfEvidence({
      id: 'ev-lee-signature-page',
      documentId,
      page: 10,
      text: [
        'IN WITNESS WHEREOF, the parties have executed this Agreement as of the date last below written.',
        'WITNESS: CROWDER-GULF JOINT VENTURE, INC.',
        'Date: 10-02-22',
        'LEE COUNTY BOARD OF COUNTY COMMISSIONERS OF LEE COUNTY, FLORIDA',
      ].join(' '),
      label: 'Page 10',
    });
    const staleHistoricalDate = makePdfEvidence({
      id: 'ev-lee-stale-history',
      documentId,
      page: 37,
      text: 'Revised 07/16/2018 - Page 2 of 2 Special Requirements.',
      label: 'Page 37',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'lee.pdf',
      documentTitle: 'Lee Contract',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name:
              'for Lee County, Florida. If in federal court, venue shall be in the U.S. District Court for the Middle District of Florida',
            contract_date: '07/16/2018',
            effective_date: '7/16/2018',
          },
        },
        extraction: {
          text_preview: [frontMatter.text, signaturePage.text, staleHistoricalDate.text].join('\n\n'),
          evidence_v1: {
            structured_fields: {
              contractor_name: 'to provide a',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [frontMatter, signaturePage, staleHistoricalDate],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.contractor_name?.value, 'Crowder-Gulf Joint Venture, Inc.');
    assert.equal(facts.executed_date?.value, '2022-10-02');
    assert.ok(facts.contractor_name?.evidence_refs.includes('ev-lee-front-matter'));
    assert.ok(facts.executed_date?.evidence_refs.includes('ev-lee-signature-page'));
  });

  it('derives Lee five-year base term from the execution commencement clause and ignores stale structured expiration', () => {
    const documentId = 'lee-five-year-term';
    const termClause = makePdfEvidence({
      id: 'ev-lee-term-clause',
      documentId,
      page: 2,
      text: [
        'II. TERM AND DELIVERY.',
        'This Agreement shall commence immediately upon the execution of all parties and shall continue on an "as needed basis" for a five (5) year period.',
        'Upon mutual written agreement of both parties, the parties may renew the Agreement, in whole or in part, for a renewal term or terms not to exceed the initial Agreement term of five (5) years.',
      ].join(' '),
      label: 'Page 2',
    });
    const signaturePage = makePdfEvidence({
      id: 'ev-lee-term-signature',
      documentId,
      page: 10,
      text: [
        'IN WITNESS WHEREOF, the parties have executed this Agreement as of the date last below written.',
        'Date: 10-02-22',
      ].join(' '),
      label: 'Page 10',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'lee-term.pdf',
      documentTitle: 'Lee Term',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            contract_date: '07/16/2018',
            effective_date: '7/16/2018',
            expiration_date: '07/16/2018',
          },
        },
        extraction: {
          text_preview: [termClause.text, signaturePage.text].join('\n\n'),
          evidence_v1: {
            structured_fields: {
              expiration_date: '2022-07-25',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [termClause, signaturePage],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.executed_date?.value, '2022-10-02');
    assert.equal(facts.term_start_date?.value, '2022-10-02');
    assert.equal(facts.term_end_date?.value, '2027-10-02');
    assert.equal(facts.expiration_date?.value, '2027-10-02');
    assert.ok(facts.term_end_date?.evidence_refs.includes('ev-lee-term-clause'));
    assert.equal(
      facts.term_start_date?.derivation_dependency?.anchor_inheritance,
      'same_as_executed_for_duration_clause_anchor',
    );
  });

  it('does not use stale typed dates from Lee solicitation packet pages when no execution evidence exists', () => {
    const documentId = 'lee-live-stale-dates';
    const scopePage = makePdfEvidence({
      id: 'ev-lee-live-scope',
      documentId,
      page: 11,
      text: [
        'Solicitation No. RFP220362BJB',
        'The Lee County Board of County Commissioners seeks to contract with a qualified Vendor to provide a variety of disaster recovery related services.',
      ].join(' '),
      label: 'Page 11',
    });
    const staleDate = makePdfEvidence({
      id: 'ev-lee-live-stale-date',
      documentId,
      page: 37,
      text: 'Insurance certificate revised 07/16/2018. Policy eff 07/16/2018. Policy exp 07/16/2019.',
      label: 'Page 37',
    });

    const extracted = extractNode({
      documentId,
      documentType: 'contract',
      documentName: 'lee-live-stale.pdf',
      documentTitle: 'Lee live stale dates',
      projectName: null,
      extractionData: {
        fields: {
          typed_fields: {
            vendor_name:
              'for Lee County, Florida. If in federal court, venue shall be in the U.S. District Court for the Middle District of Florida',
            contract_date: '07/16/2018',
            effective_date: '7/16/2018',
            expiration_date: '07/16/2018',
          },
        },
        extraction: {
          text_preview: [scopePage.text, staleDate.text].join('\n\n'),
          evidence_v1: {
            structured_fields: {
              contractor_name: 'to provide a',
              expiration_date: '2022-07-25',
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [scopePage, staleDate],
            },
          },
        },
      },
      relatedDocs: [],
    });

    const normalized = normalizeNode(extracted);
    const facts = normalized.primaryDocument.fact_map;

    assert.equal(facts.executed_date?.value, null);
    assert.equal(facts.expiration_date?.value, null);
  });
});
