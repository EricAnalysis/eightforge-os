import type { ContractFieldAnalysis } from '@/lib/contracts/types';
import {
  isRuleEnabled,
  makeEvidenceInput,
  makeFinding,
  uniqueStrings,
  type FindingEvidenceInput,
  type ProjectValidatorInput,
  type ValidatorFactRecord,
  type ValidatorFindingResult,
} from '@/lib/validator/shared';

const CATEGORY = 'financial_integrity';

export const RATE_BASED_CONTRACT_VALIDATION_RULES = {
  rate_schedule_required: {
    ruleId: 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED',
    field: 'rate_schedule_present',
    severity: 'critical' as const,
    message: 'Rate-based contract has no valid rate schedule',
  },
  rate_rows_required: {
    ruleId: 'FINANCIAL_RATE_BASED_ROWS_REQUIRED',
    field: 'rate_row_count',
    severity: 'critical' as const,
    message: 'Rate schedule present but insufficient rows to support operations',
  },
  rate_pages_required: {
    ruleId: 'FINANCIAL_RATE_BASED_PAGES_REQUIRED',
    field: 'rate_schedule_pages',
    severity: 'critical' as const,
    message: 'Rate schedule pages could not be confidently identified',
  },
  pricing_applicability_unclear: {
    ruleId: 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR',
    field: 'pricing_applicability',
    severity: 'critical' as const,
    message: 'Pricing schedule present but applicability is unresolved',
  },
  unit_coverage_check: {
    ruleId: 'FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE',
    field: 'rate_units_detected',
    severity: 'warning' as const,
    message: 'Rate schedule detected but unit coverage may be incomplete',
  },
  activation_gate_required: {
    ruleId: 'FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED',
    field: 'activation_trigger_type',
    severity: 'critical' as const,
    message: 'Activation trigger detected but status unresolved',
  },
} as const;

function contractDocumentEvidence(
  input: ProjectValidatorInput,
  note: string,
): FindingEvidenceInput[] {
  const documentIds = uniqueStrings([
    input.factLookups.contractDocumentId,
    ...input.governingDocumentIds.contract,
    ...input.familyDocumentIds.contract,
  ]);

  return documentIds.map((documentId) =>
    makeEvidenceInput({
      evidence_type: 'document',
      source_document_id: documentId,
      record_id: documentId,
      note,
    }),
  );
}

function factEvidence(
  fact: ValidatorFactRecord | null,
  fallbackNote: string,
): FindingEvidenceInput[] {
  if (!fact) return [];

  return fact.evidence.map((evidence) => makeEvidenceInput({
    ...evidence,
    note: evidence.note ?? fallbackNote,
  }));
}

function anchorEvidence(
  input: ProjectValidatorInput,
  anchorIds: readonly string[],
  fallbackNote: string,
): FindingEvidenceInput[] {
  const context = input.contractValidationContext;
  if (!context) return [];

  return uniqueStrings([...anchorIds])
    .map((anchorId) => context.evidence_by_id.get(anchorId) ?? null)
    .filter((evidence): evidence is NonNullable<typeof evidence> => evidence != null)
    .map((evidence) =>
      makeEvidenceInput({
        evidence_type: 'document',
        source_document_id: evidence.source_document_id,
        source_page: evidence.location.page ?? null,
        record_id: evidence.id,
        field_value:
          evidence.location.nearby_text
          ?? evidence.text?.slice(0, 240)
          ?? evidence.value
          ?? null,
        note: fallbackNote,
      }),
    );
}

function rateSchedulePagesValid(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'number' && Number.isFinite(entry));
  }

  if (typeof value === 'string') {
    return /\d/.test(value);
  }

  return false;
}

function normalizedUnits(values: readonly string[]): string[] {
  return uniqueStrings(
    values.map((value) => value.toLowerCase().replace(/\s+/g, ' ').trim()),
  );
}

function hasQuantityUnit(units: readonly string[]): boolean {
  return units.some((unit) =>
    /(?:cubic yard|cy\b|yard\b|ton\b|tree\b|each\b|pound\b|lb\b)/i.test(unit),
  );
}

function hasTimeUnit(units: readonly string[]): boolean {
  return units.some((unit) => /(?:hour\b|hr\b|day\b)/i.test(unit));
}

function isConditional(field: ContractFieldAnalysis | null | undefined): boolean {
  return field?.state === 'conditional';
}

