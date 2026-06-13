import type { ExtractionGap } from '@/lib/extraction/types';
import type {
  TransactionDataDateRange,
  TransactionDataDatasetSummary,
  TransactionDataDisposalSiteGroup,
  TransactionDataDmsFdsLifecycleSummary,
  TransactionDataFieldKey,
  TransactionDataHeaderMatch,
  TransactionDataInvoiceGroup,
  TransactionDataInvoiceReadinessSummary,
  TransactionDataMaterialGroup,
  TransactionDataOpsReviewBucket,
  TransactionDataProjectOperationsOverview,
  TransactionDataRateCodeGroup,
  TransactionDataRecord,
  TransactionDataServiceItemGroup,
  TransactionDataSiteTypeGroup,
  TransactionDataSiteMaterialGroup,
  TransactionDataOutlierRow,
} from '@/lib/types/transactionData';
import {
  TRANSACTION_DATA_AMOUNT_FIELDS,
  TRANSACTION_DATA_CODE_FIELDS,
  TRANSACTION_DATA_HEADER_ALIASES,
  TRANSACTION_DATA_FIELD_LABELS,
  TRANSACTION_DATA_FIELD_ORDER,
  TRANSACTION_DATA_METRIC_FIELDS,
} from '@/lib/types/transactionData';
import type { DetectSheetsResult } from '@/lib/extraction/xlsx/detectSheets';
import type {
  SpreadsheetPrimitive,
  WorkbookParseResult,
  WorkbookSheetModel,
} from '@/lib/extraction/xlsx/parseWorkbook';
import {
  deriveBillingKeysForTransactionRecord,
  normalizeInvoiceNumber,
  normalizeRateCode,
} from '@/lib/validator/billingKeys';

export interface NormalizedTransactionDataRecord extends TransactionDataRecord {
  id: string;
  evidence_ref: string;
  column_headers: Partial<Record<TransactionDataFieldKey, string>>;
  field_evidence_ids: Partial<Record<TransactionDataFieldKey, string>>;
  missing_fields: string[];
  confidence: number;
}

export interface TransactionDataRollups {
  total_extended_cost: number;
  total_transaction_quantity: number;
  total_tickets: number;
  total_cyd: number;
  invoiced_ticket_count: number;
  distinct_invoice_count: number;
  total_invoiced_amount: number;
  uninvoiced_line_count: number;
  eligible_count: number;
  ineligible_count: number;
  unknown_eligibility_count: number;
  distinct_rate_codes: string[];
  distinct_invoice_numbers: string[];
  distinct_service_items: string[];
  distinct_materials: string[];
  rows_with_missing_rate_code: number;
  rows_with_missing_invoice_number: number;
  rows_with_missing_quantity: number;
  rows_with_missing_extended_cost: number;
  rows_with_zero_cost: number;
  rows_with_extreme_unit_rate: number;
  grouped_by_rate_code: TransactionDataRateCodeGroup[];
  grouped_by_invoice: TransactionDataInvoiceGroup[];
  grouped_by_site_material: TransactionDataSiteMaterialGroup[];
  grouped_by_service_item: TransactionDataServiceItemGroup[];
  grouped_by_material: TransactionDataMaterialGroup[];
  grouped_by_site_type: TransactionDataSiteTypeGroup[];
  grouped_by_disposal_site: TransactionDataDisposalSiteGroup[];
  outlier_rows: TransactionDataOutlierRow[];
}

export interface TransactionDataNormalizationResult {
  source_type: 'transaction_data';
  row_count: number;
  sheet_names: string[];
  processed_sheet_names: string[];
  header_map: Partial<Record<TransactionDataFieldKey, TransactionDataHeaderMatch[]>>;
  inferred_project_name: string | null;
  inferred_invoice_numbers: string[];
  inferred_date_range: TransactionDataDateRange | null;
  detected_metric_columns: string[];
  detected_code_columns: string[];
  detected_amount_columns: string[];
  records: NormalizedTransactionDataRecord[];
  summary: TransactionDataDatasetSummary;
  rollups: TransactionDataRollups;
  confidence: number;
  gaps: ExtractionGap[];
}

function buildGap(input: Omit<ExtractionGap, 'id' | 'source'>): ExtractionGap {
  return {
    id: `gap:${input.category}:${input.sheet ?? 'transaction_data'}:${input.row ?? '0'}`,
    source: 'xlsx',
    ...input,
  };
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const RAW_DISPOSAL_SITE_HEADER_ALIASES = [
  'disposal site',
  'dump site',
  'dumpsite',
  'disposal facility',
  'dump facility',
  'destination site',
  'disposal location',
  'dump location',
  'landfill',
] as const;

const RAW_SITE_TYPE_HEADER_ALIASES = [
  'site type',
  'facility type',
  'disposal type',
  'disposal site type',
  'dump site type',
] as const;

const RAW_BOUNDARY_LOCATION_HEADER_ALIASES = [
  'boundary',
  'boundary status',
  'boundary review',
  'location',
  'load location',
  'pickup location',
  'pickup address',
  'service address',
  'site location',
  'site name',
] as const;

const RAW_DISTANCE_FROM_FEATURE_HEADER_ALIASES = [
  'distance from feature',
  'distance to feature',
  'feature distance',
  'distance from property line',
  'distance to right of way',
  'distance to roadway',
  'distance',
  'distance (ft)',
  'distance (feet)',
] as const;

const RAW_LOAD_CALL_HEADER_ALIASES = [
  'load call',
  'load call id',
  'load call number',
  'call id',
  'call number',
  'call in time',
  'dispatch time',
  'requested time',
] as const;

const RAW_MOBILE_TICKET_HEADER_ALIASES = [
  'mobile ticket id',
  'mobile ticket number',
  'mobile ticket',
  'mobile id',
  'parent mobile ticket',
  'parent mobile id',
  'ticket id',
] as const;

const RAW_LINKED_MOBILE_HEADER_ALIASES = [
  'linked mobile ticket id',
  'linked mobile ticket',
  'linked mobile id',
  'parent ticket id',
  'parent ticket number',
  'parent ticket',
  'mobile ticket id',
] as const;

const RAW_LOAD_TICKET_HEADER_ALIASES = [
  'load ticket id',
  'load ticket number',
  'load ticket',
  'load id',
] as const;

const RAW_TRIP_TIME_HEADER_ALIASES = [
  'trip time',
  'trip duration',
  'haul time',
  'turnaround time',
  'truck trip time',
  'cycle time',
] as const;

const RAW_TRIP_START_HEADER_ALIASES = [
  'depart time',
  'departure time',
  'start time',
  'load start',
  'haul out time',
] as const;

const RAW_TRIP_END_HEADER_ALIASES = [
  'arrival time',
  'end time',
  'unload time',
  'dump time',
  'return time',
  'trip end',
] as const;

type ReviewRowSignal = {
  recordId: string;
  evidenceRef: string;
  reason: string;
  severity: 'warning' | 'critical';
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }

  return out;
}

function roundNumber(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function parseText(value: SpreadsheetPrimitive): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return null;
}

