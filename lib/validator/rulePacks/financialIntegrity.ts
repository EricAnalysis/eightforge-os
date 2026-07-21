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
  type RateScheduleItem,
  type ValidatorFindingResult,
} from '@/lib/validator/shared';
import {
  billingRateKeyForScheduleItem,
  deriveBillingKeysForInvoiceLine,
} from '@/lib/validator/billingKeys';
import { resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';
import { runRateBasedContractValidationRules } from '@/lib/validator/rulePacks/rateBasedContractValidation';

const CATEGORY = 'financial_integrity';

const INVOICE_LINE_ID_KEYS = ['id', 'invoice_line_id', 'line_id'] as const;
const INVOICE_LINE_INVOICE_NUMBER_KEYS = ['invoice_number', 'invoice_no', 'number'] as const;
const INVOICE_LINE_RATE_CODE_KEYS = [
  'rate_code',
  'contract_rate_code',
  'item_code',
  'service_code',
] as const;
const INVOICE_LINE_DESCRIPTION_KEYS = [
  'description',
  'rate_description',
  'item_description',
  'line_description',
  'service_item',
  'service_description',
  'name',
  'item',
  'rate_raw',
] as const;
const INVOICE_LINE_SERVICE_ITEM_KEYS = [
  'service_item',
  'service_item_code',
  'line_service_item',
] as const;
const INVOICE_LINE_MATERIAL_KEYS = ['material', 'material_type', 'debris_type'] as const;
const INVOICE_LINE_RATE_KEYS = [
  'billed_rate',
  'unit_rate',
  'rate',
  'price',
  'contract_rate',
  'unit_price',
  'bill_rate',
  'rate_amount',
  'amount_per_unit',
  'unit_cost',
  'uom_rate',
] as const;
const INVOICE_LINE_UNIT_KEYS = ['unit_type', 'unit', 'uom'] as const;
const INVOICE_LINE_VALIDATION_TOTAL_KEYS = [
  'line_total',
  'extended_amount',
  'total_amount',
  'amount',
] as const;
const INVOICE_LINE_TOTAL_KEYS = [
  'line_total',
  'extended_amount',
  'total_amount',
  'amount',
  'total',
  'extended_cost',
  'line_amount',
  'net_amount',
] as const;
const INVOICE_LINE_QUANTITY_KEYS = [
  'quantity',
  'qty',
  'billed_quantity',
  'line_quantity',
  'units',
  'unit_count',
  'hours',
  'tons',
  'tonnage',
  'cyd',
] as const;
const INVOICE_TOTAL_KEYS = ['total_amount', 'invoice_total', 'billed_amount'] as const;

function invoiceLineId(row: InvoiceLineRow): string {
  return rowIdentifier(row, INVOICE_LINE_ID_KEYS, 'invoice_line');
}

function hasSuspiciousRateSource(item: RateScheduleItem): boolean {
  const sourceQuality = `${item.source_quality ?? ''} ${item.confidence ?? ''} ${item.source_kind ?? ''}`.toLowerCase();
  return /(?:junk|weak|suspicious|ocr_error|low)/.test(sourceQuality);
}

function lineCategory(row: InvoiceLineRow) {
  return resolveCanonicalRateCategory({
    sourceCategory: readRowString(row, INVOICE_LINE_MATERIAL_KEYS),
    sourceDescriptors: [
      readRowString(row, INVOICE_LINE_SERVICE_ITEM_KEYS),
      readRowString(row, INVOICE_LINE_DESCRIPTION_KEYS),
      readRowString(row, INVOICE_LINE_RATE_CODE_KEYS),
    ],
    existingCanonicalCategory: readRowString(row, ['canonical_category']),
    existingConfidence: readRowNumber(row, ['category_confidence']),
  });
}

function scheduleCategory(item: RateScheduleItem) {
  return resolveCanonicalRateCategory({
    sourceCategory: item.source_category ?? item.material_type,
    sourceDescriptors: [item.service_item ?? null, item.description, item.rate_code],
    existingCanonicalCategory: item.canonical_category,
    existingConfidence: item.category_confidence,
  });
}

function normalizeMatchText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeUnitAlias(value: string | null | undefined): string | null {
  const normalized = normalizeMatchText(value);
  if (!normalized) return null;
  if (['hour', 'hours', 'hr', 'hrs', 'h'].includes(normalized)) return 'hour';
  if (['cubic yard', 'cubic yards', 'cy', 'cyd', 'c y', 'yard', 'yards', 'yd'].includes(normalized)) return 'cubic_yard';
  if (['tree', 'trees'].includes(normalized)) return 'tree';
  if (['stump', 'stumps'].includes(normalized)) return 'stump';
  if (['pound', 'pounds', 'lb', 'lbs'].includes(normalized)) return 'pound';
  if (['unit', 'units', 'ea', 'each'].includes(normalized)) return 'unit';
  if (['ton', 'tons'].includes(normalized)) return 'ton';
  if (['passthrough', 'pass through', 'tipping fee', 'tipping fees'].includes(normalized)) return 'passthrough';
  return normalized;
}

function inferUnitAliasFromText(value: string | null | undefined): string | null {
  const text = normalizeMatchText(value);
  if (!text) return null;
  if (/\b(?:hour|hours|hr|hrs|h)\b/.test(text)) return 'hour';
  if (/\b(?:cubic yard|cubic yards|cy|cyd|yard|yards|yd)\b/.test(text)) return 'cubic_yard';
  if (/\btrees?\b/.test(text)) return 'tree';
  if (/\bstumps?\b/.test(text)) return 'stump';
  if (/\b(?:pound|pounds|lb|lbs)\b/.test(text)) return 'pound';
  if (/\b(?:unit|units|ea|each)\b/.test(text)) return 'unit';
  if (/\btons?\b/.test(text)) return 'ton';
  if (/\b(?:passthrough|pass through|tipping fees?)\b/.test(text)) return 'passthrough';
  return null;
}

export function isRateCodeMissingInformational(params: {
  invoiceLine: InvoiceLineRow;
  matchedContractRate: RateScheduleItem | null;
  matchConfidence?: number | null;
  descriptionMatched?: boolean;
  unitMatched?: boolean;
  rateMatched?: boolean;
  categoryMatched?: boolean;
}): boolean {
  const item = params.matchedContractRate;
  if (!item) return false;
  if (!item.source_document_id || !item.record_id) return false;
  if (hasSuspiciousRateSource(item)) return false;

  const lineDescription = readRowString(params.invoiceLine, INVOICE_LINE_DESCRIPTION_KEYS);
  const lineServiceItem = readRowString(params.invoiceLine, INVOICE_LINE_SERVICE_ITEM_KEYS);
  const lineMaterial = readRowString(params.invoiceLine, INVOICE_LINE_MATERIAL_KEYS);
  const lineUnit = readRowString(params.invoiceLine, INVOICE_LINE_UNIT_KEYS);
  const lineRate = readRowNumber(params.invoiceLine, INVOICE_LINE_RATE_KEYS);
  const lineKeys = deriveBillingKeysForInvoiceLine({
    rate_code: null,
    description: lineDescription,
    service_item: lineServiceItem,
    material: lineMaterial,
  });
  const lineCategoryResult = lineCategory(params.invoiceLine);
  const itemCategoryResult = scheduleCategory(item);
  const scheduleKey = billingRateKeyForScheduleItem(item);
  const normalizedLineDescriptors = [
    normalizeMatchText(lineDescription),
    normalizeMatchText(lineServiceItem),
  ].filter((value): value is string => value != null);
  const normalizedScheduleDescriptors = [
    normalizeMatchText(item.description),
    normalizeMatchText(item.service_item),
    normalizeMatchText(item.source_category ?? item.material_type),
  ].filter((value): value is string => value != null);
  const descriptionMatched =
    params.descriptionMatched
    ?? (
      (
        lineKeys.billing_rate_key != null
        && scheduleKey != null
        && lineKeys.billing_rate_key === scheduleKey
      )
      || normalizedLineDescriptors.some((lineValue) =>
        normalizedScheduleDescriptors.some((scheduleValue) => (
          lineValue === scheduleValue
          || lineValue.includes(scheduleValue)
          || scheduleValue.includes(lineValue)
        )),
      )
    );
  const rateMatched =
    params.rateMatched
    ?? (
      lineRate != null
      && item.rate_amount != null
      && Math.abs(lineRate - item.rate_amount) <= 0.01
    );
  const categoryMatched =
    params.categoryMatched
    ?? (
      lineCategoryResult.canonical_category != null
      && itemCategoryResult.canonical_category != null
      && lineCategoryResult.canonical_category === itemCategoryResult.canonical_category
    );
  const unitMatched =
    params.unitMatched
    ?? (() => {
      if (item.unit_type == null) return false;
      const itemUnit = normalizeUnitAlias(item.unit_type);
      const explicitLineUnit = normalizeUnitAlias(lineUnit);
      const inferredLineUnit =
        explicitLineUnit
        ?? inferUnitAliasFromText(lineDescription)
        ?? inferUnitAliasFromText(lineServiceItem);

      if (lineUnit != null && normalizeCode(lineUnit) === normalizeCode(item.unit_type)) {
        return true;
      }
      if (itemUnit != null && inferredLineUnit === itemUnit) {
        return true;
      }

      return lineUnit == null && (descriptionMatched || categoryMatched);
    })();
  const matchConfidence =
    params.matchConfidence
    ?? lineCategoryResult.category_confidence
    ?? itemCategoryResult.category_confidence
    ?? null;

  return (
    descriptionMatched
    && unitMatched
    && rateMatched
    && categoryMatched
    && (matchConfidence == null || matchConfidence >= 0.7)
  );
}

function invoiceEvidence(input: ProjectValidatorInput) {
  if (input.invoiceLines.length > 0) {
    return input.invoiceLines.slice(0, 5).map((row) =>
      structuredRowEvidenceInput({
        evidenceType: 'invoice_line',
        row,
        fieldName: 'line_total',
        fieldValue: readRowNumber(row, INVOICE_LINE_VALIDATION_TOTAL_KEYS),
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

function invoiceLineBusinessEvidence(row: InvoiceLineRow) {
  const fields = [
    {
      fieldName: 'invoice_number',
      fieldValue: readRowString(row, INVOICE_LINE_INVOICE_NUMBER_KEYS),
      note: 'Invoice number retained from the invoice line.',
    },
    {
      fieldName: 'description',
      fieldValue: readRowString(row, INVOICE_LINE_DESCRIPTION_KEYS),
      note: 'Description retained from the invoice line.',
    },
    {
      fieldName: 'quantity',
      fieldValue: readRowNumber(row, INVOICE_LINE_QUANTITY_KEYS),
      note: 'Quantity retained from the invoice line.',
    },
    {
      fieldName: 'unit_price',
      fieldValue: readRowNumber(row, INVOICE_LINE_RATE_KEYS),
      note: 'Unit price retained from the invoice line.',
    },
    {
      fieldName: 'line_total',
      fieldValue: readRowNumber(row, INVOICE_LINE_TOTAL_KEYS),
      note: 'Line total retained from the invoice line.',
    },
  ] as const;

  return fields.flatMap(({ fieldName, fieldValue, note }) => (
    fieldValue == null
      ? []
      : [structuredRowEvidenceInput({
        evidenceType: 'invoice_line',
        row,
        fieldName,
        fieldValue,
        note,
      })]
  ));
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
      scheduleItem?.match_source_kind !== 'manual_link' &&
      isRuleEnabled(
        input.ruleStateByRuleId,
        'FINANCIAL_RATE_CODE_MISSING',
      )
    ) {
      const informational = isRateCodeMissingInformational({
        invoiceLine: row,
        matchedContractRate: scheduleItem,
      });

      findings.push(
        makeFinding({
          projectId: input.project.id,
          ruleId: 'FINANCIAL_RATE_CODE_MISSING',
          category: CATEGORY,
          severity: informational ? 'info' : 'warning',
          subjectType: 'invoice_line',
          subjectId: lineId,
          field: 'rate_code',
          expected: 'invoice line rate code',
          actual: 'missing',
          decisionEligible: informational ? false : undefined,
          actionEligible: informational ? false : undefined,
          evidence: [
            ...invoiceLineBusinessEvidence(row),
            structuredRowEvidenceInput({
              evidenceType: 'invoice_line',
              row,
              fieldName: 'rate_code',
              fieldValue: null,
              note: informational
                ? 'Invoice line is missing a rate code, but description, unit, rate, category, and contract source evidence support a confident semantic match.'
                : 'Invoice line is missing a rate code.',
            }),
            ...(informational && scheduleItem
              ? [makeEvidenceInput({
                evidence_type: 'rate_schedule',
                source_document_id: scheduleItem.source_document_id,
                record_id: scheduleItem.record_id,
                field_name: 'rate_code',
                field_value: {
                  rate_code: scheduleItem.rate_code,
                  unit_type: scheduleItem.unit_type,
                  rate_amount: scheduleItem.rate_amount,
                  canonical_category: scheduleItem.canonical_category,
                },
                note: 'Matched governing contract rate row used to downgrade missing invoice rate code to informational audit context.',
              })]
              : []),
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
            ...invoiceLineBusinessEvidence(row),
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
