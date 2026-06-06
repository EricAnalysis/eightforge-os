import {
  deriveBillingKeysForInvoiceLine,
  deriveBillingKeysForTransactionRecord,
  deriveInvoiceRateKey,
  indexRateScheduleItemsByCanonicalKeys,
  matchRateScheduleItemForInvoiceLine,
  normalizeInvoiceNumber,
} from '@/lib/validator/billingKeys';
import {
  hasConfidentCanonicalRateCategory,
  resolveCanonicalRateCategory,
  type CanonicalRateCategoryBasis,
} from '@/lib/validator/rateTaxonomy';
import {
  isRuleEnabled,
  makeEvidenceInput,
  makeFinding,
  readRowNumber,
  readRowString,
  rowIdentifier,
  structuredRowEvidenceInput,
  type FindingEvidenceInput,
  type InvoiceLineRow,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type StructuredRow,
  type ValidatorFindingResult,
  type ValidatorTransactionDataRow,
} from '@/lib/validator/shared';
import type {
  CrossDocumentRateComparisonStatus,
  CrossDocumentRateSupportBasis,
  CrossDocumentRateValidationUnit,
  CrossDocumentRateVerificationSummary,
} from '@/types/validator';

const CATEGORY = 'financial_integrity';
const RATE_TOLERANCE = 0.01;

const INVOICE_LINE_ID_KEYS = ['id', 'invoice_line_id', 'line_id'] as const;
const INVOICE_LINE_INVOICE_NUMBER_KEYS = ['invoice_number', 'invoice_no', 'number'] as const;
const INVOICE_LINE_RATE_CODE_KEYS = [
  'rate_code',
  'contract_rate_code',
  'item_code',
  'service_code',
  'line_code',
  'service_item_code',
  'code',
  'clin',
  'rate_item_code',
  'line_item_code',
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
  'rate_raw',
] as const;
const INVOICE_LINE_UNIT_KEYS = ['unit_type', 'unit', 'uom', 'unit_of_measure'] as const;
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
const INVOICE_LINE_TOTAL_KEYS = [
  'line_total',
  'extended_amount',
  'extended_cost',
  'total',
  'amount',
  'line_amount',
] as const;

const TICKET_QUANTITY_KEYS = [
  'quantity_cyd',
  'quantity_cy',
  'quantityCY',
  'quantity',
  'qty',
  'units',
] as const;

const MOBILE_TICKET_MATERIAL_KEYS = ['material', 'material_type', 'debris_type'] as const;
const MOBILE_UNIT_SERVICE_ITEM_KEYS = [
  'service_item',
  'service_item_code',
  'line_service_item',
  'source_work_descriptor',
] as const;

type CanonicalInvoiceLine = {
  line_id: string;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  source_document_id: string | null;
  rate_code: string | null;
  description: string | null;
  service_item: string | null;
  material: string | null;
  billing_rate_key: string | null;
  invoice_rate_key: string | null;
  invoice_rate: number | null;
  unit_type: string | null;
  quantity: number | null;
  line_total: number | null;
  canonical_category: string | null;
  category_confidence: number | null;
  category_basis: CanonicalRateCategoryBasis;
  row: InvoiceLineRow;
};

type CanonicalSupportRow = {
  row_id: string;
  document_id: string | null;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  billing_rate_key: string | null;
  invoice_rate_key: string | null;
  source_family: 'mobile_ticket' | 'mobile_unit_ticket' | 'transaction_data';
  source_descriptor: string | null;
  material: string | null;
  service_item: string | null;
  quantity: number | null;
  canonical_category: string | null;
  category_confidence: number | null;
  row: StructuredRow | ValidatorTransactionDataRow;
};

type SupportMatch = {
  rows: CanonicalSupportRow[];
  support_basis: CrossDocumentRateSupportBasis;
};