function parseNumber(value: SpreadsheetPrimitive): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const normalized = value
    .replace(/[$,%]/g, '')
    .replace(/,/g, '')
    .replace(/\((.+)\)/, '-$1')
    .trim();

  if (!normalized) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function excelSerialToIso(value: number): string | null {
  if (!Number.isFinite(value) || value < 1 || value > 60000) return null;
  const millis = Math.round((value - 25569) * 86400 * 1000);
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function parseDate(value: SpreadsheetPrimitive): string | null {
  if (typeof value === 'number') {
    return excelSerialToIso(value);
  }

  const text = parseText(value);
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  const usDate = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (usDate) {
    const month = Number(usDate[1]);
    const day = Number(usDate[2]);
    const yearRaw = Number(usDate[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function rawHeaderMatchesAliases(
  header: string,
  aliases: readonly string[],
): boolean {
  const normalizedHeader = normalizeHeader(header);
  return aliases.some((alias) => {
    const normalizedAlias = normalizeHeader(alias);
    return (
      normalizedHeader === normalizedAlias ||
      normalizedHeader.startsWith(`${normalizedAlias} `) ||
      normalizedHeader.endsWith(` ${normalizedAlias}`) ||
      normalizedHeader.includes(normalizedAlias)
    );
  });
}

function findRawRowText(
  rawRow: Record<string, SpreadsheetPrimitive>,
  aliases: readonly string[],
): string | null {
  for (const [header, value] of Object.entries(rawRow)) {
    if (!rawHeaderMatchesAliases(header, aliases)) continue;
    const text = parseText(value);
    if (text) return text;
  }

  return null;
}

function findRawRowValue(
  rawRow: Record<string, SpreadsheetPrimitive>,
  aliases: readonly string[],
): SpreadsheetPrimitive | null {
  for (const [header, value] of Object.entries(rawRow)) {
    if (!rawHeaderMatchesAliases(header, aliases)) continue;
    return value ?? null;
  }

  return null;
}

function collectMatchingHeaders(
  records: readonly NormalizedTransactionDataRecord[],
  aliases: readonly string[],
): string[] {
  const matches = new Set<string>();

  for (const record of records) {
    for (const header of Object.keys(record.raw_row)) {
      if (rawHeaderMatchesAliases(header, aliases)) {
        matches.add(header);
      }
    }
  }

  return [...matches].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function normalizeLooseText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeEligibility(value: string | null | undefined): 'eligible' | 'ineligible' | 'unknown' {
  const normalized = normalizeLooseText(value);
  if (!normalized) return 'unknown';
  if (
    normalized.includes('ineligible') ||
    normalized.includes('not eligible') ||
    normalized.includes('not approved') ||
    normalized === 'no' ||
    normalized.includes('denied')
  ) {
    return 'ineligible';
  }
  if (
    normalized.includes('eligible') ||
    normalized.includes('approved') ||
    normalized === 'yes' ||
    normalized.includes('allow')
  ) {
    return 'eligible';
  }
  return 'unknown';
}

function normalizeSiteType(value: string | null | undefined): string | null {
  const normalized = normalizeLooseText(value);
  if (!normalized) return null;
  if (normalized.includes('dms') || normalized.includes('staging')) return 'DMS';
  if (normalized.includes('fds') || normalized.includes('final disposal')) return 'FDS';
  if (normalized.includes('landfill')) return 'Landfill';
  if (normalized.includes('recycl')) return 'Recycling';
  return value?.trim() ?? null;
}

function lifecycleStageForRecord(record: NormalizedTransactionDataRecord): 'DMS' | 'FDS' | 'Landfill' | 'Recycling' | 'Other' | 'Unknown' {
  const siteType = normalizeSiteType(extractSiteTypeRaw(record));
  if (siteType === 'DMS' || siteType === 'FDS' || siteType === 'Landfill' || siteType === 'Recycling') {
    return siteType;
  }

  const disposalSite = normalizeLooseText(extractDisposalSiteRaw(record));
  if (!disposalSite) return 'Unknown';
  if (disposalSite.includes('landfill')) return 'Landfill';
  if (disposalSite.includes('recycl')) return 'Recycling';
  if (disposalSite.includes('dms') || disposalSite.includes('staging')) return 'DMS';
  if (disposalSite.includes('fds') || disposalSite.includes('final disposal')) return 'FDS';
  return 'Other';
}

function parseTimeLikeMinutes(value: SpreadsheetPrimitive): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 1) return roundNumber(value * 24 * 60, 3);
    return value;
  }

  const text = parseText(value);
  if (!text) return null;

  const hhmm = /(\d{1,2}):(\d{2})(?:\s*([ap]m))?/i.exec(text);
  if (hhmm) {
    let hours = Number(hhmm[1]);
    const minutes = Number(hhmm[2]);
    const meridiem = (hhmm[3] ?? '').toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  return parseNumber(text);
}

function collectRecordEvidenceRefs(record: NormalizedTransactionDataRecord): string[] {
  const refs = new Set<string>();
  refs.add(record.evidence_ref);
  for (const value of Object.values(record.field_evidence_ids)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      refs.add(value);
    }
  }
  return [...refs];
}

function bestHeaderMatch(
  sheet: WorkbookSheetModel,
  aliases: readonly string[],
  takenHeaders: Set<string>,
): { header: string; score: number } | null {
  let best: { header: string; score: number } | null = null;

  for (const header of sheet.headers) {
    if (takenHeaders.has(header)) continue;

    const normalized = normalizeHeader(header);
    let score = 0;
    for (const alias of aliases) {
      const normalizedAlias = normalizeHeader(alias);
      if (normalized === normalizedAlias) {
        score = Math.max(score, 100);
        continue;
      }
      if (normalized.startsWith(normalizedAlias) || normalized.endsWith(normalizedAlias)) {
        score = Math.max(score, 94);
        continue;
      }
      if (normalized.includes(normalizedAlias) || normalizedAlias.includes(normalized)) {
        score = Math.max(score, 84);
      }
    }

    if (!best || score > best.score) {
      best = { header, score };
    }
  }

  return best && best.score >= 84 ? best : null;
}

export function transactionDataCellEvidenceId(
  sheetKey: string,
  rowNumber: number,
  columnHeader: string,
  headers: string[],
): string {
  const columnIndex = headers.indexOf(columnHeader);
  const c = columnIndex >= 0 ? columnIndex : 0;
  return `cell:${sheetKey}:r${rowNumber}:c${c}`;
}

function mostFrequent(values: readonly string[]): string | null {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = value.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let winner: string | null = null;
  let bestScore = -1;
  for (const value of values) {
    const key = value.trim().toLowerCase();
    const score = counts.get(key) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      winner = value;
    }
  }

  return winner;
}

type SheetAnalysis = {
  sheet: WorkbookSheetModel;
  headerMatches: Partial<Record<TransactionDataFieldKey, TransactionDataHeaderMatch>>;
  matchedHeaders: Partial<Record<TransactionDataFieldKey, string>>;
  matchedFieldCount: number;
  score: number;
  metricColumns: string[];
  codeColumns: string[];
  amountColumns: string[];
  detectedSheetConfidence: number;
};

function analyzeSheet(
  sheet: WorkbookSheetModel,
  detectedSheets: DetectSheetsResult,
): SheetAnalysis {
  const takenHeaders = new Set<string>();
  const headerMatches: Partial<Record<TransactionDataFieldKey, TransactionDataHeaderMatch>> = {};
  const matchedHeaders: Partial<Record<TransactionDataFieldKey, string>> = {};

  for (const field of TRANSACTION_DATA_FIELD_ORDER) {
    const match = bestHeaderMatch(sheet, TRANSACTION_DATA_HEADER_ALIASES[field], takenHeaders);
    if (!match) continue;
    takenHeaders.add(match.header);

    const columnIndex = sheet.headers.indexOf(match.header);
    headerMatches[field] = {
      canonical_field: field,
      sheet_key: sheet.key,
      sheet_name: sheet.name,
      column_name: match.header,
      column_index: columnIndex,
      header_row_number: sheet.header_row_number,
    };
    matchedHeaders[field] = match.header;
  }

  const matchedFields = Object.keys(matchedHeaders) as TransactionDataFieldKey[];
  const detectedSheet =
    detectedSheets.sheets.find((candidate) => candidate.sheet_key === sheet.key) ?? null;

  return {
    sheet,
    headerMatches,
    matchedHeaders,
    matchedFieldCount: matchedFields.length,
    score:
      matchedFields.length
      + (matchedFields.some((field) => TRANSACTION_DATA_AMOUNT_FIELDS.has(field)) ? 2 : 0)
      + (matchedFields.some((field) => TRANSACTION_DATA_METRIC_FIELDS.has(field)) ? 1 : 0)
      + (matchedFields.some((field) => TRANSACTION_DATA_CODE_FIELDS.has(field)) ? 1 : 0),
    metricColumns: matchedFields
      .filter((field) => TRANSACTION_DATA_METRIC_FIELDS.has(field))
      .map((field) => matchedHeaders[field]!)
      .filter(Boolean),
    codeColumns: matchedFields
      .filter((field) => TRANSACTION_DATA_CODE_FIELDS.has(field))
      .map((field) => matchedHeaders[field]!)
      .filter(Boolean),
    amountColumns: matchedFields
      .filter((field) => TRANSACTION_DATA_AMOUNT_FIELDS.has(field))
      .map((field) => matchedHeaders[field]!)
      .filter(Boolean),
    detectedSheetConfidence: detectedSheet?.confidence ?? 0.55,
  };
}

function parseRecordValue(
  field: TransactionDataFieldKey,
  rawValue: SpreadsheetPrimitive,
): string | number | null {
  switch (field) {
    case 'invoice_date':
      return parseDate(rawValue);
    case 'transaction_quantity':
    case 'transaction_rate':
    case 'extended_cost':
    case 'net_quantity':
    case 'mileage':
    case 'cyd':
    case 'net_tonnage':
    case 'load_latitude':
    case 'load_longitude':
    case 'disposal_latitude':
    case 'disposal_longitude':
      return parseNumber(rawValue);
    default:
      return parseText(rawValue);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;

  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

const MISSING_BILLING_RATE_KEY = '__missing_billing_rate__';
const MISSING_INVOICE_KEY = '__missing_invoice__';
const MISSING_SITE_MATERIAL_KEY = '__missing_site_material__';

function sortDistinctStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en-US'));
}

function effectiveMaterial(record: NormalizedTransactionDataRecord): string | null {
  if (record.material?.trim()) return record.material.trim();
  return findRawRowText(record.raw_row, TRANSACTION_DATA_HEADER_ALIASES.material);
}

function extractDisposalSiteRaw(record: NormalizedTransactionDataRecord): string | null {
  return findRawRowText(record.raw_row, RAW_DISPOSAL_SITE_HEADER_ALIASES);
}

function extractSiteTypeRaw(record: NormalizedTransactionDataRecord): string | null {
  return findRawRowText(record.raw_row, RAW_SITE_TYPE_HEADER_ALIASES);
}

function invoiceRawForDistinct(record: NormalizedTransactionDataRecord): string | null {
  const inv = record.invoice_number;
  if (typeof inv === 'string' && inv.trim().length > 0) return inv.trim();
  return null;
}

function hasInvoiceLink(record: NormalizedTransactionDataRecord): boolean {
  return invoiceRawForDistinct(record) != null;
}

function recordSiteType(record: NormalizedTransactionDataRecord): string | null {
  return normalizeSiteType(extractSiteTypeRaw(record));
}

type RateGroupAcc = {
  normalized_rate_codes: Set<string>;
  descriptions: string[];
  invoice_numbers: Set<string>;
  materials: Set<string>;
  service_items: Set<string>;
  row_count: number;
  total_qty: number;
  total_cost: number;
};

function buildRateCodeGroups(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataRateCodeGroup[] {
  const groups = new Map<string, RateGroupAcc>();

  for (const record of records) {
    const mapKey = record.billing_rate_key ?? MISSING_BILLING_RATE_KEY;
    const existing = groups.get(mapKey) ?? {
      normalized_rate_codes: new Set<string>(),
      descriptions: [] as string[],
      invoice_numbers: new Set<string>(),
      materials: new Set<string>(),
      service_items: new Set<string>(),
      row_count: 0,
      total_qty: 0,
      total_cost: 0,
    };
    existing.row_count += 1;
    existing.total_qty += record.transaction_quantity ?? 0;
    existing.total_cost += record.extended_cost ?? 0;

    const rc = normalizeRateCode(record.rate_code);
    if (rc) existing.normalized_rate_codes.add(rc);

    if (record.rate_description?.trim()) {
      existing.descriptions.push(record.rate_description.trim());
    }

    const inv = invoiceRawForDistinct(record);
    if (inv) existing.invoice_numbers.add(inv);

    const mat = effectiveMaterial(record);
    if (mat) existing.materials.add(mat);

    if (record.service_item?.trim()) {
      existing.service_items.add(record.service_item.trim());
    }

    groups.set(mapKey, existing);
  }

  const result: TransactionDataRateCodeGroup[] = [];
  for (const [mapKey, acc] of groups) {
    const billing_rate_key = mapKey === MISSING_BILLING_RATE_KEY ? null : mapKey;
    const rate_codes_sorted = sortDistinctStrings(acc.normalized_rate_codes);
    const rate_code = rate_codes_sorted[0] ?? null;

    const desc_sorted = [...acc.descriptions].sort((a, b) => a.localeCompare(b, 'en-US'));
    const rate_description_sample = desc_sorted[0] ?? null;

    result.push({
      billing_rate_key,
      rate_code,
      rate_description_sample,
      row_count: acc.row_count,
      total_transaction_quantity: roundNumber(acc.total_qty, 3),
      total_extended_cost: roundNumber(acc.total_cost, 2),
      distinct_invoice_numbers: sortDistinctStrings(acc.invoice_numbers),
      distinct_materials: sortDistinctStrings(acc.materials),
      distinct_service_items: sortDistinctStrings(acc.service_items),
    });
  }

  return result.sort((left, right) => {
    if (left.billing_rate_key == null && right.billing_rate_key == null) return 0;
    if (left.billing_rate_key == null) return 1;
    if (right.billing_rate_key == null) return -1;
    return left.billing_rate_key.localeCompare(right.billing_rate_key, 'en-US');
  });
}

type InvoiceGroupAcc = {
  rate_codes: Set<string>;
  materials: Set<string>;
  service_items: Set<string>;
  row_count: number;
  total_qty: number;
  total_cost: number;
};

function buildInvoiceGroups(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataInvoiceGroup[] {
  const groups = new Map<string, InvoiceGroupAcc>();

  for (const record of records) {
    const mapKey = normalizeInvoiceNumber(record.invoice_number) ?? MISSING_INVOICE_KEY;
    const existing = groups.get(mapKey) ?? {
      rate_codes: new Set<string>(),
      materials: new Set<string>(),
      service_items: new Set<string>(),
      row_count: 0,
      total_qty: 0,
      total_cost: 0,
    };
    existing.row_count += 1;
    existing.total_qty += record.transaction_quantity ?? 0;
    existing.total_cost += record.extended_cost ?? 0;

    const rc = normalizeRateCode(record.rate_code);
    if (rc) existing.rate_codes.add(rc);

    const mat = effectiveMaterial(record);
    if (mat) existing.materials.add(mat);

    if (record.service_item?.trim()) {
      existing.service_items.add(record.service_item.trim());
    }

    groups.set(mapKey, existing);
  }

  const result: TransactionDataInvoiceGroup[] = [];
  for (const [mapKey, acc] of groups) {
    const invoice_number = mapKey === MISSING_INVOICE_KEY ? null : mapKey;
    result.push({
      invoice_number,
      row_count: acc.row_count,
      total_transaction_quantity: roundNumber(acc.total_qty, 3),
      total_extended_cost: roundNumber(acc.total_cost, 2),
      distinct_rate_codes: sortDistinctStrings(acc.rate_codes),
      distinct_materials: sortDistinctStrings(acc.materials),
      distinct_service_items: sortDistinctStrings(acc.service_items),
    });
  }

  return result.sort((left, right) => {
    if (left.invoice_number == null && right.invoice_number == null) return 0;
    if (left.invoice_number == null) return 1;
    if (right.invoice_number == null) return -1;
    return left.invoice_number.localeCompare(right.invoice_number, 'en-US');
  });
}

type SiteMaterialGroupAcc = {
  disposal_sites: string[];
  site_types: string[];
  materials: string[];
  rate_codes: Set<string>;
  invoice_numbers: Set<string>;
  row_count: number;
  total_qty: number;
  total_cost: number;
};

function buildSiteMaterialGroups(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataSiteMaterialGroup[] {
  const groups = new Map<string, SiteMaterialGroupAcc>();

  for (const record of records) {
    const mapKey = record.site_material_key ?? MISSING_SITE_MATERIAL_KEY;
    const existing = groups.get(mapKey) ?? {
      disposal_sites: [] as string[],
      site_types: [] as string[],
      materials: [] as string[],
      rate_codes: new Set<string>(),
      invoice_numbers: new Set<string>(),
      row_count: 0,
      total_qty: 0,
      total_cost: 0,
    };
    existing.row_count += 1;
    existing.total_qty += record.transaction_quantity ?? 0;
    existing.total_cost += record.extended_cost ?? 0;

    const disp = extractDisposalSiteRaw(record);
    if (disp) existing.disposal_sites.push(disp.trim());

    const st = extractSiteTypeRaw(record);
    if (st) existing.site_types.push(st.trim());

    const mat = effectiveMaterial(record);
    if (mat) existing.materials.push(mat);

    const rc = normalizeRateCode(record.rate_code);
    if (rc) existing.rate_codes.add(rc);

    const inv = invoiceRawForDistinct(record);
    if (inv) existing.invoice_numbers.add(inv);

    groups.set(mapKey, existing);
  }

  const result: TransactionDataSiteMaterialGroup[] = [];
  for (const [mapKey, acc] of groups) {
    const site_material_key = mapKey === MISSING_SITE_MATERIAL_KEY ? null : mapKey;

    const disp_sorted = [...acc.disposal_sites].sort((a, b) => a.localeCompare(b, 'en-US'));
    const disposal_site = disp_sorted[0] ?? null;

    const st_sorted = [...acc.site_types].sort((a, b) => a.localeCompare(b, 'en-US'));
    const disposal_site_type = st_sorted[0] ?? null;

    const mat_sorted = [...acc.materials].sort((a, b) => a.localeCompare(b, 'en-US'));
    const material = mat_sorted[0] ?? null;

    result.push({
      site_material_key,
      disposal_site,
      disposal_site_type,
      material,
      row_count: acc.row_count,
      total_transaction_quantity: roundNumber(acc.total_qty, 3),
      total_extended_cost: roundNumber(acc.total_cost, 2),
      distinct_rate_codes: sortDistinctStrings(acc.rate_codes),
      distinct_invoice_numbers: sortDistinctStrings(acc.invoice_numbers),
    });
  }

  return result.sort((left, right) => {
    if (left.site_material_key == null && right.site_material_key == null) return 0;
    if (left.site_material_key == null) return 1;
    if (right.site_material_key == null) return -1;
    return left.site_material_key.localeCompare(right.site_material_key, 'en-US');
  });
}

type ReviewGroupAccumulator = {
  row_count: number;
  total_qty: number;
  total_cyd: number;
  total_cost: number;
  invoiced_ticket_count: number;
  uninvoiced_line_count: number;
  invoice_numbers: Set<string>;
  rate_codes: Set<string>;
  record_ids: string[];
  evidence_refs: string[];
};

function createReviewGroupAccumulator(): ReviewGroupAccumulator {
  return {
    row_count: 0,
    total_qty: 0,
    total_cyd: 0,
    total_cost: 0,
    invoiced_ticket_count: 0,
    uninvoiced_line_count: 0,
    invoice_numbers: new Set<string>(),
    rate_codes: new Set<string>(),
    record_ids: [],
    evidence_refs: [],
  };
}

function pushReviewGroupRecord(
  accumulator: ReviewGroupAccumulator,
  record: NormalizedTransactionDataRecord,
): void {
  accumulator.row_count += 1;
  accumulator.total_qty += record.transaction_quantity ?? 0;
  accumulator.total_cyd += record.cyd ?? 0;
  accumulator.total_cost += record.extended_cost ?? 0;

  const invoiceNumber = invoiceRawForDistinct(record);
  if (invoiceNumber) {
    accumulator.invoiced_ticket_count += 1;
    accumulator.invoice_numbers.add(invoiceNumber);
  } else {
    accumulator.uninvoiced_line_count += 1;
  }

  const rateCode = normalizeRateCode(record.rate_code);
  if (rateCode) accumulator.rate_codes.add(rateCode);

  accumulator.record_ids.push(record.id);
  accumulator.evidence_refs.push(record.evidence_ref);
}

function finalizeReviewGroupBase(
  accumulator: ReviewGroupAccumulator,
): Pick<
  TransactionDataServiceItemGroup,
  | 'row_count'
  | 'total_transaction_quantity'
  | 'total_cyd'
  | 'total_extended_cost'
  | 'invoiced_ticket_count'
  | 'uninvoiced_line_count'
  | 'distinct_invoice_numbers'
  | 'distinct_rate_codes'
  | 'record_ids'
  | 'evidence_refs'
> {
  return {
    row_count: accumulator.row_count,
    total_transaction_quantity: roundNumber(accumulator.total_qty, 3),
    total_cyd: roundNumber(accumulator.total_cyd, 3),
    total_extended_cost: roundNumber(accumulator.total_cost, 2),
    invoiced_ticket_count: accumulator.invoiced_ticket_count,
    uninvoiced_line_count: accumulator.uninvoiced_line_count,
    distinct_invoice_numbers: sortDistinctStrings(accumulator.invoice_numbers),
    distinct_rate_codes: sortDistinctStrings(accumulator.rate_codes),
    record_ids: accumulator.record_ids.sort((left, right) => left.localeCompare(right, 'en-US')),
    evidence_refs: sortDistinctStrings(accumulator.evidence_refs),
  };
}

function buildServiceItemGroups(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataServiceItemGroup[] {
  const groups = new Map<string, { label: string | null; accumulator: ReviewGroupAccumulator }>();

  for (const record of records) {
    const serviceItem = record.service_item?.trim() ?? null;
    const mapKey = normalizeLooseText(serviceItem) ?? '__missing_service_item__';
    const existing = groups.get(mapKey) ?? {
      label: serviceItem,
      accumulator: createReviewGroupAccumulator(),
    };
    pushReviewGroupRecord(existing.accumulator, record);
    groups.set(mapKey, existing);
  }

  return [...groups.entries()]
    .map(([mapKey, group]) => ({
      service_item: mapKey === '__missing_service_item__' ? null : group.label,
      ...finalizeReviewGroupBase(group.accumulator),
    }))
    .sort((left, right) => (left.service_item ?? '').localeCompare(right.service_item ?? '', 'en-US'));
}

function buildMaterialGroups(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataMaterialGroup[] {
  const groups = new Map<string, {
    label: string | null;
    disposal_sites: Set<string>;
    site_types: Set<string>;
    accumulator: ReviewGroupAccumulator;
  }>();

  for (const record of records) {
    const material = effectiveMaterial(record);
    const mapKey = normalizeLooseText(material) ?? '__missing_material__';
    const existing = groups.get(mapKey) ?? {
      label: material,
      disposal_sites: new Set<string>(),
      site_types: new Set<string>(),
      accumulator: createReviewGroupAccumulator(),
    };
    const disposalSite = extractDisposalSiteRaw(record);
    const siteType = recordSiteType(record);
    if (disposalSite) existing.disposal_sites.add(disposalSite);
    if (siteType) existing.site_types.add(siteType);
    pushReviewGroupRecord(existing.accumulator, record);
    groups.set(mapKey, existing);
  }

  return [...groups.entries()]
    .map(([mapKey, group]) => ({
      material: mapKey === '__missing_material__' ? null : group.label,
      disposal_sites: sortDistinctStrings(group.disposal_sites),
      site_types: sortDistinctStrings(group.site_types),
      ...finalizeReviewGroupBase(group.accumulator),
    }))
    .sort((left, right) => (left.material ?? '').localeCompare(right.material ?? '', 'en-US'));
}

function buildSiteTypeGroups(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataSiteTypeGroup[] {
  const groups = new Map<string, {
    label: string | null;
    disposal_sites: Set<string>;
    materials: Set<string>;
    accumulator: ReviewGroupAccumulator;
  }>();

  for (const record of records) {
    const siteType = recordSiteType(record);
    const mapKey = normalizeLooseText(siteType) ?? '__missing_site_type__';
    const existing = groups.get(mapKey) ?? {
      label: siteType,
      disposal_sites: new Set<string>(),
      materials: new Set<string>(),
      accumulator: createReviewGroupAccumulator(),
    };
    const disposalSite = extractDisposalSiteRaw(record);
    const material = effectiveMaterial(record);
    if (disposalSite) existing.disposal_sites.add(disposalSite);
    if (material) existing.materials.add(material);
    pushReviewGroupRecord(existing.accumulator, record);
    groups.set(mapKey, existing);
  }

  return [...groups.entries()]
    .map(([mapKey, group]) => ({
      site_type: mapKey === '__missing_site_type__' ? null : group.label,
      disposal_sites: sortDistinctStrings(group.disposal_sites),
      materials: sortDistinctStrings(group.materials),
      ...finalizeReviewGroupBase(group.accumulator),
    }))
    .sort((left, right) => (left.site_type ?? '').localeCompare(right.site_type ?? '', 'en-US'));
}

function buildDisposalSiteGroups(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataDisposalSiteGroup[] {
  const groups = new Map<string, {
    label: string | null;
    site_types: Set<string>;
    materials: Set<string>;
    accumulator: ReviewGroupAccumulator;
  }>();

  for (const record of records) {
    const disposalSite = extractDisposalSiteRaw(record);
    const mapKey = normalizeLooseText(disposalSite) ?? '__missing_disposal_site__';
    const existing = groups.get(mapKey) ?? {
      label: disposalSite,
      site_types: new Set<string>(),
      materials: new Set<string>(),
      accumulator: createReviewGroupAccumulator(),
    };
    const siteType = recordSiteType(record);
    const material = effectiveMaterial(record);
    if (siteType) existing.site_types.add(siteType);
    if (material) existing.materials.add(material);
    pushReviewGroupRecord(existing.accumulator, record);
    groups.set(mapKey, existing);
  }

  return [...groups.entries()]
    .map(([mapKey, group]) => ({
      disposal_site: mapKey === '__missing_disposal_site__' ? null : group.label,
      site_types: sortDistinctStrings(group.site_types),
      materials: sortDistinctStrings(group.materials),
      ...finalizeReviewGroupBase(group.accumulator),
    }))
    .sort((left, right) => (left.disposal_site ?? '').localeCompare(right.disposal_site ?? '', 'en-US'));
}

function findExtremeUnitRateSignals(
  records: readonly NormalizedTransactionDataRecord[],
): Map<string, ReviewRowSignal> {
  const baselineRatesByBillingKey = new Map<string, number[]>();

  for (const record of records) {
    if (!record.billing_rate_key || record.transaction_rate == null || !Number.isFinite(record.transaction_rate)) {
      continue;
    }
    if (record.transaction_rate <= 0) continue;

    const existing = baselineRatesByBillingKey.get(record.billing_rate_key) ?? [];
    existing.push(record.transaction_rate);
    baselineRatesByBillingKey.set(record.billing_rate_key, existing);
  }

  const outliers = new Map<string, ReviewRowSignal>();

  for (const record of records) {
    if (!record.billing_rate_key || record.transaction_rate == null || !Number.isFinite(record.transaction_rate)) {
      continue;
    }

    const rates = baselineRatesByBillingKey.get(record.billing_rate_key) ?? [];
    if (rates.length < 3) continue;

    const medianRate = median(rates);
    if (!(medianRate > 0)) continue;

    const lowerBound = medianRate / 3;
    const upperBound = medianRate * 3;
    if (record.transaction_rate < lowerBound || record.transaction_rate > upperBound) {
      outliers.set(record.id, {
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: `transaction rate ${record.transaction_rate} deviates from ${roundNumber(medianRate, 2)} baseline`,
        severity: 'warning',
      });
    }
  }

  return outliers;
}

function buildProjectOperationsOverview(params: {
  records: readonly NormalizedTransactionDataRecord[];
  inferredProjectName: string | null;
  sheetNames: string[];
  distinctServiceItems: string[];
  distinctMaterials: string[];
  groupedBySiteType: readonly TransactionDataSiteTypeGroup[];
  groupedByDisposalSite: readonly TransactionDataDisposalSiteGroup[];
  totalTransactionQuantity: number;
  totalCyd: number;
  totalInvoicedAmount: number;
  distinctInvoiceCount: number;
  invoicedTicketCount: number;
  uninvoicedLineCount: number;
  eligibleCount: number;
  ineligibleCount: number;
  unknownEligibilityCount: number;
}): TransactionDataProjectOperationsOverview {
  return {
    project_name: params.inferredProjectName,
    total_tickets: params.records.length,
    total_transaction_quantity: roundNumber(params.totalTransactionQuantity, 3),
    total_cyd: roundNumber(params.totalCyd, 3),
    total_invoiced_amount: roundNumber(params.totalInvoicedAmount, 2),
    distinct_invoice_count: params.distinctInvoiceCount,
    invoiced_ticket_count: params.invoicedTicketCount,
    uninvoiced_line_count: params.uninvoicedLineCount,
    eligible_count: params.eligibleCount,
    ineligible_count: params.ineligibleCount,
    unknown_eligibility_count: params.unknownEligibilityCount,
    distinct_service_item_count: params.distinctServiceItems.length,
    distinct_material_count: params.distinctMaterials.length,
    distinct_site_type_count: params.groupedBySiteType.filter((group) => group.site_type != null).length,
    distinct_disposal_site_count: params.groupedByDisposalSite.filter((group) => group.disposal_site != null).length,
    reviewed_sheet_names: [...params.sheetNames],
    record_ids: params.records.map((record) => record.id),
    evidence_refs: sortDistinctStrings(params.records.map((record) => record.evidence_ref)),
  };
}

function buildInvoiceReadinessSummary(params: {
  records: readonly NormalizedTransactionDataRecord[];
  rollups: Pick<
    TransactionDataRollups,
    | 'invoiced_ticket_count'
    | 'distinct_invoice_count'
    | 'total_invoiced_amount'
    | 'uninvoiced_line_count'
    | 'rows_with_missing_rate_code'
    | 'rows_with_missing_quantity'
    | 'rows_with_missing_extended_cost'
    | 'rows_with_zero_cost'
    | 'rows_with_extreme_unit_rate'
    | 'outlier_rows'
  >;
}): TransactionDataInvoiceReadinessSummary {
  const blockingReasons = [
    params.rollups.uninvoiced_line_count > 0 ? 'uninvoiced rows remain in the dataset' : null,
    params.rollups.rows_with_missing_rate_code > 0 ? 'rate code is missing on one or more rows' : null,
    params.rollups.rows_with_missing_quantity > 0 ? 'quantity is missing on one or more rows' : null,
    params.rollups.rows_with_missing_extended_cost > 0 ? 'extended cost is missing on one or more rows' : null,
    params.rollups.rows_with_zero_cost > 0 ? 'zero-cost transaction rows require review' : null,
    params.rollups.rows_with_extreme_unit_rate > 0 ? 'rate outliers were detected' : null,
  ].filter((value): value is string => value != null);

  const status =
    blockingReasons.length === 0
      ? 'ready'
      : params.rollups.invoiced_ticket_count > 0
        ? 'partial'
        : 'needs_review';

  return {
    status,
    total_tickets: params.records.length,
    invoiced_ticket_count: params.rollups.invoiced_ticket_count,
    distinct_invoice_count: params.rollups.distinct_invoice_count,
    total_invoiced_amount: roundNumber(params.rollups.total_invoiced_amount, 2),
    uninvoiced_line_count: params.rollups.uninvoiced_line_count,
    rows_with_missing_rate_code: params.rollups.rows_with_missing_rate_code,
    rows_with_missing_quantity: params.rollups.rows_with_missing_quantity,
    rows_with_missing_extended_cost: params.rollups.rows_with_missing_extended_cost,
    rows_with_zero_cost: params.rollups.rows_with_zero_cost,
    rows_with_extreme_unit_rate: params.rollups.rows_with_extreme_unit_rate,
    outlier_row_count: params.rollups.outlier_rows.length,
    blocking_reasons: blockingReasons,
    record_ids: params.records.map((record) => record.id),
    evidence_refs: sortDistinctStrings(params.records.map((record) => record.evidence_ref)),
  };
}

function buildLifecycleSummary(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataDmsFdsLifecycleSummary {
  const groups = new Map<string, {
    row_count: number;
    total_cyd: number;
    total_extended_cost: number;
    disposal_sites: Set<string>;
    materials: Set<string>;
    record_ids: string[];
    evidence_refs: string[];
  }>();
  const materialStageMap = new Map<string, Set<string>>();

  for (const record of records) {
    const stage = lifecycleStageForRecord(record);
    const existing = groups.get(stage) ?? {
      row_count: 0,
      total_cyd: 0,
      total_extended_cost: 0,
      disposal_sites: new Set<string>(),
      materials: new Set<string>(),
      record_ids: [] as string[],
      evidence_refs: [] as string[],
    };
    existing.row_count += 1;
    existing.total_cyd += record.cyd ?? 0;
    existing.total_extended_cost += record.extended_cost ?? 0;
    const disposalSite = extractDisposalSiteRaw(record);
    const material = effectiveMaterial(record);
    if (disposalSite) existing.disposal_sites.add(disposalSite);
    if (material) {
      existing.materials.add(material);
      const stages = materialStageMap.get(normalizeLooseText(material) ?? material) ?? new Set<string>();
      stages.add(stage);
      materialStageMap.set(normalizeLooseText(material) ?? material, stages);
    }
    existing.record_ids.push(record.id);
    existing.evidence_refs.push(record.evidence_ref);
    groups.set(stage, existing);
  }

  const lifecycleGroups = [...groups.entries()]
    .map(([stage, group]) => ({
      lifecycle_stage: stage as TransactionDataDmsFdsLifecycleSummary['lifecycle_groups'][number]['lifecycle_stage'],
      row_count: group.row_count,
      total_cyd: roundNumber(group.total_cyd, 3),
      total_extended_cost: roundNumber(group.total_extended_cost, 2),
      disposal_sites: sortDistinctStrings(group.disposal_sites),
      materials: sortDistinctStrings(group.materials),
      record_ids: group.record_ids.sort((left, right) => left.localeCompare(right, 'en-US')),
      evidence_refs: sortDistinctStrings(group.evidence_refs),
    }))
    .sort((left, right) => left.lifecycle_stage.localeCompare(right.lifecycle_stage, 'en-US'));

  const mixedMaterialFlowCount = [...materialStageMap.values()]
    .filter((stages) => stages.size > 1)
    .length;

  return {
    lifecycle_groups: lifecycleGroups,
    dms_row_count: lifecycleGroups.find((group) => group.lifecycle_stage === 'DMS')?.row_count ?? 0,
    fds_row_count: lifecycleGroups.find((group) => group.lifecycle_stage === 'FDS')?.row_count ?? 0,
    other_row_count: lifecycleGroups
      .filter((group) => !['DMS', 'FDS', 'Unknown'].includes(group.lifecycle_stage))
      .reduce((sum, group) => sum + group.row_count, 0),
    unknown_row_count: lifecycleGroups.find((group) => group.lifecycle_stage === 'Unknown')?.row_count ?? 0,
    mixed_material_flow_count: mixedMaterialFlowCount,
    record_ids: records.map((record) => record.id),
    evidence_refs: sortDistinctStrings(records.map((record) => record.evidence_ref)),
  };
}

function buildReviewBucket(params: {
  reviewKey: TransactionDataOpsReviewBucket['review_key'];
  label: string;
  records: readonly NormalizedTransactionDataRecord[];
  available: boolean;
  supportingColumns: string[];
  flaggedSignals: readonly ReviewRowSignal[];
  unavailableSummary: string;
  okSummary: string;
  flaggedSummary: string;
}): TransactionDataOpsReviewBucket {
  if (!params.available) {
    return {
      review_key: params.reviewKey,
      label: params.label,
      available: false,
      status: 'unavailable',
      reviewed_row_count: 0,
      flagged_row_count: 0,
      supporting_columns: params.supportingColumns,
      summary: params.unavailableSummary,
      flagged_record_ids: [],
      flagged_evidence_refs: [],
    };
  }

  const flaggedRecordIds = sortDistinctStrings(params.flaggedSignals.map((signal) => signal.recordId));
  const flaggedEvidenceRefs = sortDistinctStrings(params.flaggedSignals.map((signal) => signal.evidenceRef));

  return {
    review_key: params.reviewKey,
    label: params.label,
    available: true,
    status: params.flaggedSignals.length > 0 ? 'review' : 'ok',
    reviewed_row_count: params.records.length,
    flagged_row_count: flaggedRecordIds.length,
    supporting_columns: params.supportingColumns,
    summary: params.flaggedSignals.length > 0 ? params.flaggedSummary : params.okSummary,
    flagged_record_ids: flaggedRecordIds,
    flagged_evidence_refs: flaggedEvidenceRefs,
  };
}

function buildBoundaryLocationReview(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataOpsReviewBucket {
  const supportingColumns = sortDistinctStrings([
    ...collectMatchingHeaders(records, RAW_BOUNDARY_LOCATION_HEADER_ALIASES),
    ...collectMatchingHeaders(records, ['load latitude', 'load longitude', 'disposal latitude', 'disposal longitude']),
    ...collectMatchingHeaders(records, RAW_DISPOSAL_SITE_HEADER_ALIASES),
  ]);

  const available = supportingColumns.length > 0 || records.some((record) => (
    record.project_name != null
    || record.load_latitude != null
    || record.load_longitude != null
    || record.disposal_latitude != null
    || record.disposal_longitude != null
    || extractDisposalSiteRaw(record) != null
  ));

  const flaggedSignals: ReviewRowSignal[] = [];
  for (const record of records) {
    const hasLoadPair =
      record.load_latitude != null && record.load_longitude != null;
    const hasDisposalPair =
      record.disposal_latitude != null && record.disposal_longitude != null;
    const hasBoundaryText = findRawRowText(record.raw_row, RAW_BOUNDARY_LOCATION_HEADER_ALIASES) != null;
    const hasDisposalSite = extractDisposalSiteRaw(record) != null;
    const partialCoords =
      (record.load_latitude != null) !== (record.load_longitude != null)
      || (record.disposal_latitude != null) !== (record.disposal_longitude != null);

    if (partialCoords) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'partial location coordinates',
        severity: 'warning',
      });
      continue;
    }

    if (!hasLoadPair && !hasDisposalPair && !hasBoundaryText && !hasDisposalSite && !record.project_name) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'no location or boundary evidence on the row',
        severity: 'warning',
      });
    }
  }

  return buildReviewBucket({
    reviewKey: 'boundary_location_review',
    label: 'Boundary / location review',
    records,
    available,
    supportingColumns,
    flaggedSignals,
    unavailableSummary: 'No boundary or location columns were detected in the workbook.',
    okSummary: 'Location coverage is present for the normalized transaction rows.',
    flaggedSummary: `${sortDistinctStrings(flaggedSignals.map((signal) => signal.recordId)).length} row(s) need location or boundary review.`,
  });
}

function buildDistanceFromFeatureReview(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataOpsReviewBucket {
  const supportingColumns = collectMatchingHeaders(records, RAW_DISTANCE_FROM_FEATURE_HEADER_ALIASES);
  const values = records.map((record) => parseNumber(findRawRowValue(record.raw_row, RAW_DISTANCE_FROM_FEATURE_HEADER_ALIASES)));
  const numericValues = values.filter((value): value is number => value != null);
  const medianDistance = numericValues.length >= 4 ? median(numericValues) : null;
  const flaggedSignals: ReviewRowSignal[] = [];

  records.forEach((record, index) => {
    const value = values[index];
    if (supportingColumns.length === 0) return;
    if (value == null) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'distance-from-feature value is missing',
        severity: 'warning',
      });
      return;
    }
    if (value < 0) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'distance-from-feature value is negative',
        severity: 'critical',
      });
      return;
    }
    if ((medianDistance != null && medianDistance > 0 && value > medianDistance * 3) || value > 5280) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'distance-from-feature value is unusually high',
        severity: 'warning',
      });
    }
  });

  return buildReviewBucket({
    reviewKey: 'distance_from_feature_review',
    label: 'Distance-from-feature review',
    records,
    available: supportingColumns.length > 0,
    supportingColumns,
    flaggedSignals,
    unavailableSummary: 'No distance-from-feature columns were detected in the workbook.',
    okSummary: 'Distance-from-feature values were detected without outlier signals.',
    flaggedSummary: `${sortDistinctStrings(flaggedSignals.map((signal) => signal.recordId)).length} row(s) need distance-from-feature review.`,
  });
}

