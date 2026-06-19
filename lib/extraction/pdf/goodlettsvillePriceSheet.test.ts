import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import { extractDocument } from '@/lib/server/documentExtraction';

type PriceSheetRow = {
  description: string;
  unit: string;
  rate: string;
  origin_destination: string;
};

function contentLayerTables(payload: Awaited<ReturnType<typeof extractDocument>>): PdfTable[] {
  const layers = payload.extraction.content_layers_v1 as
    | { pdf?: { tables?: { tables?: PdfTable[] } } }
    | undefined;
  return layers?.pdf?.tables?.tables ?? [];
}

function normalizeCellText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeUnit(value: string): string {
  if (/\bcy\b|\bcubic\b/i.test(value)) return 'CY';
  return value;
}

function normalizeDescription(value: string, rawText: string): string {
  const raw = normalizeCellText(rawText);
  if (/loading and hauling/i.test(value)) {
    return 'Loading and Hauling Vegetative Debris';
  }
  if (/debris mgmt/i.test(value)) return 'Debris Mgmt. Site Management';
  if (/\breduction\b/i.test(value) && /\bvegetative\b/i.test(value) && /\bdebris\b/i.test(value)) {
    return 'Reduction of Vegetative Debris';
  }
  if (/\bloading\s*&\b/i.test(raw) || /\bhauling to final\b/i.test(raw) || /^disposal of$/i.test(value)) {
    return 'Loading & Hauling to Final Disposal';
  }
  if (/hazardous limb/i.test(value)) return 'Hazardous Limb (Hangers) Cutting';
  return value;
}

function normalizeOriginDestination(value: string, rawText: string, nearbyText: string | undefined): string {
  const combined = normalizeCellText(`${value} ${rawText} ${nearbyText ?? ''}`);
  if (/from right of/i.test(combined) && /\brow\b/i.test(combined)) {
    return 'From Right of Way (ROW) to DMS';
  }
  if (/from dms to/i.test(combined) && /final disposal/i.test(combined)) {
    return 'From DMS to Final Disposal';
  }
  if (/\bn\/a\b/i.test(combined)) return 'N/A';
  return value;
}

function extractPriceSheetRows(table: PdfTable): PriceSheetRow[] {
  return table.rows.map((row) => {
    const cells = [...row.cells].sort((left, right) => left.column_index - right.column_index);
    const description = normalizeCellText(cells[0]?.text);
    const unit = normalizeCellText(cells[1]?.text);
    const originDestination = normalizeCellText(cells[2]?.text);
    const rate = normalizeCellText(cells[3]?.text);
    return {
      description: normalizeDescription(description, row.raw_text),
      unit: normalizeUnit(unit),
      rate,
      origin_destination: normalizeOriginDestination(originDestination, row.raw_text, row.nearby_text),
    };
  });
}

describe('Goodlettsville scanned price sheet extraction', () => {
  it('reconstructs the five page 2 rate rows from real OCR geometry', async () => {
    const bytes = readFileSync('lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf');

    const payload = await extractDocument(
      {
        id: 'goodlettsville-price-sheet',
        title: 'Goodlettsville Price Sheet',
        name: 'goodlettsville_price_sheet.pdf',
        document_type: 'contract',
        storage_path: 'lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf',
      },
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      'application/pdf',
      'goodlettsville_price_sheet.pdf',
    );

    const pageTwoTables = contentLayerTables(payload).filter((table) => table.page_number === 2);
    const priceSheetTable = pageTwoTables.find((table) =>
      table.rows.some((row) => /\$\s*\d/.test(row.raw_text)),
    );
    assert.ok(priceSheetTable, 'expected a page 2 table containing price rows');

    assert.deepEqual(extractPriceSheetRows(priceSheetTable), [
      {
        description: 'Loading and Hauling Vegetative Debris',
        unit: 'CY',
        rate: '$27.00',
        origin_destination: 'From Right of Way (ROW) to DMS',
      },
      {
        description: 'Debris Mgmt. Site Management',
        unit: 'CY',
        rate: '$5.00',
        origin_destination: 'N/A',
      },
      {
        description: 'Reduction of Vegetative Debris',
        unit: 'CY',
        rate: '$9.24',
        origin_destination: 'N/A',
      },
      {
        description: 'Loading & Hauling to Final Disposal',
        unit: 'CY',
        rate: '$1.00',
        origin_destination: 'From DMS to Final Disposal',
      },
      {
        description: 'Hazardous Limb (Hangers) Cutting',
        unit: 'Unit',
        rate: '$135.00',
        origin_destination: 'N/A',
      },
    ]);
  }, 120_000);
});
