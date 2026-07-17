import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildDocumentIntelligenceViewModel,
  buildInvoiceLedgerLineDisplay,
  compareDocumentFactsForLedger,
  formatInvoiceServicePeriodRangeFromEndpoints,
  invoiceSurfaceLineItemToLedgerRecord,
  isPlausibleEmbeddedInvoiceRateCode,
  splitEmbeddedInvoiceRateCode,
} from './documentIntelligenceViewModel';
import { deriveLedgerInsightSignals } from './invoiceLedgerInsights';
import type { DocumentFactAnchorRecord } from '@/lib/documentFactAnchors';
import type { DocumentFactReviewRecord } from '@/lib/documentFactReviews';
import type { DocumentFactOverrideRecord } from '@/lib/documentFactOverrides';
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
  headers: readonly string[];
  headerContext: readonly string[];
  rows: readonly Record<string, unknown>[];
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
                  header_context: [...params.headerContext],
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
                  headers: [...params.headers],
                  header_context: [...params.headerContext],
                  rows: [...params.rows],
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
  relatedDocs?: Array<Record<string, unknown>>;
  normalizedDecisions?: NormalizedDecision[];
  executionTrace?: Record<string, unknown> | null;
  factOverrides?: DocumentFactOverrideRecord[];
  factAnchors?: DocumentFactAnchorRecord[];
  factReviews?: DocumentFactReviewRecord[];
  projectValidationSummary?: Record<string, unknown> | null;
  projectValidationStatus?: string | null;
  transactionDatasets?: Array<Record<string, unknown>>;
  transactionRows?: Array<Record<string, unknown>>;
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
    relatedDocs: (params.relatedDocs ?? []) as never,
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
    factOverrides: params.factOverrides ?? [],
    factAnchors: params.factAnchors ?? [],
    factReviews: params.factReviews ?? [],
    projectValidationSummary: params.projectValidationSummary ?? null,
    projectValidationStatus: params.projectValidationStatus ?? null,
    transactionDatasets: params.transactionDatasets ?? [],
    transactionRows: params.transactionRows ?? [],
    reviewedDecisionIds: params.reviewedDecisionIds ?? [],
  });
}

function makeFactOverride(params: {
  id: string;
  documentId: string;
  fieldKey: string;
  valueJson: unknown;
  actionType: 'add' | 'correct';
  createdAt: string;
  isActive?: boolean;
  rawValue?: string | null;
  reason?: string | null;
  supersedesOverrideId?: string | null;
}): DocumentFactOverrideRecord {
  return {
    id: params.id,
    organizationId: 'org-1',
    documentId: params.documentId,
    fieldKey: params.fieldKey,
    valueJson: params.valueJson,
    rawValue: params.rawValue ?? null,
    actionType: params.actionType,
    reason: params.reason ?? null,
    createdBy: 'user-1',
    createdAt: params.createdAt,
    isActive: params.isActive ?? true,
    supersedesOverrideId: params.supersedesOverrideId ?? null,
  };
}

function makeFactAnchor(params: {
  id: string;
  documentId: string;
  fieldKey: string;
  pageNumber: number;
  anchorType: 'text' | 'region' | 'page_range' | 'table_region';
  createdAt: string;
  overrideId?: string | null;
  startPage?: number;
  endPage?: number;
  snippet?: string | null;
  quoteText?: string | null;
  rectJson?: Record<string, unknown> | null;
  anchorJson?: Record<string, unknown> | null;
  isPrimary?: boolean;
}): DocumentFactAnchorRecord {
  return {
    id: params.id,
    organizationId: 'org-1',
    documentId: params.documentId,
    fieldKey: params.fieldKey,
    overrideId: params.overrideId ?? null,
    anchorType: params.anchorType,
    pageNumber: params.pageNumber,
    startPage: params.startPage ?? params.pageNumber,
    endPage: params.endPage ?? params.pageNumber,
    snippet: params.snippet ?? null,
    quoteText: params.quoteText ?? null,
    rectJson: params.rectJson ?? null,
    anchorJson: params.anchorJson ?? null,
    createdBy: 'user-1',
    createdAt: params.createdAt,
    isPrimary: params.isPrimary ?? true,
  };
}

function makeFactReview(params: {
  id: string;
  documentId: string;
  fieldKey: string;
  reviewStatus: 'confirmed' | 'corrected' | 'needs_followup' | 'missing_confirmed';
  reviewedAt: string;
  reviewedValueJson?: unknown;
  notes?: string | null;
}): DocumentFactReviewRecord {
  return {
    id: params.id,
    organizationId: 'org-1',
    documentId: params.documentId,
    fieldKey: params.fieldKey,
    reviewStatus: params.reviewStatus,
    reviewedValueJson:
      Object.prototype.hasOwnProperty.call(params, 'reviewedValueJson')
        ? params.reviewedValueJson
        : null,
    reviewedBy: 'user-1',
    reviewedAt: params.reviewedAt,
    notes: params.notes ?? null,
  };
}

function getFact(model: ReturnType<typeof buildModel>, fieldKey: string) {
  const fact = model.facts.find((entry) => entry.fieldKey === fieldKey);
  assert.ok(fact, `Expected fact ${fieldKey}`);
  return fact;
}