function buildDebrisClassAtDisposalSiteReview(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataOpsReviewBucket {
  const supportingColumns = sortDistinctStrings([
    ...collectMatchingHeaders(records, TRANSACTION_DATA_HEADER_ALIASES.material),
    ...collectMatchingHeaders(records, RAW_DISPOSAL_SITE_HEADER_ALIASES),
    ...collectMatchingHeaders(records, RAW_SITE_TYPE_HEADER_ALIASES),
  ]);

  const siteMaterials = new Map<string, Set<string>>();
  const flaggedSignals: ReviewRowSignal[] = [];

  for (const record of records) {
    const siteKey =
      normalizeLooseText(extractDisposalSiteRaw(record))
      ?? normalizeLooseText(recordSiteType(record))
      ?? '__unknown_site__';
    const material = normalizeLooseText(effectiveMaterial(record));
    const materials = siteMaterials.get(siteKey) ?? new Set<string>();
    if (material) materials.add(material);
    siteMaterials.set(siteKey, materials);

    if (!material || siteKey === '__unknown_site__') {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'material or disposal-site context is missing',
        severity: 'warning',
      });
    }
  }

  for (const record of records) {
    const siteKey =
      normalizeLooseText(extractDisposalSiteRaw(record))
      ?? normalizeLooseText(recordSiteType(record))
      ?? '__unknown_site__';
    const materials = siteMaterials.get(siteKey) ?? new Set<string>();
    if (materials.size > 1) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'disposal site carries multiple debris classes',
        severity: 'warning',
      });
    }
  }

  return buildReviewBucket({
    reviewKey: 'debris_class_at_disposal_site_review',
    label: 'Debris class at disposal site review',
    records,
    available: supportingColumns.length > 0,
    supportingColumns,
    flaggedSignals,
    unavailableSummary: 'No disposal-site or material columns were detected in the workbook.',
    okSummary: 'Debris class signals are consistent within the detected disposal-site groupings.',
    flaggedSummary: `${sortDistinctStrings(flaggedSignals.map((signal) => signal.recordId)).length} row(s) need debris-class / disposal-site review.`,
  });
}

