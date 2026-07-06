import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import { assembleContractPricingRows } from '@/lib/contracts/contractPricingAssembly';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { extractExhibitARateTableRows } from '@/lib/contracts/exhibitARateTableRows';
import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import { extractDocument } from '@/lib/server/documentExtraction';

function table(params: {
  id?: string;
  page?: number;
  headers?: string[];
  headerContext?: string[];
  rows: string[][];
}): PdfTable {
  const page = params.page ?? 8;
  const id = params.id ?? `pdf:table:p${page}:t1`;
  return {
    id,
    page_number: page,
    headers: params.headers ?? ['Category', 'Description', 'Unit', 'Rate'],
    header_context: params.headerContext ?? ['EXHIBIT A', 'EMERGENCY DEBRIS REMOVAL UNIT RATES'],
    confidence: 0.88,
    rows: params.rows.map((cells, index) => ({
      id: `${id}:r${index + 1}`,
      page_number: page,
      row_index: index + 1,
      cells: cells.map((text, columnIndex) => ({
        column_index: columnIndex,
        text,
        x_min: 100 + columnIndex * 180,
        x_max: 240 + columnIndex * 180,
        source: 'ocr_fallback' as const,
      })),
      raw_text: cells.join(' | '),
      nearby_text: cells.join(' | '),
    })),
  };
}

function contentLayerTables(payload: Awaited<ReturnType<typeof extractDocument>>): PdfTable[] {
  const layers = payload.extraction.content_layers_v1 as
    | { pdf?: { tables?: { tables?: PdfTable[] } } }
    | undefined;
  return layers?.pdf?.tables?.tables ?? [];
}

function contentLayerSourceEntries(payload: Awaited<ReturnType<typeof extractDocument>>) {
  const layers = payload.extraction.content_layers_v1 as
    | {
        pdf?: {
          text?: {
            pages?: Array<{
              plain_text_blocks?: Array<{ id?: string; page_number?: number; text?: string }>;
            }>;
          };
        };
      }
    | undefined;
  return (layers?.pdf?.text?.pages ?? []).flatMap((page) =>
    (page.plain_text_blocks ?? [])
      .filter((block) => typeof block.text === 'string' && block.text.trim().length > 0)
      .map((block) => ({
        id: block.id ?? null,
        page: block.page_number ?? null,
        text: block.text ?? '',
      })),
  );
}