export type CrossDocumentRateVerificationResult = {
  findings: ValidatorFindingResult[];
  summary: CrossDocumentRateVerificationSummary;
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  ).sort((left, right) => left.localeCompare(right, 'en-US'));
}

function recordString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function recordId(row: StructuredRow | ValidatorTransactionDataRow): string | null {
  const record = row as Record<string, unknown>;
  return recordString(record.id)
    ?? recordString(record.invoice_line_id)
    ?? recordString(record.mobile_ticket_id)
    ?? recordString(record.load_ticket_id)
    ?? recordString(record.transaction_number)
    ?? null;
}

function canonicalizeInvoiceLine(row: InvoiceLineRow): CanonicalInvoiceLine {
  const rateCode = readRowString(row, INVOICE_LINE_RATE_CODE_KEYS);
  const description = readRowString(row, INVOICE_LINE_DESCRIPTION_KEYS);
  const serviceItem = readRowString(row, INVOICE_LINE_SERVICE_ITEM_KEYS);
  const material = readRowString(row, INVOICE_LINE_MATERIAL_KEYS);
  const unitType = readRowString(row, INVOICE_LINE_UNIT_KEYS);
  const invoiceNumber = readRowString(row, INVOICE_LINE_INVOICE_NUMBER_KEYS);
  const keys = deriveBillingKeysForInvoiceLine({
    rate_code: rateCode,
    description,
    service_item: serviceItem,
    material,
  });
  const categoryResolution = resolveCanonicalRateCategory({
    sourceCategory: material,
    sourceDescriptors: [serviceItem, description, rateCode],
    existingCanonicalCategory: readRowString(row, ['canonical_category']),
    existingConfidence: readRowNumber(row, ['category_confidence']),
  });

  return {
    line_id: rowIdentifier(row, INVOICE_LINE_ID_KEYS, 'invoice_line'),
    invoice_number: invoiceNumber,
    normalized_invoice_number: normalizeInvoiceNumber(invoiceNumber),
    source_document_id: readRowString(row, ['source_document_id', 'document_id']),
    rate_code: rateCode,
    description,
    service_item: serviceItem,
    material,
    billing_rate_key: readRowString(row, ['billing_rate_key']) ?? keys.billing_rate_key,
    invoice_rate_key:
      readRowString(row, ['invoice_rate_key'])
      ?? deriveInvoiceRateKey(invoiceNumber, keys.billing_rate_key),
    invoice_rate: readRowNumber(row, INVOICE_LINE_RATE_KEYS),
    unit_type: unitType,
    quantity: readRowNumber(row, INVOICE_LINE_QUANTITY_KEYS),
    line_total: readRowNumber(row, INVOICE_LINE_TOTAL_KEYS),
    canonical_category: categoryResolution.canonical_category,
    category_confidence: categoryResolution.category_confidence,
    category_basis: categoryResolution.basis,
    row,
  };
}

function contractCategoryResolution(item: RateScheduleItem | null) {
  if (!item) {
    return resolveCanonicalRateCategory({});
  }

  return resolveCanonicalRateCategory({
    sourceCategory: item.source_category ?? item.material_type,
    sourceDescriptors: [item.service_item ?? null, item.description, item.rate_code],
    existingCanonicalCategory: item.canonical_category,
    existingConfidence: item.category_confidence,
  });
}

function supportRowCategory(params: {
  sourceFamily: CanonicalSupportRow['source_family'];
  material: string | null;
  serviceItem: string | null;
  sourceDescriptor: string | null;
}) {
  return resolveCanonicalRateCategory({
    sourceCategory:
      params.sourceFamily === 'mobile_ticket'
        ? params.material
        : null,
    sourceDescriptors:
      params.sourceFamily === 'mobile_unit_ticket'
        ? [params.serviceItem, params.sourceDescriptor]
        : [params.material, params.sourceDescriptor],
  });
}