function buildMileageReview(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataOpsReviewBucket {
  const supportingColumns = sortDistinctStrings([
    ...collectMatchingHeaders(records, TRANSACTION_DATA_HEADER_ALIASES.mileage),
    ...collectMatchingHeaders(records, ['mileage']),
  ]);
  const numericValues = records
    .map((record) => record.mileage)
    .filter((value): value is number => value != null);
  const medianMileage = numericValues.length >= 4 ? median(numericValues) : null;
  const flaggedSignals: ReviewRowSignal[] = [];

  for (const record of records) {
    if (supportingColumns.length === 0 && record.mileage == null) continue;
    if (record.mileage == null) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'mileage is missing',
        severity: 'warning',
      });
      continue;
    }
    if (record.mileage < 0) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'mileage is negative',
        severity: 'critical',
      });
      continue;
    }
    if ((medianMileage != null && medianMileage > 0 && record.mileage > medianMileage * 3) || record.mileage > 150) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'mileage is unusually high',
        severity: 'warning',
      });
    }
  }

  return buildReviewBucket({
    reviewKey: 'mileage_review',
    label: 'Mileage review',
    records,
    available: supportingColumns.length > 0 || numericValues.length > 0,
    supportingColumns,
    flaggedSignals,
    unavailableSummary: 'No mileage fields were detected in the workbook.',
    okSummary: 'Mileage values were detected without outlier signals.',
    flaggedSummary: `${sortDistinctStrings(flaggedSignals.map((signal) => signal.recordId)).length} row(s) need mileage review.`,
  });
}

