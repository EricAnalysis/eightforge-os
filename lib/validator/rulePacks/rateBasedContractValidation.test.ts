import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type {
  ContractAnalysisResult,
  ContractFieldAnalysis,
  ContractFieldId,
  ContractFieldState,
} from '@/lib/contracts/types';
import { runFinancialIntegrityRules } from '@/lib/validator/rulePacks/financialIntegrity';
import { runRequiredSourcesRules } from '@/lib/validator/rulePacks/requiredSources';
import {
  buildValidationSummary,
  sortFindings,
  type ProjectTotals,
  type ProjectValidatorInput,
  type ValidatorContractAnalysisContext,
  type ValidatorDocumentIdsByFamily,
  type ValidatorFactLookups,
  type ValidatorFactRecord,
  type ValidatorProjectRow,
} from '@/lib/validator/shared';
import type { EvidenceObject } from '@/lib/extraction/types';

const TEST_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const CONTRACT_DOCUMENT_ID = 'contract-1';

function makeFactRecord(key: string, value: unknown): ValidatorFactRecord {
  return {
    id: `${CONTRACT_DOCUMENT_ID}:${key}`,
    document_id: CONTRACT_DOCUMENT_ID,
    key,
    value,
    source: 'normalized_row',
    field_type: null,
    evidence: [{
      id: `fact:${CONTRACT_DOCUMENT_ID}:${key}`,
      finding_id: `fact:${CONTRACT_DOCUMENT_ID}:${key}`,
      evidence_type: 'fact',
      source_document_id: CONTRACT_DOCUMENT_ID,
      source_page: null,
      fact_id: `${CONTRACT_DOCUMENT_ID}:${key}`,
      record_id: `${CONTRACT_DOCUMENT_ID}:${key}`,
      field_name: key,
      field_value:
        typeof value === 'string'
          ? value
          : JSON.stringify(value) ?? null,
      note: `Test fact for ${key}.`,
      created_at: TEST_TIMESTAMP,
    }],
  };
}

function makeContractField(params: {
  fieldId: ContractFieldId;
  value: unknown;
  state: ContractFieldState;
  evidenceAnchors?: string[];
}): ContractFieldAnalysis {
  return {
    field_id: params.fieldId,
    label: params.fieldId,
    object_family:
      params.fieldId === 'activation_trigger_type'
      || params.fieldId === 'authorization_required'
      || params.fieldId === 'performance_start_basis'
        ? 'activation_model'
        : 'pricing_model',
    value_type:
      typeof params.value === 'boolean'
        ? 'boolean'
        : typeof params.value === 'number'
          ? 'number'
          : 'text',
    value: params.value,
    state: params.state,
    criticality: 'P1',
    confidence: 0.9,
    evidence_anchors: params.evidenceAnchors ?? [],
    source_fact_ids: [],
    pattern_ids: [],
    notes: [],
  };
}

function makeEvidence(id: string, page: number, text: string): EvidenceObject {
  return {
    id,
    kind: 'text',
    source_type: 'pdf',
    description: 'Synthetic contract evidence',
    text,
    location: {
      page,
      nearby_text: text,
    },
    confidence: 0.9,
    weak: false,
    source_document_id: CONTRACT_DOCUMENT_ID,
  };
}

