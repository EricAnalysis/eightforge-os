import {
  deriveBillingKeysForInvoiceLine,
  deriveBillingKeysForRateScheduleItem,
  deriveBillingKeysForTransactionRecord,
  deriveInvoiceRateKey,
} from '@/lib/validator/billingKeys';
import {
  readRowString,
  type InvoiceLineRow,
  type InvoiceRow,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type ValidatorBillingGroup,
  type ValidatorContractAnalysisContext,
  type ValidatorProjectTransactionData,
  type ValidatorReconciliationContext,
  type ValidatorTransactionDataDataset,
  type ValidatorTransactionDataRow,
  type ValidatorTransactionRollups,
} from '@/lib/validator/shared';
import type {
  TransactionDataInvoiceGroup,
  TransactionDataRateCodeGroup,
  TransactionDataSiteMaterialGroup,
} from '@/lib/types/transactionData';
import type {
  ContractInvoiceReconciliationStatus,
  ContractInvoiceReconciliationSummary,
  InvoiceTransactionReconciliationSummary,
  ProjectReconciliationSummary,
} from '@/types/validator';

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

type MutableBillingGroup = {
  billing_group_id: string;
  billing_rate_key: string;
  description_match_key: string | null;
  site_material_keys: Set<string>;
  invoice_rate_keys: Set<string>;
  contract_rate_schedule_items: RateScheduleItem[];
  invoice_lines: InvoiceLineRow[];
  transaction_rows: ValidatorTransactionDataRow[];
  transaction_rate_groups: TransactionDataRateCodeGroup[];
  transaction_invoice_groups: TransactionDataInvoiceGroup[];
  transaction_site_material_groups: TransactionDataSiteMaterialGroup[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry != null)
    : [];
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

function asStringArray(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [];
  return uniqueStrings(items.map((entry) => asString(entry)));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  ).sort((left, right) => left.localeCompare(right, 'en-US'));
}

function choosePreferredText(
  current: string | null,
  candidate: string | null,
): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return current.localeCompare(candidate, 'en-US') <= 0 ? current : candidate;
}

function coerceRateCodeGroup(
  value: Record<string, unknown>,
): TransactionDataRateCodeGroup | null {
  const billingRateKey = asString(value.billing_rate_key);
  const rateCode = asString(value.rate_code);
  const rateDescriptionSample = asString(value.rate_description_sample);
  const rowCount = asNumber(value.row_count);
  const totalTransactionQuantity = asNumber(value.total_transaction_quantity);
  const totalExtendedCost = asNumber(value.total_extended_cost);

  if (
    billingRateKey == null
    && rateCode == null
    && rateDescriptionSample == null
    && rowCount == null
  ) {
    return null;
  }

  return {
    billing_rate_key: billingRateKey,
    rate_code: rateCode,
    rate_description_sample: rateDescriptionSample,
    row_count: Math.max(0, Math.trunc(rowCount ?? 0)),
    total_transaction_quantity: totalTransactionQuantity ?? 0,
    total_extended_cost: totalExtendedCost ?? 0,
    distinct_invoice_numbers: asStringArray(value.distinct_invoice_numbers),
    distinct_materials: asStringArray(value.distinct_materials),
    distinct_service_items: asStringArray(value.distinct_service_items),
  };
}

function coerceInvoiceGroup(
  value: Record<string, unknown>,
): TransactionDataInvoiceGroup | null {
  const invoiceNumber = asString(value.invoice_number);
  const rowCount = asNumber(value.row_count);
  const totalTransactionQuantity = asNumber(value.total_transaction_quantity);
  const totalExtendedCost = asNumber(value.total_extended_cost);

  if (invoiceNumber == null && rowCount == null) {
    return null;
  }

  return {
    invoice_number: invoiceNumber,
    row_count: Math.max(0, Math.trunc(rowCount ?? 0)),
    total_transaction_quantity: totalTransactionQuantity ?? 0,
    total_extended_cost: totalExtendedCost ?? 0,
    distinct_rate_codes: asStringArray(value.distinct_rate_codes),
    distinct_materials: asStringArray(value.distinct_materials),
    distinct_service_items: asStringArray(value.distinct_service_items),
  };
}