function buildLoadCallReview(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataOpsReviewBucket {
  const supportingColumns = collectMatchingHeaders(records, RAW_LOAD_CALL_HEADER_ALIASES);
  const flaggedSignals: ReviewRowSignal[] = [];

  for (const record of records) {
    if (supportingColumns.length === 0) continue;
    const loadCallValue = findRawRowValue(record.raw_row, RAW_LOAD_CALL_HEADER_ALIASES);
    if (parseText(loadCallValue) == null && parseNumber(loadCallValue) == null) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'load-call value is missing',
        severity: 'warning',
      });
    }
  }

  return buildReviewBucket({
    reviewKey: 'load_call_review',
    label: 'Load-call review',
    records,
    available: supportingColumns.length > 0,
    supportingColumns,
    flaggedSignals,
    unavailableSummary: 'No load-call fields were detected in the workbook.',
    okSummary: 'Load-call columns are populated on the reviewed rows.',
    flaggedSummary: `${sortDistinctStrings(flaggedSignals.map((signal) => signal.recordId)).length} row(s) need load-call review.`,
  });
}

function buildLinkedMobileLoadConsistencyReview(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataOpsReviewBucket {
  const supportingColumns = sortDistinctStrings([
    ...collectMatchingHeaders(records, RAW_MOBILE_TICKET_HEADER_ALIASES),
    ...collectMatchingHeaders(records, RAW_LINKED_MOBILE_HEADER_ALIASES),
    ...collectMatchingHeaders(records, RAW_LOAD_TICKET_HEADER_ALIASES),
  ]);

  const mobileIds = new Set<string>();
  for (const record of records) {
    const mobileId = parseText(findRawRowValue(record.raw_row, RAW_MOBILE_TICKET_HEADER_ALIASES));
    if (mobileId) mobileIds.add(mobileId);
  }

  const flaggedSignals: ReviewRowSignal[] = [];
  for (const record of records) {
    if (supportingColumns.length === 0) continue;
    const loadId = parseText(findRawRowValue(record.raw_row, RAW_LOAD_TICKET_HEADER_ALIASES));
    const linkedMobileId = parseText(findRawRowValue(record.raw_row, RAW_LINKED_MOBILE_HEADER_ALIASES));
    if (loadId && !linkedMobileId) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'load ticket is missing a linked mobile ticket id',
        severity: 'warning',
      });
      continue;
    }
    if (linkedMobileId && mobileIds.size > 0 && !mobileIds.has(linkedMobileId)) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'linked mobile ticket id is not present in the dataset',
        severity: 'warning',
      });
    }
  }

  return buildReviewBucket({
    reviewKey: 'linked_mobile_load_consistency_review',
    label: 'Linked mobile/load consistency review',
    records,
    available: supportingColumns.length > 0,
    supportingColumns,
    flaggedSignals,
    unavailableSummary: 'No mobile/load linkage fields were detected in the workbook.',
    okSummary: 'Detected mobile/load linkage fields are internally consistent.',
    flaggedSummary: `${sortDistinctStrings(flaggedSignals.map((signal) => signal.recordId)).length} row(s) need linked mobile/load review.`,
  });
}

