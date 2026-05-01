import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'vitest';

import type { SpreadsheetReviewDataset } from '@/lib/documentIntelligenceViewModel';
import { SpreadsheetReviewSurface } from '@/components/document-intelligence/SpreadsheetReviewSurface';

function buildDataset(
  overrides: Partial<SpreadsheetReviewDataset> = {},
): SpreadsheetReviewDataset {
  return {
    records: [],
    summary: null,
    rollups: null,
    projectOperationsOverview: null,
    groupedByRateCode: [],
    groupedByServiceItemMobileOnly: [],
    groupedByMaterialMobileOnly: [],
    groupedByDisposalSite: [],
    groupedBySiteType: [],
    outlierRows: [],
    invoiceReadinessSummary: null,
    dmsFdsLifecycleSummary: null,
    kpis: {
      totalTickets: 12,
      totalCyd: 64,
      totalNetTonnage: null,
      invoicedTickets: 10,
      totalInvoices: 4,
      totalInvoicedAmount: 12000,
      uninvoicedLines: 2,
      eligible: 8,
      ineligible: 2,
    },
    totalExtendedCost: 12000,
    volumeBasis: {
      metric: 'cyd',
      unitLabel: 'CYD',
      headerLabel: 'Volume (CYD)',
    },
    rateCodeRows: [],
    serviceItemRows: [],
    materialRows: [],
    disposalSiteRows: [],
    siteTypeRows: [],
    riskSummary: {
      highRiskIssues: 1,
      mediumRiskIssues: 1,
      lowRiskIssues: 0,
      ticketsAffected: 5,
      invoicesAffected: 2,
      estimatedAmountAtRisk: 3400,
    },
    groupedRiskIssues: [
      {
        issueType: 'Missing Invoice #',
        severity: 'Medium',
        ticketCount: 5,
        affectedTicketPreview: 'TK-1001, TK-1002, TK-1003 + 2 more',
        invoiceCount: 0,
        amountImpact: 3400,
        whyItMatters: 'Rows without an invoice link cannot be reconciled to a bill.',
        actionNeeded: 'Add or confirm the Invoice # before invoice review.',
      },
    ],
    riskDrilldownRows: [
      {
        ticketNumber: 'TK-9999',
        invoiceNumber: 'INV-999',
        issueType: 'Should Not Render',
        severity: 'Medium',
        materialOrServiceItem: 'Vegetative',
        site: 'Alpha DMS',
        amount: 99,
        reason: 'This row exists only to prove the drilldown section stays hidden.',
      },
    ],
    ...overrides,
  };
}

