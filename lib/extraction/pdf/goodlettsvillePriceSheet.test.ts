import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import { assembleContractPricingRows } from '@/lib/contracts/contractPricingAssembly';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { adaptContractRateScheduleFragments } from '@/lib/operationalTables/adapters/contractRateScheduleFragmentAdapter';
import { assembleCanonicalOperationalTableRows } from '@/lib/operationalTables/canonicalOperationalTableRowAssembler';
import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
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
        document_type: 'price_sheet',
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

    const expectedRows = [
      {
        description: 'Loading and Hauling Vegetative Debris',
        unit: 'Cubic Yard (CY)',
        rate: '$27.00',
        origin_destination: 'From Right of Way (ROW) to DMS',
        canonical_origin_destination: 'From Right of Way (ROW) to DMS',
        category: 'Vegetative Collect, Remove & Haul',
      },
      {
        description: 'Debris Mgmt. Site Management',
        unit: 'Cubic Yard (CY)',
        rate: '$5.00',
        origin_destination: 'N/A',
        canonical_origin_destination: null,
        category: 'Management & Reduction',
      },
      {
        description: 'Reduction of Vegetative Debris',
        unit: 'Cubic Yard (CY)',
        rate: '$9.24',
        origin_destination: 'N/A',
        canonical_origin_destination: null,
        category: 'Management & Reduction',
      },
      {
        description: 'Loading & Hauling to Final Disposal of Reduced Vegetative Debris',
        unit: 'Cubic Yard (CY)',
        rate: '$1.00',
        origin_destination: 'From DMS to Final Disposal',
        canonical_origin_destination: 'From DMS to Final Disposal',
        category: 'Final Disposal',
      },
      {
        description: 'Hazardous Limb (Hangers) Cutting (greater than 2" diameter)',
        unit: 'Unit',
        rate: '$135.00',
        origin_destination: 'N/A',
        canonical_origin_destination: null,
        category: 'Tree Operations',
      },
    ];
    assert.deepEqual(
      extractPriceSheetRows(priceSheetTable),
      expectedRows.map((row) => ({
        description: row.description,
        unit: row.unit,
        rate: row.rate,
        origin_destination: row.origin_destination,
      })),
    );

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
    assert.deepEqual(canonicalRows.map((row) => row.origin_destination), [
      'From Right of Way (ROW) to DMS',
      null,
      null,
      'From DMS to Final Disposal',
      null,
    ]);
    assert.equal(canonicalRows[1]?.origin_destination, null);
    assert.equal(canonicalRows[2]?.origin_destination, null);
    assert.equal(canonicalRows[4]?.origin_destination, null);
    assert.deepEqual(canonicalRows.map((row) => row.page), [2, 2, 2, 2, 2]);
    assert.ok(canonicalRows.every((row) => row.source_anchor_ids.length === 1));

    const assembledRows = assembleContractPricingRows(canonicalRows);
    assert.deepEqual(
      assembledRows.map((row) => ({
        category: row.category,
        unit: row.unit,
        rate: row.rate,
        page: row.page,
        sourceAnchorPresent: Boolean(row.sourceAnchor),
      })),
      expectedRows.map((row) => ({
        category: row.category,
        unit: row.unit === 'Unit' ? 'Unit' : 'Cubic Yard',
        rate: Number(row.rate.replace(/[$,]/g, '')),
        page: 2,
        sourceAnchorPresent: true,
      })),
    );

    const livePathResult = runDocumentPipeline({
      documentId: 'goodlettsville-price-sheet',
      documentType: 'price_sheet',
      documentName: 'goodlettsville_price_sheet.pdf',
      documentTitle: 'Goodlettsville Price Sheet',
      projectName: 'Goodlettsville',
      extractionData: payload as unknown as Record<string, unknown>,
      relatedDocs: [],
    });

    assert.deepEqual(
      livePathResult.contractAnalysis?.rate_schedule_rows?.map((row) => ({
        row_id: row.row_id,
        category: row.category,
        canonical_category: row.canonical_category,
        page: row.page,
        source_anchor_ids: row.source_anchor_ids,
      })),
      expectedRows.map((row, index) => ({
        row_id: `structural_table:pdf:table:p2:t3:r${index + 1}`,
        category: row.category,
        canonical_category:
          row.category === 'Vegetative Collect, Remove & Haul' ? 'vegetative_removal'
          : row.category === 'Management & Reduction' ? 'management_reduction'
          : row.category === 'Final Disposal' ? 'final_disposal'
          : 'tree_operations',
        page: 2,
        source_anchor_ids: [`pdf:table:p2:t3:r${index + 1}`, 'pdf:table:p2:t3'],
      })),
    );
  }, 120_000);
});