function buildTruckTripTimeReview(
  records: readonly NormalizedTransactionDataRecord[],
): TransactionDataOpsReviewBucket {
  const supportingColumns = sortDistinctStrings([
    ...collectMatchingHeaders(records, RAW_TRIP_TIME_HEADER_ALIASES),
    ...collectMatchingHeaders(records, RAW_TRIP_START_HEADER_ALIASES),
    ...collectMatchingHeaders(records, RAW_TRIP_END_HEADER_ALIASES),
  ]);

  const durationValues: number[] = [];
  const rowDurations = new Map<string, number | null>();
  for (const record of records) {
    const explicitDuration = parseNumber(findRawRowValue(record.raw_row, RAW_TRIP_TIME_HEADER_ALIASES));
    if (explicitDuration != null) {
      rowDurations.set(record.id, explicitDuration);
      durationValues.push(explicitDuration);
      continue;
    }

    const startMinutes = parseTimeLikeMinutes(findRawRowValue(record.raw_row, RAW_TRIP_START_HEADER_ALIASES));
    const endMinutes = parseTimeLikeMinutes(findRawRowValue(record.raw_row, RAW_TRIP_END_HEADER_ALIASES));
    if (startMinutes != null && endMinutes != null) {
      const duration = endMinutes >= startMinutes
        ? endMinutes - startMinutes
        : (24 * 60 - startMinutes) + endMinutes;
      rowDurations.set(record.id, duration);
      durationValues.push(duration);
    } else {
      rowDurations.set(record.id, null);
    }
  }

  const medianDuration = durationValues.length >= 4 ? median(durationValues) : null;
  const flaggedSignals: ReviewRowSignal[] = [];
  for (const record of records) {
    if (supportingColumns.length === 0) continue;
    const duration = rowDurations.get(record.id) ?? null;
    if (duration == null) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'trip time is missing or incomplete',
        severity: 'warning',
      });
      continue;
    }
    if (duration < 0) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'trip time is negative',
        severity: 'critical',
      });
      continue;
    }
    if ((medianDuration != null && medianDuration > 0 && duration > medianDuration * 3) || duration > 24 * 60) {
      flaggedSignals.push({
        recordId: record.id,
        evidenceRef: record.evidence_ref,
        reason: 'trip time is unusually high',
        severity: 'warning',
      });
    }
  }

  return buildReviewBucket({
    reviewKey: 'truck_trip_time_review',
    label: 'Truck trip time review',
    records,
    available: supportingColumns.length > 0,
    supportingColumns,
    flaggedSignals,
    unavailableSummary: 'No trip-time fields were detected in the workbook.',
    okSummary: 'Trip-time coverage is present without outlier signals.',
    flaggedSummary: `${sortDistinctStrings(flaggedSignals.map((signal) => signal.recordId)).length} row(s) need truck trip-time review.`,
  });
}

