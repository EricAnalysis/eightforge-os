import type { ExtractionGap } from '@/lib/extraction/types';
import type { PdfLayout, PdfLayoutLine } from '@/lib/extraction/pdf/extractText';
import { stripUnsafeTextControls } from '@/lib/extraction/textSanitization';

export interface PdfTableCell {
  column_index: number;
  text: string;
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
};

const EXPLICIT_ROW_START_PATTERN =
  /^(?:\d+(?:\.\d+)*[A-Z]?|[A-Z](?:\d+)?|[A-Z]{1,4}-\d+)(?:[.)])?(?=\s|$)/i;

const CONTINUATION_LEAD_PATTERN =
  /^(?:\(|\[|[-*•]|[:;.=]+|work\b|including\b|hauling\b|loading\b|removal\b|transport(?:ation|ing)?\b|collection\b|collect(?:ion|ed)?\b|placed\b|placement\b|from\b|to\b|the\b|and\b|or\b|for\b|of\b|on\b|in\b|at\b|with(?:out)?\b|by\b|through\b|all\b|labor\b|equipment\b|fuel\b|materials?\b|necessary\b|construction\b|management\b|operation(?:s)?\b|eligible\b|debris\b|drainage\b|retention\b|detention\b|ponds?\b|acequias?\b|arroyos?\b|culverts?\b|roadside\b|ditches?\b)/i;

const DESCRIPTION_HEADER_PATTERNS = [
  'description',
  'service',
  'rate description',
  'labor class',
  'classification',
  'item',
  'pay item',
  'work',
  'work activity',
  'activity',
] as const;

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

  for (let index = 1; index < line.tokens.length; index += 1) {
    const previous = line.tokens[index - 1];
    const token = line.tokens[index];
    const gap = token.x - (previous.x + previous.width);
    if (gap > Math.max(18, Math.min(48, previous.width * 1.6))) {
      cells.push({
        column_index: cells.length,
        text: stripUnsafeTextControls(currentTokens.map((candidate) => candidate.text).join(' ')).trim(),
      });
      currentTokens = [token];
    } else {
      currentTokens.push(token);
    }
  }

  if (currentTokens.length > 0) {
    cells.push({
      column_index: cells.length,
      text: stripUnsafeTextControls(currentTokens.map((candidate) => candidate.text).join(' ')).trim(),
    });
  }

  return cells.filter((cell) => cell.text.length > 0);
}

function tokenCells(line: PdfLayoutLine): PdfTableCell[] {
  return line.tokens
    .map((token, index) => ({
      column_index: index,
      text: stripUnsafeTextControls(token.text).trim(),
    }))
    .filter((cell) => cell.text.length > 0);
}

function renumberCells(cells: PdfTableCell[]): PdfTableCell[] {
  return cells.map((cell, index) => ({
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
  return tokenized.length > 0 ? tokenized : split;
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

function lineHasNumericRateSignal(text: string): boolean {
  const t = stripUnsafeTextControls(text);
  return RATE_MONEY_IN_LINE_RE.test(t) || /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/.test(t);
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

  if (
    line.kind === 'text' &&
    cells.length === 1 &&
    lastRow.cells.length >= minimumContinuationColumns &&
    line.text.trim().length > 0
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

      const firstRow = currentRows[0];
      const headers = currentHeader
        ? currentHeader.cells.map((cell) => cell.text)
        : isMostlyNonNumeric(firstRow.cells)
          ? firstRow.cells.map((cell) => cell.text)
          : [];
      const dataRows = currentHeader
        ? currentRows
        : headers.length > 0
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
      } else {
        row.cells.push({
          column_index: row.cells.length,
          text: sanitizedLineText,
        });
      }
      row.raw_text = `${row.raw_text}\n${stripUnsafeTextControls(line.text)}`;
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
