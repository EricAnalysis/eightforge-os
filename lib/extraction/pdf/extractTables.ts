import type { ExtractionGap } from '@/lib/extraction/types';
import type { PdfLayout, PdfLayoutLine, PdfToken } from '@/lib/extraction/pdf/extractText';
import { stripUnsafeTextControls } from '@/lib/extraction/textSanitization';

export interface PdfTableCell {
  column_index: number;
  text: string;
  x_min?: number;
  x_max?: number;
  source?: 'pdfjs' | 'ocr_fallback';
}

export interface PdfTableRow {
  id: string;
  page_number: number;
  row_index: number;
  cells: PdfTableCell[];
  raw_text: string;
  nearby_text?: string;
}

export interface PdfTable {
  id: string;
  page_number: number;
  headers: string[];
  header_context: string[];
  rows: PdfTableRow[];
  confidence: number;
}

export interface PdfTableExtractionResult {
  tables: PdfTable[];
  confidence: number;
  gaps: ExtractionGap[];
}

type PdfTableHeaderCandidate = {
  lineIndex: number;
  cells: PdfTableCell[];
};

type PdfTableDraftRow = {
  lineIndex: number;
  endLineIndex: number;
  cells: PdfTableCell[];
  raw_text: string;
  tokens: PdfToken[];
};

type ColumnBand = {
  index: number;
  x_min: number;
  x_max: number;
  center: number;
  weight: number;
  label?: string;
};

type GeometryToken = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const EXPLICIT_ROW_START_PATTERN =
  /^(?:\d+(?:\.\d+)*[A-Z]?|[A-Z](?:\d+)?|[A-Z]{1,4}-\d+)(?:[.)])?(?=\s|$)/i;

