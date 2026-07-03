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
  type RateScheduleItem,
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
  executedDate?: string | null;
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
    contract_identity: params.executedDate
      ? {
        executed_date: makeContractField({
          fieldId: 'executed_date',
          value: params.executedDate,
          state: 'explicit',
        }),
      }
      : {},
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
  invoiceLines?: Array<Record<string, unknown>>;
  rateScheduleItems?: RateScheduleItem[];
  allFacts?: ValidatorFactRecord[];
  contractUploadGuidanceRateScheduleIncluded?: string | null;
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
    contractIdentityDocumentIds: [CONTRACT_DOCUMENT_ID],
    pricingContextDocumentIds: [],
    complianceContextDocumentIds: [],
    amendmentContextDocumentIds: [],
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
    contractUploadGuidanceRateScheduleIncluded:
      params.contractUploadGuidanceRateScheduleIncluded ?? null,
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
    rateScheduleItems: params.rateScheduleItems ?? [],
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
    validationPhase: 'contract_setup',
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
    allFacts: params.allFacts ?? [],
    mobileTickets: [],
    loadTickets: [],
    invoices: [],
    invoiceLines: params.invoiceLines ?? [],
    mobileToLoadsMap: new Map(),
    invoiceLineToRateMap: new Map(
      (params.invoiceLines ?? []).map((line) => [
        String(line.id),
        params.rateScheduleItems?.[0] ?? null,
      ]),
    ),
    projectTotals,
    factLookups,
    contractValidationContext: params.contractValidationContext,
  };
}

function makeRateItem(overrides: Partial<RateScheduleItem> = {}): RateScheduleItem {
  return {
    source_document_id: CONTRACT_DOCUMENT_ID,
    record_id: overrides.record_id ?? 'rate-row-1',
    rate_code: overrides.rate_code ?? null,
    unit_type: overrides.unit_type ?? 'HR',
    rate_amount: overrides.rate_amount ?? 80,
    material_type: overrides.material_type ?? null,
    description: overrides.description ?? 'Labor support',
    service_item: overrides.service_item ?? null,
    source_category: overrides.source_category ?? 'Labor',
    canonical_category: overrides.canonical_category ?? 'labor',
    category_confidence: overrides.category_confidence ?? 0.9,
    source_quality: overrides.source_quality ?? null,
    confidence: overrides.confidence ?? null,
    source_kind: overrides.source_kind ?? null,
    raw_value: overrides.raw_value ?? {},
  };
}