function canonicalizeTicketRow(
  row: StructuredRow,
  sourceFamily: 'mobile_ticket' | 'mobile_unit_ticket',
): CanonicalSupportRow {
  const invoiceNumber = readRowString(row, INVOICE_LINE_INVOICE_NUMBER_KEYS);
  const rateCode = readRowString(row, INVOICE_LINE_RATE_CODE_KEYS);
  const material = readRowString(row, MOBILE_TICKET_MATERIAL_KEYS);
  const serviceItem = readRowString(row, MOBILE_UNIT_SERVICE_ITEM_KEYS);
  const sourceDescriptor =
    sourceFamily === 'mobile_unit_ticket'
      ? serviceItem
      : material;
  const billingKeys = deriveBillingKeysForInvoiceLine({
    rate_code: rateCode,
    description: readRowString(row, ['description', 'rate_description', 'contract_line_item']),
    service_item: serviceItem,
    material,
  });
  const categoryResolution = supportRowCategory({
    sourceFamily,
    material,
    serviceItem,
    sourceDescriptor,
  });

  return {
    row_id:
      recordString(row.id)
      ?? rowIdentifier(
        row,
        sourceFamily === 'mobile_unit_ticket'
          ? ['load_ticket_id', 'ticket_id', 'ticket_number']
          : ['mobile_ticket_id', 'ticket_id', 'ticket_number'],
        sourceFamily,
      ),
    document_id: readRowString(row, ['source_document_id', 'document_id']),
    invoice_number: invoiceNumber,
    normalized_invoice_number: normalizeInvoiceNumber(invoiceNumber),
    billing_rate_key: readRowString(row, ['billing_rate_key']) ?? billingKeys.billing_rate_key,
    invoice_rate_key:
      readRowString(row, ['invoice_rate_key'])
      ?? deriveInvoiceRateKey(invoiceNumber, billingKeys.billing_rate_key),
    source_family: sourceFamily,
    source_descriptor: sourceDescriptor,
    material,
    service_item: serviceItem,
    quantity: readRowNumber(row, TICKET_QUANTITY_KEYS),
    canonical_category: categoryResolution.canonical_category,
    category_confidence: categoryResolution.category_confidence,
    row,
  };
}

function canonicalizeTransactionRow(row: ValidatorTransactionDataRow): CanonicalSupportRow {
  const recordJson = row.record_json ?? {};
  const material = recordString(recordJson.material);
  const serviceItem = recordString(recordJson.service_item);
  const rateDescription = recordString(recordJson.rate_description);
  const keys = deriveBillingKeysForTransactionRecord({
    invoice_number: row.invoice_number,
    rate_code: row.rate_code,
    rate_description: rateDescription,
    service_item: serviceItem,
    material,
  });
  const categoryResolution = resolveCanonicalRateCategory({
    sourceCategory: material,
    sourceDescriptors: [serviceItem, rateDescription, row.rate_code],
  });

  return {
    row_id: row.id,
    document_id: row.document_id,
    invoice_number: row.invoice_number,
    normalized_invoice_number: normalizeInvoiceNumber(row.invoice_number),
    billing_rate_key: row.billing_rate_key ?? keys.billing_rate_key,
    invoice_rate_key: row.invoice_rate_key ?? keys.invoice_rate_key,
    source_family: 'transaction_data',
    source_descriptor: serviceItem ?? material ?? rateDescription ?? row.rate_code,
    material,
    service_item: serviceItem,
    quantity: row.transaction_quantity,
    canonical_category: categoryResolution.canonical_category,
    category_confidence: categoryResolution.category_confidence,
    row,
  };
}

function buildSupportRows(input: ProjectValidatorInput): CanonicalSupportRow[] {
  return [
    ...input.mobileTickets.map((row) => canonicalizeTicketRow(row, 'mobile_ticket')),
    ...input.loadTickets.map((row) => canonicalizeTicketRow(row, 'mobile_unit_ticket')),
    ...(input.transactionData?.rows ?? []).map(canonicalizeTransactionRow),
  ];
}