function buildOutlierRows(params: {
  records: readonly NormalizedTransactionDataRecord[];
  extremeRateSignals: Map<string, ReviewRowSignal>;
  reviewBuckets: readonly TransactionDataOpsReviewBucket[];
}): TransactionDataOutlierRow[] {
  const reasonsByRecordId = new Map<string, Array<{ reason: string; severity: 'warning' | 'critical' }>>();
  const hasEligibilitySignals =
    params.records.some((record) => parseText(record.eligibility) != null)
    || collectMatchingHeaders(params.records, TRANSACTION_DATA_HEADER_ALIASES.eligibility).length > 0;

  const pushReason = (
    record: NormalizedTransactionDataRecord,
    reason: string,
    severity: 'warning' | 'critical',
  ) => {
    const existing = reasonsByRecordId.get(record.id) ?? [];
    if (!existing.some((entry) => entry.reason === reason)) {
      existing.push({ reason, severity });
      reasonsByRecordId.set(record.id, existing);
    }
  };

  for (const record of params.records) {
    if (record.rate_code == null) pushReason(record, 'missing rate code', 'warning');
    if (record.invoice_number == null) pushReason(record, 'missing invoice number', 'warning');
    if (record.transaction_quantity == null) pushReason(record, 'missing quantity', 'warning');
    if (record.extended_cost == null) pushReason(record, 'missing extended cost', 'warning');
    if (record.extended_cost === 0) pushReason(record, 'zero extended cost', 'warning');
    if (hasEligibilitySignals && normalizeEligibility(record.eligibility) === 'unknown') {
      pushReason(record, 'eligibility status unresolved', 'warning');
    }
  }

  for (const signal of params.extremeRateSignals.values()) {
    const record = params.records.find((entry) => entry.id === signal.recordId);
    if (record) pushReason(record, signal.reason, signal.severity);
  }

  for (const bucket of params.reviewBuckets) {
    for (const recordId of bucket.flagged_record_ids) {
      const record = params.records.find((entry) => entry.id === recordId);
      if (!record) continue;
      pushReason(record, bucket.label, 'warning');
    }
  }

  return params.records
    .filter((record) => reasonsByRecordId.has(record.id))
    .map((record) => {
      const reasons = reasonsByRecordId.get(record.id) ?? [];
      const severity = (reasons.some((reason) => reason.severity === 'critical') ? 'critical' : 'warning') as 'critical' | 'warning';
      return {
        record_id: record.id,
        transaction_number: record.transaction_number,
        invoice_number: record.invoice_number,
        billing_rate_key: record.billing_rate_key,
        description_match_key: record.description_match_key,
        source_sheet_name: record.source_sheet_name,
        source_row_number: record.source_row_number,
        severity,
        reasons: reasons.map((reason) => reason.reason).sort((left, right) => left.localeCompare(right, 'en-US')),
        metrics: {
          transaction_quantity: record.transaction_quantity,
          transaction_rate: record.transaction_rate,
          extended_cost: record.extended_cost,
          mileage: record.mileage,
          cyd: record.cyd,
          net_tonnage: record.net_tonnage,
        },
        evidence_refs: collectRecordEvidenceRefs(record),
      };
    })
    .sort((left, right) => {
      const severityDelta = (left.severity === 'critical' ? 0 : 1) - (right.severity === 'critical' ? 0 : 1);
      if (severityDelta !== 0) return severityDelta;
      const sheetDelta = left.source_sheet_name.localeCompare(right.source_sheet_name, 'en-US');
      if (sheetDelta !== 0) return sheetDelta;
      return left.source_row_number - right.source_row_number;
    });
}

function buildRecord(
  analysis: SheetAnalysis,
  row: WorkbookSheetModel['rows'][number],
): NormalizedTransactionDataRecord {
  const columnHeaders: Partial<Record<TransactionDataFieldKey, string>> = {};
  const fieldEvidenceIds: Partial<Record<TransactionDataFieldKey, string>> = {};
  const parsedValues = new Map<TransactionDataFieldKey, string | number | null>();

  for (const [field, headerMatch] of Object.entries(analysis.headerMatches) as Array<[TransactionDataFieldKey, TransactionDataHeaderMatch]>) {
    const header = headerMatch.column_name;
    columnHeaders[field] = header;
    fieldEvidenceIds[field] = transactionDataCellEvidenceId(
      analysis.sheet.key,
      row.row_number,
      header,
      analysis.sheet.headers,
    );
    parsedValues.set(field, parseRecordValue(field, row.values[header] ?? null));
  }

  const missingFields = [
    parsedValues.get('rate_code') == null ? 'rate_code' : null,
    parsedValues.get('transaction_quantity') == null ? 'transaction_quantity' : null,
    parsedValues.get('extended_cost') == null ? 'extended_cost' : null,
  ].filter((field): field is string => Boolean(field));

  const populatedFieldCount = [...parsedValues.values()].filter((value) => value != null).length;
  const confidence = Number((
    0.42
    + Math.min(0.32, populatedFieldCount * 0.03)
    + Math.min(0.18, analysis.detectedSheetConfidence * 0.2)
    - (missingFields.length * 0.03)
  ).toFixed(3));

  const invoiceNumber = (parsedValues.get('invoice_number') as string | null) ?? null;
  const rateCode = (parsedValues.get('rate_code') as string | null) ?? null;
  const rateDescription = (parsedValues.get('rate_description') as string | null) ?? null;
  const material = (parsedValues.get('material') as string | null) ?? null;
  const serviceItem = (parsedValues.get('service_item') as string | null) ?? null;
  const materialResolved =
    material ?? findRawRowText(row.values, TRANSACTION_DATA_HEADER_ALIASES.material);

  const {
    billing_rate_key,
    description_match_key,
    site_material_key,
    invoice_rate_key,
  } = deriveBillingKeysForTransactionRecord({
    invoice_number: invoiceNumber,
    rate_code: rateCode,
    rate_description: rateDescription,
    service_item: serviceItem,
    material: materialResolved,
    disposal_site: findRawRowText(row.values, RAW_DISPOSAL_SITE_HEADER_ALIASES),
    site_type: findRawRowText(row.values, RAW_SITE_TYPE_HEADER_ALIASES),
  });

  return {
    id: `transaction:${analysis.sheet.key}:${row.row_number}`,
    transaction_number: (parsedValues.get('transaction_number') as string | null) ?? null,
    invoice_number: invoiceNumber,
    invoice_date: (parsedValues.get('invoice_date') as string | null) ?? null,
    rate_code: rateCode,
    rate_description: rateDescription,
    transaction_quantity: (parsedValues.get('transaction_quantity') as number | null) ?? null,
    transaction_rate: (parsedValues.get('transaction_rate') as number | null) ?? null,
    extended_cost: (parsedValues.get('extended_cost') as number | null) ?? null,
    net_quantity: (parsedValues.get('net_quantity') as number | null) ?? null,
    mileage: (parsedValues.get('mileage') as number | null) ?? null,
    cyd: (parsedValues.get('cyd') as number | null) ?? null,
    net_tonnage: (parsedValues.get('net_tonnage') as number | null) ?? null,
    material,
    service_item: serviceItem,
    ticket_notes: (parsedValues.get('ticket_notes') as string | null) ?? null,
    eligibility: (parsedValues.get('eligibility') as string | null) ?? null,
    eligibility_internal_comments: (parsedValues.get('eligibility_internal_comments') as string | null) ?? null,
    eligibility_external_comments: (parsedValues.get('eligibility_external_comments') as string | null) ?? null,
    load_latitude: (parsedValues.get('load_latitude') as number | null) ?? null,
    load_longitude: (parsedValues.get('load_longitude') as number | null) ?? null,
    disposal_latitude: (parsedValues.get('disposal_latitude') as number | null) ?? null,
    disposal_longitude: (parsedValues.get('disposal_longitude') as number | null) ?? null,
    project_name: (parsedValues.get('project_name') as string | null) ?? null,
    billing_rate_key,
    description_match_key,
    site_material_key,
    invoice_rate_key,
    source_sheet_name: analysis.sheet.name,
    source_row_number: row.row_number,
    raw_row: { ...row.values },
    evidence_ref: `sheet:${analysis.sheet.key}:row:${row.row_number}`,
    column_headers: columnHeaders,
    field_evidence_ids: fieldEvidenceIds,
    missing_fields: missingFields,
    confidence,
  };
}

