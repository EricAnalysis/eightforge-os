import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { extractNode } from '@/lib/pipeline/nodes/extractNode';
import { normalizeNode } from '@/lib/pipeline/nodes/normalizeNode';

function makeTableRow(params: {
  id: string;
  page: number;
  rowIndex: number;
  cells: Array<string | { text: string; source?: 'ocr_fallback' | 'pdfjs' }>;
}): Record<string, unknown> {
  return {
    id: params.id,
    page_number: params.page,
    row_index: params.rowIndex,
    cells: params.cells.map((cell, index) => ({
      column_index: index,
      text: typeof cell === 'string' ? cell : cell.text,
      source: typeof cell === 'string' ? undefined : cell.source,
    })),
    raw_text: params.cells.map((cell) => typeof cell === 'string' ? cell : cell.text).join(' | '),
  };
}

function makeTable(params: {
  id: string;
  page: number;
  headers?: string[];
  headerContext?: string[];
  rows: Array<Array<string | { text: string; source?: 'ocr_fallback' | 'pdfjs' }>>;
}): Record<string, unknown> {
  return {
    id: params.id,
    page_number: params.page,
    headers: params.headers ?? [],
    header_context: params.headerContext ?? [],
    rows: params.rows.map((cells, index) =>
      makeTableRow({
        id: `${params.id}:r${index + 1}`,
        page: params.page,
        rowIndex: index + 1,
        cells,
      }),
    ),
  };
}

function normalizeContractFromTables(params: {
  textPreview?: string;
  tables: Record<string, unknown>[];
  sectionSignals?: Record<string, unknown>;
  typedFields?: Record<string, unknown>;
}) {
  const extracted = extractNode({
    documentId: 'contract-rate-test',
    documentType: 'contract',
    documentName: 'contract-rate-test.pdf',
    documentTitle: 'Contract Rate Test',
    projectName: null,
    extractionData: {
      fields: {
        typed_fields: {
          vendor_name: 'Aftermath Disaster Recovery, Inc.',
          ...params.typedFields,
        },
      },
      extraction: {
        text_preview: params.textPreview ?? '',
        evidence_v1: {
          structured_fields: {},
          section_signals: params.sectionSignals ?? {},
        },
        content_layers_v1: {
          pdf: {
            evidence: [],
            tables: {
              tables: params.tables,
            },
          },
        },
      },
    },
    relatedDocs: [],
  });

  return normalizeNode(extracted);
}

function normalizeInvoiceFromTables(params: {
  typedFields: Record<string, unknown>;
  tables: Record<string, unknown>[];
}) {
  const extracted = extractNode({
    documentId: 'invoice-shadow-warning-test',
    documentType: 'invoice',
    documentName: 'invoice-shadow-warning-test.pdf',
    documentTitle: 'Invoice Shadow Warning Test',
    projectName: null,
    extractionData: {
      fields: {
        typed_fields: params.typedFields,
      },
      extraction: {
        text_preview: '',
        evidence_v1: {
          structured_fields: {},
          section_signals: {},
        },
        content_layers_v1: {
          pdf: {
            evidence: [],
            tables: {
              tables: params.tables,
            },
          },
        },
      },
    },
    relatedDocs: [],
  });

  return normalizeNode(extracted);
}

function makeAssemblyRow(params: {
  documentId: string;
  rowId: string;
  sourceFamily: 'invoice' | 'contract';
  description: string;
  category?: string;
  unit?: string;
  unitPrice?: number;
  mileageTier?: string;
  siteType?: string;
  rowRole?: string;
}) {
  return {
    row_id: params.rowId,
    document_id: params.documentId,
    source_family: params.sourceFamily,
    source_table_key: `${params.sourceFamily}-table`,
    source_document_family: params.sourceFamily,
    assembly_semantic_mode: params.sourceFamily === 'invoice' ? 'transactional' : 'schedule_definition',
    row_role: params.rowRole ?? (params.sourceFamily === 'invoice' ? 'line_item' : 'unit_rate_definition'),
    category: params.category,
    description: params.description,
    unit: params.unit,
    unit_price: params.unitPrice,
    mileage_tier: params.mileageTier,
    site_type: params.siteType,
    warnings: [],
    confidence: 1,
    evidence_refs: [{
      document_id: params.documentId,
      page_number: 1,
      table_key: `${params.sourceFamily}-table`,
      row_index: 1,
      cell_index: 1,
      raw_text: params.description,
      field_assigned: 'description',
      confidence: 1,
    }],
    raw_fragments: [],
  };
}