const CONTINUATION_LEAD_PATTERN =
  /^(?:\(|\[|[-*•]|[:;.=]+|work\b|including\b|hauling\b|loading\b|removal\b|transport(?:ation|ing)?\b|collection\b|collect(?:ion|ed)?\b|placed\b|placement\b|from\b|to\b|the\b|and\b|or\b|for\b|of\b|on\b|in\b|at\b|with(?:out)?\b|by\b|through\b|all\b|labor\b|equipment\b|fuel\b|materials?\b|necessary\b|construction\b|management\b|operation(?:s)?\b|eligible\b|debris\b|drainage\b|retention\b|detention\b|ponds?\b|acequias?\b|arroyos?\b|culverts?\b|roadside\b|ditches?\b)/i;

function buildGap(input: Omit<ExtractionGap, 'id' | 'source'>): ExtractionGap {
  return {
    id: `gap:${input.category}:${input.page ?? 'global'}`,
    source: 'pdf',
    ...input,
  };
}

function splitIntoCells(line: PdfLayoutLine): PdfTableCell[] {
  if (line.tokens.length === 0) return [];
  const cells: PdfTableCell[] = [];
  let currentTokens = [line.tokens[0]];

  const cellFromTokens = (tokens: typeof line.tokens): PdfTableCell => {
    const xMin = Math.min(...tokens.map((token) => token.x));
    const xMax = Math.max(...tokens.map((token) => token.x + token.width));
    return {
      column_index: cells.length,
      text: stripUnsafeTextControls(tokens.map((candidate) => candidate.text).join(' ')).trim(),
      x_min: xMin,
      x_max: xMax,
      source: tokens.some((token) => token.source === 'ocr_fallback') || line.source === 'ocr_fallback'
        ? 'ocr_fallback'
        : 'pdfjs',
    };
  };

  for (let index = 1; index < line.tokens.length; index += 1) {
    const previous = line.tokens[index - 1];
    const token = line.tokens[index];
    const gap = token.x - (previous.x + previous.width);
    const gapThreshold = line.source === 'ocr_fallback' || previous.source === 'ocr_fallback' || token.source === 'ocr_fallback'
      ? Math.max(14, Math.min(28, previous.width * 0.85))
      : Math.max(18, Math.min(48, previous.width * 1.6));
    if (gap > gapThreshold) {
      cells.push(cellFromTokens(currentTokens));
      currentTokens = [token];
    } else {
      currentTokens.push(token);
    }
  }

  if (currentTokens.length > 0) {
    cells.push(cellFromTokens(currentTokens));
  }

  return cells.filter((cell) => cell.text.length > 0);
}

function tokenCells(line: PdfLayoutLine): PdfTableCell[] {
  return line.tokens
    .map((token, index) => ({
      column_index: index,
      text: stripUnsafeTextControls(token.text).trim(),
      x_min: token.x,
      x_max: token.x + token.width,
      source: token.source === 'ocr_fallback' || line.source === 'ocr_fallback' ? 'ocr_fallback' as const : 'pdfjs' as const,
    }))
    .filter((cell) => cell.text.length > 0);
}

function renumberCells(cells: PdfTableCell[]): PdfTableCell[] {
  return cells.map((cell, index) => ({
    ...cell,
    column_index: index,
    text: stripUnsafeTextControls(cell.text).trim(),
  })).filter((cell) => cell.text.length > 0);
}

function normalizeHeaderCells(cells: PdfTableCell[]): PdfTableCell[] {
  const normalized = renumberCells(cells);
  if (
    normalized[0]?.text === 'N' &&
    /^o\.?$/i.test(normalized[1]?.text ?? '')
  ) {
    return renumberCells([
      { column_index: 0, text: 'No.' },
      ...normalized.slice(2),
    ]);
  }
  return normalized;
}

function denseText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function headerAliasScore(value: string): number {
  const dense = denseText(value);
  if (dense.includes('description')) return 6;
  if (dense.includes('service')) return 5;
  if (dense.includes('ratedescription')) return 5;
  if (dense.includes('workactivity')) return 5;
  if (dense.includes('payitem')) return 4;
  if (dense.includes('laborclass')) return 4;
  if (dense.includes('classification')) return 4;
  if (dense === 'work' || dense.startsWith('work')) return 4;
  if (dense.includes('activity')) return 3;
  if (dense === 'item' || dense.startsWith('item')) return 2;
  return 0;
}

function looksNumeric(value: string): boolean {
  return /^\$?\s*[\d,]+(?:\.\d+)?(?:\s*(?:per|\/)\s*[A-Za-z].*)?$/i.test(value.trim());
}

function textHeavyScore(value: string): number {
  const letters = (value.match(/[A-Za-z]/g) ?? []).length;
  const digits = (value.match(/\d/g) ?? []).length;
  const words = value.trim().split(/\s+/).filter(Boolean).length;
  return letters * 2 + words * 3 - digits;
}

function resolveDescriptionColumnIndex(
  rowCells: PdfTableCell[],
  headerCells: PdfTableCell[] | null,
): number {
  if (rowCells.length === 0) return 0;
  if (headerCells) {
    let bestIndex = -1;
    let bestScore = 0;
    headerCells.forEach((cell, index) => {
      if (index >= rowCells.length) return;
      const score = headerAliasScore(cell.text);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex !== -1) return bestIndex;
  }

  const candidates = rowCells
    .map((cell, index) => {
      const trimmed = cell.text.trim();
      return {
        index,
        score:
          trimmed.length === 0 || looksNumeric(trimmed) || /^[A-Z]{1,4}$/.test(trimmed)
            ? Number.NEGATIVE_INFINITY
            : textHeavyScore(trimmed),
      };
    })
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  if (candidates[0]) return candidates[0].index;
  return Math.min(rowCells.length - 1, rowCells.length > 1 ? 1 : 0);
}

function cellsForTableLine(line: PdfLayoutLine): PdfTableCell[] {
  const split = splitIntoCells(line);
  if (split.length >= 2) return split;
  const tokenized = tokenCells(line);
  if (tokenized.length >= 2) return tokenized;
  const singleCell = tokenized.length > 0 ? tokenized : split;
  if (singleCell.length === 1) {
    const rowCells = splitSingleCellDataRowCells(line.text);
    if (rowCells.length >= 2) {
      return rowCells.map((cell) => ({
        ...cell,
        source: line.source === 'ocr_fallback' ? 'ocr_fallback' : cell.source,
      }));
    }
  }
  return singleCell;
}

function cellsForHeaderLine(line: PdfLayoutLine): PdfTableCell[] {
  const split = normalizeHeaderCells(splitIntoCells(line));
  const tokenized = normalizeHeaderCells(tokenCells(line));
  if (
    tokenized.length >= 3 &&
    tokenized.length > split.length &&
    tokenized.length <= Math.max(8, split.length + 3)
  ) {
    return tokenized;
  }
  if (split.length >= 3) {
    return split;
  }
  return tokenized.length > 0 ? tokenized : split;
}

function isMostlyNonNumeric(cells: PdfTableCell[]): boolean {
  const nonNumeric = cells.filter((cell) => !/[$]?\d/.test(cell.text)).length;
  return nonNumeric >= Math.ceil(cells.length / 2);
}

function headerContext(lines: PdfLayoutLine[], startIndex: number): string[] {
  return lines
    .slice(Math.max(0, startIndex - 2), startIndex)
    .map((line) => stripUnsafeTextControls(line.text).trim())
    .filter((line) => line.length > 0)
    .slice(-2);
}

function rowNearbyText(lines: PdfLayoutLine[], index: number): string | undefined {
  const nextText = stripUnsafeTextControls(lines[index + 1]?.text ?? '').trim();
  return nextText || undefined;
}

function leadingRowText(line: PdfLayoutLine, cells: PdfTableCell[]): string {
  return cells[0]?.text?.trim() || stripUnsafeTextControls(line.text).trim();
}

function looksLikeExplicitRowStart(text: string): boolean {
  return EXPLICIT_ROW_START_PATTERN.test(text.trim());
}

const RATE_MONEY_IN_LINE_RE = /\$?\s*[\d,]+(?:\.\d{1,4})?\b/;
const TRAILING_ROW_VALUES_RE =
  /(?:\$?\s*[\d,]+(?:\.\d+)?\s+){1,3}\$?\s*[\d,]+(?:\.\d+)?\s*$/;
const TRAILING_RATE_UNIT_RE =
  /(?:\$?\s*(?:per|\/)\s*[A-Za-z][A-Za-z .-]*|EA|EACH|HR|HOUR|DAY|CY|TN|LF|LS|LOT|TREE|TON|LOAD|ACRE|MILE|GAL|LB|SF|SY|MO|MONTH|WK|WEEK|CUBIC\s+YARD|LINEAR\s+FOOT|LUMP\s+SUM)\s*$/i;
const ROW_VALUE_RE = /^\$?\s*[\d,]+(?:\.\d+)?$/;
const ROW_SIGNAL_WORD_RE =
  /\b(?:rate|price|qty|quantity|unit|extension|amount|county\s+[a-z])\b/i;

function lineHasNumericRateSignal(text: string): boolean {
  const t = stripUnsafeTextControls(text);
  return RATE_MONEY_IN_LINE_RE.test(t) || /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/.test(t);
}

function lineHasMoneySignal(text: string): boolean {
  return /\$\s*[\d,]+(?:\.\d+)?/.test(stripUnsafeTextControls(text));
}

function normalizeLooseCellText(text: string): string {
  return stripUnsafeTextControls(text).replace(/\s+/g, ' ').trim();
}

function cellCenter(cell: PdfTableCell): number | null {
  if (typeof cell.x_min !== 'number' || typeof cell.x_max !== 'number') return null;
  return (cell.x_min + cell.x_max) / 2;
}

function isOcrCell(cell: PdfTableCell): boolean {
  return cell.source === 'ocr_fallback';
}

function bandLabelKind(label: string | undefined): 'description' | 'unit' | 'rate' | 'other' {
  const normalized = (label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (/\b(description|service|item|activity|classification)\b/.test(normalized)) return 'description';
  if (/\b(unit|uom)\b/.test(normalized) && !/\bprice|rate|cost\b/.test(normalized)) return 'unit';
  if (/\b(rate|price|cost)\b/.test(normalized)) return 'rate';
  return 'other';
}

function cellLooksLikeUnitValue(text: string): boolean {
  return /^(?:\$?\s*)?(?:per\s+)?(?:cubic\s+yards?|cy|cyd|each|ea|tons?|tn|hours?|hrs?|day|days|tree|trees|stump|stumps|pound|pounds|unit|units|ls|lump\s+sum|lf|sf|sy)$/i.test(text.trim());
}

function cellLooksLikeRateValue(text: string): boolean {
  return /^(?:\$?\s*[\d,]+(?:\.\d+)?|pass[-\s]?through)$/i.test(text.trim());
}

function isOcrTableCandidate(
  rows: readonly PdfTableDraftRow[],
  header: PdfTableHeaderCandidate | null,
): boolean {
  return rows.some((row) => row.cells.some(isOcrCell)) || Boolean(header?.cells.some(isOcrCell));
}

function inferColumnBands(params: {
  rows: readonly PdfTableDraftRow[];
  header: PdfTableHeaderCandidate | null;
}): ColumnBand[] {
  const headerCells = (params.header?.cells ?? []).filter((cell) => cellCenter(cell) != null);
  if (headerCells.length >= 2) {
    return headerCells
      .sort((left, right) => (cellCenter(left) ?? 0) - (cellCenter(right) ?? 0))
      .map((cell, index) => ({
        index,
        x_min: cell.x_min ?? cellCenter(cell) ?? 0,
        x_max: cell.x_max ?? cellCenter(cell) ?? 0,
        center: cellCenter(cell) ?? 0,
        weight: 1,
        label: cell.text,
      }));
  }

  const cells = [
    ...headerCells,
    ...params.rows.flatMap((row) => row.cells),
  ].filter((cell) => cellCenter(cell) != null);
  if (cells.length === 0) return [];

  const sorted = [...cells].sort((left, right) => (cellCenter(left) ?? 0) - (cellCenter(right) ?? 0));
  const clusters: Array<{ centers: number[]; xMins: number[]; xMaxes: number[] }> = [];
  const threshold = Math.max(
    24,
    Math.min(42, (Math.max(...sorted.map((cell) => cell.x_max ?? 0)) - Math.min(...sorted.map((cell) => cell.x_min ?? 0))) / 14),
  );

  for (const cell of sorted) {
    const center = cellCenter(cell);
    if (center == null) continue;
    const current = clusters.at(-1);
    const currentCenter = current
      ? current.centers.reduce((sum, value) => sum + value, 0) / current.centers.length
      : null;
    if (current && currentCenter != null && Math.abs(center - currentCenter) <= threshold) {
      current.centers.push(center);
      current.xMins.push(cell.x_min ?? center);
      current.xMaxes.push(cell.x_max ?? center);
    } else {
      clusters.push({
        centers: [center],
        xMins: [cell.x_min ?? center],
        xMaxes: [cell.x_max ?? center],
      });
    }
  }

  return clusters
    .filter((cluster) => cluster.centers.length >= 2 || params.rows.length <= 2)
    .map((cluster, index) => {
      const center = cluster.centers.reduce((sum, value) => sum + value, 0) / cluster.centers.length;
      return {
        index,
        x_min: Math.min(...cluster.xMins),
        x_max: Math.max(...cluster.xMaxes),
        center,
        weight: cluster.centers.length,
      };
    });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function reconstructColumnsFromGeometry(tokens: GeometryToken[]): ColumnBand[] {
  const usableTokens = tokens
    .filter((token) =>
      token.text.trim().length > 0 &&
      Number.isFinite(token.x) &&
      Number.isFinite(token.width),
    )
    .map((token) => ({
      ...token,
      x_max: token.x + Math.max(0, token.width),
    }));
  if (usableTokens.length === 0) return [];

  const lineBuckets: Array<{ y: number; tokens: typeof usableTokens }> = [];
  const medianHeight = median(usableTokens.map((token) => token.height).filter((height) => height > 0));
  const yTolerance = Math.max(4, medianHeight * 0.6);
  for (const token of usableTokens) {
    const bucket = lineBuckets.find((candidate) => Math.abs(candidate.y - token.y) <= yTolerance);
    if (bucket) {
      bucket.tokens.push(token);
    } else {
      lineBuckets.push({ y: token.y, tokens: [token] });
    }
  }

  const cutPositions: number[] = [];
  for (const bucket of lineBuckets) {
    const lineTokens = bucket.tokens.sort((left, right) => left.x - right.x);
    const gaps = lineTokens
      .slice(1)
      .map((token, index) => token.x - (lineTokens[index]?.x_max ?? token.x))
      .filter((gap) => gap > 0);
    const lineThreshold = Math.max(24, Math.min(42, median(gaps) * 2 || 28));
    for (let index = 1; index < lineTokens.length; index += 1) {
      const previous = lineTokens[index - 1];
      const token = lineTokens[index];
      const gap = token.x - (previous.x_max ?? token.x);
      if (gap > lineThreshold) {
        cutPositions.push((previous.x_max + token.x) / 2);
      }
    }
  }

  const clusteredCuts: Array<{ values: number[] }> = [];
  for (const cut of cutPositions.sort((left, right) => left - right)) {
    const current = clusteredCuts.at(-1);
    const currentCenter = current
      ? current.values.reduce((sum, value) => sum + value, 0) / current.values.length
      : null;
    if (current && currentCenter != null && Math.abs(cut - currentCenter) <= 35) {
      current.values.push(cut);
    } else {
      clusteredCuts.push({ values: [cut] });
    }
  }

  const cuts = clusteredCuts
    .filter((cluster) => cluster.values.length >= 2 || clusteredCuts.length <= 3)
    .map((cluster) => cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length)
    .sort((left, right) => left - right);
  if (cuts.length >= 2) {
    const xMin = Math.min(...usableTokens.map((token) => token.x));
    const xMax = Math.max(...usableTokens.map((token) => token.x_max));
    const boundaries = [xMin - 1, ...cuts, xMax + 1];
    return boundaries.slice(0, -1).map((left, index) => {
      const right = boundaries[index + 1] ?? left;
      const bandTokens = usableTokens.filter((token) => {
        const center = token.x + (Math.max(0, token.width) / 2);
        return center >= left && center < right;
      });
      const bandXMin = bandTokens.length > 0 ? Math.min(...bandTokens.map((token) => token.x)) : left;
      const bandXMax = bandTokens.length > 0 ? Math.max(...bandTokens.map((token) => token.x_max)) : right;
      return {
        index,
        x_min: bandXMin,
        x_max: bandXMax,
        center: (bandXMin + bandXMax) / 2,
        weight: bandTokens.length,
      };
    });
  }

  const intervals = usableTokens
    .map((token) => ({
      x_min: token.x,
      x_max: token.x_max,
    }))
    .sort((left, right) => left.x_min - right.x_min || left.x_max - right.x_max);

  const positiveGaps = intervals
    .slice(1)
    .map((interval, index) => interval.x_min - (intervals[index]?.x_max ?? interval.x_min))
    .filter((gap) => gap > 0);
  const adaptiveGap = Math.max(22, Math.min(30, median(positiveGaps) * 2.4 || 24));
  const clusters: Array<{ xMins: number[]; xMaxes: number[] }> = [];

  for (const interval of intervals) {
    const current = clusters.at(-1);
    const currentMax = current ? Math.max(...current.xMaxes) : null;
    if (current && currentMax != null && interval.x_min - currentMax <= adaptiveGap) {
      current.xMins.push(interval.x_min);
      current.xMaxes.push(interval.x_max);
    } else {
      clusters.push({
        xMins: [interval.x_min],
        xMaxes: [interval.x_max],
      });
    }
  }

  return clusters
    .filter((cluster) => Math.max(...cluster.xMaxes) - Math.min(...cluster.xMins) >= 8)
    .map((cluster, index) => {
      const xMin = Math.min(...cluster.xMins);
      const xMax = Math.max(...cluster.xMaxes);
      return {
        index,
        x_min: xMin,
        x_max: xMax,
        center: (xMin + xMax) / 2,
        weight: cluster.xMins.length,
      };
    });
}

function maxCellCount(rows: readonly PdfTableDraftRow[], header: PdfTableHeaderCandidate | null): number {
  return Math.max(
    header?.cells.length ?? 0,
    0,
    ...rows.map((row) => row.cells.length),
  );
}

function hasDollarCell(rows: readonly PdfTableDraftRow[], header: PdfTableHeaderCandidate | null): boolean {
  const texts = [
    ...(header?.cells.map((cell) => cell.text) ?? []),
    ...rows.flatMap((row) => [row.raw_text, ...row.cells.map((cell) => cell.text)]),
  ];
  return texts.some(lineHasMoneySignal);
}

function nearestGeometryBand(token: GeometryToken, bands: readonly ColumnBand[]): ColumnBand | null {
  if (bands.length === 0) return null;
  const center = token.x + (Math.max(0, token.width) / 2);
  return [...bands]
    .map((band) => {
      const distance = center >= band.x_min && center <= band.x_max
        ? 0
        : Math.min(Math.abs(center - band.x_min), Math.abs(center - band.x_max));
      return { band, distance };
    })
    .sort((left, right) => left.distance - right.distance || left.band.index - right.band.index)[0]?.band ?? null;
}

function geometryCellText(tokens: readonly PdfToken[]): string {
  return normalizeLooseCellText(tokens.map((token) => token.text).join(' '));
}

function buildGeometryCells(tokens: readonly PdfToken[], bands: readonly ColumnBand[]): PdfTableCell[] {
  const byColumn = new Map<number, PdfToken[]>();
  for (const token of tokens) {
    const band = nearestGeometryBand(token, bands);
    if (!band) continue;
    const current = byColumn.get(band.index) ?? [];
    current.push(token);
    byColumn.set(band.index, current);
  }

  return [...byColumn.entries()]
    .sort(([left], [right]) => left - right)
    .map(([columnIndex, columnTokens]) => {
      const sorted = [...columnTokens].sort((left, right) => left.y - right.y || left.x - right.x);
      return {
        column_index: columnIndex,
        text: geometryCellText(sorted),
        x_min: Math.min(...sorted.map((token) => token.x)),
        x_max: Math.max(...sorted.map((token) => token.x + token.width)),
        source: sorted.some((token) => token.source === 'ocr_fallback') ? 'ocr_fallback' as const : 'pdfjs' as const,
      };
    })
    .filter((cell) => cell.text.length > 0);
}

function firstTokenBand(line: PdfLayoutLine, bands: readonly ColumnBand[]): ColumnBand | null {
  const first = line.tokens[0];
  return first ? nearestGeometryBand(first, bands) : null;
}

function looksLikeGeometryRowStart(line: PdfLayoutLine, bands: readonly ColumnBand[]): boolean {
  if (lineHasMoneySignal(line.text)) return false;
  if (firstTokenBand(line, bands)?.index !== 0 && !line.text.includes('&')) return false;
  const words = line.text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (/^(?:from|to|and|or|of|yard|cubic|unit|final\s+disposal)\b/i.test(line.text.trim())) {
    return false;
  }
  return true;
}

function reconstructOcrRowsFromGeometry(params: {
  rows: readonly PdfTableDraftRow[];
  pageLines: readonly PdfLayoutLine[];
}): PdfTableDraftRow[] {
  const firstLineIndex = Math.min(...params.rows.map((row) => row.lineIndex));
  const lastLineIndex = Math.max(...params.rows.map((row) => row.endLineIndex));
  let startLineIndex = firstLineIndex;
  for (let index = firstLineIndex - 1; index >= Math.max(0, firstLineIndex - 8); index -= 1) {
    const line = params.pageLines[index];
    if (!line || line.source !== 'ocr_fallback') break;
    startLineIndex = index;
    if (/\bdescription\b/i.test(line.text)) break;
  }

  const candidateLines = params.pageLines
    .slice(startLineIndex, lastLineIndex + 1)
    .map((line, offset) => ({ line, index: startLineIndex + offset }))
    .filter(({ line }) => line.source === 'ocr_fallback' && line.tokens.length > 0);
  const moneyLines = candidateLines.filter(({ line }) => lineHasMoneySignal(line.text));
  if (moneyLines.length < 2) return [];

  let headerEnd = startLineIndex - 1;
  for (const { index, line } of candidateLines) {
    if (index >= moneyLines[0]!.index) break;
    if (/\b(?:description|unit|measure|origin|destination|cost|rate|price)\b/i.test(line.text)) {
      headerEnd = index;
      continue;
    }
    break;
  }
  const dataStart = Math.max(
    startLineIndex,
    Math.min(headerEnd + 1, moneyLines[0]!.index - 3),
  );
  const dataLines = candidateLines.filter(({ index }) => index >= dataStart);
  const bands = reconstructColumnsFromGeometry(dataLines.flatMap(({ line }) => line.tokens));
  if (bands.length < 3) return [];

  const rowStarts = dataLines
    .filter(({ index, line }) =>
      index > dataStart &&
      index > moneyLines[0]!.index &&
      looksLikeGeometryRowStart(line, bands) &&
      moneyLines.some((moneyLine) => moneyLine.index >= index),
    )
    .map(({ index }) => index);
  const anchoredRowStarts = [...new Set([dataStart, ...rowStarts])].sort((left, right) => left - right);
  const rowAnchors = anchoredRowStarts.length >= moneyLines.length
    ? anchoredRowStarts
    : moneyLines.map(({ index }) => index);

  return rowAnchors.map((startIndex, rowIndex) => {
    const nextStart = rowAnchors[rowIndex + 1] ?? (lastLineIndex + 1);
    const rowHasMoney = moneyLines.some(({ index }) => index >= startIndex && index < nextStart);
    if (!rowHasMoney) return null;
    const lowerBound = startIndex;
    const upperBound = nextStart - 1;
    const rowLines = dataLines.filter(({ index }) => index >= lowerBound && index <= upperBound);
    const rowTokens = rowLines.flatMap(({ line }) => line.tokens);
    const cells = buildGeometryCells(rowTokens, bands);
    return {
      lineIndex: rowLines[0]?.index ?? startIndex,
      endLineIndex: rowLines.at(-1)?.index ?? startIndex,
      cells: renumberCells(cells),
      raw_text: rowLines.map(({ line }) => stripUnsafeTextControls(line.text)).join('\n'),
      tokens: rowTokens,
    };
  }).filter((row): row is PdfTableDraftRow => row != null && row.cells.length >= 3);
}

function nearestColumnBand(cell: PdfTableCell, bands: readonly ColumnBand[]): ColumnBand | null {
  const center = cellCenter(cell);
  if (center == null || bands.length === 0) return null;
  const best = [...bands]
    .map((band) => ({ band, distance: Math.abs(center - band.center) }))
    .sort((left, right) => left.distance - right.distance || left.band.index - right.band.index)[0]?.band ?? null;
  if (!best) return null;
  const previous = bands[best.index - 1];
  const bestKind = bandLabelKind(best.label);
  const previousKind = bandLabelKind(previous?.label);
  if (
    previous &&
    previousKind === 'description' &&
    bestKind === 'unit' &&
    !cellLooksLikeUnitValue(cell.text) &&
    (cell.x_min ?? center) < best.x_min
  ) {
    return previous;
  }
  if (
    previous &&
    previousKind === 'unit' &&
    bestKind === 'rate' &&
    !cellLooksLikeRateValue(cell.text) &&
    (cell.x_min ?? center) < best.x_min
  ) {
    return previous;
  }
  return best;
}

function alignCellsToColumnBands(
  cells: readonly PdfTableCell[],
  bands: readonly ColumnBand[],
): PdfTableCell[] {
  if (bands.length < 2) return renumberCells([...cells]);
  const byColumn = new Map<number, PdfTableCell[]>();
  for (const cell of cells) {
    const band = nearestColumnBand(cell, bands);
    const index = band?.index ?? cell.column_index;
    const current = byColumn.get(index) ?? [];
    current.push(cell);
    byColumn.set(index, current);
  }

  return [...byColumn.entries()]
    .sort(([left], [right]) => left - right)
    .map(([columnIndex, columnCells]) => ({
      column_index: columnIndex,
      text: normalizeLooseCellText(columnCells.map((cell) => cell.text).join(' ')),
      x_min: Math.min(...columnCells.map((cell) => cell.x_min ?? Number.POSITIVE_INFINITY).filter(Number.isFinite)),
      x_max: Math.max(...columnCells.map((cell) => cell.x_max ?? Number.NEGATIVE_INFINITY).filter(Number.isFinite)),
      source: columnCells.some(isOcrCell) ? 'ocr_fallback' as const : 'pdfjs' as const,
    }))
    .map((cell) => ({
      ...cell,
      x_min: Number.isFinite(cell.x_min) ? cell.x_min : undefined,
      x_max: Number.isFinite(cell.x_max) ? cell.x_max : undefined,
    }))
    .filter((cell) => cell.text.length > 0);
}

function stabilizeOcrTableColumns(params: {
  rows: PdfTableDraftRow[];
  header: PdfTableHeaderCandidate | null;
  pageLines: readonly PdfLayoutLine[];
}): {
  rows: PdfTableDraftRow[];
  header: PdfTableHeaderCandidate | null;
} {
  if (!isOcrTableCandidate(params.rows, params.header)) return params;
  const lineSpan = params.rows.length > 0
    ? Math.max(...params.rows.map((row) => row.endLineIndex)) - Math.min(...params.rows.map((row) => row.lineIndex)) + 1
    : 0;
  const originalMaxCellCount = maxCellCount(params.rows, params.header);
  const shouldAttemptGeometryReconstruction =
    hasDollarCell(params.rows, params.header) &&
    (
      originalMaxCellCount < 3 ||
      (params.rows.length <= 4 && lineSpan >= 8)
    );
  const bands = inferColumnBands(params);
  const stabilized = bands.length < 2
    ? params
    : {
    header: params.header
      ? { ...params.header, cells: alignCellsToColumnBands(params.header.cells, bands) }
      : params.header,
    rows: params.rows.map((row) => ({
      ...row,
      cells: alignCellsToColumnBands(row.cells, bands),
    })),
  };
  if (!shouldAttemptGeometryReconstruction) {
    return stabilized;
  }

  const reconstructedRows = reconstructOcrRowsFromGeometry({
    rows: params.rows,
    pageLines: params.pageLines,
  });
  return reconstructedRows.length > 0
    ? { rows: reconstructedRows, header: null }
    : stabilized;
}

function pullTrailingLooseCellValue(text: string): { remaining: string; value: string } | null {
  const match = /^(.*?)(?:\s+|^)(\$?\s*[\d,]+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const remaining = normalizeLooseCellText(match[1] ?? '');
  const value = normalizeLooseCellText(match[2] ?? '');
  if (value.length === 0) return null;
  return { remaining, value };
}

function pullTrailingLooseRateUnit(text: string): { remaining: string; value: string } | null {
  const match = new RegExp(
    `^(.*?)(?:\\s+|^)(${TRAILING_RATE_UNIT_RE.source})\\s*$`,
    TRAILING_RATE_UNIT_RE.flags,
  ).exec(text);
  if (!match) return null;
  const remaining = normalizeLooseCellText(match[1] ?? '');
  const value = normalizeLooseCellText(match[2] ?? '');
  if (value.length === 0) return null;
  return { remaining, value };
}

function looksLikeSingleCellDataRowText(text: string): boolean {
  const normalized = normalizeLooseCellText(text);
  if (normalized.length === 0) return false;

  const hasTrailingRowValues = TRAILING_ROW_VALUES_RE.test(normalized);
  const hasTrailingRateUnit = TRAILING_RATE_UNIT_RE.test(normalized);
  const hasRateWords = ROW_SIGNAL_WORD_RE.test(normalized);
  const hasDecimalValue = /\b\d+\.\d+\b/.test(normalized);
  const hasTrailingNumericValue = ROW_VALUE_RE.test(
    pullTrailingLooseCellValue(normalized)?.value ?? '',
  );

  return (
    (hasTrailingRowValues && hasDecimalValue) ||
    (hasTrailingRateUnit && hasTrailingNumericValue) ||
    (hasRateWords && hasTrailingNumericValue)
  );
}

function splitSingleCellDataRowCells(text: string): PdfTableCell[] {
  const normalized = normalizeLooseCellText(text);
  if (!looksLikeSingleCellDataRowText(normalized)) return [];

  const trailingValues: string[] = [];
  let remaining = normalized;

  for (let index = 0; index < 3; index += 1) {
    const nextValue = pullTrailingLooseCellValue(remaining);
    if (!nextValue) break;
    trailingValues.unshift(nextValue.value);
    remaining = nextValue.remaining;
  }

  if (trailingValues.length === 0) return [];

  const rateUnit = pullTrailingLooseRateUnit(remaining);
  const unitValue = rateUnit?.value ?? null;
  remaining = rateUnit?.remaining ?? remaining;

  let quantityValue: string | null = null;
  const quantity = pullTrailingLooseCellValue(remaining);
  if (quantity && unitValue) {
    quantityValue = quantity.value;
    remaining = quantity.remaining;
  }

  const description = normalizeLooseCellText(remaining);
  if (description.length === 0) return [];

  return renumberCells([
    { column_index: 0, text: description },
    ...(quantityValue ? [{ column_index: 1, text: quantityValue }] : []),
    ...(unitValue ? [{ column_index: 2, text: unitValue }] : []),
    ...trailingValues.map((value, index) => ({
      column_index: 3 + index,
      text: value,
    })),
  ]);
}

function looksLikeScheduleFooterLine(line: PdfLayoutLine, cells: PdfTableCell[]): boolean {
  const t = stripUnsafeTextControls(line.text).trim();
  if (t.length === 0) return false;
  if (/^\*?\s*total\b/i.test(t)) return true;
  if (/^page\s+\d+\s*(?:of\s+\d+)?$/i.test(t)) return true;
  if (line.kind === 'form_candidate' && /\btotal\b/i.test(t)) return true;
  if (/^subtotal\b/i.test(t)) return true;
  const joined = cells.map((c) => c.text).join(' ');
  if (/\btotal\b/i.test(joined) && lineHasNumericRateSignal(joined)) return true;
  return false;
}

function looksLikeStandaloneSectionHeader(line: PdfLayoutLine): boolean {
  const text = stripUnsafeTextControls(line.text).trim();
  if (!text) return false;
  if (/^section\s+[A-Za-z0-9]+(?:\b|[.:)-])/i.test(text)) return true;
  if (/^(?:category|type)\s*:/i.test(text)) return true;
  return false;
}

function looksLikeDescriptionContinuation(
  line: PdfLayoutLine,
  cells: PdfTableCell[],
  lastRow: PdfTableDraftRow,
): boolean {
  const lead = leadingRowText(line, cells);
  if (looksLikeExplicitRowStart(lead)) return false;
  const numericCells = cells.filter((cell) => /[$]?\d/.test(cell.text)).length;
  if (numericCells >= 2) return false;
  const trimmed = lead.trim();
  if (trimmed.length === 0) return false;
  if (lastRow.cells.length < 2) return false;
  if (/^\(/.test(trimmed)) return true;
  if (/^[A-Z][a-z][^.]{2,}/.test(trimmed) && numericCells === 0 && cells.length <= 3) {
    return true;
  }
  return false;
}

function mergeContinuationLine(
  line: PdfLayoutLine,
  cells: PdfTableCell[],
  lastRow: PdfTableDraftRow,
  headerCells: PdfTableCell[] | null,
  explicitRowStart: boolean,
  tableContextActive: boolean,
  minimumContinuationColumns: number,
  numericCells: number,
): boolean {
  if (!tableContextActive || !lastRow || explicitRowStart) return false;
  if (looksLikeScheduleFooterLine(line, cells)) return false;
  if (looksLikeStandaloneSectionHeader(line)) return false;

  if (
    line.kind === 'text' &&
    cells.length === 1 &&
    lastRow.cells.length >= minimumContinuationColumns &&
    line.text.trim().length > 0 &&
    !looksLikeSingleCellDataRowText(line.text)
  ) {
    return true;
  }

  if (line.kind === 'text' && looksLikeWrappedContinuation({ line, cells, lastRow, headerCells })) {
    return true;
  }

  if (line.kind === 'text' && looksLikeDescriptionContinuation(line, cells, lastRow)) {
    return true;
  }

  if (
    line.kind === 'table_candidate' &&
    looksLikeDescriptionContinuation(line, cells, lastRow) &&
    !(cells.length >= 3 && numericCells >= 1)
  ) {
    return true;
  }

  if (line.kind === 'table_candidate') {
    const lead = leadingRowText(line, cells);
    if (looksLikeExplicitRowStart(lead)) return false;
    if (cells.length >= 3 && numericCells >= 1) return false;
    if (cells.length >= 5) return false;
    const strongMoney = cells.some((c) => /^\$\s*[\d,]+(?:\.\d+)?$/.test(c.text.trim()));
    if (strongMoney && cells.length >= 3) return false;
    if (
      looksLikeWrappedContinuation({ line, cells, lastRow, headerCells }) ||
      looksLikeDescriptionContinuation(line, cells, lastRow)
    ) {
      return true;
    }
  }

  return false;
}

function isRelaxedDataRow(params: {
  line: PdfLayoutLine;
  cells: PdfTableCell[];
  numericCells: number;
  explicitRowStart: boolean;
  tableContextActive: boolean;
}): boolean {
  const { line, cells, numericCells, explicitRowStart, tableContextActive } = params;
  if (!tableContextActive) return false;
  if (explicitRowStart && (numericCells >= 1 || lineHasNumericRateSignal(line.text))) {
    return true;
  }
  if (cells.length >= 2 && numericCells >= 1) {
    const hasRateToken = cells.some(
      (c) =>
        /^\$?\s*[\d,]+(?:\.\d+)?$/.test(c.text.trim()) ||
        /^\$?\s*[\d,]+(?:\.\d+)?\s*(?:per|\/)/i.test(c.text.trim()),
    );
    if (hasRateToken || lineHasNumericRateSignal(line.text)) return true;
  }
  if (cells.length === 1 && line.kind === 'text' && looksLikeSingleCellDataRowText(line.text)) {
    return true;
  }
  return false;
}

function headerLooksLikeRateSchedule(headers: string[]): boolean {
  const blob = headers.join(' ').toLowerCase();
  return /(unit|price|rate|qty|quantity|clin|description|extension|item|service|uom)/i.test(blob);
}

function looksLikeWrappedContinuation(params: {
  line: PdfLayoutLine;
  cells: PdfTableCell[];
  lastRow: PdfTableDraftRow;
  headerCells: PdfTableCell[] | null;
}): boolean {
  const lineText = stripUnsafeTextControls(params.line.text).trim();
  if (lineText.length === 0) return false;

  const leadText = leadingRowText(params.line, params.cells);
  if (looksLikeExplicitRowStart(leadText)) return false;

  const numericCells = params.cells.filter((cell) => /[$]?\d/.test(cell.text)).length;
  const referenceWidth = Math.max(
    params.lastRow.cells.length,
    params.headerCells?.length ?? 0,
  );
  const compactShape =
    params.cells.length <= Math.max(3, Math.ceil(referenceWidth / 2));
  const continuationLead =
    /^[a-z]/.test(leadText) ||
    CONTINUATION_LEAD_PATTERN.test(leadText);

  return continuationLead && (compactShape || numericCells <= 1);
}

export function buildPdfTableExtraction(params: {
  layout: PdfLayout;
}): PdfTableExtractionResult {
  const tables: PdfTable[] = [];
  const gaps: ExtractionGap[] = [...params.layout.gaps];

  for (const page of params.layout.pages) {
    let pendingHeader: PdfTableHeaderCandidate | null = null;
    let currentHeader: PdfTableHeaderCandidate | null = null;
    let currentRows: PdfTableDraftRow[] = [];

    const flush = () => {
      if (currentRows.length === 0) {
        pendingHeader = null;
        currentHeader = null;
        return;
      }

      if (!currentHeader && currentRows.length < 2) {
        currentRows = [];
        pendingHeader = null;
        currentHeader = null;
        return;
      }

      const provisionalHeader =
        currentHeader == null &&
        isMostlyNonNumeric(currentRows[0]?.cells ?? []) &&
        !lineHasNumericRateSignal(currentRows[0]?.raw_text ?? '')
          ? { lineIndex: currentRows[0]?.lineIndex ?? 0, cells: currentRows[0]?.cells ?? [] }
          : currentHeader;
      const stabilized = stabilizeOcrTableColumns({
        rows: currentRows,
        header: provisionalHeader,
        pageLines: page.lines,
      });
      currentRows = stabilized.rows;
      currentHeader = currentHeader == null ? null : stabilized.header;

      const firstRow = currentRows[0];
      const headers = currentHeader
        ? currentHeader.cells.map((cell) => cell.text)
        : isMostlyNonNumeric(firstRow.cells) && !lineHasNumericRateSignal(firstRow.raw_text)
          ? firstRow.cells.map((cell) => cell.text)
          : [];
      const dataRows = currentHeader
        ? currentRows
        : headers.length > 0 && !lineHasNumericRateSignal(firstRow.raw_text)
          ? currentRows.slice(1)
          : currentRows;
      if (dataRows.length === 0) {
        currentRows = [];
        pendingHeader = null;
        currentHeader = null;
        return;
      }

      const anchorLineIndex = currentHeader?.lineIndex ?? firstRow.lineIndex;
      const tableId = `pdf:table:p${page.page_number}:t${tables.length + 1}`;
      const confidence = Math.min(
        0.95,
        0.4 +
          (headers.length > 0 ? 0.2 : 0.1) +
          Math.min(0.25, dataRows.length * 0.05),
      );

      tables.push({
        id: tableId,
        page_number: page.page_number,
        headers,
        header_context: headerContext(page.lines, anchorLineIndex),
        rows: dataRows.map((row, rowIndex) => ({
          id: `${tableId}:r${rowIndex + 1}`,
          page_number: page.page_number,
          row_index: rowIndex + 1,
          cells: renumberCells(row.cells),
          raw_text: stripUnsafeTextControls(row.raw_text),
          nearby_text: rowNearbyText(page.lines, row.endLineIndex),
        })),
        confidence,
      });

      if (process.env.EIGHTFORGE_OCR_DEBUG === '1' && isOcrTableCandidate(dataRows, currentHeader)) {
        console.log('[pdf-tables][ocr-table-candidate]', {
          page_number: page.page_number,
          table_key: tableId,
          row_count: dataRows.length,
          column_count: Math.max(headers.length, ...dataRows.map((row) => row.cells.length)),
          header_row_text: headers.join(' | '),
          sample_row_text: dataRows[0]?.raw_text ?? null,
          cell_count_per_row: dataRows.map((row) => row.cells.length),
          x_coordinate_ranges: dataRows.slice(0, 8).map((row) =>
            row.cells.map((cell) => ({
              cell_index: cell.column_index,
              text: cell.text,
              x_min: cell.x_min ?? null,
              x_max: cell.x_max ?? null,
              source: cell.source ?? null,
            })),
          ),
        });
      }

      const lineIndices = currentRows.map((r) => r.lineIndex);
      const endIndices = currentRows.map((r) => r.endLineIndex);
      const lineSpan = Math.max(1, Math.max(...endIndices) - Math.min(...lineIndices) + 1);
      if (
        dataRows.length > 0 &&
        dataRows.length <= 4 &&
        lineSpan >= 16 &&
        headerLooksLikeRateSchedule(headers)
      ) {
        gaps.push(
          buildGap({
            category: 'table_row_count_suspiciously_low',
            severity: 'warning',
            page: page.page_number,
            label: tableId,
            message:
              `Table "${tableId}" has ${dataRows.length} data row(s) over ${lineSpan} layout lines; row detection may have merged or dropped lines.`,
          }),
        );
      }

      currentRows = [];
      pendingHeader = null;
      currentHeader = null;
    };

    const appendContinuation = (line: PdfLayoutLine) => {
      const row = currentRows.at(-1);
      if (!row) return;
      const sanitizedLineText = stripUnsafeTextControls(line.text).trim();
      const descriptionIndex = resolveDescriptionColumnIndex(row.cells, currentHeader?.cells ?? null);
      const descriptionCell = row.cells[descriptionIndex];
      if (descriptionCell) {
        descriptionCell.text = `${descriptionCell.text} ${sanitizedLineText}`.trim();
        if (line.source === 'ocr_fallback') {
          descriptionCell.source = 'ocr_fallback';
        }
      } else {
        row.cells.push({
          column_index: row.cells.length,
          text: sanitizedLineText,
          x_min: typeof line.x_min === 'number' ? line.x_min : undefined,
          x_max: typeof line.x_max === 'number' ? line.x_max : undefined,
          source: line.source === 'ocr_fallback' ? 'ocr_fallback' : 'pdfjs',
        });
      }
      row.raw_text = `${row.raw_text}\n${stripUnsafeTextControls(line.text)}`;
      row.tokens = [...row.tokens, ...line.tokens];
      row.endLineIndex = page.lines.indexOf(line);
    };

    page.lines.forEach((line, index) => {
      const cells = cellsForTableLine(line);
      const numericCells = cells.filter((cell) => /[$]?\d/.test(cell.text)).length;
      const leadText = leadingRowText(line, cells);
      const explicitRowStart = looksLikeExplicitRowStart(leadText);
      const tableContextActive =
        currentRows.length > 0 ||
        currentHeader != null ||
        pendingHeader != null;
      const lastRow = currentRows.at(-1);
      const headerCells = cellsForHeaderLine(line);

      if (
        tableContextActive &&
        currentRows.length > 0 &&
        looksLikeScheduleFooterLine(line, cells)
      ) {
        flush();
        return;
      }

      const minimumContinuationColumns = currentHeader != null
        ? Math.max(3, Math.min(currentHeader.cells.length, lastRow?.cells.length ?? 0))
        : 0;
      const mergeContinuation = lastRow
        ? mergeContinuationLine(
            line,
            cells,
            lastRow,
            currentHeader?.cells ?? null,
            explicitRowStart,
            tableContextActive,
            minimumContinuationColumns,
            numericCells,
          )
        : false;

      if (mergeContinuation) {
        appendContinuation(line);
        return;
      }

      const candidate =
        line.kind === 'table_candidate' ||
        (cells.length >= 3 && numericCells >= 1) ||
        (tableContextActive && explicitRowStart) ||
        isRelaxedDataRow({
          line,
          cells,
          numericCells,
          explicitRowStart,
          tableContextActive,
        });
      const headerLike =
        line.kind === 'text' &&
        headerCells.length >= 3 &&
        isMostlyNonNumeric(headerCells);

      if (candidate) {
        if (currentRows.length === 0) {
          currentHeader =
            pendingHeader && pendingHeader.lineIndex === index - 1
              ? pendingHeader
              : null;
        }
        pendingHeader = null;
        currentRows.push({
          lineIndex: index,
          endLineIndex: index,
          cells: renumberCells(cells),
          raw_text: stripUnsafeTextControls(line.text),
          tokens: line.tokens,
        });
        return;
      }

      if (headerLike) {
        flush();
        pendingHeader = {
          lineIndex: index,
          cells: headerCells,
        };
        return;
      }

      flush();
    });

    flush();
  }

  if (tables.length === 0) {
    gaps.push(buildGap({
      category: 'table_structure_missing',
      severity: 'info',
      message: 'No stable table structure was detected in the PDF.',
    }));
  }

  const confidence = tables.length > 0
    ? Number((tables.reduce((sum, table) => sum + table.confidence, 0) / tables.length).toFixed(3))
    : 0;

  return {
    tables,
    confidence,
    gaps,
  };
}