export function normalizeTransactionData(params: {
  workbook: WorkbookParseResult;
  detectedSheets: DetectSheetsResult;
}): TransactionDataNormalizationResult {
  const analyses = params.workbook.sheets.map((sheet) => analyzeSheet(sheet, params.detectedSheets));
  const preferredSheets = analyses.filter((analysis) =>
    analysis.matchedFieldCount >= 3 ||
    (
      analysis.matchedFieldCount >= 2 &&
      analysis.amountColumns.length > 0 &&
      (analysis.metricColumns.length > 0 || analysis.codeColumns.length > 0)
    ),
  );
  const processedAnalyses = preferredSheets.length > 0
    ? preferredSheets
    : analyses.filter((analysis) => analysis.matchedFieldCount > 0);

  const gaps: ExtractionGap[] = [];
  if (processedAnalyses.length === 0) {
    gaps.push(buildGap({
      category: 'transaction_data_headers_unresolved',
      severity: 'warning',
      message: 'Workbook did not contain enough recognizable transaction-data headers to parse rows confidently.',
    }));
  }

  const headerMap: Partial<Record<TransactionDataFieldKey, TransactionDataHeaderMatch[]>> = {};
  const records: NormalizedTransactionDataRecord[] = [];

  for (const analysis of processedAnalyses) {
    for (const [field, match] of Object.entries(analysis.headerMatches) as Array<[TransactionDataFieldKey, TransactionDataHeaderMatch]>) {
      const existing = headerMap[field] ?? [];
      existing.push(match);
      headerMap[field] = existing;
    }

    for (const row of analysis.sheet.rows) {
      records.push(buildRecord(analysis, row));
    }
  }

  if (processedAnalyses.length > 0 && records.length === 0) {
    gaps.push(buildGap({
      category: 'transaction_data_rows_missing',
      severity: 'warning',
      message: 'Matched transaction-data sheets were found, but no populated data rows were available to normalize.',
    }));
  }

  const projectNames = records
    .map((record) => record.project_name)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const invoiceNumbers = uniqueStrings(records.map((record) => record.invoice_number));
  const invoiceDates = uniqueStrings(records.map((record) => record.invoice_date)).sort();
  const workbookSheetNames = params.workbook.sheets.map((sheet) => sheet.name);
  const groupedByRateCode = buildRateCodeGroups(records);
  const groupedByInvoice = buildInvoiceGroups(records);
  const groupedBySiteMaterial = buildSiteMaterialGroups(records);
  const groupedByServiceItem = buildServiceItemGroups(records);
  const groupedByMaterial = buildMaterialGroups(records);
  const groupedBySiteType = buildSiteTypeGroups(records);
  const groupedByDisposalSite = buildDisposalSiteGroups(records);
  const extremeRateSignals = findExtremeUnitRateSignals(records);
  const rowsWithExtremeUnitRate = extremeRateSignals.size;

  const totalExtendedCost = roundNumber(
    records.reduce((sum, record) => sum + (record.extended_cost ?? 0), 0),
    2,
  );
  const totalTransactionQuantity = roundNumber(
    records.reduce((sum, record) => sum + (record.transaction_quantity ?? 0), 0),
    3,
  );
  const totalCyd = roundNumber(
    records.reduce((sum, record) => sum + (record.cyd ?? 0), 0),
    3,
  );
  const totalInvoicedAmount = roundNumber(
    records.reduce((sum, record) => sum + (hasInvoiceLink(record) ? (record.extended_cost ?? 0) : 0), 0),
    2,
  );
  const invoicedTicketCount = records.filter((record) => hasInvoiceLink(record)).length;
  const distinctInvoiceCount = new Set(
    records
      .map((record) => normalizeInvoiceNumber(record.invoice_number))
      .filter((value): value is string => value != null),
  ).size;
  const distinctServiceItems = uniqueStrings(records.map((record) => record.service_item));
  const distinctMaterials = uniqueStrings(records.map((record) => effectiveMaterial(record)));
  const eligibilityCounts = records.reduce((accumulator, record) => {
    const status = normalizeEligibility(record.eligibility);
    if (status === 'eligible') accumulator.eligible += 1;
    else if (status === 'ineligible') accumulator.ineligible += 1;
    else accumulator.unknown += 1;
    return accumulator;
  }, { eligible: 0, ineligible: 0, unknown: 0 });

  const boundaryLocationReview = buildBoundaryLocationReview(records);
  const distanceFromFeatureReview = buildDistanceFromFeatureReview(records);
  const debrisClassAtDisposalSiteReview = buildDebrisClassAtDisposalSiteReview(records);
  const mileageReview = buildMileageReview(records);
  const loadCallReview = buildLoadCallReview(records);
  const linkedMobileLoadConsistencyReview = buildLinkedMobileLoadConsistencyReview(records);
  const truckTripTimeReview = buildTruckTripTimeReview(records);
  const reviewBuckets = [
    boundaryLocationReview,
    distanceFromFeatureReview,
    debrisClassAtDisposalSiteReview,
    mileageReview,
    loadCallReview,
    linkedMobileLoadConsistencyReview,
    truckTripTimeReview,
  ] as const;
  const outlierRows = buildOutlierRows({
    records,
    extremeRateSignals,
    reviewBuckets,
  });

  const rollups: TransactionDataRollups = {
    total_extended_cost: totalExtendedCost,
    total_transaction_quantity: totalTransactionQuantity,
    total_tickets: records.length,
    total_cyd: totalCyd,
    invoiced_ticket_count: invoicedTicketCount,
    distinct_invoice_count: distinctInvoiceCount,
    total_invoiced_amount: totalInvoicedAmount,
    uninvoiced_line_count: records.filter((record) => !hasInvoiceLink(record)).length,
    eligible_count: eligibilityCounts.eligible,
    ineligible_count: eligibilityCounts.ineligible,
    unknown_eligibility_count: eligibilityCounts.unknown,
    distinct_rate_codes: uniqueStrings(records.map((record) => record.rate_code)),
    distinct_invoice_numbers: invoiceNumbers,
    distinct_service_items: distinctServiceItems,
    distinct_materials: distinctMaterials,
    rows_with_missing_rate_code: records.filter((record) => record.rate_code == null).length,
    rows_with_missing_invoice_number: records.filter((record) => record.invoice_number == null).length,
    rows_with_missing_quantity: records.filter((record) => record.transaction_quantity == null).length,
    rows_with_missing_extended_cost: records.filter((record) => record.extended_cost == null).length,
    rows_with_zero_cost: records.filter((record) => record.extended_cost === 0).length,
    rows_with_extreme_unit_rate: rowsWithExtremeUnitRate,
    grouped_by_rate_code: groupedByRateCode,
    grouped_by_invoice: groupedByInvoice,
    grouped_by_site_material: groupedBySiteMaterial,
    grouped_by_service_item: groupedByServiceItem,
    grouped_by_material: groupedByMaterial,
    grouped_by_site_type: groupedBySiteType,
    grouped_by_disposal_site: groupedByDisposalSite,
    outlier_rows: outlierRows,
  };

  const projectOperationsOverview = buildProjectOperationsOverview({
    records,
    inferredProjectName: mostFrequent(projectNames),
    sheetNames: workbookSheetNames,
    distinctServiceItems,
    distinctMaterials,
    groupedBySiteType,
    groupedByDisposalSite,
    totalTransactionQuantity,
    totalCyd,
    totalInvoicedAmount,
    distinctInvoiceCount,
    invoicedTicketCount,
    uninvoicedLineCount: rollups.uninvoiced_line_count,
    eligibleCount: rollups.eligible_count,
    ineligibleCount: rollups.ineligible_count,
    unknownEligibilityCount: rollups.unknown_eligibility_count,
  });
  const invoiceReadinessSummary = buildInvoiceReadinessSummary({
    records,
    rollups,
  });
  const dmsFdsLifecycleSummary = buildLifecycleSummary(records);

  const summary: TransactionDataDatasetSummary = {
    row_count: records.length,
    distinct_invoice_numbers: rollups.distinct_invoice_numbers,
    distinct_rate_codes: rollups.distinct_rate_codes,
    distinct_service_items: rollups.distinct_service_items,
    distinct_materials: rollups.distinct_materials,
    total_extended_cost: rollups.total_extended_cost,
    total_transaction_quantity: rollups.total_transaction_quantity,
    total_tickets: rollups.total_tickets,
    total_cyd: rollups.total_cyd,
    invoiced_ticket_count: rollups.invoiced_ticket_count,
    distinct_invoice_count: rollups.distinct_invoice_count,
    total_invoiced_amount: rollups.total_invoiced_amount,
    uninvoiced_line_count: rollups.uninvoiced_line_count,
    eligible_count: rollups.eligible_count,
    ineligible_count: rollups.ineligible_count,
    unknown_eligibility_count: rollups.unknown_eligibility_count,
    rows_with_missing_rate_code: rollups.rows_with_missing_rate_code,
    rows_with_missing_invoice_number: rollups.rows_with_missing_invoice_number,
    rows_with_missing_quantity: rollups.rows_with_missing_quantity,
    rows_with_missing_extended_cost: rollups.rows_with_missing_extended_cost,
    rows_with_zero_cost: rollups.rows_with_zero_cost,
    rows_with_extreme_unit_rate: rollups.rows_with_extreme_unit_rate,
    project_operations_overview: projectOperationsOverview,
    invoice_readiness_summary: invoiceReadinessSummary,
    grouped_by_rate_code: rollups.grouped_by_rate_code,
    grouped_by_invoice: rollups.grouped_by_invoice,
    grouped_by_site_material: rollups.grouped_by_site_material,
    grouped_by_service_item: rollups.grouped_by_service_item,
    grouped_by_material: rollups.grouped_by_material,
    grouped_by_site_type: rollups.grouped_by_site_type,
    grouped_by_disposal_site: rollups.grouped_by_disposal_site,
    outlier_rows: rollups.outlier_rows,
    dms_fds_lifecycle_summary: dmsFdsLifecycleSummary,
    boundary_location_review: boundaryLocationReview,
    distance_from_feature_review: distanceFromFeatureReview,
    debris_class_at_disposal_site_review: debrisClassAtDisposalSiteReview,
    mileage_review: mileageReview,
    load_call_review: loadCallReview,
    linked_mobile_load_consistency_review: linkedMobileLoadConsistencyReview,
    truck_trip_time_review: truckTripTimeReview,
    detected_header_map: headerMap,
    detected_sheet_names: workbookSheetNames,
    inferred_date_range_start: invoiceDates[0] ?? null,
    inferred_date_range_end: invoiceDates[invoiceDates.length - 1] ?? null,
  };

  const rowConfidenceValues = records.map((record) => record.confidence).filter((value) => value > 0);
  const confidence = rowConfidenceValues.length > 0
    ? Number((rowConfidenceValues.reduce((sum, value) => sum + value, 0) / rowConfidenceValues.length).toFixed(3))
    : 0.48;

  return {
    source_type: 'transaction_data',
    row_count: records.length,
    sheet_names: params.workbook.sheets.map((sheet) => sheet.name),
    processed_sheet_names: processedAnalyses.map((analysis) => analysis.sheet.name),
    header_map: headerMap,
    inferred_project_name: mostFrequent(projectNames),
    inferred_invoice_numbers: invoiceNumbers,
    inferred_date_range:
      invoiceDates.length > 0
        ? { start: invoiceDates[0], end: invoiceDates[invoiceDates.length - 1] }
        : null,
    detected_metric_columns: uniqueStrings(processedAnalyses.flatMap((analysis) => analysis.metricColumns)),
    detected_code_columns: uniqueStrings(processedAnalyses.flatMap((analysis) => analysis.codeColumns)),
    detected_amount_columns: uniqueStrings(processedAnalyses.flatMap((analysis) => analysis.amountColumns)),
    records,
    summary,
    rollups,
    confidence,
    gaps,
  };
}
