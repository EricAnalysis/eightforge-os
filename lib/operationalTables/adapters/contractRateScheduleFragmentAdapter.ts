import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import { buildTableCellGeometry } from '@/lib/extraction/tableGeometry';
import type { OperationalTableFragment } from '@/lib/operationalTables/canonicalOperationalTableRowAssembler';

export type ContractRateScheduleSourceFamily = 'contract' | 'price_sheet';

export type ContractRateScheduleKind =
  | 'unit_rate'
  | 'time_and_materials'
  | 'price_sheet'
  | 'unknown';

export type ContractRateScheduleFragmentAdapterInput = {
  document_id: string;
  source_family: ContractRateScheduleSourceFamily;
  tables: PdfTable[];
  schedule_kind: ContractRateScheduleKind;
};

export type ContractRateScheduleFragmentAdapterOutput = {
  fragments: OperationalTableFragment[];
  adapter_warnings: string[];
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hintFromHeader(header: string | null | undefined): string | undefined {
  const normalized = normalizeHeader(header ?? '');
  if (!normalized) return undefined;
  if (/\b(category|type|group)\b/.test(normalized)) return 'category';
  if (/\b(description|service|item|classification|labor class)\b/.test(normalized)) return 'description';
  if (/\b(origin|destination)\b/.test(normalized)) return 'origin_destination';
  if (/\b(unit price|unit rate|unit cost|rate|price|cost)\b/.test(normalized)) return 'unit_price';
  if (/\b(unit|uom)\b/.test(normalized)) return 'unit';
  return undefined;
}

function hasMoneyLikeValue(value: string): boolean {
  return /(?:\$|[$§])\s*\d|(?:^|\s)\d{1,4}(?:\.\d{2})\b/.test(value);
}

function hasUnitLikeValue(value: string): boolean {
  return /\bcubic\b[^A-Za-z0-9]{0,16}\byards?\b/i.test(value)
    || /\b(?:cubic\s+yards?|cy|cyd|tons?|hours?|hrs?|each|ea|linear\s+feet|lf|square\s+feet|sf|acre|load|loads|trees?|stumps?)\b/i
    .test(value);
}

function isOcrFallbackTable(table: PdfTable): boolean {
  return table.rows.some((row) => row.cells.some((cell) => cell.source === 'ocr_fallback'));
}

function ocrRateScheduleSignals(table: PdfTable): { moneyCount: number; unitCount: number; titleHit: boolean } {
  const values = [
    ...table.headers,
    ...table.header_context,
    ...table.rows.map((row) => row.raw_text),
    ...table.rows.flatMap((row) => row.cells.map((cell) => cell.text)),
  ];
  return {
    moneyCount: values.filter(hasMoneyLikeValue).length,
    unitCount: values.filter(hasUnitLikeValue).length,
    titleHit: values.some((value) => /\b(?:rate|unit\s+rate|unit\s+price|price\s+sheet|schedule|description|category)\b/i.test(value)),
  };
}

function shouldInferOcrHints(table: PdfTable, hintsByColumn: ReadonlyMap<number, string>): boolean {
  if (!isOcrFallbackTable(table)) return false;
  if (hintsByColumn.has(0) && [...hintsByColumn.values()].some((hint) => hint === 'unit_price')) return false;
  const signals = ocrRateScheduleSignals(table);
  return signals.moneyCount >= 1 && signals.unitCount >= 1 && (signals.titleHit || signals.moneyCount >= 2);
}

function inferStructuredOcrColumnHints(table: PdfTable): Map<number, string> {
  const hints = new Map<number, string>();
  if (!isOcrFallbackTable(table) || table.rows.length < 2) return hints;

  const valuesByColumn = new Map<number, string[]>();
  for (const row of table.rows) {
    for (const cell of row.cells) {
      valuesByColumn.set(cell.column_index, [
        ...(valuesByColumn.get(cell.column_index) ?? []),
        cell.text,
      ]);
    }
  }
  if (valuesByColumn.size !== 4) return hints;

  for (const [columnIndex, values] of valuesByColumn) {
    const populated = values.filter((value) => value.trim().length > 0);
    if (populated.length === 0) continue;
    if (populated.every(hasMoneyLikeValue)) {
      hints.set(columnIndex, 'unit_price');
      continue;
    }
    if (populated.every(hasUnitLikeValue)) {
      hints.set(columnIndex, 'unit');
      continue;
    }
    if (populated.every((value) => /^(?:n\s*\/\s*a|from\b|to\b)|\b(?:origin|destination|dms|row)\b/i.test(value.trim()))) {
      hints.set(columnIndex, 'origin_destination');
    }
  }

  const remaining = [...valuesByColumn.keys()].filter((columnIndex) => !hints.has(columnIndex));
  if (remaining.length === 1) hints.set(remaining[0]!, 'description');
  return hints;
}

function inferOcrCellHint(cell: PdfTable['rows'][number]['cells'][number]): string | undefined {
  const text = cell.text.trim();
  if (!text || /^[|_\-—–.;:[\]()\s]+$/.test(text)) return undefined;
  if (/\bpass[-\s]?through\b/i.test(text) || hasMoneyLikeValue(text)) return 'unit_price';
  if (hasUnitLikeValue(text)) return 'unit';
  if (/[A-Za-z]/.test(text)) return 'description';
  return undefined;
}

function moneyValues(value: string): string[] {
  return value.match(/[$Â§]\s*[\d,]+(?:\.\d{1,2})?/g) ?? [];
}

function unitValue(value: string): string | null {
  if (/\bcubic\b[^A-Za-z0-9]{0,16}\byards?\b/i.test(value)) return 'Cubic Yard';
  if (/c[uy]b[il1]c?[^A-Za-z0-9]{0,16}yards?/i.test(value)) return 'Cubic Yard';
  const match = value.match(/\b(?:cubic\s+yards?|cy|cyd|tons?|hours?|hrs?|each|ea|linear\s+feet|lf|square\s+feet|sf|acre|load|loads|trees?|stumps?)\b/i);
  return match?.[0] ?? null;
}

function geometryForCell(params: {
  table: PdfTable;
  row: PdfTable['rows'][number];
  cell: PdfTable['rows'][number]['cells'][number];
}) {
  return buildTableCellGeometry({
    page_number: params.row.page_number ?? params.table.page_number,
    table_id: params.table.id,
    row_id: params.row.id,
    row_index: params.row.row_index,
    cell_index: params.cell.column_index,
    text: params.cell.text,
    x_min: params.cell.x_min,
    x_max: params.cell.x_max,
    source_type: params.cell.source,
    anchor_id: params.row.id,
  });
}

function mixedOcrFragments(params: {
  cell: PdfTable['rows'][number]['cells'][number];
  row: PdfTable['rows'][number];
  table: PdfTable;
}): OperationalTableFragment[] | null {
  const hasText = /[A-Za-z]/.test(params.cell.text);
  const rates = moneyValues(params.cell.text);
  const unit = unitValue(params.cell.text);
  if (!hasText || (rates.length === 0 && !unit)) return null;

  const base = {
    cell_index: params.cell.column_index,
    row_index: params.row.row_index,
    table_key: params.table.id,
    page_number: params.row.page_number ?? params.table.page_number,
    source: params.cell.source,
    geometry: geometryForCell(params),
  } satisfies Pick<OperationalTableFragment, 'cell_index' | 'row_index' | 'table_key' | 'page_number' | 'source' | 'geometry'>;
  const fragments: OperationalTableFragment[] = [];
  const descriptionText = params.cell.text
    .replace(/[$Â§]\s*[\d,]+(?:\.\d{1,2})?/g, ' ')
    .replace(/\bcubic\b[^A-Za-z0-9]{0,16}\byards?\b/ig, ' ')
    .replace(/c[uy]b[il1]c?[^A-Za-z0-9]{0,16}yards?/ig, ' ')
    .replace(/\b(?:cubic\s+yards?|cy|cyd|tons?|hours?|hrs?|each|ea|trees?|stumps?)\b/ig, ' ')
    .replace(/\b(?:category|description|unit|rate)\b/ig, ' ')
    .replace(/[|_[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (descriptionText && /[A-Za-z]/.test(descriptionText)) {
    fragments.push({
      ...base,
      cell_text: descriptionText,
      extractor_hint: 'description',
    });
  }
  if (unit) {
    fragments.push({
      ...base,
      cell_text: unit,
      extractor_hint: 'unit',
    });
  }
  if (rates.length > 0 || /\bpass[-\s]?through\b/i.test(params.cell.text)) {
    fragments.push({
      ...base,
      cell_text: params.cell.text,
      extractor_hint: 'unit_price',
    });
  }

  return fragments.length > 1 ? fragments : null;
}

function tableText(table: PdfTable): string {
  return [
    ...table.headers,
    ...table.header_context,
    ...table.rows.map((row) => row.raw_text),
    ...table.rows.flatMap((row) => row.cells.map((cell) => cell.text)),
  ].join(' ');
}

export function adaptContractRateScheduleFragments(
  input: ContractRateScheduleFragmentAdapterInput,
): ContractRateScheduleFragmentAdapterOutput {
  const fragments: OperationalTableFragment[] = [];
  const adapterWarnings: string[] = [];

  for (const table of input.tables) {
    if (table.headers.length === 0) {
      adapterWarnings.push(`no headers detected for table ${table.id}`);
    }

    const text = tableText(table);
    if (/\bpass[-\s]?through\b/i.test(text)) {
      adapterWarnings.push(`Passthrough rate detected in table ${table.id}`);
    }
    if (/\$\s*[\d,]+(?:\.\d{1,2})?\s*\/\s*(?:hr|hour|hours)\b/i.test(text)) {
      adapterWarnings.push(`compound rate detected in table ${table.id}`);
    }
    if (/\bpound\s*\/\s*unit\b/i.test(text)) {
      adapterWarnings.push(`compound unit detected in table ${table.id}: Pound/Unit`);
    }

    const hintsByColumn = new Map<number, string>();
    table.headers.forEach((header, index) => {
      const hint = hintFromHeader(header);
      if (hint) hintsByColumn.set(index, hint);
    });
    for (const [columnIndex, hint] of inferStructuredOcrColumnHints(table)) {
      if (!hintsByColumn.has(columnIndex)) hintsByColumn.set(columnIndex, hint);
    }
    const inferOcrHints = shouldInferOcrHints(table, hintsByColumn);

    for (const row of table.rows) {
      for (const cell of row.cells) {
        const mixedFragments = inferOcrHints && cell.source === 'ocr_fallback'
          ? mixedOcrFragments({ cell, row, table })
          : null;
        if (mixedFragments) {
          fragments.push(...mixedFragments);
          continue;
        }
        const extractorHint = hintsByColumn.get(cell.column_index)
          ?? (inferOcrHints ? inferOcrCellHint(cell) : undefined);
        fragments.push({
          cell_text: cell.text,
          cell_index: cell.column_index,
          row_index: row.row_index,
          table_key: table.id,
          page_number: row.page_number ?? table.page_number,
          source: cell.source,
          geometry: geometryForCell({ table, row, cell }),
          extractor_hint: extractorHint,
        });
      }
    }
  }

  return {
    fragments,
    adapter_warnings: adapterWarnings,
  };
}