function supportCategories(rows: readonly CanonicalSupportRow[]): string[] {
  return uniqueStrings(
    rows
      .filter((row) => hasConfidentCanonicalRateCategory(row))
      .map((row) => row.canonical_category),
  );
}

function chooseSupportRows(
  line: CanonicalInvoiceLine,
  supportRows: readonly CanonicalSupportRow[],
): SupportMatch {
  const sameInvoice = supportRows.filter((row) => (
    line.normalized_invoice_number != null
    && row.normalized_invoice_number === line.normalized_invoice_number
  ));

  const invoiceRateRows = sameInvoice.filter((row) => (
    line.invoice_rate_key != null
    && row.invoice_rate_key === line.invoice_rate_key
  ));
  if (invoiceRateRows.length > 0) {
    return { rows: invoiceRateRows, support_basis: 'invoice_linked' };
  }

  const invoiceCategoryRows = sameInvoice.filter((row) => (
    line.canonical_category != null
    && row.canonical_category === line.canonical_category
  ));
  if (invoiceCategoryRows.length > 0) {
    return { rows: invoiceCategoryRows, support_basis: 'invoice_linked' };
  }

  const billingKeyRows = supportRows.filter((row) => (
    line.billing_rate_key != null
    && row.billing_rate_key === line.billing_rate_key
    && line.normalized_invoice_number != null
    && row.normalized_invoice_number === line.normalized_invoice_number
  ));
  if (billingKeyRows.length > 0) {
    return { rows: billingKeyRows, support_basis: 'billing_key_fallback' };
  }

  const projectCategoryRows = supportRows.filter((row) => (
    line.canonical_category != null
    && row.canonical_category === line.canonical_category
  ));
  if (projectCategoryRows.length > 0) {
    return { rows: projectCategoryRows, support_basis: 'project_level' };
  }

  return { rows: [], support_basis: 'none' };
}

function canonicalCategoriesAlign(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left === right;
}

function classifyComparison(params: {
  line: CanonicalInvoiceLine;
  contractItem: RateScheduleItem | null;
  supportMatch: SupportMatch;
  supportCategories: readonly string[];
}): {
  status: CrossDocumentRateComparisonStatus;
  reason: string;
} {
  const invoiceCategoryKnown = hasConfidentCanonicalRateCategory(params.line);
  const contractCategory = contractCategoryResolution(params.contractItem);
  const contractCategoryKnown = hasConfidentCanonicalRateCategory(contractCategory);
  const lineCategory = params.line.canonical_category;
  const contractCanonicalCategory = contractCategory.canonical_category;
  const supportConfirmsLineCategory =
    lineCategory != null
    && params.supportCategories.includes(lineCategory);

  if (!invoiceCategoryKnown) {
    return {
      status: 'needs_review',
      reason: 'Invoice line category could not be resolved confidently through the shared taxonomy.',
    };
  }

  if (!params.contractItem) {
    return {
      status: params.supportMatch.rows.length > 0 ? 'missing_contract_rate' : 'unsupported_work',
      reason:
        params.supportMatch.rows.length > 0
          ? 'Invoice work has support data but no matching governing contract rate row.'
          : 'Invoice work has neither a matching governing contract rate row nor support data.',
    };
  }

  if (!contractCategoryKnown) {
    return {
      status: 'needs_review',
      reason: 'Contract rate row category could not be resolved confidently through the shared taxonomy.',
    };
  }

  const ratesAlign =
    params.line.invoice_rate != null
    && params.contractItem.rate_amount != null
    && Math.abs(params.line.invoice_rate - params.contractItem.rate_amount) <= RATE_TOLERANCE;

  if (
    !canonicalCategoriesAlign(lineCategory, contractCanonicalCategory)
    && !(ratesAlign && supportConfirmsLineCategory)
  ) {
    return {
      status: 'category_mismatch',
      reason: 'Invoice line category does not match the governing contract rate category.',
    };
  }

  if (params.line.invoice_rate != null && params.contractItem.rate_amount != null) {
    const rateDelta = Math.abs(params.line.invoice_rate - params.contractItem.rate_amount);
    if (rateDelta > RATE_TOLERANCE) {
      return {
        status: 'rate_mismatch',
        reason: 'Invoice unit rate does not match the governing contract rate.',
      };
    }
  }

  if (params.supportMatch.rows.length === 0) {
    return {
      status: 'missing_support',
      reason: 'Invoice and contract categories align, but no ticket or transaction support was found.',
    };
  }

  if (params.supportCategories.length === 0) {
    return {
      status: 'needs_review',
      reason: 'Support rows exist but their categories could not be resolved confidently.',
    };
  }

  if (!supportConfirmsLineCategory) {
    return {
      status: 'category_mismatch',
      reason: 'Ticket support resolves to a different canonical work category than the invoice line.',
    };
  }

  return {
    status: 'match',
    reason: 'Contract rate, invoice rate, and ticket support align through the shared canonical category.',
  };
}

