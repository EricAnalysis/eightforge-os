import type { ContractFieldAnalysis } from '@/lib/contracts/types';
import {
  isRuleEnabled,
  makeEvidenceInput,
  makeFinding,
  readRowString,
  uniqueStrings,
  type FindingEvidenceInput,
  type InvoiceLineRow,
  type ProjectValidatorInput,
  type RateScheduleItem,
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
    severity: 'warning' as const,
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
    severity: 'warning' as const,
    message: 'Activation trigger detected but status unresolved',
  },
  upload_guidance_hint_mismatch: {
    ruleId: 'CONTRACT_RATE_SCHEDULE_HINT_MISMATCH',
    field: 'rate_row_count',
    severity: 'warning' as const,
    message: 'Operator indicated a rate schedule was included, but none was extracted',
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

const RECOGNIZED_UNIT_ALIASES = new Map<string, string>([
  ['cubic yard', 'cubic_yard'],
  ['cubic yards', 'cubic_yard'],
  ['cy', 'cubic_yard'],
  ['cyd', 'cubic_yard'],
  ['c y', 'cubic_yard'],
  ['yard', 'cubic_yard'],
  ['yards', 'cubic_yard'],
  ['yd', 'cubic_yard'],
  ['hour', 'hour'],
  ['hours', 'hour'],
  ['hr', 'hour'],
  ['hrs', 'hour'],
  ['h', 'hour'],
  ['tree', 'tree'],
  ['trees', 'tree'],
  ['stump', 'stump'],
  ['stumps', 'stump'],
  ['pound', 'pound'],
  ['pounds', 'pound'],
  ['lb', 'pound'],
  ['lbs', 'pound'],
  ['unit', 'unit'],
  ['units', 'unit'],
  ['ea', 'unit'],
  ['each', 'unit'],
  ['passthrough', 'passthrough'],
  ['pass through', 'passthrough'],
  ['tipping fee', 'passthrough'],
  ['tipping fees', 'passthrough'],
  ['ton', 'ton'],
  ['tons', 'ton'],
]);

const INVOICE_LINE_ID_KEYS = ['id', 'invoice_line_id', 'line_id'] as const;
const INVOICE_LINE_UNIT_KEYS = ['unit_type', 'unit', 'uom', 'unit_of_measure'] as const;

function canonicalUnit(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .toLowerCase()
    .replace(/\bc\.?\s*y\.?\b/g, 'cy')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return null;
  return RECOGNIZED_UNIT_ALIASES.get(normalized) ?? null;
}

function invoiceLineId(row: InvoiceLineRow): string {
  return readRowString(row, INVOICE_LINE_ID_KEYS)
    ?? `invoice_line:${JSON.stringify(row).slice(0, 80)}`;
}

function unitCoverageSummary(input: ProjectValidatorInput): {
  unknownUnits: string[];
  affectedRateRows: string[];
  affectedInvoiceLines: string[];
  allMatchedLinesRecognized: boolean;
} {
  const unknownUnits = new Set<string>();
  const affectedRateRows = new Set<string>();
  const affectedInvoiceLines = new Set<string>();

  for (const row of input.invoiceLines) {
    const lineId = invoiceLineId(row);
    const scheduleItem = input.invoiceLineToRateMap.get(lineId) ?? null;
    if (!scheduleItem) continue;

    const lineUnit = readRowString(row, INVOICE_LINE_UNIT_KEYS);
    const units = uniqueStrings([lineUnit, scheduleItem.unit_type]);
    for (const unit of units) {
      if (canonicalUnit(unit)) continue;
      unknownUnits.add(unit);
      affectedInvoiceLines.add(lineId);
      if (scheduleItem.record_id) affectedRateRows.add(scheduleItem.record_id);
    }
  }

  if (input.invoiceLines.length === 0) {
    for (const unit of input.factLookups.rateUnitsDetected) {
      if (canonicalUnit(unit)) continue;
      unknownUnits.add(unit);
    }
  }

  return {
    unknownUnits: [...unknownUnits].sort((left, right) => left.localeCompare(right, 'en-US')),
    affectedRateRows: [...affectedRateRows].sort((left, right) => left.localeCompare(right, 'en-US')),
    affectedInvoiceLines: [...affectedInvoiceLines].sort((left, right) => left.localeCompare(right, 'en-US')),
    allMatchedLinesRecognized: unknownUnits.size === 0,
  };
}

function fieldValueText(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value == null) return '';
  return String(value).toLowerCase();
}

