import {
  deriveBillingKeysForInvoiceLine,
  deriveBillingKeysForTransactionRecord,
  deriveInvoiceRateKey,
  normalizeInvoiceNumber,
} from '@/lib/validator/billingKeys';
import {
  findFirstNumberFact,
  makeEvidenceInput,
  makeFinding,
  readRowNumber,
  readRowString,
  resolveRuleTolerance,
  rowIdentifier,
  structuredRowEvidenceInput,
  type InvoiceLineRow,
  type InvoiceRow,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type ValidatorFindingResult,
  type ValidatorTransactionDataRow,
} from '@/lib/validator/shared';
import type {
  ContractInvoiceReconciliationStatus,
  InvoiceExposureSummary,
  ProjectExposureSummary,
} from '@/types/validator';

const CATEGORY = 'financial_integrity';

const INVOICE_ID_KEYS = ['id', 'invoice_id'] as const;
const INVOICE_NUMBER_KEYS = ['invoice_number', 'invoice_no', 'number'] as const;
const INVOICE_TOTAL_KEYS = [
  'total_amount',
  'invoice_total',
  'billed_amount',
  'current_amount_due',
  'amount_due',
  'subtotal',
  'net_amount',
  'currentPaymentDue',
  'total',
  'amount',
] as const;
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

const PROJECT_EXPOSURE_SUPPORTED_RULE_ID = 'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED';
const PROJECT_EXPOSURE_AT_RISK_RULE_ID = 'PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO';
const INVOICE_EXPOSURE_SUPPORTED_RULE_ID = 'INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED';
const INVOICE_EXPOSURE_AT_RISK_RULE_ID = 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO';
const INVOICE_BILLED_TOTAL_PRESENT_RULE_ID = 'INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE';

const EXPOSURE_RULE_IDS = new Set([
  PROJECT_EXPOSURE_SUPPORTED_RULE_ID,
  PROJECT_EXPOSURE_AT_RISK_RULE_ID,
  INVOICE_EXPOSURE_SUPPORTED_RULE_ID,
  INVOICE_EXPOSURE_AT_RISK_RULE_ID,
  INVOICE_BILLED_TOTAL_PRESENT_RULE_ID,
]);

type InvoiceLookup = {
  byDocumentId: Map<string, string>;
  byInvoiceId: Map<string, string>;
};

type InvoiceContext = {
  invoice_key: string;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  row: InvoiceRow | null;
  billed_amount: number | null;
  billed_amount_source: InvoiceExposureSummary['billed_amount_source'];
  line_total_sum: number;
  aliases: Set<string>;
  line_ids: Set<string>;
  group_internal_keys: Set<string>;
};

type LineContext = {
  line_id: string;
  invoice_key: string;
  invoice_number: string | null;
  line_total: number | null;
  quantity: number | null;
  quantity_inferred: boolean;
  unit_price: number | null;
  billing_rate_key: string | null;
  invoice_rate_key: string | null;
  group_subject_id: string;
  internal_group_key: string;
  contract_supported: boolean;
  schedule_item: RateScheduleItem | null;
  row: InvoiceLineRow;
};

function resolveInvoiceSourceDocumentId(
  invoice: InvoiceContext,
  lineContexts: Map<string, LineContext>,
): string | null {
  if (invoice.row) {
    const id = readRowString(invoice.row, ['source_document_id', 'document_id']);
    if (id) return id;
  }
  for (const lineId of invoice.line_ids) {
    const line = lineContexts.get(lineId);
    if (!line?.row) continue;
    const id = readRowString(line.row, ['source_document_id', 'document_id']);
    if (id) return id;
  }
  return null;
}

type GroupContext = {
  internal_key: string;
  subject_id: string;
  invoice_key: string;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  billing_rate_key: string | null;
  invoice_rate_key: string | null;
  amount: number;
  quantity: number | null;
  line_ids: string[];
  transaction_supported: boolean;
};

type CanonicalTransactionRow = {
  row_id: string;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  billing_rate_key: string | null;
  invoice_rate_key: string | null;
  transaction_quantity: number | null;
  extended_cost: number | null;
  meaningful_data: boolean;
};

type ExposureAssessment = {
  summary: ProjectExposureSummary | null;
  findings: ValidatorFindingResult[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(2));
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(4));
}

function sumNumbers(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  );
}