function contractEvidence(item: RateScheduleItem | null): FindingEvidenceInput[] {
  if (!item) return [];

  const rawValue =
    item.raw_value != null
    && typeof item.raw_value === 'object'
    && !Array.isArray(item.raw_value)
      ? item.raw_value as Record<string, unknown>
      : null;

  return [
    makeEvidenceInput({
      evidence_type: 'rate_schedule',
      source_document_id: item.source_document_id,
      source_page:
        typeof rawValue?.source_page === 'number'
          ? rawValue.source_page
          : typeof rawValue?.page === 'number'
            ? rawValue.page
            : null,
      record_id: item.record_id,
      field_name: 'canonical_category',
      field_value: {
        canonical_category: item.canonical_category,
        rate_amount: item.rate_amount,
        source_category: item.source_category ?? item.material_type,
      },
      note: 'Governing contract rate row used in cross-document rate verification.',
    }),
  ];
}

function supportEvidence(rows: readonly CanonicalSupportRow[]): FindingEvidenceInput[] {
  return rows.slice(0, 8).map((row) =>
    makeEvidenceInput({
      evidence_type: row.source_family === 'transaction_data' ? 'transaction_row' : row.source_family,
      source_document_id: row.document_id,
      record_id: row.row_id,
      field_name: 'canonical_category',
      field_value: {
        canonical_category: row.canonical_category,
        source_descriptor: row.source_descriptor,
        quantity: row.quantity,
      },
      note: 'Ticket or transaction support row used in cross-document rate verification.',
    }),
  );
}

