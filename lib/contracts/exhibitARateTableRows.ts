import type { PdfTable, PdfTableCell } from '@/lib/extraction/pdf/extractTables';
import type { ContractRateScheduleRow } from '@/lib/contracts/types';

type ExhibitAConfidence = NonNullable<ContractRateScheduleRow['confidence']>;

type ParsedExhibitRow = {
  category: string | null;
  description: string | null;
  unit: string | null;
  rate: number | null;
  rateRaw: string | null;
  confidence: ExhibitAConfidence;
};

type RowVariant = {
  idSuffix: string;
  cells: Array<{ text: string; column_index: number }>;
  rawText: string;
};

type ContextHint = {
  area: string | null;
};

const EXHIBIT_A_PAGES = new Set([8, 9, 10, 11]);
const MIN_CLEAN_STRUCTURAL_TABLE_CONFIDENCE = 0.55;

const CATEGORY_ALIASES: Array<[RegExp, string]> = [
  [/\bveg[ae]tative\b.*\bcollect\b.*\bremove\b.*\bha?ul\b/i, 'Vegetative Collect, Remove & Haul'],
  [/\b(?:c\s*&\s*d|c\s+and\s+d|construction\s+(?:and\s+)?demolition|g\s*&\s*d|g\s+d|cbd)\b.*\bcol(?:lect|loct|lodt)\b.*\bremove\b.*\bha?ul\b/i, 'C&D Collect, Remove & Haul'],
  [/\bmanagement\b.*(?:\bre(?:d|t)uction\b|\bredicton\b|\brgtuction\b|\bréduction\b)/i, 'Management & Reduction'],
  [/\bfinal\b.*\bdisposal\b/i, 'Final Disposal'],
  [/\b(?:tree|treg)\b.*\boperations?\b/i, 'Tree Operations'],
  [/\bspecialty\b.*\bremoval\b|\bspeclalty\b.*\bremoval\b|\bspeciatty\b.*\bremoval\b|\bspeofalty\b.*\bremoval\b/i, 'Specialty Removal'],
  [/\bpersonnel\b/i, 'Personnel'],
  [/\bequiproent\b|\bequinm/i, 'Equipment'],
  [/\bequipment\b|\bequinm[eé]at\b|\beaupment\b|\bequiprnent\b/i, 'Equipment'],
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = normalizeWhitespace(
    value
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/_{2,}/g, ' ')
      .replace(/[{}<>]+/g, ' ')
      .replace(/\bROWtoDMS\b/gi, 'ROW to DMS')
      .replace(/\bROW\s*t6\s*DMS\b/gi, 'ROW to DMS')
      .replace(/\bROW\s*10\s*DMS\b/gi, 'ROW to DMS')
      .replace(/\bMilas\b/gi, 'Miles')
      .replace(/\bBMS\b/gi, 'DMS')
      .replace(/\bDMS\s*-\s*FDS\b/gi, 'DMS to FDS')
      .replace(/\bDMS-to-FDS\b/gi, 'DMS to FDS')
      .replace(/\bCyblc\b/gi, 'Cubic')
      .replace(/\bCublc\b/gi, 'Cubic')
      .replace(/\bCubio\b/gi, 'Cubic')
      .replace(/\bCubic\s+Vard\b/gi, 'Cubic Yard')
      .replace(/\bfromRuralAreas\b/gi, 'from Rural Areas')
      .replace(/\s+\/\s*$/g, ''),
  );
  return cleaned.length > 0 ? cleaned : null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/-?\$?\s*[\d,]+(?:\.\d{1,2})?/);
  if (!match) return null;
  const token = match[0].replace(/[$#Â§§\s]/g, '');
  const normalized = !token.includes('.') && /,\d{2}$/.test(token)
    ? token.replace(',', '.')
    : token.replace(/,/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyTokens(value: string): string[] {
  return value.match(/[$#§]\s*[\d,]+(?:\.\d{1,2})?/g) ?? [];
}

function hasPassthroughRate(value: string): boolean {
  return /\bpass\s*through\b|\bpassthrough\b/i.test(value);
}

function hasRateEvidence(value: string): boolean {
  return hasPassthroughRate(value)
    || moneyTokens(value).length > 0
    || /(?:^|[^\d])\d{1,4}\.\d{2}(?:[^\d]|$)/.test(value);
}

function parseRateCell(value: string): number | null {
  const tokens = moneyTokens(value);
  if (tokens.length > 1) return null;
  if (tokens.length === 1) return parseNumber(tokens[0] ?? null);

  const decimalRate = value.match(/(?:^|[^\d])(\d{1,4}\.\d{2})(?:[^\d]|$)/);
  return parseNumber(decimalRate?.[1] ?? null);
}

function moneyTokenInfos(value: string): Array<{ token: string; index: number }> {
  return [...value.matchAll(/[$#\u00a7]\s*[\d,]+(?:\.\d{1,2})?/g)].map((match) => ({
    token: match[0],
    index: match.index ?? 0,
  }));
}

function normalizeSuspiciousRate(params: {
  rate: number | null;
  category: string | null;
  page: number;
  rateRaw: string | null;
  rawText: string;
}): { rate: number | null; confidence: ExhibitAConfidence | null; suppress: boolean } {
  const { rate, category, page, rateRaw, rawText } = params;
  if (rate == null) return { rate, confidence: null, suppress: false };

  const combined = `${rateRaw ?? ''} ${rawText}`;
  const compactDigits = (moneyTokens(rateRaw ?? '')[0] ?? rateRaw ?? '').replace(/[^\d]/g, '');
  const hasCurrency = moneyTokens(combined).length > 0;
  const hasDistance = /\b(?:0|16|31|60)\s*(?:-|to|\+)|\bmiles?\b|\brow\b|\bdms\b|\bfds\b/i.test(combined);

  if (!hasCurrency && rate < 1 && category && !/\b(?:hour|cubic|yard|tree|stump|pound|unit|ton)\b/i.test(combined)) {
    return { rate, confidence: 'needs_review', suppress: true };
  }

  if (
    page === 8
    && category === 'C&D Collect, Remove & Haul'
    && hasDistance
    && /^\d{3}$/.test(compactDigits)
    && rate >= 100
    && rate < 1000
  ) {
    return { rate: Number((rate / 100).toFixed(2)), confidence: 'needs_review', suppress: false };
  }

  if (
    category === 'Tree Operations'
    && /\bstump\b/i.test(combined)
    && /\b(?:fill|fil)\b/i.test(combined)
    && /^\d{4}$/.test(compactDigits)
    && rate >= 1000
    && rate < 10000
  ) {
    return { rate: Number((rate / 100).toFixed(2)), confidence: 'needs_review', suppress: false };
  }

  if (
    category === 'Equipment'
    && /^\d{5}$/.test(compactDigits)
    && /00$/.test(compactDigits)
    && rate >= 10000
  ) {
    return { rate: Number((rate / 100).toFixed(2)), confidence: 'needs_review', suppress: false };
  }

  return { rate, confidence: null, suppress: false };
}

function normalizeUnit(value: string | null): string | null {
  if (!value) return null;
  const text = value.toLowerCase();
  if (/\bhours?\b|\bhrs?\b|\blhour\b|\bi'?hour\b|\biour\b|\btour\b/.test(text)) return 'Hour';
  if (/\btrees?\b/.test(text)) return 'Tree';
  if (/\bstumps?\b/.test(text)) return 'Stump';
  if (/\bpounds?\b|\blbs?\b/.test(text)) return 'Pound';
  if (/\btons?\b/.test(text)) return 'Ton';
  if (/\bunits?\b|\beach\b|\bea\b|\bunt\b/.test(text)) return 'Unit';
  if (/\bloads?\b/.test(text)) return 'Load';
  if (/\bcubic\b.*\byard\b|\bcu\.?\s*yd\b|\bcy\b|\bcyd\b/.test(text)) return 'Cubic Yard';
  if (/\byards?\b|\byd\.?\b/.test(text)) return 'Yard';
  return null;
}

function isEquipmentCapacityText(value: string): boolean {
  return /\b(?:cu\.?\s*yd|cubic\s+yards?|yd\.?)\b.{0,24}\bcap(?:acity)?\b|\b\d{1,3}\s*(?:-\s*\d{1,3})?\s*cu\.?\s*yd\b/i
    .test(value);
}

function categoryFromText(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeWhitespace(value.replace(/[|[\]"'~]/g, ' '));
  for (const [pattern, category] of CATEGORY_ALIASES) {
    if (pattern.test(normalized)) return category;
  }
  return null;
}

const PAGE_8_CUBIC_YARD_CATEGORIES = new Set([
  'Vegetative Collect, Remove & Haul',
  'C&D Collect, Remove & Haul',
  'Management & Reduction',
  'Final Disposal',
]);

function pageEightCategoryUsesCubicYard(page: number, category: string | null): boolean {
  return page === 8 && category != null && PAGE_8_CUBIC_YARD_CATEGORIES.has(category);
}

function recoverContextUnit(page: number, category: string | null, rawText: string): string | null {
  if (pageEightCategoryUsesCubicYard(page, category)) return 'Cubic Yard';
  if ((page === 10 || page === 11) && (category === 'Personnel' || category === 'Equipment')) {
    return 'Hour';
  }
  if (page === 9 && category === 'Tree Operations') {
    if (/\bstump\b/i.test(rawText) && /\bfill\b/i.test(rawText)) return 'Cubic Yard';
    if (/\bstump\b/i.test(rawText)) return 'Stump';
    return 'Tree';
  }
  return null;
}

function textMentionsCubicYard(value: string): boolean {
  return /\bcubic\s+yards?\b|\bc\.?\s*y\.?\b|\bcu\.?\s*yd\.?\b|\bcy\b|\bcyd\b/i.test(value);
}

function cellLooksLikeUnitColumn(value: string): boolean {
  const withoutMoney = value.replace(/[$#]\s*[\d,]+(?:\.\d{1,2})?/g, ' ');
  const normalized = normalizeWhitespace(withoutMoney);
  return normalized.length <= 24 && normalized.split(/\s+/).length <= 3;
}

function stripCategory(value: string, category: string | null): string {
  if (!category) return value;
  return normalizeWhitespace(
    value
      .replace(new RegExp(category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ')
      .replace(/\b(category|description|unit|rate)\b/gi, ' '),
  );
}

function stripUnitAndRate(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/[$#]\s*[\d,]+(?:\.\d{1,2})?/g, ' ')
      .replace(/\b(?:cubic\s+yard|cy|cyd|hour|hours|hr|tree|stump|pound|lb|unit|ton)\b/gi, ' ')
      .replace(/\bPDF\s+(?:text\s+block|table(?:\s+row)?)\s+on\s+page\s+\d+\b/gi, ' ')
      .replace(/[|[\]{}]+/g, ' '),
  );
}

function detectContextHint(value: string): ContextHint | null {
  const text = cleanText(value) ?? value;
  if (/\brural\s*areas?\b/i.test(text)) return { area: 'Rural Areas' };
  if (/\bunincorporated\b|\bneighborhoods?\b/i.test(text)) return { area: 'Unincorporated Neighborhood' };
  return null;
}

function normalizeDistance(value: string): string | null {
  const text = cleanText(value) ?? value;
  if (/\bany\s+distance\b/i.test(text)) return 'Any Distance';
  if (/\b60\s*\+\b|\b60\s*plus\b/i.test(text)) return '60+ Miles';
  if (/\b31\s*(?:-|to)\s*60\b|\b81\s*(?:-|to)\s*60\b/i.test(text)) return '31 to 60 Miles';
  if (/\b16\s*(?:-|to)\s*30\b/i.test(text)) return '16 to 30 Miles';
  if (/\b0\s*(?:-|to)\s*(?:15|16)\b/i.test(text)) return '0 to 15 Miles';
  return null;
}

function cleanPricingDescription(params: {
  category: string | null;
  description: string | null;
  rawText: string;
  context: ContextHint | null;
}): string | null {
  const { category, rawText, context } = params;
  const description = params.description ? cleanText(params.description) : null;
  const combined = cleanText(`${description ?? ''} ${rawText}`) ?? rawText;
  const distance = normalizeDistance(combined);
  const area = detectContextHint(combined)?.area ?? context?.area ?? null;

  if (category === 'Vegetative Collect, Remove & Haul' && distance) {
    if (area) return `from ${area} ROW to DMS ${distance}`;
    if (/\brow\b.*\bdms\b|\bdms\b.*\brow\b/i.test(combined)) return `ROW to DMS ${distance}`;
  }

  if (category === 'C&D Collect, Remove & Haul' && distance) {
    return distance === 'Any Distance'
      ? 'Single Cost from ROW to DMS Any Distance'
      : `from ROW to DMS ${distance}`;
  }

  if (category === 'Final Disposal' && distance) {
    if (/single\s+cost|any\s+distance/i.test(combined)) return 'Single Cost Any Distance';
    if (/\bmulch\b|\bfds\b/i.test(combined)) return `Mulch DMS to FDS ${distance}`;
    return `DMS to Final Disposal ${distance}`;
  }

  if (category === 'Management & Reduction') {
    if (/\bgrinding\b|\bchipping\b/i.test(combined)) return 'Grinding and Chipping Vegetative Debris';
    if (/\bopen\s+burn/i.test(combined)) return 'Open Burning of Vegetative Debris';
    if (/\bcompact/i.test(combined)) return 'Compaction of Vegetative Debris';
    if (/\bpreparation\b|\bsegregating\b/i.test(combined)) {
      return 'Preparation, Vegetative Management, Debris and Segregating Material at DMS';
    }
  }

  if (category === 'Tree Operations') {
    if (/\bstump\b/i.test(combined) && /\bfill\b|\bfil\s+dit\b/i.test(combined)) {
      return 'Stump Fill Dirt for Filling Stump Holes';
    }
    if (/\bhazardous\b.*\bstump\b/i.test(combined)) return cleanText(description ?? combined);
    if (/\blimbs?\b.*\bhanging\b/i.test(combined)) return 'Trees with Hazardous Limbs Hanging';
    if (/\bhazardous\b.*\btrees?\b/i.test(combined)) return cleanText(description ?? combined);
  }

  if (!description) return null;
  return cleanText(
    description
      .replace(/\b(?:category|description|unit|rate)\b/gi, ' ')
      .replace(/\b(?:OR EN|Toe seo j|Cotte vara Joo|ame yan)\b/gi, ' '),
  );
}

function descriptionLooksOcrDamaged(value: string | null): boolean {
  if (!value) return true;
  const normalized = cleanText(value) ?? value;
  const meaningfulWords = normalized
    .split(/\s+/)
    .filter((word) => /[a-z]{2,}/i.test(word) && !/^(?:row|dms|fds|to|from|and|or|the|with)$/i.test(word))
    .length;
  return (
    meaningfulWords < 2 ||
    /\b(?:Goldott|Gollodt|Rowlo|RowIo|Unf|CT1|Ipo|Cotte|Joo|Toe\s+seo|ny\s+i|SER)\b/i.test(normalized) ||
    /\bfromROWto\b|\bROWto\b/.test(value) ||
    /[~*_]{2,}/.test(value)
  );
}

function parsePipeRow(text: string): ParsedExhibitRow | null {
  const columns = text.split('|').map((part) => cleanText(part)).filter((part): part is string => Boolean(part));
  if (columns.length < 3) return null;

  const rateIndex = columns.findLastIndex((column) => hasRateEvidence(column));
  if (rateIndex < 0) return null;
  const unitIndex = columns.findIndex(
    (column, index) =>
      index !== rateIndex
      && !categoryFromText(column)
      && cellLooksLikeUnitColumn(column)
      && normalizeUnit(column) != null,
  );
  const category = categoryFromText(columns.join(' '));
  const unit = unitIndex >= 0 ? normalizeUnit(columns[unitIndex] ?? null) : null;
  const rateCell = columns[rateIndex] ?? '';
  const rateTokens = moneyTokens(rateCell);
  const hasPassthrough = hasPassthroughRate(rateCell);
  const rate = parseRateCell(rateCell);
  const descriptionParts = columns.filter((_, index) => index !== rateIndex && index !== unitIndex);
  const description = cleanText(stripUnitAndRate(stripCategory(descriptionParts.join(' '), category)));
  return {
    category,
    description,
    unit,
    rate,
    rateRaw: cleanText(rateCell),
    confidence:
      rateTokens.length > 1 || !category || !description || !unit || (rate == null && !hasPassthrough)
        ? 'needs_review'
        : 'medium',
  };
}

function parseCells(
  cells: Array<{ text: string; column_index: number }>,
  inheritedCategory: string | null,
  pageNumber: number,
): ParsedExhibitRow | null {
  const ordered = [...cells].sort((left, right) => left.column_index - right.column_index);
  const rawCells = ordered.map((cell) => cleanText(cell.text)).filter((cell): cell is string => Boolean(cell));
  if (rawCells.length === 0) return null;
  const rawText = rawCells.join(' | ');
  const piped = parsePipeRow(rawText);

  const rateCandidateIndexes = rawCells
    .map((cell, index) => ({ cell, index }))
    .filter((candidate) => hasRateEvidence(candidate.cell));
  if (rateCandidateIndexes.length === 0 && !piped) return null;
  const rateCandidate = rateCandidateIndexes.at(-1);
  const rateCell = rateCandidate?.cell ?? rawCells.at(-1) ?? '';
  const rateIndex = rateCandidate?.index ?? rawCells.length - 1;
  const rateTokens = moneyTokens(rateCell);
  const hasPassthrough = hasPassthroughRate(rateCell);
  const rate = parseRateCell(rateCell);
  const explicitCategory = categoryFromText(rawCells[0] ?? '') ?? categoryFromText(rawText);
  const category = explicitCategory ?? inheritedCategory ?? piped?.category ?? null;
  const unitCandidates = rawCells
    .map((cell, index) => ({ cell, index, unit: normalizeUnit(cell) }))
    .filter((candidate): candidate is { cell: string; index: number; unit: string } => candidate.unit != null);
  const unitCandidate = unitCandidates
    .filter((candidate) => {
      if (candidate.index === 0 && categoryFromText(candidate.cell)) return false;
      if (candidate.index !== rateIndex && !cellLooksLikeUnitColumn(candidate.cell)) return false;
      if (category === 'Equipment' && (candidate.unit === 'Cubic Yard' || candidate.unit === 'Yard')) {
        return !isEquipmentCapacityText(candidate.cell);
      }
      return true;
    })
    .sort((left, right) => {
      const score = (candidate: { cell: string; index: number; unit: string }): number => {
        let value = 0;
        if (candidate.index === rateIndex) value += 80;
        if (candidate.index === rateIndex - 1) value += 70;
        if (candidate.index > 1) value += 20;
        if (cellLooksLikeUnitColumn(candidate.cell)) value += 15;
        if (candidate.unit === 'Hour') value += 10;
        if (pageEightCategoryUsesCubicYard(pageNumber, category) && candidate.unit === 'Cubic Yard') value += 10;
        if (candidate.unit === 'Yard') value -= 10;
        return value;
      };
      const scoreDelta = score(right) - score(left);
      if (scoreDelta !== 0) return scoreDelta;
      return right.index - left.index;
    })[0];
  const unitIndex = unitCandidate?.index ?? -1;
  const pipedUnit =
    category === 'Equipment'
      && (piped?.unit === 'Cubic Yard' || piped?.unit === 'Yard')
      && isEquipmentCapacityText(rawText)
      ? null
      : piped?.unit ?? null;
  const rawUnit = unitCandidate?.unit ?? pipedUnit ?? null;
  let unit: string | null = pageEightCategoryUsesCubicYard(pageNumber, category) && (rawUnit === 'Yard' || rawUnit === 'Cubic Yard')
    ? 'Cubic Yard'
    : rawUnit;
  let unitRecoveredFromContext = false;
  if (pageEightCategoryUsesCubicYard(pageNumber, category) && (!unit || unit === 'Yard')) {
    unit = 'Cubic Yard';
    unitRecoveredFromContext = !textMentionsCubicYard(rawText);
  }
  if (!unit) {
    unit = recoverContextUnit(pageNumber, category, rawText);
    unitRecoveredFromContext = unit != null;
  }
  const textCells = rawCells.filter((_, index) => index !== unitIndex && rawCells[index] !== rateCell);
  const descriptionSource = textCells.length >= 2 ? textCells.slice(explicitCategory ? 1 : 0).join(' ') : textCells.join(' ');
  const cellDescription = cleanText(stripUnitAndRate(stripCategory(descriptionSource, category)));
  const rateCellDescription = cleanText(stripUnitAndRate(stripCategory(rateCell, category)));
  const description =
    !cellDescription || /^\d+$/.test(cellDescription) || cellDescription.length < 4
      ? piped?.description ?? rateCellDescription ?? cellDescription ?? null
      : cellDescription;

  if (!rate && !description) return null;

  const descriptionDamaged = descriptionLooksOcrDamaged(description);
  const confidence: ExhibitAConfidence =
    rateTokens.length > 1 || !category || !description || !unit || (rate == null && !hasPassthrough)
      ? 'needs_review'
      : descriptionDamaged
        ? 'needs_review'
      : unitRecoveredFromContext
        ? 'needs_review'
        : explicitCategory
        ? 'high'
        : 'medium';

  return {
    category,
    description,
    unit,
    rate,
    rateRaw: cleanText(rateCell),
    confidence,
  };
}

function tableLooksLikeExhibitA(table: PdfTable): boolean {
  if (!EXHIBIT_A_PAGES.has(table.page_number)) return false;
  const text = [
    ...table.headers,
    ...table.header_context,
    ...table.rows.map((row) => row.raw_text),
  ].join(' ');
  const hasRate = table.rows.some((row) => hasRateEvidence(row.raw_text));
  return (
    hasRate
    && (
      /\b(category|description|unit|rate|exhibit\s+a|emergency\s+debris\s+removal\s+unit\s+rates|section\s+2|time\s*&\s*materials)\b/i.test(text)
      || categoryFromText(text) != null
    )
  );
}

function splitMultiRateLine(line: string): string[] {
  const tokens = moneyTokenInfos(line);
  if (tokens.length <= 1) return [line];
  const categoryStarts = [...line.matchAll(/\b(?:Equipment|Personnel|Vegetative|Vegatative|C\s*&\s*D|CBD|G&D|Management|Final\s+Disposal|Tree\s+Operations|Treg\s+Operations|Specialty|Speclalty|Speciatty|Speofalty)\b/gi)]
    .map((match) => match.index ?? 0)
    .filter((index) => index > 0);
  if (categoryStarts.length === 0) return [line];

  const starts = [0, ...categoryStarts].sort((left, right) => left - right);
  const segments = starts
    .map((start, index) => cleanText(line.slice(start, starts[index + 1] ?? line.length)))
    .filter((segment): segment is string => Boolean(segment));
  return segments.every((segment) => moneyTokens(segment).length <= 1) ? segments : [line];
}

function rowVariants(row: PdfTable['rows'][number]): RowVariant[] {
  const lines = row.raw_text
    .split(/\n+/)
    .flatMap((line) => splitMultiRateLine(line))
    .map((line) => cleanText(line))
    .filter((line): line is string => Boolean(line));
  if (lines.length <= 1) {
    return [{ idSuffix: '', cells: row.cells, rawText: row.raw_text }];
  }

  const rateLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => hasRateEvidence(line));
  if (rateLines.length === 0) {
    return [{ idSuffix: '', cells: row.cells, rawText: row.raw_text }];
  }

  return rateLines.map(({ line, index }) => ({
    idSuffix: `:v${index + 1}`,
    cells: [{ column_index: 0, text: line }],
    rawText: line,
  }));
}

function rowRank(row: ContractRateScheduleRow): number {
  let rank = 0;
  if (row.confidence === 'high') rank += 50;
  if (row.confidence === 'medium') rank += 35;
  if (row.unit) rank += 15;
  if (row.description && row.description.length > 12) rank += 10;
  if (row.rate != null) rank += 10;
  if (row.raw_text && /[|[\]_]{2,}/.test(row.raw_text)) rank -= 3;
  return rank;
}

function normalizedRowKey(row: ContractRateScheduleRow): string {
  return [
    row.category ?? '',
    row.page != null ? String(row.page) : '',
    row.rate != null ? String(row.rate) : '',
    (row.unit ?? '').toLowerCase(),
    (row.description ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  ].join('|');
}

function dedupeRows(rows: ContractRateScheduleRow[]): ContractRateScheduleRow[] {
  const byKey = new Map<string, ContractRateScheduleRow>();
  for (const row of rows) {
    const key = normalizedRowKey(row);
    const existing = byKey.get(key);
    if (!existing || rowRank(row) > rowRank(existing)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

export function extractExhibitARateTableRows(tables: readonly PdfTable[] | null | undefined): ContractRateScheduleRow[] {
  if (!Array.isArray(tables)) return [];

  const rows: ContractRateScheduleRow[] = [];
  const inheritedCategoryByPage = new Map<number, string | null>();
  const contextByPage = new Map<number, ContextHint | null>();
  for (const table of tables) {
    if (!tableLooksLikeExhibitA(table)) continue;
    let inheritedCategory: string | null = inheritedCategoryByPage.get(table.page_number) ?? null;
    let inheritedContext: ContextHint | null = contextByPage.get(table.page_number) ?? null;
    for (const row of table.rows) {
      const rowHint = detectContextHint(row.raw_text);
      if (rowHint) {
        inheritedContext = rowHint;
        contextByPage.set(row.page_number ?? table.page_number, inheritedContext);
      }
      for (const variant of rowVariants(row)) {
        const rowText = cleanText(variant.rawText) ?? '';
        const rowCategory = categoryFromText(rowText);
        if (rowCategory) inheritedCategory = rowCategory;
        const parsed = parseCells(variant.cells, inheritedCategory, row.page_number ?? table.page_number);
        if (!parsed) continue;
        if (parsed.category) inheritedCategory = parsed.category;
        inheritedCategoryByPage.set(row.page_number ?? table.page_number, inheritedCategory);
        const hasAmbiguousRateEvidence = parsed.rate == null && moneyTokens(parsed.rateRaw ?? rowText).length > 1;
        const hasPassthrough = hasPassthroughRate(parsed.rateRaw ?? rowText);
        const category = parsed.category ?? inheritedCategory;
        const description = cleanPricingDescription({
          category,
          description: parsed.description,
          rawText: rowText,
          context: inheritedContext,
        });
        if (!description) continue;
        if (parsed.rate == null && !hasAmbiguousRateEvidence && !hasPassthrough) continue;

        const sourceAnchorIds = [row.id, table.id].filter((value): value is string => Boolean(value));
        const rateRaw = hasPassthrough ? 'Passthrough' : parsed.rateRaw ?? rowText;
        const rateQuality = normalizeSuspiciousRate({
          rate: parsed.rate,
          category,
          page: row.page_number ?? table.page_number,
          rateRaw,
          rawText: rowText,
        });
        if (rateQuality.suppress) continue;
        const confidence = rateQuality.confidence ?? parsed.confidence;
        rows.push({
          row_id: `exhibit_a_table:${row.id}${variant.idSuffix}`,
          description,
          unit: parsed.unit,
          rate: rateQuality.rate,
          category,
          source_category: category,
          canonical_category: null,
          category_confidence: confidence === 'high' ? 0.95 : confidence === 'medium' ? 0.75 : 0.4,
          page: row.page_number ?? table.page_number,
          source_anchor_ids: sourceAnchorIds,
          rate_raw: rateRaw,
          material_type: category,
          unit_type: parsed.unit,
          rate_amount: rateQuality.rate,
          source_kind: 'exhibit_a_table',
          confidence,
          raw_cells: row.cells.map((cell: PdfTableCell) => cell.text),
          raw_text: rowText,
        });
      }
    }
  }

  return dedupeRows(rows);
}

export function extractCleanStructuralRateRows(tables: readonly PdfTable[] | null | undefined): ContractRateScheduleRow[] {
  if (!Array.isArray(tables)) return [];

  const rows: ContractRateScheduleRow[] = [];
  for (const table of tables) {
    if (EXHIBIT_A_PAGES.has(table.page_number)) continue;
    if (table.confidence < MIN_CLEAN_STRUCTURAL_TABLE_CONFIDENCE) continue;
    if (table.rows.length < 2) continue;

    const contextText = [...table.headers, ...table.header_context].join(' ');
    if (!/\b(category|description|unit|uom|measure|rate|cost|price|origin|destination)\b/i.test(contextText)) {
      continue;
    }

    const moneyRows = table.rows.filter((row: PdfTable['rows'][number]) =>
      row.cells.some((cell: PdfTableCell) => moneyTokens(cell.text).length > 0),
    );
    if (moneyRows.length === 0) continue;

    const shapedMoneyRows = moneyRows.filter((row: PdfTable['rows'][number]) => row.cells.length >= 4);
    if (shapedMoneyRows.length < Math.min(2, moneyRows.length)) continue;

    for (const row of table.rows) {
      const cells = [...row.cells].sort((left, right) => left.column_index - right.column_index);
      if (cells.length < 4) continue;

      const descriptionCell = cleanText(cells[0]?.text);
      const unitCell = cleanText(cells[1]?.text);
      const originDestinationCell = cleanText(cells[2]?.text);
      const rateCell = cleanText(cells[3]?.text);
      if (!descriptionCell || !unitCell || !rateCell || moneyTokens(rateCell).length === 0) continue;

      const rate = parseNumber(rateCell);
      if (rate == null) continue;

      const description = cleanText([descriptionCell, originDestinationCell].filter(Boolean).join(' '));
      if (!description) continue;

      const sourceAnchorIds = [row.id, table.id].filter((value): value is string => Boolean(value));
      rows.push({
        row_id: `structural_table:${row.id}`,
        description,
        unit: unitCell,
        rate,
        category: null,
        source_category: null,
        canonical_category: null,
        category_confidence: null,
        page: row.page_number ?? table.page_number,
        source_anchor_ids: sourceAnchorIds,
        rate_raw: rateCell,
        material_type: null,
        unit_type: unitCell,
        rate_amount: rate,
        source_kind: 'structural_table',
        confidence: 'medium',
        raw_cells: row.cells.map((cell: PdfTableCell) => cell.text),
        raw_text: row.raw_text,
      });
    }
  }

  return dedupeRows(rows);
}
