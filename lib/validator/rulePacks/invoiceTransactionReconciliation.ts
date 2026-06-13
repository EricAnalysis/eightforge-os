import {
  deriveBillingKeysForInvoiceLine,
  deriveBillingKeysForTransactionRecord,
  deriveInvoiceRateKey,
  normalizeInvoiceNumber,
  normalizeRateCode,
} from '@/lib/validator/billingKeys';
import { emptyValidatorTransactionRollups } from '@/lib/validator/reconciliation';
import {
  isRuleEnabled,
  makeEvidenceInput,
  makeFinding,
  normalizeLooseText,
  readRowNumber,
  readRowString,
  resolveRuleTolerance,
  rowIdentifier,
  structuredRowEvidenceInput,
  toNumber,
  type FindingEvidenceInput,
  type InvoiceLineRow,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type ValidatorFindingResult,
  type ValidatorTransactionDataRow,
  type ValidatorTransactionRollups,
} from '@/lib/validator/shared';
import type { InvoiceTransactionReconciliationSummary } from '@/types/validator';

const CATEGORY = 'financial_integrity';

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
];
const INVOICE_LINE_SERVICE_ITEM_KEYS = [
  'service_item',
  'service_item_code',
  'line_service_item',
];
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
];
const INVOICE_LINE_TOTAL_KEYS = [
  'line_total',
  'extended_amount',
  'total_amount',
  'amount',
  'total',
  'extended_cost',
  'line_amount',
  'net_amount',
];
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
];

const RAW_SITE_TYPE_HEADER_ALIASES = [
  'site type',
  'facility type',
  'disposal type',
  'disposal site type',
  'dump site type',
] as const;

type InvoiceLookup = {
  byDocumentId: Map<string, string>;
  byInvoiceId: Map<string, string>;
};

type CanonicalInvoiceLine = {
  line_id: string;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  rate_code: string | null;
  billing_rate_key: string | null;
  invoice_rate_key: string | null;
  description: string | null;
  service_item: string | null;
  material: string | null;
  unit_price: number | null;
  quantity: number | null;
  quantity_inferred: boolean;
  line_total: number | null;
  schedule_item: RateScheduleItem | null;
  row: InvoiceLineRow;
};

type CanonicalInvoiceGroup = {
  group_id: string;
  subject_id: string;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  rate_code: string | null;
  billing_rate_key: string | null;
  invoice_rate_key: string | null;
  total_amount: number | null;
  total_quantity: number | null;
  invoice_rate: number | null;
  contract_rate: number | null;
  schedule_item: RateScheduleItem | null;
  lines: CanonicalInvoiceLine[];
};

type CanonicalTransactionRow = {
  row_id: string;
  document_id: string;
  invoice_number: string | null;
  normalized_invoice_number: string | null;
  transaction_number: string | null;
  rate_code: string | null;
  normalized_rate_code: string | null;
  rate_description: string | null;
  billing_rate_key: string | null;
  invoice_rate_key: string | null;
  site_material_key: string | null;
  transaction_quantity: number | null;
  extended_cost: number | null;
  transaction_rate: number | null;
  material: string | null;
  normalized_material: string | null;
  service_item: string | null;
  site_type_raw: string | null;
  normalized_site_type: string | null;
  source_sheet_name: string;
  source_row_number: number;
  record_json: Record<string, unknown>;
  raw_row_json: Record<string, unknown>;
  meaningful_data: boolean;
};

type TransactionIndexes = {
  rows: CanonicalTransactionRow[];
  byBillingRateKey: Map<string, CanonicalTransactionRow[]>;
  byInvoiceRateKey: Map<string, CanonicalTransactionRow[]>;
  byInvoiceNumber: Map<string, CanonicalTransactionRow[]>;
};

export type InvoiceTransactionReconciliationResult = {
  findings: ValidatorFindingResult[];
  summary: InvoiceTransactionReconciliationSummary;
};

function roundNumber(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

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

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = asString(value);
    if (parsed) return parsed;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findRawRowText(
  rawRow: Record<string, unknown>,
  aliases: readonly string[],
): string | null {
  for (const [header, value] of Object.entries(rawRow)) {
    const normalizedHeader = normalizeHeader(header);
    const matched = aliases.some((alias) => {
      const normalizedAlias = normalizeHeader(alias);
      return (
        normalizedHeader === normalizedAlias
        || normalizedHeader.startsWith(`${normalizedAlias} `)
        || normalizedHeader.endsWith(` ${normalizedAlias}`)
        || normalizedHeader.includes(normalizedAlias)
      );
    });

    if (!matched) continue;
    const parsed = asString(value);
    if (parsed) return parsed;
  }

  return null;
}

function median(values: readonly number[]): number | null {
  const ordered = [...values]
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (ordered.length === 0) return null;

  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle] ?? null;
}

function selectRepresentativeNumber(values: readonly number[]): number | null {
  const present = values.filter((value) => Number.isFinite(value));
  if (present.length === 0) return null;
  const chosen = median(present);
  return chosen != null ? roundNumber(chosen, 4) : null;
}