function findingForUnit(
  input: ProjectValidatorInput,
  unit: CrossDocumentRateValidationUnit,
  line: CanonicalInvoiceLine,
  contractItem: RateScheduleItem | null,
  supportRows: readonly CanonicalSupportRow[],
): ValidatorFindingResult | null {
  if (unit.comparison_status === 'match') return null;

  const ruleByStatus: Record<Exclude<CrossDocumentRateComparisonStatus, 'match'>, {
    ruleId: string;
    severity: 'critical' | 'warning';
    field: string;
    expected: unknown;
    actual: unknown;
  }> = {
    rate_mismatch: {
      ruleId: 'CROSS_DOCUMENT_RATE_MATCHES_CONTRACT',
      severity: 'critical',
      field: 'invoice_rate',
      expected: unit.contract_rate,
      actual: unit.invoice_rate,
    },
    category_mismatch: {
      ruleId: 'CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS',
      severity: 'critical',
      field: 'canonical_category',
      expected: unit.canonical_category,
      actual:
        unit.support_observed_categories.length > 0
          ? unit.support_observed_categories.join(', ')
          : contractCategoryResolution(contractItem).canonical_category
            ?? unit.contract_source_category,
    },
    missing_contract_rate: {
      ruleId: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
      severity: 'critical',
      field: 'contract_rate',
      expected: 'Confirmed contract schedule row for this billed line',
      actual: 'No confident contract rate-row match found',
    },
    missing_support: {
      ruleId: 'CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS',
      severity: 'warning',
      field: 'support_rows',
      expected: 'ticket or transaction support',
      actual: 'missing',
    },
    unsupported_work: {
      ruleId: 'CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED',
      severity: 'critical',
      field: 'invoice_line_support',
      expected: 'contract rate and support work',
      actual: 'missing',
    },
    needs_review: {
      ruleId: 'CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW',
      severity: 'warning',
      field: 'canonical_category',
      expected: 'confident canonical category',
      actual: unit.canonical_category ?? 'unresolved',
    },
  };

  const config = ruleByStatus[unit.comparison_status];
  if (!isRuleEnabled(input.ruleStateByRuleId, config.ruleId)) return null;

  const invoiceLineContextEvidence = [
    structuredRowEvidenceInput({
      evidenceType: 'invoice_line',
      row: line.row,
      fieldName: 'invoice_number',
      fieldValue: line.invoice_number,
      note: 'Invoice number for the billed line evaluated through cross-document rate verification.',
    }),
    structuredRowEvidenceInput({
      evidenceType: 'invoice_line',
      row: line.row,
      fieldName: 'rate_code',
      fieldValue: line.rate_code,
      note: 'Invoice line rate code evaluated against the governing contract schedule.',
    }),
    structuredRowEvidenceInput({
      evidenceType: 'invoice_line',
      row: line.row,
      fieldName: 'description',
      fieldValue: line.description,
      note: 'Invoice line description evaluated against the governing contract schedule.',
    }),
    structuredRowEvidenceInput({
      evidenceType: 'invoice_line',
      row: line.row,
      fieldName: 'quantity',
      fieldValue: line.quantity,
      note: 'Invoice line quantity retained as context only for the contract rate match finding.',
    }),
    structuredRowEvidenceInput({
      evidenceType: 'invoice_line',
      row: line.row,
      fieldName: 'unit_price',
      fieldValue: line.invoice_rate,
      note: 'Invoice unit price retained as context only for the contract rate match finding.',
    }),
    structuredRowEvidenceInput({
      evidenceType: 'invoice_line',
      row: line.row,
      fieldName: 'line_total',
      fieldValue: line.line_total,
      note: 'Invoice line total retained as context only for the contract rate match finding.',
    }),
  ];

  return makeFinding({
    projectId: input.project.id,
    ruleId: config.ruleId,
    category: CATEGORY,
    severity: config.severity,
    subjectType: 'invoice_line',
    subjectId: line.line_id,
    field: config.field,
    expected: config.expected,
    actual: config.actual,
    evidence: [
      ...invoiceLineContextEvidence,
      structuredRowEvidenceInput({
        evidenceType: 'invoice_line',
        row: line.row,
        fieldName: 'canonical_category',
        fieldValue: {
          canonical_category: line.canonical_category,
          invoice_rate: line.invoice_rate,
          description: line.description,
        },
        note: 'Invoice line evaluated through cross-document rate verification.',
      }),
      ...contractEvidence(contractItem),
      ...supportEvidence(supportRows),
    ],
  });
}

function buildSummary(
  units: CrossDocumentRateValidationUnit[],
): CrossDocumentRateVerificationSummary {
  return {
    comparable_units: units.length,
    matched_units: units.filter((unit) => unit.comparison_status === 'match').length,
    rate_mismatch_units: units.filter((unit) => unit.comparison_status === 'rate_mismatch').length,
    category_mismatch_units: units.filter((unit) => unit.comparison_status === 'category_mismatch').length,
    missing_contract_rate_units: units.filter((unit) => unit.comparison_status === 'missing_contract_rate').length,
    missing_support_units: units.filter((unit) => unit.comparison_status === 'missing_support').length,
    unsupported_work_units: units.filter((unit) => unit.comparison_status === 'unsupported_work').length,
    needs_review_units: units.filter((unit) => unit.comparison_status === 'needs_review').length,
    validation_units: units,
  };
}

