import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildDocumentIntelligenceViewModel,
  compareDocumentFactsForLedger,
} from './documentIntelligenceViewModel';
import type { EvidenceObject } from '@/lib/extraction/types';
import type { NormalizedDecision } from '@/lib/types/documentIntelligence';

function makeEvidence(params: {
  id: string;
  documentId: string;
  page: number;
  text: string;
  description?: string;
  label?: string;
  sourceMethod?: string;
  sourceElementId?: string;
}): EvidenceObject {
  return {
    id: params.id,
    kind: 'text',
    source_type: 'pdf',
    source_document_id: params.documentId,
    description: params.description ?? params.text,
    text: params.text,
    location: {
      page: params.page,
      label: params.label ?? params.description ?? params.text,
      nearby_text: params.text,
    },
    confidence: 0.94,
    weak: false,
    metadata: {
      source_document_id: params.documentId,
      source_method: params.sourceMethod ?? 'pdf_text',
      ...(params.sourceElementId ? { source_element_id: params.sourceElementId } : {}),
    },
  };
}

function makeRateTableRow(params: {
  tableId: string;
  page: number;
  rowIndex: number;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  extension: string;
}): Record<string, unknown> {
  return {
    id: `${params.tableId}:r${params.rowIndex}`,
    page_number: params.page,
    row_index: params.rowIndex,
    cells: [
      { column_index: 0, text: `${params.rowIndex}.` },
      { column_index: 1, text: params.description },
      { column_index: 2, text: params.quantity },
      { column_index: 3, text: params.unit },
      { column_index: 4, text: params.unitPrice },
      { column_index: 5, text: params.extension },
    ],
    raw_text: `${params.rowIndex}. ${params.description} ${params.quantity} ${params.unit} ${params.unitPrice} ${params.extension}`,
    nearby_text: params.extension,
  };
}

function makeGenericTableRow(params: {
  tableId: string;
  page: number;
  rowIndex: number;
  cells: string[];
}): Record<string, unknown> {
  return {
    id: `${params.tableId}:r${params.rowIndex}`,
    page_number: params.page,
    row_index: params.rowIndex,
    cells: params.cells.map((text, index) => ({
      column_index: index,
      text,
    })),
    raw_text: params.cells.join(' '),
    nearby_text: params.cells.at(-1) ?? null,
  };
}

function buildRateScheduleModel(params: {
  documentId: string;
  page: number;
  headers: string[];
  headerContext: string[];
  rows: Record<string, unknown>[];
  noisyPages?: number[];
}) {
  const tableId = `pdf:table:p${params.page}:t1`;
  const headerContextText = params.headerContext.join(' ');

  return buildModel({
    documentId: params.documentId,
    documentType: 'contract',
    documentName: `${params.documentId}.pdf`,
    documentTitle: params.documentId,
    preferredExtraction: {
      fields: {
        typed_fields: {
          vendor_name: 'Acme Debris LLC',
        },
      },
      extraction: {
        text_preview: headerContextText,
        content_layers_v1: {
          pdf: {
            evidence: [
              makeEvidence({
                id: `ev-rate-page-${params.page}`,
                documentId: params.documentId,
                page: params.page,
                text: headerContextText,
                sourceElementId: `el-rate-page-${params.page}`,
              }),
              {
                id: tableId,
                kind: 'table',
                source_type: 'pdf',
                source_document_id: params.documentId,
                description: `PDF table on page ${params.page}`,
                text: params.rows.map((row) => String(row.raw_text ?? '')).join('\n'),
                location: {
                  page: params.page,
                  header_context: params.headerContext,
                },
                confidence: 0.92,
                weak: false,
                metadata: { source_document_id: params.documentId },
              } satisfies EvidenceObject,
            ],
            tables: {
              tables: [
                {
                  id: tableId,
                  page_number: params.page,
                  headers: params.headers,
                  header_context: params.headerContext,
                  rows: params.rows,
                  confidence: 0.92,
                },
              ],
            },
          },
        },
        evidence_v1: {
          structured_fields: {
            contractor_name: 'Acme Debris LLC',
          },
          section_signals: {
            rate_section_present: true,
            rate_section_pages: params.noisyPages ?? [2, 4, params.page, 19, 21],
            rate_items_detected: 6,
            unit_price_structure_present: true,
            time_and_materials_present: /time\s*(?:and|&)\s*materials/i.test(headerContextText),
          },
          page_text: [
            {
              page_number: params.page,
              source_method: 'pdf_text',
              text: headerContextText,
            },
          ],
        },
      },
    },
  });
}