function coerceSiteMaterialGroup(
  value: Record<string, unknown>,
): TransactionDataSiteMaterialGroup | null {
  const siteMaterialKey = asString(value.site_material_key);
  const rowCount = asNumber(value.row_count);
  const totalTransactionQuantity = asNumber(value.total_transaction_quantity);
  const totalExtendedCost = asNumber(value.total_extended_cost);
  const disposalSite = asString(value.disposal_site);
  const disposalSiteType = asString(value.disposal_site_type);
  const material = asString(value.material);

  if (
    siteMaterialKey == null
    && disposalSite == null
    && disposalSiteType == null
    && material == null
    && rowCount == null
  ) {
    return null;
  }

  return {
    site_material_key: siteMaterialKey,
    disposal_site: disposalSite,
    disposal_site_type: disposalSiteType,
    material,
    row_count: Math.max(0, Math.trunc(rowCount ?? 0)),
    total_transaction_quantity: totalTransactionQuantity ?? 0,
    total_extended_cost: totalExtendedCost ?? 0,
    distinct_rate_codes: asStringArray(value.distinct_rate_codes),
    distinct_invoice_numbers: asStringArray(value.distinct_invoice_numbers),
  };
}

function sortRateCodeGroups(
  groups: readonly TransactionDataRateCodeGroup[],
): TransactionDataRateCodeGroup[] {
  return [...groups].sort((left, right) => (
    (left.billing_rate_key ?? left.rate_code ?? left.rate_description_sample ?? '')
      .localeCompare(
        right.billing_rate_key ?? right.rate_code ?? right.rate_description_sample ?? '',
        'en-US',
      )
  ));
}

function sortInvoiceGroups(
  groups: readonly TransactionDataInvoiceGroup[],
): TransactionDataInvoiceGroup[] {
  return [...groups].sort((left, right) => (
    (left.invoice_number ?? '').localeCompare(right.invoice_number ?? '', 'en-US')
  ));
}

function sortSiteMaterialGroups(
  groups: readonly TransactionDataSiteMaterialGroup[],
): TransactionDataSiteMaterialGroup[] {
  return [...groups].sort((left, right) => (
    (left.site_material_key ?? left.material ?? '')
      .localeCompare(right.site_material_key ?? right.material ?? '', 'en-US')
  ));
}

export function emptyValidatorTransactionRollups(): ValidatorTransactionRollups {
  return {
    grouped_by_rate_code: [],
    grouped_by_invoice: [],
    grouped_by_site_material: [],
  };
}

export function buildValidatorTransactionRollups(
  transactionData: Pick<ValidatorProjectTransactionData, 'datasets'> | null | undefined,
): ValidatorTransactionRollups {
  if (!transactionData) return emptyValidatorTransactionRollups();

  const groupedByRateCode: TransactionDataRateCodeGroup[] = [];
  const groupedByInvoice: TransactionDataInvoiceGroup[] = [];
  const groupedBySiteMaterial: TransactionDataSiteMaterialGroup[] = [];

  for (const dataset of transactionData.datasets) {
    const summaryJson = asRecord(dataset.summary_json);
    if (!summaryJson) continue;

    groupedByRateCode.push(
      ...asRecordArray(summaryJson.grouped_by_rate_code)
        .map((entry) => coerceRateCodeGroup(entry))
        .filter((entry): entry is TransactionDataRateCodeGroup => entry != null),
    );
    groupedByInvoice.push(
      ...asRecordArray(summaryJson.grouped_by_invoice)
        .map((entry) => coerceInvoiceGroup(entry))
        .filter((entry): entry is TransactionDataInvoiceGroup => entry != null),
    );
    groupedBySiteMaterial.push(
      ...asRecordArray(summaryJson.grouped_by_site_material)
        .map((entry) => coerceSiteMaterialGroup(entry))
        .filter((entry): entry is TransactionDataSiteMaterialGroup => entry != null),
    );
  }

  return {
    grouped_by_rate_code: sortRateCodeGroups(groupedByRateCode),
    grouped_by_invoice: sortInvoiceGroups(groupedByInvoice),
    grouped_by_site_material: sortSiteMaterialGroups(groupedBySiteMaterial),
  };
}

function ensureBillingGroup(
  groups: Map<string, MutableBillingGroup>,
  billingRateKey: string,
): MutableBillingGroup {
  const existing = groups.get(billingRateKey);
  if (existing) return existing;

  const created: MutableBillingGroup = {
    billing_group_id: billingRateKey,
    billing_rate_key: billingRateKey,
    description_match_key: null,
    site_material_keys: new Set<string>(),
    invoice_rate_keys: new Set<string>(),
    contract_rate_schedule_items: [],
    invoice_lines: [],
    transaction_rows: [],
    transaction_rate_groups: [],
    transaction_invoice_groups: [],
    transaction_site_material_groups: [],
  };
  groups.set(billingRateKey, created);
  return created;
}

function invoiceNumberForLine(line: InvoiceLineRow): string | null {
  return readRowString(line, INVOICE_LINE_INVOICE_NUMBER_KEYS);
}

