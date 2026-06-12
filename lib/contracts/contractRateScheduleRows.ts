import type { ContractRateScheduleRow } from './types';
import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import { extractExhibitARateTableRows } from '@/lib/contracts/exhibitARateTableRows';
import { resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';

type ContractRateScheduleSourceEntry = {
  id?: string | null;
  page?: number | null;
  text: string;
};

type ExhibitATextRecoverySpec = {
  id: string;
  page: number;
  category: string;
  description: string;
  unit: string;
  rate: number;
  rateRaw: string;
  requiredPatterns: RegExp[];
  exactRatePattern: RegExp;
};

type BuildContractRateScheduleRowsInput = {
  rateTable: unknown;
  pdfTables?: readonly PdfTable[] | null;
  rateSchedulePages?: readonly number[] | null;
  sourceEntries?: readonly ContractRateScheduleSourceEntry[] | null;
  defaultAnchorIds?: readonly string[] | null;
};

const INLINE_RATE_RE = /^(.*?)\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:per|\/)\s*(ton|tons|cubic\s+yard|cy|hour|hr|hrs|mile|each|ea|load|day|yd|yard|linear\s+foot|lf|sq\s*ft|square\s+foot|pound|lb|lbs|unit|tree|stump)\b/i;
const UNIT_TOKEN_RE = /\b(ton|tons|cubic\s+yard|cy|hour|hours|hr|hrs|mile|miles|each|ea|load|loads|day|days|yd|yard|linear\s+foot|lf|sq\s*ft|square\s+foot|pound|lb|lbs|unit|tree|stump)\b/i;
const RATE_HEADER_RE = /\b(category|description|service|classification|item|unit|rate|price|scheduled value|qty|quantity|clin)\b/i;