function buildModel(params: {
  documentId: string;
  documentType: string;
  documentName: string;
  documentTitle: string;
  preferredExtraction: Record<string, unknown>;
  normalizedDecisions?: NormalizedDecision[];
  executionTrace?: Record<string, unknown> | null;
  reviewedDecisionIds?: string[];
}) {
  return buildDocumentIntelligenceViewModel({
    documentId: params.documentId,
    documentType: params.documentType,
    documentName: params.documentName,
    documentTitle: params.documentTitle,
    projectName: 'Storm Debris Cleanup',
    preferredExtraction: {
      id: `${params.documentId}:extraction`,
      created_at: '2026-03-23T14:00:00Z',
      data: params.preferredExtraction,
    },
    relatedDocs: [],
    normalizedDecisions: params.normalizedDecisions ?? [],
    extractionGaps: [],
    auditNotes: [],
    nodeTraces: [],
    executionTrace: (params.executionTrace ?? {
      facts: {},
      decisions: [],
      flow_tasks: [],
      generated_at: '2026-03-23T14:00:00Z',
      engine_version: 'document_intelligence:v2',
      extracted: {},
    }) as never,
    extractionHistory: [],
    reviewedDecisionIds: params.reviewedDecisionIds ?? [],
  });
}

function getFact(model: ReturnType<typeof buildModel>, fieldKey: string) {
  const fact = model.facts.find((entry) => entry.fieldKey === fieldKey);
  assert.ok(fact, `Expected fact ${fieldKey}`);
  return fact;
}