function buildInvoiceLookup(input: ProjectValidatorInput): InvoiceLookup {
  const byDocumentId = new Map<string, string>();
  const byInvoiceId = new Map<string, string>();

  for (const invoice of input.invoices) {
    const invoiceNumber = readRowString(invoice, INVOICE_LINE_INVOICE_NUMBER_KEYS);
    if (!invoiceNumber) continue;

    const sourceDocumentId = readRowString(invoice, ['source_document_id', 'document_id']);
    const invoiceId = readRowString(invoice, ['id', 'invoice_id']);
    if (sourceDocumentId) byDocumentId.set(sourceDocumentId, invoiceNumber);
    if (invoiceId) byInvoiceId.set(invoiceId, invoiceNumber);
  }

  return { byDocumentId, byInvoiceId };
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
      quantity: roundNumber(lineTotal / unitPrice, 4),
      inferred: true,
    };
  }

  return { quantity: null, inferred: false };
}

function buildInvoiceGroups(
  input: ProjectValidatorInput,
): CanonicalInvoiceGroup[] {
  const invoiceLookup = buildInvoiceLookup(input);
  const groups = new Map<string, {
    invoice_number: string | null;
    normalized_invoice_number: string | null;
    rate_code: string | null;
    billing_rate_key: string | null;
    invoice_rate_key: string | null;
    line_totals: number[];
    quantities: number[];
    unit_prices: number[];
    contract_rates: number[];
    schedule_item: RateScheduleItem | null;
    lines: CanonicalInvoiceLine[];
  }>();

  for (const row of input.invoiceLines) {
    const lineId = rowIdentifier(row, INVOICE_LINE_ID_KEYS, 'invoice_line');
    const sourceDocumentId = readRowString(row, ['source_document_id', 'document_id']);
    const invoiceId = readRowString(row, ['invoice_id', 'source_invoice_id']);
    const invoiceNumber =
      readRowString(row, INVOICE_LINE_INVOICE_NUMBER_KEYS)
      ?? (sourceDocumentId ? invoiceLookup.byDocumentId.get(sourceDocumentId) ?? null : null)
      ?? (invoiceId ? invoiceLookup.byInvoiceId.get(invoiceId) ?? null : null);
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
    const normalizedInvoiceNumber = normalizeInvoiceNumber(invoiceNumber);
    const invoiceRateKey = deriveInvoiceRateKey(invoiceNumber, keys.billing_rate_key);
    const scheduleItem = input.invoiceLineToRateMap.get(lineId) ?? null;
    const groupId = invoiceRateKey
      ?? keys.billing_rate_key
      ?? `invoice_line:${lineId}`;
    const existing = groups.get(groupId) ?? {
      invoice_number: invoiceNumber,
      normalized_invoice_number: normalizedInvoiceNumber,
      rate_code: rateCode,
      billing_rate_key: keys.billing_rate_key,
      invoice_rate_key: invoiceRateKey,
      line_totals: [] as number[],
      quantities: [] as number[],
      unit_prices: [] as number[],
      contract_rates: [] as number[],
      schedule_item: scheduleItem,
      lines: [] as CanonicalInvoiceLine[],
    };

    if (lineTotal != null) existing.line_totals.push(lineTotal);
    if (quantity.quantity != null) existing.quantities.push(quantity.quantity);
    if (unitPrice != null) existing.unit_prices.push(unitPrice);
    if (scheduleItem?.rate_amount != null) existing.contract_rates.push(scheduleItem.rate_amount);
    if (!existing.schedule_item && scheduleItem) {
      existing.schedule_item = scheduleItem;
    }

    existing.lines.push({
      line_id: lineId,
      invoice_number: invoiceNumber,
      normalized_invoice_number: normalizedInvoiceNumber,
      rate_code: rateCode,
      billing_rate_key: keys.billing_rate_key,
      invoice_rate_key: invoiceRateKey,
      description,
      service_item: serviceItem,
      material,
      unit_price: unitPrice,
      quantity: quantity.quantity,
      quantity_inferred: quantity.inferred,
      line_total: lineTotal,
      schedule_item: scheduleItem,
      row,
    });

    groups.set(groupId, existing);
  }

  return [...groups.entries()]
    .map(([groupId, group]) => ({
      group_id: groupId,
      subject_id: group.invoice_rate_key ?? group.billing_rate_key ?? group.lines[0]?.line_id ?? groupId,
      invoice_number: group.invoice_number,
      normalized_invoice_number: group.normalized_invoice_number,
      rate_code: group.rate_code,
      billing_rate_key: group.billing_rate_key,
      invoice_rate_key: group.invoice_rate_key,
      total_amount:
        group.line_totals.length > 0
          ? roundNumber(group.line_totals.reduce((sum, value) => sum + value, 0), 2)
          : null,
      total_quantity:
        group.quantities.length > 0
          ? roundNumber(group.quantities.reduce((sum, value) => sum + value, 0), 4)
          : null,
      invoice_rate: selectRepresentativeNumber(group.unit_prices),
      contract_rate: selectRepresentativeNumber(group.contract_rates),
      schedule_item: group.schedule_item,
      lines: group.lines,
    }))
    .sort((left, right) => left.group_id.localeCompare(right.group_id, 'en-US'));
}

