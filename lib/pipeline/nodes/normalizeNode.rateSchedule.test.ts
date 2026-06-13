import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { extractNode } from '@/lib/pipeline/nodes/extractNode';
import { normalizeNode } from '@/lib/pipeline/nodes/normalizeNode';

function makeTableRow(params: {
  id: string;
  page: number;
  rowIndex: number;
  cells: string[];
}): Record<string, unknown> {
  return {
    id: params.id,
    page_number: params.page,
    row_index: params.rowIndex,
    cells: params.cells.map((text, index) => ({
      column_index: index,
      text,
    })),
    raw_text: params.cells.join(' | '),
  };
}

function makeTable(params: {
  id: string;
  page: number;
  headers?: string[];
  headerContext?: string[];
  rows: string[][];
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
  });
});