function deriveBillingGroupFromContract(
  groups: Map<string, MutableBillingGroup>,
  item: RateScheduleItem,
) {
  const keys = deriveBillingKeysForRateScheduleItem(item);
  if (!keys.billing_rate_key) return;

  const group = ensureBillingGroup(groups, keys.billing_rate_key);
  group.description_match_key = choosePreferredText(
    group.description_match_key,
    keys.description_match_key,
  );
  if (keys.site_material_key) {
    group.site_material_keys.add(keys.site_material_key);
  }
  group.contract_rate_schedule_items.push(item);
}

function deriveBillingGroupFromInvoice(
  groups: Map<string, MutableBillingGroup>,
  line: InvoiceLineRow,
) {
  const rateCode = readRowString(line, INVOICE_LINE_RATE_CODE_KEYS);
  const description = readRowString(line, INVOICE_LINE_DESCRIPTION_KEYS);
  const serviceItem = readRowString(line, INVOICE_LINE_SERVICE_ITEM_KEYS);
  const material = readRowString(line, INVOICE_LINE_MATERIAL_KEYS);
  const keys = deriveBillingKeysForInvoiceLine({
    rate_code: rateCode,
    description,
    service_item: serviceItem,
    material,
  });
  if (!keys.billing_rate_key) return;

  const group = ensureBillingGroup(groups, keys.billing_rate_key);
  group.description_match_key = choosePreferredText(
    group.description_match_key,
    keys.description_match_key,
  );
  if (keys.site_material_key) {
    group.site_material_keys.add(keys.site_material_key);
  }
  const fallbackInvoiceRateKey = deriveInvoiceRateKey(
    invoiceNumberForLine(line),
    keys.billing_rate_key,
  );
  if (fallbackInvoiceRateKey) {
    group.invoice_rate_keys.add(fallbackInvoiceRateKey);
  }
  group.invoice_lines.push(line);
}

function deriveBillingGroupFromTransaction(
  groups: Map<string, MutableBillingGroup>,
  row: ValidatorTransactionDataRow,
) {
  const recordJson = asRecord(row.record_json) ?? {};
  const derived = deriveBillingKeysForTransactionRecord({
    invoice_number: asString(recordJson.invoice_number) ?? row.invoice_number,
    rate_code: asString(recordJson.rate_code) ?? row.rate_code,
    rate_description: asString(recordJson.rate_description),
    service_item: asString(recordJson.service_item),
    material: asString(recordJson.material),
    disposal_site: asString(recordJson.disposal_site),
    site_type: asString(recordJson.site_type),
  });
  const billingRateKey = row.billing_rate_key ?? derived.billing_rate_key;
  if (!billingRateKey) return;

  const group = ensureBillingGroup(groups, billingRateKey);
  group.description_match_key = choosePreferredText(
    group.description_match_key,
    derived.description_match_key,
  );
  if (row.site_material_key ?? derived.site_material_key) {
    group.site_material_keys.add(row.site_material_key ?? derived.site_material_key!);
  }
  if (recordJson.invoice_rate_key || derived.invoice_rate_key) {
    group.invoice_rate_keys.add(
      asString(recordJson.invoice_rate_key) ?? derived.invoice_rate_key!,
    );
  }
  group.transaction_rows.push(row);
}

function uniqueDocumentIds(
  context: ValidatorContractAnalysisContext | null,
  rateScheduleItems: readonly RateScheduleItem[],
  governingContractIds: readonly string[],
): string[] {
  return uniqueStrings([
    context?.document_id ?? null,
    ...governingContractIds,
    ...rateScheduleItems.map((item) => item.source_document_id),
  ]);
}

