import { describe, expect, it } from 'vitest';

import type { TransactionDataProjectOperationsOverview, TransactionDataRecord } from '@/lib/types/transactionData';
import type { ValidationFinding } from '@/types/validator';
import {
  buildSpreadsheetFactWorkspaceDatasetSummary,
  normalizeSpreadsheetEligibility,
  resolveTicketOverrideTargetId,
} from './spreadsheetDocumentReview';

function buildFinding(
  overrides: Partial<ValidationFinding> = {},
): ValidationFinding {
  return {
    id: 'finding-1',
    run_id: 'run-1',
    project_id: 'project-1',
    rule_id: 'ticket_integrity',
    check_key: 'ticket_integrity:missing_invoice',
    category: 'ticket_integrity',
    severity: 'warning',
    status: 'open',
    subject_type: 'transaction_row',
    subject_id: 'transaction:sheet-1:12',
    field: null,
    expected: null,
    actual: null,
    variance: null,
    variance_unit: null,
    blocked_reason: null,
    decision_eligible: false,
    action_eligible: false,
    linked_decision_id: null,
    linked_action_id: null,
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: '2026-04-13T00:00:00Z',
    updated_at: '2026-04-13T00:00:00Z',
    ...overrides,
  };
}

function buildOps(
  overrides: Partial<TransactionDataProjectOperationsOverview> = {},
): TransactionDataProjectOperationsOverview {
  return {
    project_name: 'Storm Debris Cleanup',
    total_tickets: 12,
    total_transaction_quantity: 120,
    total_cyd: 64,
    total_invoiced_amount: 2500,
    distinct_invoice_count: 2,
    invoiced_ticket_count: 2,
    uninvoiced_line_count: 0,
    eligible_count: 2,
    ineligible_count: 0,
    distinct_service_item_count: 1,
    distinct_material_count: 1,
    distinct_site_type_count: 1,
    distinct_disposal_site_count: 1,
    reviewed_sheet_names: ['ticket_query'],
    record_ids: ['row-1', 'row-2'],
    evidence_refs: [],
    ...overrides,
  };
}

function buildRecord(
  overrides: Partial<TransactionDataRecord> = {},
): TransactionDataRecord {
  return {
    id: 'row-1',
    transaction_number: 'TX-1001',
    invoice_number: 'INV-100',
    invoice_date: null,
    invoice_status: null,
    invoice_line_amount: null,
    transaction_date: null,
    ticket_date: null,
    ticket_type: null,
    load_number: null,
    load_description: null,
    driver_name: null,
    truck_id: null,
    trailer_id: null,
    truck_type: null,
    ticket_notes: null,
    service_item: null,
    material: null,
    disposal_site: null,
    site_type: null,
    disposal_location: null,
    final_disposition: null,
    eligibility: null,
    source_document_id: null,
    source_document_name: null,
    source_sheet_name: 'ticket_query',
    source_row_number: 3,
    source_columns: [],
    billing_rate_key: null,
    billing_type: null,
    rate_code: null,
    rate_description: null,
    transaction_quantity: null,
    transaction_unit: null,
    transaction_rate: null,
    extended_cost: null,
    mileage: null,
    cyd: null,
    net_tonnage: null,
    raw_row: {},
    evidence_refs: [],
    ...overrides,
  };
}

describe('spreadsheet document review ticket overrides', () => {
  it('uses the transaction row subject id when evidence rows are absent', () => {
    const finding = buildFinding();

    expect(resolveTicketOverrideTargetId(finding, [])).toBe('transaction:sheet-1:12');
  });

  it('suppresses ticket overrides when a finding spans multiple records', () => {
    const finding = buildFinding({
      subject_type: 'invoice_rate_group',
      subject_id: 'INV-001|RATE-A',
    });

    expect(resolveTicketOverrideTargetId(finding, [
      { record_id: 'transaction:sheet-1:12' },
      { record_id: 'transaction:sheet-1:13' },
    ])).toBeNull();
  });
});

