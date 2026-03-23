import type { ExtractionGap } from '@/lib/extraction/types';
import type { PdfLayout, PdfLayoutLine } from '@/lib/extraction/pdf/extractText';

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
    if (gap > Math.max(18, previous.width * 1.6)) {
      cells.push({
        column_index: cells.length,
        text: currentTokens.map((candidate) => candidate.text).join(' ').trim(),
      });
      currentTokens = [token];
    } else {
      currentTokens.push(token);
    }
  }

  if (currentTokens.length > 0) {
    cells.push({
      column_index: cells.length,
      text: currentTokens.map((candidate) => candidate.text).join(' ').trim(),
    });
  }

  return cells.filter((cell) => cell.text.length > 0);
}

function isMostlyNonNumeric(cells: PdfTableCell[]): boolean {
  const nonNumeric = cells.filter((cell) => !/[$]?\d/.test(cell.text)).length;
  return nonNumeric >= Math.ceil(cells.length / 2);
}

function headerContext(lines: PdfLayoutLine[], startIndex: number): string[] {
  return lines
    .slice(Math.max(0, startIndex - 2), startIndex)
    .map((line) => line.text.trim())
    .filter((line) => line.length > 0)
    .slice(-2);
}

function rowNearbyText(lines: PdfLayoutLine[], index: number): string | undefined {
  const nextText = lines[index + 1]?.text?.trim();
  return nextText || undefined;
}

export function buildPdfTableExtraction(params: {
  layout: PdfLayout;
}): PdfTableExtractionResult {
  const tables: PdfTable[] = [];
  const gaps: ExtractionGap[] = [...params.layout.gaps];

  for (const page of params.layout.pages) {
    let currentRows: Array<{ lineIndex: number; line: PdfLayoutLine; cells: PdfTableCell[] }> = [];

    const flush = () => {
      if (currentRows.length < 2) {
        currentRows = [];
        return;
      }

      const firstRow = currentRows[0];
      const headers = isMostlyNonNumeric(firstRow.cells)
        ? firstRow.cells.map((cell) => cell.text)
        : [];
      const dataRows = headers.length > 0 ? currentRows.slice(1) : currentRows;
      if (dataRows.length === 0) {
        currentRows = [];
        return;
      }

      const confidence = Math.min(
        0.95,
        0.4 +
          (headers.length > 0 ? 0.2 : 0.1) +
          Math.min(0.25, dataRows.length * 0.05),
      );

      tables.push({
        id: `pdf:table:p${page.page_number}:t${tables.length + 1}`,
        page_number: page.page_number,
        headers,
        header_context: headerContext(page.lines, firstRow.lineIndex),
        rows: dataRows.map((row, rowIndex) => ({
          id: `pdf:table:p${page.page_number}:t${tables.length + 1}:r${rowIndex + 1}`,
          page_number: page.page_number,
          row_index: rowIndex + 1,
          cells: row.cells,
          raw_text: row.line.text,
          nearby_text: rowNearbyText(page.lines, row.lineIndex),
        })),
        confidence,
      });

      currentRows = [];
    };

    page.lines.forEach((line, index) => {
      const cells = splitIntoCells(line);
      const numericCells = cells.filter((cell) => /[$]?\d/.test(cell.text)).length;
      const candidate =
        line.kind === 'table_candidate' ||
        (cells.length >= 3 && numericCells >= 1);

      if (!candidate) {
        flush();
        return;
      }

      currentRows.push({ lineIndex: index, line, cells });
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