function buildContractAnalysis(params: {
  pricingState: ContractFieldState;
  activationState: ContractFieldState;
}): ValidatorContractAnalysisContext {
  const pricingEvidence = makeEvidence(
    'pricing-1',
    9,
    'Tipping fees shall be reimbursed only with eligible support and approved disposal documentation.',
  );
  const activationEvidence = makeEvidence(
    'activation-1',
    2,
    'No work may begin until written authorization or notice to proceed is issued by the County.',
  );

  const analysis: ContractAnalysisResult = {
    document_id: CONTRACT_DOCUMENT_ID,
    document_family: 'contract',
    document_type_profile: 'fema_disaster_recovery_debris_contract',
    language_engine_version: 'test',
    pattern_library_version: 'test',
    coverage_library_version: 'test',
    contract_identity: {},
    term_model: {},
    activation_model: {
      activation_trigger_type: makeContractField({
        fieldId: 'activation_trigger_type',
        value: params.activationState === 'missing_critical' ? null : 'notice_to_proceed',
        state: params.activationState,
        evidenceAnchors: params.activationState === 'missing_critical' ? [] : ['activation-1'],
      }),
      authorization_required: makeContractField({
        fieldId: 'authorization_required',
        value: params.activationState === 'missing_critical' ? null : true,
        state: params.activationState,
        evidenceAnchors: params.activationState === 'missing_critical' ? [] : ['activation-1'],
      }),
      performance_start_basis: makeContractField({
        fieldId: 'performance_start_basis',
        value:
          params.activationState === 'missing_critical'
            ? null
            : 'after_notice_to_proceed',
        state: params.activationState,
        evidenceAnchors: params.activationState === 'missing_critical' ? [] : ['activation-1'],
      }),
    },
    scope_model: {},
    pricing_model: {
      pricing_applicability: makeContractField({
        fieldId: 'pricing_applicability',
        value:
          params.pricingState === 'explicit'
            ? 'unit_rate_schedule_controls_pricing'
            : params.pricingState === 'conditional'
              ? 'requires_activation_scope_or_eligibility_resolution'
              : null,
        state: params.pricingState,
        evidenceAnchors: params.pricingState === 'missing_critical' ? [] : ['pricing-1'],
      }),
      contract_ceiling_type: makeContractField({
        fieldId: 'contract_ceiling_type',
        value: 'rate_based',
        state: 'explicit',
      }),
    },
    documentation_model: {},
    compliance_model: {},
    payment_model: {},
    clause_patterns_detected: [],
    coverage_status: [],
    issues: [],
    trace_summary: {
      detected_pattern_ids: [],
      coverage_gap_ids: [],
      emitted_issue_ids: [],
      suppressed_issues: [],
      issue_anchor_summary: [],
    },
  };

  return {
    document_id: CONTRACT_DOCUMENT_ID,
    analysis,
    evidence_by_id: new Map([
      [pricingEvidence.id, pricingEvidence],
      [activationEvidence.id, activationEvidence],
    ]),
  };
}

function buildInput(params: {
  contractCeilingType: 'rate_based' | 'total' | 'none';
  rateSchedulePresent: boolean | null;
  rateRowCount: number | null;
  rateSchedulePages: string | null;
  rateUnitsDetected: string[];
  timeAndMaterialsPresent: boolean;
  contractValidationContext: ValidatorContractAnalysisContext | null;
  hasRateScheduleFacts?: boolean;
}): ProjectValidatorInput {
  const project: ValidatorProjectRow = {
    id: 'project-1',
    organization_id: 'org-1',
    name: 'Williamson baseline',
    code: 'WIL-1',
  };

  const familyDocumentIds: ValidatorDocumentIdsByFamily = {
    contract: [CONTRACT_DOCUMENT_ID],
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
    contractDocumentId: CONTRACT_DOCUMENT_ID,
    contractCeilingTypeFact: makeFactRecord('contract_ceiling_type', params.contractCeilingType),
    contractCeilingType: params.contractCeilingType,
    rateSchedulePresentFact:
      params.rateSchedulePresent == null
        ? null
        : makeFactRecord('rate_schedule_present', params.rateSchedulePresent),
    rateSchedulePresent: params.rateSchedulePresent,
    rateRowCountFact:
      params.rateRowCount == null
        ? null
        : makeFactRecord('rate_row_count', params.rateRowCount),
    rateRowCount: params.rateRowCount,
    rateSchedulePagesFact:
      params.rateSchedulePages == null
        ? null
        : makeFactRecord('rate_schedule_pages', params.rateSchedulePages),
    rateSchedulePagesDisplay: params.rateSchedulePages,
    rateUnitsDetectedFact:
      params.rateUnitsDetected.length > 0
        ? makeFactRecord('rate_units_detected', params.rateUnitsDetected)
        : null,
    rateUnitsDetected: params.rateUnitsDetected,
    timeAndMaterialsPresentFact: makeFactRecord(
      'time_and_materials_present',
      params.timeAndMaterialsPresent,
    ),
    timeAndMaterialsPresent: params.timeAndMaterialsPresent,
    rateScheduleFacts: [],
    rateScheduleItems: [],
    hasRateScheduleFacts: params.hasRateScheduleFacts ?? (params.rateSchedulePresent === true),
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
    documents: [],
    documentRelationships: [],
    precedenceFamilies: [],
    familyDocumentIds,
    governingDocumentIds: familyDocumentIds,
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
    contractValidationContext: params.contractValidationContext,
  };
}