function buildInvoiceLookup(invoices: readonly InvoiceRow[]): InvoiceLookup {
  const byDocumentId = new Map<string, string>();
  const byInvoiceId = new Map<string, string>();

  for (const invoice of invoices) {
    const invoiceNumber = readRowString(invoice, INVOICE_NUMBER_KEYS);
    if (!invoiceNumber) continue;

    const sourceDocumentId = readRowString(invoice, ['source_document_id', 'document_id']);
    const invoiceId = readRowString(invoice, INVOICE_ID_KEYS);
    if (sourceDocumentId) byDocumentId.set(sourceDocumentId, invoiceNumber);
    if (invoiceId) byInvoiceId.set(invoiceId, invoiceNumber);
  }

  return { byDocumentId, byInvoiceId };
}

function invoiceKeyFor(params: {
  invoiceNumber?: string | null;
  sourceDocumentId?: string | null;
  invoiceId?: string | null;
  fallback: string;
}): string {
  const normalizedInvoiceNumber = normalizeInvoiceNumber(params.invoiceNumber ?? null);
  if (normalizedInvoiceNumber) return `invoice:${normalizedInvoiceNumber}`;
  if (params.sourceDocumentId) return `document:${params.sourceDocumentId}`;
  if (params.invoiceId) return `row:${params.invoiceId}`;
  return params.fallback;
}

function ensureInvoiceContext(
  contexts: Map<string, InvoiceContext>,
  params: {
    invoiceKey: string;
    invoiceNumber?: string | null;
    row?: InvoiceRow | null;
  },
): InvoiceContext {
  const existing = contexts.get(params.invoiceKey);
  if (existing) return existing;

  const created: InvoiceContext = {
    invoice_key: params.invoiceKey,
    invoice_number: params.invoiceNumber ?? null,
    normalized_invoice_number: normalizeInvoiceNumber(params.invoiceNumber ?? null),
    row: params.row ?? null,
    billed_amount: null,
    billed_amount_source: 'missing',
    line_total_sum: 0,
    aliases: new Set<string>(),
    line_ids: new Set<string>(),
    group_internal_keys: new Set<string>(),
  };
  contexts.set(params.invoiceKey, created);
  return created;
}

function addInvoiceAliases(
  context: InvoiceContext,
  aliasMap: Map<string, string>,
  aliases: Array<string | null | undefined>,
) {
  for (const alias of uniqueStrings(aliases)) {
    context.aliases.add(alias);
    aliasMap.set(alias, context.invoice_key);
    const normalized = normalizeInvoiceNumber(alias);
    if (normalized) {
      context.aliases.add(normalized);
      aliasMap.set(normalized, context.invoice_key);
    }
  }
}

function deriveInvoiceLineQuantity(
  row: InvoiceLineRow,
  unitPrice: number | null,
  lineTotal: number | null,
): { quantity: number | null; inferred: boolean } {
  const explicitQuantity = readRowNumber(row, INVOICE_LINE_QUANTITY_KEYS);
  if (explicitQuantity != null) {
    return { quantity: explicitQuantity, inferred: false };
  }

  if (
    unitPrice != null
    && Math.abs(unitPrice) > 0.000001
    && lineTotal != null
  ) {
    return {
      quantity: roundQuantity(lineTotal / unitPrice),
      inferred: true,
    };
  }

  return { quantity: null, inferred: false };
}

function buildCanonicalTransactionRows(
  rows: readonly ValidatorTransactionDataRow[],
): Map<string, CanonicalTransactionRow> {
  const mapped = new Map<string, CanonicalTransactionRow>();

  for (const row of rows) {
    const recordJson = asRecord(row.record_json) ?? {};
    const invoiceNumber = asString(recordJson.invoice_number) ?? row.invoice_number;
    const derived = deriveBillingKeysForTransactionRecord({
      invoice_number: invoiceNumber,
      rate_code: asString(recordJson.rate_code) ?? row.rate_code,
      rate_description: asString(recordJson.rate_description),
      service_item: asString(recordJson.service_item),
      material: asString(recordJson.material),
      disposal_site: asString(recordJson.disposal_site),
      site_type: asString(recordJson.site_type),
    });
    const billingRateKey = row.billing_rate_key ?? derived.billing_rate_key;
    const invoiceRateKey =
      asString(recordJson.invoice_rate_key)
      ?? deriveInvoiceRateKey(invoiceNumber, billingRateKey)
      ?? derived.invoice_rate_key;
    const transactionQuantity =
      asNumber(recordJson.transaction_quantity) ?? row.transaction_quantity;
    const extendedCost =
      asNumber(recordJson.extended_cost) ?? row.extended_cost;
    const meaningfulData =
      billingRateKey != null
      || invoiceRateKey != null
      || asString(recordJson.transaction_number) != null
      || row.transaction_number != null
      || transactionQuantity != null
      || extendedCost != null;

    mapped.set(row.id, {
      row_id: row.id,
      invoice_number: invoiceNumber,
      normalized_invoice_number: normalizeInvoiceNumber(invoiceNumber),
      billing_rate_key: billingRateKey,
      invoice_rate_key: invoiceRateKey,
      transaction_quantity: transactionQuantity,
      extended_cost: extendedCost,
      meaningful_data: meaningfulData,
    });
  }

  return mapped;
}