function normalizeInvoiceFromPersistedDiagnostics() {
  const invoiceId = 'invoice-diff-test';
  const contractId = 'contract-diff-test';
  const extracted = extractNode({
    documentId: invoiceId,
    documentType: 'invoice',
    documentName: 'invoice-diff.pdf',
    documentTitle: 'Invoice Diff',
    projectName: null,
    extractionData: {
      fields: { typed_fields: {} },
      extraction: {
        text_preview: '',
        evidence_v1: { structured_fields: {}, section_signals: {} },
        diagnostics: {
          canonicalOperationalTableRowAssembly: {
            rows: [
              makeAssemblyRow({
                documentId: invoiceId,
                rowId: 'invoice:r1',
                sourceFamily: 'invoice',
                description: 'Collect remove and haul 0-15 miles from ROW to DMS',
                category: 'Vegetative',
                unit: 'CY',
                unitPrice: 7.25,
                mileageTier: '0-15',
                siteType: 'ROW_to_DMS',
              }),
            ],
          },
        },
        content_layers_v1: { pdf: { evidence: [] } },
      },
    },
    relatedDocs: [
      {
        id: contractId,
        document_type: 'contract',
        name: 'contract-diff.pdf',
        title: 'Contract Diff',
        extraction: {
          fields: { typed_fields: {} },
          extraction: {
            text_preview: '',
            evidence_v1: { structured_fields: {}, section_signals: {} },
            diagnostics: {
              canonicalContractRateScheduleAssembly: {
                rows: [
                  makeAssemblyRow({
                    documentId: contractId,
                    rowId: 'contract:r1',
                    sourceFamily: 'contract',
                    description: 'Vegetative debris collection 0-15 Miles from ROW to DMS',
                    category: 'Vegetative',
                    unit: 'Cubic Yard',
                    unitPrice: 6.9,
                    mileageTier: '0-15',
                    siteType: 'ROW_to_DMS',
                  }),
                ],
              },
            },
            content_layers_v1: { pdf: { evidence: [] } },
          },
        },
      },
    ],
  });

  return normalizeNode(extracted);
}