function hasActivationDependency(input: ProjectValidatorInput): boolean {
  const analysis = input.contractValidationContext?.analysis;
  if (!analysis) return false;

  return (
    isConditional(analysis.activation_model.activation_trigger_type)
    || isConditional(analysis.activation_model.authorization_required)
    || isConditional(analysis.activation_model.performance_start_basis)
  );
}

export function runRateBasedContractValidationRules(
  input: ProjectValidatorInput,
): ValidatorFindingResult[] {
  const findings: ValidatorFindingResult[] = [];
  if (input.factLookups.contractCeilingType !== 'rate_based') {
    return findings;
  }

  const subjectId = input.factLookups.contractDocumentId ?? input.project.id;
  const subjectType = input.factLookups.contractDocumentId ? 'contract' : 'project';
  const rateSchedulePresent = input.factLookups.rateSchedulePresent === true;
  const rateRowCount = input.factLookups.rateRowCount;
  const ratePagesDisplay = input.factLookups.rateSchedulePagesDisplay;
  const pagesValid = rateSchedulePagesValid(
    input.factLookups.rateSchedulePagesFact?.value ?? ratePagesDisplay,
  );
  const units = normalizedUnits(input.factLookups.rateUnitsDetected);
  const requiresTimeUnit = input.factLookups.timeAndMaterialsPresent;

  if (
    isRuleEnabled(
      input.ruleStateByRuleId,
      RATE_BASED_CONTRACT_VALIDATION_RULES.rate_schedule_required.ruleId,
    ) &&
    !rateSchedulePresent
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: RATE_BASED_CONTRACT_VALIDATION_RULES.rate_schedule_required.ruleId,
        category: CATEGORY,
        severity: RATE_BASED_CONTRACT_VALIDATION_RULES.rate_schedule_required.severity,
        subjectType,
        subjectId,
        field: RATE_BASED_CONTRACT_VALIDATION_RULES.rate_schedule_required.field,
        expected: true,
        actual: input.factLookups.rateSchedulePresent ?? 'missing',
        evidence: [
          ...factEvidence(
            input.factLookups.contractCeilingTypeFact,
            'Rate-based ceiling classification detected on the governing contract.',
          ),
          ...factEvidence(
            input.factLookups.rateSchedulePresentFact,
            'Rate schedule presence fact available to the validator.',
          ),
          ...contractDocumentEvidence(
            input,
            'Rate-based contract requires a valid rate schedule before work can proceed.',
          ),
        ],
      }),
    );
  }

  if (
    rateSchedulePresent &&
    isRuleEnabled(
      input.ruleStateByRuleId,
      RATE_BASED_CONTRACT_VALIDATION_RULES.rate_rows_required.ruleId,
    ) &&
    (rateRowCount == null || rateRowCount < 5)
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: RATE_BASED_CONTRACT_VALIDATION_RULES.rate_rows_required.ruleId,
        category: CATEGORY,
        severity: RATE_BASED_CONTRACT_VALIDATION_RULES.rate_rows_required.severity,
        subjectType,
        subjectId,
        field: RATE_BASED_CONTRACT_VALIDATION_RULES.rate_rows_required.field,
        expected: '>= 5',
        actual: rateRowCount,
        evidence: [
          ...factEvidence(
            input.factLookups.rateRowCountFact,
            'Rate row count extracted from the governing contract schedule.',
          ),
          ...factEvidence(
            input.factLookups.rateSchedulePresentFact,
            'Rate schedule presence fact available to the validator.',
          ),
        ],
      }),
    );
  }

  if (
    rateSchedulePresent &&
    isRuleEnabled(
      input.ruleStateByRuleId,
      RATE_BASED_CONTRACT_VALIDATION_RULES.rate_pages_required.ruleId,
    ) &&
    !pagesValid
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: RATE_BASED_CONTRACT_VALIDATION_RULES.rate_pages_required.ruleId,
        category: CATEGORY,
        severity: RATE_BASED_CONTRACT_VALIDATION_RULES.rate_pages_required.severity,
        subjectType,
        subjectId,
        field: RATE_BASED_CONTRACT_VALIDATION_RULES.rate_pages_required.field,
        expected: 'identified rate schedule pages',
        actual: ratePagesDisplay ?? 'missing',
        evidence: [
          ...factEvidence(
            input.factLookups.rateSchedulePagesFact,
            'Rate schedule pages fact available to the validator.',
          ),
          ...factEvidence(
            input.factLookups.rateSchedulePresentFact,
            'Rate schedule presence fact available to the validator.',
          ),
        ],
      }),
    );
  }

  const pricingField =
    input.contractValidationContext?.analysis.pricing_model.pricing_applicability
    ?? null;
  if (
    rateSchedulePresent &&
    isRuleEnabled(
      input.ruleStateByRuleId,
      RATE_BASED_CONTRACT_VALIDATION_RULES.pricing_applicability_unclear.ruleId,
    ) &&
    pricingField?.state === 'conditional'
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: RATE_BASED_CONTRACT_VALIDATION_RULES.pricing_applicability_unclear.ruleId,
        category: CATEGORY,
        severity: RATE_BASED_CONTRACT_VALIDATION_RULES.pricing_applicability_unclear.severity,
        subjectType,
        subjectId,
        field: RATE_BASED_CONTRACT_VALIDATION_RULES.pricing_applicability_unclear.field,
        expected: 'resolved pricing applicability',
        actual: pricingField.value ?? pricingField.state,
        evidence: [
          ...factEvidence(
            input.factLookups.rateSchedulePresentFact,
            'Rate schedule presence fact available to the validator.',
          ),
          ...anchorEvidence(
            input,
            pricingField.evidence_anchors,
            'Pricing applicability evidence remains conditional for this rate-based contract.',
          ),
        ],
      }),
    );
  }

  const unitCoverageComplete =
    units.length > 0
    && hasQuantityUnit(units)
    && (!requiresTimeUnit || hasTimeUnit(units));
  if (
    rateSchedulePresent &&
    isRuleEnabled(
      input.ruleStateByRuleId,
      RATE_BASED_CONTRACT_VALIDATION_RULES.unit_coverage_check.ruleId,
    ) &&
    !unitCoverageComplete
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: RATE_BASED_CONTRACT_VALIDATION_RULES.unit_coverage_check.ruleId,
        category: CATEGORY,
        severity: RATE_BASED_CONTRACT_VALIDATION_RULES.unit_coverage_check.severity,
        subjectType,
        subjectId,
        field: RATE_BASED_CONTRACT_VALIDATION_RULES.unit_coverage_check.field,
        expected: requiresTimeUnit
          ? 'quantity units plus labor/time units'
          : 'quantity-based operational units',
        actual: units.length > 0 ? units.join(', ') : 'missing',
        evidence: [
          ...factEvidence(
            input.factLookups.rateUnitsDetectedFact,
            'Detected rate schedule units available to the validator.',
          ),
          ...factEvidence(
            input.factLookups.timeAndMaterialsPresentFact,
            'Time-and-materials signal available to the validator.',
          ),
        ],
      }),
    );
  }

  const activationField =
    input.contractValidationContext?.analysis.activation_model.activation_trigger_type
    ?? null;
  const authorizationField =
    input.contractValidationContext?.analysis.activation_model.authorization_required
    ?? null;
  const performanceField =
    input.contractValidationContext?.analysis.activation_model.performance_start_basis
    ?? null;
  if (
    isRuleEnabled(
      input.ruleStateByRuleId,
      RATE_BASED_CONTRACT_VALIDATION_RULES.activation_gate_required.ruleId,
    ) &&
    hasActivationDependency(input)
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: RATE_BASED_CONTRACT_VALIDATION_RULES.activation_gate_required.ruleId,
        category: CATEGORY,
        severity: RATE_BASED_CONTRACT_VALIDATION_RULES.activation_gate_required.severity,
        subjectType,
        subjectId,
        field: RATE_BASED_CONTRACT_VALIDATION_RULES.activation_gate_required.field,
        expected: 'resolved activation trigger status',
        actual:
          activationField?.value
          ?? authorizationField?.value
          ?? performanceField?.value
          ?? 'conditional',
        evidence: [
          ...anchorEvidence(
            input,
            [
              ...(activationField?.evidence_anchors ?? []),
              ...(authorizationField?.evidence_anchors ?? []),
              ...(performanceField?.evidence_anchors ?? []),
            ],
            'Activation language is present, but the governing trigger remains unresolved.',
          ),
        ],
      }),
    );
  }

  return findings;
}
