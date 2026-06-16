import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import { assembleContractPricingRows } from '@/lib/contracts/contractPricingAssembly';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { extractExhibitARateTableRows } from '@/lib/contracts/exhibitARateTableRows';
import type { PdfTable } from '@/lib/extraction/pdf/extractTables';

function table(params: {
  id?: string;
  page?: number;
  headers?: string[];
  rows: string[][];
}): PdfTable {
  const page = params.page ?? 8;
  const id = params.id ?? `pdf:table:p${page}:t1`;
  return {
    id,
    page_number: page,
    headers: params.headers ?? ['Category', 'Description', 'Unit', 'Rate'],
    header_context: ['EXHIBIT A', 'EMERGENCY DEBRIS REMOVAL UNIT RATES'],
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

describe('extractExhibitARateTableRows', () => {
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
          ['1 Vegetative Collect, Remove & Haul | from Rural Areas 31-60 Miles from ROW to DMS', '($15.50 |'],
        ],
      }),
    ]);

    assert.equal(row?.category, 'Vegetative Collect, Remove & Haul');
    assert.equal(row?.unit, 'Cubic Yard');
    assert.equal(row?.rate, 15.5);
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

  it('accepts Passthrough rows as traceable pricing rows', () => {
    const [row] = extractExhibitARateTableRows([
      table({
        page: 9,
        id: 'pdf:table:p9:final',
        rows: [
          ['Final Disposal', 'Tipping Fee', 'Ton', 'Passthrough'],
        ],
      }),
    ]);

    assert.equal(row?.category, 'Final Disposal');
    assert.equal(row?.description, 'Tipping Fee');
    assert.equal(row?.unit, 'Ton');
    assert.equal(row?.rate, null);
    assert.equal(row?.rate_raw, 'Passthrough');
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

  it('limits fallback source text parsing to accepted rate schedule pages', () => {
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
          id: 'pdf:text:p1:email',
          page: 1,
          text: 'Email wrapper phantom service $999.00 per cubic yard',
        },
        {
          id: 'pdf:text:p2:rate',
          page: 2,
          text: 'Loading and Hauling Vegetative Debris $27.00 per CY',
        },
      ],
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.page, 2);
    assert.equal(rows[0]?.rate, 27);
    assert.equal(rows[0]?.source_anchor_ids.includes('pdf:text:p1:email'), false);
  });

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
            ['Vegetative Collect, Remove & Haul', 'from Rural Areas ROW to DMS 31 to 60 Miles', 'Cubic Yard', '$15.50'],
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
            ['Vegetative Collect, Remove & Haul', 'from Rural Areas ROW to DMS 31 to 60 Miles', 'Cubic Yard', '$15.50'],
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
            ['Vegetative Collect, Remove & Haul', 'from Rural Areas ROW to DMS 31-60 Miles', 'Cubic Yard', '$15.50'],
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
            'Vegetative Collect, Remove & Haul 0-15 Miles from ROW to DMS Cubic Yard $13.80 from Rural Areas\n'
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
});
