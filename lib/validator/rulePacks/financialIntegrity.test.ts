import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { runFinancialIntegrityRules } from '@/lib/validator/rulePacks/financialIntegrity';
import type {
  InvoiceLineRow,
  ProjectValidatorInput,
  RateScheduleItem,
  ValidatorFindingResult,
} from '@/lib/validator/shared';

const CONTRACT_DOCUMENT_ID = 'contract-test';

function makeRateItem(overrides: Partial<RateScheduleItem> = {}): RateScheduleItem {
  return {
    source_document_id: CONTRACT_DOCUMENT_ID,
    record_id: 'rate-row-test',
    rate_code: 'LABOR',
    unit_type: 'HR',
    rate_amount: 80,
    material_type: null,
    description: 'Contract schedule description',
    source_category: 'Labor',
    canonical_category: 'labor',
    category_confidence: 0.9,
    raw_value: {},
    ...overrides,
  };
}

function buildInput(
  invoiceLine: InvoiceLineRow,
  scheduleItem: RateScheduleItem | null,
): ProjectValidatorInput {
  const familyDocumentIds = {
    contract: [CONTRACT_DOCUMENT_ID],
    rate_sheet: [],
    permit: [],
    invoice: [],
    ticket_support: [],
  };

  return {
    project: {
      id: 'project-test',
      organization_id: 'organization-test',
      name: 'Financial integrity evidence test',
      code: 'PROJECT-TEST',
    },
    validationPhase: 'billing_review',
    documents: [],
    documentRelationships: [],
    precedenceFamilies: [],
    familyDocumentIds,
    governingDocumentIds: familyDocumentIds,
    truthCategoryDocumentIds: {
      contract_identity: [CONTRACT_DOCUMENT_ID],
      pricing: [CONTRACT_DOCUMENT_ID],
      compliance: [],
      amendments: [],
    },
    ruleStateByRuleId: new Map(),
    factsByDocumentId: new Map(),
    allFacts: [],
    mobileTickets: [],
    loadTickets: [],
    invoices: [],
    invoiceLines: [invoiceLine],
    mobileToLoadsMap: new Map(),
    invoiceLineToRateMap: new Map([[String(invoiceLine.id), scheduleItem]]),
    projectTotals: {
      billed_total: null,
      invoice_count: 1,
      invoice_line_count: 1,
      mobile_ticket_count: 0,
      load_ticket_count: 0,
    },
    factLookups: {
      contractProjectCodeFacts: [],
      invoiceProjectCodeFacts: [],
      contractPartyNameFacts: [],
      contractIdentityDocumentIds: [CONTRACT_DOCUMENT_ID],
      pricingContextDocumentIds: [CONTRACT_DOCUMENT_ID],
      complianceContextDocumentIds: [],
      amendmentContextDocumentIds: [],
      nteFact: null,
      contractDocumentId: CONTRACT_DOCUMENT_ID,
      contractCeilingTypeFact: null,
      contractCeilingType: 'rate_based',
      rateSchedulePresentFact: null,
      rateSchedulePresent: true,
      rateRowCountFact: null,
      rateRowCount: 12,
      rateSchedulePagesFact: null,
      rateSchedulePagesDisplay: 'page 1',
      rateUnitsDetectedFact: null,
      rateUnitsDetected: ['hour'],
      timeAndMaterialsPresentFact: null,
      timeAndMaterialsPresent: true,
      rateScheduleFacts: [],
      rateScheduleItems: scheduleItem ? [scheduleItem] : [],
      hasRateScheduleFacts: scheduleItem != null,
    },
    contractValidationContext: null,
  };
}

function findingFor(
  input: ProjectValidatorInput,
  ruleId: string,
): ValidatorFindingResult {
  const finding = runFinancialIntegrityRules(input).find(
    (candidate) => candidate.rule_id === ruleId,
  );
  assert.ok(finding);
  return finding;
}

function invoiceLineEvidenceValues(finding: ValidatorFindingResult) {
  return Object.fromEntries(
    finding.evidence
      .filter((entry) => entry.evidence_type === 'invoice_line')
      .map((entry) => [entry.field_name, entry.field_value]),
  );
}

const enrichedBusinessFields = {
  invoice_number: 'INV-TEST-42',
  description: 'Emergency hauling',
  quantity: '12.5',
  unit_price: '80',
  line_total: '1000',
};

