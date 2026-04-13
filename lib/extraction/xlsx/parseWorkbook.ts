import { read, utils } from 'xlsx';
import type { ExtractionGap } from '@/lib/extraction/types';

export type SpreadsheetPrimitive = string | number | boolean | null;

export interface WorkbookRow {
  row_number: number;
  cells: SpreadsheetPrimitive[];
  values: Record<string, SpreadsheetPrimitive>;
}

export interface WorkbookSheetModel {
  key: string;
  name: string;
  header_row_number: number;
  headers: string[];
  row_count: number;
  column_count: number;
  rows: WorkbookRow[];
  preview_text: string;
}

export interface WorkbookParseResult {
  parser_version: 'workbook_v1';
  sheet_count: number;
  sheets: WorkbookSheetModel[];
  workbook_text_preview: string;
  confidence: number;
  gaps: ExtractionGap[];
}

const MAX_SHEETS = 8;
const MAX_ROWS_PER_SHEET = 750;
const MAX_COLUMNS = 40;

function buildGap(input: Omit<ExtractionGap, 'id' | 'source'>): ExtractionGap {
  return {
    id: `gap:${input.category}:${input.sheet ?? 'workbook'}:${input.row ?? '0'}`,
    source: 'xlsx',
    ...input,
  };
}

function normalizeHeader(value: unknown, index: number): string {
  const base = String(value ?? '').replace(/\s+/g, ' ').trim();
  return base || `Column ${index + 1}`;
}

function uniqueHeaders(values: string[]): string[] {
  const counts = new Map<string, number>();
  return values.map((value) => {
    const normalized = value.trim();
    const current = counts.get(normalized) ?? 0;
    counts.set(normalized, current + 1);
    return current === 0 ? normalized : `${normalized} (${current + 1})`;
  });
}

function filledCells(row: unknown[]): number {
  return row.filter((cell) => String(cell ?? '').trim().length > 0).length;
}

function parseCell(value: unknown): SpreadsheetPrimitive {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text.replace(/[$,]/g, ''));
  if (!Number.isNaN(numeric) && /[$,\d.]/.test(text)) return numeric;
  return text;
}

function previewText(headers: string[], rows: WorkbookRow[]): string {
  return rows
    .slice(0, 8)
    .map((row) => headers
      .map((header) => `${header}: ${row.values[header] ?? ''}`)
      .filter((pair) => !pair.endsWith(': '))
      .join(' | '))
    .filter(Boolean)
    .join('\n');
}

export function stableSheetKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sheet';
}

export async function parseWorkbook(bytes: ArrayBuffer): Promise<WorkbookParseResult> {
  try {
    const workbook = read(Buffer.from(bytes), {
      type: 'buffer',
      cellDates: true,
      raw: false,
      dense: true,
    });

    const gaps: ExtractionGap[] = [];
    const sheets: WorkbookSheetModel[] = [];
    const sheetNames = workbook.SheetNames.slice(0, MAX_SHEETS);
    if (workbook.SheetNames.length > MAX_SHEETS) {
      gaps.push(buildGap({
        category: 'sheet_limit_applied',
        severity: 'warning',
        message: `Workbook contains ${workbook.SheetNames.length} sheets; only the first ${MAX_SHEETS} were parsed.`,
      }));
    }

    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rawRows = utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
      }) as unknown[][];

      if (rawRows.length === 0) {
        gaps.push(buildGap({
          category: 'empty_sheet',
          severity: 'info',
          message: 'Sheet did not contain any populated rows.',
          sheet: sheetName,
        }));
        continue;
      }

      let headerRowIndex = 0;
      let bestScore = -1;
      for (let index = 0; index < Math.min(rawRows.length, 10); index += 1) {
        const score = filledCells(rawRows[index]?.slice(0, MAX_COLUMNS) ?? []);
        if (score > bestScore) {
          bestScore = score;
          headerRowIndex = index;
        }
      }

      const headerCandidates = rawRows[headerRowIndex]?.slice(0, MAX_COLUMNS) ?? [];
      const headers = uniqueHeaders(headerCandidates.map((header, index) => normalizeHeader(header, index)));
      const dataRows = rawRows
        .slice(headerRowIndex + 1, headerRowIndex + 1 + MAX_ROWS_PER_SHEET)
        .map((row, index) => {
          const trimmed = row.slice(0, MAX_COLUMNS);
          const values = Object.fromEntries(
            headers.map((header, headerIndex) => [header, parseCell(trimmed[headerIndex])]),
          );
          return {
            row_number: headerRowIndex + index + 2,
            cells: trimmed.map((cell) => parseCell(cell)),
            values,
          } satisfies WorkbookRow;
        })
        .filter((row) => Object.values(row.values).some((value) => value !== null));

      if (rawRows.length - headerRowIndex - 1 > MAX_ROWS_PER_SHEET) {
        gaps.push(buildGap({
          category: 'row_limit_applied',
          severity: 'warning',
          message: `Sheet contains ${rawRows.length - headerRowIndex - 1} data rows; only the first ${MAX_ROWS_PER_SHEET} were parsed.`,
          sheet: sheetName,
        }));
      }

      if (headers.every((header) => header.startsWith('Column '))) {
        gaps.push(buildGap({
          category: 'header_context_weak',
          severity: 'warning',
          message: 'Sheet headers were weak or missing; row context may be limited.',
          sheet: sheetName,
        }));
      }

      sheets.push({
        key: stableSheetKey(sheetName),
        name: sheetName,
        header_row_number: headerRowIndex + 1,
        headers,
        row_count: dataRows.length,
        column_count: headers.length,
        rows: dataRows,
        preview_text: previewText(headers, dataRows),
      });
    }

    const workbookTextPreview = sheets
      .map((sheet) => `${sheet.name}\n${sheet.preview_text}`)
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 12000);

    const confidence = sheets.length > 0
      ? Number((0.5 + Math.min(0.35, sheets.length * 0.07) + (workbookTextPreview.length > 200 ? 0.08 : 0)).toFixed(3))
      : 0;

    return {
      parser_version: 'workbook_v1',
      sheet_count: workbook.SheetNames.length,
      sheets,
      workbook_text_preview: workbookTextPreview,
      confidence,
      gaps,
    };
  } catch (error) {
    return {
      parser_version: 'workbook_v1',
      sheet_count: 0,
      sheets: [],
      workbook_text_preview: '',
      confidence: 0,
      gaps: [
        buildGap({
          category: 'workbook_parse_failed',
          severity: 'critical',
          message: error instanceof Error ? error.message : 'Unable to parse workbook.',
        }),
      ],
    };
  }
}