describe('document intelligence view model', () => {
  it('exposes content-layer page text for OCR-backed PDF viewer fallback', () => {
    const model = buildModel({
      documentId: 'ocr-contract',
      documentType: 'contract',
      documentName: 'ocr-contract.pdf',
      documentTitle: 'OCR Contract',
      preferredExtraction: {
        fields: {
          typed_fields: {
            vendor_name: 'Aftermath Disaster Recovery, Inc.',
          },
        },
        extraction: {
          text_preview: 'OCR recovered contract text',
          content_layers_v1: {
            source_kind: 'ocr',
            pdf: {
              evidence: [],
              text: {
                pages: [
                  { page_number: 2, source_method: 'ocr', text: 'Second page OCR text' },
                  { page_number: 1, source_method: 'ocr', text: 'First page OCR text' },
                  { page_number: 1, source_method: 'ocr', text: 'Duplicate page should not win' },
                ],
              },
            },
          },
          evidence_v1: {
            structured_fields: {},
            section_signals: {},
            page_text: [],
          },
        },
      },
    });

    assert.deepEqual(model.sourceTextPages, [
      { pageNumber: 1, sourceMethod: 'ocr', text: 'First page OCR text' },
      { pageNumber: 2, sourceMethod: 'ocr', text: 'Second page OCR text' },
    ]);
  });

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
        text: 'Maximum contract amount: Not to exceed $2,500,000.00',
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
                text: 'Maximum contract amount: Not to exceed $2,500,000.00',
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
    assert.deepEqual(model.sourceTextPages, [
      { pageNumber: 1, sourceMethod: 'pdf_text', text: 'Contractor and effective date text' },
      { pageNumber: 2, sourceMethod: 'pdf_text', text: 'Not to exceed amount text' },
    ]);
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

  it('keeps EMERG03 contract facts grounded and filters metadata-only extraction fields', () => {
    const documentId = 'emerg03-contract-view-model-doc';
    const page1Text = [
      'CONTRACT NO. EMERG03',
      'THIS AGREEMENT is made and entered into by and between the New Mexico Department of Transportation and Stampede Ventures, Inc.',
      'Agreement Date: 8/12/2024',
    ].join('\n');
    const page2Text = [
      'TERM 1.B',
      'The effective date of this Agreement is 8/12/2024.',
      'The total amount payable to the Contractor under this Agreement, inclusive of gross receipts tax and all authorized work, shall not exceed $30,000,000.00.',
    ].join('\n');

    const model = buildModel({
      documentId,
      documentType: 'contract',
      documentName: 'EMERG03_FE.pdf',
      documentTitle: 'EMERG03 Contract',
      preferredExtraction: {
        fields: {
          typed_fields: {
            vendor_name: 'Stampede Ventures, Inc.',
            nte_amount: 30000000,
            contract_date: '2024-08-12',
          },
        },
        extraction: {
          text_preview: `${page1Text}\n\n${page2Text}`,
          content_layers_v1: {
            pdf: {
              evidence: [
                makeEvidence({
                  id: 'ev-emerg03-contractor',
                  documentId,
                  page: 1,
                  text: page1Text,
                  sourceElementId: 'el-emerg03-contractor',
                }),
                makeEvidence({
                  id: 'ev-emerg03-ceiling',
                  documentId,
                  page: 2,
                  text: page2Text,
                  sourceElementId: 'el-emerg03-ceiling',
                }),
              ],
            },
          },
          evidence_v1: {
            structured_fields: {
              contractor_name: 'Stampede Ventures, Inc.',
              contractor_name_source: 'heuristic',
              contractor_name_context: page2Text,
              nte_amount_source: 'page_text',
            },
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [32, 33],
              rate_items_detected: 5,
              unit_price_structure_present: true,
            },
            page_text: [
              {
                page_number: 1,
                source_method: 'pdf_text',
                text: page1Text,
              },
              {
                page_number: 2,
                source_method: 'pdf_text',
                text: page2Text,
              },
            ],
          },
        },
      },
      executionTrace: {
        facts: {
          contractor_name: 'Stampede Ventures, Inc.',
          contract_ceiling: 30000000,
          executed_date: '2024-08-12',
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-28T18:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          vendor_name: 'Stampede Ventures, Inc.',
          contractor:
            'The total amount payable to the Contractor under this Agreement, inclusive of gross receipts tax and all authorized work, shall not exceed $30,000,000.00.',
          notToExceedAmount: '$30,000,000.00',
          contractor_name_source: 'heuristic',
        },
      },
    });

    const contractor = getFact(model, 'contractor_name');
    assert.equal(contractor.displayValue, 'Stampede Ventures, Inc.');
    assert.equal(contractor.rawDisplay, 'Stampede Ventures, Inc.');
    assert.equal(contractor.primaryPage, 1);
    assert.equal(contractor.primaryAnchor?.pageNumber, 1);

    const contractCeiling = getFact(model, 'contract_ceiling');
    assert.equal(contractCeiling.displayValue, '$30,000,000');
    assert.equal(contractCeiling.rawDisplay, '$30,000,000.00');
    assert.equal(contractCeiling.primaryPage, 2);

    assert.ok(!model.facts.some((fact) => /(_source|_context)$/.test(fact.fieldKey)));
    assert.ok(!model.facts.some((fact) => fact.displayValue === 'heuristic'));
  });

  it('prefers curated contractor raw aliases over generic contractor clause text', () => {
    const documentId = 'contractor-raw-alias-priority-doc';
    const contractorClause =
      'The total amount payable to the Contractor under this Agreement, inclusive of gross receipts tax and all authorized work, shall not exceed $30,000,000.00.';

    const model = buildModel({
      documentId,
      documentType: 'contract',
      documentName: 'contractor-raw-alias-priority.pdf',
      documentTitle: 'Contractor Raw Alias Priority',
      preferredExtraction: {
        fields: {
          typed_fields: {
            vendor_name: 'Stampede Ventures, Inc.',
          },
        },
        extraction: {
          content_layers_v1: {
            pdf: {
              evidence: [
                makeEvidence({
                  id: 'ev-contractor-raw-alias-name',
                  documentId,
                  page: 1,
                  text: 'Contractor: Stampede Ventures, Inc.',
                  sourceElementId: 'el-contractor-raw-alias-name',
                }),
                makeEvidence({
                  id: 'ev-contractor-raw-alias-clause',
                  documentId,
                  page: 2,
                  text: contractorClause,
                  sourceElementId: 'el-contractor-raw-alias-clause',
                }),
              ],
            },
          },
          evidence_v1: {
            structured_fields: {},
          },
        },
      },
      executionTrace: {
        facts: {
          contractor_name: 'Stampede Ventures, Inc.',
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-28T18:20:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          vendor_name: 'Stampede Ventures, Inc.',
          contractor: contractorClause,
        },
      },
    });

    const contractor = getFact(model, 'contractor_name');
    assert.equal(contractor.displayValue, 'Stampede Ventures, Inc.');
    assert.equal(contractor.rawDisplay, 'Stampede Ventures, Inc.');
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

  it('uses active human corrections for display while preserving machine values and history', () => {
    const documentId = 'invoice-override-doc';

    const model = buildModel({
      documentId,
      documentType: 'invoice',
      documentName: 'invoice-override.pdf',
      documentTitle: 'Invoice Override',
      preferredExtraction: {
        fields: {
          typed_fields: {
            current_amount_due: 9800,
          },
        },
        extraction: {
          evidence_v1: {
            structured_fields: {
              current_amount_due: 9800,
            },
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
        },
      },
      factOverrides: [
        makeFactOverride({
          id: 'override-old',
          documentId,
          fieldKey: 'billed_amount',
          valueJson: 9950,
          actionType: 'correct',
          createdAt: '2026-03-24T10:00:00Z',
          isActive: false,
        }),
        makeFactOverride({
          id: 'override-active',
          documentId,
          fieldKey: 'billed_amount',
          valueJson: 10100,
          actionType: 'correct',
          createdAt: '2026-03-24T12:00:00Z',
          rawValue: '$10,100.00',
          reason: 'Confirmed against operator review.',
        }),
      ],
      factReviews: [
        makeFactReview({
          id: 'review-billed-amount',
          documentId,
          fieldKey: 'billed_amount',
          reviewStatus: 'corrected',
          reviewedValueJson: 10050,
          reviewedAt: '2026-03-24T11:00:00Z',
          notes: 'Operator first corrected the amount before saving the final override.',
        }),
      ],
    });

    const billedAmount = getFact(model, 'billed_amount');
    assert.equal(billedAmount.displaySource, 'human_corrected');
    assert.equal(billedAmount.displayValue, '$10,100');
    assert.equal(billedAmount.machineDisplay, '$9,800');
    assert.equal(billedAmount.normalizedDisplay, '$9,800');
    assert.equal(billedAmount.humanDisplay, '$10,100');
    assert.equal(billedAmount.reviewState, 'overridden');
    assert.equal(billedAmount.overrideHistory.length, 2);
    assert.equal(billedAmount.overrideHistory[0]?.isActive, true);
    assert.equal(billedAmount.overrideHistory[0]?.valueDisplay, '$10,100');
    assert.equal(billedAmount.reviewStatus, 'corrected');
    assert.equal(billedAmount.reviewedAt, '2026-03-24T11:00:00Z');
    assert.equal(billedAmount.reviewHistory.length, 1);
    assert.equal(billedAmount.reviewHistory[0]?.reviewStatus, 'corrected');
    assert.equal(billedAmount.reviewHistory[0]?.reviewedValueDisplay, '$10,050');
  });

  it('marks facts confirmed without replacing the extracted value', () => {
    const documentId = 'invoice-review-confirmed-doc';

    const model = buildModel({
      documentId,
      documentType: 'invoice',
      documentName: 'invoice-review-confirmed.pdf',
      documentTitle: 'Invoice Review Confirmed',
      preferredExtraction: {
        fields: {
          typed_fields: {
            current_amount_due: 9800,
          },
        },
        extraction: {
          evidence_v1: {
            structured_fields: {
              current_amount_due: 9800,
            },
          },
        },
      },
      executionTrace: {
        facts: {
          billed_amount: 9800,
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-25T08:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          currentPaymentDue: '$9,800.00',
        },
      },
      factReviews: [
        makeFactReview({
          id: 'review-confirmed-billed-amount',
          documentId,
          fieldKey: 'billed_amount',
          reviewStatus: 'confirmed',
          reviewedAt: '2026-03-25T08:15:00Z',
          notes: 'Confirmed against the signed invoice total.',
        }),
      ],
    });

    const billedAmount = getFact(model, 'billed_amount');
    assert.equal(billedAmount.displaySource, 'auto');
    assert.equal(billedAmount.displayValue, '$9,800');
    assert.equal(billedAmount.machineDisplay, '$9,800');
    assert.equal(billedAmount.humanDisplay, null);
    assert.equal(billedAmount.reviewState, 'reviewed');
    assert.equal(billedAmount.reviewStatus, 'confirmed');
    assert.equal(billedAmount.reviewedBy, 'user-1');
    assert.equal(billedAmount.reviewedAt, '2026-03-25T08:15:00Z');
    assert.equal(billedAmount.reviewNotes, 'Confirmed against the signed invoice total.');
    assert.equal(billedAmount.statusLabel, 'confirmed');
  });

  it('uses reviewed corrections when no active override exists', () => {
    const documentId = 'invoice-review-corrected-doc';

    const model = buildModel({
      documentId,
      documentType: 'invoice',
      documentName: 'invoice-review-corrected.pdf',
      documentTitle: 'Invoice Review Corrected',
      preferredExtraction: {
        fields: {
          typed_fields: {
            current_amount_due: 9800,
          },
        },
        extraction: {
          evidence_v1: {
            structured_fields: {
              current_amount_due: 9800,
            },
          },
        },
      },
      executionTrace: {
        facts: {
          billed_amount: 9800,
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-25T09:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          currentPaymentDue: '$9,800.00',
        },
      },
      factReviews: [
        makeFactReview({
          id: 'review-corrected-billed-amount',
          documentId,
          fieldKey: 'billed_amount',
          reviewStatus: 'corrected',
          reviewedValueJson: 10100,
          reviewedAt: '2026-03-25T09:10:00Z',
          notes: 'Corrected after remittance review.',
        }),
      ],
    });

    const billedAmount = getFact(model, 'billed_amount');
    assert.equal(billedAmount.displaySource, 'human_corrected');
    assert.equal(billedAmount.displayValue, '$10,100');
    assert.equal(billedAmount.machineDisplay, '$9,800');
    assert.equal(billedAmount.humanDisplay, '$10,100');
    assert.equal(billedAmount.reviewState, 'reviewed');
    assert.equal(billedAmount.reviewStatus, 'corrected');
    assert.equal(billedAmount.reviewedAt, '2026-03-25T09:10:00Z');
    assert.equal(billedAmount.reviewNotes, 'Corrected after remittance review.');
    assert.equal(billedAmount.statusLabel, 'reviewed correction');
  });

  it('creates a persisted fact row for human-added values with no machine extraction', () => {
    const documentId = 'invoice-added-fact-doc';

    const model = buildModel({
      documentId,
      documentType: 'invoice',
      documentName: 'invoice-added.pdf',
      documentTitle: 'Invoice Added Fact',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-333',
          },
        },
        extraction: {
          evidence_v1: {
            structured_fields: {
              invoice_number: 'INV-333',
            },
          },
        },
      },
      factOverrides: [
        makeFactOverride({
          id: 'override-add-billing-period',
          documentId,
          fieldKey: 'billing_period',
          valueJson: '2026-03-01 to 2026-03-31',
          actionType: 'add',
          createdAt: '2026-03-25T09:30:00Z',
          reason: 'Provided by operator from cover sheet.',
        }),
      ],
    });

    const billingPeriod = getFact(model, 'billing_period');
    assert.equal(billingPeriod.displaySource, 'human_added');
    assert.equal(billingPeriod.displayValue, '2026-03-01 to 2026-03-31');
    assert.equal(billingPeriod.machineDisplay, 'Missing');
    assert.equal(billingPeriod.reviewState, 'overridden');
    assert.equal(billingPeriod.overrideHistory.length, 1);
  });

  it('counts missing evidence for human-added facts until an anchor is attached', () => {
    const documentId = 'invoice-human-evidence-gap-doc';

    const withoutAnchor = buildModel({
      documentId,
      documentType: 'invoice',
      documentName: 'invoice-human-evidence-gap.pdf',
      documentTitle: 'Invoice Human Evidence Gap',
      preferredExtraction: {
        fields: {
          typed_fields: {},
        },
        extraction: {
          evidence_v1: {
            structured_fields: {},
          },
        },
      },
      factOverrides: [
        makeFactOverride({
          id: 'override-add-billing-period-gap',
          documentId,
          fieldKey: 'billing_period',
          valueJson: '2026-03-01 to 2026-03-31',
          actionType: 'add',
          createdAt: '2026-03-25T09:30:00Z',
        }),
      ],
    });

    const billingPeriodWithoutAnchor = getFact(withoutAnchor, 'billing_period');
    assert.equal(billingPeriodWithoutAnchor.displaySource, 'human_added');
    assert.equal(billingPeriodWithoutAnchor.anchorCount, 0);
    assert.ok(withoutAnchor.counts.missingEvidenceFacts >= 1);

    const withAnchor = buildModel({
      documentId,
      documentType: 'invoice',
      documentName: 'invoice-human-evidence-gap.pdf',
      documentTitle: 'Invoice Human Evidence Gap',
      preferredExtraction: {
        fields: {
          typed_fields: {},
        },
        extraction: {
          evidence_v1: {
            structured_fields: {},
          },
        },
      },
      factOverrides: [
        makeFactOverride({
          id: 'override-add-billing-period-gap',
          documentId,
          fieldKey: 'billing_period',
          valueJson: '2026-03-01 to 2026-03-31',
          actionType: 'add',
          createdAt: '2026-03-25T09:30:00Z',
        }),
      ],
      factAnchors: [
        makeFactAnchor({
          id: 'anchor-billing-period-gap',
          documentId,
          fieldKey: 'billing_period',
          anchorType: 'text',
          pageNumber: 2,
          snippet: 'Billing period 03/01/2026 through 03/31/2026',
          createdAt: '2026-03-25T09:35:00Z',
        }),
      ],
    });

    const billingPeriodWithAnchor = getFact(withAnchor, 'billing_period');
    assert.equal(billingPeriodWithAnchor.anchorCount, 1);
    assert.equal(billingPeriodWithAnchor.primaryAnchor?.id, 'manual:anchor-billing-period-gap');
    assert.equal(withAnchor.counts.missingEvidenceFacts, withoutAnchor.counts.missingEvidenceFacts - 1);
  });

  it('applies display precedence: active override beats reviewed correction and machine value', () => {
    const documentId = 'precedence-override-doc';
    const model = buildModel({
      documentId,
      documentType: 'contract',
      documentName: 'precedence.pdf',
      documentTitle: 'Precedence',
      preferredExtraction: {
        fields: {
          typed_fields: {
            contractor_name: 'Machine Vendor LLC',
          },
        },
        extraction: {
          content_layers_v1: {
            pdf: {
              evidence: [
                makeEvidence({
                  id: 'ev-vendor',
                  documentId,
                  page: 1,
                  text: 'Contractor: Machine Vendor LLC',
                  sourceElementId: 'el-vendor',
                }),
              ],
            },
          },
        },
      },
      factReviews: [
        makeFactReview({
          id: 'rev-vendor-1',
          documentId,
          fieldKey: 'contractor_name',
          reviewStatus: 'corrected',
          reviewedValueJson: 'Reviewed Vendor Inc',
          reviewedAt: '2026-03-28T10:00:00Z',
        }),
      ],
      factOverrides: [
        makeFactOverride({
          id: 'ov-vendor-1',
          documentId,
          fieldKey: 'contractor_name',
          valueJson: 'Override Vendor Corp',
          actionType: 'correct',
          createdAt: '2026-03-28T11:00:00Z',
        }),
      ],
    });

    const vendor = getFact(model, 'contractor_name');
    assert.equal(vendor.displayValue, 'Override Vendor Corp');
    assert.equal(vendor.humanDisplay, 'Override Vendor Corp');
    assert.equal(vendor.reviewState, 'overridden');
    assert.equal(vendor.reviewStatus, 'corrected');
  });

  it('merges persisted human anchors into facts and promotes the primary anchor', () => {
    const documentId = 'invoice-anchor-doc';

    const model = buildModel({
      documentId,
      documentType: 'invoice',
      documentName: 'invoice-anchor.pdf',
      documentTitle: 'Invoice Anchor',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-204',
            current_amount_due: 9800,
          },
        },
        extraction: {
          content_layers_v1: {
            pdf: {
              evidence: [
                makeEvidence({
                  id: 'ev-billed-amount',
                  documentId,
                  page: 1,
                  text: 'Current amount due $9,800.00',
                  sourceElementId: 'el-billed-amount',
                }),
              ],
            },
          },
          evidence_v1: {
            structured_fields: {
              invoice_number: 'INV-204',
              current_amount_due: 9800,
            },
          },
          parsed_elements_v1: {
            elements: [
              {
                id: 'el-billed-amount',
                page_number: 1,
                text: 'Current amount due $9,800.00',
                coordinates: {
                  points: [[40, 120], [280, 120], [280, 156], [40, 156]],
                  layout_width: 612,
                  layout_height: 792,
                },
              },
            ],
          },
        },
      },
      factOverrides: [
        makeFactOverride({
          id: 'override-billed-amount',
          documentId,
          fieldKey: 'billed_amount',
          valueJson: 10100,
          actionType: 'correct',
          createdAt: '2026-03-25T10:00:00Z',
        }),
      ],
      factAnchors: [
        makeFactAnchor({
          id: 'anchor-billed-amount',
          documentId,
          fieldKey: 'billed_amount',
          overrideId: 'override-billed-amount',
          anchorType: 'region',
          pageNumber: 2,
          snippet: 'Operator selected corrected total on page 2.',
          rectJson: {
            x: 88,
            y: 140,
            width: 190,
            height: 28,
            layoutWidth: 612,
            layoutHeight: 792,
          },
          createdAt: '2026-03-25T10:05:00Z',
          isPrimary: true,
        }),
      ],
    });

    const billedAmount = getFact(model, 'billed_amount');
    assert.equal(billedAmount.anchorCount, 2);
    assert.equal(billedAmount.primaryPage, 2);
    assert.equal(billedAmount.primaryAnchor?.id, 'manual:anchor-billed-amount');
    assert.equal(billedAmount.primaryAnchor?.anchorSource, 'human');
    assert.equal(billedAmount.primaryAnchor?.anchorType, 'region');
    assert.equal(billedAmount.anchors[1]?.anchorSource, 'machine');
  });

  it('respects a human-defined rate schedule over machine schedule detection', () => {
    const documentId = 'contract-human-schedule-doc';

    const model = buildModel({
      documentId,
      documentType: 'contract',
      documentName: 'contract-human-schedule.pdf',
      documentTitle: 'Contract Human Schedule',
      preferredExtraction: {
        fields: {
          typed_fields: {
            vendor_name: 'Acme Debris LLC',
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
              contractor_name: 'Acme Debris LLC',
            },
            section_signals: {
              rate_section_present: true,
              rate_section_pages: [4],
              rate_items_detected: 6,
              unit_price_structure_present: true,
            },
          },
        },
      },
      factAnchors: [
        makeFactAnchor({
          id: 'anchor-rate-schedule',
          documentId,
          fieldKey: 'rate_schedule_pages',
          anchorType: 'page_range',
          pageNumber: 10,
          startPage: 10,
          endPage: 12,
          snippet: 'Operator marked the contract rate schedule on pages 10 through 12.',
          createdAt: '2026-03-28T15:00:00Z',
        }),
      ],
    });

    const rateSchedulePresent = getFact(model, 'rate_schedule_present');
    const rateSchedulePages = getFact(model, 'rate_schedule_pages');

    assert.equal(rateSchedulePresent.displaySource, 'human_corrected');
    assert.equal(rateSchedulePresent.displayValue, 'true');
    assert.equal(rateSchedulePresent.machineDisplay, 'true');
    assert.equal(rateSchedulePresent.humanDefinedSchedule, true);

    assert.equal(rateSchedulePages.displaySource, 'human_corrected');
    assert.equal(rateSchedulePages.displayValue, 'pages 10-12');
    assert.equal(rateSchedulePages.machineDisplay, 'page 4');
    assert.equal(rateSchedulePages.humanDisplay, 'pages 10-12');
    assert.equal(rateSchedulePages.primaryAnchor?.anchorType, 'page_range');
    assert.equal(rateSchedulePages.primaryAnchor?.startPage, 10);
    assert.equal(rateSchedulePages.primaryAnchor?.endPage, 12);

    assert.equal(model.rateScheduleSource, 'human');
    assert.equal(model.rateSchedulePages, 'pages 10-12');
    assert.equal(model.rateScheduleAnchor?.anchorType, 'page_range');
    assert.equal(model.pageMarkerCounts[10], 1);
    assert.equal(model.pageMarkerCounts[12], 1);
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
      // The source table row count is a qualification estimate, not canonical
      // persisted truth. Canonical counts are asserted against the persisted
      // contract_analysis.rate_schedule_rows array elsewhere.
      assert.equal(typeof rateRowCount.normalizedValue, 'number', testCase.documentId);
      assert.equal(rateRowCount.normalizedDisplay, String(rateRowCount.normalizedValue), testCase.documentId);
      assert.equal(rateRowCount.valueType, 'number', testCase.documentId);
      assert.notEqual(rateSchedulePages.normalizedValue, 'pages 2, 4, 19, 21', testCase.documentId);
    }
  });

  it('surfaces canonical contract rate rows from persisted contract analysis', () => {
    const model = buildModel({
      documentId: 'contract-rate-trace-doc',
      documentType: 'contract',
      documentName: 'rate-trace-contract.pdf',
      documentTitle: 'Rate Trace Contract',
      preferredExtraction: {
        fields: {
          typed_fields: {
            vendor_name: 'Acme Debris LLC',
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
              contractor_name: 'Acme Debris LLC',
            },
            section_signals: {
              rate_schedule_present: true,
              rate_schedule_pages: [8],
              rate_row_count: 2,
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
        extracted: {},
        contract_analysis: {
          rate_schedule_rows: [
            {
              row_id: 'row-1',
              description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
              unit: 'Cubic Yard',
              rate: 6.9,
              category: 'Vegetative Collect, Remove & Haul',
              page: 8,
              source_anchor_ids: ['anchor-1'],
              rate_raw:
                'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
              material_type: 'Vegetative Collect, Remove & Haul',
              unit_type: 'Cubic Yard',
              rate_amount: 6.9,
            },
            {
              row_id: 'row-2',
              description: 'from ROW to DMS 0 to 15 Miles',
              unit: 'Cubic Yard',
              rate: null,
              category: 'C&D Collect, Remove & Haul',
              page: 8,
              source_anchor_ids: [],
              rate_raw: 'C&D Collect, Remove & Haul | from ROW to DMS 0 to 15 Miles | Cubic Yard | $87.86',
              material_type: 'C&D Collect, Remove & Haul',
              unit_type: 'Cubic Yard',
              rate_amount: 87.86,
            },
          ],
        },
      },
    });

    assert.deepEqual(model.contractRateRows, [
      {
        rowId: 'row-1',
        description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
        unit: 'Cubic Yard',
        rate: 6.9,
        category: 'Vegetative Collect, Remove & Haul',
        page: 8,
        sourceAnchorIds: ['anchor-1'],
      },
      {
        rowId: 'row-2',
        description: 'from ROW to DMS 0 to 15 Miles',
        unit: 'Cubic Yard',
        rate: 87.86,
        category: 'C&D Collect, Remove & Haul',
        page: 8,
        sourceAnchorIds: [],
      },
    ]);
    assert.equal(model.contractPricingAssemblyRows?.[0]?.id, 'row-1');
    assert.equal(
      model.contractPricingAssemblyRows?.[0]?.description,
      'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
    );
    assert.equal(model.contractPricingAssemblyRows?.[0]?.unit, 'Cubic Yard');
    assert.equal(model.contractPricingAssemblyRows?.[0]?.rate, 6.9);
    assert.equal(model.contractPricingAssemblyRows?.[0]?.sourceAnchor, 'anchor-1');
    assert.equal(model.contractPricingAssemblyRows?.[1]?.id, 'row-2');
    assert.equal(model.contractPricingAssemblyRows?.[1]?.rate, 87.86);
  });

  it('surfaces contract pricing assembly for an attached price-sheet support document', () => {
    const model = buildModel({
      documentId: 'mvsu-exhibit-a-price-sheet',
      documentType: 'price_sheet',
      documentName: 'MVSU Exhibit A.pdf',
      documentTitle: 'MVSU Exhibit A',
      relatedDocs: [
        {
          id: 'mvsu-draft-contract',
          document_type: 'contract',
          name: 'MVSU Draft Contract.pdf',
          title: 'MVSU Draft Contract',
          extraction: null,
          relationship_type: 'attached_to',
          relationship_source_document_id: 'mvsu-exhibit-a-price-sheet',
          relationship_target_document_id: 'mvsu-draft-contract',
        },
      ],
      preferredExtraction: {
        extraction: {},
      },
      executionTrace: {
        facts: {},
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {},
        contract_analysis: {
          rate_schedule_rows: [
            {
              row_id: 'pdf:table:p1:t1:professional:r1',
              description: 'Operations Manager',
              unit: 'Hour',
              rate: 125,
              quantity_text: '1 staff, 13 hrs/day, 7 days',
              total_amount: 11375,
              category: 'Personnel',
              canonical_category: 'personnel',
              category_confidence: 0.95,
              page: 1,
              source_anchor_ids: ['pdf:table:p1:t1:r1'],
              source_kind: 'professional_services_table',
            },
          ],
        },
      },
    });

    assert.equal(model.shouldSurfaceContractPricingAssembly, true);
    assert.equal(model.contractPricingAssemblyRows?.length, 1);
    assert.equal(model.contractPricingAssemblyRows?.[0]?.description, 'Operations Manager');
    assert.equal(model.contractPricingAssemblyRows?.[0]?.quantityText, '1 staff, 13 hrs/day, 7 days');
    assert.equal(model.contractPricingAssemblyRows?.[0]?.totalAmount, 11375);
  });

  it('does not synthesize contract rate rows from legacy extraction signals alone', () => {
    const model = buildRateScheduleModel({
      documentId: 'contract-rate-ui-canonical-only-doc',
      page: 18,
      headers: ['Item', 'Qty', 'Unit', 'Rate'],
      headerContext: ['Exhibit A', 'Rate Schedule'],
      rows: [
        makeGenericTableRow({
          tableId: 'pdf:table:p18:t1',
          page: 18,
          rowIndex: 1,
          cells: ['Vegetative Debris Removal', '1000.00', 'CY', '$36.33'],
        }),
      ],
    });

    assert.deepEqual(model.contractRateRows, []);
  });

  it('renders contract rate shadow assembly diagnostics from normalized extracted output', () => {
    const model = buildRateScheduleModel({
      documentId: 'contract-shadow-diagnostics-doc',
      page: 18,
      headers: ['Category', 'Description', 'Unit', 'Rate'],
      headerContext: ['Exhibit A', 'EMERGENCY DEBRIS REMOVAL UNIT RATES'],
      rows: [
        makeGenericTableRow({
          tableId: 'pdf:table:p18:t1',
          page: 18,
          rowIndex: 1,
          cells: ['Vegetative', '0-15 Miles from ROW to DMS', 'Cubic Yard', '$6.90'],
        }),
        makeGenericTableRow({
          tableId: 'pdf:table:p18:t1',
          page: 18,
          rowIndex: 2,
          cells: ['Vegetative', '16-30 Miles from ROW to DMS', 'Cubic Yard', '$7.90'],
        }),
      ],
    });

    const diagnostic = model.diagnostics.find((drawer) => drawer.id === 'canonical_contract_rate_schedule_assembly');
    assert.ok(diagnostic);
    assert.equal(diagnostic.title, 'Contract Rate Assembly');
    assert.match(diagnostic.textBlocks?.[0]?.content ?? '', /Rows reconstructed: 2/);
    assert.match(diagnostic.textBlocks?.[0]?.content ?? '', /Evidence refs: present/);
    assert.match(diagnostic.textBlocks?.[0]?.content ?? '', /Shadow mode: active — parser authoritative/);
    assert.equal(diagnostic.rowInspection?.label, 'Inspect rows');
    assert.equal(diagnostic.rowInspection?.rows.length, 2);
  });

  it('renders invoice operational row assembly diagnostics from trace extracted output', () => {
    const model = buildModel({
      documentId: 'invoice-shadow-diagnostics-doc',
      documentType: 'invoice',
      documentName: 'invoice-shadow.pdf',
      documentTitle: 'Invoice Shadow',
      preferredExtraction: {
        fields: { typed_fields: {} },
        extraction: {
          content_layers_v1: { pdf: { evidence: [] } },
          evidence_v1: { structured_fields: {}, page_text: [] },
        },
      },
      executionTrace: {
        facts: {},
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          canonicalOperationalTableRowAssembly: {
            rows: [
              {
                row_id: 'invoice-row-1',
                rate_code: '1A',
                row_role: 'line_item',
                confidence: 1,
                warnings: [],
                evidence_refs: [{ raw_text: '1A', field_assigned: 'rate_code' }],
              },
            ],
            rejected_rows: [],
            unclassified_rows: [],
            assembly_warnings: [],
          },
        },
      },
    });

    const diagnostic = model.diagnostics.find((drawer) => drawer.id === 'canonical_operational_table_row_assembly');
    assert.ok(diagnostic);
    assert.equal(diagnostic.title, 'Invoice Operational Row Assembly');
    assert.match(diagnostic.textBlocks?.[0]?.content ?? '', /Rows reconstructed: 1/);
    assert.match(diagnostic.textBlocks?.[0]?.content ?? '', /Evidence refs: present/);
    assert.equal(diagnostic.rowInspection?.rows[0]?.rate_code, '1A');
  });

  it('renders cross-document rate diff diagnostics from trace extracted output', () => {
    const model = buildModel({
      documentId: 'invoice-rate-diff-diagnostics-doc',
      documentType: 'invoice',
      documentName: 'invoice-rate-diff.pdf',
      documentTitle: 'Invoice Rate Diff',
      preferredExtraction: {
        fields: { typed_fields: {} },
        extraction: {
          content_layers_v1: { pdf: { evidence: [] } },
          evidence_v1: { structured_fields: {}, page_text: [] },
        },
      },
      executionTrace: {
        facts: {},
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          canonicalOperationalRateDiff: {
            project_id: null,
            invoice_document_id: 'invoice-rate-diff-diagnostics-doc',
            contract_document_id: 'contract-rate-diff-diagnostics-doc',
            generated_at: '2026-05-13T12:00:00.000Z',
            summary: {
              matched_rows: 1,
              ambiguous_rows: 0,
              unmatched_rows: 0,
              low_confidence_matches: 0,
              rows_exceeding_contract_ceiling: 1,
              passthrough_rows: 0,
              tm_rows: 0,
            },
            rows: [
              {
                invoice_row_id: 'invoice:r1',
                contract_row_id: 'contract:r1',
                variance_status: 'exceeds_ceiling',
                match_confidence: 0.92,
                mismatch_reasons: ['invoice rate exceeds contract rate'],
                candidate_matches: [{ contract_row_id: 'contract:r1' }],
              },
            ],
          },
        },
      },
    });

    const diagnostic = model.diagnostics.find((drawer) => drawer.id === 'canonical_operational_rate_diff');
    assert.ok(diagnostic);
    assert.equal(diagnostic.title, 'Cross Document Rate Diff');
    assert.match(diagnostic.textBlocks?.[0]?.content ?? '', /Matched rows: 1/);
    assert.match(diagnostic.textBlocks?.[0]?.content ?? '', /Low-confidence matches: 0/);
    assert.match(diagnostic.textBlocks?.[0]?.content ?? '', /Rows exceeding contract ceiling: 1/);
    assert.match(diagnostic.textBlocks?.[0]?.content ?? '', /Shadow mode: active - no approval or payment gating/);
    assert.equal(diagnostic.rowInspection?.rows[0]?.row_role, 'exceeds_ceiling');
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

  it('prioritizes transaction_data dataset review groups ahead of row drilldown', () => {
    const model = buildModel({
      documentId: 'transaction-review-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {
            structured_fields: {
              source_type: 'transaction_data',
              row_count: 4,
              total_tickets: 4,
              total_cyd: 56,
              distinct_invoice_count: 2,
              total_invoiced_amount: 1449,
              project_operations_overview: {
                total_tickets: 4,
                distinct_invoice_count: 2,
              },
              invoice_readiness_summary: {
                status: 'partial',
                outlier_row_count: 1,
              },
              grouped_by_service_item: [
                {
                  service_item: 'Hauling',
                  row_count: 3,
                  total_transaction_quantity: 16,
                  total_extended_cost: 1449,
                },
              ],
              grouped_by_material: [
                {
                  material: 'Vegetative',
                  row_count: 3,
                  total_transaction_quantity: 16,
                  total_extended_cost: 1449,
                },
              ],
              grouped_by_site_type: [
                {
                  site_type: 'DMS',
                  row_count: 2,
                  total_transaction_quantity: 8,
                  total_extended_cost: 724.5,
                },
              ],
              grouped_by_disposal_site: [
                {
                  disposal_site: 'Ag Center DMS',
                  row_count: 2,
                  total_transaction_quantity: 8,
                  total_extended_cost: 724.5,
                },
              ],
              outlier_rows: [
                {
                  record_id: 'transaction:ticket_query:7',
                  source_sheet_name: 'ticket_query',
                  source_row_number: 7,
                  reasons: ['transaction rate deviates from baseline'],
                },
              ],
              boundary_location_review: {
                status: 'warning',
                flagged_row_count: 1,
              },
              transaction_data_records: [
                {
                  id: 'transaction:ticket_query:3',
                  transaction_number: 'TX-1001',
                },
              ],
              sheet_names: ['ticket_query'],
              detected_header_map: {
                invoice_number: [{ column_name: 'Invoice #' }],
              },
            },
          },
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                source_type: 'transaction_data',
              },
            },
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

    assert.deepEqual(
      model.groups.map((group) => group.key).slice(0, 4),
      ['dataset_summary', 'grouped_review_tables', 'flags_outliers', 'row_drilldown'],
    );
    assert.equal(getFact(model, 'project_operations_overview').schemaGroup, 'dataset_summary');
    assert.equal(getFact(model, 'invoice_readiness_summary').schemaGroup, 'dataset_summary');
    assert.equal(getFact(model, 'grouped_by_service_item').schemaGroup, 'grouped_review_tables');
    assert.equal(getFact(model, 'outlier_rows').schemaGroup, 'flags_outliers');
    assert.equal(getFact(model, 'transaction_data_records').schemaGroup, 'row_drilldown');
  });

  it('builds spreadsheet review data from canonical transaction rows when the persisted trace is compacted', () => {
    const model = buildDocumentIntelligenceViewModel({
      documentId: 'spreadsheet-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      projectName: 'Storm Debris Cleanup',
      preferredExtraction: null,
      relatedDocs: [],
      normalizedDecisions: [],
      extractionGaps: [],
      auditNotes: [],
      nodeTraces: [],
      executionTrace: {
        facts: {
          source_type: 'transaction_data',
          row_count: 1,
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-04-18T12:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          sourceType: 'transaction_data',
          rowCount: 1,
          summary: {
            row_count: 1,
          },
          rollups: {
            totalTickets: 1,
          },
        },
      },
      extractionHistory: [],
      factOverrides: [],
      factAnchors: [],
      factReviews: [],
      transactionDatasets: [
        {
          id: 'dataset-1',
          summary_json: {
            row_count: 1,
            total_tickets: 1,
            total_cyd: 12,
            distinct_invoice_count: 1,
            total_invoiced_amount: 1250,
            uninvoiced_line_count: 0,
            eligible_count: 1,
            ineligible_count: 0,
            unknown_eligibility_count: 0,
            grouped_by_rate_code: [
              {
                rate_code: 'RC-01',
                billing_rate_key: 'RC01',
                row_count: 1,
                total_transaction_quantity: 12,
                total_extended_cost: 1250,
                record_ids: ['row-1'],
              },
            ],
          },
        },
      ],
      transactionRows: [
        {
          id: 'row-1',
          record_json: {
            id: 'row-1',
            invoice_number: 'INV-100',
            transaction_number: 'TX-1001',
            rate_code: 'RC-01',
            transaction_quantity: 12,
            extended_cost: 1250,
            source_sheet_name: 'ticket_query',
            source_row_number: 3,
          },
          raw_row_json: {
            'Invoice #': 'INV-100',
            'Transaction #': 'TX-1001',
          },
        },
      ],
      reviewedDecisionIds: [],
    });

    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.transactionDataExtraction?.records?.length ?? 0, 0);
    assert.equal(model.spreadsheetReviewDataset?.records.length, 1);
    assert.equal(model.spreadsheetReviewDataset?.records[0]?.invoice_number, 'INV-100');
    assert.equal(model.spreadsheetReviewDataset?.groupedByRateCode[0]?.rate_code, 'RC-01');
  });

  it('keeps spreadsheet review KPIs and grouped rollups canonical when stale extraction summary data is also present', () => {
    const model = buildDocumentIntelligenceViewModel({
      documentId: 'spreadsheet-canonical-precedence-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      projectName: 'Storm Debris Cleanup',
      preferredExtraction: null,
      relatedDocs: [],
      normalizedDecisions: [],
      extractionGaps: [],
      auditNotes: [],
      nodeTraces: [],
      executionTrace: {
        facts: {
          source_type: 'transaction_data',
          row_count: 750,
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-04-18T12:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          sourceType: 'transaction_data',
          rowCount: 750,
          projectOperationsOverview: {
            project_name: 'Storm Debris Cleanup',
            total_tickets: 750,
            total_transaction_quantity: 0,
            total_cyd: 0,
            total_invoiced_amount: 0,
            distinct_invoice_count: 0,
            invoiced_ticket_count: 0,
            uninvoiced_line_count: 750,
            eligible_count: 0,
            ineligible_count: 0,
            unknown_eligibility_count: 750,
            distinct_service_item_count: 0,
            distinct_material_count: 0,
            distinct_site_type_count: 0,
            distinct_disposal_site_count: 0,
            reviewed_sheet_names: ['ticket_query'],
            record_ids: [],
            evidence_refs: [],
          },
          summary: {
            row_count: 750,
            total_tickets: 750,
            total_cyd: 0,
            distinct_invoice_count: 0,
            total_invoiced_amount: 0,
            uninvoiced_line_count: 750,
            eligible_count: 0,
            ineligible_count: 0,
            unknown_eligibility_count: 750,
            grouped_by_rate_code: [
              {
                rate_code: 'STALE-RC',
                billing_rate_key: 'STALE-RC',
                row_count: 750,
                total_transaction_quantity: 0,
                total_extended_cost: 0,
                record_ids: ['stale-row-1'],
              },
            ],
          },
          rollups: {
            totalTickets: 750,
            totalCyd: 0,
            distinctInvoiceCount: 0,
            totalInvoicedAmount: 0,
            uninvoicedLineCount: 750,
            groupedByRateCode: [
              {
                billing_rate_key: 'STALE-RC',
                rate_code: 'STALE-RC',
                rate_description_sample: null,
                row_count: 750,
                total_transaction_quantity: 0,
                total_extended_cost: 0,
                distinct_invoice_numbers: [],
                distinct_materials: [],
                distinct_service_items: [],
              },
            ],
          },
        },
      },
      extractionHistory: [],
      factOverrides: [],
      factAnchors: [],
      factReviews: [],
      transactionDatasets: [
        {
          id: 'dataset-1',
          summary_json: {
            row_count: 2,
            total_tickets: 2,
            total_cyd: 64,
            distinct_invoice_count: 2,
            total_invoiced_amount: 2500,
            uninvoiced_line_count: 0,
            eligible_count: 2,
            ineligible_count: 0,
            unknown_eligibility_count: 0,
            grouped_by_rate_code: [
              {
                rate_code: 'RC-01',
                billing_rate_key: 'RC01',
                row_count: 2,
                total_transaction_quantity: 20,
                total_extended_cost: 2500,
                record_ids: ['row-1', 'row-2'],
              },
            ],
          },
        },
      ],
      transactionRows: [
        {
          id: 'row-1',
          record_json: {
            id: 'row-1',
            invoice_number: 'INV-100',
            transaction_number: 'TX-1001',
            rate_code: 'RC-01',
            transaction_quantity: 10,
            extended_cost: 1000,
            source_sheet_name: 'ticket_query',
            source_row_number: 3,
          },
          raw_row_json: {
            'Invoice #': 'INV-100',
            'Transaction #': 'TX-1001',
          },
        },
        {
          id: 'row-2',
          record_json: {
            id: 'row-2',
            invoice_number: 'INV-101',
            transaction_number: 'TX-1002',
            rate_code: 'RC-01',
            transaction_quantity: 10,
            extended_cost: 1500,
            source_sheet_name: 'ticket_query',
            source_row_number: 4,
          },
          raw_row_json: {
            'Invoice #': 'INV-101',
            'Transaction #': 'TX-1002',
          },
        },
      ],
      reviewedDecisionIds: [],
    });

    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.spreadsheetReviewDataset?.records.length, 2);
    assert.equal(model.spreadsheetReviewDataset?.summary?.row_count, 2);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalTickets, 2);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalCyd, 64);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalInvoices, 2);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalInvoicedAmount, 2500);
    assert.equal(model.spreadsheetReviewDataset?.rollups?.totalTickets, 2);
    assert.equal(model.spreadsheetReviewDataset?.rollups?.total_tickets, 2);
    assert.equal(model.spreadsheetReviewDataset?.groupedByRateCode[0]?.rate_code, 'RC-01');
    assert.equal(model.spreadsheetReviewDataset?.rollups?.groupedByRateCode?.[0]?.rate_code, 'RC-01');
  });

  it('does not derive final spreadsheet readiness from legacy extraction when normalized rows exist', () => {
    const model = buildDocumentIntelligenceViewModel({
      documentId: 'spreadsheet-readiness-normalized-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      projectName: 'Storm Debris Cleanup',
      preferredExtraction: null,
      relatedDocs: [],
      normalizedDecisions: [],
      extractionGaps: [],
      auditNotes: [],
      nodeTraces: [],
      executionTrace: {
        facts: {
          source_type: 'transaction_data',
          row_count: 1,
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-04-18T12:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          sourceType: 'transaction_data',
          records: [
            {
              id: 'stale-row-1',
              invoice_number: 'STALE-INV',
              transaction_number: 'STALE-TX',
            },
          ],
          invoiceReadinessSummary: {
            status: 'ready',
            total_tickets: 999,
            invoiced_ticket_count: 999,
            distinct_invoice_count: 999,
            total_invoiced_amount: 999,
            uninvoiced_line_count: 0,
            rows_with_missing_rate_code: 0,
            rows_with_missing_quantity: 0,
            rows_with_missing_extended_cost: 0,
            rows_with_zero_cost: 0,
            rows_with_extreme_unit_rate: 0,
            outlier_row_count: 0,
            blocking_reasons: [],
            record_ids: ['stale-row-1'],
            evidence_refs: [],
          },
        },
      },
      extractionHistory: [],
      factOverrides: [],
      factAnchors: [],
      factReviews: [],
      transactionDatasets: [
        {
          id: 'dataset-without-summary',
          summary_json: null,
        },
      ],
      transactionRows: [
        {
          id: 'row-1',
          record_json: {
            id: 'row-1',
            invoice_number: 'INV-100',
            transaction_number: 'TX-1001',
            transaction_quantity: 10,
            extended_cost: 1000,
            source_sheet_name: 'ticket_query',
            source_row_number: 3,
          },
          raw_row_json: {
            'Invoice #': 'INV-100',
            'Transaction #': 'TX-1001',
          },
        },
      ],
      reviewedDecisionIds: [],
    });

    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.spreadsheetReviewDataset?.records[0]?.invoice_number, 'INV-100');
    assert.notEqual(model.spreadsheetReviewDataset?.invoiceReadinessSummary?.status, 'ready');
    assert.equal(model.spreadsheetReviewDataset?.invoiceReadinessSummary?.total_tickets, 0);
  });

  it('uses canonical grouped eligibility counts when persisted group record ids no longer resolve', () => {
    const model = buildDocumentIntelligenceViewModel({
      documentId: 'spreadsheet-canonical-group-counts-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      projectName: 'Storm Debris Cleanup',
      preferredExtraction: null,
      relatedDocs: [],
      normalizedDecisions: [],
      extractionGaps: [],
      auditNotes: [],
      nodeTraces: [],
      executionTrace: null,
      extractionHistory: [],
      factOverrides: [],
      factAnchors: [],
      factReviews: [],
      transactionDatasets: [
        {
          id: 'dataset-1',
          summary_json: {
            row_count: 2,
            total_tickets: 2,
            total_cyd: 18,
            total_extended_cost: 1800,
            distinct_invoice_count: 2,
            total_invoiced_amount: 1800,
            uninvoiced_line_count: 0,
            eligible_count: 1,
            ineligible_count: 1,
            grouped_by_material: [
              {
                material: 'Vegetative',
                row_count: 2,
                total_transaction_quantity: 18,
                total_cyd: 18,
                total_extended_cost: 1800,
                invoiced_ticket_count: 2,
                uninvoiced_line_count: 0,
                eligible_count: 1,
                ineligible_count: 1,
                distinct_invoice_numbers: ['INV-100', 'INV-101'],
                distinct_rate_codes: ['RC-01'],
                record_ids: ['stale-row-1', 'stale-row-2'],
                evidence_refs: [],
                disposal_sites: ['North Yard'],
                site_types: ['Reduction Site'],
              },
            ],
            grouped_by_site_type: [
              {
                site_type: 'Reduction Site',
                row_count: 2,
                total_transaction_quantity: 18,
                total_cyd: 18,
                total_extended_cost: 1800,
                invoiced_ticket_count: 2,
                uninvoiced_line_count: 0,
                eligible_count: 1,
                ineligible_count: 1,
                distinct_invoice_numbers: ['INV-100', 'INV-101'],
                distinct_rate_codes: ['RC-01'],
                record_ids: ['stale-row-1', 'stale-row-2'],
                evidence_refs: [],
                disposal_sites: ['North Yard'],
                materials: ['Vegetative'],
              },
            ],
            grouped_by_disposal_site: [],
            grouped_by_service_item: [],
            grouped_by_rate_code: [],
            outlier_rows: [],
          },
        },
      ],
      transactionRows: [
        {
          id: 'db-row-1',
          record_json: {
            id: 'row-1',
            invoice_number: 'INV-100',
            transaction_number: 'T-5001',
            eligibility: 'Eligible',
            transaction_quantity: 10,
            extended_cost: 1000,
            cyd: 10,
            source_sheet_name: 'ticket_query',
            source_row_number: 3,
          },
          raw_row_json: {
            id: 'db-row-1',
            'Transaction #': 'T-5001',
          },
        },
        {
          id: 'db-row-2',
          record_json: {
            id: 'row-2',
            invoice_number: 'INV-101',
            transaction_number: 'T-5002',
            eligibility: 'Ineligible',
            transaction_quantity: 8,
            extended_cost: 800,
            cyd: 8,
            source_sheet_name: 'ticket_query',
            source_row_number: 4,
          },
          raw_row_json: {
            id: 'db-row-2',
            'Transaction #': 'T-5002',
          },
        },
      ],
      reviewedDecisionIds: [],
    });

    assert.deepEqual(
      model.spreadsheetReviewDataset?.materialRows.map((row) => ({
        label: row.label,
        ticketCount: row.ticketCount,
        eligibleTickets: row.eligibleTickets,
        ineligibleTickets: row.ineligibleTickets,
      })),
      [
        {
          label: 'Vegetative',
          ticketCount: 2,
          eligibleTickets: 1,
          ineligibleTickets: 1,
        },
      ],
    );
    assert.deepEqual(
      model.spreadsheetReviewDataset?.siteTypeRows.map((row) => ({
        label: row.label,
        ticketCount: row.ticketCount,
        eligibleTickets: row.eligibleTickets,
        ineligibleTickets: row.ineligibleTickets,
      })),
      [
        {
          label: 'Reduction Site',
          ticketCount: 2,
          eligibleTickets: 1,
          ineligibleTickets: 1,
        },
      ],
    );
  });

  it('uses canonical project facts for spreadsheet readiness, blockers, and billed totals', () => {
    const model = buildModel({
      documentId: 'spreadsheet-project-facts-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {},
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                records: [],
                summary: {
                  row_count: 0,
                },
              },
            },
          },
        },
      },
      projectValidationStatus: 'BLOCKED',
      projectValidationSummary: {
        validator_status: 'BLOCKED',
        blocked_reasons: ['Missing governing contract'],
        total_billed: 5400,
        exposure: {
          total_billed_amount: 5400,
          total_contract_supported_amount: 0,
          total_transaction_supported_amount: 0,
          total_fully_reconciled_amount: 0,
          total_unreconciled_amount: 5400,
          total_at_risk_amount: 5400,
          total_requires_verification_amount: 5400,
          support_gap_tolerance_amount: 0,
          at_risk_tolerance_amount: 0,
          moderate_severity: 'warning',
          invoices: [
            {
              invoice_number: 'INV-100',
              billed_amount: 2500,
              billed_amount_source: 'invoice_total',
              contract_supported_amount: 0,
              transaction_supported_amount: 0,
              fully_reconciled_amount: 0,
              supported_amount: 0,
              unreconciled_amount: 2500,
              at_risk_amount: 2500,
              requires_verification_amount: 2500,
              reconciliation_status: 'MISMATCH',
            },
            {
              invoice_number: 'INV-101',
              billed_amount: 2900,
              billed_amount_source: 'invoice_total',
              contract_supported_amount: 0,
              transaction_supported_amount: 0,
              fully_reconciled_amount: 0,
              supported_amount: 0,
              unreconciled_amount: 2900,
              at_risk_amount: 2900,
              requires_verification_amount: 2900,
              reconciliation_status: 'PARTIAL',
            },
          ],
        },
      },
      transactionDatasets: [
        {
          id: 'dataset-project-facts',
          summary_json: {
            total_tickets: 3,
            total_cyd: 12,
            total_invoiced_amount: 1000,
            distinct_invoice_count: 1,
            invoice_readiness_summary: {
              status: 'ready',
              total_tickets: 3,
              invoiced_ticket_count: 1,
              distinct_invoice_count: 1,
              total_invoiced_amount: 1000,
              uninvoiced_line_count: 2,
              rows_with_missing_rate_code: 0,
              rows_with_missing_quantity: 0,
              rows_with_missing_extended_cost: 0,
              rows_with_zero_cost: 0,
              rows_with_extreme_unit_rate: 0,
              outlier_row_count: 0,
              blocking_reasons: [],
              record_ids: [],
              evidence_refs: [],
            },
          },
        },
      ],
    });

    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.spreadsheetReviewDataset?.invoiceReadinessSummary?.status, 'needs_review');
    assert.deepEqual(
      model.spreadsheetReviewDataset?.invoiceReadinessSummary?.blocking_reasons,
      ['Missing governing contract'],
    );
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalInvoicedAmount, 5400);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalInvoices, 2);
  });

  it('folds legacy unknown eligibility counts into ineligible and strips the third bucket from the spreadsheet review dataset', () => {
    const model = buildDocumentIntelligenceViewModel({
      documentId: 'spreadsheet-legacy-eligibility-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      projectName: 'Storm Debris Cleanup',
      preferredExtraction: null,
      relatedDocs: [],
      normalizedDecisions: [],
      extractionGaps: [],
      auditNotes: [],
      nodeTraces: [],
      executionTrace: null,
      extractionHistory: [],
      factOverrides: [],
      factAnchors: [],
      factReviews: [],
      transactionDatasets: [
        {
          id: 'dataset-legacy-1',
          summary_json: {
            row_count: 2,
            total_tickets: 2,
            total_cyd: 0,
            distinct_invoice_count: 1,
            total_invoiced_amount: 100,
            uninvoiced_line_count: 1,
            eligible_count: 1,
            ineligible_count: 1,
            unknown_eligibility_count: 2,
            outlier_rows: [
              {
                record_id: 'row-2',
                transaction_number: 'TX-1002',
                invoice_number: null,
                billing_rate_key: null,
                description_match_key: null,
                source_sheet_name: 'ticket_query',
                source_row_number: 4,
                severity: 'warning',
                reasons: ['eligibility status unresolved'],
                metrics: {
                  transaction_quantity: 1,
                  transaction_rate: 100,
                  extended_cost: 100,
                  mileage: null,
                  cyd: null,
                  net_tonnage: null,
                },
                evidence_refs: [],
              },
            ],
            project_operations_overview: {
              project_name: 'Storm Debris Cleanup',
              total_tickets: 2,
              total_transaction_quantity: 2,
              total_cyd: 0,
              total_invoiced_amount: 100,
              distinct_invoice_count: 1,
              invoiced_ticket_count: 1,
              uninvoiced_line_count: 1,
              eligible_count: 1,
              ineligible_count: 1,
              unknown_eligibility_count: 2,
              distinct_service_item_count: 1,
              distinct_material_count: 1,
              distinct_site_type_count: 0,
              distinct_disposal_site_count: 0,
              reviewed_sheet_names: ['ticket_query'],
              record_ids: ['row-1', 'row-2'],
              evidence_refs: [],
            },
            grouped_by_rate_code: [],
            grouped_by_service_item: [],
            grouped_by_material: [],
            grouped_by_site_type: [],
            grouped_by_disposal_site: [],
          },
        },
      ],
      transactionRows: [
        {
          id: 'row-1',
          record_json: {
            id: 'row-1',
            transaction_number: 'TX-1001',
            invoice_number: 'INV-100',
            eligibility: 'Eligible',
            source_sheet_name: 'ticket_query',
            source_row_number: 3,
          },
          raw_row_json: {
            'Transaction #': 'TX-1001',
            Eligibility: 'Eligible',
          },
        },
        {
          id: 'row-2',
          record_json: {
            id: 'row-2',
            transaction_number: 'TX-1002',
            invoice_number: null,
            eligibility: null,
            source_sheet_name: 'ticket_query',
            source_row_number: 4,
          },
          raw_row_json: {
            'Transaction #': 'TX-1002',
            Eligibility: '',
          },
        },
      ],
      reviewedDecisionIds: [],
    });

    assert.equal(model.spreadsheetReviewDataset?.kpis.eligible, 1);
    assert.equal(model.spreadsheetReviewDataset?.kpis.ineligible, 3);
    assert.equal(
      'unknown_eligibility_count'
        in ((model.spreadsheetReviewDataset?.summary ?? {}) as Record<string, unknown>),
      false,
    );
    assert.equal(model.spreadsheetReviewDataset?.outlierRows.length, 0);
  });

  it('prefers fresh preferred extraction transaction data over stale execution trace for spreadsheet review', () => {
    const model = buildModel({
      documentId: 'spreadsheet-fresh-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {},
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                source_type: 'transaction_data',
                row_count: 2,
                row_limit_reached: false,
                sheet_names: ['ticket_query'],
                header_map: {
                  transaction_number: [
                    {
                      canonical_field: 'transaction_number',
                      sheet_key: 'ticket_query',
                      sheet_name: 'ticket_query',
                      column_name: 'Ticket ID',
                      column_index: 0,
                      header_row_number: 2,
                    },
                  ],
                  invoice_number: [
                    {
                      canonical_field: 'invoice_number',
                      sheet_key: 'ticket_query',
                      sheet_name: 'ticket_query',
                      column_name: 'Invoice #',
                      column_index: 1,
                      header_row_number: 2,
                    },
                  ],
                  rate_code: [
                    {
                      canonical_field: 'rate_code',
                      sheet_key: 'ticket_query',
                      sheet_name: 'ticket_query',
                      column_name: 'Rate Code',
                      column_index: 2,
                      header_row_number: 2,
                    },
                  ],
                },
                records: [
                  {
                    id: 'transaction:ticket_query:3',
                    transaction_number: 'FRESH-1001',
                    invoice_number: 'INV-FRESH-1',
                    rate_code: 'RC-99',
                    transaction_quantity: 10,
                    extended_cost: 1000,
                    source_sheet_name: 'ticket_query',
                    source_row_number: 3,
                    raw_row: {
                      'Ticket ID': 'FRESH-1001',
                      'Invoice #': 'INV-FRESH-1',
                      'Rate Code': 'RC-99',
                    },
                    evidence_ref: 'sheet:ticket_query:row:3',
                  },
                  {
                    id: 'transaction:ticket_query:4',
                    transaction_number: 'FRESH-1002',
                    invoice_number: 'INV-FRESH-2',
                    rate_code: 'RC-99',
                    transaction_quantity: 10,
                    extended_cost: 1500,
                    source_sheet_name: 'ticket_query',
                    source_row_number: 4,
                    raw_row: {
                      'Ticket ID': 'FRESH-1002',
                      'Invoice #': 'INV-FRESH-2',
                      'Rate Code': 'RC-99',
                    },
                    evidence_ref: 'sheet:ticket_query:row:4',
                  },
                ],
                summary: {
                  row_count: 2,
                  total_tickets: 2,
                  total_cyd: 64,
                  distinct_invoice_count: 2,
                  total_invoiced_amount: 2500,
                  uninvoiced_line_count: 0,
                  eligible_count: 2,
                  ineligible_count: 0,
                  unknown_eligibility_count: 0,
                },
                rollups: {
                  total_tickets: 2,
                  total_cyd: 64,
                  distinct_invoice_count: 2,
                  total_invoiced_amount: 2500,
                  uninvoiced_line_count: 0,
                  grouped_by_rate_code: [
                    {
                      billing_rate_key: 'RC99',
                      rate_code: 'RC99',
                      rate_description_sample: null,
                      row_count: 2,
                      total_transaction_quantity: 20,
                      total_extended_cost: 2500,
                      distinct_invoice_numbers: ['INV-FRESH-1', 'INV-FRESH-2'],
                      distinct_materials: ['Vegetative'],
                      distinct_service_items: ['Hauling'],
                    },
                  ],
                },
              },
            },
          },
        },
      },
      executionTrace: {
        facts: {
          source_type: 'transaction_data',
          row_count: 750,
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-04-18T12:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          sourceType: 'transaction_data',
          rowCount: 750,
          records: [
            {
              id: 'stale-row-1',
              transaction_number: 'STALE-1001',
              invoice_number: 'INV-STALE',
              rate_code: 'STALE-RC',
            },
          ],
          summary: {
            row_count: 750,
            total_tickets: 750,
            total_cyd: 0,
            distinct_invoice_count: 0,
            total_invoiced_amount: 0,
            uninvoiced_line_count: 750,
            eligible_count: 0,
            ineligible_count: 0,
            unknown_eligibility_count: 750,
          },
          rollups: {
            totalTickets: 750,
            totalCyd: 0,
            distinctInvoiceCount: 0,
            totalInvoicedAmount: 0,
            uninvoicedLineCount: 750,
            groupedByRateCode: [
              {
                billing_rate_key: 'STALE-RC',
                rate_code: 'STALE-RC',
                rate_description_sample: null,
                row_count: 750,
                total_transaction_quantity: 0,
                total_extended_cost: 0,
                distinct_invoice_numbers: [],
                distinct_materials: [],
                distinct_service_items: [],
              },
            ],
          },
        },
      },
    });

    assert.ok(model.transactionDataExtraction);
    assert.equal(model.transactionDataExtraction?.rowCount, 2);
    assert.equal(model.transactionDataExtraction?.records?.length, 2);
    assert.equal(model.transactionDataExtraction?.records?.[0]?.invoice_number, 'INV-FRESH-1');
    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.spreadsheetReviewDataset?.records.length, 2);
    assert.equal(model.spreadsheetReviewDataset?.records[0]?.invoice_number, 'INV-FRESH-1');
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalTickets, 2);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalCyd, 64);
    assert.equal(model.spreadsheetReviewDataset?.groupedByRateCode[0]?.rate_code, 'RC99');
  });

  it('keeps spreadsheet review overview inputs explicit for unique ticket count, transaction count, invoice count, and total cost', () => {
    const model = buildModel({
      documentId: 'spreadsheet-overview-truth-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {},
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                source_type: 'transaction_data',
                row_count: 5063,
                row_limit_reached: false,
                sheet_names: ['ticket_query'],
                records: [],
                summary: {
                  row_count: 5063,
                  total_tickets: 2388,
                  total_cyd: 0,
                  total_extended_cost: 815559.35,
                  distinct_invoice_count: 2,
                  total_invoiced_amount: 815559.35,
                  uninvoiced_line_count: 5061,
                  eligible_count: 0,
                  ineligible_count: 0,
                  unknown_eligibility_count: 0,
                  grouped_by_material: [],
                  grouped_by_disposal_site: [],
                  grouped_by_site_type: [],
                  grouped_by_service_item: [],
                  invoice_readiness_summary: {
                    status: 'partial',
                    total_tickets: 2388,
                    invoiced_ticket_count: 2,
                    distinct_invoice_count: 2,
                    total_invoiced_amount: 815559.35,
                    uninvoiced_line_count: 5061,
                    rows_with_missing_rate_code: 0,
                    rows_with_missing_quantity: 0,
                    rows_with_missing_extended_cost: 0,
                    rows_with_zero_cost: 0,
                    rows_with_extreme_unit_rate: 0,
                    outlier_row_count: 0,
                    blocking_reasons: ['uninvoiced rows remain in the dataset'],
                    record_ids: [],
                    evidence_refs: [],
                  },
                },
                rollups: {
                  total_tickets: 2388,
                  total_extended_cost: 815559.35,
                  total_invoiced_amount: 815559.35,
                  distinct_invoice_count: 2,
                  uninvoiced_line_count: 5061,
                  eligible_count: 0,
                  ineligible_count: 0,
                  unknown_eligibility_count: 0,
                },
              },
            },
          },
        },
      },
    });

    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.spreadsheetReviewDataset?.summary?.row_count, 5063);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalTickets, 2388);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalInvoices, 2);
    assert.equal(model.spreadsheetReviewDataset?.totalExtendedCost, 815559.35);
  });

  it('derives client-ready spreadsheet review rows with service-item diameter units, material flow, and grouped risk issues', () => {
    const serviceItemGroups = [
      {
        service_item: 'Debris Hauling',
        row_count: 2,
        total_transaction_quantity: 25,
        total_cyd: 45,
        total_extended_cost: 2500,
        invoiced_ticket_count: 2,
        uninvoiced_line_count: 0,
        distinct_invoice_numbers: ['INV-100', 'INV-101'],
        distinct_rate_codes: ['HAUL'],
        record_ids: ['transaction:ticket_query:3', 'transaction:ticket_query:4'],
        evidence_refs: [],
      },
      {
        service_item: 'Load Monitoring',
        row_count: 1,
        total_transaction_quantity: 0,
        total_cyd: 0,
        total_extended_cost: 300,
        invoiced_ticket_count: 0,
        uninvoiced_line_count: 1,
        distinct_invoice_numbers: [],
        distinct_rate_codes: ['MON'],
        record_ids: ['transaction:ticket_query:5'],
        evidence_refs: [],
      },
    ];
    const materialGroups = [
      {
        material: 'Vegetative',
        row_count: 1,
        total_transaction_quantity: 20,
        total_cyd: 20,
        total_extended_cost: 1000,
        invoiced_ticket_count: 1,
        uninvoiced_line_count: 0,
        distinct_invoice_numbers: ['INV-100'],
        distinct_rate_codes: ['HAUL'],
        record_ids: ['transaction:ticket_query:3'],
        evidence_refs: [],
        disposal_sites: ['Alpha Landfill'],
        site_types: ['Landfill'],
      },
      {
        material: 'C&D',
        row_count: 1,
        total_transaction_quantity: 5,
        total_cyd: 25,
        total_extended_cost: 1500,
        invoiced_ticket_count: 1,
        uninvoiced_line_count: 0,
        distinct_invoice_numbers: ['INV-101'],
        distinct_rate_codes: [],
        record_ids: ['transaction:ticket_query:4'],
        evidence_refs: [],
        disposal_sites: ['Bravo DMS'],
        site_types: ['DMS'],
      },
    ];
    const disposalSiteGroups = [
      {
        disposal_site: 'Alpha Landfill',
        row_count: 2,
        total_transaction_quantity: 20,
        total_cyd: 20,
        total_extended_cost: 1300,
        invoiced_ticket_count: 1,
        uninvoiced_line_count: 1,
        distinct_invoice_numbers: ['INV-100'],
        distinct_rate_codes: ['HAUL', 'MON'],
        record_ids: ['transaction:ticket_query:3', 'transaction:ticket_query:5'],
        evidence_refs: [],
        site_types: ['Landfill'],
        materials: ['Vegetative'],
      },
      {
        disposal_site: 'Bravo DMS',
        row_count: 1,
        total_transaction_quantity: 5,
        total_cyd: 25,
        total_extended_cost: 1500,
        invoiced_ticket_count: 1,
        uninvoiced_line_count: 0,
        distinct_invoice_numbers: ['INV-101'],
        distinct_rate_codes: [],
        record_ids: ['transaction:ticket_query:4'],
        evidence_refs: [],
        site_types: ['DMS'],
        materials: ['C&D'],
      },
    ];
    const siteTypeGroups = [
      {
        site_type: 'Landfill',
        row_count: 2,
        total_transaction_quantity: 20,
        total_cyd: 20,
        total_extended_cost: 1300,
        invoiced_ticket_count: 1,
        uninvoiced_line_count: 1,
        distinct_invoice_numbers: ['INV-100'],
        distinct_rate_codes: ['HAUL', 'MON'],
        record_ids: ['transaction:ticket_query:3', 'transaction:ticket_query:5'],
        evidence_refs: [],
        disposal_sites: ['Alpha Landfill'],
        materials: ['Vegetative'],
      },
      {
        site_type: 'DMS',
        row_count: 1,
        total_transaction_quantity: 5,
        total_cyd: 25,
        total_extended_cost: 1500,
        invoiced_ticket_count: 1,
        uninvoiced_line_count: 0,
        distinct_invoice_numbers: ['INV-101'],
        distinct_rate_codes: [],
        record_ids: ['transaction:ticket_query:4'],
        evidence_refs: [],
        disposal_sites: ['Bravo DMS'],
        materials: ['C&D'],
      },
    ];

    const model = buildModel({
      documentId: 'spreadsheet-client-review-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {},
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                source_type: 'transaction_data',
                row_count: 3,
                row_limit_reached: false,
                sheet_names: ['ticket_query'],
                records: [
                  {
                    id: 'transaction:ticket_query:3',
                    transaction_number: 'T-1001',
                    invoice_number: 'INV-100',
                    rate_code: 'HAUL',
                    service_item: 'Debris Hauling',
                    material: 'Vegetative',
                    transaction_quantity: 20,
                    extended_cost: 1000,
                    cyd: 20,
                    diameter: 20,
                    eligibility: 'Eligible',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 3,
                    raw_row: {
                      'Ticket Type': 'Mobile Unit',
                      Diameter: '20',
                    },
                  },
                  {
                    id: 'transaction:ticket_query:4',
                    transaction_number: 'T-1002',
                    invoice_number: 'INV-101',
                    rate_code: null,
                    service_item: 'Debris Hauling',
                    material: 'C&D',
                    transaction_quantity: 5,
                    transaction_rate: 200,
                    extended_cost: 1500,
                    cyd: 25,
                    diameter: 5,
                    eligibility: 'Ineligible',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 4,
                    raw_row: {
                      'Ticket Type': 'Mobile Unit',
                      Diameter: 5,
                    },
                  },
                  {
                    id: 'transaction:ticket_query:5',
                    transaction_number: 'T-1003',
                    invoice_number: null,
                    rate_code: 'MON',
                    service_item: 'Load Monitoring',
                    material: null,
                    transaction_quantity: null,
                    extended_cost: 300,
                    cyd: null,
                    eligibility: null,
                    source_sheet_name: 'ticket_query',
                    source_row_number: 5,
                    raw_row: {
                      'Ticket Type': 'Mobile Unit',
                    },
                  },
                ],
                summary: {
                  row_count: 3,
                  total_tickets: 3,
                  total_cyd: 45,
                  total_extended_cost: 2800,
                  distinct_invoice_count: 2,
                  total_invoiced_amount: 2500,
                  uninvoiced_line_count: 1,
                  eligible_count: 1,
                  ineligible_count: 2,
                  grouped_by_service_item: serviceItemGroups,
                  grouped_by_material: materialGroups,
                  grouped_by_disposal_site: disposalSiteGroups,
                  grouped_by_site_type: siteTypeGroups,
                  outlier_rows: [
                    {
                      record_id: 'transaction:ticket_query:4',
                      transaction_number: 'T-1002',
                      invoice_number: 'INV-101',
                      billing_rate_key: null,
                      description_match_key: 'debris hauling',
                      source_sheet_name: 'ticket_query',
                      source_row_number: 4,
                      severity: 'critical',
                      reasons: ['missing rate code', 'transaction rate 200 deviates from 10 baseline'],
                      metrics: {
                        transaction_quantity: 5,
                        transaction_rate: 200,
                        extended_cost: 1500,
                        mileage: null,
                        cyd: 25,
                        net_tonnage: null,
                      },
                      evidence_refs: [],
                    },
                    {
                      record_id: 'transaction:ticket_query:5',
                      transaction_number: 'T-1003',
                      invoice_number: null,
                      billing_rate_key: 'MON',
                      description_match_key: 'load monitoring',
                      source_sheet_name: 'ticket_query',
                      source_row_number: 5,
                      severity: 'warning',
                      reasons: ['missing invoice number', 'Load call review'],
                      metrics: {
                        transaction_quantity: null,
                        transaction_rate: null,
                        extended_cost: 300,
                        mileage: null,
                        cyd: null,
                        net_tonnage: null,
                      },
                      evidence_refs: [],
                    },
                  ],
                  invoice_readiness_summary: {
                    status: 'partial',
                    total_tickets: 3,
                    invoiced_ticket_count: 2,
                    distinct_invoice_count: 2,
                    total_invoiced_amount: 2500,
                    uninvoiced_line_count: 1,
                    rows_with_missing_rate_code: 1,
                    rows_with_missing_quantity: 1,
                    rows_with_missing_extended_cost: 0,
                    rows_with_zero_cost: 0,
                    rows_with_extreme_unit_rate: 1,
                    outlier_row_count: 2,
                    blocking_reasons: ['Project contains unresolved invoice linkage.'],
                    record_ids: [],
                    evidence_refs: [],
                  },
                },
                rollups: {
                  total_tickets: 3,
                  total_cyd: 45,
                  total_extended_cost: 2800,
                  total_invoiced_amount: 2500,
                  distinct_invoice_count: 2,
                  uninvoiced_line_count: 1,
                  eligible_count: 1,
                  ineligible_count: 2,
                  grouped_by_rate_code: [
                    {
                      billing_rate_key: 'HAUL',
                      rate_code: 'HAUL',
                      rate_description_sample: 'Debris Hauling',
                      row_count: 1,
                      total_transaction_quantity: 20,
                      total_extended_cost: 1000,
                      distinct_invoice_numbers: ['INV-100'],
                      distinct_materials: ['Vegetative'],
                      distinct_service_items: ['Debris Hauling'],
                    },
                    {
                      billing_rate_key: null,
                      rate_code: null,
                      rate_description_sample: 'Debris Hauling',
                      row_count: 1,
                      total_transaction_quantity: 5,
                      total_extended_cost: 1500,
                      distinct_invoice_numbers: ['INV-101'],
                      distinct_materials: ['C&D'],
                      distinct_service_items: ['Debris Hauling'],
                    },
                    {
                      billing_rate_key: 'MON',
                      rate_code: 'MON',
                      rate_description_sample: 'Load Monitoring',
                      row_count: 1,
                      total_transaction_quantity: 0,
                      total_extended_cost: 300,
                      distinct_invoice_numbers: [],
                      distinct_materials: [],
                      distinct_service_items: ['Load Monitoring'],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });

    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.spreadsheetReviewDataset?.volumeBasis.headerLabel, 'Volume (CYD)');
    assert.deepEqual(
      model.spreadsheetReviewDataset?.disposalSiteRows.map((row) => ({
        label: row.label,
        ticketCount: row.ticketCount,
        eligibleTickets: row.eligibleTickets,
        ineligibleTickets: row.ineligibleTickets,
        volume: row.volume,
        amount: row.amount,
      })),
      [
        {
          label: 'Bravo DMS',
          ticketCount: 1,
          eligibleTickets: 0,
          ineligibleTickets: 1,
          volume: 25,
          amount: 1500,
        },
        {
          label: 'Alpha Landfill',
          ticketCount: 2,
          eligibleTickets: 1,
          ineligibleTickets: 1,
          volume: 20,
          amount: 1300,
        },
      ],
    );
    assert.deepEqual(
      model.spreadsheetReviewDataset?.serviceItemRows.map((row) => ({
        serviceItem: row.serviceItem,
        ticketCount: row.ticketCount,
        eligibleTickets: row.eligibleTickets,
        ineligibleTickets: row.ineligibleTickets,
        diameterUnits: row.diameterUnits,
        amount: row.amount,
      })),
      [
        {
          serviceItem: 'Debris Hauling',
          ticketCount: 2,
          eligibleTickets: 1,
          ineligibleTickets: 1,
          diameterUnits: 25,
          amount: 2500,
        },
        {
          serviceItem: 'Load Monitoring',
          ticketCount: 1,
          eligibleTickets: 0,
          ineligibleTickets: 1,
          diameterUnits: null,
          amount: 300,
        },
      ],
    );
    assert.equal(
      'unknownTickets' in ((model.spreadsheetReviewDataset?.disposalSiteRows[0] ?? {}) as Record<string, unknown>),
      false,
    );
    assert.deepEqual(
      model.spreadsheetReviewDataset?.materialRows.map((row) => ({
        label: row.label,
        volume: row.volume,
        amount: row.amount,
      })),
      [
        {
          label: 'C&D',
          volume: 25,
          amount: 1500,
        },
        {
          label: 'Vegetative',
          volume: 20,
          amount: 1000,
        },
      ],
    );
    assert.equal(model.spreadsheetReviewDataset?.riskSummary?.highRiskIssues, 2);
    assert.equal(model.spreadsheetReviewDataset?.riskSummary?.mediumRiskIssues, 2);
    assert.deepEqual(
      model.spreadsheetReviewDataset?.groupedRiskIssues.map((row) => ({
        issueType: row.issueType,
        affectedTicketPreview: row.affectedTicketPreview,
      })),
      [
        {
          issueType: 'Missing Rate Code',
          affectedTicketPreview: 'T-1002',
        },
        {
          issueType: 'Rate Review',
          affectedTicketPreview: 'T-1002',
        },
        {
          issueType: 'Load Call Review',
          affectedTicketPreview: 'T-1003',
        },
        {
          issueType: 'Missing Invoice #',
          affectedTicketPreview: 'T-1003',
        },
      ],
    );
  });

  it('prefers business ticket numbers over internal record ids in grouped risk previews', () => {
    const model = buildModel({
      documentId: 'spreadsheet-risk-ticket-number-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {},
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                source_type: 'transaction_data',
                row_count: 1,
                row_limit_reached: false,
                sheet_names: ['ticket_query'],
                records: [
                  {
                    id: 'transaction:ticket_query:3',
                    transaction_number: 'T-9001',
                    invoice_number: 'INV-900',
                    rate_code: null,
                    extended_cost: 900,
                    cyd: 9,
                    source_sheet_name: 'ticket_query',
                    source_row_number: 3,
                    raw_row: {},
                  },
                ],
                summary: {
                  row_count: 1,
                  total_tickets: 1,
                  total_cyd: 9,
                  total_extended_cost: 900,
                  distinct_invoice_count: 1,
                  total_invoiced_amount: 900,
                  uninvoiced_line_count: 0,
                  eligible_count: 0,
                  ineligible_count: 1,
                  grouped_by_material: [],
                  grouped_by_disposal_site: [],
                  grouped_by_site_type: [],
                  grouped_by_service_item: [],
                  outlier_rows: [
                    {
                      record_id: 'transaction:ticket_query:3',
                      transaction_number: 'transaction:ticket_query:3',
                      invoice_number: 'INV-900',
                      billing_rate_key: null,
                      description_match_key: null,
                      source_sheet_name: 'ticket_query',
                      source_row_number: 3,
                      severity: 'warning',
                      reasons: ['missing rate code'],
                      metrics: {
                        transaction_quantity: 9,
                        transaction_rate: null,
                        extended_cost: 900,
                        mileage: null,
                        cyd: 9,
                        net_tonnage: null,
                      },
                      evidence_refs: [],
                    },
                  ],
                  invoice_readiness_summary: {
                    status: 'needs_review',
                    total_tickets: 1,
                    invoiced_ticket_count: 1,
                    distinct_invoice_count: 1,
                    total_invoiced_amount: 900,
                    uninvoiced_line_count: 0,
                    rows_with_missing_rate_code: 1,
                    rows_with_missing_quantity: 0,
                    rows_with_missing_extended_cost: 0,
                    rows_with_zero_cost: 0,
                    rows_with_extreme_unit_rate: 0,
                    outlier_row_count: 1,
                    blocking_reasons: [],
                    record_ids: [],
                    evidence_refs: [],
                  },
                },
                rollups: {
                  total_tickets: 1,
                  total_cyd: 9,
                  total_extended_cost: 900,
                  total_invoiced_amount: 900,
                  distinct_invoice_count: 1,
                  eligible_count: 0,
                  ineligible_count: 1,
                },
              },
            },
          },
        },
      },
    });

    assert.equal(
      model.spreadsheetReviewDataset?.groupedRiskIssues[0]?.affectedTicketPreview,
      'T-9001',
    );
  });

  it('rolls up service item diameter units from unique-ticket Diameter values without double-counting duplicate rows', () => {
    const model = buildModel({
      documentId: 'spreadsheet-service-item-diameters-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {},
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                source_type: 'transaction_data',
                row_count: 4,
                row_limit_reached: false,
                sheet_names: ['ticket_query'],
                records: [
                  {
                    id: 'transaction:ticket_query:3',
                    transaction_number: 'T-3001',
                    invoice_number: 'INV-300',
                    service_item: 'Mobile Grinding',
                    transaction_quantity: 1,
                    extended_cost: 900,
                    cyd: null,
                    diameter: 12.5,
                    eligibility: 'Eligible',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 3,
                    raw_row: {
                      Diameter: '12.5',
                    },
                  },
                  {
                    id: 'transaction:ticket_query:4',
                    transaction_number: 'T-3001',
                    invoice_number: 'INV-300',
                    service_item: 'Mobile Grinding',
                    transaction_quantity: 1,
                    extended_cost: 600,
                    cyd: null,
                    diameter: 12.5,
                    eligibility: 'In Scope',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 4,
                    raw_row: {
                      Diameter: 12.5,
                    },
                  },
                  {
                    id: 'transaction:ticket_query:5',
                    transaction_number: 'T-3002',
                    invoice_number: 'INV-301',
                    service_item: 'Mobile Grinding',
                    transaction_quantity: 1,
                    extended_cost: 400,
                    cyd: null,
                    diameter: 7.5,
                    eligibility: 'Eligible',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 5,
                    raw_row: {
                      Diameter: 7.5,
                    },
                  },
                  {
                    id: 'transaction:ticket_query:6',
                    transaction_number: 'T-3002',
                    invoice_number: 'INV-301',
                    service_item: 'Mobile Grinding',
                    transaction_quantity: 1,
                    extended_cost: 200,
                    cyd: null,
                    diameter: null,
                    eligibility: 'Eligible',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 6,
                    raw_row: {
                      Diameter: '',
                    },
                  },
                ],
                summary: {
                  row_count: 4,
                  total_tickets: 2,
                  total_cyd: 0,
                  total_extended_cost: 2100,
                  distinct_invoice_count: 2,
                  total_invoiced_amount: 2100,
                  uninvoiced_line_count: 0,
                  eligible_count: 4,
                  ineligible_count: 0,
                  unknown_eligibility_count: 0,
                  grouped_by_service_item: [
                    {
                      service_item: 'Mobile Grinding',
                      row_count: 4,
                      total_transaction_quantity: 4,
                      total_cyd: 0,
                      total_extended_cost: 2100,
                      invoiced_ticket_count: 2,
                      uninvoiced_line_count: 0,
                      distinct_invoice_numbers: ['INV-300', 'INV-301'],
                      distinct_rate_codes: [],
                      record_ids: [
                        'transaction:ticket_query:3',
                        'transaction:ticket_query:4',
                        'transaction:ticket_query:5',
                        'transaction:ticket_query:6',
                      ],
                      evidence_refs: [],
                    },
                  ],
                  grouped_by_material: [],
                  grouped_by_disposal_site: [],
                  grouped_by_site_type: [],
                },
                rollups: {
                  total_tickets: 2,
                  total_cyd: 0,
                  total_extended_cost: 2100,
                  total_invoiced_amount: 2100,
                  distinct_invoice_count: 2,
                },
              },
            },
          },
        },
      },
    });

    assert.deepEqual(
      model.spreadsheetReviewDataset?.serviceItemRows.map((row) => ({
        serviceItem: row.serviceItem,
        ticketCount: row.ticketCount,
        eligibleTickets: row.eligibleTickets,
        ineligibleTickets: row.ineligibleTickets,
        diameterUnits: row.diameterUnits,
        amount: row.amount,
      })),
      [
        {
          serviceItem: 'Mobile Grinding',
          ticketCount: 2,
          eligibleTickets: 2,
          ineligibleTickets: 0,
          diameterUnits: 20,
          amount: 2100,
        },
      ],
    );
  });

  it('uses the first non-null Diameter value in source order when duplicate ticket rows disagree', () => {
    const model = buildModel({
      documentId: 'spreadsheet-service-item-diameter-conflict-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {},
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                source_type: 'transaction_data',
                row_count: 2,
                row_limit_reached: false,
                sheet_names: ['ticket_query'],
                records: [
                  {
                    id: 'transaction:ticket_query:3',
                    transaction_number: 'T-4001',
                    invoice_number: 'INV-400',
                    service_item: 'Mobile Grinding',
                    transaction_quantity: 1,
                    extended_cost: 500,
                    cyd: null,
                    diameter: 9,
                    eligibility: 'Eligible',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 3,
                    raw_row: {
                      Diameter: 9,
                    },
                  },
                  {
                    id: 'transaction:ticket_query:4',
                    transaction_number: 'T-4001',
                    invoice_number: 'INV-400',
                    service_item: 'Mobile Grinding',
                    transaction_quantity: 1,
                    extended_cost: 250,
                    cyd: null,
                    diameter: 11,
                    eligibility: 'Eligible',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 4,
                    raw_row: {
                      Diameter: 11,
                    },
                  },
                ],
                summary: {
                  row_count: 2,
                  total_tickets: 1,
                  total_cyd: 0,
                  total_extended_cost: 750,
                  distinct_invoice_count: 1,
                  total_invoiced_amount: 750,
                  uninvoiced_line_count: 0,
                  eligible_count: 2,
                  ineligible_count: 0,
                  unknown_eligibility_count: 0,
                  grouped_by_service_item: [
                    {
                      service_item: 'Mobile Grinding',
                      row_count: 2,
                      total_transaction_quantity: 2,
                      total_cyd: 0,
                      total_extended_cost: 750,
                      invoiced_ticket_count: 1,
                      uninvoiced_line_count: 0,
                      distinct_invoice_numbers: ['INV-400'],
                      distinct_rate_codes: [],
                      record_ids: ['transaction:ticket_query:3', 'transaction:ticket_query:4'],
                      evidence_refs: [],
                    },
                  ],
                  grouped_by_material: [],
                  grouped_by_disposal_site: [],
                  grouped_by_site_type: [],
                },
                rollups: {
                  total_tickets: 1,
                  total_cyd: 0,
                  total_extended_cost: 750,
                  total_invoiced_amount: 750,
                  distinct_invoice_count: 1,
                },
              },
            },
          },
        },
      },
    });

    assert.equal(model.spreadsheetReviewDataset?.serviceItemRows[0]?.diameterUnits, 9);
  });

  it('uses tons as the project volume basis when CYD is not available', () => {
    const model = buildModel({
      documentId: 'spreadsheet-tons-review-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {},
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                source_type: 'transaction_data',
                row_count: 2,
                row_limit_reached: false,
                sheet_names: ['ticket_query'],
                records: [
                  {
                    id: 'transaction:ticket_query:3',
                    transaction_number: 'T-2001',
                    invoice_number: 'INV-200',
                    service_item: 'Grinding',
                    material: 'Vegetative',
                    transaction_quantity: 11,
                    extended_cost: 1000,
                    cyd: null,
                    net_tonnage: 11,
                    eligibility: 'Eligible',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 3,
                    raw_row: {
                      Unit: 'Tons',
                    },
                  },
                  {
                    id: 'transaction:ticket_query:4',
                    transaction_number: 'T-2002',
                    invoice_number: 'INV-201',
                    service_item: 'Grinding',
                    material: 'Vegetative',
                    transaction_quantity: 9,
                    extended_cost: 800,
                    cyd: null,
                    net_tonnage: 9,
                    eligibility: 'Eligible',
                    source_sheet_name: 'ticket_query',
                    source_row_number: 4,
                    raw_row: {
                      Unit: 'Tons',
                    },
                  },
                ],
                summary: {
                  row_count: 2,
                  total_tickets: 2,
                  total_cyd: 0,
                  total_extended_cost: 1800,
                  distinct_invoice_count: 2,
                  total_invoiced_amount: 1800,
                  uninvoiced_line_count: 0,
                  eligible_count: 2,
                  ineligible_count: 0,
                  unknown_eligibility_count: 0,
                  grouped_by_material: [
                    {
                      material: 'Vegetative',
                      row_count: 2,
                      total_transaction_quantity: 20,
                      total_cyd: 0,
                      total_extended_cost: 1800,
                      invoiced_ticket_count: 2,
                      uninvoiced_line_count: 0,
                      distinct_invoice_numbers: ['INV-200', 'INV-201'],
                      distinct_rate_codes: [],
                      record_ids: ['transaction:ticket_query:3', 'transaction:ticket_query:4'],
                      evidence_refs: [],
                      disposal_sites: ['North Yard'],
                      site_types: ['Reduction Site'],
                    },
                  ],
                  grouped_by_disposal_site: [
                    {
                      disposal_site: 'North Yard',
                      row_count: 2,
                      total_transaction_quantity: 20,
                      total_cyd: 0,
                      total_extended_cost: 1800,
                      invoiced_ticket_count: 2,
                      uninvoiced_line_count: 0,
                      distinct_invoice_numbers: ['INV-200', 'INV-201'],
                      distinct_rate_codes: [],
                      record_ids: ['transaction:ticket_query:3', 'transaction:ticket_query:4'],
                      evidence_refs: [],
                      site_types: ['Reduction Site'],
                      materials: ['Vegetative'],
                    },
                  ],
                  grouped_by_site_type: [
                    {
                      site_type: 'Reduction Site',
                      row_count: 2,
                      total_transaction_quantity: 20,
                      total_cyd: 0,
                      total_extended_cost: 1800,
                      invoiced_ticket_count: 2,
                      uninvoiced_line_count: 0,
                      distinct_invoice_numbers: ['INV-200', 'INV-201'],
                      distinct_rate_codes: [],
                      record_ids: ['transaction:ticket_query:3', 'transaction:ticket_query:4'],
                      evidence_refs: [],
                      disposal_sites: ['North Yard'],
                      materials: ['Vegetative'],
                    },
                  ],
                },
                rollups: {
                  total_tickets: 2,
                  total_cyd: 0,
                  total_extended_cost: 1800,
                  total_invoiced_amount: 1800,
                  distinct_invoice_count: 2,
                },
              },
            },
          },
        },
      },
    });

    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.spreadsheetReviewDataset?.volumeBasis.headerLabel, 'Volume (Tons)');
    assert.equal(model.spreadsheetReviewDataset?.materialRows[0]?.volume, 20);
    assert.equal(model.spreadsheetReviewDataset?.disposalSiteRows[0]?.volume, 20);
    assert.equal(model.spreadsheetReviewDataset?.siteTypeRows[0]?.percentOfTotalVolume, 100);
  });

  it('suppresses zero-value and missing-rate-code rows from cost drivers while keeping real billed rate codes', () => {
    const model = buildModel({
      documentId: 'spreadsheet-cost-driver-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Ticket Query Export',
      preferredExtraction: {
        fields: {},
        extraction: {
          evidence_v1: {},
          content_layers_v1: {
            spreadsheet: {
              evidence: [],
              normalized_transaction_data: {
                source_type: 'transaction_data',
                row_count: 4,
                row_limit_reached: false,
                sheet_names: ['ticket_query'],
                records: [
                  {
                    id: 'transaction:ticket_query:3',
                    transaction_number: 'TX-4001',
                    invoice_number: 'INV-401',
                    rate_code: null,
                    extended_cost: 0,
                    source_sheet_name: 'ticket_query',
                    source_row_number: 3,
                    raw_row: {},
                  },
                  {
                    id: 'transaction:ticket_query:4',
                    transaction_number: 'TX-4002',
                    invoice_number: 'INV-402',
                    rate_code: null,
                    extended_cost: 1500,
                    source_sheet_name: 'ticket_query',
                    source_row_number: 4,
                    raw_row: {},
                  },
                  {
                    id: 'transaction:ticket_query:5',
                    transaction_number: 'TX-4003',
                    invoice_number: 'INV-403',
                    rate_code: 'RC-01',
                    extended_cost: 2500,
                    source_sheet_name: 'ticket_query',
                    source_row_number: 5,
                    raw_row: {},
                  },
                  {
                    id: 'transaction:ticket_query:6',
                    transaction_number: 'TX-4004',
                    invoice_number: 'INV-404',
                    rate_code: 'RC-02',
                    extended_cost: 125,
                    source_sheet_name: 'ticket_query',
                    source_row_number: 6,
                    raw_row: {},
                  },
                ],
                summary: {
                  row_count: 4,
                  total_tickets: 4,
                  total_cyd: 0,
                  total_extended_cost: 4125,
                  distinct_invoice_count: 4,
                  total_invoiced_amount: 4125,
                  uninvoiced_line_count: 0,
                  eligible_count: 0,
                  ineligible_count: 0,
                  unknown_eligibility_count: 4,
                  grouped_by_rate_code: [
                    {
                      billing_rate_key: null,
                      rate_code: null,
                      rate_description_sample: null,
                      row_count: 1,
                      total_transaction_quantity: 0,
                      total_extended_cost: 0,
                      distinct_invoice_numbers: ['INV-401'],
                      distinct_materials: [],
                      distinct_service_items: [],
                    },
                    {
                      billing_rate_key: null,
                      rate_code: null,
                      rate_description_sample: 'Debris Hauling',
                      row_count: 1,
                      total_transaction_quantity: 10,
                      total_extended_cost: 1500,
                      distinct_invoice_numbers: ['INV-402'],
                      distinct_materials: [],
                      distinct_service_items: ['Hauling'],
                    },
                    {
                      billing_rate_key: 'RC01',
                      rate_code: 'RC-01',
                      rate_description_sample: 'Debris Hauling',
                      row_count: 1,
                      total_transaction_quantity: 10,
                      total_extended_cost: 2500,
                      distinct_invoice_numbers: ['INV-403'],
                      distinct_materials: [],
                      distinct_service_items: ['Hauling'],
                    },
                    {
                      billing_rate_key: 'RC02',
                      rate_code: 'RC-02',
                      rate_description_sample: null,
                      row_count: 1,
                      total_transaction_quantity: 1,
                      total_extended_cost: 125,
                      distinct_invoice_numbers: ['INV-404'],
                      distinct_materials: [],
                      distinct_service_items: ['Monitoring'],
                    },
                  ],
                },
                rollups: {
                  total_tickets: 4,
                  total_extended_cost: 4125,
                  total_invoiced_amount: 4125,
                  distinct_invoice_count: 4,
                  grouped_by_rate_code: [
                    {
                      billing_rate_key: null,
                      rate_code: null,
                      rate_description_sample: null,
                      row_count: 1,
                      total_transaction_quantity: 0,
                      total_extended_cost: 0,
                      distinct_invoice_numbers: ['INV-401'],
                      distinct_materials: [],
                      distinct_service_items: [],
                    },
                    {
                      billing_rate_key: null,
                      rate_code: null,
                      rate_description_sample: 'Debris Hauling',
                      row_count: 1,
                      total_transaction_quantity: 10,
                      total_extended_cost: 1500,
                      distinct_invoice_numbers: ['INV-402'],
                      distinct_materials: [],
                      distinct_service_items: ['Hauling'],
                    },
                    {
                      billing_rate_key: 'RC01',
                      rate_code: 'RC-01',
                      rate_description_sample: 'Debris Hauling',
                      row_count: 1,
                      total_transaction_quantity: 10,
                      total_extended_cost: 2500,
                      distinct_invoice_numbers: ['INV-403'],
                      distinct_materials: [],
                      distinct_service_items: ['Hauling'],
                    },
                    {
                      billing_rate_key: 'RC02',
                      rate_code: 'RC-02',
                      rate_description_sample: null,
                      row_count: 1,
                      total_transaction_quantity: 1,
                      total_extended_cost: 125,
                      distinct_invoice_numbers: ['INV-404'],
                      distinct_materials: [],
                      distinct_service_items: ['Monitoring'],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    });

    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.spreadsheetReviewDataset?.groupedByRateCode.length, 4);
    assert.deepEqual(
      model.spreadsheetReviewDataset?.rateCodeRows.map((row) => ({
        rateCode: row.rateCode,
        description: row.description,
        amount: row.amount,
      })),
      [
        {
          rateCode: 'RC-01',
          description: 'Debris Hauling',
          amount: 2500,
        },
        {
          rateCode: 'RC-02',
          description: null,
          amount: 125,
        },
      ],
    );
    assert.ok(model.spreadsheetReviewDataset?.rateCodeRows.every((row) => row.rateCode != null));
  });
});

describe('invoice rate line helpers', () => {
  it('splits embedded alphanumeric rate codes from leading description tokens', () => {
    const parsed = splitEmbeddedInvoiceRateCode(
      '1A- Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
    );
    assert.equal(parsed.rateCode, '1A');
    assert.ok(parsed.remainder.includes('Vegetative Collect'));
  });

  it('splits rate codes when the table uses spaced hyphens', () => {
    const parsed = splitEmbeddedInvoiceRateCode(
      '1B - Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30',
    );
    assert.equal(parsed.rateCode, '1B');
    assert.ok(parsed.remainder.includes('Vegetative'));
  });

  it('keeps descriptions without a delimiter prefix intact', () => {
    const parsed = splitEmbeddedInvoiceRateCode('Vegetative hauling line item');
    assert.equal(parsed.rateCode, null);
    assert.equal(parsed.remainder, 'Vegetative hauling line item');
  });

  it('splits space-delimited leading rate codes (Williamson raw row)', () => {
    const parsed = splitEmbeddedInvoiceRateCode(
      '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894 CYD 6.90',
    );
    assert.equal(parsed.rateCode, '1A');
    assert.ok(parsed.remainder.includes('Vegetative Collect'));
  });

  it('splits colon-separated leading codes', () => {
    const parsed = splitEmbeddedInvoiceRateCode('1A: Vegetative work');
    assert.equal(parsed.rateCode, '1A');
    assert.equal(parsed.remainder, 'Vegetative work');
  });

  it('does not treat plain quantities as embedded rate tokens', () => {
    assert.equal(splitEmbeddedInvoiceRateCode('43894 Vegetative').rateCode, null);
    assert.equal(splitEmbeddedInvoiceRateCode('994 EA work').rateCode, null);
    assert.equal(splitEmbeddedInvoiceRateCode('43,894.00 Vegetative').rateCode, null);
    assert.equal(splitEmbeddedInvoiceRateCode('916 CYD').rateCode, null);
  });

  it('rejects ordinal-looking digit+letter tokens', () => {
    assert.equal(splitEmbeddedInvoiceRateCode('1st Invoice line').rateCode, null);
    assert.equal(isPlausibleEmbeddedInvoiceRateCode('1st'), false);
  });
});

describe('buildInvoiceLedgerLineDisplay', () => {
  it('matches operational Williamson-style billed lines (rate, description stripped, qty, money)', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_code: '43,894',
      line_description:
        '1A- Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
      quantity: 43_894,
      unit_price: 6.9,
      line_total: 302_868.6,
    });
    assert.equal(row.rateCode, '1A');
    assert.equal(
      row.description,
      'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
    );
    assert.equal(row.quantity, '43,894');
    assert.equal(row.unitPrice, '$6.90');
    assert.equal(row.lineTotal, '$302,868.60');
  });

  it('parses six invoice-style prefixes including 1A with tight hyphen spacing', () => {
    const exact = [
      '1A- Vegetative Collect Remove Haul…',
      '1B - Vegetative Collect Remove Haul…',
      '1E - Vegetative Collect Remove Haul…',
      '1F - Vegetative Collect Remove Haul…',
      '5A - Tree Operations Hazardous Tree Removal 6-12 in',
      '6A - Tree Operations Hazardous Hanging Limb Removal >2" per tree',
    ];
    const expectations = ['1A', '1B', '1E', '1F', '5A', '6A'];
    for (let index = 0; index < exact.length; index += 1) {
      const row = buildInvoiceLedgerLineDisplay({
        line_description: exact[index],
        quantity: 1,
        unit_price: 10,
        line_total: 10,
      });
      assert.equal(row.rateCode, expectations[index], exact[index]);
    }
  });

  it('does not surface billing_rate_key when description embeds a rate code (duplicate or alternate token)', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_description: '1A- Vegetative work',
      billing_rate_key: '5B',
      quantity: 100,
      unit_price: 2,
      line_total: 200,
    });
    assert.equal(row.rateCode, '1A');
    assert.equal(row.description, 'Vegetative work');
  });

  it('strips prefixes so descriptions omit the extracted rate tokens', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_description: '5A - Tree Operations Hazardous Tree Removal 6-12 in',
      quantity: 1,
      unit_price: 10,
      line_total: 10,
    });
    assert.equal(row.rateCode, '5A');
    assert.equal(row.description, 'Tree Operations Hazardous Tree Removal 6-12 in');
    assert.ok(!row.description.includes('5A'));
  });

  it('recovers rate code from raw_text when description omits the code and structured line_code is quantity', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_code: '43,894',
      line_description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS',
      raw_text:
        '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894.00 CYD 6.90 302,868.60',
      quantity: 43_894,
      unit_price: 6.9,
      line_total: 302_868.6,
    });
    assert.equal(row.rateCode, '1A');
    assert.equal(
      row.description,
      'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS',
    );
  });

  it('recovers 6A from raw_text when line_code matches EA quantity leakage', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_code: '994',
      line_description: 'Tree Operations Hazardous Hanging Limb Removal',
      raw_text: '6A Tree Operations Hazardous Hanging Limb Removal 994.00 EA 80.00 79,520.00',
      quantity: 994,
      unit_price: 80,
      line_total: 79_520,
    });
    assert.equal(row.rateCode, '6A');
    assert.equal(row.description, 'Tree Operations Hazardous Hanging Limb Removal');
  });

  it('prefers structured line_description when absent line_code relies on raw_text recovery', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_description: 'Vegetative Collect Remove Haul',
      raw_text: '1B Vegetative Collect Remove Haul 12,250 CYD 7.90',
      quantity: 12_250,
      unit_price: 7.9,
      line_total: 96_775,
    });
    assert.equal(row.rateCode, '1B');
    assert.equal(row.description, 'Vegetative Collect Remove Haul');
  });

  it('recovers rate code embedded mid line_description when structured line_code is numeric quantity', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_code: '12,250',
      line_description: 'Additional 1B - Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS',
      quantity: 12_250,
      unit_price: 7.9,
      line_total: 96_775,
    });
    assert.equal(row.rateCode, '1B');
  });

  it('recovers rate code from description field when line_description is absent', () => {
    const row = buildInvoiceLedgerLineDisplay({
      description: '1E - Vegetative Collect Remove Haul Rural Areas ROW to DMS',
      line_code: '3099',
      quantity: 3099,
      unit_price: 13.5,
      line_total: 41_836.5,
    });
    assert.equal(row.rateCode, '1E');
  });

  it('recovers rate code from text when line_description omits code', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_description: 'Tree Operations Hazardous Hanging Limb Removal',
      text: '6A Tree Operations Hazardous Hanging Limb Removal 994.00 LH',
      line_code: '994',
      quantity: 994,
      unit_price: 80,
      line_total: 79_520,
    });
    assert.equal(row.rateCode, '6A');
  });

  it('recovers 5A when embedded after other words in line_description', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_description: 'Billing 5A - Tree Operations Hazardous Tree Removal 6-12 in',
      quantity: 5,
      unit_price: 95,
      line_total: 475,
    });
    assert.equal(row.rateCode, '5A');
  });

  it('keeps space-delimited 5A Williamson tree line with clean description column', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_code: '5A',
      line_description: 'Tree Operations Hazardous Tree Removal',
      raw_text: '5A Tree Operations Hazardous Tree Removal 5.00 EA 95.00 475.00',
      quantity: 5,
      unit_price: 95,
      line_total: 475,
    });
    assert.equal(row.rateCode, '5A');
    assert.equal(row.description, 'Tree Operations Hazardous Tree Removal');
  });

  it('recovers unit price from raw tail when typed unit echoes quantity ($ in tail)', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_description: 'Vegetative Collect …',
      line_code: '43,894',
      quantity: 43_894,
      unit_price: 43_894,
      line_total: 302_868.6,
      raw_text:
        '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894.00 CYD $6.90 $302,868.60',
    });
    assert.equal(row.unitPrice, '$6.90');
    assert.equal(row.lineTotal, '$302,868.60');
  });

  it('does not invent a rate code from a quantity-prefixed raw_text line', () => {
    const row = buildInvoiceLedgerLineDisplay({
      line_description: 'Vegetative',
      raw_text: '43894 Vegetative trailing text',
      quantity: 43_894,
      unit_price: 1,
      line_total: 43_894,
    });
    assert.equal(row.rateCode, 'Unavailable');
  });

  it('Williamson reprocess: rate from raw_text_for_display, description column preserved (2026-002 six lines)', () => {
    const specs = [
      {
        want: '1A',
        line_description:
          'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
        raw_text: '43,894.00 ROW $6.90 $302,868.60',
        full:
          '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894.00 CYD $6.90 $302,868.60',
        leak: '43,894',
        qty: 43_894,
        up: 6.9,
        tot: 302_868.6,
      },
      {
        want: '1B',
        line_description:
          'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30',
        raw_text: '12,250.00 ROW $7.90 $96,775.00',
        full:
          '1B Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 12,250.00 CYD $7.90 $96,775.00',
        leak: '12,250',
        qty: 12_250,
        up: 7.9,
        tot: 96_775,
      },
      {
        want: '1E',
        line_description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15',
        raw_text: '3,099.00 ROW $13.50 $41,836.50',
        full:
          '1E Vegetative Collect Remove Haul Rural Areas ROW to DMS 3,099.00 CYD $13.50 $41,836.50',
        leak: '3,099',
        qty: 3099,
        up: 13.5,
        tot: 41_836.5,
      },
      {
        want: '1F',
        line_description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30',
        raw_text: '916.00 ROW $14.50 $13,282.00',
        full:
          '1F Vegetative Collect Remove Haul Rural Areas ROW to DMS 916.00 CYD $14.50 $13,282.00',
        leak: '916',
        qty: 916,
        up: 14.5,
        tot: 13_282,
      },
      {
        want: '5A',
        line_description: 'Tree Operations Hazardous Tree Removal 6-12 in',
        raw_text: '5.00 EA $95.00 $475.00',
        full: '5A Tree Operations Hazardous Tree Removal 5.00 EA $95.00 $475.00',
        leak: '5',
        qty: 5,
        up: 95,
        tot: 475,
      },
      {
        want: '6A',
        line_description: 'Tree Operations Hazardous Hanging Limb Removal >2" per tree',
        raw_text: '994.00 LH $80.00 $79,520.00',
        full: '6A Tree Operations Hazardous Hanging Limb Removal 994.00 LH $80.00 $79,520.00',
        leak: '994',
        qty: 994,
        up: 80,
        tot: 79_520,
      },
    ];
    for (const spec of specs) {
      const row = buildInvoiceLedgerLineDisplay({
        line_code: spec.leak,
        line_description: spec.line_description,
        raw_text: spec.raw_text,
        raw_text_for_display: spec.full,
        quantity: spec.qty,
        unit_price: spec.up,
        line_total: spec.tot,
      });
      assert.equal(row.rateCode, spec.want, spec.want);
      assert.equal(row.description, spec.line_description, spec.want);
    }
  });
});