export function buildValidatorReconciliationContext(
  params: Pick<
    ProjectValidatorInput,
    | 'governingDocumentIds'
    | 'contractValidationContext'
    | 'factLookups'
    | 'invoices'
    | 'invoiceLines'
    | 'transactionData'
  >,
): ValidatorReconciliationContext {
  const transactionDatasets: ValidatorTransactionDataDataset[] =
    params.transactionData?.datasets ?? [];
  const transactionRows: ValidatorTransactionDataRow[] =
    params.transactionData?.rows ?? [];
  const transactionRollups =
    params.transactionData?.rollups
    ?? buildValidatorTransactionRollups(params.transactionData);

  const groups = new Map<string, MutableBillingGroup>();

  for (const item of params.factLookups.rateScheduleItems) {
    deriveBillingGroupFromContract(groups, item);
  }

  for (const line of params.invoiceLines) {
    deriveBillingGroupFromInvoice(groups, line);
  }

  for (const row of transactionRows) {
    deriveBillingGroupFromTransaction(groups, row);
  }

  for (const rateGroup of transactionRollups.grouped_by_rate_code) {
    if (!rateGroup.billing_rate_key) continue;
    const group = ensureBillingGroup(groups, rateGroup.billing_rate_key);
    group.description_match_key = choosePreferredText(
      group.description_match_key,
      rateGroup.rate_description_sample,
    );
    group.transaction_rate_groups.push(rateGroup);
  }

  const billingGroups: ValidatorBillingGroup[] = [...groups.values()]
    .map((group) => {
      const siteMaterialKeys = uniqueStrings([...group.site_material_keys]);
      const invoiceRateKeys = uniqueStrings([...group.invoice_rate_keys]);
      const transactionInvoiceGroups = transactionRollups.grouped_by_invoice.filter((invoiceGroup) => {
        const invoiceRateKey = deriveInvoiceRateKey(invoiceGroup.invoice_number, group.billing_rate_key);
        return invoiceRateKey != null && invoiceRateKeys.includes(invoiceRateKey);
      });
      const transactionSiteMaterialGroups = transactionRollups.grouped_by_site_material.filter((siteGroup) => (
        siteGroup.site_material_key != null
        && siteMaterialKeys.includes(siteGroup.site_material_key)
      ));

      return {
        billing_group_id: group.billing_group_id,
        billing_rate_key: group.billing_rate_key,
        description_match_key: group.description_match_key,
        site_material_keys: siteMaterialKeys,
        invoice_rate_keys: invoiceRateKeys,
        contract_rate_schedule_items: [...group.contract_rate_schedule_items].sort((left, right) => (
          `${left.source_document_id}:${left.record_id}`
            .localeCompare(`${right.source_document_id}:${right.record_id}`, 'en-US')
        )),
        invoice_lines: [...group.invoice_lines].sort((left, right) => (
          `${invoiceNumberForLine(left) ?? ''}:${readRowString(left, ['id', 'invoice_line_id', 'line_id']) ?? ''}`
            .localeCompare(
              `${invoiceNumberForLine(right) ?? ''}:${readRowString(right, ['id', 'invoice_line_id', 'line_id']) ?? ''}`,
              'en-US',
            )
        )),
        transaction_rows: [...group.transaction_rows].sort((left, right) => (
          `${left.invoice_number ?? ''}:${left.source_sheet_name}:${String(left.source_row_number).padStart(8, '0')}`
            .localeCompare(
              `${right.invoice_number ?? ''}:${right.source_sheet_name}:${String(right.source_row_number).padStart(8, '0')}`,
              'en-US',
            )
        )),
        transaction_rate_groups: sortRateCodeGroups(group.transaction_rate_groups),
        transaction_invoice_groups: sortInvoiceGroups(transactionInvoiceGroups),
        transaction_site_material_groups: sortSiteMaterialGroups(transactionSiteMaterialGroups),
      };
    })
    .sort((left, right) => left.billing_group_id.localeCompare(right.billing_group_id, 'en-US'));

  return {
    contract: {
      governing_document_ids: uniqueDocumentIds(
        params.contractValidationContext,
        params.factLookups.rateScheduleItems,
        params.governingDocumentIds.contract,
      ),
      intelligence: params.contractValidationContext,
      rate_schedule_items: [...params.factLookups.rateScheduleItems],
    },
    invoice: {
      invoices: [...params.invoices] as InvoiceRow[],
      line_items: [...params.invoiceLines],
    },
    transaction: {
      datasets: transactionDatasets,
      rows: transactionRows,
      rollups: transactionRollups,
    },
    billing_groups: billingGroups,
  };
}

function combineStatuses(
  statuses: ContractInvoiceReconciliationStatus[],
): ContractInvoiceReconciliationStatus {
  if (statuses.length === 0) return 'MISSING';
  if (statuses.includes('MISMATCH')) return 'MISMATCH';
  const presentStatuses = statuses.filter((status) => status !== 'MISSING');
  if (presentStatuses.length === 0) return 'MISSING';
  if (statuses.includes('PARTIAL') || statuses.includes('MISSING')) return 'PARTIAL';
  return 'MATCH';
}

export function deriveContractInvoiceStatus(
  summary: ContractInvoiceReconciliationSummary | null | undefined,
): ContractInvoiceReconciliationStatus {
  if (!summary) return 'MISSING';

  const statuses: ContractInvoiceReconciliationStatus[] = [
    summary.vendor_identity_status,
    summary.client_identity_status,
    summary.service_period_status,
    summary.invoice_total_status,
  ];

  if (summary.rate_mismatches > 0 || summary.unmatched_invoice_lines > 0) {
    statuses.push('MISMATCH');
  } else if (summary.matched_invoice_lines > 0) {
    statuses.push('MATCH');
  } else {
    statuses.push('MISSING');
  }

  return combineStatuses(statuses);
}