function buildCanonicalTransactionRows(
  rows: readonly ValidatorTransactionDataRow[],
): CanonicalTransactionRow[] {
  return rows.map((row) => {
    const recordJson = asRecord(row.record_json) ?? {};
    const rawRowJson = asRecord(row.raw_row_json) ?? {};
    const invoiceNumber = firstString(recordJson.invoice_number, row.invoice_number);
    const rateCode = firstString(recordJson.rate_code, row.rate_code);
    const rateDescription = asString(recordJson.rate_description);
    const serviceItem = asString(recordJson.service_item);
    const material = asString(recordJson.material);
    const transactionQuantity = firstNumber(recordJson.transaction_quantity, row.transaction_quantity);
    const extendedCost = firstNumber(recordJson.extended_cost, row.extended_cost);
    const transactionRate = firstNumber(recordJson.transaction_rate);
    const siteTypeRaw =
      asString(recordJson.site_type)
      ?? findRawRowText(rawRowJson, RAW_SITE_TYPE_HEADER_ALIASES);
    const derivedKeys = deriveBillingKeysForTransactionRecord({
      invoice_number: invoiceNumber,
      rate_code: rateCode,
      rate_description: rateDescription,
      service_item: serviceItem,
      material,
      site_type: siteTypeRaw,
    });
    const billingRateKey =
      firstString(row.billing_rate_key, recordJson.billing_rate_key)
      ?? derivedKeys.billing_rate_key;
    const invoiceRateKey =
      firstString(recordJson.invoice_rate_key)
      ?? deriveInvoiceRateKey(invoiceNumber, billingRateKey)
      ?? derivedKeys.invoice_rate_key;
    const siteMaterialKey =
      firstString(row.site_material_key, recordJson.site_material_key)
      ?? derivedKeys.site_material_key;
    const meaningfulData =
      billingRateKey != null
      || rateCode != null
      || firstString(recordJson.transaction_number, row.transaction_number) != null
      || transactionQuantity != null
      || extendedCost != null
      || transactionRate != null;

    return {
      row_id: firstString(recordJson.id, row.id) ?? row.id,
      document_id: row.document_id,
      invoice_number: invoiceNumber,
      normalized_invoice_number: normalizeInvoiceNumber(invoiceNumber),
      transaction_number: firstString(recordJson.transaction_number, row.transaction_number),
      rate_code: rateCode,
      normalized_rate_code: normalizeRateCode(rateCode),
      rate_description: rateDescription,
      billing_rate_key: billingRateKey,
      invoice_rate_key: invoiceRateKey,
      site_material_key: siteMaterialKey,
      transaction_quantity: transactionQuantity,
      extended_cost: extendedCost,
      transaction_rate: transactionRate,
      material,
      normalized_material: normalizeLooseText(material),
      service_item: serviceItem,
      site_type_raw: siteTypeRaw,
      normalized_site_type: normalizeLooseText(siteTypeRaw),
      source_sheet_name: row.source_sheet_name,
      source_row_number: row.source_row_number,
      record_json: recordJson,
      raw_row_json: rawRowJson,
      meaningful_data: meaningfulData,
    };
  });
}

function buildTransactionIndexes(
  rows: readonly ValidatorTransactionDataRow[],
): TransactionIndexes {
  const canonicalRows = buildCanonicalTransactionRows(rows);
  const byBillingRateKey = new Map<string, CanonicalTransactionRow[]>();
  const byInvoiceRateKey = new Map<string, CanonicalTransactionRow[]>();
  const byInvoiceNumber = new Map<string, CanonicalTransactionRow[]>();

  for (const row of canonicalRows) {
    if (row.billing_rate_key) {
      const existing = byBillingRateKey.get(row.billing_rate_key) ?? [];
      existing.push(row);
      byBillingRateKey.set(row.billing_rate_key, existing);
    }
    if (row.invoice_rate_key) {
      const existing = byInvoiceRateKey.get(row.invoice_rate_key) ?? [];
      existing.push(row);
      byInvoiceRateKey.set(row.invoice_rate_key, existing);
    }
    if (row.normalized_invoice_number) {
      const existing = byInvoiceNumber.get(row.normalized_invoice_number) ?? [];
      existing.push(row);
      byInvoiceNumber.set(row.normalized_invoice_number, existing);
    }
  }

  return {
    rows: canonicalRows,
    byBillingRateKey,
    byInvoiceRateKey,
    byInvoiceNumber,
  };
}

function invoiceEvidenceForGroup(
  group: CanonicalInvoiceGroup,
  fieldName: string,
  note: string,
): FindingEvidenceInput[] {
  return group.lines.slice(0, 8).map((line) =>
    structuredRowEvidenceInput({
      evidenceType: 'invoice_line',
      row: line.row,
      fieldName,
      fieldValue:
        fieldName === 'rate_code'
          ? line.rate_code
          : fieldName === 'unit_price'
            ? line.unit_price
            : fieldName === 'quantity'
              ? line.quantity
              : line.line_total,
      note:
        fieldName === 'quantity' && line.quantity_inferred
          ? `${note} Quantity was inferred from line total and unit price.`
          : note,
    }),
  );
}

function transactionRateGroupEvidence(
  group: CanonicalInvoiceGroup,
  rollups: ValidatorTransactionRollups,
  note: string,
): FindingEvidenceInput[] {
  if (!group.billing_rate_key) return [];

  return rollups.grouped_by_rate_code
    .filter((rateGroup) => rateGroup.billing_rate_key === group.billing_rate_key)
    .slice(0, 2)
    .map((rateGroup) => makeEvidenceInput({
      evidence_type: 'transaction_group',
      record_id: rateGroup.billing_rate_key ?? group.billing_rate_key,
      field_name: 'billing_rate_key',
      field_value: {
        billing_rate_key: rateGroup.billing_rate_key,
        row_count: rateGroup.row_count,
        total_transaction_quantity: rateGroup.total_transaction_quantity,
        total_extended_cost: rateGroup.total_extended_cost,
      },
      note,
    }));
}