describe('rate-based contract validator rules', () => {
  it('keeps the Williamson baseline blocked on activation and pricing, not on a missing ceiling', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 46,
      rateSchedulePages: 'pages 8-11',
      rateUnitsDetected: ['cubic yard', 'hour', 'pound'],
      timeAndMaterialsPresent: true,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'conditional',
        activationState: 'conditional',
      }),
    });

    const findings = sortFindings(runFinancialIntegrityRules(input));
    const ruleIds = findings.map((finding) => finding.rule_id);

    assert.deepEqual(ruleIds, [
      'FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED',
      'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR',
    ]);
    assert.equal(ruleIds.includes('FINANCIAL_NTE_FACT_MISSING'), false);
    assert.equal(
      findings.every((finding) => finding.evidence.some((evidence) => evidence.source_page != null)),
      true,
    );

    const summary = buildValidationSummary(findings, 'FINDINGS_OPEN');
    assert.equal(summary.validator_status, 'BLOCKED');
    assert.deepEqual(
      summary.validator_blockers.map((item) => item.message),
      [
        'Activation trigger detected but status unresolved',
        'Pricing schedule present but applicability is unresolved',
      ],
    );
  });

  it('routes a rate-based contract with no rate schedule into the dedicated critical validator rule', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: false,
      rateRowCount: null,
      rateSchedulePages: null,
      rateUnitsDetected: [],
      timeAndMaterialsPresent: false,
      contractValidationContext: null,
      hasRateScheduleFacts: false,
    });

    const sourceRuleIds = runRequiredSourcesRules(input).map((finding) => finding.rule_id);
    assert.equal(sourceRuleIds.includes('SOURCES_NO_RATE_SCHEDULE'), false);

    const findings = runFinancialIntegrityRules(input);
    assert.deepEqual(
      findings.map((finding) => finding.rule_id),
      ['FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED'],
    );
    assert.equal(findings[0]?.severity, 'critical');
  });

  it('fails a weak rate schedule when the extracted row count is too low', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 3,
      rateSchedulePages: 'page 8',
      rateUnitsDetected: ['cubic yard'],
      timeAndMaterialsPresent: false,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'explicit',
        activationState: 'missing_critical',
      }),
    });

    const findings = runFinancialIntegrityRules(input);
    assert.deepEqual(
      findings.map((finding) => finding.rule_id),
      ['FINANCIAL_RATE_BASED_ROWS_REQUIRED'],
    );
    assert.equal(findings[0]?.severity, 'critical');
  });

  it('returns READY for a complete rate-based contract with resolved pricing and activation', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 12,
      rateSchedulePages: 'pages 8-10',
      rateUnitsDetected: ['cubic yard', 'hour'],
      timeAndMaterialsPresent: true,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'explicit',
        activationState: 'explicit',
      }),
    });

    const findings = runFinancialIntegrityRules(input);
    assert.deepEqual(findings, []);

    const summary = buildValidationSummary(findings, 'VALIDATED');
    assert.equal(summary.validator_status, 'READY');
    assert.deepEqual(summary.validator_open_items, []);
    assert.deepEqual(summary.validator_blockers, []);
  });
});