describe('financial integrity invoice-line evidence', () => {
  it('enriches FINANCIAL_RATE_CODE_MISSING from the invoice row without duplicate field names', () => {
    const finding = findingFor(
      buildInput({
        id: 'line-missing-code',
        invoice_no: 'INV-TEST-42',
        description: 'Emergency hauling',
        billed_quantity: 12.5,
        unit_price: 80,
        extended_cost: 1000,
        unit_type: 'Hour',
        canonical_category: 'labor',
        category_confidence: 0.9,
      }, null),
      'FINANCIAL_RATE_CODE_MISSING',
    );
    const invoiceEvidence = finding.evidence.filter(
      (entry) => entry.evidence_type === 'invoice_line',
    );

    assert.deepEqual(invoiceLineEvidenceValues(finding), {
      ...enrichedBusinessFields,
      rate_code: null,
    });
    assert.equal(
      new Set(invoiceEvidence.map((entry) => entry.field_name)).size,
      invoiceEvidence.length,
    );
    assert.deepEqual(
      {
        severity: finding.severity,
        status: finding.status,
        decision_eligible: finding.decision_eligible,
        action_eligible: finding.action_eligible,
        expected: finding.expected,
        actual: finding.actual,
      },
      {
        severity: 'warning',
        status: 'open',
        decision_eligible: false,
        action_eligible: false,
        expected: 'invoice line rate code',
        actual: 'missing',
      },
    );
  });

  it('preserves informational missing-rate-code outputs while enriching its invoice evidence', () => {
    const finding = findingFor(
      buildInput({
        id: 'line-informational',
        invoice_no: 'INV-TEST-42',
        description: 'Emergency hauling',
        billed_quantity: 12.5,
        unit_price: 80,
        extended_cost: 1000,
        unit_type: 'Hour',
        canonical_category: 'labor',
        category_confidence: 0.9,
      }, makeRateItem({ description: 'Emergency hauling' })),
      'FINANCIAL_RATE_CODE_MISSING',
    );

    assert.deepEqual(invoiceLineEvidenceValues(finding), {
      ...enrichedBusinessFields,
      rate_code: null,
    });
    assert.deepEqual(
      {
        severity: finding.severity,
        status: finding.status,
        decision_eligible: finding.decision_eligible,
        action_eligible: finding.action_eligible,
        expected: finding.expected,
        actual: finding.actual,
      },
      {
        severity: 'info',
        status: 'open',
        decision_eligible: false,
        action_eligible: false,
        expected: 'invoice line rate code',
        actual: 'missing',
      },
    );
  });

  it('enriches FINANCIAL_UNIT_TYPE_MISMATCH from the same invoice row', () => {
    const finding = findingFor(
      buildInput({
        id: 'line-unit-mismatch',
        invoice_no: 'INV-TEST-42',
        rate_code: 'LABOR',
        description: 'Emergency hauling',
        billed_quantity: 12.5,
        unit_price: 80,
        extended_cost: 1000,
        unit_type: 'CY',
      }, makeRateItem()),
      'FINANCIAL_UNIT_TYPE_MISMATCH',
    );

    assert.deepEqual(invoiceLineEvidenceValues(finding), {
      ...enrichedBusinessFields,
      unit_type: 'CY',
    });
    assert.deepEqual(
      {
        severity: finding.severity,
        status: finding.status,
        decision_eligible: finding.decision_eligible,
        action_eligible: finding.action_eligible,
        expected: finding.expected,
        actual: finding.actual,
      },
      {
        severity: 'critical',
        status: 'open',
        decision_eligible: false,
        action_eligible: false,
        expected: 'HR',
        actual: 'CY',
      },
    );
  });

  it('does not backfill a blank invoice description from the matched schedule row', () => {
    const contractDescription = 'Contract-only schedule description';
    const finding = findingFor(
      buildInput({
        id: 'line-blank-description',
        description: '   ',
        unit_type: 'Hour',
        unit_price: 80,
        canonical_category: 'labor',
        category_confidence: 0.9,
      }, makeRateItem({ description: contractDescription })),
      'FINANCIAL_RATE_CODE_MISSING',
    );
    const invoiceDescriptions = finding.evidence.filter(
      (entry) => (
        entry.evidence_type === 'invoice_line'
        && entry.field_name === 'description'
      ),
    );

    assert.deepEqual(invoiceDescriptions, []);
    assert.equal(
      finding.evidence.some((entry) => (
        entry.evidence_type === 'invoice_line'
        && entry.field_value === contractDescription
      )),
      false,
    );
  });
});