function transactionInvoiceGroupEvidence(
  group: CanonicalInvoiceGroup,
  rollups: ValidatorTransactionRollups,
  note: string,
): FindingEvidenceInput[] {
  if (!group.normalized_invoice_number) return [];

  return rollups.grouped_by_invoice
    .filter((invoiceGroup) => (
      normalizeInvoiceNumber(invoiceGroup.invoice_number) === group.normalized_invoice_number
    ))
    .slice(0, 1)
    .map((invoiceGroup) => makeEvidenceInput({
      evidence_type: 'transaction_group',
      record_id: invoiceGroup.invoice_number ?? group.normalized_invoice_number ?? 'invoice_group',
      field_name: 'invoice_number',
      field_value: {
        invoice_number: invoiceGroup.invoice_number,
        row_count: invoiceGroup.row_count,
        total_transaction_quantity: invoiceGroup.total_transaction_quantity,
        total_extended_cost: invoiceGroup.total_extended_cost,
      },
      note,
    }));
}

function transactionSiteGroupEvidence(
  rows: readonly CanonicalTransactionRow[],
  rollups: ValidatorTransactionRollups,
  note: string,
): FindingEvidenceInput[] {
  const siteMaterialKeys = Array.from(
    new Set(
      rows
        .map((row) => row.site_material_key)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );
  if (siteMaterialKeys.length === 0) return [];

  return rollups.grouped_by_site_material
    .filter((siteGroup) => (
      siteGroup.site_material_key != null
      && siteMaterialKeys.includes(siteGroup.site_material_key)
    ))
    .slice(0, 2)
    .map((siteGroup) => makeEvidenceInput({
      evidence_type: 'transaction_group',
      record_id: siteGroup.site_material_key ?? 'site_material_group',
      field_name: 'site_material_key',
      field_value: {
        site_material_key: siteGroup.site_material_key,
        row_count: siteGroup.row_count,
        total_transaction_quantity: siteGroup.total_transaction_quantity,
        total_extended_cost: siteGroup.total_extended_cost,
      },
      note,
    }));
}

function invoiceContextEvidenceForTransactionRow(
  row: CanonicalTransactionRow,
  invoiceGroups: readonly CanonicalInvoiceGroup[],
): FindingEvidenceInput[] {
  const matchingGroups = invoiceGroups.filter((group) => (
    (row.invoice_rate_key && group.invoice_rate_key === row.invoice_rate_key)
    || (!row.invoice_rate_key && row.billing_rate_key && group.billing_rate_key === row.billing_rate_key)
    || (!row.invoice_rate_key && !row.billing_rate_key && row.normalized_rate_code && normalizeRateCode(group.rate_code) === row.normalized_rate_code)
  ));

  if (matchingGroups.length === 0) {
    return invoiceGroups
      .slice(0, 1)
      .flatMap((group) => invoiceEvidenceForGroup(
        group,
        'rate_code',
        'Invoice context available for project-level transaction reconciliation.',
      ));
  }

  return matchingGroups
    .slice(0, 2)
    .flatMap((group) => invoiceEvidenceForGroup(
      group,
      'rate_code',
      'Invoice line context matched to the transaction reconciliation key.',
    ));
}

function transactionRowEvidence(
  row: CanonicalTransactionRow,
  fieldName: string,
  fieldValue: unknown,
  note: string,
): FindingEvidenceInput {
  return makeEvidenceInput({
    evidence_type: 'transaction_row',
    source_document_id: row.document_id,
    record_id: row.row_id,
    field_name: fieldName,
    field_value: fieldValue,
    note: `${note} Source ${row.source_sheet_name} row ${row.source_row_number}.`,
  });
}

function groupingKeyEvidence(params: {
  invoiceRateKey?: string | null;
  billingRateKey?: string | null;
  note: string;
}): FindingEvidenceInput {
  if (params.invoiceRateKey) {
    return makeEvidenceInput({
      evidence_type: 'grouping_key',
      record_id: params.invoiceRateKey,
      field_name: 'invoice_rate_key',
      field_value: params.invoiceRateKey,
      note: params.note,
    });
  }

  return makeEvidenceInput({
    evidence_type: 'grouping_key',
    record_id: params.billingRateKey ?? 'missing_grouping_key',
    field_name: 'billing_rate_key',
    field_value: params.billingRateKey ?? null,
    note: params.note,
  });
}

function scheduleRateEvidence(item: RateScheduleItem | null): FindingEvidenceInput[] {
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
      field_name: 'rate_amount',
      field_value: item.rate_amount,
      note: 'Contract rate schedule context available for transaction rate comparison.',
    }),
  ];
}

function relatedRowsForMissingGroup(
  group: CanonicalInvoiceGroup,
  indexes: TransactionIndexes,
): CanonicalTransactionRow[] {
  if (group.invoice_rate_key) {
    const invoiceScoped = indexes.byInvoiceRateKey.get(group.invoice_rate_key) ?? [];
    if (invoiceScoped.length > 0) return invoiceScoped.slice(0, 8);
  }

  if (group.billing_rate_key) {
    const rateScoped = indexes.byBillingRateKey.get(group.billing_rate_key) ?? [];
    if (rateScoped.length > 0) return rateScoped.slice(0, 8);
  }

  if (group.normalized_invoice_number) {
    const invoiceRows = indexes.byInvoiceNumber.get(group.normalized_invoice_number) ?? [];
    if (invoiceRows.length > 0) return invoiceRows.slice(0, 8);
  }

  return [];
}

