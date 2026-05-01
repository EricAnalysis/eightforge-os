import type { ContractRateScheduleRow } from './types';
import { resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';

type ContractRateScheduleSourceEntry = {
  id?: string | null;
  page?: number | null;
  text: string;
};

type BuildContractRateScheduleRowsInput = {
  rateTable: unknown;
  rateSchedulePages?: readonly number[] | null;
  sourceEntries?: readonly ContractRateScheduleSourceEntry[] | null;
  defaultAnchorIds?: readonly string[] | null;
};

const INLINE_RATE_RE = /^(.*?)\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:per|\/)\s*(ton|tons|cubic\s+yard|cy|hour|hr|hrs|mile|each|ea|load|day|yd|yard|linear\s+foot|lf|sq\s*ft|square\s+foot|pound|lb|lbs|unit|tree|stump)\b/i;
const UNIT_TOKEN_RE = /\b(ton|tons|cubic\s+yard|cy|hour|hours|hr|hrs|mile|miles|each|ea|load|loads|day|days|yd|yard|linear\s+foot|lf|sq\s*ft|square\s+foot|pound|lb|lbs|unit|tree|stump)\b/i;
const RATE_HEADER_RE = /\b(category|description|service|classification|item|unit|rate|price|scheduled value|qty|quantity|clin)\b/i;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeLower(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || Array.isArray(value) || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const normalized = normalizeWhitespace(value);
      if (normalized) return normalized;
    }
  }
  return null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/-?[\d,]+(?:\.\d{1,2})?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function readNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const parsed = parseNumber(record[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

function normalizeUnit(value: string | null): string | null {
  if (!value) return null;
  return normalizeWhitespace(value).toLowerCase();
}

function splitLineColumns(line: string): string[] {
  const normalized = line.trim();
  if (!normalized) return [];

  const pipeColumns = normalized.split('|').map((value) => value.trim()).filter(Boolean);
  if (pipeColumns.length >= 2) return pipeColumns;

  const tabColumns = normalized.split(/\t+/).map((value) => value.trim()).filter(Boolean);
  if (tabColumns.length >= 3) return tabColumns;

  const spacedColumns = normalized.split(/\s{2,}/).map((value) => value.trim()).filter(Boolean);
  if (spacedColumns.length >= 3) return spacedColumns;

  return [normalized];
}

function lineContainsMoneyValue(line: string): boolean {
  return /\$\s*[\d,]+(?:\.\d{1,2})?/.test(line) || /\b\d+\.\d{2}\b/.test(line);
}

function lineLooksLikeHeader(line: string): boolean {
  return RATE_HEADER_RE.test(line) && !lineContainsMoneyValue(line);
}

function unitFromText(value: string): string | null {
  const match = value.match(UNIT_TOKEN_RE);
  return normalizeUnit(match?.[1] ?? null);
}

function rateKey(row: Pick<ContractRateScheduleRow, 'description' | 'category' | 'unit' | 'rate' | 'page'>): string {
  return [
    safeLower(row.description ?? ''),
    safeLower(row.category ?? ''),
    safeLower(row.unit ?? ''),
    row.rate != null ? String(row.rate) : '',
    row.page != null ? String(row.page) : '',
  ].join('|');
}

function findMatchingSourceContext(params: {
  candidates: readonly string[];
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  rateSchedulePages: readonly number[];
  defaultAnchorIds: readonly string[];
}): {
  page: number | null;
  sourceAnchorIds: string[];
} {
  const preferredPages = new Set(params.rateSchedulePages);
  const orderedEntries = params.sourceEntries
    .filter((entry) => normalizeWhitespace(entry.text).length > 0)
    .sort((left, right) => {
      const leftPreferred = left.page != null && preferredPages.has(left.page) ? 0 : 1;
      const rightPreferred = right.page != null && preferredPages.has(right.page) ? 0 : 1;
      return leftPreferred - rightPreferred;
    });

  const loweredCandidates = params.candidates
    .map((candidate) => safeLower(candidate))
    .filter((candidate) => candidate.length >= 4);

  for (const candidate of loweredCandidates) {
    const matches = orderedEntries.filter((entry) => safeLower(entry.text).includes(candidate));
    if (matches.length > 0) {
      return {
        page: matches[0]?.page ?? null,
        sourceAnchorIds: matches
          .map((entry) => entry.id ?? null)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .slice(0, 3),
      };
    }
  }

  if (params.rateSchedulePages.length === 1) {
    const page = params.rateSchedulePages[0] ?? null;
    const pageEntries = orderedEntries.filter((entry) => entry.page === page);
    return {
      page,
      sourceAnchorIds:
        pageEntries
          .map((entry) => entry.id ?? null)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .slice(0, 1)
          .concat(params.defaultAnchorIds.slice(0, 1)),
    };
  }

  return {
    page: null,
    sourceAnchorIds: [...params.defaultAnchorIds.slice(0, 1)],
  };
}

function buildStructuredRow(params: {
  rowId: string;
  description: string | null;
  category: string | null;
  canonicalCategory?: string | null;
  categoryConfidence?: number | null;
  unit: string | null;
  rate: number | null;
  rateRaw: string | null;
  page: number | null;
  sourceAnchorIds: readonly string[];
}): ContractRateScheduleRow | null {
  const description = params.description ? normalizeWhitespace(params.description) : null;
  const category = params.category ? normalizeWhitespace(params.category) : null;
  const unit = normalizeUnit(params.unit);
  const rateRaw = params.rateRaw ? normalizeWhitespace(params.rateRaw) : null;
  const resolvedCategory = resolveCanonicalRateCategory({
    sourceCategory: category,
    sourceDescriptors: [description, rateRaw],
    existingCanonicalCategory: params.canonicalCategory,
    existingConfidence: params.categoryConfidence,
  });
  const canonicalCategory = resolvedCategory.canonical_category;
  const categoryConfidence = resolvedCategory.category_confidence;

  if (description == null && category == null && unit == null && params.rate == null && rateRaw == null) {
    return null;
  }

  return {
    row_id: params.rowId,
    description,
    unit,
    rate: params.rate,
    category,
    source_category: category,
    canonical_category: canonicalCategory ? canonicalCategory.replace(/\s+/g, '_').toLowerCase() : null,
    category_confidence: categoryConfidence,
    page: params.page,
    source_anchor_ids: [...params.sourceAnchorIds],
    rate_raw: rateRaw,
    material_type: category,
    unit_type: unit,
    rate_amount: params.rate,
  };
}

function normalizeTypedRateTableRows(params: {
  rateTable: unknown;
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  rateSchedulePages: readonly number[];
  defaultAnchorIds: readonly string[];
}): ContractRateScheduleRow[] {
  if (!Array.isArray(params.rateTable)) return [];

  const rows: ContractRateScheduleRow[] = [];
  for (const [index, entry] of params.rateTable.entries()) {
    const record = asRecord(entry);
    const description = record
      ? readString(record, ['description', 'service_item', 'name', 'item'])
      : null;
    const category = record
      ? readString(record, ['category', 'material_type', 'material', 'debris_type'])
      : null;
    const unit = record
      ? readString(record, ['unit', 'unit_type', 'uom'])
      : typeof entry === 'string'
        ? unitFromText(entry)
        : null;
    const rate = record
      ? readNumber(record, ['rate_amount', 'rate', 'amount', 'price', 'unit_rate', 'rate_raw'])
      : parseNumber(entry);
    const page = record
      ? readNumber(record, ['page', 'page_number', 'source_page'])
      : null;
    const rateRaw = record
      ? readString(record, ['rate_raw', 'raw_text'])
      : typeof entry === 'string'
        ? normalizeWhitespace(entry)
        : null;
    const categoryResolution = resolveCanonicalRateCategory({
      sourceCategory: category,
      sourceDescriptors: [description, rateRaw],
      existingCanonicalCategory: record
        ? readString(record, ['canonical_category'])
        : null,
      existingConfidence: record
        ? readNumber(record, ['category_confidence'])
        : null,
    });
    const matchedSource = findMatchingSourceContext({
      candidates: [rateRaw, description, category, unit].filter(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
      ),
      sourceEntries: params.sourceEntries,
      rateSchedulePages: params.rateSchedulePages,
      defaultAnchorIds: params.defaultAnchorIds,
    });

    const row = buildStructuredRow({
      rowId: `rate_row:${index + 1}`,
      description,
      category,
      canonicalCategory: categoryResolution.canonical_category,
      categoryConfidence: categoryResolution.category_confidence,
      unit,
      rate,
      rateRaw,
      page: page ?? matchedSource.page,
      sourceAnchorIds: matchedSource.sourceAnchorIds,
    });
    if (row) rows.push(row);
  }

  return rows;
}

function parseRateRowFromColumns(params: {
  line: string;
  page: number | null;
  sourceAnchorId?: string | null;
  rowIndex: number;
}): ContractRateScheduleRow | null {
  const columns = splitLineColumns(params.line);
  if (columns.length < 2) return null;
  if (lineLooksLikeHeader(params.line)) return null;

  let rateIndex = -1;
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    if (lineContainsMoneyValue(columns[index] ?? '')) {
      rateIndex = index;
      break;
    }
  }
  if (rateIndex < 0) return null;

  const unitIndex = columns.findIndex((value, index) => index !== rateIndex && unitFromText(value) != null);
  const rate = parseNumber(columns[rateIndex]);
  const unit = unitIndex >= 0 ? unitFromText(columns[unitIndex]) : unitFromText(params.line);
  const textColumns = columns.filter((_, index) => index !== rateIndex && index !== unitIndex);
  const category = textColumns.length > 1 ? textColumns[0] ?? null : null;
  const description =
    textColumns.length > 1
      ? textColumns.slice(1).join(' | ')
      : textColumns[0] ?? null;

  return buildStructuredRow({
    rowId: `rate_row:fallback:${params.rowIndex}`,
    description,
    category,
    unit,
    rate,
    rateRaw: params.line,
    page: params.page,
    sourceAnchorIds:
      params.sourceAnchorId && params.sourceAnchorId.trim().length > 0
        ? [params.sourceAnchorId]
        : [],
  });
}

function parseRateRowInline(params: {
  line: string;
  page: number | null;
  sourceAnchorId?: string | null;
  rowIndex: number;
}): ContractRateScheduleRow | null {
  if (lineLooksLikeHeader(params.line)) return null;
  const match = params.line.match(INLINE_RATE_RE);
  if (!match) return null;

  const description = normalizeWhitespace(match[1] ?? '') || null;
  const rate = parseNumber(match[2] ?? null);
  const unit = normalizeUnit(match[3] ?? null);

  return buildStructuredRow({
    rowId: `rate_row:fallback:${params.rowIndex}`,
    description,
    category: null,
    unit,
    rate,
    rateRaw: params.line,
    page: params.page,
    sourceAnchorIds:
      params.sourceAnchorId && params.sourceAnchorId.trim().length > 0
        ? [params.sourceAnchorId]
        : [],
  });
}

function buildFallbackRowsFromSourceEntries(params: {
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  rateSchedulePages: readonly number[];
}): ContractRateScheduleRow[] {
  const rows: ContractRateScheduleRow[] = [];
  const ratePages = new Set(params.rateSchedulePages);
  const candidateEntries = params.sourceEntries.filter((entry) => {
    if (normalizeWhitespace(entry.text).length === 0) return false;
    return ratePages.size === 0 || (entry.page != null && ratePages.has(entry.page));
  });

  let rowIndex = 0;
  for (const entry of candidateEntries) {
    const lines = entry.text
      .split('\n')
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
    for (const line of lines) {
      rowIndex += 1;
      const row =
        parseRateRowFromColumns({
          line,
          page: entry.page ?? null,
          sourceAnchorId: entry.id ?? null,
          rowIndex,
        })
        ?? parseRateRowInline({
          line,
          page: entry.page ?? null,
          sourceAnchorId: entry.id ?? null,
          rowIndex,
        });
      if (row) rows.push(row);
    }
  }

  const deduped = new Map<string, ContractRateScheduleRow>();
  for (const row of rows) {
    const key = rateKey(row);
    if (!deduped.has(key)) {
      deduped.set(key, row);
    }
  }

  return [...deduped.values()];
}

export function buildContractRateScheduleRows(
  params: BuildContractRateScheduleRowsInput,
): ContractRateScheduleRow[] {
  const rateSchedulePages = [...(params.rateSchedulePages ?? [])]
    .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : null))
    .filter((value): value is number => value != null);
  const sourceEntries = [...(params.sourceEntries ?? [])];
  const defaultAnchorIds = [...(params.defaultAnchorIds ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  const structuredRows = normalizeTypedRateTableRows({
    rateTable: params.rateTable,
    sourceEntries,
    rateSchedulePages,
    defaultAnchorIds,
  });
  if (structuredRows.length > 0) {
    return structuredRows;
  }

  return buildFallbackRowsFromSourceEntries({
    sourceEntries,
    rateSchedulePages,
  });
}
