import {
  isRuleEnabled,
  makeEvidenceInput,
  makeFinding,
  normalizeCode,
  readRowNumber,
  readRowString,
  rowIdentifier,
  structuredRowEvidenceInput,
  toNumber,
  type InvoiceLineRow,
  type ProjectValidatorInput,
  type ValidatorFindingResult,
} from '@/lib/validator/shared';
import { billingRateKeyForScheduleItem } from '@/lib/validator/billingKeys';
import { runRateBasedContractValidationRules } from '@/lib/validator/rulePacks/rateBasedContractValidation';

const CATEGORY = 'financial_integrity';

const INVOICE_LINE_ID_KEYS = ['id', 'invoice_line_id', 'line_id'] as const;
const INVOICE_LINE_RATE_CODE_KEYS = [
  'rate_code',
  'contract_rate_code',
  'item_code',
  'service_code',
] as const;
const INVOICE_LINE_UNIT_KEYS = ['unit_type', 'unit', 'uom'] as const;
const INVOICE_LINE_TOTAL_KEYS = [
  'line_total',
  'extended_amount',
  'total_amount',
  'amount',
] as const;
const INVOICE_TOTAL_KEYS = ['total_amount', 'invoice_total', 'billed_amount'] as const;

function invoiceLineId(row: InvoiceLineRow): string {
  return rowIdentifier(row, INVOICE_LINE_ID_KEYS, 'invoice_line');
}

function invoiceEvidence(input: ProjectValidatorInput) {
  if (input.invoiceLines.length > 0) {
    return input.invoiceLines.slice(0, 5).map((row) =>
      structuredRowEvidenceInput({
        evidenceType: 'invoice_line',
        row,
        fieldName: 'line_total',
        fieldValue: readRowNumber(row, INVOICE_LINE_TOTAL_KEYS),
        note: 'Invoice line contributes to the billed total considered by the validator.',
      }),
    );
  }

  return input.invoices.slice(0, 5).map((row) =>
    structuredRowEvidenceInput({
      evidenceType: 'invoice',
      row,
      fieldName: 'total_amount',
      fieldValue: readRowNumber(row, INVOICE_TOTAL_KEYS),
      note: 'Invoice total contributes to the billed total fallback used by the validator.',
    }),
  );
}

export function runFinancialIntegrityRules(
  input: ProjectValidatorInput,
): ValidatorFindingResult[] {
  const findings = runRateBasedContractValidationRules(input);
  const hasUsableRateSchedule = input.factLookups.rateScheduleItems.some(
    (item) => billingRateKeyForScheduleItem(item) != null,
  );
  const rateBasedCeiling = input.factLookups.contractCeilingType === 'rate_based';

  for (const row of input.invoiceLines) {
    const lineId = invoiceLineId(row);
    const rateCode = readRowString(row, INVOICE_LINE_RATE_CODE_KEYS);
    const billedUnit = readRowString(row, INVOICE_LINE_UNIT_KEYS);
    const scheduleItem = input.invoiceLineToRateMap.get(lineId) ?? null;

    if (
      !rateCode &&
      isRuleEnabled(
        input.ruleStateByRuleId,
        'FINANCIAL_RATE_CODE_MISSING',
      )
    ) {
      findings.push(
        makeFinding({
          projectId: input.project.id,
          ruleId: 'FINANCIAL_RATE_CODE_MISSING',
          category: CATEGORY,
          severity: 'warning',
          subjectType: 'invoice_line',
          subjectId: lineId,
          field: 'rate_code',
          expected: 'invoice line rate code',
          actual: 'missing',
          evidence: [
            structuredRowEvidenceInput({
              evidenceType: 'invoice_line',
              row,
              fieldName: 'rate_code',
              fieldValue: null,
              note: 'Invoice line is missing a rate code.',
            }),
          ],
        }),
      );
    }

    if (!rateCode || !hasUsableRateSchedule) continue;

    if (
      scheduleItem &&
      billedUnit &&
      scheduleItem.unit_type &&
      normalizeCode(billedUnit) !== normalizeCode(scheduleItem.unit_type) &&
      isRuleEnabled(
        input.ruleStateByRuleId,
        'FINANCIAL_UNIT_TYPE_MISMATCH',
      )
    ) {
      findings.push(
        makeFinding({
          projectId: input.project.id,
          ruleId: 'FINANCIAL_UNIT_TYPE_MISMATCH',
          category: CATEGORY,
          severity: 'critical',
          subjectType: 'invoice_line',
          subjectId: lineId,
          field: 'unit_type',
          expected: scheduleItem.unit_type,
          actual: billedUnit,
          evidence: [
            structuredRowEvidenceInput({
              evidenceType: 'invoice_line',
              row,
              fieldName: 'unit_type',
              fieldValue: billedUnit,
              note: 'Invoice line unit type differs from the extracted contract rate unit type.',
            }),
            makeEvidenceInput({
              evidence_type: 'rate_schedule',
              source_document_id: scheduleItem.source_document_id,
              record_id: scheduleItem.record_id,
              field_name: 'unit_type',
              field_value: scheduleItem.unit_type,
              note: 'Matched contract rate schedule unit type.',
            }),
          ],
        }),
      );
    }
  }

  const nte = toNumber(input.factLookups.nteFact?.value ?? null);
  const billedTotal = input.projectTotals.billed_total;

  if (
    nte == null &&
    !rateBasedCeiling &&
    isRuleEnabled(input.ruleStateByRuleId, 'FINANCIAL_NTE_FACT_MISSING')
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'FINANCIAL_NTE_FACT_MISSING',
        category: CATEGORY,
        severity: 'info',
        subjectType: 'project',
        subjectId: input.project.id,
        field: 'nte_amount',
        expected: 'extracted NTE fact',
        actual: 'missing',
        blockedReason: 'NTE not extracted - contract may need review',
        actionEligible: true,
        evidence: input.familyDocumentIds.contract.map((documentId) =>
          makeEvidenceInput({
            evidence_type: 'document',
            source_document_id: documentId,
            record_id: documentId,
            note: 'Contract document linked for NTE extraction.',
          }),
        ),
      }),
    );
  }

  if (nte == null || billedTotal == null) {
    return findings;
  }

  if (
    billedTotal > nte &&
    isRuleEnabled(input.ruleStateByRuleId, 'FINANCIAL_NTE_EXCEEDED')
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'FINANCIAL_NTE_EXCEEDED',
        category: CATEGORY,
        severity: 'critical',
        subjectType: 'project',
        subjectId: input.project.id,
        field: 'billed_total',
        expected: nte,
        actual: billedTotal,
        variance: billedTotal - nte,
        varianceUnit: 'USD',
        evidence: [
          ...invoiceEvidence(input),
          ...((input.factLookups.nteFact?.evidence ?? []).map((evidence) =>
            makeEvidenceInput(evidence),
          )),
        ],
      }),
    );
  } else if (
    billedTotal > nte * 0.8 &&
    isRuleEnabled(input.ruleStateByRuleId, 'FINANCIAL_NTE_APPROACHING')
  ) {
    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'FINANCIAL_NTE_APPROACHING',
        category: CATEGORY,
        severity: 'info',
        subjectType: 'project',
        subjectId: input.project.id,
        field: 'billed_total',
        expected: nte,
        actual: billedTotal,
        variance: nte - billedTotal,
        varianceUnit: 'USD',
        evidence: [
          ...invoiceEvidence(input),
          ...((input.factLookups.nteFact?.evidence ?? []).map((evidence) =>
            makeEvidenceInput(evidence),
          )),
        ],
      }),
    );
  }

  return findings;
}