describe('normalizeInvoiceSurfaceLineItem passthrough and InvoiceSurface ledger mapping', () => {
  const executionTraceMinimal = {
    facts: {},
    decisions: [],
    flow_tasks: [],
    generated_at: '2026-03-23T14:00:00Z',
    engine_version: 'document_intelligence:v2',
    classification: {
      label: 'Invoice',
      family: 'invoice',
    },
  } as Record<string, unknown>;

  it('builds InvoiceSurface extraction from reviewed and overridden facts before stale machine values', () => {
    const model = buildModel({
      documentId: 'invoice-effective-facts',
      documentType: 'invoice',
      documentName: 'invoice.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-STale',
            vendor_name: 'Stale Machine Vendor',
            total_amount: 916,
            line_items: [{
              line_code: '6A',
              line_description: 'Monitor tower',
              quantity: 916,
              unit_price: 14.5,
              line_total: 13_282,
            }],
          },
        },
        extraction: {
          evidence_v1: {},
        },
      },
      executionTrace: executionTraceMinimal as never,
      factOverrides: [
        makeFactOverride({
          id: 'override-vendor',
          documentId: 'invoice-effective-facts',
          fieldKey: 'vendor_name',
          valueJson: 'Corrected Vendor LLC',
          actionType: 'correct',
          createdAt: '2026-05-06T10:00:00.000Z',
        }),
      ],
      factReviews: [
        makeFactReview({
          id: 'review-total',
          documentId: 'invoice-effective-facts',
          fieldKey: 'total_amount',
          reviewStatus: 'corrected',
          reviewedValueJson: 13_282,
          reviewedAt: '2026-05-06T10:01:00.000Z',
        }),
      ],
    });

    assert.equal(model.invoiceExtraction?.contractorName, 'Corrected Vendor LLC');
    assert.equal(model.invoiceExtraction?.vendor_name, 'Corrected Vendor LLC');
    assert.equal(model.invoiceExtraction?.totalAmount, 13_282);
    assert.equal(model.invoiceExtraction?.lineItems?.[0]?.unitPrice, 14.5);
  });

  it('preserves raw_text / rawText / line_text / text on normalized surface lines', () => {
    const raw = '1A Vegetative Collect Remove Haul 43,894 CYD';
    const model = buildModel({
      documentId: 'inv-surface-passthrough',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-PASS',
            line_items: [
              {
                line_code: '43894',
                line_description: 'Vegetative Collect Remove Haul',
                quantity: 43_894,
                unit_price: 6.9,
                line_total: 302_868.6,
                raw_text: raw,
                rawText: 'camel-raw-unused-in-split',
                line_text: 'line-text-slot',
                text: 'text-slot',
              },
            ],
          },
        },
        extraction: {
          evidence_v1: {},
        },
      },
      executionTrace: executionTraceMinimal as never,
    });

    const line = model.invoiceExtraction?.lineItems?.[0];
    assert.ok(line, 'invoice surface line items');
    assert.equal(line.raw_text, raw);
    assert.equal(line.rawText, 'camel-raw-unused-in-split');
    assert.equal(line.line_text, 'line-text-slot');
    assert.equal(line.text, 'text-slot');
    assert.equal(line.lineCode, '1A');

    const mapped = invoiceSurfaceLineItemToLedgerRecord(line as Record<string, unknown>);
    assert.equal(mapped.raw_text, raw);
    assert.equal(mapped.line_text, 'line-text-slot');
    const row = buildInvoiceLedgerLineDisplay(mapped);
    assert.equal(row.rateCode, '1A');
    assert.equal(row.quantity, '43,894');
  });

  it('preserves raw_text_for_display through typed line_items onto invoice extraction', () => {
    const displayFull =
      '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894.00 CYD $6.90 $302,868.60';
    const model = buildModel({
      documentId: 'inv-raw-display',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: '2026-002',
            line_items: [
              {
                line_code: '43,894',
                line_description:
                  'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
                quantity: 43_894,
                unit_price: 6.9,
                line_total: 302_868.6,
                raw_text: '43,894.00 ROW $6.90 $302,868.60',
                raw_text_for_display: displayFull,
              },
            ],
          },
        },
        extraction: { evidence_v1: {} },
      },
      executionTrace: executionTraceMinimal as never,
    });

    const line = model.invoiceExtraction?.lineItems?.[0];
    assert.ok(line);
    assert.equal(line?.raw_text_for_display, displayFull);
    assert.equal(line?.lineCode, '1A');
    const mapped = invoiceSurfaceLineItemToLedgerRecord(line as Record<string, unknown>);
    assert.equal(mapped.raw_text_for_display, displayFull);
    const row = buildInvoiceLedgerLineDisplay(mapped);
    assert.equal(row.rateCode, '1A');
    assert.equal(
      row.description,
      'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
    );
  });

  it('Williamson 2026-002 typed_fields split: fuller description column wins over truncated line_description', () => {
    const rows = [
      {
        wantCode: '1A',
        wantDesc: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
        fact: {
          line_code: '43,894',
          line_description:
            'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS',
          description:
            'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
          quantity: 43_894,
          unit_price: 6.9,
          line_total: 302_868.6,
          raw_text: '43,894.00 ROW $6.90 $302,868.60',
          raw_text_for_display:
            '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894.00 CYD $6.90 $302,868.60',
        },
      },
      {
        wantCode: '1B',
        wantDesc: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30',
        fact: {
          line_code: '12,250',
          line_description:
            'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS',
          description:
            'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30',
          quantity: 12_250,
          unit_price: 7.9,
          line_total: 96_775,
          raw_text: '12,250.00 ROW $7.90 $96,775.00',
          raw_text_for_display:
            '1B Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 12,250.00 CYD $7.90 $96,775.00',
        },
      },
      {
        wantCode: '1E',
        wantDesc: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15',
        fact: {
          line_code: '3,099',
          line_description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS',
          description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15',
          quantity: 3099,
          unit_price: 13.5,
          line_total: 41_836.5,
          raw_text: '3,099.00 ROW $13.50 $41,836.50',
          raw_text_for_display:
            '1E Vegetative Collect Remove Haul Rural Areas ROW to DMS 3,099.00 CYD $13.50 $41,836.50',
        },
      },
      {
        wantCode: '1F',
        wantDesc: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30',
        fact: {
          line_code: '916',
          line_description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS',
          description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30',
          quantity: 916,
          unit_price: 14.5,
          line_total: 13_282,
          raw_text: '916.00 ROW $14.50 $13,282.00',
          raw_text_for_display:
            '1F Vegetative Collect Remove Haul Rural Areas ROW to DMS 916.00 CYD $14.50 $13,282.00',
        },
      },
      /** Single-column description (often how 5A is persisted — no competing truncated line_description). */
      {
        wantCode: '5A',
        wantDesc: 'Tree Operations Hazardous Tree Removal 6-12 in',
        fact: {
          line_code: '5',
          line_description: 'Tree Operations Hazardous Tree Removal 6-12 in',
          quantity: 5,
          unit_price: 95,
          line_total: 475,
          raw_text: '5.00 EA $95.00 $475.00',
          raw_text_for_display: '5A Tree Operations Hazardous Tree Removal 5.00 EA $95.00 $475.00',
        },
      },
      {
        wantCode: '6A',
        wantDesc: 'Tree Operations Hazardous Hanging Limb Removal >2" per tree',
        fact: {
          line_code: '994',
          line_description: 'Tree Operations Hazardous Hanging Limb Removal',
          description: 'Tree Operations Hazardous Hanging Limb Removal >2" per tree',
          quantity: 994,
          unit_price: 80,
          line_total: 79_520,
          raw_text: '994.00 LH $80.00 $79,520.00',
          raw_text_for_display:
            '6A Tree Operations Hazardous Hanging Limb Removal 994.00 LH $80.00 $79,520.00',
        },
      },
    ] as const;

    const model = buildModel({
      documentId: 'inv-williamson-2026-002-split',
      documentType: 'invoice',
      documentName: 'inv.xlsx',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: '2026-002',
            line_items: rows.map((r) => ({ ...r.fact })),
          },
        },
        extraction: { evidence_v1: {} },
      },
      executionTrace: executionTraceMinimal as never,
    });

    rows.forEach((row, lineIndex) => {
      const display = buildInvoiceLedgerLineDisplay(row.fact as Record<string, unknown>);
      assert.equal(display.rateCode, row.wantCode);
      assert.equal(display.description, row.wantDesc);

      const surfaceLine = model.invoiceExtraction?.lineItems?.[lineIndex];
      assert.ok(surfaceLine, row.wantCode);
      const surfaced = buildInvoiceLedgerLineDisplay(
        invoiceSurfaceLineItemToLedgerRecord(surfaceLine as Record<string, unknown>),
      );
      assert.equal(surfaced.rateCode, row.wantCode);
      assert.equal(surfaced.description, row.wantDesc);
    });
  });

  it('recovers billed line display from the exact stored Williamson 2026-002 row shape plus page text', () => {
    const storedRows = [
      {
        unit: null,
        total: 302_868.6,
        quantity: 43_894,
        raw_text: '43,894.00 $6.90 $302,868.60 Neighborhoods ROW to DMS 0 to 15',
        line_code: null,
        line_total: 302_868.6,
        unit_price: 43_894,
        description: '$6.90 Neighborhoods ROW to DMS 0 to 15',
        billing_rate_key: 'desc:6 90 neighborhoods row to dms 0 to 15',
        line_description: '$6.90 Neighborhoods ROW to DMS 0 to 15',
        description_match_key: '6 90 neighborhoods row to dms 0 to 15',
      },
      {
        unit: null,
        total: 96_775,
        quantity: 12_250,
        raw_text: '12,250.00 $7.90 $96,775.00 Neighborhoods ROW to DMS 16 to 30',
        line_code: null,
        line_total: 96_775,
        unit_price: 12_250,
        description: '$7.90 Neighborhoods ROW to DMS 16 to 30',
        billing_rate_key: 'desc:7 90 neighborhoods row to dms 16 to 30',
        line_description: '$7.90 Neighborhoods ROW to DMS 16 to 30',
        description_match_key: '7 90 neighborhoods row to dms 16 to 30',
      },
      {
        unit: null,
        total: 13_282,
        quantity: 916,
        raw_text: '916.00 $14.50 $13,282.00 to 30',
        line_code: null,
        line_total: 13_282,
        unit_price: 916,
        description: '$14.50 to 30',
        billing_rate_key: 'desc:14 50 to 30',
        line_description: '$14.50 to 30',
        description_match_key: '14 50 to 30',
      },
      {
        unit: null,
        total: 475,
        quantity: 5,
        raw_text: '5.00 5A - Tree Operations Hazardous Tree Removal 6-12 in $95.00 $475.00',
        line_code: null,
        line_total: 475,
        unit_price: 5,
        description: '5A - Tree Operations Hazardous Tree Removal 6-12 in $95.00',
        billing_rate_key: 'desc:5a tree operations hazardous tree removal 6 12 in 95 00',
        line_description: '5A - Tree Operations Hazardous Tree Removal 6-12 in $95.00',
        description_match_key: '5a tree operations hazardous tree removal 6 12 in 95 00',
      },
      {
        unit: null,
        total: 79_520,
        quantity: 994,
        raw_text: '994 $80.00 $79,520.00 tree',
        line_code: null,
        line_total: 79_520,
        unit_price: 994,
        description: '$80.00 tree',
        billing_rate_key: 'desc:80 00 tree',
        line_description: '$80.00 tree',
        description_match_key: '80 00 tree',
      },
    ];
    const pageText = [
      'INVOICE',
      'Aftermath Disaster Recovery, Inc.',
      'Williamson County Highway Dept',
      '302 Beasley Dr',
      'Due Date',
      'Emergency Agmt for Disaster Debris Removal Services',
      'Q Quantity Description Unit Price Line Total',
      '1A- Vegetative Collect Remove Haul Unincorporated',
      '43,894.00 $6.90 $302,868.60',
      'Neighborhoods ROW to DMS 0 to 15',
      '1B - Vegetative Collect Remove Haul Unincorporated',
      '12,250.00 $7.90 $96,775.00',
      'Neighborhoods ROW to DMS 16 to 30',
      '1E - Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to',
      '3,099.00 $13.50 $41,836.50',
      '15',
      '1F - Vegetative Collect Remove Haul Rural Areas ROW to DMS 16',
      '916.00 $14.50 $13,282.00',
      'to 30',
      '5.00 5A - Tree Operations Hazardous Tree Removal 6-12 in $95.00 $475.00',
      '6A - Tree Operations Hazardous Hanging Limb Removal >2" per',
      '994 $80.00 $79,520.00',
      'tree',
      'Subtotal $ 534,757.10',
    ].join('\n');

    const model = buildModel({
      documentId: 'inv-williamson-2026-002-stored-shape',
      documentType: 'invoice',
      documentName: 'Aftermath-Williamson Co invoice - ROW and LH .xlsx - 2026-002_01INV_InvoiceCover.pdf',
      documentTitle: 'Aftermath-Williamson Co invoice - ROW and LH .xlsx - 2026-002_01INV_InvoiceCover',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: '2026-002',
            line_items: storedRows,
          },
        },
        extraction: {
          evidence_v1: {
            page_text: [{ page_number: 1, source_method: 'pdf_text', text: pageText }],
          },
        },
      },
      executionTrace: executionTraceMinimal as never,
    });

    const expectedCodes = ['1A', '1B', '1E', '1F', '5A', '6A'];
    const expectedDescriptions = [
      'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
      'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30',
      'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15',
      'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30',
      'Tree Operations Hazardous Tree Removal 6-12 in',
      'Tree Operations Hazardous Hanging Limb Removal >2" per tree',
    ];

    const surfaceItems = model.invoiceExtraction?.lineItems ?? [];
    assert.equal(surfaceItems.length, 6);
    assert.deepEqual(surfaceItems.map((item) => item.lineCode), expectedCodes);
    surfaceItems.forEach((item, index) => {
      const row = buildInvoiceLedgerLineDisplay(
        invoiceSurfaceLineItemToLedgerRecord(item as Record<string, unknown>),
      );
      assert.equal(row.rateCode, expectedCodes[index]);
      assert.equal(row.description, expectedDescriptions[index]);
      assert.equal(/INVOICE|Aftermath|Williamson County|Due Date|Emergency Agmt/.test(row.description), false);
    });

    const factItems = model.facts.find((fact) =>
      ['line_items', 'invoice_line_items'].includes(fact.fieldKey),
    )?.normalizedValue;
    assert.ok(Array.isArray(factItems));
    assert.equal(factItems.length, 6);
    factItems.forEach((item, index) => {
      const row = buildInvoiceLedgerLineDisplay(item as Record<string, unknown>);
      assert.equal(row.rateCode, expectedCodes[index]);
      assert.equal(row.description, expectedDescriptions[index]);
      assert.equal(/INVOICE|Aftermath|Williamson County|Due Date|Emergency Agmt/.test(row.description), false);
    });
  });

  it('cleans invoice facts display while preserving the recovered rate lines table source', () => {
    const model = buildModel({
      documentId: 'inv-facts-cleanup',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: '2026-002',
            invoice_date: '2026-04-03',
            invoice_status: 'OPEN',
            section: 'pdf:text:p1:b9',
            normalized: 'helper',
            text: 'pdf:text:p1:b10',
            raw_text: 'raw helper text',
            period_start: '2026-02-23',
            period_end: '2026-03-18',
            billing_period: '2/23/26 through 3/18/2026',
            period_through: '2026-03-18',
            periodFrom: '2026-02-23',
            periodTo: '2026-03-18',
            subtotal_amount: 534_757.1,
            current_amount_due: 534_757.1,
            line_item_support_present: true,
            line_item_count: 6,
            line_item_codes: ['1A', '1B', '1E', '1F', '5A', '6A'],
            line_items: [
              {
                line_code: '1A',
                line_description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
                quantity: 43_894,
                unit_price: 6.9,
                line_total: 302_868.6,
              },
              {
                line_code: '1B',
                line_description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30',
                quantity: 12_250,
                unit_price: 7.9,
                line_total: 96_775,
              },
              {
                line_code: '1E',
                line_description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15',
                quantity: 3099,
                unit_price: 13.5,
                line_total: 41_836.5,
              },
              {
                line_code: '1F',
                line_description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30',
                quantity: 916,
                unit_price: 14.5,
                line_total: 13_282,
              },
              {
                line_code: '5A',
                line_description: 'Tree Operations Hazardous Tree Removal 6-12 in',
                quantity: 5,
                unit_price: 95,
                line_total: 475,
              },
              {
                line_code: '6A',
                line_description: 'Tree Operations Hazardous Hanging Limb Removal >2" per tree',
                quantity: 994,
                unit_price: 80,
                line_total: 79_520,
              },
            ],
          },
        },
        extraction: { evidence_v1: {} },
      },
      executionTrace: executionTraceMinimal as never,
    });

    const factKeys = model.facts.map((fact) => fact.fieldKey);
    assert.ok(factKeys.includes('invoice_number'));
    assert.ok(factKeys.includes('invoice_date'));
    assert.ok(factKeys.includes('billed_amount'));
    assert.ok(factKeys.includes('period_start'));
    assert.ok(factKeys.includes('period_end'));
    assert.ok(factKeys.includes('line_item_count'));
    assert.ok(factKeys.some((key) => ['line_items', 'invoice_line_items'].includes(key)));

    for (const hidden of [
      'invoice_status',
      'section',
      'normalized',
      'text',
      'raw_text',
      'billing_period',
      'period_through',
      'period_from',
      'period_to',
      'subtotal_amount',
      'line_item_support_present',
      'line_item_codes',
    ]) {
      assert.equal(factKeys.includes(hidden), false, hidden);
    }

    const servicePeriod = model.groups.find((group) => group.key === 'billing_period');
    assert.equal(servicePeriod?.label, 'Service Period');
    assert.deepEqual(servicePeriod?.facts.map((fact) => fact.fieldKey), ['period_start', 'period_end']);

    const rateLines = model.groups.find((group) => group.key === 'rate_lines');
    assert.deepEqual(rateLines?.facts.map((fact) => fact.fieldKey), ['line_item_count', 'line_items']);
    const lineItems = rateLines?.facts.find((fact) =>
      ['line_items', 'invoice_line_items'].includes(fact.fieldKey),
    )?.normalizedValue;
    assert.ok(Array.isArray(lineItems));
    assert.equal(lineItems.length, 6);
    assert.deepEqual(
      lineItems.map((item) => buildInvoiceLedgerLineDisplay(item as Record<string, unknown>).rateCode),
      ['1A', '1B', '1E', '1F', '5A', '6A'],
    );
  });

  it('recovers 1A / 1B / 1E / 1F / 5A / 6A through surface normalization + InvoiceSurface ledger record', () => {
    const lineSpecs = [
      {
        expectCode: '1A',
        raw: '1A Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 43,894.00 CYD 6.90',
        desc: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
        leak: '43894',
        qty: 43_894,
        unitPrice: 6.9,
        total: 302_868.6,
      },
      {
        expectCode: '1B',
        raw: '1B Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 12,250.00 CYD 7.90',
        desc: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30',
        leak: '12250',
        qty: 12_250,
        unitPrice: 7.9,
        total: 96_775,
      },
      {
        expectCode: '1E',
        raw: '1E Vegetative Collect Remove Haul Rural Areas ROW to DMS 3,099.00 CYD 13.50',
        desc: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15',
        leak: '3099',
        qty: 3099,
        unitPrice: 13.5,
        total: 41_836.5,
      },
      {
        expectCode: '1F',
        raw: '1F Vegetative Collect Remove Haul Rural Areas ROW to DMS 916.00 CYD 14.50',
        desc: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30',
        leak: '916',
        qty: 916,
        unitPrice: 14.5,
        total: 13_282,
      },
      {
        expectCode: '5A',
        raw: '5A Tree Operations Hazardous Tree Removal 5.00 EA 95.00',
        desc: 'Tree Operations Hazardous Tree Removal 6-12 in',
        leak: '5',
        qty: 5,
        unitPrice: 95,
        total: 475,
      },
      {
        expectCode: '6A',
        raw: '6A Tree Operations Hazardous Hanging Limb Removal 994.00 EA 80.00',
        desc: 'Tree Operations Hazardous Hanging Limb Removal >2" per tree',
        leak: '994',
        qty: 994,
        unitPrice: 80,
        total: 79_520,
      },
    ];

    const model = buildModel({
      documentId: 'inv-williamson-six-surface',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: '2026-002',
            line_items: lineSpecs.map((spec) => ({
              line_code: spec.leak,
              line_description: spec.desc,
              quantity: spec.qty,
              unit_price: spec.unitPrice,
              line_total: spec.total,
              raw_text: spec.raw,
            })),
          },
        },
        extraction: {
          evidence_v1: {},
        },
      },
      executionTrace: executionTraceMinimal as never,
    });

    const items = model.invoiceExtraction?.lineItems ?? [];
    assert.equal(items.length, 6);
    for (let i = 0; i < lineSpecs.length; i += 1) {
      assert.equal(items[i]?.raw_text, lineSpecs[i].raw, lineSpecs[i].expectCode);
      const row = buildInvoiceLedgerLineDisplay(
        invoiceSurfaceLineItemToLedgerRecord(items[i] as Record<string, unknown>),
      );
      assert.equal(row.rateCode, lineSpecs[i].expectCode);
      assert.equal(row.description, lineSpecs[i].desc);
    }
  });
});