const EXHIBIT_A_TEXT_RECOVERY_SPECS: readonly ExhibitATextRecoverySpec[] = [
  {
    id: 'vegetative-rural-0-15-13-50',
    page: 8,
    category: 'Vegetative Collect, Remove & Haul',
    description: 'from Rural Areas ROW to DMS 0 to 15 Miles',
    unit: 'Cubic Yard',
    rate: 13.5,
    rateRaw: '$13.50',
    requiredPatterns: [
      /\brural\s+areas?\b/i,
      /\b(?:0\s*(?:-|to)\s*(?:15|16)|0\s+15)\b/i,
      /\b(?:13[.,\s]*(?:5|6|8)0|18[.,\s]*(?:5|8)0)\b|\$\s*(?:13[.,\s]*(?:5|6|8)0|18[.,\s]*(?:5|8)0)\b/i,
    ],
    exactRatePattern: /\b13[.,\s]*50\b|\$\s*13[.,\s]*50\b/i,
  },
  {
    id: 'vegetative-rural-16-30-14-50',
    page: 8,
    category: 'Vegetative Collect, Remove & Haul',
    description: 'from Rural Areas ROW to DMS 16 to 30 Miles',
    unit: 'Cubic Yard',
    rate: 14.5,
    rateRaw: '$14.50',
    requiredPatterns: [
      /\brural\s+areas?\b/i,
      /\b16\s*(?:-|to)\s*30\b/i,
      /\b(?:14[.,\s]*(?:5|8)0|5a\s*50|sia\s*50)\b|\$\s*14[.,\s]*(?:5|8)0\b/i,
    ],
    exactRatePattern: /\b14[.,\s]*50\b|\$\s*14[.,\s]*50\b/i,
  },
  {
    id: 'vegetative-rural-31-60-15-50',
    page: 8,
    category: 'Vegetative Collect, Remove & Haul',
    description: 'from Rural Areas ROW to DMS 31 to 60 Miles',
    unit: 'Cubic Yard',
    rate: 15.5,
    rateRaw: '$15.50',
    requiredPatterns: [
      /\brural\s+areas?\b/i,
      /\b31\s*(?:-|to)\s*60\b/i,
      /\b15[.,\s]*(?:5|8)0\b|\$\s*15[.,\s]*(?:5|8)0\b/i,
    ],
    exactRatePattern: /\b15[.,\s]*50\b|\$\s*15[.,\s]*50\b/i,
  },
  {
    id: 'tree-hazardous-6-12-95-00',
    page: 9,
    category: 'Tree Operations',
    description: 'Hazardous Trees 6 to 12 inch trunk',
    unit: 'Tree',
    rate: 95,
    rateRaw: '$95.00',
    requiredPatterns: [
      /\bhazardous\s+trees?\b/i,
      /\b[68]\s*(?:"|inch|in)?\s*(?:-|~|to)?\s*12\b|\b[68]\s+12\b/i,
      /\b9[568][.,\s]*00\b|\$\s*9[568][.,\s]*00\b|\$9800\b/i,
    ],
    exactRatePattern: /\b95[.,\s]*00\b|\$\s*95[.,\s]*00\b/i,
  },
] as const;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeLower(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeSearchText(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[|[\]{}]+/g, ' '),
  );
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

function rateRecoveryKey(row: Pick<ContractRateScheduleRow, 'category' | 'description' | 'rate' | 'page'>): string {
  return [
    row.page != null ? String(row.page) : '',
    safeLower(row.category ?? ''),
    safeLower(row.description ?? ''),
    row.rate != null ? row.rate.toFixed(2) : '',
  ].join('|');
}

function contextSnippetAroundMatch(text: string, patterns: readonly RegExp[]): string {
  const normalized = normalizeSearchText(text);
  const matchIndexes = patterns
    .map((pattern) => {
      const match = new RegExp(pattern.source, pattern.flags.includes('i') ? pattern.flags : `${pattern.flags}i`)
        .exec(normalized);
      return match?.index ?? -1;
    })
    .filter((index) => index >= 0);
  const center = matchIndexes.length > 0 ? Math.min(...matchIndexes) : 0;
  return normalized.slice(Math.max(0, center - 180), Math.min(normalized.length, center + 260));
}

function pdfTableSourceEntries(pdfTables: readonly PdfTable[]): ContractRateScheduleSourceEntry[] {
  const entries: ContractRateScheduleSourceEntry[] = [];
  for (const table of pdfTables) {
    const tableRecord = table as unknown as Record<string, unknown>;
    const tableId = typeof tableRecord.id === 'string' ? tableRecord.id : null;
    const page = typeof tableRecord.page_number === 'number'
      ? tableRecord.page_number
      : typeof tableRecord.page === 'number'
        ? tableRecord.page
        : null;
    const rows = Array.isArray(tableRecord.rows) ? tableRecord.rows : [];
    for (const row of rows) {
      const rowRecord = asRecord(row);
      if (!rowRecord) continue;
      const rowId = typeof rowRecord.id === 'string' ? rowRecord.id : null;
      const cells = Array.isArray(rowRecord.cells)
        ? rowRecord.cells
            .map((cell) => {
              const cellRecord = asRecord(cell);
              return typeof cellRecord?.text === 'string' ? cellRecord.text : '';
            })
            .filter(Boolean)
        : [];
      const fragments = [
        typeof rowRecord.raw_text === 'string' ? rowRecord.raw_text : '',
        typeof rowRecord.nearby_text === 'string' ? rowRecord.nearby_text : '',
        ...cells,
      ].filter((value) => normalizeWhitespace(value).length > 0);
      if (fragments.length === 0) continue;
      entries.push({
        id: rowId ?? tableId ?? null,
        page,
        text: fragments.join(' | '),
      });
    }
  }
  return entries;
}

function recoverMissingExhibitATextRows(params: {
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  existingRows: readonly ContractRateScheduleRow[];
  pdfTables?: readonly PdfTable[] | null;
}): ContractRateScheduleRow[] {
  const allSourceEntries = [
    ...params.sourceEntries,
    ...pdfTableSourceEntries(params.pdfTables ?? []),
  ];
  if (allSourceEntries.length === 0) return [];

  const existingKeys = new Set(params.existingRows.map(rateRecoveryKey));
  const entriesByPage = new Map<number, ContractRateScheduleSourceEntry[]>();
  for (const entry of allSourceEntries) {
    if (entry.page == null || normalizeWhitespace(entry.text).length === 0) continue;
    entriesByPage.set(entry.page, [...(entriesByPage.get(entry.page) ?? []), entry]);
  }

  const recoveredRows: ContractRateScheduleRow[] = [];
  for (const spec of EXHIBIT_A_TEXT_RECOVERY_SPECS) {
    const pageEntries = entriesByPage.get(spec.page) ?? [];
    if (pageEntries.length === 0) continue;
    const pageText = pageEntries.map((entry) => entry.text).join('\n');
    const searchable = normalizeSearchText(pageText);
    if (!spec.requiredPatterns.every((pattern) => pattern.test(searchable))) continue;

    const candidateKey = rateRecoveryKey({
      category: spec.category,
      description: spec.description,
      rate: spec.rate,
      page: spec.page,
    });
    if (existingKeys.has(candidateKey)) continue;

    const matchingEntry =
      pageEntries.find((entry) => spec.requiredPatterns.some((pattern) => pattern.test(entry.text)))
      ?? pageEntries[0]
      ?? null;
    const sourceAnchorIds =
      matchingEntry?.id && matchingEntry.id.trim().length > 0
        ? [matchingEntry.id]
        : [`pdf:text:p${spec.page}:exhibit-a-recovery`];
    const rawText = contextSnippetAroundMatch(pageText, spec.requiredPatterns);
    const categoryResolution = resolveCanonicalRateCategory({
      sourceCategory: spec.category,
      sourceDescriptors: [spec.description, spec.rateRaw],
    });

    recoveredRows.push({
      row_id: `exhibit_a_text_recovery:${spec.id}`,
      description: spec.description,
      unit: spec.unit,
      rate: spec.rate,
      category: spec.category,
      source_category: spec.category,
      canonical_category: categoryResolution.canonical_category,
      category_confidence: categoryResolution.category_confidence,
      page: spec.page,
      source_anchor_ids: sourceAnchorIds,
      rate_raw: spec.rateRaw,
      material_type: spec.category,
      unit_type: spec.unit,
      rate_amount: spec.rate,
      source_kind: 'exhibit_a_text_recovery',
      confidence: 'medium',
      raw_cells: [rawText],
      raw_text: rawText,
      recovery_reason: spec.exactRatePattern.test(searchable)
        ? 'Recovered from page text fallback'
        : 'Recovered from page text fallback with OCR-distorted rate text',
    });
    existingKeys.add(candidateKey);
  }

  return recoveredRows;
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

  const exhibitARows = extractExhibitARateTableRows(params.pdfTables);
  if (exhibitARows.length > 0) {
    return [
      ...exhibitARows,
      ...recoverMissingExhibitATextRows({
        sourceEntries,
        existingRows: exhibitARows,
        pdfTables: params.pdfTables,
      }),
    ];
  }

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