function buildSiteMaterialAnomalies(
  indexes: TransactionIndexes,
): Array<{
  grouping_key: string;
  billing_rate_key: string | null;
  invoice_rate_key: string | null;
  material: string;
  site_types: string[];
  rows: CanonicalTransactionRow[];
}> {
  const groups = new Map<string, {
    billing_rate_key: string | null;
    invoice_rate_key: string | null;
    material: string;
    site_types: Set<string>;
    rows: CanonicalTransactionRow[];
  }>();

  for (const row of indexes.rows) {
    if (!row.normalized_material || !row.normalized_site_type) continue;
    const groupingKey =
      row.invoice_rate_key
      ?? row.billing_rate_key
      ?? `material:${row.normalized_material}`;
    const mapKey = `${groupingKey}::${row.normalized_material}`;
    const existing = groups.get(mapKey) ?? {
      billing_rate_key: row.billing_rate_key,
      invoice_rate_key: row.invoice_rate_key,
      material: row.material ?? row.normalized_material,
      site_types: new Set<string>(),
      rows: [] as CanonicalTransactionRow[],
    };

    existing.site_types.add(row.site_type_raw ?? row.normalized_site_type);
    existing.rows.push(row);
    groups.set(mapKey, existing);
  }

  return [...groups.entries()]
    .map(([grouping_key, group]) => ({
      grouping_key,
      billing_rate_key: group.billing_rate_key,
      invoice_rate_key: group.invoice_rate_key,
      material: group.material,
      site_types: [...group.site_types].sort((left, right) => left.localeCompare(right, 'en-US')),
      rows: group.rows.sort((left, right) => left.source_row_number - right.source_row_number),
    }))
    .filter((group) => group.site_types.length > 1);
}

function lineExposureAmount(line: CanonicalInvoiceLine): number | null {
  if (line.line_total != null) {
    return roundNumber(Math.abs(line.line_total), 2);
  }

  if (line.unit_price != null && line.quantity != null) {
    return roundNumber(Math.abs(line.unit_price * line.quantity), 2);
  }

  return null;
}

function buildDuplicateInvoiceLineGroups(
  groups: readonly CanonicalInvoiceGroup[],
): Array<{
  invoice_number: string | null;
  rate_code: string | null;
  billing_rate_key: string | null;
  lines: CanonicalInvoiceLine[];
  duplicate_count: number;
  duplicate_amount: number | null;
}> {
  const duplicates = new Map<string, {
    invoice_number: string | null;
    rate_code: string | null;
    billing_rate_key: string | null;
    lines: CanonicalInvoiceLine[];
    duplicate_count: number;
    duplicate_amount: number | null;
  }>();

  for (const line of groups.flatMap((group) => group.lines)) {
    const normalizedInvoice = normalizeInvoiceNumber(line.invoice_number) ?? 'invoice:unknown';
    const normalizedDescription = normalizeLooseText(line.description) ?? '';
    const signature = [
      normalizedInvoice,
      line.billing_rate_key ?? 'missing-key',
      line.unit_price != null ? line.unit_price.toFixed(4) : 'missing-rate',
      line.quantity != null ? line.quantity.toFixed(4) : 'missing-qty',
      line.line_total != null ? line.line_total.toFixed(2) : 'missing-total',
      normalizedDescription,
    ].join('::');

    const existing = duplicates.get(signature) ?? {
      invoice_number: line.invoice_number,
      rate_code: line.rate_code,
      billing_rate_key: line.billing_rate_key,
      lines: [] as CanonicalInvoiceLine[],
      duplicate_count: 0,
      duplicate_amount: null,
    };

    existing.lines.push(line);
    existing.duplicate_count = existing.lines.length;

    const exposure = lineExposureAmount(line);
    if (exposure != null && existing.lines.length > 1) {
      existing.duplicate_amount = roundNumber(exposure * (existing.lines.length - 1), 2);
    }

    duplicates.set(signature, existing);
  }

  return [...duplicates.values()].filter((entry) => (
    entry.lines.length > 1
    && entry.duplicate_amount != null
    && entry.duplicate_amount > 0.01
  ));
}

function transactionGroupTotals(rows: readonly CanonicalTransactionRow[]): {
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
        ? roundNumber(presentCosts.reduce((sum, value) => sum + value, 0), 2)
        : null,
    totalQuantity:
      presentQuantities.length > 0
        ? roundNumber(presentQuantities.reduce((sum, value) => sum + value, 0), 4)
        : null,
    hasAnyQuantity: presentQuantities.length > 0,
  };
}