describe('invoice unit price (no generic rate as unit price)', () => {
  const executionTraceMinimal = {
    facts: {},
    decisions: [],
    flow_tasks: [],
    generated_at: '2026-03-23T14:00:00Z',
    engine_version: 'document_intelligence:v2',
    classification: {
      label: 'Invoice',
      family: 'invoice',
    },
  } as Record<string, unknown>;

  it('surface line uses unit_price over misused rate; string $6.90 parses; unitRate and unit_rate work', () => {
    const model = buildModel({
      documentId: 'inv-unit-price',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-U',
            line_items: [
              {
                line_description: 'Vegetative',
                quantity: 43_894,
                rate: 43_894,
                unit_price: 6.9,
                line_total: 302_868.6,
                raw_text: '1A Vegetative 43,894 CYD 6.90',
              },
              {
                line_description: 'Trees',
                quantity: 5,
                rate: 999,
                unitRate: 95,
                line_total: 475,
              },
              {
                line_description: 'Dollar string',
                quantity: 1,
                rate: 1,
                unit_price: '$6.90',
                line_total: 6.9,
              },
              {
                line_description: 'Snake unit_rate',
                quantity: 2,
                rate: 50_000,
                unit_rate: 12.5,
                line_total: 25,
              },
            ],
          },
        },
        extraction: { evidence_v1: {} },
      },
      executionTrace: executionTraceMinimal as never,
    });

    const items = model.invoiceExtraction?.lineItems ?? [];
    assert.equal(items[0]?.unitPrice, 6.9);
    assert.equal(items[1]?.unitPrice, 95);
    assert.equal(items[2]?.unitPrice, 6.9);
    assert.equal(items[3]?.unitPrice, 12.5);

    assert.equal(
      buildInvoiceLedgerLineDisplay(invoiceSurfaceLineItemToLedgerRecord(items[0] as Record<string, unknown>))
        .unitPrice,
      '$6.90',
    );
    assert.equal(
      buildInvoiceLedgerLineDisplay(invoiceSurfaceLineItemToLedgerRecord(items[2] as Record<string, unknown>))
        .unitPrice,
      '$6.90',
    );
  });

  it('surface line does not treat generic rate as unit price when unit_price absent', () => {
    const model = buildModel({
      documentId: 'inv-rate-only',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-RO',
            line_items: [
              {
                line_description: 'Misaligned row',
                quantity: 43_894,
                rate: 43_894,
                line_total: 302_868.6,
              },
            ],
          },
        },
        extraction: { evidence_v1: {} },
      },
      executionTrace: executionTraceMinimal as never,
    });

    const line = model.invoiceExtraction?.lineItems?.[0];
    assert.ok(line);
    assert.equal(line.unitPrice, undefined);
    const row = buildInvoiceLedgerLineDisplay(invoiceSurfaceLineItemToLedgerRecord(line as Record<string, unknown>));
    assert.equal(row.unitPrice, 'Unavailable');
    assert.equal(row.lineTotal, '$302,868.60');
  });
});