describe('rate-based contract validator rules', () => {
  it('keeps the Williamson baseline in review for activation and pricing, not blocked on a missing ceiling', () => {
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
      'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR',
      'FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED',
    ]);
    assert.equal(ruleIds.includes('FINANCIAL_NTE_FACT_MISSING'), false);
    assert.equal(
      findings.every((finding) => finding.evidence.some((evidence) => evidence.source_page != null)),
      true,
    );
    assert.deepEqual(
      findings.map((finding) => finding.severity),
      ['warning', 'warning'],
    );

    const summary = buildValidationSummary(findings, 'FINDINGS_OPEN');
    assert.equal(summary.validator_status, 'NEEDS_REVIEW');
    assert.equal(summary.blocker_count, 0);
    assert.equal(summary.requires_review_count, 1);
    assert.equal(summary.warning_count, 1);
    assert.deepEqual(summary.validator_blockers, []);
    assert.deepEqual(
      summary.validator_open_items.map((item) => item.message),
      [
        'The contract has pricing language, but the governing pricing basis for the billed work is still unresolved.',
        'The contract includes activation language, but it is still unclear whether a separate authorization document is required for approval.',
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

  it('flags operator upload guidance when a rate schedule was expected but no rows were extracted', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 0,
      rateSchedulePages: 'pages 8-10',
      rateUnitsDetected: [],
      timeAndMaterialsPresent: false,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'explicit',
        activationState: 'missing_critical',
      }),
      contractUploadGuidanceRateScheduleIncluded: 'yes',
    });

    const findings = runFinancialIntegrityRules(input);

    assert.equal(
      findings.some((finding) =>
        finding.rule_id === 'CONTRACT_RATE_SCHEDULE_HINT_MISMATCH',
      ),
      true,
    );
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

  it('clears unit coverage when all matched invoice lines use recognized units', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 12,
      rateSchedulePages: 'pages 8-10',
      rateUnitsDetected: ['hr'],
      timeAndMaterialsPresent: true,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'explicit',
        activationState: 'explicit',
      }),
      invoiceLines: [{
        id: 'line-hr-1',
        unit_type: 'Hour',
      }],
      rateScheduleItems: [makeRateItem({ unit_type: 'HR' })],
    });

    const findings = runFinancialIntegrityRules(input);
    assert.equal(
      findings.some((finding) => finding.rule_id === 'FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE'),
      false,
    );
  });

  it('downgrades missing invoice rate code to informational when semantic match is confident', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 12,
      rateSchedulePages: 'pages 8-10',
      rateUnitsDetected: ['hour'],
      timeAndMaterialsPresent: true,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'explicit',
        activationState: 'explicit',
      }),
      invoiceLines: [{
        id: 'line-missing-code-1',
        description: 'Labor support',
        unit_type: 'Hour',
        unit_price: 80,
        canonical_category: 'labor',
        category_confidence: 0.9,
      }],
      rateScheduleItems: [makeRateItem({
        rate_code: 'LABOR',
        description: 'Labor support',
        unit_type: 'HR',
        rate_amount: 80,
        canonical_category: 'labor',
        category_confidence: 0.9,
      })],
    });

    const finding = runFinancialIntegrityRules(input).find(
      (candidate) => candidate.rule_id === 'FINANCIAL_RATE_CODE_MISSING',
    );

    assert.ok(finding);
    assert.equal(finding.severity, 'info');
    assert.equal(finding.finding_disposition, 'info');
    assert.equal(finding.approval_gate_effect, 'informational');
    assert.equal(finding.action_eligible, false);
  });

  it('keeps missing invoice rate code reviewable when semantic match is weak', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 12,
      rateSchedulePages: 'pages 8-10',
      rateUnitsDetected: ['hour'],
      timeAndMaterialsPresent: true,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'explicit',
        activationState: 'explicit',
      }),
      invoiceLines: [{
        id: 'line-missing-code-weak-1',
        description: 'Labor support',
        unit_type: 'Hour',
        unit_price: 80,
        canonical_category: 'labor',
        category_confidence: 0.9,
      }],
      rateScheduleItems: [makeRateItem({
        rate_code: 'LABOR',
        description: 'Labor support',
        unit_type: 'HR',
        rate_amount: 80,
        canonical_category: 'labor',
        category_confidence: 0.9,
        source_quality: 'suspicious_ocr',
      })],
    });

    const finding = runFinancialIntegrityRules(input).find(
      (candidate) => candidate.rule_id === 'FINANCIAL_RATE_CODE_MISSING',
    );

    assert.ok(finding);
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.approval_gate_effect, 'requires_operator_review');
  });

  it('emits one targeted unit coverage warning for unknown units', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 12,
      rateSchedulePages: 'pages 8-10',
      rateUnitsDetected: ['mystery unit'],
      timeAndMaterialsPresent: false,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'explicit',
        activationState: 'explicit',
      }),
      invoiceLines: [{
        id: 'line-unknown-1',
        unit_type: 'mystery unit',
      }],
      rateScheduleItems: [makeRateItem({
        record_id: 'rate-row-unknown',
        unit_type: 'mystery unit',
      })],
    });

    const findings = runFinancialIntegrityRules(input).filter(
      (finding) => finding.rule_id === 'FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE',
    );

    assert.equal(findings.length, 1);
    assert.match(findings[0]?.actual ?? '', /mystery unit/);
    assert.match(findings[0]?.actual ?? '', /line-unknown-1/);
    assert.match(findings[0]?.actual ?? '', /rate-row-unknown/);
  });

  it('treats a fully executed governing contract as active and confirms pricing when lines are matched', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 12,
      rateSchedulePages: 'pages 8-10',
      rateUnitsDetected: ['hour'],
      timeAndMaterialsPresent: true,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'conditional',
        activationState: 'conditional',
        executedDate: '2026-02-09',
      }),
      invoiceLines: [{
        id: 'line-active-1',
        unit_type: 'Hour',
      }],
      rateScheduleItems: [makeRateItem({ unit_type: 'HR' })],
    });

    const findings = runFinancialIntegrityRules(input);
    assert.equal(
      findings.some((finding) => finding.rule_id === 'FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED'),
      false,
    );
    assert.equal(
      findings.some((finding) => finding.rule_id === 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR'),
      false,
    );

    const summary = buildValidationSummary(findings, 'VALIDATED', {
      contractValidationContext: input.contractValidationContext,
      crossDocumentRateVerification: {
        comparable_units: 1,
        matched_units: 1,
        rate_mismatch_units: 0,
        category_mismatch_units: 0,
        missing_contract_rate_units: 0,
        missing_support_units: 0,
        unsupported_work_units: 0,
        needs_review_units: 0,
        validation_units: [],
      },
    });
    assert.equal(summary.activation_gate_status, 'satisfied');
    assert.equal(summary.pricing_applicability_status, 'confirmed');
  });

  it('keeps activation review when an inactive override signal exists', () => {
    const input = buildInput({
      contractCeilingType: 'rate_based',
      rateSchedulePresent: true,
      rateRowCount: 12,
      rateSchedulePages: 'pages 8-10',
      rateUnitsDetected: ['hour'],
      timeAndMaterialsPresent: true,
      contractValidationContext: buildContractAnalysis({
        pricingState: 'explicit',
        activationState: 'conditional',
        executedDate: '2026-02-09',
      }),
      allFacts: [makeFactRecord('contract_active', false)],
      invoiceLines: [{
        id: 'line-inactive-1',
        unit_type: 'Hour',
      }],
      rateScheduleItems: [makeRateItem({ unit_type: 'HR' })],
    });

    const findings = runFinancialIntegrityRules(input);
    assert.equal(
      findings.some((finding) => finding.rule_id === 'FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED'),
      true,
    );
  });
});
