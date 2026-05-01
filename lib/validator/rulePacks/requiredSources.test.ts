import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { runRequiredSourcesRules } from '@/lib/validator/rulePacks/requiredSources';
import type {
  ProjectTotals,
  ProjectValidatorInput,
  ValidatorDocumentIdsByFamily,
  ValidatorFactLookups,
  ValidatorProjectRow,
  ValidatorProjectTransactionData,
} from '@/lib/validator/shared';

const PROJECT_ID = 'project-1';

function buildInput(
  transactionData: ValidatorProjectTransactionData,
  overrides: Partial<Pick<ProjectValidatorInput, 'validationPhase'>> = {},
): ProjectValidatorInput {
  const project: ValidatorProjectRow = {
    id: PROJECT_ID,
    organization_id: 'org-1',
    name: 'Williamson project',
    code: 'WIL-1',
  };

  const familyDocumentIds: ValidatorDocumentIdsByFamily = {
    contract: ['contract-doc-1'],
    rate_sheet: [],
    permit: [],
    invoice: [],
    ticket_support: [],
  };

  const factLookups: ValidatorFactLookups = {
    contractProjectCodeFacts: [],
    invoiceProjectCodeFacts: [],
    contractPartyNameFacts: [],
    nteFact: null,
    contractDocumentId: 'contract-doc-1',
    contractCeilingTypeFact: null,
    contractCeilingType: 'rate_based',
    rateSchedulePresentFact: null,
    rateSchedulePresent: true,
    rateRowCountFact: null,
    rateRowCount: 1,
    rateSchedulePagesFact: null,
    rateSchedulePagesDisplay: 'page 7',
    rateUnitsDetectedFact: null,
    rateUnitsDetected: ['cubic yard'],
    timeAndMaterialsPresentFact: null,
    timeAndMaterialsPresent: false,
    rateScheduleFacts: [],
    rateScheduleItems: [],
    hasRateScheduleFacts: true,
  };

  const projectTotals: ProjectTotals = {
    billed_total: null,
    invoice_count: 0,
    invoice_line_count: 0,
    mobile_ticket_count: 0,
    load_ticket_count: 0,
  };

  return {
    project,
    validationPhase: overrides.validationPhase ?? 'contract_setup',
    documents: [],
    documentRelationships: [],
    precedenceFamilies: [],
    familyDocumentIds,
    governingDocumentIds: familyDocumentIds,
    truthCategoryDocumentIds: {
      contract_identity: ['contract-doc-1'],
      pricing: [],
      compliance: [],
      amendments: [],
    },
    ruleStateByRuleId: new Map(),
    factsByDocumentId: new Map(),
    allFacts: [],
    mobileTickets: [],
    loadTickets: [],
    invoices: [],
    invoiceLines: [],
    mobileToLoadsMap: new Map(),
    invoiceLineToRateMap: new Map(),
    projectTotals,
    factLookups,
    contractValidationContext: null,
    transactionData,
    reconciliationContext: null,
  };
}

describe('required source validator rules', () => {
  it('detects canonical transaction datasets as ticket-like project truth', () => {
    const findings = runRequiredSourcesRules(
      buildInput({
        datasets: [
          {
            id: 'dataset-1',
            document_id: 'tx-doc-1',
            project_id: PROJECT_ID,
            row_count: 5063,
            total_extended_cost: 815559,
            total_transaction_quantity: 215729,
            date_range_start: '2026-02-23',
            date_range_end: '2026-03-22',
            summary_json: {
              project_operations_overview: {
                total_tickets: 2388,
                total_cyd: 215729,
                total_invoiced_amount: 815559,
              },
            },
            created_at: '2026-04-24T10:00:00Z',
          },
        ],
        rows: [],
        rollups: {
          grouped_by_rate_code: [],
          grouped_by_invoice: [],
          grouped_by_site_material: [],
        },
      }),
    );

    assert.equal(
      findings.some((finding) => finding.rule_id === 'SOURCES_NO_TICKET_DATA'),
      false,
    );
  });

  it('does not fire the missing ticket-data finding when canonical transaction rows exist', () => {
    const findings = runRequiredSourcesRules(
      buildInput({
        datasets: [],
        rows: [
          {
            id: 'row-1',
            document_id: 'tx-doc-1',
            project_id: PROJECT_ID,
            invoice_number: 'INV-100',
            transaction_number: 'TX-1001',
            rate_code: 'RC-01',
            billing_rate_key: 'RC01',
            description_match_key: 'debris hauling',
            site_material_key: 's:alpha landfill|m:vegetative',
            invoice_rate_key: 'INV100::RC01',
            transaction_quantity: 10,
            extended_cost: 100.5,
            invoice_date: '2026-03-15',
            source_sheet_name: 'ticket_query',
            source_row_number: 3,
            record_json: {
              invoice_number: 'INV-100',
              transaction_number: 'TX-1001',
            },
            raw_row_json: {
              'Invoice #': 'INV-100',
            },
            created_at: '2026-04-24T10:00:00Z',
          },
        ],
        rollups: {
          grouped_by_rate_code: [],
          grouped_by_invoice: [],
          grouped_by_site_material: [],
        },
      }),
    );

    assert.equal(
      findings.some((finding) => finding.rule_id === 'SOURCES_NO_TICKET_DATA'),
      false,
    );
  });

  it('does not block contract setup when ticket data is not expected yet', () => {
    const findings = runRequiredSourcesRules(
      buildInput({
        datasets: [],
        rows: [],
        rollups: {
          grouped_by_rate_code: [],
          grouped_by_invoice: [],
          grouped_by_site_material: [],
        },
      }, {
        validationPhase: 'contract_setup',
      }),
    );

    assert.equal(
      findings.some((finding) => finding.rule_id === 'SOURCES_NO_TICKET_DATA'),
      false,
    );
  });

  it('blocks billing review when ticket data is missing', () => {
    const findings = runRequiredSourcesRules(
      buildInput({
        datasets: [],
        rows: [],
        rollups: {
          grouped_by_rate_code: [],
          grouped_by_invoice: [],
          grouped_by_site_material: [],
        },
      }, {
        validationPhase: 'billing_review',
      }),
    );

    assert.equal(
      findings.some((finding) => finding.rule_id === 'SOURCES_NO_TICKET_DATA'),
      true,
    );
  });
});