describe('document intelligence view model', () => {
  it('normalizes contract facts with grouping, dedupe, raw values, and geometry fallback', () => {
    const documentId = 'contract-doc';
    const evidence = [
      makeEvidence({
        id: 'ev-contractor',
        documentId,
        page: 1,
        text: 'Contractor: Looks Great Services of MS, Inc.',
        sourceElementId: 'el-contractor',
      }),
      makeEvidence({
        id: 'ev-ceiling',
        documentId,
        page: 2,
        text: 'Not to exceed $2,500,000.00',
        sourceElementId: 'el-ceiling',
      }),
      makeEvidence({
        id: 'ev-executed',
        documentId,
        page: 1,
        text: 'Executed 03/01/2026',
        sourceMethod: 'ocr',
      }),
      makeEvidence({
        id: 'ev-rate-page',
        documentId,
        page: 7,
        text: 'Exhibit A Rate Schedule',
        sourceElementId: 'el-rate-page',
      }),
    ];

    const model = buildModel({
      documentId,
      documentType: 'contract',
      documentName: 'services-agreement.pdf',
      documentTitle: 'Services Agreement',
      preferredExtraction: {
        fields: {
          typed_fields: {
            vendor_name: 'Looks Great Services of MS, Inc.',
            contract_date: '2026-03-01',
            nte_amount: 2500000,
          },
        },
        extraction: {
          text_preview: 'Compensation shall be based on Exhibit A rate schedule.',
          content_layers_v1: {
            pdf: {
              evidence,
            },
          },
          evidence_v1: {
            structured_fields: {
              contractor_name: 'Looks Great Services of MS, Inc.',
              executed_date: '2026-03-01',
              nte_amount: 2500000,
            },
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [7],
              rate_items_detected: 12,
              unit_price_structure_present: true,
              time_and_materials_present: false,
            },
            page_text: [
              { page_number: 1, source_method: 'pdf_text', text: 'Contractor and effective date text' },
              { page_number: 2, source_method: 'pdf_text', text: 'Not to exceed amount text' },
            ],
          },
          parsed_elements_v1: {
            elements: [
              {
                id: 'el-contractor',
                page_number: 1,
                text: 'Contractor: Looks Great Services of MS, Inc.',
                coordinates: {
                  points: [[24, 36], [320, 36], [320, 68], [24, 68]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
              {
                id: 'el-ceiling',
                page_number: 2,
                text: 'Not to exceed $2,500,000.00',
                coordinates: {
                  points: [[40, 88], [288, 88], [288, 122], [40, 122]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
              {
                id: 'el-executed-fallback',
                page_number: 1,
                text: 'Executed 03/01/2026',
                coordinates: {
                  points: [[24, 112], [248, 112], [248, 146], [24, 146]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
              {
                id: 'el-rate-page',
                page_number: 7,
                text: 'Exhibit A Rate Schedule',
                coordinates: {
                  points: [[52, 108], [256, 108], [256, 144], [52, 144]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
            ],
          },
        },
      },
      executionTrace: {
        facts: {
          contractor_name: 'Looks Great Services of MS, Inc.',
          contract_ceiling: 2500000,
          custom_enum: 'pending_review',
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          contractorName: 'Looks Great Services of MS, Inc.',
          executedDate: "March 1st '26",
          notToExceedAmount: '$2,500,000.00',
          rateSchedulePresent: 'Yes',
          customEnum: 'PENDING_REVIEW',
        },
      },
      normalizedDecisions: [
        {
          id: 'decision-reviewed-contractor',
          family: 'risk',
          severity: 'warning',
          title: 'Contractor verified',
          detail: 'Operator confirmed the contractor name.',
          field_key: 'contractor_name',
        },
        {
          id: 'decision-missing-approver',
          family: 'missing',
          severity: 'warning',
          title: 'Approver missing',
          detail: 'An approver name is still required.',
          field_key: 'approver_name',
        },
      ],
      reviewedDecisionIds: ['decision-reviewed-contractor'],
    });

    assert.equal(model.family, 'contract');
    assert.equal(model.groups.at(-1)?.key, 'additional_fields');
    assert.ok(model.groups.some((group) => group.key === 'parties'));
    assert.ok(model.groups.some((group) => group.key === 'dates'));
    assert.ok(model.groups.some((group) => group.key === 'financial_terms'));
    assert.ok(model.groups.some((group) => group.key === 'additional_fields'));

    const factKeys = model.facts.map((fact) => fact.fieldKey);
    assert.equal(factKeys.filter((key) => key === 'contractor_name').length, 1);
    assert.ok(!factKeys.includes('vendor_name'));
    assert.ok(!factKeys.includes('nte_amount'));
    assert.ok(!factKeys.includes('rate_section_present'));
    assert.ok(!factKeys.includes('rate_section_pages'));

    const contractor = getFact(model, 'contractor_name');
    assert.equal(contractor.reviewState, 'reviewed');
    assert.equal(contractor.schemaGroup, 'parties');
    assert.equal(contractor.evidenceCount, 1);
    assert.equal(contractor.primaryPage, 1);
    assert.ok(contractor.anchors[0]?.geometry);
    assert.equal(contractor.anchors[0]?.sourceLayer, 'Native text');

    const executedDate = getFact(model, 'executed_date');
    assert.equal(executedDate.normalizedDisplay, '2026-03-01');
    assert.equal(executedDate.rawDisplay, "March 1st '26");
    assert.equal(executedDate.valueType, 'date');
    assert.equal(executedDate.primaryPage, 1);
    assert.ok(executedDate.anchors[0]?.geometry, 'expected geometry from same-page text overlap fallback');
    assert.equal(executedDate.anchors[0]?.sourceLayer, 'OCR');

    const contractCeiling = getFact(model, 'contract_ceiling');
    assert.equal(contractCeiling.normalizedDisplay, '$2,500,000');
    assert.equal(contractCeiling.rawDisplay, '$2,500,000.00');
    assert.equal(contractCeiling.reviewState, 'auto');
    assert.equal(contractCeiling.valueType, 'currency');

    const rateSchedulePresent = getFact(model, 'rate_schedule_present');
    assert.equal(rateSchedulePresent.normalizedDisplay, 'true');
    assert.equal(rateSchedulePresent.rawDisplay, 'Yes');
    assert.equal(rateSchedulePresent.valueType, 'boolean');

    const timeAndMaterials = getFact(model, 'time_and_materials_present');
    assert.equal(timeAndMaterials.reviewState, 'derived');
    assert.equal(timeAndMaterials.evidenceCount, 0);

    const approver = getFact(model, 'approver_name');
    assert.equal(approver.reviewState, 'missing');

    const customEnum = getFact(model, 'custom_enum');
    assert.equal(customEnum.schemaGroup, 'additional_fields');
    assert.equal(customEnum.normalizedDisplay, 'pending_review');
    assert.equal(customEnum.rawDisplay, 'PENDING_REVIEW');

    assert.ok(model.counts.missingEvidenceFacts >= 1);
  });

  it('normalizes invoice conflicts, overrides, and missing facts without duplicating aliases', () => {
    const documentId = 'invoice-doc';
    const conflictEvidence = [
      makeEvidence({
        id: 'ev-approved-1',
        documentId,
        page: 2,
        text: 'Approved amount $8,600.00',
        sourceElementId: 'el-approved-1',
      }),
      makeEvidence({
        id: 'ev-approved-2',
        documentId,
        page: 3,
        text: 'Approved amount $9,100.00',
        sourceElementId: 'el-approved-2',
      }),
    ];

    const model = buildModel({
      documentId,
      documentType: 'invoice',
      documentName: 'invoice-204.pdf',
      documentTitle: 'Invoice 204',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-204',
            vendor_name: 'Acme Debris LLC',
            current_amount_due: 9800,
            invoice_date: '2026-03-15',
          },
        },
        extraction: {
          text_preview: 'Invoice INV-204 current amount due $9,800.00',
          content_layers_v1: {
            pdf: {
              evidence: [
                makeEvidence({
                  id: 'ev-invoice-number',
                  documentId,
                  page: 1,
                  text: 'Invoice Number INV-204',
                  sourceElementId: 'el-invoice-number',
                }),
                makeEvidence({
                  id: 'ev-vendor',
                  documentId,
                  page: 1,
                  text: 'Vendor Acme Debris LLC',
                  sourceElementId: 'el-vendor',
                }),
                makeEvidence({
                  id: 'ev-amount',
                  documentId,
                  page: 1,
                  text: 'Current amount due $9,800.00',
                  sourceElementId: 'el-amount',
                }),
                makeEvidence({
                  id: 'ev-date',
                  documentId,
                  page: 1,
                  text: 'Invoice Date 03/15/2026',
                  sourceElementId: 'el-date',
                  sourceMethod: 'ocr',
                }),
                ...conflictEvidence,
              ],
            },
          },
          evidence_v1: {
            structured_fields: {
              invoice_number: 'INV-204',
              vendor_name: 'Acme Debris LLC',
              total_amount: 9800,
            },
            section_signals: {},
          },
          parsed_elements_v1: {
            elements: [
              {
                id: 'el-invoice-number',
                page_number: 1,
                text: 'Invoice Number INV-204',
                coordinates: {
                  points: [[36, 42], [224, 42], [224, 72], [36, 72]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
              {
                id: 'el-vendor',
                page_number: 1,
                text: 'Vendor Acme Debris LLC',
                coordinates: {
                  points: [[36, 88], [246, 88], [246, 118], [36, 118]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
              {
                id: 'el-amount',
                page_number: 1,
                text: 'Current amount due $9,800.00',
                coordinates: {
                  points: [[36, 136], [284, 136], [284, 168], [36, 168]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
              {
                id: 'el-date',
                page_number: 1,
                text: 'Invoice Date 03/15/2026',
                coordinates: {
                  points: [[36, 182], [238, 182], [238, 214], [36, 214]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
              {
                id: 'el-approved-1',
                page_number: 2,
                text: 'Approved amount $8,600.00',
                coordinates: {
                  points: [[42, 94], [252, 94], [252, 126], [42, 126]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
              {
                id: 'el-approved-2',
                page_number: 3,
                text: 'Approved amount $9,100.00',
                coordinates: {
                  points: [[42, 104], [252, 104], [252, 136], [42, 136]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
            ],
          },
        },
      },
      executionTrace: {
        facts: {
          billed_amount: 9800,
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T16:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          currentPaymentDue: '$9,800.00',
          invoiceDate: '03/15/2026',
        },
      },
      normalizedDecisions: [
        {
          id: 'decision-override-billed',
          family: 'mismatch',
          severity: 'warning',
          title: 'Amount reviewed',
          detail: 'Operator accepted the corrected billed amount.',
          field_key: 'current_amount_due',
          observed_value: 9900,
          expected_value: 9800,
        },
        {
          id: 'decision-conflict-approved',
          family: 'mismatch',
          severity: 'warning',
          title: 'Approved amount conflict',
          detail: 'Two different approved amount signals were found.',
          field_key: 'approved_amount',
          observed_value: 9100,
          expected_value: 8600,
          evidence_objects: conflictEvidence,
        },
        {
          id: 'decision-missing-period',
          family: 'missing',
          severity: 'warning',
          title: 'Billing period missing',
          detail: 'Billing period still needs manual review.',
          field_key: 'billing_period',
        },
      ],
      reviewedDecisionIds: ['decision-override-billed'],
    });

    assert.equal(model.family, 'invoice');

    const factKeys = model.facts.map((fact) => fact.fieldKey);
    assert.equal(factKeys.filter((key) => key === 'billed_amount').length, 1);
    assert.ok(!factKeys.includes('current_amount_due'));
    assert.ok(!factKeys.includes('total_amount'));

    const billedAmount = getFact(model, 'billed_amount');
    assert.equal(billedAmount.reviewState, 'overridden');
    assert.equal(billedAmount.normalizedDisplay, '$9,800');
    assert.equal(billedAmount.rawDisplay, '$9,800.00');
    assert.equal(billedAmount.schemaGroup, 'amounts');

    const invoiceDate = getFact(model, 'invoice_date');
    assert.equal(invoiceDate.normalizedDisplay, '2026-03-15');
    assert.equal(invoiceDate.rawDisplay, '03/15/2026');

    const approvedAmount = getFact(model, 'approved_amount');
    assert.equal(approvedAmount.reviewState, 'conflicted');
    assert.equal(approvedAmount.evidenceCount, 2);
    assert.deepEqual(
      approvedAmount.anchors.map((anchor) => anchor.pageNumber),
      [2, 3],
    );
    assert.ok(approvedAmount.anchors.every((anchor) => anchor.geometry != null));

    const billingPeriod = getFact(model, 'billing_period');
    assert.equal(billingPeriod.reviewState, 'missing');

    assert.equal(model.counts.conflictingFacts, 1);
  });

  it('prefers extracted rate tables over noisy section signals and keeps rate row count numeric', () => {
    const documentId = 'contract-rate-doc';
    const tableId = 'pdf:table:p18:t1';
    const rows = [
      makeRateTableRow({
        tableId,
        page: 18,
        rowIndex: 1,
        description: 'Pick Up & Haul Vegetative Debris (Field/Public Row) to STL Composting (560 Terminal Row)',
        quantity: '10,000.00',
        unit: 'CY',
        unitPrice: '$36.33',
        extension: '$363,300.00',
      }),
      makeRateTableRow({
        tableId,
        page: 18,
        rowIndex: 2,
        description: 'Pick Up & Haul C&D Debris (Field/Public Row) to Landfill',
        quantity: '5,000.00',
        unit: 'CY',
        unitPrice: '$87.86',
        extension: '$439,300.00',
      }),
      makeRateTableRow({
        tableId,
        page: 18,
        rowIndex: 3,
        description: 'Collect & Dispose of Household Hazardous Waste (HHW)',
        quantity: '100.00',
        unit: 'CY',
        unitPrice: '$495.00',
        extension: '$49,500.00',
      }),
      makeRateTableRow({
        tableId,
        page: 18,
        rowIndex: 4,
        description: 'Collect & Dispose of Friable Asbestos Containing Material (ACM)',
        quantity: '50.00',
        unit: 'CY',
        unitPrice: '$785.00',
        extension: '$39,250.00',
      }),
      makeRateTableRow({
        tableId,
        page: 18,
        rowIndex: 5,
        description: 'Off Route Pickup (Additional Cost to Unit Prices in Items 1-4)',
        quantity: '1,000.00',
        unit: 'CY',
        unitPrice: '$24.10',
        extension: '$24,100.00',
      }),
      makeRateTableRow({
        tableId,
        page: 18,
        rowIndex: 6,
        description: 'Remove White Goods with Freon (Refrigerators, Freezers, Air Conditioners, etc.)',
        quantity: '10.00',
        unit: 'EA',
        unitPrice: '$245.00',
        extension: '$2,450.00',
      }),
      makeRateTableRow({
        tableId,
        page: 18,
        rowIndex: 7,
        description: 'Remove White Goods without Freon (Washers, Dryers, Water Heaters, Stoves, etc.)',
        quantity: '10.00',
        unit: 'EA',
        unitPrice: '$195.00',
        extension: '$1,950.00',
      }),
      makeRateTableRow({
        tableId,
        page: 18,
        rowIndex: 8,
        description: 'Contingency*',
        quantity: '1.00',
        unit: 'EA',
        unitPrice: '$580,150.00',
        extension: '$580,150.00',
      }),
    ];

    const model = buildModel({
      documentId,
      documentType: 'contract',
      documentName: 'st-louis-contract.pdf',
      documentTitle: 'St. Louis Contract',
      preferredExtraction: {
        fields: {
          typed_fields: {
            vendor_name: 'Looks Great Services of MS, Inc.',
          },
        },
        extraction: {
          text_preview: 'ATTACHMENT B UNIT PRICES',
          content_layers_v1: {
            pdf: {
              evidence: [
                makeEvidence({
                  id: 'ev-rate-page-18',
                  documentId,
                  page: 18,
                  text: 'ATTACHMENT B UNIT PRICES',
                  sourceElementId: 'el-rate-page-18',
                }),
                {
                  id: tableId,
                  kind: 'table',
                  source_type: 'pdf',
                  source_document_id: documentId,
                  description: 'PDF table on page 18',
                  text: rows.map((row) => String(row.raw_text ?? '')).join('\n'),
                  location: {
                    page: 18,
                    header_context: ['No.', 'Description', 'Quantity', 'Unit', 'Unit Price', 'Extension'],
                  },
                  confidence: 0.93,
                  weak: false,
                  metadata: { source_document_id: documentId },
                } satisfies EvidenceObject,
              ],
              tables: {
                tables: [
                  {
                    id: tableId,
                    page_number: 18,
                    headers: ['No.', 'Description', 'Quantity', 'Unit', 'Unit Price', 'Extension'],
                    header_context: ['ATTACHMENT B', 'UNIT PRICES'],
                    rows,
                    confidence: 0.93,
                  },
                ],
              },
            },
          },
          evidence_v1: {
            structured_fields: {
              contractor_name: 'Looks Great Services of MS, Inc.',
            },
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [2, 4, 5, 6, 9, 18, 19, 21, 22, 23, 24, 25, 26, 30],
              rate_items_detected: 6,
              unit_price_structure_present: true,
              time_and_materials_present: false,
            },
            page_text: [
              {
                page_number: 18,
                source_method: 'pdf_text',
                text: 'ATTACHMENT B\nUNIT PRICES\n1. Pick Up & Haul Vegetative 10,000.00 CY $36.33 $363,300.00',
              },
            ],
          },
        },
      },
    });

    const rateSchedulePresent = getFact(model, 'rate_schedule_present');
    assert.equal(rateSchedulePresent.normalizedDisplay, 'true');

    const rateSchedulePages = getFact(model, 'rate_schedule_pages');
    assert.equal(rateSchedulePages.normalizedValue, 'page 18');
    assert.equal(rateSchedulePages.normalizedDisplay, 'page 18');

    const rateRowCount = getFact(model, 'rate_row_count');
    assert.equal(rateRowCount.normalizedValue, 8);
    assert.equal(rateRowCount.normalizedDisplay, '8');
    assert.equal(rateRowCount.valueType, 'number');
    assert.notEqual(rateRowCount.normalizedDisplay, '$8');
    assert.notEqual(rateRowCount.normalizedDisplay, '$6');
  });

  it('recognizes alternative structured rate table shapes and suppresses noisy prose pages', () => {
    const cases = [
      {
        documentId: 'schedule-of-rates-doc',
        page: 12,
        headers: ['Item', 'Service', 'Unit', 'Rate'],
        headerContext: ['Schedule of Rates'],
        rows: [
          makeGenericTableRow({
            tableId: 'pdf:table:p12:t1',
            page: 12,
            rowIndex: 1,
            cells: ['A1', 'Emergency Debris Monitoring', 'HR', '125.00'],
          }),
          makeGenericTableRow({
            tableId: 'pdf:table:p12:t1',
            page: 12,
            rowIndex: 2,
            cells: ['A2', 'Load Site Supervision', 'DAY', '950.00'],
          }),
        ],
      },
      {
        documentId: 'price-sheet-doc',
        page: 14,
        headers: ['Description', 'Unit', 'Price'],
        headerContext: ['Price Sheet'],
        rows: [
          makeGenericTableRow({
            tableId: 'pdf:table:p14:t1',
            page: 14,
            rowIndex: 1,
            cells: ['Vegetative Debris Removal', 'CY', '36.33'],
          }),
          makeGenericTableRow({
            tableId: 'pdf:table:p14:t1',
            page: 14,
            rowIndex: 2,
            cells: ['Construction & Demolition Debris', 'TN', '87.86'],
          }),
        ],
      },
      {
        documentId: 'compensation-schedule-doc',
        page: 16,
        headers: ['Rate Code', 'Rate Description', 'Unit', 'Rate'],
        headerContext: ['Compensation Schedule'],
        rows: [
          makeGenericTableRow({
            tableId: 'pdf:table:p16:t1',
            page: 16,
            rowIndex: 1,
            cells: ['RD-1', 'Vegetative Debris Removal', 'CY', '36.33'],
          }),
          makeGenericTableRow({
            tableId: 'pdf:table:p16:t1',
            page: 16,
            rowIndex: 2,
            cells: ['RD-2', 'Mixed C&D Debris Haul Off', 'TN', '87.86'],
          }),
        ],
      },
      {
        documentId: 'tm-rates-doc',
        page: 20,
        headers: ['Labor Class', 'Unit', 'Rate'],
        headerContext: ['Time and Materials Rates'],
        rows: [
          makeGenericTableRow({
            tableId: 'pdf:table:p20:t1',
            page: 20,
            rowIndex: 1,
            cells: ['Equipment Operator', 'HR', '$98.50'],
          }),
          makeGenericTableRow({
            tableId: 'pdf:table:p20:t1',
            page: 20,
            rowIndex: 2,
            cells: ['Truck Foreman', 'HR', '$110.00'],
          }),
        ],
      },
      {
        documentId: 'debris-unit-rates-doc',
        page: 22,
        headers: ['Description', 'Quantity', 'Unit', 'Unit Price'],
        headerContext: ['Emergency Debris Removal Unit Rates'],
        rows: [
          makeGenericTableRow({
            tableId: 'pdf:table:p22:t1',
            page: 22,
            rowIndex: 1,
            cells: ['Vegetative Debris Removal', '1000.00', 'CY', '$36.33'],
          }),
          makeGenericTableRow({
            tableId: 'pdf:table:p22:t1',
            page: 22,
            rowIndex: 2,
            cells: ['Construction & Demolition Debris', '500.00', 'TN', '$87.86'],
          }),
        ],
      },
    ] as const;

    for (const testCase of cases) {
      const model = buildRateScheduleModel(testCase);
      const rateSchedulePresent = getFact(model, 'rate_schedule_present');
      const rateSchedulePages = getFact(model, 'rate_schedule_pages');
      const rateRowCount = getFact(model, 'rate_row_count');

      assert.equal(rateSchedulePresent.normalizedValue, true, testCase.documentId);
      assert.equal(rateSchedulePages.normalizedValue, `page ${testCase.page}`, testCase.documentId);
      assert.equal(rateSchedulePages.normalizedDisplay, `page ${testCase.page}`, testCase.documentId);
      assert.equal(rateRowCount.normalizedValue, testCase.rows.length, testCase.documentId);
      assert.equal(rateRowCount.normalizedDisplay, String(testCase.rows.length), testCase.documentId);
      assert.equal(rateRowCount.valueType, 'number', testCase.documentId);
      assert.notEqual(rateSchedulePages.normalizedValue, 'pages 2, 4, 19, 21', testCase.documentId);
    }
  });

  it('dedupes additional field sources with structured_fields precedence over typed_fields', () => {
    const model = buildModel({
      documentId: 'dedupe-doc',
      documentType: 'contract',
      documentName: 'dedupe.pdf',
      documentTitle: 'Dedupe',
      preferredExtraction: {
        fields: {
          typed_fields: {
            zeta_dup_field: 'typed-layer',
          },
        },
        extraction: {
          content_layers_v1: {
            pdf: {
              evidence: [],
            },
          },
          evidence_v1: {
            structured_fields: {
              zeta_dup_field: 'structured-layer',
            },
            page_text: [],
          },
        },
      },
      executionTrace: {
        facts: {},
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          zeta_dup_field: 'extracted-layer',
        },
      },
    });

    const dup = getFact(model, 'zeta_dup_field');
    assert.equal(dup.normalizedDisplay, 'structured-layer');
    assert.equal(dup.derivationKind, 'structured_fields');
  });

  it('falls back to additional_fields grouping when no schema pattern matches', () => {
    const model = buildModel({
      documentId: 'fallback-doc',
      documentType: 'contract',
      documentName: 'fallback.pdf',
      documentTitle: 'Fallback',
      preferredExtraction: {
        fields: {
          typed_fields: {
            qqqq_unknown_marker: 'unclassified value',
          },
        },
        extraction: {
          content_layers_v1: {
            pdf: {
              evidence: [],
            },
          },
          evidence_v1: {
            page_text: [],
          },
        },
      },
      executionTrace: {
        facts: {},
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {},
      },
    });

    const fact = getFact(model, 'qqqq_unknown_marker');
    assert.equal(fact.schemaGroup, 'additional_fields');
    assert.equal(fact.schemaGroupLabel, 'Additional Extracted Fields');
  });

  it('ranks document-type field priority in ledger comparison (invoice identifiers vs PO)', () => {
    const model = buildModel({
      documentId: 'order-doc',
      documentType: 'invoice',
      documentName: 'order.pdf',
      documentTitle: 'Order',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-900',
            vendor_name: 'Vendor LLC',
            invoice_date: '2026-01-10',
            current_amount_due: 1200,
            po_number: 'PO-77',
          },
        },
        extraction: {
          content_layers_v1: {
            pdf: {
              evidence: [],
            },
          },
          evidence_v1: {
            structured_fields: {
              invoice_number: 'INV-900',
              vendor_name: 'Vendor LLC',
              invoice_date: '2026-01-10',
              total_amount: 1200,
            },
            section_signals: {},
            page_text: [],
          },
        },
      },
      executionTrace: {
        facts: {},
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {},
      },
    });

    const invoice = getFact(model, 'invoice_number');
    const po = getFact(model, 'po_number');
    assert.ok(compareDocumentFactsForLedger(invoice, po, 'invoice') < 0);
  });

  it('resolves geometry via metadata.source_element_id when evidence id differs from parsed element id', () => {
    const documentId = 'geom-id-doc';
    const model = buildModel({
      documentId,
      documentType: 'contract',
      documentName: 'g.pdf',
      documentTitle: 'G',
      preferredExtraction: {
        fields: {
          typed_fields: {
            vendor_name: 'Anchor Co',
          },
        },
        extraction: {
          content_layers_v1: {
            pdf: {
              evidence: [
                makeEvidence({
                  id: 'ev-differs-from-element',
                  documentId,
                  page: 1,
                  text: 'Contractor Anchor Co',
                  label: 'Scope narrative',
                  sourceElementId: 'el-parsed-1',
                }),
              ],
            },
          },
          evidence_v1: {},
          parsed_elements_v1: {
            elements: [
              {
                id: 'el-parsed-1',
                page_number: 1,
                text: 'Contractor Anchor Co',
                coordinates: {
                  points: [[10, 10], [100, 10], [100, 40], [10, 40]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
            ],
          },
        },
      },
      executionTrace: {
        facts: {},
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {},
      },
    });

    const contractor = getFact(model, 'contractor_name');
    assert.ok(contractor.anchors[0]?.geometry);
    assert.equal(contractor.anchors[0]?.geometryResolution, 'source_element_id');
  });

  it('exposes anchorCoverage metrics on the view model', () => {
    const model = buildModel({
      documentId: 'coverage-doc',
      documentType: 'invoice',
      documentName: 'cov.pdf',
      documentTitle: 'Cov',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-1',
          },
        },
        extraction: {
          content_layers_v1: { pdf: { evidence: [] } },
          evidence_v1: {},
        },
      },
      executionTrace: {
        facts: {},
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {},
      },
    });

    assert.equal(model.anchorCoverage.totalFacts, model.facts.length);
    assert.ok(model.anchorCoverage.factsWithAtLeastOneAnchor >= 0);
    assert.ok(model.anchorCoverage.anchorsTotal >= 0);
  });
});