describe('normalizeNode contract rate schedule qualification', () => {
  it('preserves Williamson-style baseline schedules and row counts', () => {
    const normalized = normalizeContractFromTables({
      textPreview:
        'Exhibit A emergency debris removal unit rates. '
        + 'All rates in Exhibit A shall be considered not-to-exceed rates for emergency response purposes.',
      tables: [
        makeTable({
          id: 'williamson-rate-table',
          page: 8,
          headerContext: [
            'EXHIBIT A',
            'EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES',
          ],
          headers: ['Category', 'Description', 'Unit', 'Rate'],
          rows: [
            ['Vegetative Collect, Remove & Haul', '0-15 Miles from ROW to DMS', 'Cubic Yard', '$6.90'],
            ['Vegetative Collect, Remove & Haul', '16-30 Miles from ROW to DMS', 'Cubic Yard', '$7.90'],
            ['Final Disposal', 'Single Cost - Any Distance', 'Cubic Yard', '$5.40'],
          ],
        }),
      ],
    });

    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.rate_schedule_present?.value, true);
    assert.equal(facts.rate_row_count?.value, 3);
    assert.equal(facts.rate_schedule_pages?.value, 'page 8');
    assert.equal(facts.contract_ceiling?.value, null);
    assert.equal(facts.contract_ceiling?.machine_classification, 'rate_price_no_ceiling');
    assert.equal(facts.contract_ceiling_type?.value, 'rate_based');
    const shadow = normalized.extracted.canonicalContractRateScheduleAssembly as Record<string, unknown>;
    assert.ok(shadow);
    assert.equal(shadow.source_family, 'contract');
    assert.equal(shadow.schedule_kind, 'unit_rate');
    assert.equal((shadow.rows as unknown[]).length, 3);
    assert.ok(Array.isArray(shadow.assembly_warnings));
  });

  it('accepts Williamson-style OCR tables with mixed description unit rate cells', () => {
    const normalized = normalizeContractFromTables({
      textPreview: 'Exhibit A emergency debris removal unit rates.',
      tables: [
        makeTable({
          id: 'williamson-ocr-mixed',
          page: 8,
          headerContext: ['EXHIBIT A'],
          headers: ['EXHIBIT', 'A', '|'],
          rows: [
            [{ text: 'Vegetative Collect, Remove & Haul 0-15 Milesfrom ROW t6 DMS Gn | Cubic ____| Yard | $6.90 Rate', source: 'ocr_fallback' }],
            [{ text: 'Vegetative from Unincorporated Collect, Remove Neighborhoods &Haul | 16-30 Miles from ROWtoDMS | Cubic Yard | $7.90', source: 'ocr_fallback' }],
            [{ text: 'Final Disposal | 31-60 Miles from DMS to Final | Cyblc Yard | $4.25', source: 'ocr_fallback' }],
            [{ text: 'Tree Operations Hazardous Tree Removal 6-12 inch | Tree $95.00', source: 'ocr_fallback' }],
            [{ text: 'Tree Operations Hazardous Trees with Hanging Limbs | Tree $80.00', source: 'ocr_fallback' }],
          ],
        }),
      ],
    });

    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.rate_schedule_present?.value, true);
    assert.equal(facts.rate_row_count?.value, 3);
    const shadow = normalized.extracted.canonicalContractRateScheduleAssembly as Record<string, unknown>;
    assert.ok(shadow);
    const rows = shadow.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 5);
    assert.ok(rows.some((row) => row.unit_price === 6.9 && row.unit === 'CY' && row.site_type === 'ROW_to_DMS'));
    assert.ok(rows.some((row) => row.unit_price === 7.9 && row.unit === 'CY' && row.mileage_tier === '16-30'));
    assert.ok(rows.some((row) => row.unit_price === 4.25 && row.unit === 'CY' && row.site_type === 'DMS_to_FDS'));
    assert.ok(rows.some((row) => row.unit_price === 95 && row.unit === 'Tree'));
    assert.ok(rows.some((row) => row.unit_price === 80 && row.unit === 'Tree'));
  });

  it('does not treat NTE amounts beside unit/rate/classification language as contract ceiling when a rate schedule qualifies', () => {
    const normalized = normalizeContractFromTables({
      textPreview: 'Exhibit A unit rates.',
      typedFields: { nte_amount: 9_999_999 },
      tables: [
        makeTable({
          id: 'nte-rate-cap-table',
          page: 3,
          headerContext: ['SCHEDULE', 'Classification', 'Unit', 'Not to exceed rate'],
          headers: ['Classification', 'Unit', 'NTE'],
          rows: [
            ['Line haul vegetative', 'CY', '$6.90'],
            ['Disposal', 'CY', '$5.40'],
          ],
        }),
      ],
    });
    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.contract_ceiling?.value, null);
    assert.equal(facts.contract_ceiling?.machine_classification, 'rate_price_no_ceiling');
    assert.equal(facts.contract_ceiling_type?.value, 'rate_based');
  });

  it('keeps schedule-only pricing without rate-based NTE language classified as no explicit ceiling', () => {
    const normalized = normalizeContractFromTables({
      textPreview: 'Exhibit A emergency debris removal unit rates.',
      tables: [
        makeTable({
          id: 'schedule-only-rate-table',
          page: 6,
          headerContext: ['EXHIBIT A', 'EMERGENCY DEBRIS REMOVAL UNIT RATES'],
          headers: ['Category', 'Description', 'Unit', 'Rate'],
          rows: [
            ['Vegetative', '0-15 Miles from ROW to DMS', 'Cubic Yard', '$6.90'],
            ['Vegetative', '16-30 Miles from ROW to DMS', 'Cubic Yard', '$7.90'],
          ],
        }),
      ],
    });

    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.contract_ceiling?.value, null);
    assert.equal(facts.contract_ceiling?.machine_classification, undefined);
    assert.equal(facts.contract_ceiling_type?.value, 'none');
  });

  it('accepts EMERG03-style wide rate tables with inline unit labels and deterministic debug reasons', () => {
    const previousDebug = process.env.EIGHTFORGE_DEBUG_CONTRACT;
    process.env.EIGHTFORGE_DEBUG_CONTRACT = '1';

    try {
      const normalized = normalizeContractFromTables({
        textPreview: 'Attachment B unit rate price form.',
        tables: [
          makeTable({
            id: 'emerg03-rate-table',
            page: 32,
            headerContext: [
              'Attachment B',
              'UNIT RATE PRICE FORM DOT (EMERG03)',
              'Item and Place Pricing',
            ],
            rows: [
              [
                '1.',
                'Removal of Eligible Hazardous Trees Work consists of all labor, equipment, fuel, and associated costs necessary for the removal of eligible hazardous trees and placement on the ROW.',
                '$ Per Tree',
                '483.31',
                '313.27',
              ],
              [
                'A.',
                'Single Slope Operation Plan',
                '$ Per Tree',
                '483.31',
                '313.27',
              ],
              [
                'B.',
                'Chipping, reducing, and broadcasting tree debris generated on the ROW',
                '$ Per Tree',
                '1150.80',
                '1012.05',
              ],
            ],
          }),
        ],
      });

      const facts = normalized.primaryDocument.fact_map;
      const debug = (normalized.extracted.debug_contract ?? {}) as {
        detected_failure_modes?: string[] | null;
        selected_rate_table?: { id?: string; estimated_rate_row_count?: number | null } | null;
        rate_schedule_qualification?: {
          rate_schedule_present_reason?: string | null;
          rate_row_count_reason?: string | null;
          candidate_rate_table_count?: number | null;
          accepted_rate_table_count?: number | null;
          inline_unit_signal_detected?: boolean | null;
          price_column_count?: number | null;
          estimated_rate_row_count?: number | null;
          clin_detected?: boolean | null;
          money_column_detected?: boolean | null;
          title_alias_matches?: string[] | null;
          header_signal_matches?: string[] | null;
          unit_pattern_matches?: string[] | null;
          structural_rules_passed?: string[] | null;
          decision_explanation?: string | null;
        } | null;
      };

      assert.equal(facts.rate_schedule_present?.value, true);
      assert.equal(facts.rate_row_count?.value, 3);
      assert.equal(facts.rate_schedule_pages?.value, 'page 32');
      assert.equal(debug.selected_rate_table?.id, 'emerg03-rate-table');
      assert.equal(debug.selected_rate_table?.estimated_rate_row_count, 3);
      assert.equal(debug.rate_schedule_qualification?.rate_schedule_present_reason, 'accepted_rate_tables_present');
      assert.equal(debug.rate_schedule_qualification?.rate_row_count_reason, 'sum_estimated_rows_of_qualified_rate_tables');
      assert.equal(debug.rate_schedule_qualification?.candidate_rate_table_count, 1);
      assert.equal(debug.rate_schedule_qualification?.accepted_rate_table_count, 1);
      assert.equal(debug.rate_schedule_qualification?.inline_unit_signal_detected, true);
      assert.equal(debug.rate_schedule_qualification?.price_column_count, 2);
      assert.equal(debug.rate_schedule_qualification?.estimated_rate_row_count, 3);
      assert.equal(debug.rate_schedule_qualification?.clin_detected, false);
      assert.equal(debug.rate_schedule_qualification?.money_column_detected, true);
      assert.ok((debug.rate_schedule_qualification?.title_alias_matches ?? []).includes('rateSchedules.titleAliases.unitRatePriceForm'));
      assert.ok((debug.detected_failure_modes ?? []).includes('rateSchedules.titleAliases.unitRatePriceForm'));
      assert.match(debug.rate_schedule_qualification?.decision_explanation ?? '', /^table detected because /);
    } finally {
      if (previousDebug === undefined) {
        delete process.env.EIGHTFORGE_DEBUG_CONTRACT;
      } else {
        process.env.EIGHTFORGE_DEBUG_CONTRACT = previousDebug;
      }
    }
  });

  it('accepts alternate header aliases without changing existing contract behavior', () => {
    const normalized = normalizeContractFromTables({
      textPreview: 'Attachment A pricing schedule.',
      tables: [
        makeTable({
          id: 'alias-rate-table',
          page: 11,
          headerContext: ['ATTACHMENT A', 'PRICING SCHEDULE'],
          headers: ['Pay Item', 'Work Activity', 'UOM', 'Unit Rate'],
          rows: [
            ['A1', 'Emergency Debris Monitoring', 'HR', '125.00'],
            ['A2', 'Load Site Supervision', 'DAY', '950.00'],
          ],
        }),
      ],
    });

    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.rate_schedule_present?.value, true);
    assert.equal(facts.rate_row_count?.value, 2);
    assert.equal(facts.rate_schedule_pages?.value, 'page 11');
    const shadow = normalized.extracted.canonicalContractRateScheduleAssembly as Record<string, unknown>;
    assert.ok(shadow);
    assert.equal(shadow.schedule_kind, 'price_sheet');
    assert.equal((shadow.rows as unknown[]).length, 2);
  });

  it('accepts schedule of values tables through the shared registry aliases', () => {
    const previousDebug = process.env.EIGHTFORGE_DEBUG_CONTRACT;
    process.env.EIGHTFORGE_DEBUG_CONTRACT = '1';

    try {
      const normalized = normalizeContractFromTables({
        textPreview: 'Exhibit C schedule of values.',
        tables: [
          makeTable({
            id: 'sov-rate-table',
            page: 14,
            headerContext: ['EXHIBIT C', 'SCHEDULE OF VALUES'],
            headers: ['Item', 'Description', 'Scheduled Value'],
            rows: [
              ['1', 'Mobilization', '$12,500.00'],
              ['2', 'Debris Loading', '$48,750.00'],
              ['3', 'Hauling', '$35,125.00'],
            ],
          }),
        ],
      });

      const facts = normalized.primaryDocument.fact_map;
      const debug = (normalized.extracted.debug_contract ?? {}) as {
        detected_failure_modes?: string[] | null;
        rate_schedule_qualification?: {
          title_alias_matches?: string[] | null;
          header_signal_matches?: string[] | null;
        } | null;
      };

      assert.equal(facts.rate_schedule_present?.value, true);
      assert.equal(facts.rate_row_count?.value, 3);
      assert.equal(facts.rate_schedule_pages?.value, 'page 14');
      assert.ok((debug.rate_schedule_qualification?.title_alias_matches ?? []).includes('rateSchedules.titleAliases.scheduleOfValues'));
      assert.ok((debug.rate_schedule_qualification?.header_signal_matches ?? []).includes('rateSchedules.headerSignals.scheduledValue'));
      assert.ok((debug.detected_failure_modes ?? []).includes('rateSchedules.titleAliases.scheduleOfValues'));
    } finally {
      if (previousDebug === undefined) {
        delete process.env.EIGHTFORGE_DEBUG_CONTRACT;
      } else {
        process.env.EIGHTFORGE_DEBUG_CONTRACT = previousDebug;
      }
    }
  });

  it('accepts CLIN-style contract price schedules even when the word rate is absent', () => {
    const previousDebug = process.env.EIGHTFORGE_DEBUG_CONTRACT;
    process.env.EIGHTFORGE_DEBUG_CONTRACT = '1';

    try {
      const normalized = normalizeContractFromTables({
        textPreview: 'Attachment D contract price schedule.',
        tables: [
          makeTable({
            id: 'clin-price-schedule',
            page: 21,
            headerContext: ['ATTACHMENT D', 'CONTRACT PRICE SCHEDULE'],
            headers: ['CLIN', 'Description', 'Qty', 'Unit Price', 'Total'],
            rows: [
              ['0001', 'Tree removal', '12', '$483.31', '$5,799.72'],
              ['0002', 'Debris hauling', '8', '$313.27', '$2,506.16'],
              ['0003', 'Stump grinding', '4', '$150.00', '$600.00'],
            ],
          }),
        ],
      });

      const facts = normalized.primaryDocument.fact_map;
      const debug = (normalized.extracted.debug_contract ?? {}) as {
        rate_schedule_qualification?: {
          clin_detected?: boolean | null;
          title_alias_matches?: string[] | null;
          header_signal_matches?: string[] | null;
          decision_explanation?: string | null;
        } | null;
      };

      assert.equal(facts.rate_schedule_present?.value, true);
      assert.equal(facts.rate_row_count?.value, 3);
      assert.equal(facts.rate_schedule_pages?.value, 'page 21');
      assert.equal(debug.rate_schedule_qualification?.clin_detected, true);
      assert.ok((debug.rate_schedule_qualification?.title_alias_matches ?? []).includes('rateSchedules.titleAliases.contractPriceSchedule'));
      assert.ok((debug.rate_schedule_qualification?.header_signal_matches ?? []).includes('rateSchedules.headerSignals.CLIN'));
      assert.match(debug.rate_schedule_qualification?.decision_explanation ?? '', /CLIN header matched/i);
    } finally {
      if (previousDebug === undefined) {
        delete process.env.EIGHTFORGE_DEBUG_CONTRACT;
      } else {
        process.env.EIGHTFORGE_DEBUG_CONTRACT = previousDebug;
      }
    }
  });

  it('does not promote generic schedule-like tables without a money column', () => {
    const normalized = normalizeContractFromTables({
      textPreview: 'Exhibit C schedule of values draft quantities.',
      tables: [
        makeTable({
          id: 'sov-no-money-table',
          page: 15,
          headerContext: ['EXHIBIT C', 'SCHEDULE OF VALUES'],
          headers: ['Item', 'Description', 'Quantity'],
          rows: [
            ['1', 'Tree removal', '12'],
            ['2', 'Debris hauling', '8'],
            ['3', 'Stump grinding', '4'],
          ],
        }),
      ],
    });

    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.rate_schedule_present?.value, false);
    assert.equal(facts.rate_row_count?.value, 0);
    assert.equal(facts.rate_schedule_pages?.value, null);
    assert.equal(normalized.extracted.canonicalContractRateScheduleAssembly, undefined);
  });

  it('rejects noisy tables and no longer treats any contract table as a rate schedule', () => {
    const normalized = normalizeContractFromTables({
      textPreview: 'General contract provisions only.',
      tables: [
        makeTable({
          id: 'noisy-summary-table',
          page: 4,
          headerContext: ['EQUIPMENT SUMMARY'],
          headers: ['Description', 'Unit Price', 'Total'],
          rows: [
            ['Mobilization', '$1,200.00', '$1,200.00'],
            ['Fence Repair', '$850.00', '$850.00'],
          ],
        }),
      ],
    });

    const facts = normalized.primaryDocument.fact_map;
    assert.equal(facts.rate_schedule_present?.value, false);
    assert.equal(facts.rate_row_count?.value, 0);
    assert.equal(facts.rate_schedule_pages?.value, null);
    assert.equal(normalized.extracted.canonicalContractRateScheduleAssembly, undefined);
  });

  it('does not warn when invoice parser unit is null and shadow assembler infers narrative ROW', () => {
    const normalized = normalizeInvoiceFromTables({
      typedFields: {
        invoice_number: '2026-unit-null',
        line_items: [
          {
            line_code: '1A',
            line_description: 'ROW clearing',
            quantity: 10,
            unit: null,
            unit_price: 5,
            line_total: 50,
          },
        ],
      },
      tables: [
        makeTable({
          id: 'invoice-lines',
          page: 1,
          headers: ['Code', 'Description', 'Quantity', 'Unit Price', 'Total'],
          rows: [
            ['1A', 'ROW clearing', '10', '5.00', '50.00'],
          ],
        }),
      ],
    });

    const assembly = normalized.extracted.canonicalOperationalTableRowAssembly as {
      assembly_warnings?: string[];
      rows?: Array<{ unit?: string }>;
    };
    assert.equal(assembly.rows?.[0]?.unit, 'ROW');
    assert.ok(!(assembly.assembly_warnings ?? []).some((warning) => warning.includes('1A.unit')));
  });

  it('still warns when invoice parser and shadow assembler have explicit conflicting units', () => {
    const normalized = normalizeInvoiceFromTables({
      typedFields: {
        invoice_number: '2026-unit-conflict',
        line_items: [
          {
            line_code: '1A',
            line_description: 'ROW clearing',
            quantity: 10,
            unit: 'EA',
            unit_price: 5,
            line_total: 50,
          },
        ],
      },
      tables: [
        makeTable({
          id: 'invoice-lines',
          page: 1,
          headers: ['Code', 'Description', 'Quantity', 'Unit Price', 'Total'],
          rows: [
            ['1A', 'ROW clearing', '10', '5.00', '50.00'],
          ],
        }),
      ],
    });

    const assembly = normalized.extracted.canonicalOperationalTableRowAssembly as {
      assembly_warnings?: string[];
    };
    assert.ok((assembly.assembly_warnings ?? []).some((warning) =>
      warning.includes('assembler mismatch for 1A.unit: existing=ea assembled=row')));
  });

  it('keeps Williamson 2026-002 invoice shadow assembly on canonical invoice lines', () => {
    const normalized = normalizeInvoiceFromTables({
      typedFields: {
        invoice_number: '2026-002',
        line_items: [
          {
            line_code: '1A',
            line_description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
            quantity: 43894,
            unit_price: 6.9,
            line_total: 302868.6,
            raw_text: '1A- Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15 43,894.00 $6.90$302,868.60',
          },
          {
            line_code: '1B',
            line_description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30',
            quantity: 12250,
            unit_price: 7.9,
            line_total: 96775,
            raw_text: '1B - Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30 12,250.00 $7.90$96,775.00',
          },
          {
            line_code: '1E',
            line_description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to',
            quantity: 3099,
            unit_price: 13.5,
            line_total: 41836.5,
            raw_text: '1E - Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 3,099.00 $13.50$41,836.50',
          },
          {
            line_code: '1F',
            line_description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to',
            quantity: 916,
            unit_price: 14.5,
            line_total: 13282,
            raw_text: '1F - Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 916.00 $14.50$13,282.00',
          },
          {
            line_code: '5A',
            line_description: 'Tree Operations Hazardous Tree Removal 6-12 in',
            quantity: 5,
            unit_price: 95,
            line_total: 475,
            raw_text: '5A - Tree Operations Hazardous Tree Removal 6-12 in 5.00 $95.00$475.00',
          },
          {
            line_code: '6A',
            line_description: 'Tree Operations Hazardous Hanging Limb Removal>2"per tree',
            quantity: 994,
            unit_price: 80,
            line_total: 79520,
            raw_text: '6A-TreeOperationsHazardousHangingLimbRemoval>2"per tree 994 $80.00$79,520.00',
          },
        ],
      },
      tables: [
        makeTable({
          id: 'regressed-pdf-table',
          page: 1,
          rows: [
            ['$6.90 Neighborhoods ROW to DMS 0 to 15', '0', 'ROW', '15', '$302,868.60'],
            ['$7.90 Neighborhoods ROW to DMS 16 to 30', '16', 'ROW', '30', '$96,775.00'],
          ],
        }),
      ],
    });

    const assembly = normalized.extracted.canonicalOperationalTableRowAssembly as {
      rows?: Array<{ rate_code?: string; unit_price?: number; evidence_refs?: unknown[] }>;
    };
    assert.deepEqual(
      assembly.rows?.map((row) => [row.rate_code, row.unit_price]),
      [
        ['1A', 6.9],
        ['1B', 7.9],
        ['1E', 13.5],
        ['1F', 14.5],
        ['5A', 95],
        ['6A', 80],
      ],
    );
    assert.ok(assembly.rows?.every((row) => (row.evidence_refs ?? []).length > 0));
  });

  it('keeps Williamson 2026-003 invoice shadow assembly on canonical invoice lines', () => {
    const normalized = normalizeInvoiceFromTables({
      typedFields: {
        invoice_number: '2026-003',
        line_items: [
          {
            line_code: '2A',
            line_description: 'Management Reduction Preparation Management Segregating Material at DMS',
            quantity: 70496,
            unit_price: 1.5,
            line_total: 105744,
            raw_text: '2A - Management Reduction Preparation Management Segregating Material at DMS 70,496.00 $1.50$105,744.00',
          },
          {
            line_code: '2B',
            line_description: 'Management Reduction Grinding Chipping Vegetative Debris',
            quantity: 70496,
            unit_price: 2.25,
            line_total: 158616,
            raw_text: '2B - Management Reduction Grinding Chipping Vegetative Debris 70,496.00 $2.25$158,616.00',
          },
          {
            line_code: '3B',
            line_description: 'Final Disposal Mulch DMS to FDS 16-30 miles',
            quantity: 2144,
            unit_price: 3.75,
            line_total: 8040,
            raw_text: '3B - Final Disposal Mulch DMS to FDS 16-30 miles 2,144.00$3.75$8,040.00',
          },
          {
            line_code: '3C',
            line_description: 'Final Disposal Mulch DMS to FDS 31-60 miles',
            quantity: 1977,
            unit_price: 4.25,
            line_total: 8402.25,
            raw_text: '3C - Final Disposal Mulch DMS to FDS 31-60 miles 1,977.00 $4.25$8,402.25',
          },
        ],
      },
      tables: [
        makeTable({
          id: 'merged-pdf-table',
          page: 1,
          rows: [
            ['$105,744.00 Segregating Material at DMS 70,496.00 2B - Management Reduction Grinding Chipping Vegetative Debris $2.25 $158,616.00'],
            ['2,144.00 3B - Final Disposal Mulch DMS to FDS 16-30 miles'],
          ],
        }),
      ],
    });

    const assembly = normalized.extracted.canonicalOperationalTableRowAssembly as {
      rows?: Array<{ rate_code?: string; unit_price?: number; evidence_refs?: unknown[] }>;
    };
    assert.deepEqual(
      assembly.rows?.map((row) => [row.rate_code, row.unit_price]),
      [
        ['2A', 1.5],
        ['2B', 2.25],
        ['3B', 3.75],
        ['3C', 4.25],
      ],
    );
    assert.ok(assembly.rows?.every((row) => (row.evidence_refs ?? []).length > 0));
  });

  it('builds cross-document rate diff only from persisted assembly diagnostics', () => {
    const normalized = normalizeInvoiceFromPersistedDiagnostics();
    const diff = normalized.extracted.canonicalOperationalRateDiff as {
      invoice_document_id?: string;
      contract_document_id?: string;
      rows?: Array<{
        invoice_row_id?: string;
        contract_row_id?: string | null;
        variance_status?: string;
        variance?: number | null;
        match_reasons?: string[];
        invoice_evidence_refs?: unknown[];
        contract_evidence_refs?: unknown[];
      }>;
      summary?: { rows_exceeding_contract_ceiling?: number };
    };

    assert.equal(diff.invoice_document_id, 'invoice-diff-test');
    assert.equal(diff.contract_document_id, 'contract-diff-test');
    assert.equal(diff.rows?.[0]?.invoice_row_id, 'invoice:r1');
    assert.equal(diff.rows?.[0]?.contract_row_id, 'contract:r1');
    assert.equal(diff.rows?.[0]?.variance_status, 'exceeds_ceiling');
    assert.equal(diff.rows?.[0]?.variance, 0.35);
    assert.ok((diff.rows?.[0]?.match_reasons ?? []).some((reason) => reason.includes('unit compatible')));
    assert.ok((diff.rows?.[0]?.invoice_evidence_refs ?? []).length > 0);
    assert.ok((diff.rows?.[0]?.contract_evidence_refs ?? []).length > 0);
    assert.equal(diff.summary?.rows_exceeding_contract_ceiling, 1);
  });
});