describe('invoice party labels in view model', () => {
  it('uses contractor and client field labels and splits embedded rate codes for invoice lines', () => {
    const model = buildModel({
      documentId: 'inv-party-labels',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-100',
            invoice_date: '2026-01-05',
            vendor_name: 'Aftermath Disaster Recovery, Inc.',
            client_name: 'Williamson County, Tennessee',
            line_items: [
              {
                line_code: '43894',
                billing_rate_key: '999Z',
                line_description:
                  '1A- Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
                quantity: 43_894,
                unit_price: 6.9,
                line_total: 302_868.6,
              },
            ],
          },
        },
        extraction: {
          evidence_v1: {},
        },
      },
      executionTrace: {
        facts: {
          invoice_number: 'INV-100',
          vendor_name: 'Aftermath Disaster Recovery, Inc.',
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        classification: {
          label: 'Invoice',
          family: 'invoice',
        },
      },
    });

    const contractor = model.facts.find((fact) => fact.fieldKey === 'contractor_name');
    const client = model.facts.find((fact) => fact.fieldKey === 'client_name');
    assert.ok(contractor, 'contractor fact present');
    assert.ok(client, 'client fact present');
    assert.equal(contractor?.fieldLabel, 'Contractor');
    assert.equal(client?.fieldLabel, 'Client');
    assert.equal(contractor?.displayValue, 'Aftermath Disaster Recovery');

    assert.equal(model.family, 'invoice');
    const line = model.invoiceExtraction?.lineItems?.[0];
    assert.ok(line);
    assert.equal(line?.lineCode, '1A');
    assert.ok(line?.lineDescription?.startsWith('Vegetative'));
    assert.equal(line?.billingRateKey, undefined);
  });
});