export function deriveInvoiceTransactionStatus(
  summary: InvoiceTransactionReconciliationSummary | null | undefined,
): ContractInvoiceReconciliationStatus {
  if (!summary) return 'MISSING';

  if (
    summary.cost_mismatches > 0
    || summary.quantity_mismatches > 0
    || summary.outlier_rows > 0
  ) {
    return 'MISMATCH';
  }

  const hasCoverage =
    summary.matched_groups > 0
    || summary.unmatched_groups > 0
    || summary.orphan_transactions > 0;
  if (!hasCoverage) return 'MISSING';

  if (summary.matched_groups > 0 && summary.unmatched_groups === 0 && summary.orphan_transactions === 0) {
    return 'MATCH';
  }

  return summary.matched_groups > 0 ? 'PARTIAL' : 'MISSING';
}

export function buildProjectReconciliationSummary(params: {
  reconciliationContext?: ValidatorReconciliationContext | null;
  contractInvoiceReconciliation?: ContractInvoiceReconciliationSummary | null;
  invoiceTransactionReconciliation?: InvoiceTransactionReconciliationSummary | null;
}): ProjectReconciliationSummary | null {
  const reconciliationContext = params.reconciliationContext ?? null;
  const hasAnyInput =
    reconciliationContext != null
    || params.contractInvoiceReconciliation != null
    || params.invoiceTransactionReconciliation != null;
  if (!hasAnyInput) return null;

  const billingGroups = reconciliationContext?.billing_groups ?? [];
  const matchedBillingGroups = billingGroups.filter((group) => (
    group.contract_rate_schedule_items.length > 0
    && group.invoice_lines.length > 0
    && group.transaction_rows.length > 0
  )).length;
  const unmatchedBillingGroups = billingGroups.filter((group) => !(
    group.contract_rate_schedule_items.length > 0
    && group.invoice_lines.length > 0
    && group.transaction_rows.length > 0
  )).length;
  const contractInvoiceStatus = deriveContractInvoiceStatus(
    params.contractInvoiceReconciliation,
  );
  const invoiceTransactionStatus = deriveInvoiceTransactionStatus(
    params.invoiceTransactionReconciliation,
  );
  const rateMismatches =
    (params.contractInvoiceReconciliation?.rate_mismatches ?? 0)
    + (params.invoiceTransactionReconciliation?.outlier_rows ?? 0);
  const quantityMismatches =
    params.invoiceTransactionReconciliation?.quantity_mismatches ?? 0;
  const orphanInvoiceLines =
    params.contractInvoiceReconciliation?.unmatched_invoice_lines ?? 0;
  const orphanTransactions =
    params.invoiceTransactionReconciliation?.orphan_transactions ?? 0;
  const anyCoverage =
    matchedBillingGroups > 0
    || unmatchedBillingGroups > 0
    || orphanInvoiceLines > 0
    || orphanTransactions > 0
    || contractInvoiceStatus !== 'MISSING'
    || invoiceTransactionStatus !== 'MISSING';

  let overallReconciliationStatus: ContractInvoiceReconciliationStatus;
  if (!anyCoverage) {
    overallReconciliationStatus = 'MISSING';
  } else if (
    contractInvoiceStatus === 'MISMATCH'
    || invoiceTransactionStatus === 'MISMATCH'
    || rateMismatches > 0
    || quantityMismatches > 0
  ) {
    overallReconciliationStatus = 'MISMATCH';
  } else if (
    contractInvoiceStatus === 'MATCH'
    && invoiceTransactionStatus === 'MATCH'
    && unmatchedBillingGroups === 0
    && orphanInvoiceLines === 0
    && orphanTransactions === 0
  ) {
    overallReconciliationStatus = 'MATCH';
  } else {
    overallReconciliationStatus = 'PARTIAL';
  }

  return {
    contract_invoice_status: contractInvoiceStatus,
    invoice_transaction_status: invoiceTransactionStatus,
    overall_reconciliation_status: overallReconciliationStatus,
    matched_billing_groups: matchedBillingGroups,
    unmatched_billing_groups: unmatchedBillingGroups,
    rate_mismatches: rateMismatches,
    quantity_mismatches: quantityMismatches,
    orphan_invoice_lines: orphanInvoiceLines,
    orphan_transactions: orphanTransactions,
  };
}