describe('buildSpreadsheetFactWorkspaceDatasetSummary', () => {
  it('maps spreadsheet eligibility variants deterministically', () => {
    expect(normalizeSpreadsheetEligibility('Eligible')).toBe('eligible');
    expect(normalizeSpreadsheetEligibility('in scope')).toBe('eligible');
    expect(normalizeSpreadsheetEligibility('In_Scope')).toBe('eligible');
    expect(normalizeSpreadsheetEligibility('IN-SCOPE')).toBe('eligible');

    expect(normalizeSpreadsheetEligibility('Ineligible')).toBe('ineligible');
    expect(normalizeSpreadsheetEligibility('out of scope')).toBe('ineligible');
    expect(normalizeSpreadsheetEligibility('out_of_scope')).toBe('ineligible');
    expect(normalizeSpreadsheetEligibility('OUT-OF-SCOPE')).toBe('ineligible');
    expect(normalizeSpreadsheetEligibility('void')).toBe('ineligible');

    expect(normalizeSpreadsheetEligibility(null)).toBe('ineligible');
    expect(normalizeSpreadsheetEligibility('')).toBe('ineligible');
    expect(normalizeSpreadsheetEligibility('unset')).toBe('ineligible');
    expect(normalizeSpreadsheetEligibility('un_set')).toBe('ineligible');
    expect(normalizeSpreadsheetEligibility('pending review')).toBe('ineligible');
  });

  it('uses the shared spreadsheet eligibility mapping when deriving row-level eligibility totals', () => {
    const records = [
      buildRecord({
        id: 'row-1',
        transaction_number: 'TX-1001',
        eligibility: 'Eligible',
      }),
      buildRecord({
        id: 'row-2',
        transaction_number: 'TX-1002',
        eligibility: 'in_scope',
      }),
      buildRecord({
        id: 'row-3',
        transaction_number: 'TX-1003',
        eligibility: 'out-of-scope',
      }),
      buildRecord({
        id: 'row-4',
        transaction_number: 'TX-1004',
        eligibility: 'void',
      }),
      buildRecord({
        id: 'row-5',
        transaction_number: 'TX-1005',
        eligibility: 'unset',
      }),
      buildRecord({
        id: 'row-6',
        transaction_number: 'TX-1006',
        eligibility: 'pending review',
      }),
    ];

    const summary = buildSpreadsheetFactWorkspaceDatasetSummary({
      ops: null,
      records,
    });

    expect(summary).not.toBeNull();
    expect(summary?.eligible).toBe(2);
    expect(summary?.ineligible).toBe(4);
  });

  it('folds legacy unknown eligibility ops totals into the ineligible bucket', () => {
    const ops = {
      ...buildOps({
        eligible_count: 4,
        ineligible_count: 2,
      }),
      unknown_eligibility_count: 3,
    } as TransactionDataProjectOperationsOverview & {
      unknown_eligibility_count: number;
    };

    const summary = buildSpreadsheetFactWorkspaceDatasetSummary({
      ops,
      records: [],
    });

    expect(summary).not.toBeNull();
    expect(summary?.eligible).toBe(4);
    expect(summary?.ineligible).toBe(5);
  });

  it('prefers authoritative ops totals over row-derived ticket and net tonnage totals when both are present', () => {
    const ops = {
      ...buildOps({
        total_tickets: 5063,
      }),
      total_net_tonnage: 9876,
    } as TransactionDataProjectOperationsOverview & { total_net_tonnage: number };

    const records = [
      buildRecord({
        id: 'row-1',
        transaction_number: 'TX-1001',
        net_tonnage: 12,
      }),
      buildRecord({
        id: 'row-2',
        transaction_number: 'TX-1002',
        net_tonnage: 15,
      }),
    ];

    const summary = buildSpreadsheetFactWorkspaceDatasetSummary({
      ops,
      records,
    });

    expect(summary).not.toBeNull();
    expect(summary?.totalTickets).toBe(5063);
    expect(summary?.totalNetTonnage).toBe(9876);
    expect(summary?.invoicedTickets).toBe(2);
    expect(summary?.totalInvoices).toBe(2);
  });

  it('falls back to row-derived totals when ops-level ticket or net tonnage totals are absent', () => {
    const records = [
      buildRecord({
        id: 'row-1',
        transaction_number: 'TX-1001',
        net_tonnage: 12,
      }),
      buildRecord({
        id: 'row-2',
        transaction_number: 'TX-1002',
        net_tonnage: 15,
      }),
      buildRecord({
        id: 'row-3',
        transaction_number: 'TX-1002',
        net_tonnage: null,
      }),
    ];

    const summary = buildSpreadsheetFactWorkspaceDatasetSummary({
      ops: null,
      records,
    });

    expect(summary).not.toBeNull();
    expect(summary?.totalTickets).toBe(2);
    expect(summary?.totalNetTonnage).toBe(27);
  });
});