function transactionTotals(rows: readonly CanonicalTransactionRow[]): {
  totalCost: number | null;
  totalQuantity: number | null;
  hasAnyQuantity: boolean;
} {
  const presentCosts = rows
    .map((row) => row.extended_cost)
    .filter((value): value is number => value != null);
  const presentQuantities = rows
    .map((row) => row.transaction_quantity)
    .filter((value): value is number => value != null);

  return {
    totalCost:
      presentCosts.length > 0
        ? roundCurrency(sumNumbers(presentCosts))
        : null,
    totalQuantity:
      presentQuantities.length > 0
        ? roundQuantity(sumNumbers(presentQuantities))
        : null,
    hasAnyQuantity: presentQuantities.length > 0,
  };
}

function statusForInvoiceExposure(params: {
  billedAmount: number | null;
  supportedAmount: number;
  atRiskAmount: number;
  supportGapTolerance: number;
  atRiskTolerance: number;
}): ContractInvoiceReconciliationStatus {
  if (params.billedAmount == null) return 'MISSING';

  const unreconciled = Math.max(0, params.billedAmount - params.supportedAmount);
  if (params.atRiskAmount > params.atRiskTolerance) return 'MISMATCH';
  if (unreconciled <= params.supportGapTolerance) return 'MATCH';
  if (params.supportedAmount > params.supportGapTolerance) return 'PARTIAL';
  return 'MISSING';
}

function invoiceRowEvidence(invoice: InvoiceContext | null) {
  return invoice?.row
    ? [
      structuredRowEvidenceInput({
        evidenceType: 'invoice',
        row: invoice.row,
        fieldName: 'billed_amount',
        fieldValue: invoice.billed_amount,
        note: 'Invoice billed amount used for project exposure math.',
      }),
    ]
    : [];
}

function lineEvidence(
  lines: readonly LineContext[],
  note: string,
) {
  return lines.slice(0, 8).map((line) => structuredRowEvidenceInput({
    evidenceType: 'invoice_line',
    row: line.row,
    fieldName: 'line_total',
    fieldValue: line.line_total,
    note,
  }));
}