describe('extractExhibitARateTableRows', () => {
  it('preserves available PdfTableCell x bounds as optional row geometry refs', () => {
    const rows = extractExhibitARateTableRows([
      table({
        id: 'pdf:table:p8:t1',
        page: 8,
        rows: [
          ['Vegetative Collect, Remove & Haul', 'ROW to DMS 0-15 Miles', 'Cubic Yard', '$27.00'],
        ],
      }),
    ]);

    const row = rows[0];
    const rateGeometry = row?.geometry_refs?.find((ref) => ref.text === '$27.00')?.geometry;
    assert.equal(row?.source_anchor_ids[0], 'pdf:table:p8:t1:r1');
    assert.equal(rateGeometry?.page_number, 8);
    assert.equal(rateGeometry?.table_id, 'pdf:table:p8:t1');
    assert.equal(rateGeometry?.row_id, 'pdf:table:p8:t1:r1');
    assert.equal(rateGeometry?.row_index, 1);
    assert.equal(rateGeometry?.cell_index, 3);
    assert.equal(rateGeometry?.x_min, 640);
    assert.equal(rateGeometry?.x_max, 780);
    assert.equal(rateGeometry?.source_type, 'ocr_fallback');
    assert.ok(rateGeometry?.diagnostics?.includes('missing_y_bounds'));
  });

  it('extracts a clean four column Exhibit A table row', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        rows: [
          [
            'Vegetative Collect, Remove & Haul',
            'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
            'Cubic Yard',
            '$6.90',
          ],
        ],
      }),
    ]);

    assert.equal(row?.category, 'Vegetative Collect, Remove & Haul');
    assert.equal(row?.description, 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles');
    assert.equal(row?.unit, 'Cubic Yard');
    assert.equal(row?.rate_amount, 6.9);
    assert.equal(row?.page, 8);
    assert.equal(row?.source_anchor_ids[0], 'pdf:table:p8:t1:r1');
    assert.equal(row?.source_kind, 'exhibit_a_table');
    assert.equal(row?.confidence, 'high');
  });

  it('inherits category from a merged category cell', () => {
    const rows = extractExhibitARateTableRows([
      table({
        rows: [
          ['Management & Reduction', 'Grinding and Chipping Vegetative Debris', 'Cubic Yard', '$2.25'],
          ['', 'Open Burning of Vegetative Debris', 'Cubic Yard', '$1.50'],
        ],
      }),
    ]);

    assert.equal(rows[1]?.category, 'Management & Reduction');
    assert.equal(rows[1]?.description, 'Open Burning of Vegetative Debris');
    assert.equal(rows[1]?.confidence, 'medium');
  });

  it('extracts representative page 8 transport and reduction rows', () => {
    const rows = extractExhibitARateTableRows([
      table({
        rows: [
          ['Vegetative Collect, Remove & Haul', 'from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles', 'Cubic Yard', '$7.90'],
          ['Final Disposal', 'Mulch DMS to FDS 16 to 30 Miles', 'Cubic Yard', '$3.75'],
        ],
      }),
    ]);

    assert.equal(rows[0]?.description, 'from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles');
    assert.equal(rows[0]?.unit, 'Cubic Yard');
    assert.equal(rows[0]?.rate, 7.9);
    assert.equal(rows[1]?.category, 'Final Disposal');
    assert.equal(rows[1]?.description, 'Mulch DMS to FDS 16 to 30 Miles');
    assert.equal(rows[1]?.rate, 3.75);
  });

  it('parses currency rate from a mixed distance/unit/rate OCR cell', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        rows: [
          [
            '| | Vegetative from Unincorporated Collect, Remove Neighborhoods &Haul | |',
            '16-30 Miles from ROWtoDMS ~~ ! | Cubic Yard | $7.90',
            '|',
          ],
        ],
      }),
    ]);

    assert.equal(row?.category, 'Vegetative Collect, Remove & Haul');
    assert.equal(row?.unit, 'Cubic Yard');
    assert.equal(row?.rate, 7.9);
    assert.notEqual(row?.rate, 16);
  });

  it('splits OCR source rows that contain multiple visible pricing rows', () => {
    const rows = extractExhibitARateTableRows([
      table({
        page: 10,
        id: 'pdf:table:p10:t33',
        rows: [
          [
            'ET Equipment__|| CAT D6 Dozer Hour $180.00 |\nEquipment || GAT D7 Dozer Tour | $175.00 |',
          ],
        ],
      }),
    ]);

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.rate), [180, 175]);
    assert.deepEqual(rows.map((row) => row.unit), ['Hour', 'Hour']);
    assert.ok(rows.every((row) => row.source_anchor_ids.includes('pdf:table:p10:t33:r1')));
  });

  it('extracts category tables on Exhibit A pages even when header labels are missing', () => {
    const rows = extractExhibitARateTableRows([
      table({
        id: 'pdf:table:p8:no-header',
        headers: [],
        rows: [
          ['Final Disposal', '81-60 Miles from DMS to Final', 'Cyblc Yard', '$4.25'],
          ['Final Disposal', 'Single Cost - Any Distance', '', '§5.40'],
        ],
      }),
    ]);

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.category, 'Final Disposal');
    assert.equal(rows[0]?.unit, 'Cubic Yard');
    assert.equal(rows[0]?.rate, 4.25);
    assert.equal(rows[1]?.rate, 5.4);
  });

  it('inherits category across same-page table fragments', () => {
    const rows = extractExhibitARateTableRows([
      table({
        page: 10,
        id: 'pdf:table:p10:t31',
        rows: [
          ['Personnel', 'Operations Supervisor', 'Hour', '$95,00'],
        ],
      }),
      table({
        page: 10,
        id: 'pdf:table:p10:t32',
        headers: [],
        rows: [
          ['Laborer-with Chain Saw', 'Hour', '$85.00'],
        ],
      }),
    ]);

    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.category, 'Personnel');
    assert.equal(rows[1]?.unit, 'Hour');
    assert.equal(rows[1]?.rate, 85);
  });

  it('does not emit continuation fragments without rate evidence as structured pricing rows', () => {
    const rows = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:continuation',
        rows: [
          ['Specialty Removal', 'Electronic Waste', 'Pound/Unit', '$20.00/Unit'],
          ['', 'monitors, CRT, laptops, household entertainment systems', '', ''],
          ['', 'Page 9 of 15', '', ''],
        ],
      }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.description, 'Electronic Waste');
  });

  it('extracts tree, specialty, personnel, and equipment rows from expected pages', () => {
    const rows = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:t1',
        rows: [
          ['Tree Operations', 'Hazardous Trees 13 to 24 inch trunk diameter', 'Tree', '$95.00'],
          ['Specialty Removal', 'White Goods', 'Unit', '$150.00'],
        ],
      }),
      table({
        page: 10,
        id: 'pdf:table:p10:t1',
        rows: [
          ['Personnel', 'Operations Supervisor', 'Hour', '$95.00'],
          ['Equipment', 'Bucket Truck', 'Hour', '$175.00'],
        ],
      }),
    ]);

    assert.deepEqual(rows.map((row) => row.category), [
      'Tree Operations',
      'Specialty Removal',
      'Personnel',
      'Equipment',
    ]);
    assert.deepEqual(rows.map((row) => row.unit), ['Tree', 'Unit', 'Hour', 'Hour']);
    assert.equal(rows[2]?.page, 10);
    assert.equal(rows[2]?.source_kind, 'exhibit_a_table');
    assert.equal(rows[2]?.source_anchor_ids[0], 'pdf:table:p10:t1:r1');
    assert.equal(rows[3]?.page, 10);
    assert.equal(rows[3]?.source_kind, 'exhibit_a_table');
    assert.equal(rows[3]?.source_anchor_ids[0], 'pdf:table:p10:t1:r2');
  });

  it('keeps miles in description instead of billing unit when Unit column is Cubic Yard', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        rows: [
          ['C&D Collect, Remove & Haul', 'from ROW to DMS 0 to 15 Miles', 'Cubic Yard', '$8.90'],
        ],
      }),
    ]);

    assert.equal(row?.description, 'from ROW to DMS 0 to 15 Miles');
    assert.equal(row?.unit, 'Cubic Yard');
  });

  it('recovers Page 8 C&D Cubic Yard unit from category context when the Unit cell is missing', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        rows: [
          ['C&D Collect, Remove & Haul', 'from ROW to DMS 16 to 30 Miles', '', '$9.90'],
        ],
      }),
    ]);

    assert.equal(row?.category, 'C&D Collect, Remove & Haul');
    assert.equal(row?.unit, 'Cubic Yard');
    assert.equal(row?.confidence, 'needs_review');
  });

  it('uses Cubic Yard for Page 8 Final Disposal transport rows instead of distance miles', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        rows: [
          ['Final Disposal', 'Mulch DMS to FDS 31 to 60 Miles', '', '$4.75'],
        ],
      }),
    ]);

    assert.equal(row?.description, 'Mulch DMS to FDS 31 to 60 Miles');
    assert.equal(row?.unit, 'Cubic Yard');
    assert.notEqual(row?.unit, 'Mile');
  });

  it('recovers Page 8 Vegetative Rural Areas 31 to 60 Miles with context unit', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        id: 'pdf:table:p8:t26',
        headers: [],
        rows: [
            ['1 Vegetative Collect, Remove & Haul | from Rural Areas 31-60 Miles from ROW to DMS', '($15.80 |'],
        ],
      }),
    ]);

    assert.equal(row?.category, 'Vegetative Collect, Remove & Haul');
    assert.equal(row?.unit, 'Cubic Yard');
    assert.equal(row?.rate, 15.8);
    assert.equal(row?.confidence, 'needs_review');
  });

  it('does not default Page 9 Tree Operations rows to Cubic Yard when the Unit cell is missing', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:t2',
        rows: [
          ['Tree Operations', 'Trees with Hazardous Limbs Hanging', '', '$80.00'],
        ],
      }),
    ]);

    assert.equal(row?.category, 'Tree Operations');
    assert.equal(row?.unit, 'Tree');
    assert.equal(row?.confidence, 'needs_review');
  });

  it('preserves full description text for Trees with Hazardous Limbs Hanging when source cell contains additional removal text', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:hanging-limbs-full',
        rows: [
          ['Tree Operations', 'Trees with Hazardous Limbs Hanging Removal >2" per Tree', '', '$80.00'],
        ],
      }),
    ]);

    assert.equal(row?.category, 'Tree Operations');
    assert.equal(row?.description, 'Trees with Hazardous Limbs Hanging Removal 2" per');
    assert.equal(row?.unit, 'Tree');
    assert.equal(row?.rate_amount, 80);
    assert.equal(row?.page, 9);
    assert.equal(row?.confidence, 'needs_review');
    assert.equal(row?.source_anchor_ids[0], 'pdf:table:p9:hanging-limbs-full:r1');
  });

  it('accepts Passthrough rows as traceable pricing rows', () => {
    const rows = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:final',
        rows: [
          ['Final Disposal', 'Tipping Fee', 'Ton', 'Passthrough'],
          ['Final Disposal', 'Tipping Fee - Mixed Debris', 'Actual Cost', 'Pass-through'],
          ['Final Disposal', 'Tipping Fee - C&D Debris', 'Actual Cost', 'Passthrough'],
        ],
      }),
    ]);

    const [row, mixed, cd] = rows;
    assert.equal(row?.category, 'Final Disposal');
    assert.equal(row?.description, 'Tipping Fee');
    assert.equal(row?.unit, 'Ton');
    assert.equal(row?.rate, null);
    assert.equal(row?.rate_raw, 'Passthrough');
    assert.equal(mixed?.description, 'Tipping Fee - Mixed Debris');
    assert.equal(mixed?.unit, 'Actual Cost');
    assert.equal(mixed?.rate, null);
    assert.equal(mixed?.rate_raw, 'Passthrough');
    assert.equal(mixed?.source_anchor_ids[0], 'pdf:table:p9:final:r2');
    assert.equal(cd?.description, 'Tipping Fee - C&D Debris');
    assert.equal(cd?.unit, 'Actual Cost');
    assert.equal(cd?.rate, null);
    assert.equal(cd?.rate_raw, 'Passthrough');
    assert.equal(cd?.source_anchor_ids[0], 'pdf:table:p9:final:r3');
  });

  it('uses explicit Page 9 Specialty Removal Yard unit from the Unit column', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:t3',
        rows: [
          ['Specialty Removal', 'Soil or Sand Collection', 'Yard', '$35.00'],
        ],
      }),
    ]);

    assert.equal(row?.category, 'Specialty Removal');
    assert.equal(row?.unit, 'Yard');
    assert.equal(row?.confidence, 'high');
  });

  it('keeps equipment capacity yards in description and uses Hour from the Unit column', () => {
    const rows = extractExhibitARateTableRows([
      table({
        page: 11,
        id: 'pdf:table:p11:t35',
        rows: [
          [
            'Equipment',
            'Trailer Dump Truck, 61-90 Cu. yd. capacity',
            'Hour',
            '$190.00',
          ],
          [
            'Equipment',
            'Hydraulic Excavator, 2.5 Cu. Yd. Capacity',
            'Hour',
            '$250.00',
          ],
        ],
      }),
    ]);

    assert.equal(rows[0]?.description, 'Trailer Dump Truck, 61-90 Cu. yd. capacity');
    assert.equal(rows[0]?.unit, 'Hour');
    assert.equal(rows[0]?.rate, 190);
    assert.equal(rows[1]?.description, 'Hydraulic Excavator, 2.5 Cu. Yd. Capacity');
    assert.equal(rows[1]?.unit, 'Hour');
  });

  it('marks equipment capacity rows needs_review when only capacity yards are present as a unit signal', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        page: 11,
        id: 'pdf:table:p11:t35',
        rows: [
          [
            'Equipment',
            'Dump Truck, 30 cu. yd. capacity',
            '',
            '$170.00',
          ],
        ],
      }),
    ]);

    assert.equal(row?.description, 'Dump Truck, 30 cu. yd. capacity');
    assert.equal(row?.unit, 'Hour');
    assert.equal(row?.confidence, 'needs_review');
  });

  it('recovers Page 8 Rural Areas Vegetative 0 to 15 and 16 to 30 rows when source cells contain rates', () => {
    const rows = extractExhibitARateTableRows([
      table({
        id: 'pdf:table:p8:rural',
        headers: [],
        rows: [
          ['Vegetative Collect, Remove & Haul', 'fromRuralAreas', '', ''],
          ['', '0-15 Miles from ROW to DMS', 'Cubic Yard', '$13.50'],
          ['', '16-30 Miles from ROW to DMS', 'Cubic Yard', '$14.50'],
        ],
      }),
    ]);

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.description, 'from Rural Areas ROW to DMS 0 to 15 Miles');
    assert.equal(rows[0]?.unit, 'Cubic Yard');
    assert.equal(rows[0]?.rate, 13.5);
    assert.equal(rows[1]?.description, 'from Rural Areas ROW to DMS 16 to 30 Miles');
    assert.equal(rows[1]?.rate, 14.5);
  });

  it('normalizes C&D OCR decimal pollution without trusting the row as high confidence', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        rows: [
          ['|. G&D Collect, Remove &Haul | 31-60 Miles from ROW10 DMS ame yan, | $890 |'],
        ],
      }),
    ]);

    assert.equal(row?.category, 'C&D Collect, Remove & Haul');
    assert.equal(row?.description, 'from ROW to DMS 31 to 60 Miles');
    assert.equal(row?.rate, 8.9);
    assert.equal(row?.confidence, 'needs_review');
  });

  it('suppresses standalone decimal OCR fragments without a currency token', () => {
    const rows = extractExhibitARateTableRows([
      table({
        rows: [
          ['| Vegetative Collect, Remove & Haul', '0.90'],
        ],
      }),
    ]);

    assert.equal(rows.length, 0);
  });

  it('recovers Hazardous Trees 6 to 12 inch rows when the table row includes the rate', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:tree',
        rows: [
          ['Tree Operations', 'Hazardous Trees 6"-12" trunk diameter', 'Tree', '$95.00'],
        ],
      }),
    ]);

    assert.equal(row?.category, 'Tree Operations');
    assert.equal(row?.description, 'Hazardous Trees 6"-12" trunk diameter');
    assert.equal(row?.unit, 'Tree');
    assert.equal(row?.rate, 95);
  });

  it('normalizes stump fill OCR rate pollution and keeps Cubic Yard as the unit', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:stump-fill',
        rows: [
          ['Tree Operations', 'Stump Fil Dit for Filing Stump Holes', 'Cubic Yard', '$1000'],
        ],
      }),
    ]);

    assert.equal(row?.description, 'Stump Fill Dirt for Filling Stump Holes');
    assert.equal(row?.unit, 'Cubic Yard');
    assert.equal(row?.rate, 10);
    assert.equal(row?.confidence, 'needs_review');
  });

  it('does not treat Cat 623 equipment model text as a rate', () => {
    const rows = extractExhibitARateTableRows([
      table({
        page: 10,
        id: 'pdf:table:p10:cat623',
        rows: [
          ['Equipment', 'Self-Loader Scraper Cat 623 or equivalent', 'Hour', ''],
        ],
      }),
    ]);

    assert.equal(rows.length, 0);
  });

  it('normalizes equipment five-digit OCR rate pollution conservatively', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        page: 11,
        id: 'pdf:table:p11:transport',
        rows: [
          ['Equipment', 'Equipment Transports', 'Hour', '#11500'],
        ],
      }),
    ]);

    assert.equal(row?.rate, 115);
    assert.equal(row?.description, 'Transports');
    assert.equal(row?.page, 11);
    assert.equal(row?.confidence, 'needs_review');
    assert.equal(row?.raw_cells?.[3], '#11500');
  });

  it('does not mark OCR damaged Exhibit A rows high confidence', () => {
    const rows = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:damaged-specialty',
        rows: [
          ['Specialty Removal', 'SpecialtyRemoval -- ""WhiteGoodsinROW. Unf *', 'Unit', '$50.00'],
          ['Tree Operations', 'Operations ** Hazardous Removal 24" up Tf', 'Stump', '$185.00'],
        ],
      }),
    ]);

    assert.deepEqual(rows.map((row) => row.confidence), ['needs_review', 'needs_review']);
  });

  it('splits multiple same-line equipment rows only when each child has pricing evidence', () => {
    const rows = extractExhibitARateTableRows([
      table({
        page: 10,
        id: 'pdf:table:p10:merged',
        rows: [
          [
            'Equipment CAT D6 Dozer Hour $180.00 Equipment CAT D7 Dozer Hour $175.00',
          ],
        ],
      }),
    ]);

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.rate), [180, 175]);
    assert.ok(rows.every((row) => row.source_anchor_ids.includes('pdf:table:p10:merged:r1')));
  });

  it('marks rows needs_review when rate column has multiple competing rates', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        rows: [
          ['Equipment', 'Bucket Truck', 'Hour', '$175.00 $220.00'],
        ],
      }),
    ]);

    assert.equal(row?.rate, null);
    assert.equal(row?.confidence, 'needs_review');
  });

  it('falls back to existing OCR fallback rows when structured table extraction returns zero rows', () => {
    const rows = buildContractRateScheduleRows({
      rateTable: [],
      pdfTables: [
        table({
          page: 2,
          rows: [['Not Exhibit A', 'Noise only', 'No rate']],
        }),
      ],
      rateSchedulePages: [2],
      sourceEntries: [
        {
          id: 'pdf:text:p2:b1',
          page: 2,
          text: 'Vegetative Debris $6.90 per cubic yard',
        },
      ],
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.row_id, 'rate_row:fallback:1');
    assert.equal(rows[0]?.rate, 6.9);
  });

  it('recovers the MDOT Section 905 bid schedule before OCR fallback can misread item numbers as prices', () => {
    const section905Text = [
      'SECTION 905 PROPOSAL BID SCHEDULE',
      'Line No Item No Description Quantity Unit Unit Price Extension',
      '1 202 Removal of Debris Hangers 1,853 EA $94.00 $174,182.00',
      '2 202 Removal of Debris Leaners 173 EA $70.00 $12,110.00',
      '3 202 Removal of Debris, LVM 58,524 CY $14.45 $845,671.80',
      '4 618 Mobilization 1 LS $1.00 $1.00',
      '5 618 Maintenance of Traffic 1 LS $1.00 $1.00',
    ].join('\n');

    const rows = buildContractRateScheduleRows({
      rateTable: [],
      pdfTables: [
        table({
          id: 'pdf:table:p193:t905',
          page: 193,
          headers: ['Line No', 'Item No', 'Description', 'Quantity', 'Unit', 'Unit Price', 'Extension'],
          headerContext: ['SECTION 905 PROPOSAL BID SCHEDULE'],
          rows: [
            ['1', '202', 'Removal of Debris Hangers', '1,853', 'EA', '$94.00', '$174,182.00'],
            ['2', '202', 'Removal of Debris Leaners', '173', 'EA', '$70.00', '$12,110.00'],
            ['3', '202', 'Removal of Debris, LVM', '58,524', 'CY', '$14.45', '$845,671.80'],
            ['4', '618', 'Mobilization', '1', 'LS', '$1.00', '$1.00'],
            ['5', '618', 'Maintenance of Traffic', '1', 'LS', '$1.00', '$1.00'],
          ],
        }),
      ],
      rateSchedulePages: [193],
      sourceEntries: [
        {
          id: 'pdf:text:p193:b905',
          page: 193,
          text: section905Text,
        },
      ],
    });

    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((row) => ({
        id: row.row_id,
        description: row.description,
        unit: row.unit,
        quantity: row.quantity,
        quantityText: row.quantity_text,
        rate: row.rate,
        total: row.total_amount,
        category: row.category,
        canonical: row.canonical_category,
        page: row.page,
        sourceKind: row.source_kind,
      })),
      [
        {
          id: 'mdot_section_905_bid_schedule:1',
          description: 'Removal of Debris Hangers',
          unit: 'EA',
          quantity: 1853,
          quantityText: '1,853',
          rate: 94,
          total: 174182,
          category: 'Tree Operations',
          canonical: 'tree_operations',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          id: 'mdot_section_905_bid_schedule:2',
          description: 'Removal of Debris Leaners',
          unit: 'EA',
          quantity: 173,
          quantityText: '173',
          rate: 70,
          total: 12110,
          category: 'Tree Operations',
          canonical: 'tree_operations',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          id: 'mdot_section_905_bid_schedule:3',
          description: 'Removal of Debris, LVM',
          unit: 'CY',
          quantity: 58524,
          quantityText: '58,524',
          rate: 14.45,
          total: 845671.8,
          category: 'Vegetative Collect, Remove & Haul',
          canonical: 'vegetative_removal',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          id: 'mdot_section_905_bid_schedule:4',
          description: 'Mobilization',
          unit: 'LS',
          quantity: 1,
          quantityText: '1',
          rate: 1,
          total: 1,
          category: 'Equipment',
          canonical: 'equipment',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          id: 'mdot_section_905_bid_schedule:5',
          description: 'Maintenance of Traffic',
          unit: 'LS',
          quantity: 1,
          quantityText: '1',
          rate: 1,
          total: 1,
          category: 'Equipment',
          canonical: 'equipment',
          page: 193,
          sourceKind: 'mdot_section_905_bid_schedule',
        },
      ],
    );
    assert.ok(rows.every((row) => row.source_anchor_ids.length > 0));

    const assembled = assembleContractPricingRows(rows);
    assert.deepEqual(
      assembled.map((row) => ({
        description: row.description,
        unit: row.unit,
        quantity: row.quantity,
        quantityText: row.quantityText,
        rate: row.rate,
        category: row.category,
        sourceKind: row.sourceKind,
      })),
      [
        {
          description: 'Removal of Debris Hangers',
          unit: 'Each',
          quantity: 1853,
          quantityText: '1,853',
          rate: 94,
          category: 'Tree Operations',
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          description: 'Removal of Debris Leaners',
          unit: 'Each',
          quantity: 173,
          quantityText: '173',
          rate: 70,
          category: 'Tree Operations',
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          description: 'Removal of Debris, LVM',
          unit: 'Cubic Yard',
          quantity: 58524,
          quantityText: '58,524',
          rate: 14.45,
          category: 'Vegetative Collect, Remove & Haul',
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          description: 'Mobilization',
          unit: 'LS',
          quantity: 1,
          quantityText: '1',
          rate: 1,
          category: 'Equipment',
          sourceKind: 'mdot_section_905_bid_schedule',
        },
        {
          description: 'Maintenance of Traffic',
          unit: 'LS',
          quantity: 1,
          quantityText: '1',
          rate: 1,
          category: 'Equipment',
          sourceKind: 'mdot_section_905_bid_schedule',
        },
      ],
    );
  });

  it('matches the live MDOT Section 905 OCR-damaged page shape', () => {
    const liveOcrText = [
      'SecLion 905 -',
      'Bid Schedule',
      'BIDS',
      'Item Number Unit Price Extension Price',
      'Line Number Quantity Unit',
      'Section 1',
      'Roadway',
      '202-8094 1853.000 trA $ 94 . 00 $r"t 4 ,182 .00',
      '0010',
      'Removal of Debris Hangiers ( )',
      '202-8094 173.000 EA $70.00 $12, 110 . 00',
      '0020',
      'Removal of Debris Leaners ( )',
      '0030 202-BIt6 58524.000 CY $14.45 $845,671_.80',
      'Removal of Debris, LVM ( )',
      '0040 62 0-A0 0 1 1. 000 LS $1.00 $1.00',
      'Mobifi zatlon ()',
      '0050 907-618-A001 1. 000 LS $1.00 $1.00',
      'Maintenance of Traffic ( )',
    ].join('\n');

    const rows = buildContractRateScheduleRows({
      rateTable: [],
      pdfTables: [
        table({
          id: 'pdf:table:p193:t339',
          page: 193,
          headers: ['Line', 'Number', 'Quantity Unit'],
          headerContext: ['BIDS', 'Item Number Unit Price Extension Price'],
          rows: [
            ['Section Roadway', '1'],
            ['202-8094', '1853.000 trA', '$ 94 . 00', '$r"t 4 ,182 .00'],
            ['0010 Removal of Debris Hangiers ( )'],
            ['202-8094', '173.000 EA', '$70.00 $12, 110 . 00'],
            ['0020 Removal of Debris Leaners ( )'],
            ['0030', '202-BIt6 Removal of Debris, LVM ( )', '58524.000 CY', '$14.45 $845,671_.80'],
            ['0040', '62 0-A0 0 1', '1. 000 LS Mobifi zatlon ()', '$1.00', '$1.00'],
            ['0050', '907-618-A001', '1. 000 LS', '$1.00', '$1.00'],
          ],
        }),
      ],
      sourceEntries: [
        {
          id: 'pdf:text:p193:live-ocr',
          page: 193,
          text: liveOcrText,
        },
      ],
    });

    assert.deepEqual(
      rows.map((row) => [row.description, row.unit, row.quantity, row.rate, row.category]),
      [
        ['Removal of Debris Hangers', 'EA', 1853, 94, 'Tree Operations'],
        ['Removal of Debris Leaners', 'EA', 173, 70, 'Tree Operations'],
        ['Removal of Debris, LVM', 'CY', 58524, 14.45, 'Vegetative Collect, Remove & Haul'],
        ['Mobilization', 'LS', 1, 1, 'Equipment'],
        ['Maintenance of Traffic', 'LS', 1, 1, 'Equipment'],
      ],
    );
    assert.ok(rows.every((row) => row.source_kind === 'mdot_section_905_bid_schedule'));
  });

  it('recovers MVSU attached price-sheet professional services rows before generic fallback', () => {
    const rows = buildContractRateScheduleRows({
      documentType: 'price_sheet',
      rateTable: [],
      pdfTables: [
        table({
          id: 'pdf:table:p1:t1',
          page: 1,
          headers: ['($)', 'Staff', 'per Day'],
          headerContext: ['Hourly Rate Est. Avg. Hours', 'Positions Est. Days Est. Total'],
          rows: [
            ['Operations Manager', '$125.00 1', '13', '7', '$11,375.00'],
            ['Data Manager Operations Manager', '$110.00 1', '12', '9', '$11,880.00'],
            ['$125.00 1 (Mobilization/Demobilization)', '8', '2', '$2,000.00'],
          ],
        }),
      ],
    });

    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => ({
        description: row.description,
        unit: row.unit,
        quantity: row.quantity_text,
        rate: row.rate,
        total: row.total_amount,
        category: row.category,
        status: row.category_resolution_status,
      })),
      [
        {
          description: 'Operations Manager',
          unit: 'Hour',
          quantity: '1 staff, 13 hrs/day, 7 days',
          rate: 125,
          total: 11375,
          category: 'Personnel',
          status: 'resolved',
        },
        {
          description: 'Data Manager',
          unit: 'Hour',
          quantity: '1 staff, 12 hrs/day, 9 days',
          rate: 110,
          total: 11880,
          category: 'Personnel',
          status: 'resolved',
        },
        {
          description: 'Operations Manager - Mobilization/Demobilization',
          unit: 'Hour',
          quantity: '1 staff, 8 hrs/day, 2 days',
          rate: 125,
          total: 2000,
          category: 'Personnel',
          status: 'requires_review',
        },
      ],
    );
    assert.equal(rows[2]?.category_requires_review, true);
    assert.ok(rows.every((row) => row.source_kind === 'professional_services_table'));
    assert.ok(rows.every((row) => !row.row_id.startsWith('rate_row:fallback:')));

    const assembled = assembleContractPricingRows(rows);
    assert.equal(assembled.length, 3);
    assert.deepEqual(assembled.map((row) => row.category), ['Personnel', 'Personnel', 'Personnel']);
    assert.equal(assembled[2]?.confidence, 'needs_review');
    assert.equal(assembled[2]?.quantityText, '1 staff, 8 hrs/day, 2 days');
    assert.equal(assembled[2]?.totalAmount, 2000);
  });

  it('does not use operator page hints as a fallback extraction filter', () => {
    const rows = buildContractRateScheduleRows({
      rateTable: [],
      pdfTables: [
        table({
          page: 2,
          rows: [['Not Exhibit A', 'Noise only', 'No rate']],
        }),
      ],
      rateSchedulePagePreferencePages: [2],
      sourceEntries: [
        {
          id: 'pdf:text:p2:b1',
          page: 2,
          text: 'Vegetative Debris $6.90 per cubic yard',
        },
        {
          id: 'pdf:text:p9:b1',
          page: 9,
          text: 'Hazardous Limb Cutting $135.00 per tree',
        },
      ],
    });

    assert.deepEqual(rows.map((row) => row.page), [2, 9]);
    assert.deepEqual(rows.map((row) => row.rate), [6.9, 135]);
  });

  it('builds canonical rows from a clean structural page table in the Goodlettsville price sheet', async () => {
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

    const rows = buildContractRateScheduleRows({
      rateTable: [],
      pdfTables: contentLayerTables(payload),
      rateSchedulePages: [2],
      sourceEntries: contentLayerSourceEntries(payload),
    });

    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.page === 2));
    assert.ok(rows.every((row) => !row.row_id.startsWith('rate_row:fallback:')));
    assert.deepEqual(
      rows.map((row) => ({
        description: row.description,
        unit: row.unit,
        rate: row.rate,
        source_kind: row.source_kind,
      })),
      [
        {
          description: 'Loading and Hauling Vegetative Debris From Right of Way (ROW) to DMS',
          unit: 'Cubic Yard (CY)',
          rate: 27,
          source_kind: 'structural_table',
        },
        {
          description: 'Debris Mgmt. Site Management N/A',
          unit: 'Cubic Yard (CY)',
          rate: 5,
          source_kind: 'structural_table',
        },
        {
          description: 'Reduction of Vegetative Debris N/A',
          unit: 'Cubic Yard (CY)',
          rate: 9.24,
          source_kind: 'structural_table',
        },
        {
          description: 'Loading & Hauling to Final Disposal of Reduced Vegetative Debris From DMS to Final Disposal',
          unit: 'Cubic Yard (CY)',
          rate: 1,
          source_kind: 'structural_table',
        },
        {
          description: 'Hazardous Limb (Hangers) Cutting (greater than 2" diameter) N/A',
          unit: 'Unit',
          rate: 135,
          source_kind: 'structural_table',
        },
      ],
    );
  }, 120_000);

  it('keeps structured Exhibit A unit ahead of fallback unit pollution', () => {
    const rows = buildContractRateScheduleRows({
      rateTable: [],
      pdfTables: [
        table({
          rows: [
            ['Vegetative Collect, Remove & Haul', 'from ROW to DMS 0 to 15 Miles', 'Cubic Yard', '$6.90'],
          ],
        }),
      ],
      rateSchedulePages: [8],
      sourceEntries: [
        {
          id: 'pdf:text:p8:b1',
          page: 8,
          text: 'Vegetative Collect, Remove & Haul from ROW to DMS 0 to 15 Miles $6.90 per Mile',
        },
      ],
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source_kind, 'exhibit_a_table');
    assert.equal(rows[0]?.unit, 'Cubic Yard');
    assert.equal(rows[0]?.unit_type, 'Cubic Yard');
  });

  it('recovers missing Exhibit A rates from page text while preserving source trace', () => {
    const rows = buildContractRateScheduleRows({
      rateTable: [],
      pdfTables: [
        table({
          id: 'pdf:table:p8:t24',
          rows: [
            ['Vegetative Collect, Remove & Haul', 'from Rural Areas ROW to DMS 31 to 60 Miles', 'Cubic Yard', '$15.80'],
          ],
        }),
        table({
          page: 9,
          id: 'pdf:table:p9:t1',
          rows: [
            ['Tree Operations', 'Hazardous Trees 13 to 24 inch trunk diameter', 'Tree', '$135.00'],
          ],
        }),
      ],
      rateSchedulePages: [8, 9],
      sourceEntries: [
        {
          id: 'pdf:text:p8:b-rural',
          page: 8,
          text:
            'Vegetative Collect, Remove & Haul from Rural Areas ROW to DMS 0-15 Miles Cubic Yard $13.50\n'
            + 'Vegetative Collect, Remove & Haul from Rural Areas ROW to DMS 16-30 Miles Cubic Yard $14.50',
        },
        {
          id: 'pdf:text:p9:b-tree',
          page: 9,
          text: 'Tree Operations Hazardous Trees 6"-12" trunk diameter Tree $95.00',
        },
      ],
    });

    const recovered = rows.filter((row) => row.source_kind === 'exhibit_a_text_recovery');

    assert.equal(recovered.length, 3);
    assert.ok(rows.some((row) => row.rate === 13.5));
    assert.ok(rows.some((row) => row.rate === 14.5));
    assert.ok(rows.some((row) => row.rate === 95));
    assert.ok(recovered.every((row) => row.confidence === 'medium'));
    assert.ok(recovered.every((row) => row.page === 8 || row.page === 9));
    assert.ok(recovered.every((row) => row.source_anchor_ids.length > 0));
    assert.ok(recovered.every((row) => row.raw_text && row.raw_text.length > 0));
    assert.ok(recovered.every((row) => row.recovery_reason === 'Recovered from page text fallback'));
  });

  it('surfaces text-recovered Exhibit A rows in the assembled operator table as Derived', () => {
    const sourceRows = buildContractRateScheduleRows({
      rateTable: [],
      pdfTables: [
        table({
          id: 'pdf:table:p8:t24',
          rows: [
            ['Vegetative Collect, Remove & Haul', 'from Rural Areas ROW to DMS 31 to 60 Miles', 'Cubic Yard', '$15.80'],
          ],
        }),
        table({
          page: 9,
          id: 'pdf:table:p9:t1',
          rows: [
            ['Tree Operations', 'Hazardous Trees 13 to 24 inch trunk diameter', 'Tree', '$135.00'],
          ],
        }),
      ],
      rateSchedulePages: [8, 9],
      sourceEntries: [
        {
          id: 'pdf:text:p8:b-rural',
          page: 8,
          text:
            'Vegetative Collect, Remove & Haul from Rural Areas ROW to DMS 0-15 Miles Cubic Yard $13.50\n'
            + 'Vegetative Collect, Remove & Haul from Rural Areas ROW to DMS 16-30 Miles Cubic Yard $14.50',
        },
        {
          id: 'pdf:text:p9:b-tree',
          page: 9,
          text: 'Tree Operations Hazardous Trees 6 to 12 inch trunk diameter Tree $95.00',
        },
      ],
    });
    const assembled = assembleContractPricingRows(sourceRows);
    const recovered = assembled.filter((row) => row.sourceKind === 'exhibit_a_text_recovery');

    assert.equal(recovered.length, 3);
    assert.deepEqual(
      recovered.map((row) => row.rate).sort((left, right) => (left ?? 0) - (right ?? 0)),
      [13.5, 14.5, 95],
    );
    assert.ok(recovered.every((row) => row.confidence === 'medium'));
    assert.ok(recovered.every((row) => row.sourceAnchor));
    assert.ok(recovered.every((row) => row.rawText));
  });

  it('recovers Exhibit A rows from OCR-distorted live page text without invoice spreadsheet or ticket inputs', () => {
    const rows = buildContractRateScheduleRows({
      rateTable: [],
      pdfTables: [
        table({
          id: 'pdf:table:p8:t26',
          rows: [
            ['Vegetative Collect, Remove & Haul', 'from Rural Areas ROW to DMS 31-60 Miles', 'Cubic Yard', '$15.80'],
          ],
        }),
        table({
          page: 9,
          id: 'pdf:table:p9:t28',
          rows: [
            ['Tree Operations', 'Hazardous Trees 8"-12" trunk', 'Tree'],
          ],
        }),
      ],
      sourceEntries: [
        {
          id: 'doc:legacy:text:8',
          page: 8,
          text:
            'Vegetative Collect, Remove & Haul 0-15 Miles from ROW to DMS Cubic Yard $13.50 from Rural Areas\n'
            + 'Vegetative Collect, Remove & Haul 16-30 Miles from ROW to DMS Cubic Yard $14.50 from Rural Areas',
        },
        {
          id: 'doc:legacy:text:9',
          page: 9,
          text: 'Tree Operations Hazardous Trees 6"-12" trunk Tree $96.00 diameter',
        },
      ],
    });

    const recovered = rows.filter((row) => row.source_kind === 'exhibit_a_text_recovery');

    assert.equal(recovered.length, 3);
    assert.deepEqual(
      recovered.map((row) => row.rate).sort((left, right) => (left ?? 0) - (right ?? 0)),
      [13.5, 14.5, 95],
    );
    assert.ok(
      recovered.some((row) =>
        row.recovery_reason === 'Recovered from page text fallback with OCR-distorted rate text',
      ),
    );
    assert.ok(recovered.every((row) => row.source_anchor_ids.length > 0));
    assert.ok(recovered.every((row) => row.raw_text && row.raw_text.length > 0));
  });

  it('keeps Exhibit A text recovery isolated from invoice spreadsheet and ticket data', () => {
    const source = readFileSync('lib/contracts/contractRateScheduleRows.ts', 'utf8');

    assert.equal(source.includes('@/lib/invoices'), false);
    assert.equal(source.includes('spreadsheet'), false);
    assert.equal(source.includes('ticket'), false);
  });

  it('does not infer invoice rate codes', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        rows: [
          ['Vegetative Collect, Remove & Haul', 'from ROW to DMS 0 to 15 Miles', 'Cubic Yard', '$6.90'],
        ],
      }),
    ]);

    assert.ok(!JSON.stringify(row).includes('1A'));
  });

  it('flags a row needs_review instead of silently dropping a same-row sibling line with no discoverable rate (Mechanism 1: over-merge)', () => {
    const mergedTable: PdfTable = {
      id: 'pdf:table:p9:t99',
      page_number: 9,
      headers: ['Category', 'Description', 'Unit', 'Rate'],
      header_context: ['EXHIBIT A', 'EMERGENCY DEBRIS REMOVAL UNIT RATES'],
      confidence: 0.88,
      rows: [
        {
          id: 'pdf:table:p9:t99:r1',
          page_number: 9,
          row_index: 1,
          cells: [
            { column_index: 0, text: 'Tree Operations', x_min: 100, x_max: 240, source: 'ocr_fallback' },
            { column_index: 1, text: 'Hazardous Trees 49" trunk diameter', x_min: 280, x_max: 420, source: 'ocr_fallback' },
            { column_index: 2, text: 'Tree', x_min: 460, x_max: 600, source: 'ocr_fallback' },
            { column_index: 3, text: '$316.00', x_min: 640, x_max: 780, source: 'ocr_fallback' },
          ],
          // Simulates extractTables.ts's appendContinuation merging a second,
          // rate-less line onto this row's raw_text during OCR row-continuation
          // -- the exact Williamson page-9 shape, generalized: two logically
          // distinct line items land on one table row, and the second one's
          // rate was never recovered by OCR.
          raw_text:
            'Tree Operations | Hazardous Trees 49" trunk diameter | Tree | $316.00\nTrees with Hazardous Limbs Hanging Removal',
          nearby_text: '',
        },
      ],
    };

    const rows = extractExhibitARateTableRows([mergedTable]);
    const survivor = rows.find((row) => row.rate === 316);
    assert.ok(survivor, 'the rate-bearing line survives as its own row');
    assert.equal(
      survivor?.confidence,
      'needs_review',
      'flagged because a sibling line with no rate evidence was found and dropped, not merged or guessed',
    );
    assert.match(survivor?.recovery_reason ?? '', /sibling line/i);
    assert.equal(
      rows.some((row) => (row.description ?? '').includes('Hazardous Limbs Hanging') && row.rate != null),
      false,
      'no row is ever created with a fabricated rate for the dropped sibling line',
    );
  });

  it('flags a row needs_review when the rate cell has low OCR engine confidence, without changing the rate value (Mechanism 2)', () => {
    const lowConfidenceTable: PdfTable = {
      id: 'pdf:table:p9:t100',
      page_number: 9,
      headers: ['Category', 'Description', 'Unit', 'Rate'],
      header_context: ['EXHIBIT A', 'EMERGENCY DEBRIS REMOVAL UNIT RATES'],
      confidence: 0.88,
      rows: [
        {
          id: 'pdf:table:p9:t100:r1',
          page_number: 9,
          row_index: 1,
          cells: [
            { column_index: 0, text: 'Equipment', x_min: 100, x_max: 240, source: 'ocr_fallback' },
            { column_index: 1, text: 'Bucket Truck', x_min: 280, x_max: 420, source: 'ocr_fallback' },
            { column_index: 2, text: 'Hour', x_min: 460, x_max: 600, source: 'ocr_fallback' },
            { column_index: 3, text: '$20.00', x_min: 640, x_max: 780, source: 'ocr_fallback', confidence: 0.42 },
          ],
          raw_text: 'Equipment | Bucket Truck | Hour | $20.00',
          nearby_text: '',
        },
      ],
    };

    const [row] = extractExhibitARateTableRows([lowConfidenceTable]);
    assert.ok(row, 'the row is surfaced, not dropped');
    assert.equal(row?.rate, 20, 'the rate value is never fabricated or auto-corrected by the confidence signal');
    assert.equal(row?.rate_ocr_confidence, 0.42);
    assert.equal(
      row?.confidence,
      'needs_review',
      'flagged because the rate cell OCR confidence (0.42) is below the reused 0.65 medium-confidence threshold',
    );
  });

  it('leaves a high-confidence rate cell unaffected by the new OCR confidence gate (Mechanism 2)', () => {
    const highConfidenceTable: PdfTable = {
      id: 'pdf:table:p9:t101',
      page_number: 9,
      headers: ['Category', 'Description', 'Unit', 'Rate'],
      header_context: ['EXHIBIT A', 'EMERGENCY DEBRIS REMOVAL UNIT RATES'],
      confidence: 0.88,
      rows: [
        {
          id: 'pdf:table:p9:t101:r1',
          page_number: 9,
          row_index: 1,
          cells: [
            { column_index: 0, text: 'Equipment', x_min: 100, x_max: 240, source: 'ocr_fallback' },
            { column_index: 1, text: 'Bucket Truck', x_min: 280, x_max: 420, source: 'ocr_fallback' },
            { column_index: 2, text: 'Hour', x_min: 460, x_max: 600, source: 'ocr_fallback' },
            { column_index: 3, text: '$200.00', x_min: 640, x_max: 780, source: 'ocr_fallback', confidence: 0.97 },
          ],
          raw_text: 'Equipment | Bucket Truck | Hour | $200.00',
          nearby_text: '',
        },
      ],
    };

    const [row] = extractExhibitARateTableRows([highConfidenceTable]);
    assert.ok(row);
    assert.equal(row?.rate, 200);
    assert.equal(row?.rate_ocr_confidence, 0.97);
    assert.notEqual(row?.confidence, 'needs_review');
  });

  it('keeps an ambiguous multi-rate cell as needs_review with no guessed rate (Mechanism 1: incomplete/under-merged row, pre-existing invariant)', () => {
    const ambiguousTable = table({
      page: 9,
      rows: [
        ['Tree Operations', 'Hazardous Trees 6 to 12 inch trunk', 'Tree', '$95.00'],
        ['Tree Operations', 'Hazardous Stump Removal 24 inch up', 'Stump', '$150.00 $185.00'],
      ],
    });

    const rows = extractExhibitARateTableRows([ambiguousTable]);
    const ambiguous = rows.find((row) => row.unit === 'Stump');
    assert.ok(ambiguous, 'the row is surfaced for review rather than silently vanishing');
    assert.equal(ambiguous?.rate, null, 'no rate is guessed when multiple competing values are present in the cell');
    assert.equal(ambiguous?.confidence, 'needs_review');
  });
});