function hasInactiveContractSignal(input: ProjectValidatorInput): boolean {
  const inactiveKeys = /(?:inactive|void|voided|superseded|expired|active|status)/i;
  return input.allFacts.some((fact) => {
    if (!inactiveKeys.test(fact.key)) return false;
    const value = fieldValueText(fact.value);
    if (!value) return false;
    if (fact.key.toLowerCase().includes('active') && value === 'false') return true;
    return /\b(?:inactive|voided|void|superseded|expired)\b/.test(value);
  });
}

export function isGoverningContractFullyExecutedAndActive(input: ProjectValidatorInput): boolean {
  const executedField = input.contractValidationContext?.analysis.contract_identity.executed_date;
  const executedValue = executedField?.value;
  const hasExecutedDate =
    executedValue != null
    && String(executedValue).trim().length > 0
    && (executedField?.state === 'explicit' || executedField?.state === 'derived');

  return (
    input.factLookups.contractDocumentId != null
    && hasExecutedDate
    && !hasInactiveContractSignal(input)
  );
}

function allInvoiceLinesHaveMatchedRates(input: ProjectValidatorInput): boolean {
  return (
    input.invoiceLines.length > 0
    && input.invoiceLines.every((row) => {
      const item: RateScheduleItem | null =
        input.invoiceLineToRateMap.get(invoiceLineId(row)) ?? null;
      return item != null && item.source_document_id != null && item.record_id != null;
    })
  );
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
  const unitCoverage = unitCoverageSummary(input);
  const contractActiveByExecution = isGoverningContractFullyExecutedAndActive(input);
  const allLinesMatched = allInvoiceLinesHaveMatchedRates(input);

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
    input.factLookups.contractUploadGuidanceRateScheduleIncluded === 'yes' &&
    rateRowCount === 0 &&
    isRuleEnabled(
      input.ruleStateByRuleId,
      RATE_BASED_CONTRACT_VALIDATION_RULES.upload_guidance_hint_mismatch.ruleId,
    )
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: RATE_BASED_CONTRACT_VALIDATION_RULES.upload_guidance_hint_mismatch.ruleId,
        category: CATEGORY,
        severity: RATE_BASED_CONTRACT_VALIDATION_RULES.upload_guidance_hint_mismatch.severity,
        subjectType,
        subjectId,
        field: RATE_BASED_CONTRACT_VALIDATION_RULES.upload_guidance_hint_mismatch.field,
        expected: '> 0 rate rows extracted',
        actual: rateRowCount,
        evidence: [
          ...factEvidence(
            input.factLookups.rateRowCountFact,
            'Rate row count extracted from the governing contract schedule.',
          ),
          ...contractDocumentEvidence(
            input,
            'Upload guidance indicated that a rate schedule was included, but no canonical rate rows were extracted.',
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
    pricingField?.state === 'conditional' &&
    !(contractActiveByExecution && allLinesMatched)
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

  if (
    rateSchedulePresent &&
    isRuleEnabled(
      input.ruleStateByRuleId,
      RATE_BASED_CONTRACT_VALIDATION_RULES.unit_coverage_check.ruleId,
    ) &&
    !unitCoverage.allMatchedLinesRecognized
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
        expected: 'recognized contract units for matched invoice lines',
        actual: {
          unknown_units: unitCoverage.unknownUnits,
          affected_rate_rows: unitCoverage.affectedRateRows,
          affected_invoice_lines: unitCoverage.affectedInvoiceLines,
        },
        evidence: [
          ...factEvidence(
            input.factLookups.rateUnitsDetectedFact,
            'Detected rate schedule units available to the validator.',
          ),
          ...factEvidence(
            input.factLookups.timeAndMaterialsPresentFact,
            'Time-and-materials signal available to the validator.',
          ),
          makeEvidenceInput({
            evidence_type: 'rate_schedule',
            source_document_id: input.factLookups.contractDocumentId,
            record_id: subjectId,
            field_name: 'unknown_units',
            field_value: {
              detected_units: units,
              unknown_units: unitCoverage.unknownUnits,
              affected_rate_rows: unitCoverage.affectedRateRows,
              affected_invoice_lines: unitCoverage.affectedInvoiceLines,
            },
            note: 'Unit coverage warning is limited to unknown units used by matched invoice lines.',
          }),
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
    hasActivationDependency(input) &&
    !contractActiveByExecution
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