describe('SpreadsheetReviewSurface', () => {
  it('renders grouped issue ticket previews and omits the issue drilldown section', () => {
    const html = renderToStaticMarkup(
      createElement(SpreadsheetReviewSurface, { dataset: buildDataset() }),
    );

    assert.ok(html.includes('Grouped Issue Categories'));
    assert.ok(html.includes('Affected Ticket Numbers'));
    assert.ok(html.includes('TK-1001, TK-1002, TK-1003 + 2 more'));
    assert.ok(!html.includes('Issue Drilldown'));
    assert.ok(!html.includes('Should Not Render'));
  });

  it('renders explicit overview truth targets and transaction-based invoice readiness counts', () => {
    const html = renderToStaticMarkup(
      createElement(SpreadsheetReviewSurface, {
        dataset: buildDataset({
          summary: {
            row_count: 5063,
          } as SpreadsheetReviewDataset['summary'],
          kpis: {
            totalTickets: 2388,
            totalCyd: 64,
            totalNetTonnage: null,
            invoicedTickets: 10,
            totalInvoices: 2,
            totalInvoicedAmount: 815559.35,
            uninvoicedLines: 5061,
            eligible: 8,
            ineligible: 2,
          },
          totalExtendedCost: 815559.35,
          invoiceReadinessSummary: {
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
        }),
      }),
    );

    assert.ok(html.includes('Unique Ticket Numbers'));
    assert.ok(html.includes('Total Transaction Rows'));
    assert.ok(html.includes('Invoice Count'));
    assert.ok(html.includes('Workbook Invoiced Amount'));
    assert.ok(html.includes('2,388'));
    assert.ok(html.includes('5,063'));
    assert.ok(html.includes('$815,559.35'));
    assert.ok(html.includes('Invoiced Transaction Rows'));
    assert.ok(!html.includes('Eligibility Unresolved'));
    assert.ok(!html.includes('unknown eligibility'));
  });

  it('renders the cleaned up service item columns and uses an em dash when diameter units are missing', () => {
    const html = renderToStaticMarkup(
      createElement(SpreadsheetReviewSurface, {
        dataset: buildDataset({
          serviceItemRows: [
            {
              serviceItem: 'Load Monitoring',
              ticketCount: 1,
              eligibleTickets: 0,
              ineligibleTickets: 1,
              diameterUnits: null,
              amount: 200,
              percentOfTotalServiceCost: 100,
            },
          ],
        }),
      }),
    );

    assert.ok(html.includes('Unique Ticket Numbers'));
    assert.ok(html.includes('Diameter/Units'));
    assert.ok(!html.includes('<th class="px-4 py-3 font-semibold">Quantity</th>'));
    assert.ok(!html.includes('<th class="px-4 py-3 font-semibold">Unit</th>'));
    assert.ok(html.includes('Load Monitoring'));
    assert.ok(html.includes('<td class="px-4 py-3 text-[#F5F7FA]">—</td>'));
  });
  it('renders the exact spreadsheet evidence row and return paths when a validator target is selected', () => {
    const html = renderToStaticMarkup(
      createElement(SpreadsheetReviewSurface, {
        dataset: buildDataset({
          records: [
            {
              id: 'transaction:sheet-1:12',
              transaction_number: 'TK-1001',
              invoice_number: 'INV-100',
              invoice_date: '2026-03-22',
              rate_code: 'LC-1',
              rate_description: 'Load and haul',
              transaction_quantity: 5,
              transaction_rate: 125,
              extended_cost: 625,
              net_quantity: null,
              mileage: null,
              cyd: 14,
              net_tonnage: null,
              diameter: null,
              material: 'Vegetative',
              service_item: 'Haul',
              ticket_notes: null,
              eligibility: 'eligible',
              eligibility_internal_comments: null,
              eligibility_external_comments: null,
              load_latitude: null,
              load_longitude: null,
              disposal_latitude: null,
              disposal_longitude: null,
              project_name: 'Golden Project',
              billing_rate_key: 'rate:lc-1',
              description_match_key: 'load-and-haul',
              site_material_key: 'site:vegetative',
              invoice_rate_key: 'invoice:lc-1',
              source_sheet_name: 'Tickets',
              source_row_number: 12,
              raw_row: {},
            },
          ],
        }),
        selectedRecordId: 'transaction:sheet-1:12',
        navigationAction: 'review',
        decisionContextHref: '/platform/decisions/decision-1#decision-context',
        validatorHref: '/platform/projects/project-1#project-validator',
      }),
    );

    assert.ok(html.includes('Spreadsheet row transaction:sheet-1:12'));
    assert.ok(html.includes('Tickets row 12'));
    assert.ok(html.includes('Return to decision'));
    assert.ok(html.includes('Open validator'));
    assert.ok(html.includes('Load and haul'));
  });

  it('renders an explicit missing-evidence state when the selected spreadsheet row no longer exists', () => {
    const html = renderToStaticMarkup(
      createElement(SpreadsheetReviewSurface, {
        dataset: buildDataset(),
        selectedRecordId: 'transaction:sheet-9:404',
        navigationAction: 'manual_override',
        decisionContextHref: '/platform/decisions/decision-1#decision-context',
        validatorHref: '/platform/projects/project-1#project-validator',
      }),
    );

    assert.ok(html.includes('Exact spreadsheet row unavailable'));
    assert.ok(html.includes('transaction:sheet-9:404'));
    assert.ok(html.includes('The evidence link is not a dead end anymore'));
    assert.ok(html.includes('Return to decision'));
    assert.ok(html.includes('Open validator'));
  });
});