export function evaluateCrossDocumentRateVerification(
  input: ProjectValidatorInput,
): CrossDocumentRateVerificationResult {
  const findings: ValidatorFindingResult[] = [];
  const invoiceLines = input.invoiceLines.map(canonicalizeInvoiceLine);
  const scheduleIndex = indexRateScheduleItemsByCanonicalKeys(input.factLookups.rateScheduleItems);
  const supportRows = buildSupportRows(input);
  const units: CrossDocumentRateValidationUnit[] = [];

  for (const line of invoiceLines) {
    const match = matchRateScheduleItemForInvoiceLine({
      rate_code: line.rate_code,
      description: line.description,
      service_item: line.service_item,
      material: line.material,
      unit_price: line.invoice_rate,
      unit_type: line.unit_type,
      canonical_category: line.canonical_category,
      quantity: line.quantity,
      line_total: line.line_total,
      billing_rate_key: line.billing_rate_key,
    }, scheduleIndex);
    const contractItem = match.match ?? null;
    const supportMatch = chooseSupportRows(line, supportRows);
    const observedSupportCategories = supportCategories(supportMatch.rows);
    const classification = classifyComparison({
      line,
      contractItem,
      supportMatch,
      supportCategories: observedSupportCategories,
    });
    const contractCategory = contractCategoryResolution(contractItem);
    const supportQuantity = supportMatch.rows.reduce((sum, row) => sum + (row.quantity ?? 0), 0);

    const unit: CrossDocumentRateValidationUnit = {
      validation_unit_id: `cross_rate:${line.line_id}`,
      invoice_line_id: line.line_id,
      invoice_number: line.invoice_number,
      billing_rate_key: line.billing_rate_key,
      canonical_category: line.canonical_category,
      category_confidence: line.category_confidence,
      category_basis: line.category_basis,
      invoice_source_descriptor: line.service_item ?? line.description ?? line.rate_code,
      invoice_rate: line.invoice_rate,
      contract_rate_found: contractItem != null,
      contract_rate: contractItem?.rate_amount ?? null,
      contract_source_category: contractItem?.source_category ?? contractItem?.material_type ?? null,
      contract_source_descriptor: contractItem?.description ?? contractItem?.rate_code ?? null,
      supported_quantity: supportMatch.rows.length > 0 ? Number(supportQuantity.toFixed(4)) : null,
      support_row_count: supportMatch.rows.length,
      support_basis: supportMatch.support_basis,
      support_families: uniqueStrings(supportMatch.rows.map((row) => row.source_family)),
      support_observed_categories: observedSupportCategories,
      comparison_status: classification.status,
      reason: classification.reason,
      source_documents: {
        invoice_document_id: line.source_document_id,
        contract_document_ids: uniqueStrings(contractItem ? [contractItem.source_document_id] : []),
        support_document_ids: uniqueStrings(supportMatch.rows.map((row) => row.document_id)),
      },
      source_rows: {
        invoice_record_id: recordId(line.row) ?? line.line_id,
        contract_record_ids: uniqueStrings(contractItem ? [contractItem.record_id] : []),
        support_record_ids: uniqueStrings(supportMatch.rows.map((row) => row.row_id)),
      },
    };

    // Preserve the contract category calculation in the unit metadata when the invoice
    // category is unresolved but the contract side is known.
    if (unit.canonical_category == null && contractCategory.canonical_category != null) {
      unit.canonical_category = contractCategory.canonical_category;
      unit.category_confidence = contractCategory.category_confidence;
    }

    units.push(unit);

    const finding = findingForUnit(
      input,
      unit,
      line,
      contractItem,
      supportMatch.rows,
    );
    if (finding) findings.push(finding);
  }

  return {
    findings,
    summary: buildSummary(units),
  };
}