describe('invoice period formatting', () => {
  it('formats US short range for ISO endpoints', () => {
    assert.equal(
      formatInvoiceServicePeriodRangeFromEndpoints('2026-02-22', '2026-03-17'),
      'Feb 22, 2026 → Mar 17, 2026',
    );
  });
});

describe('deriveLedgerInsightSignals', () => {
  it('returns invoice insights for a reconciled invoice', () => {
    const model = buildModel({
      documentId: 'inv-insights-clean',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-100',
            vendor_name: 'Vendor Co',
            client_name: 'Client Co',
          },
        },
        extraction: { evidence_v1: {} },
      },
      executionTrace: {
        facts: {
          invoice_number: 'INV-100',
          vendor_name: 'Vendor Co',
          client_name: 'Client Co',
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        classification: { label: 'Invoice', family: 'invoice' },
      },
    });
    const signals = deriveLedgerInsightSignals(model, []);
    assert.equal(signals?.isInvoiceInsights, true);
    assert.equal(signals?.missingInvoiceParties, false);
    assert.equal(signals?.crossDocComparisonDebt, false);
    assert.equal(signals?.needsReviewFactCount >= 0, true);
  });

  it('flags missing invoice parties', () => {
    const model = buildModel({
      documentId: 'inv-insights-missing-parties',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: { typed_fields: { invoice_number: 'INV-1' } },
        extraction: { evidence_v1: {} },
      },
      executionTrace: {
        facts: { invoice_number: 'INV-1' },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        classification: { label: 'Invoice', family: 'invoice' },
      },
    });
    const signals = deriveLedgerInsightSignals(model, []);
    assert.equal(signals?.missingInvoiceParties, true);
  });

  it('flags cross-document contract comparison debt', () => {
    const model = buildModel({
      documentId: 'inv-insights-xdoc',
      documentType: 'invoice',
      documentName: 'inv.pdf',
      documentTitle: 'Invoice',
      preferredExtraction: {
        fields: {
          typed_fields: {
            invoice_number: 'INV-100',
            vendor_name: 'Vendor Co',
            client_name: 'Client Co',
          },
        },
        extraction: { evidence_v1: {} },
      },
      executionTrace: {
        facts: {
          invoice_number: 'INV-100',
          vendor_name: 'Vendor Co',
          client_name: 'Client Co',
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-23T14:00:00Z',
        engine_version: 'document_intelligence:v2',
        classification: { label: 'Invoice', family: 'invoice' },
      },
    });
    const signals = deriveLedgerInsightSignals(model, [
      {
        id: 'cmp-1',
        check: 'Contract unit rates',
        status: 'missing',
        leftLabel: 'Contract',
        leftValue: null,
        rightLabel: 'Invoice',
        rightValue: null,
        explanation: 'No linked contract row.',
      },
    ]);
    assert.equal(signals?.crossDocComparisonDebt, true);
  });
});