export function evaluateInvoiceTransactionReconciliation(
  input: ProjectValidatorInput,
): InvoiceTransactionReconciliationResult {
  const findings: ValidatorFindingResult[] = [];
  const allInvoiceGroups = buildInvoiceGroups(input);
  const invoiceGroups = allInvoiceGroups
    .filter((group) => group.billing_rate_key != null || group.invoice_rate_key != null);
  const transactionIndexes = buildTransactionIndexes(input.transactionData?.rows ?? []);
  const transactionRollups =
    input.reconciliationContext?.transaction.rollups
    ?? input.transactionData?.rollups
    ?? emptyValidatorTransactionRollups();
  const costTolerance = resolveRuleTolerance(
    input.ruleStateByRuleId,
    'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE',
    0.01,
  );
  const quantityTolerance = resolveRuleTolerance(
    input.ruleStateByRuleId,
    'TRANSACTION_QUANTITY_MATCHES_INVOICE',
    0.001,
  );
  const rateTolerance = resolveRuleTolerance(
    input.ruleStateByRuleId,
    'TRANSACTION_RATE_OUTLIERS',
    0.25,
  );

  for (const group of allInvoiceGroups.filter((candidate) => (
    candidate.billing_rate_key == null
    && candidate.invoice_rate_key == null
  ))) {
    const representativeLine = group.lines[0] ?? null;
    if (!representativeLine) continue;

    const exposureAmount = lineExposureAmount(representativeLine);
    const hasMaterialContent =
      exposureAmount != null
      || representativeLine.unit_price != null
      || representativeLine.quantity != null
      || representativeLine.description != null
      || representativeLine.rate_code != null;
    if (!hasMaterialContent) continue;

    if (!isRuleEnabled(input.ruleStateByRuleId, 'INVOICE_LINE_REQUIRES_BILLING_KEY')) {
      continue;
    }

    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'INVOICE_LINE_REQUIRES_BILLING_KEY',
        category: CATEGORY,
        severity: 'critical',
        subjectType: 'invoice_line',
        subjectId: representativeLine.line_id,
        field: 'billing_rate_key',
        expected: 'resolved billing key',
        actual: 'missing',
        variance: exposureAmount,
        varianceUnit: exposureAmount != null ? 'USD' : null,
        evidence: [
          structuredRowEvidenceInput({
            evidenceType: 'invoice_line',
            row: representativeLine.row,
            fieldName: 'invoice_number',
            fieldValue: representativeLine.invoice_number,
            note: 'Invoice number linked to the unkeyed billed line.',
          }),
          structuredRowEvidenceInput({
            evidenceType: 'invoice_line',
            row: representativeLine.row,
            fieldName: 'rate_code',
            fieldValue: representativeLine.rate_code,
            note: 'Invoice rate code reviewed while deriving the billing key.',
          }),
          structuredRowEvidenceInput({
            evidenceType: 'invoice_line',
            row: representativeLine.row,
            fieldName: 'description',
            fieldValue: representativeLine.description,
            note: 'Invoice description reviewed while deriving the billing key.',
          }),
          structuredRowEvidenceInput({
            evidenceType: 'invoice_line',
            row: representativeLine.row,
            fieldName: 'line_total',
            fieldValue: representativeLine.line_total,
            note: 'Invoice line total at risk while the billing key remains unresolved.',
          }),
          groupingKeyEvidence({
            invoiceRateKey: representativeLine.invoice_rate_key,
            billingRateKey: representativeLine.billing_rate_key,
            note: 'Derived billing key state for the invoice line.',
          }),
        ],
      }),
    );
  }

  for (const duplicate of buildDuplicateInvoiceLineGroups(allInvoiceGroups)) {
    if (!isRuleEnabled(input.ruleStateByRuleId, 'INVOICE_DUPLICATE_BILLED_LINE')) {
      continue;
    }

    const representativeLine = duplicate.lines[0] ?? null;
    if (!representativeLine) continue;

    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'INVOICE_DUPLICATE_BILLED_LINE',
        category: CATEGORY,
        severity: 'critical',
        subjectType: 'invoice_line',
        subjectId: representativeLine.line_id,
        field: 'line_total',
        expected: '1 billed line',
        actual: `${duplicate.duplicate_count} billed lines`,
        variance: duplicate.duplicate_amount,
        varianceUnit: duplicate.duplicate_amount != null ? 'USD' : null,
        evidence: duplicate.lines.slice(0, 6).flatMap((line) => ([
          structuredRowEvidenceInput({
            evidenceType: 'invoice_line',
            row: line.row,
            fieldName: 'invoice_number',
            fieldValue: line.invoice_number,
            note: 'Invoice number linked to the duplicate billed line cluster.',
          }),
          structuredRowEvidenceInput({
            evidenceType: 'invoice_line',
            row: line.row,
            fieldName: 'rate_code',
            fieldValue: line.rate_code,
            note: 'Invoice rate code matched across duplicate billed lines.',
          }),
          structuredRowEvidenceInput({
            evidenceType: 'invoice_line',
            row: line.row,
            fieldName: 'line_total',
            fieldValue: line.line_total,
            note: 'Line total repeated across duplicate billed lines.',
          }),
        ])),
      }),
    );
  }

  let matchedGroups = 0;
  let unmatchedGroups = 0;
  let costMismatches = 0;
  let quantityMismatches = 0;
  const orphanTransactionRowIds = new Set<string>();
  const outlierRowIds = new Set<string>();

  for (const group of invoiceGroups) {
    const matchedRows =
      (group.invoice_rate_key
        ? transactionIndexes.byInvoiceRateKey.get(group.invoice_rate_key) ?? []
        : group.billing_rate_key
          ? transactionIndexes.byBillingRateKey.get(group.billing_rate_key) ?? []
          : [])
        .filter((row) => row.meaningful_data);

    if (matchedRows.length === 0) {
      unmatchedGroups += 1;

      if (isRuleEnabled(input.ruleStateByRuleId, 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE')) {
        const relatedRows = relatedRowsForMissingGroup(group, transactionIndexes);
        const actualState =
          relatedRows.length > 0
            ? 'transaction rows exist on other invoice/rate groupings only'
            : 'missing';

        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'invoice_rate_group',
            subjectId: group.subject_id,
            field: 'billing_rate_key',
            expected: group.invoice_rate_key ?? group.billing_rate_key ?? 'transaction rate group',
            actual: actualState,
            evidence: [
              ...invoiceEvidenceForGroup(
                group,
                'rate_code',
                'Invoice line rate group expected a matching transaction group.',
              ),
              ...transactionRateGroupEvidence(
                group,
                transactionRollups,
                'Transaction rate-group rollup reviewed during missing-group reconciliation.',
              ),
              ...transactionInvoiceGroupEvidence(
                group,
                transactionRollups,
                'Invoice-level transaction rollup reviewed during missing-group reconciliation.',
              ),
              ...relatedRows.slice(0, 6).map((row) => transactionRowEvidence(
                row,
                'billing_rate_key',
                row.billing_rate_key,
                'Related transaction row reviewed during missing-group reconciliation.',
              )),
              groupingKeyEvidence({
                invoiceRateKey: group.invoice_rate_key,
                billingRateKey: group.billing_rate_key,
                note: 'Grouping key used for invoice-to-transaction reconciliation.',
              }),
              ...scheduleRateEvidence(group.schedule_item),
            ],
          }),
        );
      }

      continue;
    }

    matchedGroups += 1;
    const transactionTotals = transactionGroupTotals(matchedRows);

    if (
      group.total_amount != null
      && transactionTotals.totalCost != null
      && Math.abs(group.total_amount - transactionTotals.totalCost) > costTolerance
    ) {
      costMismatches += 1;

      if (isRuleEnabled(input.ruleStateByRuleId, 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE')) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'invoice_rate_group',
            subjectId: group.subject_id,
            field: 'extended_cost',
            expected: group.total_amount,
            actual: transactionTotals.totalCost,
            variance: Math.abs(group.total_amount - transactionTotals.totalCost),
            varianceUnit: 'USD',
            evidence: [
              ...invoiceEvidenceForGroup(
                group,
                'line_total',
                'Invoice line total contributes to the invoice-to-transaction cost reconciliation.',
              ),
              ...transactionRateGroupEvidence(
                group,
                transactionRollups,
                'Transaction rate-group total compared against the invoice line total.',
              ),
              ...transactionInvoiceGroupEvidence(
                group,
                transactionRollups,
                'Invoice-level transaction total compared against the invoice line total.',
              ),
              ...matchedRows.slice(0, 10).map((row) => transactionRowEvidence(
                row,
                'extended_cost',
                row.extended_cost,
                'Transaction extended cost contributes to the grouped reconciliation total.',
              )),
              groupingKeyEvidence({
                invoiceRateKey: group.invoice_rate_key,
                billingRateKey: group.billing_rate_key,
                note: 'Grouping key used for invoice-to-transaction cost reconciliation.',
              }),
              ...scheduleRateEvidence(group.schedule_item),
            ],
          }),
        );
      }
    }

    if (
      group.total_quantity != null
      && (
        !transactionTotals.hasAnyQuantity
        || transactionTotals.totalQuantity == null
        || Math.abs(group.total_quantity - transactionTotals.totalQuantity) > quantityTolerance
      )
    ) {
      quantityMismatches += 1;

      if (isRuleEnabled(input.ruleStateByRuleId, 'TRANSACTION_QUANTITY_MATCHES_INVOICE')) {
        findings.push(
          makeFinding({
            projectId: input.project.id,
            ruleId: 'TRANSACTION_QUANTITY_MATCHES_INVOICE',
            category: CATEGORY,
            severity: 'critical',
            subjectType: 'invoice_rate_group',
            subjectId: group.subject_id,
            field: 'transaction_quantity',
            expected: group.total_quantity,
            actual: transactionTotals.totalQuantity ?? 'missing',
            variance:
              transactionTotals.totalQuantity != null
                ? Math.abs(group.total_quantity - transactionTotals.totalQuantity)
                : null,
            varianceUnit: 'QTY',
            evidence: [
              ...invoiceEvidenceForGroup(
                group,
                'quantity',
                'Invoice quantity contributes to the invoice-to-transaction quantity reconciliation.',
              ),
              ...transactionRateGroupEvidence(
                group,
                transactionRollups,
                'Transaction rate-group quantity compared against the invoice quantity.',
              ),
              ...transactionInvoiceGroupEvidence(
                group,
                transactionRollups,
                'Invoice-level transaction quantity compared against the invoice quantity.',
              ),
              ...matchedRows.slice(0, 10).map((row) => transactionRowEvidence(
                row,
                'transaction_quantity',
                row.transaction_quantity,
                'Transaction quantity contributes to the grouped reconciliation quantity.',
              )),
              groupingKeyEvidence({
                invoiceRateKey: group.invoice_rate_key,
                billingRateKey: group.billing_rate_key,
                note: 'Grouping key used for invoice-to-transaction quantity reconciliation.',
              }),
              ...scheduleRateEvidence(group.schedule_item),
            ],
          }),
        );
      }
    }

    const rateBaseline = group.invoice_rate ?? group.contract_rate;
    const baselineSource = group.invoice_rate != null ? 'invoice' : group.contract_rate != null ? 'contract' : null;
    if (rateBaseline == null || !(rateBaseline > 0)) {
      continue;
    }

    const effectiveRateTolerance = Math.max(rateTolerance, Math.abs(rateBaseline) * 0.1);

    for (const row of matchedRows) {
      if (row.transaction_rate == null) continue;
      const variance = Math.abs(row.transaction_rate - rateBaseline);
      if (variance <= effectiveRateTolerance) continue;

      outlierRowIds.add(row.row_id);

      if (!isRuleEnabled(input.ruleStateByRuleId, 'TRANSACTION_RATE_OUTLIERS')) {
        continue;
      }

      findings.push(
        makeFinding({
          projectId: input.project.id,
          ruleId: 'TRANSACTION_RATE_OUTLIERS',
          category: CATEGORY,
          severity: 'warning',
          subjectType: 'transaction_row',
          subjectId: row.row_id,
          field: 'transaction_rate',
          expected: rateBaseline,
          actual: row.transaction_rate,
          variance,
          varianceUnit: 'USD',
          evidence: [
            ...invoiceEvidenceForGroup(
              group,
              'unit_price',
              baselineSource === 'invoice'
                ? 'Invoice unit price is the baseline for transaction rate comparison.'
                : 'Invoice line group linked to the transaction rate outlier.',
            ),
            transactionRowEvidence(
              row,
              'transaction_rate',
              row.transaction_rate,
              'Transaction rate deviates from the reconciliation baseline.',
            ),
            groupingKeyEvidence({
              invoiceRateKey: group.invoice_rate_key,
              billingRateKey: group.billing_rate_key,
              note: 'Grouping key used for transaction rate outlier detection.',
            }),
            ...transactionRateGroupEvidence(
              group,
              transactionRollups,
              'Transaction rate-group rollup provides grouped context for the outlier review.',
            ),
            ...(baselineSource === 'contract'
              ? scheduleRateEvidence(group.schedule_item)
              : []),
          ],
        }),
      );
    }
  }

  for (const row of transactionIndexes.rows) {
    if (row.invoice_rate_key || row.normalized_invoice_number || !row.meaningful_data) continue;
    orphanTransactionRowIds.add(row.row_id);

    if (!isRuleEnabled(input.ruleStateByRuleId, 'TRANSACTION_MISSING_INVOICE_LINK')) {
      continue;
    }

    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'TRANSACTION_MISSING_INVOICE_LINK',
        category: CATEGORY,
        severity: 'warning',
        subjectType: 'transaction_row',
        subjectId: row.row_id,
        field: 'invoice_number',
        expected: 'linked invoice number',
        actual: 'missing',
        evidence: [
          ...invoiceContextEvidenceForTransactionRow(row, invoiceGroups),
          ...transactionSiteGroupEvidence(
            [row],
            transactionRollups,
            'Transaction grouped evidence reviewed for the orphaned transaction row.',
          ),
          transactionRowEvidence(
            row,
            'invoice_number',
            row.invoice_number,
            'Transaction row is missing an invoice link while containing reconcilable data.',
          ),
          groupingKeyEvidence({
            invoiceRateKey: row.invoice_rate_key,
            billingRateKey: row.billing_rate_key,
            note: 'Grouping key available on the orphaned transaction row.',
          }),
        ],
      }),
    );
  }

  for (const anomaly of buildSiteMaterialAnomalies(transactionIndexes)) {
    const relatedGroup = invoiceGroups.find((group) => (
      (anomaly.invoice_rate_key && group.invoice_rate_key === anomaly.invoice_rate_key)
      || (!anomaly.invoice_rate_key && anomaly.billing_rate_key && group.billing_rate_key === anomaly.billing_rate_key)
    )) ?? null;

    for (const row of anomaly.rows) {
      outlierRowIds.add(row.row_id);
    }

    if (!isRuleEnabled(input.ruleStateByRuleId, 'SITE_MATERIAL_ANOMALIES')) {
      continue;
    }

    findings.push(
      makeFinding({
        projectId: input.project.id,
        ruleId: 'SITE_MATERIAL_ANOMALIES',
        category: CATEGORY,
        severity: 'warning',
        subjectType: 'transaction_group',
        subjectId: anomaly.grouping_key,
        field: 'site_material_key',
        expected: 'consistent site type for grouped material reconciliation',
        actual: anomaly.site_types.join(', '),
        evidence: [
          ...(relatedGroup
            ? invoiceEvidenceForGroup(
              relatedGroup,
              'rate_code',
              'Invoice context linked to the site/material anomaly group.',
            )
            : invoiceContextEvidenceForTransactionRow(anomaly.rows[0]!, invoiceGroups)),
          ...transactionSiteGroupEvidence(
            anomaly.rows,
            transactionRollups,
            'Grouped site/material transaction evidence used for anomaly detection.',
          ),
          ...anomaly.rows.slice(0, 10).map((row) => transactionRowEvidence(
            row,
            'site_material_key',
            row.site_material_key,
            'Transaction row contributes to the site/material anomaly detection.',
          )),
          groupingKeyEvidence({
            invoiceRateKey: anomaly.invoice_rate_key,
            billingRateKey: anomaly.billing_rate_key,
            note: `Grouping key used while evaluating site/material anomalies for ${anomaly.material}.`,
          }),
        ],
      }),
    );
  }

  return {
    findings,
    summary: {
      matched_groups: matchedGroups,
      unmatched_groups: unmatchedGroups,
      cost_mismatches: costMismatches,
      quantity_mismatches: quantityMismatches,
      orphan_transactions: orphanTransactionRowIds.size,
      outlier_rows: outlierRowIds.size,
    },
  };
}