export function evaluateProjectExposure(
  input: ProjectValidatorInput,
  findings: readonly ValidatorFindingResult[],
): ExposureAssessment {
  const contractRateTolerance = resolveRuleTolerance(
    input.ruleStateByRuleId,
    'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE',
    0.01,
  );
  const transactionCostTolerance = resolveRuleTolerance(
    input.ruleStateByRuleId,
    'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE',
    0.01,
  );
  const transactionQuantityTolerance = resolveRuleTolerance(
    input.ruleStateByRuleId,
    'TRANSACTION_QUANTITY_MATCHES_INVOICE',
    0.001,
  );
  const supportGapTolerance = resolveRuleTolerance(
    input.ruleStateByRuleId,
    PROJECT_EXPOSURE_SUPPORTED_RULE_ID,
    0.01,
  );
  const atRiskTolerance = resolveRuleTolerance(
    input.ruleStateByRuleId,
    PROJECT_EXPOSURE_AT_RISK_RULE_ID,
    0.01,
  );

  const invoiceLookup = buildInvoiceLookup(input.invoices);
  const invoiceContexts = new Map<string, InvoiceContext>();
  const invoiceAliasMap = new Map<string, string>();

  for (let index = 0; index < input.invoices.length; index += 1) {
    const row = input.invoices[index]!;
    const invoiceNumber = readRowString(row, INVOICE_NUMBER_KEYS);
    const sourceDocumentId = readRowString(row, ['source_document_id', 'document_id']);
    const invoiceId = readRowString(row, INVOICE_ID_KEYS);
    const invoiceKey = invoiceKeyFor({
      invoiceNumber,
      sourceDocumentId,
      invoiceId,
      fallback: `invoice:${index + 1}`,
    });
    const context = ensureInvoiceContext(invoiceContexts, {
      invoiceKey,
      invoiceNumber,
      row,
    });
    context.row = row;
    context.invoice_number = invoiceNumber ?? context.invoice_number;
    context.normalized_invoice_number =
      normalizeInvoiceNumber(context.invoice_number) ?? context.normalized_invoice_number;

    addInvoiceAliases(context, invoiceAliasMap, [
      invoiceNumber,
      sourceDocumentId,
      invoiceId,
      context.normalized_invoice_number,
    ]);
  }

  const lineContexts = new Map<string, LineContext>();
  const groupContexts = new Map<string, GroupContext>();
  const groupSubjectIndex = new Map<string, string[]>();
  const billingRateIndex = new Map<string, string[]>();

  for (let index = 0; index < input.invoiceLines.length; index += 1) {
    const row = input.invoiceLines[index]!;
    const lineId = rowIdentifier(row, INVOICE_LINE_ID_KEYS, 'invoice_line');
    const sourceDocumentId = readRowString(row, ['source_document_id', 'document_id']);
    const invoiceId = readRowString(row, ['invoice_id', 'source_invoice_id']);
    const invoiceNumber =
      readRowString(row, INVOICE_LINE_INVOICE_NUMBER_KEYS)
      ?? (sourceDocumentId ? invoiceLookup.byDocumentId.get(sourceDocumentId) ?? null : null)
      ?? (invoiceId ? invoiceLookup.byInvoiceId.get(invoiceId) ?? null : null);
    const invoiceKey = invoiceKeyFor({
      invoiceNumber,
      sourceDocumentId,
      invoiceId,
      fallback: `line:${index + 1}`,
    });
    const invoiceContext = ensureInvoiceContext(invoiceContexts, {
      invoiceKey,
      invoiceNumber,
      row: null,
    });
    invoiceContext.invoice_number = invoiceNumber ?? invoiceContext.invoice_number;
    invoiceContext.normalized_invoice_number =
      normalizeInvoiceNumber(invoiceContext.invoice_number) ?? invoiceContext.normalized_invoice_number;
    invoiceContext.line_ids.add(lineId);
    addInvoiceAliases(invoiceContext, invoiceAliasMap, [
      invoiceNumber,
      sourceDocumentId,
      invoiceId,
      invoiceContext.normalized_invoice_number,
    ]);

    const rateCode = readRowString(row, INVOICE_LINE_RATE_CODE_KEYS);
    const description = readRowString(row, INVOICE_LINE_DESCRIPTION_KEYS);
    const serviceItem = readRowString(row, INVOICE_LINE_SERVICE_ITEM_KEYS);
    const material = readRowString(row, INVOICE_LINE_MATERIAL_KEYS);
    const unitPrice = readRowNumber(row, INVOICE_LINE_RATE_KEYS);
    const lineTotal = readRowNumber(row, INVOICE_LINE_TOTAL_KEYS);
    const quantity = deriveInvoiceLineQuantity(row, unitPrice, lineTotal);
    const keys = deriveBillingKeysForInvoiceLine({
      rate_code: rateCode,
      description,
      service_item: serviceItem,
      material,
    });
    const invoiceRateKey = deriveInvoiceRateKey(invoiceNumber, keys.billing_rate_key);
    const groupSubjectId = invoiceRateKey ?? keys.billing_rate_key ?? lineId;
    const internalGroupKey = `${invoiceKey}::${groupSubjectId}`;
    const scheduleItem = input.invoiceLineToRateMap.get(lineId) ?? null;
    const contractSupported =
      lineTotal != null
      && scheduleItem != null
      && unitPrice != null
      && scheduleItem.rate_amount != null
      && Math.abs(unitPrice - scheduleItem.rate_amount) <= contractRateTolerance;

    lineContexts.set(lineId, {
      line_id: lineId,
      invoice_key: invoiceKey,
      invoice_number: invoiceNumber,
      line_total: lineTotal,
      quantity: quantity.quantity,
      quantity_inferred: quantity.inferred,
      unit_price: unitPrice,
      billing_rate_key: keys.billing_rate_key,
      invoice_rate_key: invoiceRateKey,
      group_subject_id: groupSubjectId,
      internal_group_key: internalGroupKey,
      contract_supported: contractSupported,
      schedule_item: scheduleItem,
      row,
    });

    if (lineTotal != null) {
      invoiceContext.line_total_sum = roundCurrency(invoiceContext.line_total_sum + lineTotal);
    }
    invoiceContext.group_internal_keys.add(internalGroupKey);

    const existingGroup = groupContexts.get(internalGroupKey) ?? {
      internal_key: internalGroupKey,
      subject_id: groupSubjectId,
      invoice_key: invoiceKey,
      invoice_number: invoiceNumber,
      normalized_invoice_number: normalizeInvoiceNumber(invoiceNumber),
      billing_rate_key: keys.billing_rate_key,
      invoice_rate_key: invoiceRateKey,
      amount: 0,
      quantity: 0,
      line_ids: [] as string[],
      transaction_supported: false,
    };
    existingGroup.line_ids.push(lineId);
    if (lineTotal != null) {
      existingGroup.amount = roundCurrency(existingGroup.amount + lineTotal);
    }
    if (quantity.quantity != null) {
      existingGroup.quantity = roundQuantity((existingGroup.quantity ?? 0) + quantity.quantity);
    } else if (existingGroup.quantity === 0 && existingGroup.line_ids.length === 1) {
      existingGroup.quantity = null;
    }
    groupContexts.set(internalGroupKey, existingGroup);

    const subjectEntries = groupSubjectIndex.get(groupSubjectId) ?? [];
    if (!subjectEntries.includes(internalGroupKey)) {
      subjectEntries.push(internalGroupKey);
      groupSubjectIndex.set(groupSubjectId, subjectEntries);
    }
    if (keys.billing_rate_key) {
      const billingEntries = billingRateIndex.get(keys.billing_rate_key) ?? [];
      if (!billingEntries.includes(internalGroupKey)) {
        billingEntries.push(internalGroupKey);
        billingRateIndex.set(keys.billing_rate_key, billingEntries);
      }
    }
  }

  for (const invoice of invoiceContexts.values()) {
    if (invoice.row) {
      const billedAmount = readRowNumber(invoice.row, INVOICE_TOTAL_KEYS);
      if (billedAmount != null) {
        invoice.billed_amount = billedAmount;
        invoice.billed_amount_source = 'invoice_total';
        continue;
      }
    }

    const invoiceDocId = resolveInvoiceSourceDocumentId(invoice, lineContexts);
    if (invoiceDocId) {
      const fromFacts = findFirstNumberFact(
        input.factsByDocumentId,
        [invoiceDocId],
        [...INVOICE_TOTAL_KEYS],
      );
      if (fromFacts != null) {
        invoice.billed_amount = fromFacts;
        invoice.billed_amount_source = 'invoice_total';
        continue;
      }
    }

    if (invoice.line_total_sum > 0) {
      invoice.billed_amount = invoice.line_total_sum;
      invoice.billed_amount_source = 'line_total_fallback';
    } else {
      invoice.billed_amount = null;
      invoice.billed_amount_source = 'missing';
    }
  }

  const canonicalTransactionRows = buildCanonicalTransactionRows(input.transactionData?.rows ?? []);
  const transactionByInvoiceRateKey = new Map<string, CanonicalTransactionRow[]>();
  const transactionByBillingRateKey = new Map<string, CanonicalTransactionRow[]>();

  for (const row of canonicalTransactionRows.values()) {
    if (row.invoice_rate_key) {
      const existing = transactionByInvoiceRateKey.get(row.invoice_rate_key) ?? [];
      existing.push(row);
      transactionByInvoiceRateKey.set(row.invoice_rate_key, existing);
    }
    if (row.billing_rate_key) {
      const existing = transactionByBillingRateKey.get(row.billing_rate_key) ?? [];
      existing.push(row);
      transactionByBillingRateKey.set(row.billing_rate_key, existing);
    }
  }

  for (const group of groupContexts.values()) {
    const matchedRows =
      (group.invoice_rate_key
        ? transactionByInvoiceRateKey.get(group.invoice_rate_key) ?? []
        : group.billing_rate_key
          ? transactionByBillingRateKey.get(group.billing_rate_key) ?? []
          : [])
        .filter((row) => row.meaningful_data);
    if (matchedRows.length === 0 || !(group.amount > 0)) {
      group.transaction_supported = false;
      continue;
    }

    const totals = transactionTotals(matchedRows);
    const costSupported =
      totals.totalCost != null
      && Math.abs(group.amount - totals.totalCost) <= transactionCostTolerance;
    const quantitySupported =
      group.quantity == null
      || (
        totals.hasAnyQuantity
        && totals.totalQuantity != null
        && Math.abs(group.quantity - totals.totalQuantity) <= transactionQuantityTolerance
      );
    group.transaction_supported = costSupported && quantitySupported;
  }

  const wholeInvoiceAtRisk = new Set<string>();
  const atRiskLineIds = new Set<string>();

  function markInvoiceByKey(invoiceKey: string | null | undefined) {
    if (!invoiceKey) return;
    if (invoiceContexts.has(invoiceKey)) {
      wholeInvoiceAtRisk.add(invoiceKey);
    }
  }

  function markInvoiceByAlias(alias: string | null | undefined) {
    if (!alias) return;
    const invoiceKey =
      invoiceAliasMap.get(alias)
      ?? invoiceAliasMap.get(normalizeInvoiceNumber(alias) ?? '');
    if (invoiceKey) {
      markInvoiceByKey(invoiceKey);
    }
  }

  function markLine(lineId: string | null | undefined) {
    if (!lineId || !lineContexts.has(lineId)) return;
    atRiskLineIds.add(lineId);
  }

  function markGroupByInternalKey(internalKey: string | null | undefined) {
    if (!internalKey) return;
    const group = groupContexts.get(internalKey);
    if (!group) return;
    for (const lineId of group.line_ids) {
      atRiskLineIds.add(lineId);
    }
  }

  function markGroupBySubjectId(subjectId: string | null | undefined) {
    if (!subjectId) return;
    for (const internalKey of groupSubjectIndex.get(subjectId) ?? []) {
      markGroupByInternalKey(internalKey);
    }
  }

  for (const finding of findings) {
    if (
      finding.status !== 'open'
      || finding.severity === 'info'
      || EXPOSURE_RULE_IDS.has(finding.rule_id)
    ) {
      continue;
    }

    switch (finding.subject_type) {
      case 'invoice':
        markInvoiceByAlias(finding.subject_id);
        break;
      case 'invoice_line':
        markLine(finding.subject_id);
        break;
      case 'invoice_rate_group':
        markGroupBySubjectId(finding.subject_id);
        break;
      case 'transaction_row': {
        const row = canonicalTransactionRows.get(finding.subject_id);
        if (!row) break;

        if (row.invoice_rate_key) {
          markGroupBySubjectId(row.invoice_rate_key);
          break;
        }

        if (row.invoice_number && row.billing_rate_key) {
          const scopedGroupId = deriveInvoiceRateKey(row.invoice_number, row.billing_rate_key);
          if (scopedGroupId) {
            markGroupBySubjectId(scopedGroupId);
          }
        }
        break;
      }
      case 'transaction_group':
        markGroupBySubjectId(finding.subject_id);
        for (const evidence of finding.evidence) {
          if (evidence.evidence_type !== 'grouping_key') continue;
          if (typeof evidence.record_id === 'string') {
            markGroupBySubjectId(evidence.record_id);
            for (const internalKey of billingRateIndex.get(evidence.record_id) ?? []) {
              markGroupByInternalKey(internalKey);
            }
          }
        }
        break;
      default:
        break;
    }
  }

  const invoiceSummaries: InvoiceExposureSummary[] = [...invoiceContexts.values()]
    .map((invoice) => {
      const invoiceLines = [...invoice.line_ids]
        .map((lineId) => lineContexts.get(lineId))
        .filter((line): line is LineContext => line != null);
      const contractSupportedAmount = roundCurrency(sumNumbers(
        invoiceLines
          .filter((line) => line.contract_supported && line.line_total != null)
          .map((line) => line.line_total as number),
      ));
      const transactionSupportedAmount = roundCurrency(sumNumbers(
        [...invoice.group_internal_keys]
          .map((groupKey) => groupContexts.get(groupKey))
          .filter((group): group is GroupContext => group != null && group.transaction_supported)
          .map((group) => group.amount),
      ));
      const fullyReconciledAmount = roundCurrency(sumNumbers(
        invoiceLines
          .filter((line) => (
            line.contract_supported
            && groupContexts.get(line.internal_group_key)?.transaction_supported
            && line.line_total != null
          ))
          .map((line) => line.line_total as number),
      ));
      const cappedContractSupported =
        invoice.billed_amount != null
          ? Math.min(invoice.billed_amount, contractSupportedAmount)
          : contractSupportedAmount;
      const cappedTransactionSupported =
        invoice.billed_amount != null
          ? Math.min(invoice.billed_amount, transactionSupportedAmount)
          : transactionSupportedAmount;
      const cappedFullyReconciled =
        invoice.billed_amount != null
          ? Math.min(invoice.billed_amount, fullyReconciledAmount)
          : fullyReconciledAmount;
      const invoiceAtRiskAmount =
        wholeInvoiceAtRisk.has(invoice.invoice_key)
          ? roundCurrency(invoice.billed_amount ?? invoice.line_total_sum)
          : roundCurrency(sumNumbers(
            invoiceLines
              .filter((line) => atRiskLineIds.has(line.line_id) && line.line_total != null)
              .map((line) => line.line_total as number),
          ));
      const cappedAtRiskAmount =
        invoice.billed_amount != null
          ? Math.min(invoice.billed_amount, invoiceAtRiskAmount)
          : invoiceAtRiskAmount;
      const unreconciledAmount =
        invoice.billed_amount != null
          ? roundCurrency(Math.max(0, invoice.billed_amount - cappedFullyReconciled))
          : null;

      return {
        invoice_number: invoice.invoice_number,
        billed_amount: invoice.billed_amount,
        billed_amount_source: invoice.billed_amount_source,
        contract_supported_amount: roundCurrency(cappedContractSupported),
        transaction_supported_amount: roundCurrency(cappedTransactionSupported),
        fully_reconciled_amount: roundCurrency(cappedFullyReconciled),
        supported_amount: roundCurrency(cappedFullyReconciled),
        unreconciled_amount: unreconciledAmount,
        at_risk_amount: roundCurrency(cappedAtRiskAmount),
        requires_verification_amount: roundCurrency(cappedAtRiskAmount),
        reconciliation_status: statusForInvoiceExposure({
          billedAmount: invoice.billed_amount,
          supportedAmount: cappedFullyReconciled,
          atRiskAmount: cappedAtRiskAmount,
          supportGapTolerance,
          atRiskTolerance,
        }),
      };
    })
    .sort((left, right) => (
      (left.invoice_number ?? '').localeCompare(right.invoice_number ?? '', 'en-US')
    ));

  if (invoiceSummaries.length === 0) {
    return { summary: null, findings: [] };
  }

  const summary: ProjectExposureSummary = {
    total_billed_amount: roundCurrency(sumNumbers(
      invoiceSummaries
        .map((invoice) => invoice.billed_amount)
        .filter((value): value is number => value != null),
    )),
    total_contract_supported_amount: roundCurrency(sumNumbers(
      invoiceSummaries.map((invoice) => invoice.contract_supported_amount),
    )),
    total_transaction_supported_amount: roundCurrency(sumNumbers(
      invoiceSummaries.map((invoice) => invoice.transaction_supported_amount),
    )),
    total_fully_reconciled_amount: roundCurrency(sumNumbers(
      invoiceSummaries.map((invoice) => invoice.fully_reconciled_amount),
    )),
    total_unreconciled_amount: roundCurrency(sumNumbers(
      invoiceSummaries
        .map((invoice) => invoice.unreconciled_amount)
        .filter((value): value is number => value != null),
    )),
    total_at_risk_amount: roundCurrency(sumNumbers(
      invoiceSummaries.map((invoice) => invoice.at_risk_amount),
    )),
    total_requires_verification_amount: roundCurrency(sumNumbers(
      invoiceSummaries.map((invoice) => invoice.requires_verification_amount ?? 0),
    )),
    support_gap_tolerance_amount: supportGapTolerance,
    at_risk_tolerance_amount: atRiskTolerance,
    moderate_severity: 'warning',
    invoices: invoiceSummaries,
  };

  const exposureFindings: ValidatorFindingResult[] = [];
  const findInvoiceContext = (invoiceNumber: string | null) => {
    if (!invoiceNumber) return null;
    const invoiceKey =
      invoiceAliasMap.get(invoiceNumber)
      ?? invoiceAliasMap.get(normalizeInvoiceNumber(invoiceNumber) ?? '');
    return invoiceKey ? invoiceContexts.get(invoiceKey) ?? null : null;
  };

  for (const invoiceSummary of invoiceSummaries) {
    const invoiceContext = findInvoiceContext(invoiceSummary.invoice_number);
    const invoiceLines = invoiceContext
      ? [...invoiceContext.line_ids]
        .map((lineId) => lineContexts.get(lineId))
        .filter((line): line is LineContext => line != null)
      : [];

    if (invoiceSummary.billed_amount_source !== 'invoice_total') {
      exposureFindings.push(
        makeFinding({
          projectId: input.project.id,
          ruleId: INVOICE_BILLED_TOTAL_PRESENT_RULE_ID,
          category: CATEGORY,
          severity: 'warning',
          subjectType: 'invoice',
          subjectId: invoiceSummary.invoice_number ?? invoiceContext?.invoice_key ?? 'unknown_invoice',
          field: 'billed_amount',
          expected: 'invoice billed total',
          actual:
            invoiceSummary.billed_amount_source === 'line_total_fallback'
              ? 'line total fallback'
              : 'missing',
          evidence: [
            ...invoiceRowEvidence(invoiceContext),
            ...lineEvidence(
              invoiceLines,
              'Invoice line totals were used while evaluating billed amount exposure fallback.',
            ),
            makeEvidenceInput({
              evidence_type: 'summary',
              record_id: invoiceSummary.invoice_number ?? invoiceContext?.invoice_key ?? 'unknown_invoice',
              field_name: 'billed_amount_source',
              field_value: invoiceSummary.billed_amount_source,
              note: 'Exposure math records whether billed dollars came from the invoice total or a line-total fallback.',
            }),
          ],
        }),
      );
    }

    if (
      invoiceSummary.billed_amount != null
      && invoiceSummary.unreconciled_amount != null
      && invoiceSummary.unreconciled_amount > supportGapTolerance
    ) {
      const unsupportedLines = invoiceLines.filter((line) => !(
        line.contract_supported
        && groupContexts.get(line.internal_group_key)?.transaction_supported
      ));
      exposureFindings.push(
        makeFinding({
          projectId: input.project.id,
          ruleId: INVOICE_EXPOSURE_SUPPORTED_RULE_ID,
          category: CATEGORY,
          severity: 'warning',
          subjectType: 'invoice',
          subjectId: invoiceSummary.invoice_number ?? invoiceContext?.invoice_key ?? 'unknown_invoice',
          field: 'supported_amount',
          expected: invoiceSummary.billed_amount,
          actual: invoiceSummary.supported_amount,
          variance: invoiceSummary.unreconciled_amount,
          varianceUnit: 'USD',
          evidence: [
            ...invoiceRowEvidence(invoiceContext),
            ...lineEvidence(
              unsupportedLines,
              'This invoice line contributes to billed dollars that are not fully reconciled.',
            ),
            makeEvidenceInput({
              evidence_type: 'summary',
              record_id: invoiceSummary.invoice_number ?? invoiceContext?.invoice_key ?? 'unknown_invoice',
              field_name: 'unreconciled_amount',
              field_value: invoiceSummary.unreconciled_amount,
              note: 'Invoice exposure math compared billed dollars against fully reconciled dollars.',
            }),
          ],
        }),
      );
    }

    if (invoiceSummary.at_risk_amount > atRiskTolerance) {
      const riskLines = invoiceLines.filter((line) => atRiskLineIds.has(line.line_id));
      exposureFindings.push(
        makeFinding({
          projectId: input.project.id,
          ruleId: INVOICE_EXPOSURE_AT_RISK_RULE_ID,
          category: CATEGORY,
          severity: 'warning',
          subjectType: 'invoice',
          subjectId: invoiceSummary.invoice_number ?? invoiceContext?.invoice_key ?? 'unknown_invoice',
          field: 'at_risk_amount',
          expected: 0,
          actual: invoiceSummary.at_risk_amount,
          variance: invoiceSummary.at_risk_amount,
          varianceUnit: 'USD',
          evidence: [
            ...invoiceRowEvidence(invoiceContext),
            ...lineEvidence(
              riskLines,
              'This invoice line is tied to at-risk billed dollars through open critical or warning findings.',
            ),
            makeEvidenceInput({
              evidence_type: 'summary',
              record_id: invoiceSummary.invoice_number ?? invoiceContext?.invoice_key ?? 'unknown_invoice',
              field_name: 'at_risk_amount',
              field_value: invoiceSummary.at_risk_amount,
              note: 'At-risk dollars are derived from open critical or warning findings, with warning treated as moderate severity.',
            }),
          ],
        }),
      );
    }
  }

  if (summary.total_unreconciled_amount > supportGapTolerance) {
    exposureFindings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: PROJECT_EXPOSURE_SUPPORTED_RULE_ID,
        category: CATEGORY,
        severity: 'warning',
        subjectType: 'project',
        subjectId: input.project.id,
        field: 'total_fully_reconciled_amount',
        expected: summary.total_billed_amount,
        actual: summary.total_fully_reconciled_amount,
        variance: summary.total_unreconciled_amount,
        varianceUnit: 'USD',
        evidence: [
          ...invoiceSummaries
            .filter((invoice) => (invoice.unreconciled_amount ?? 0) > supportGapTolerance)
            .slice(0, 6)
            .flatMap((invoice) => invoiceRowEvidence(findInvoiceContext(invoice.invoice_number))),
          makeEvidenceInput({
            evidence_type: 'summary',
            record_id: input.project.id,
            field_name: 'total_unreconciled_amount',
            field_value: summary.total_unreconciled_amount,
            note: 'Project exposure math compares total billed dollars against fully reconciled dollars.',
          }),
        ],
      }),
    );
  }

  if (summary.total_at_risk_amount > atRiskTolerance) {
    exposureFindings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: PROJECT_EXPOSURE_AT_RISK_RULE_ID,
        category: CATEGORY,
        severity: 'warning',
        subjectType: 'project',
        subjectId: input.project.id,
        field: 'total_at_risk_amount',
        expected: 0,
        actual: summary.total_at_risk_amount,
        variance: summary.total_at_risk_amount,
        varianceUnit: 'USD',
        evidence: [
          ...invoiceSummaries
            .filter((invoice) => invoice.at_risk_amount > atRiskTolerance)
            .slice(0, 6)
            .flatMap((invoice) => invoiceRowEvidence(findInvoiceContext(invoice.invoice_number))),
          makeEvidenceInput({
            evidence_type: 'summary',
            record_id: input.project.id,
            field_name: 'total_at_risk_amount',
            field_value: summary.total_at_risk_amount,
            note: 'Project at-risk dollars aggregate invoice dollars tied to open critical or warning findings.',
          }),
        ],
      }),
    );
  }

  return {
    summary,
    findings: exposureFindings,
  };
}
