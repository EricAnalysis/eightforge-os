import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { adaptContractRateScheduleFragments } from '@/lib/operationalTables/adapters/contractRateScheduleFragmentAdapter';
import { assembleCanonicalOperationalTableRows } from '@/lib/operationalTables/canonicalOperationalTableRowAssembler';
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

function extractPriceSheetRows(table: PdfTable): PriceSheetRow[] {
  return table.rows.map((row) => {
    const cells = [...row.cells].sort((left, right) => left.column_index - right.column_index);
    const description = normalizeCellText(cells[0]?.text);
    const unit = normalizeCellText(cells[1]?.text);
    const originDestination = normalizeCellText(cells[2]?.text);
    const rate = normalizeCellText(cells[3]?.text);
    return {
      description,
      unit,
      rate,
      origin_destination: originDestination,
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
        unit: 'Cubic Yard (CY)',
        rate: '$27.00',
        origin_destination: 'From Right of Way (ROW) to DMS',
      },
      {
        description: 'Debris Mgmt. Site Management',
        unit: 'Cubic Yard (CY)',
        rate: '$5.00',
        origin_destination: 'N/A',
      },
      {
        description: 'Reduction of Vegetative Debris',
        unit: 'Cubic Yard (CY)',
        rate: '$9.24',
        origin_destination: 'N/A',
      },
      {
        description: 'Loading & Hauling to Final Disposal of Reduced Vegetative Debris',
        unit: 'Cubic Yard (CY)',
        rate: '$1.00',
        origin_destination: 'From DMS to Final Disposal',
      },
      {
        description: 'Hazardous Limb (Hangers) Cutting (greater than 2" diameter)',
        unit: 'Unit',
        rate: '$135.00',
        origin_destination: 'N/A',
      },
    ]);

    const adapted = adaptContractRateScheduleFragments({
      document_id: 'goodlettsville-price-sheet',
      source_family: 'contract',
      tables: [priceSheetTable],
      schedule_kind: 'price_sheet',
    });
    const assembly = assembleCanonicalOperationalTableRows({
      document_id: 'goodlettsville-price-sheet',
      source_family: 'contract',
      fragments: adapted.fragments,
    });
    const canonicalRows = buildContractRateScheduleRows({
      rateTable: [],
      canonicalRateScheduleAssembly: assembly,
    });

    assert.deepEqual(canonicalRows.map((row) => row.description), [
      'Loading and Hauling Vegetative Debris',
      'Debris Mgmt. Site Management',
      'Reduction of Vegetative Debris',
      'Loading & Hauling to Final Disposal of Reduced Vegetative Debris',
      'Hazardous Limb (Hangers) Cutting (greater than 2" diameter)',
    ]);
    assert.deepEqual(canonicalRows.map((row) => row.unit), ['cy', 'cy', 'cy', 'cy', 'unit']);
    assert.deepEqual(canonicalRows.map((row) => row.rate), [27, 5, 9.24, 1, 135]);
    assert.ok(canonicalRows.every((row) => row.source_anchor_ids.length === 1));
  }, 120_000);
});
