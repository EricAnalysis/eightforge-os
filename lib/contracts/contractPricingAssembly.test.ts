import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

import {
  assembleContractPricingRows,
  cleanContractRateDescriptionForDisplay,
  formatContractPricingRate,
  scoreContractPricingRowSourceQuality,
} from '@/lib/contracts/contractPricingAssembly';
import type { ContractRateScheduleRow } from '@/lib/contracts/types';

function row(overrides: Partial<ContractRateScheduleRow> = {}): ContractRateScheduleRow {
  return {
    row_id: 'rate_row:fallback:2',
    description: 'Vegetative Collect, Remove & Haul from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
    unit: 'Cubic Yard',
    rate: 6.9,
    category: 'Vegetative Collect, Remove & Haul',
    source_category: 'Vegetative Collect, Remove & Haul',
    canonical_category: 'vegetative',
    category_confidence: 0.92,
    page: 8,
    source_anchor_ids: ['pdf:text:p8:b12'],
    rate_raw:
      'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
    material_type: 'Vegetative Collect, Remove & Haul',
    unit_type: 'Cubic Yard',
    rate_amount: 6.9,
    ...overrides,
  };
}

describe('assembleContractPricingRows', () => {
  it('assembles clean rate row with category, description, unit, rate, page', () => {
    const [assembled] = assembleContractPricingRows([row()]);
    assert.equal(assembled?.category, 'Vegetative Collect, Remove & Haul');
    assert.equal(
      assembled?.description,
      'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
    );
    assert.equal(assembled?.unit, 'Cubic Yard');
    assert.equal(assembled?.rate, 6.9);
    assert.equal(assembled?.page, 8);
  });

  it('keeps a clean description unchanged', () => {
    const cleanDescription = 'Final Disposal Single Cost - Any Distance';
    const [assembled] = assembleContractPricingRows([
      row({
        description: cleanDescription,
        category: 'Final Disposal',
        source_category: 'Final Disposal',
        canonical_category: 'final_disposal',
        rate_raw: 'Final Disposal | Single Cost - Any Distance | Cubic Yard | $5.40',
        rate: 5.4,
        rate_amount: 5.4,
      }),
    ]);
    assert.equal(assembled?.description, 'Single Cost - Any Distance');
  });

  it('collapses doubled Bucket Truck OCR fragments into a readable equipment description', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'equipment-bucket-doubled',
        category: 'Equipment',
        source_category: 'Equipment',
        description: 'Bucket Truck With 50 60 Arm Bucket Truck With 50 60 Arm Hour 200 00 Equipment Bucket Truck',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 200,
        rate_amount: 200,
        page: 10,
        rate_raw: 'Equipment Bucket Truck With 50 60 Arm Bucket Truck With 50 60 Arm Hour 200 00',
      }),
    ]);

    assert.equal(assembled?.description, 'Bucket Truck with 50 to 60 foot Arm');
    assert.equal(assembled?.confidence, 'low');
  });

  it('downgrades merged Dump Truck capacity rows to Needs Review', () => {
    const extractedDescription = 'Dump Dump Truck, Truck, 21-40 16-20 Gu, Cu, Yd, Yt, Capac Capaety -';
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'equipment-dump-merged',
        category: 'Equipment',
        source_category: 'Equipment',
        description: extractedDescription,
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 170,
        rate_amount: 170,
        page: 11,
        rate_raw: 'Equipment Dump Dump Truck, Truck, 21-40 16-20 Gu, Cu, Yd, Yt, Capac Capaety - Hour $170.00',
      }),
    ]);

    assert.equal(assembled?.description, extractedDescription);
    assert.equal(assembled?.confidence, 'needs_review');
    assert.equal(assembled?.state, 'needs_review');
  });

  it('strips Articulated Loader OCR prefixes and normalizes capacity text', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'equipment-articulated-loader',
        category: 'Equipment',
        source_category: 'Equipment',
        description: "me LE '2.0-4.0 Gu. Vd. Articulated Loader with bucket' I",
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 150,
        rate_amount: 150,
        page: 10,
        rate_raw: "Equipment me LE '2.0-4.0 Gu. Vd. Articulated Loader with bucket' I Hour $150.00",
      }),
    ]);

    assert.equal(assembled?.description, '3.0 to 4.0 Cu. Yd. Articulated Loader with bucket');
    assert.notEqual(assembled?.confidence, 'high');
  });

  it('strips trailing dashes from Water Truck equipment rows', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'equipment-water-truck',
        category: 'Equipment',
        source_category: 'Equipment',
        description: 'Water Truck --',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 96,
        rate_amount: 96,
        page: 11,
        rate_raw: 'Equipment | Water Truck -- | Hour | $96.00',
      }),
    ]);

    assert.equal(assembled?.description, 'Water Truck');
  });

  it('recovers Rural Areas context for the Vegetative 15.50 row when source text supports it', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'vegetative-rural-31-60',
        category: 'Vegetative Collect, Remove & Haul',
        source_category: 'Vegetative Collect, Remove & Haul',
        description: 'ROW to DMS 31 to 60 Miles',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 15.5,
        rate_amount: 15.5,
        page: 8,
        rate_raw: 'Vegetative Collect, Remove & Haul | 31-60 Miles from ROW to DMS | Cubic Yard | $15.50 | from Rural Areas',
      }),
    ]);

    assert.equal(assembled?.description, 'from Rural Areas ROW to DMS 31 to 60 Miles');
    assert.equal(assembled?.confidence, 'low');
  });

  it('keeps suspicious Vessel Removal 2800 OCR rate visible as Needs Review', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'specialty-vessel-2800',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        description: 'Vessel Removal from Land applicable allowed',
        unit: 'Unit',
        unit_type: 'Unit',
        rate: 2800,
        rate_amount: 2800,
        page: 9,
        rate_raw: "Specialty Removal | Vessel Removal from Land | Unit [$2800",
      }),
    ]);

    assert.equal(assembled?.description, 'Vessel Removal');
    assert.equal(assembled?.rate, 2800);
    assert.equal(assembled?.confidence, 'needs_review');
  });

  it('corrects Stump Fill Dirt unit to Cubic Yard and flags polluted 1000 rate', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'tree-stump-fill-1000',
        category: 'Tree Operations',
        source_category: 'Tree Operations',
        description: 'Stump Fill Dirt for Filling Stump Holes',
        unit: 'Stump',
        unit_type: 'Stump',
        rate: 1000,
        rate_amount: 1000,
        page: 9,
        rate_raw: 'Tree Operations | Stump Fill Dirt for Filling Stump Holes | Cubic Yard [$1000',
      }),
    ]);

    assert.equal(assembled?.description, 'Stump Fill Dirt for Filling Stump Holes');
    assert.equal(assembled?.unit, 'Cubic Yard');
    assert.equal(assembled?.confidence, 'needs_review');
  });

  it('cleans source-backed 190 Equipment trailer dump row', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'equipment-trailer-dump-190',
        category: 'Equipment',
        source_category: 'Equipment',
        description: 'Equipment | Trailer Dump Truck, 61-90Cu.yd,',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 190,
        rate_amount: 190,
        page: 11,
        rate_raw: 'Equipment | Trailer Dump Truck, 61-90Cu.yd, | Hour [$190.00',
      }),
    ]);

    assert.equal(assembled?.description, 'Trailer Dump Truck');
    assert.notEqual(assembled?.confidence, 'needs_review');
  });

  it('recovers Demolition of Private Structure for source-backed Specialty 28 row', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'specialty-demolition-28',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        description: 'rooemyonment SpeofattyRemoval --- Fen Domalltion dment of Private ond Structure I',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 28,
        rate_amount: 28,
        page: 9,
        rate_raw: 'Specialty Removal Domalltion dment of Private ond Structure Cubic Yard $28.00',
      }),
    ]);

    assert.equal(assembled?.description, 'Demolition of Private Structure');
    assert.equal(assembled?.confidence, 'low');
  });

  it('parses noisy OCR table text into readable pricing description', () => {
    const noisyDescription =
      'Cubic Yard | $7.90 | [Category /[ Vegetative Collect, Remove & Haul | [Description 0-16 Milesfrom ROW t6 DMS Gn | Cubic ____ | Yard | from Unincorporated Nejghborhoods';
    const noisyRaw =
      '| | Vegetative from Unincorporated Collect, Remove Neighborhoods &Haul | | 16-30 Miles from ROWtoDMS | Cubic Yard | $7.90 | [Category /[ Vegetative Collect, Remove & Haul | [Description 0-16 Milesfrom ROW t6 DMS Gn | Cubic ____| Yard | $6.90 Rate _ | | | | from Unincorporated Nejghborhoods: PDF text block on page 8';
    const [assembled] = assembleContractPricingRows([
      row({
        description: noisyDescription,
        unit: 'miles',
        unit_type: 'miles',
        category: 'Vegetative from Unincorporated Collect, Remove Neighborhoods &Haul',
        source_category: 'Vegetative from Unincorporated Collect, Remove Neighborhoods &Haul',
        rate_raw: noisyRaw,
      }),
    ]);
    assert.equal(assembled?.category, 'Vegetative Collect, Remove & Haul');
    assert.equal(
      assembled?.description,
      'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
    );
    assert.equal(assembled?.unit, 'Cubic Yard');
    assert.equal(assembled?.rate, 6.9);
    assert.equal(assembled?.confidence, 'medium');
    assert.ok(!assembled?.description.includes('$7.90'));
    assert.ok(!assembled?.description.includes('Cubic Yard'));
    assert.ok(!assembled?.description.includes('PDF text block'));
  });

  it('parses noisy 0-30 Milesftom OCR table text into readable pricing description', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        rate: 7,
        rate_amount: 7,
        description:
          'Cubic Yard | $7.00 | [Category / Vegetative Collect, Remove & Haul | [Description 0-30 Milesftom ROW to DMS Gn | Cubic ____| Yard | From Unincorporated Neighborhoods',
        rate_raw:
          'Vegetative Collect, Remove & Haul | 0-30 Milesftom ROW to DMS | Cubic Yard | $7.00 | From Unincorporated Neighborhoods',
      }),
    ]);

    assert.equal(
      assembled?.description,
      'from Unincorporated Neighborhood ROW to DMS 0 to 30 Miles',
    );
    assert.equal(assembled?.distanceBand, '0 to 30 Miles');
    assert.equal(assembled?.route, 'ROW to DMS');
    assert.ok(!assembled?.description.includes('$7.00'));
    assert.ok(!assembled?.description.includes('Cubic Yard'));
  });

  it('normalizes cubic yard variants', () => {
    for (const unit of ['CY', 'C.Y.', 'cubic yards', 'yard', 'yards']) {
      const [assembled] = assembleContractPricingRows([row({ unit, unit_type: unit })]);
      assert.equal(assembled?.unit, 'Cubic Yard', unit);
    }
  });

  it('does not treat miles as billing unit when cubic yard is present', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        unit: 'miles',
        unit_type: 'miles',
        rate_raw: '0 to 15 Miles from ROW to DMS Cubic Yard $6.90',
      }),
    ]);
    assert.equal(assembled?.unit, 'Cubic Yard');
  });

  it('extracts ROW to DMS route', () => {
    const [assembled] = assembleContractPricingRows([row()]);
    assert.equal(assembled?.route, 'ROW to DMS');
  });

  it('preserves origin_destination as raw extracted cell text', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'price-sheet-row-1',
        description: 'Loading and Hauling Vegetative Debris',
        origin_destination: 'From Right of Way (ROW) to DMS',
        unit: 'CY',
        unit_type: 'CY',
        rate: 27,
        rate_amount: 27,
        category: null,
        source_category: null,
        material_type: null,
        canonical_category: null,
        page: 2,
        rate_raw: 'Loading and Hauling Vegetative Debris | From Right of Way (ROW) to DMS | CY | $27.00',
      }),
    ]);

    assert.equal(assembled?.description, 'Loading and Hauling Vegetative Debris');
    assert.equal(assembled?.origin_destination, 'From Right of Way (ROW) to DMS');
    assert.equal(assembled?.unit, 'Cubic Yard');
    assert.equal(assembled?.rate, 27);
    assert.equal(assembled?.rawText?.includes('From Right of Way (ROW) to DMS'), true);
  });

  it('extracts distance band 0 to 15', () => {
    const [assembled] = assembleContractPricingRows([row()]);
    assert.equal(assembled?.distanceBand, '0 to 15 Miles');
  });

  it('keeps route and distance language in description without requiring separate fields for confidence', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        description: 'Vegetative Collect, Remove & Haul from Unincorporated Neighborhood ROW to DMS 0 to 16 Miles',
        rate_raw:
          'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 0 to 16 Miles | Cubic Yard | $6.90',
      }),
    ]);
    assert.equal(
      assembled?.description,
      'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
    );
    assert.equal(assembled?.distanceBand, '0 to 15 Miles');
    assert.equal(assembled?.confidence, 'high');
  });

  it('downgrades OCR damaged Vegetative rows instead of confirming them', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'exhibit_a_table:damaged-vegetative',
        source_kind: 'exhibit_a_table',
        description: 'Vegetative Goldott, Remove & Hal She oto Rowlo HS ny i',
        rate_raw: 'Vegetative Goldott, Remove & Hal She oto Rowlo HS ny i | Cubic Yard | $100',
        rate: 100,
        rate_amount: 100,
      }),
    ]);

    assert.equal(assembled?.confidence, 'needs_review');
    assert.notEqual(assembled?.confidence, 'high');
    assert.equal(assembled?.rawText?.includes('Goldott'), true);
  });

  it('downgrades OCR damaged Specialty Removal rows instead of confirming them', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'exhibit_a_table:damaged-specialty',
        source_kind: 'exhibit_a_table',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        material_type: 'Specialty Removal',
        canonical_category: 'specialty_removal',
        page: 9,
        description: 'SpecialtyRemoval -- ""WhiteGoodsinROW. Unf *',
        unit: 'Unit',
        unit_type: 'Unit',
        rate: 50,
        rate_amount: 50,
        rate_raw: 'SpecialtyRemoval -- ""WhiteGoodsinROW. Unf * | Unit | $50.00',
      }),
    ]);

    assert.equal(assembled?.confidence, 'low');
    assert.notEqual(assembled?.confidence, 'high');
  });

  it('keeps clean Equipment rows confirmed', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'exhibit_a_table:bucket-truck',
        source_kind: 'exhibit_a_table',
        category: 'Equipment',
        source_category: 'Equipment',
        material_type: 'Equipment',
        canonical_category: 'equipment',
        page: 10,
        description: 'Bucket Truck with 50 to 60 foot Arm',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 200,
        rate_amount: 200,
        rate_raw: 'Equipment | Bucket Truck with 50 to 60 foot Arm | Hour | $200.00',
      }),
    ]);

    assert.equal(assembled?.description, 'Bucket Truck with 50 to 60 foot Arm');
    assert.equal(assembled?.confidence, 'high');
  });

  it('does not confirm Cat 623 model-number rate pollution', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'exhibit_a_table:cat-623',
        source_kind: 'exhibit_a_table',
        category: 'Equipment',
        source_category: 'Equipment',
        material_type: 'Equipment',
        canonical_category: 'equipment',
        page: 10,
        description: 'Self-Loader Scraper Cat 623 or equivalent',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 623,
        rate_amount: 623,
        rate_raw: 'Equipment | Self-Loader Scraper Cat 623 or equivalent | Hour',
      }),
    ]);

    assert.equal(rows.length, 0);
  });

  it('does not confirm corrected Equipment Transports OCR rate pollution', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'exhibit_a_table:equipment-transport',
        source_kind: 'exhibit_a_table',
        confidence: 'needs_review',
        category: 'Equipment',
        source_category: 'Equipment',
        material_type: 'Equipment',
        canonical_category: 'equipment',
        page: 11,
        description: 'Equipment Transports',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 115,
        rate_amount: 115,
        rate_raw: "Equipment | Equipment Transports. II 'Hour [#11500",
      }),
    ]);

    assert.equal(assembled?.confidence, 'needs_review');
    assert.notEqual(assembled?.confidence, 'high');
  });

  it('does not confirm operator-unreadable OCR damaged descriptions', () => {
    const cases: Array<{
      id: string;
      category: string;
      unit: string;
      rate: number;
      page: number;
      description: string;
    }> = [
      {
        id: 'damaged-management-roman',
        category: 'Management & Reduction',
        unit: 'Cubic Yard',
        rate: 1,
        page: 8,
        description: '1 Management & Reduction I',
      },
      {
        id: 'damaged-tree-limbs',
        category: 'Tree Operations',
        unit: 'Tree',
        rate: 80,
        page: 9,
        description: 'Operations ** Hazardous Limbs Hanging IE',
      },
      {
        id: 'damaged-tree-stump',
        category: 'Tree Operations',
        unit: 'Stump',
        rate: 185,
        page: 9,
        description: 'Operations ** Hazardous Removal 24" up Tf',
      },
      {
        id: 'damaged-equipment',
        category: 'Equipment',
        unit: 'Hour',
        rate: 106.09,
        page: 10,
        description: 'Equinmãt A-Gutdin Tolnarator elf Coad sjua',
      },
      {
        id: 'damaged-vessel',
        category: 'Specialty Removal',
        unit: 'Unit',
        rate: 28,
        page: 9,
        description: 'applicable/allowed, Vessel Removal from Land if _ Unt',
      },
      {
        id: 'damaged-vehicle',
        category: 'Specialty Removal',
        unit: 'Unit',
        rate: 200,
        page: 9,
        description: 'sand/myd/dirt/rock Vehicle Removal',
      },
      {
        id: 'damaged-carcass',
        category: 'Specialty Removal',
        unit: 'Pound',
        rate: 8,
        page: 9,
        description: 'Specialty Removal oo BE $pplicable/allowed Carcass Removal',
      },
      {
        id: 'damaged-structure',
        category: 'Specialty Removal',
        unit: 'Cubic Yard',
        rate: 28,
        page: 9,
        description: 'rooemyonment SpeofattyRemoval --- Fen Domalltion dment of Private ond Structure I',
      },
    ];

    const rows = assembleContractPricingRows(
      cases.map((entry) =>
        row({
          row_id: `exhibit_a_table:${entry.id}`,
          source_kind: 'exhibit_a_table',
          category: entry.category,
          source_category: entry.category,
          material_type: entry.category,
          canonical_category: entry.category.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          page: entry.page,
          description: entry.description,
          unit: entry.unit,
          unit_type: entry.unit,
          rate: entry.rate,
          rate_amount: entry.rate,
          rate_raw: `${entry.category} | ${entry.description} | ${entry.unit} | $${entry.rate.toFixed(2)}`,
        }),
      ),
    );

    assert.ok(rows.length >= cases.length - 1);
    const byId = new Map(rows.map((assembled) => [assembled.id, assembled]));
    assert.equal(byId.get('exhibit_a_table:damaged-management-roman')?.description, '1 Management & Reduction I');
    assert.equal(byId.get('exhibit_a_table:damaged-management-roman')?.confidence, 'needs_review');
    assert.equal(byId.get('exhibit_a_table:damaged-tree-limbs')?.description, 'Trees with Hazardous Limbs Hanging');
    assert.equal(byId.get('exhibit_a_table:damaged-tree-limbs')?.confidence, 'low');
    assert.equal(byId.get('exhibit_a_table:damaged-tree-stump')?.description, 'Hazardous Stump Removal 24 inch up');
    assert.equal(byId.get('exhibit_a_table:damaged-tree-stump')?.confidence, 'low');
    assert.equal(byId.get('exhibit_a_table:damaged-equipment')?.confidence, 'needs_review');
    if (byId.has('exhibit_a_table:damaged-vessel')) {
      assert.equal(byId.get('exhibit_a_table:damaged-vessel')?.description, 'Vessel Removal');
      assert.notEqual(byId.get('exhibit_a_table:damaged-vessel')?.confidence, 'high');
    }
    assert.equal(byId.get('exhibit_a_table:damaged-vehicle')?.confidence, 'needs_review');
    assert.equal(byId.get('exhibit_a_table:damaged-carcass')?.description, 'Carcass Removal');
    assert.equal(byId.get('exhibit_a_table:damaged-carcass')?.confidence, 'low');
    assert.equal(byId.get('exhibit_a_table:damaged-structure')?.description, 'Demolition of Private Structure');
    assert.notEqual(byId.get('exhibit_a_table:damaged-structure')?.confidence, 'high');
    assert.ok(rows.every((assembled) => assembled.confidence !== 'high'));
    assert.ok(rows.every((assembled) => assembled.rawText));
  });

  it('normalizes route OCR variant t6 DMS', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        description: 'Vegetative Collect, Remove & Haul from Unincorporated Neighborhood 0-16 Milesfrom ROW t6 DMS',
        rate_raw: 'Vegetative Collect, Remove & Haul | 0-16 Milesfrom ROW t6 DMS | Cubic Yard | $6.90',
      }),
    ]);
    assert.equal(assembled?.route, 'ROW to DMS');
    assert.equal(
      assembled?.description,
      'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
    );
  });

  it('rejects noisy scope fragments as categories', () => {
    const rows = assembleContractPricingRows([
      row({
        category: 'from Unincorporated Neighborhoods',
        source_category: 'from Unincorporated Neighborhoods',
        material_type: 'from Unincorporated Neighborhoods',
        canonical_category: null,
        description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
        rate_raw: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
      }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.category, null);
    assert.equal(rows[0]?.confidence, 'needs_review');
  });

  it('rejects numeric and roman numeral categories', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'numeric-category',
        category: '1',
        source_category: '1',
        material_type: '1',
        canonical_category: null,
        description: 'ROW to DMS 0 to 15 Miles',
        rate_raw: 'ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
      }),
      row({
        row_id: 'roman-category',
        category: 'II',
        source_category: 'II',
        material_type: 'II',
        canonical_category: null,
        description: 'ROW to DMS 16 to 30 Miles',
        rate_raw: 'ROW to DMS 16 to 30 Miles | Cubic Yard | $7.90',
        rate: 7.9,
        rate_amount: 7.9,
      }),
    ]);

    assert.equal(rows.length, 2);
    assert.ok(rows.every((assembled) => assembled.confidence === 'needs_review'));
  });

  it('does not expose random OCR fragments as categories', () => {
    const rows = assembleContractPricingRows([
      row({
        category: 'diameter A',
        source_category: 'diameter A',
        material_type: 'diameter A',
        canonical_category: null,
        description: 'ROW to DMS 0 to 15 Miles',
        rate_raw: 'ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
      }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.confidence, 'needs_review');
  });

  it('marks traceable OCR rows for review instead of displaying raw fragments as trusted rows', () => {
    const rows = assembleContractPricingRows([
      row({
        description: 'Cubic Yard | $6.90 | [Category] | Description ____ | PDF text block on page 8',
        category: '1',
        source_category: 'II',
        canonical_category: null,
        rate_raw: 'Cubic Yard | $6.90 | [Category] | Description ____ | PDF text block on page 8',
      }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.description, 'Cubic Yard | $6.90 | [Category] | Description ____ | PDF text block on page 8');
    assert.equal(rows[0]?.confidence, 'needs_review');
    assert.equal(rows[0]?.sourceQuality, 'fallback');
  });

  it('collapses exact duplicate assembled rows conservatively', () => {
    const rows = assembleContractPricingRows([
      row({ row_id: 'duplicate-a' }),
      row({ row_id: 'duplicate-b' }),
      row({ row_id: 'unique-rate', rate: 7.9, rate_amount: 7.9, rate_raw: '$7.90' }),
    ]);

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.id, 'duplicate-a');
    assert.equal(rows[1]?.rate, 7.9);
  });

  it('keeps allowed operator-facing categories', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'equipment',
        category: 'Equipment',
        source_category: 'Equipment',
        canonical_category: 'equipment',
        description: 'Excavator with operator',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 120,
        rate_amount: 120,
        page: 10,
        rate_raw: 'Equipment | Excavator with operator | Hour | $120.00',
      }),
      row({
        row_id: 'personnel',
        category: 'Personnel',
        source_category: 'Personnel',
        canonical_category: 'personnel',
        description: 'Supervisor labor',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 85,
        rate_amount: 85,
        page: 10,
        rate_raw: 'Personnel | Supervisor labor | Hour | $85.00',
      }),
      row({
        row_id: 'final-disposal',
        category: 'Final Disposal',
        source_category: 'Final Disposal',
        canonical_category: 'final_disposal',
        description: 'Final Disposal Single Cost - Any Distance',
        rate: 5.4,
        rate_amount: 5.4,
        rate_raw: 'Final Disposal | Single Cost - Any Distance | Cubic Yard | $5.40',
      }),
      row({
        row_id: 'management-reduction',
        category: 'Management & Reduction',
        source_category: 'Management & Reduction',
        canonical_category: 'management_reduction',
        description: 'Management & Reduction at DMS',
        rate: 2.5,
        rate_amount: 2.5,
        rate_raw: 'Management & Reduction | DMS | Cubic Yard | $2.50',
      }),
    ]);

    assert.deepEqual(rows.map((assembled) => assembled.category), [
      'Management & Reduction',
      'Final Disposal',
      'Equipment',
      'Personnel',
    ]);
  });

  it('preserves Exhibit A columns and derives route/distance for transport rows', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'vegetative-1',
        category: 'Vegetative Collect, Remove & Haul',
        source_category: 'Vegetative Collect, Remove & Haul',
        canonical_category: 'vegetative',
        description: 'from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 7.9,
        rate_amount: 7.9,
        page: 8,
        rate_raw:
          'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles | Cubic Yard | $7.90',
      }),
      row({
        row_id: 'final-disposal-transport',
        category: 'Final Disposal',
        source_category: 'Final Disposal',
        canonical_category: 'final_disposal',
        description: 'Mulch DMS-to-FDS 16 to 30 Miles',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 3.75,
        rate_amount: 3.75,
        page: 8,
        rate_raw: 'Final Disposal | Mulch DMS-to-FDS 16 to 30 Miles | Cubic Yard | $3.75',
      }),
    ]);

    assert.equal(rows[0]?.category, 'Vegetative Collect, Remove & Haul');
    assert.equal(rows[0]?.description, 'from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles');
    assert.equal(rows[0]?.route, 'ROW to DMS');
    assert.equal(rows[0]?.distanceBand, '16 to 30 Miles');
    assert.equal(rows[0]?.unit, 'Cubic Yard');
    assert.equal(rows[0]?.rate, 7.9);
    assert.equal(rows[0]?.page, 8);
    assert.equal(rows[0]?.confidence, 'high');
    assert.equal(rows[1]?.category, 'Final Disposal');
    assert.equal(rows[1]?.description, 'Mulch DMS to FDS 16 to 30 Miles');
    assert.equal(rows[1]?.route, 'DMS to FDS');
    assert.equal(rows[1]?.distanceBand, '16 to 30 Miles');
    assert.equal(rows[1]?.confidence, 'high');
  });

  it('parses C&D rows without inventing billing keys', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'c-d-1',
        category: 'C&D Collect, Remove & Haul',
        source_category: 'C&D Collect, Remove & Haul',
        canonical_category: 'construction_demolition',
        description: 'C&D Collect, Remove & Haul ROW to DMS 31 to 60 Miles',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 12.9,
        rate_amount: 12.9,
        page: 8,
        rate_raw: 'C&D Collect, Remove & Haul | ROW to DMS 31 to 60 Miles | Cubic Yard | $12.90',
      }),
    ]);

    assert.equal(assembled?.category, 'C&D Collect, Remove & Haul');
    assert.equal(assembled?.description, 'ROW to DMS 31 to 60 Miles');
    assert.equal(assembled?.route, 'ROW to DMS');
    assert.equal(assembled?.distanceBand, '31 to 60 Miles');
    assert.equal(assembled?.unit, 'Cubic Yard');
    assert.equal(assembled?.rate, 12.9);
    assert.ok(!assembled?.description.includes('1A'));
  });

  it('keeps non-transport Exhibit A descriptions with no derived route or distance', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'management',
        category: 'Management & Reduction',
        source_category: 'Management & Reduction',
        canonical_category: 'management_reduction',
        description: 'Grinding and Chipping Vegetative Debris',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 2.25,
        rate_amount: 2.25,
        page: 8,
        rate_raw: 'Management & Reduction | Grinding and Chipping Vegetative Debris | Cubic Yard | $2.25',
      }),
      row({
        row_id: 'tree',
        category: 'Tree Operations',
        source_category: 'Tree Operations',
        canonical_category: 'tree_operations',
        description: 'Trees with Hazardous Limbs Hanging',
        unit: 'Tree',
        unit_type: 'Tree',
        rate: 80,
        rate_amount: 80,
        page: 9,
        rate_raw: 'Tree Operations | Trees with Hazardous Limbs Hanging | Tree | $80.00',
      }),
      row({
        row_id: 'specialty',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        canonical_category: 'specialty_removal',
        description: 'Vehicle Removal',
        unit: 'Unit',
        unit_type: 'Unit',
        rate: 200,
        rate_amount: 200,
        page: 9,
        rate_raw: 'Specialty Removal | Vehicle Removal | Unit | $200.00',
      }),
      row({
        row_id: 'equipment',
        category: 'Equipment',
        source_category: 'Equipment',
        canonical_category: 'equipment',
        description: 'Bucket Truck',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 175,
        rate_amount: 175,
        page: 10,
        rate_raw: 'Equipment | Bucket Truck | Hour | $175.00',
      }),
      row({
        row_id: 'personnel',
        category: 'Personnel',
        source_category: 'Personnel',
        canonical_category: 'personnel',
        description: 'Operations Supervisor',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 95,
        rate_amount: 95,
        page: 10,
        rate_raw: 'Personnel | Operations Supervisor | Hour | $95.00',
      }),
    ]);

    for (const assembled of rows) {
      assert.equal(assembled.route, null);
      assert.equal(assembled.distanceBand, null);
      assert.equal(assembled.confidence, 'high');
    }
    assert.deepEqual(rows.map((assembled) => assembled.unit), [
      'Cubic Yard',
      'Tree',
      'Hour',
      'Hour',
      'Unit',
    ]);
  });

  it('normalizes OCR route and distance variants without treating distance as unit', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        category: 'Vegetative Collect, Remove & Haul',
        source_category: 'Vegetative Collect, Remove & Haul',
        canonical_category: 'vegetative',
        description: '0-16 Milesftom ROW t6 DMS',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate_raw: 'Vegetative Collect, Remove & Haul | 0-16 Milesftom ROW t6 DMS | Cubic Yard | $6.90',
      }),
    ]);

    assert.equal(assembled?.description, 'ROW to DMS 0 to 15 Miles');
    assert.equal(assembled?.route, 'ROW to DMS');
    assert.equal(assembled?.distanceBand, '0 to 15 Miles');
    assert.equal(assembled?.unit, 'Cubic Yard');
    assert.equal(assembled?.confidence, 'medium');
  });

  it('excludes uncertain duplicate rows from the operator-facing table', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'uncertain-a',
        category: '1',
        source_category: '1',
        material_type: '1',
        canonical_category: null,
        description: 'ROW to DMS 0 to 15 Miles',
        rate_raw: 'ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
      }),
      row({
        row_id: 'uncertain-b',
        category: '1',
        source_category: '1',
        material_type: '1',
        canonical_category: null,
        description: 'ROW to DMS 0 to 15 Miles',
        rate_raw: 'ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
      }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.confidence, 'needs_review');
  });

  it('caps large Exhibit A assemblies at expected category counts', () => {
    const sourceRows = Array.from({ length: 105 }, (_, index) =>
      row({
        row_id: `tm-equipment-${index + 1}`,
        category: 'Equipment',
        source_category: 'Equipment',
        canonical_category: 'equipment',
        description: `Equipment Item ${index + 1}`,
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 100 + index,
        rate_amount: 100 + index,
        page: index < 55 ? 10 : 11,
        rate_raw: `Equipment | Equipment Item ${index + 1} | Hour | $${(100 + index).toFixed(2)}`,
      }),
    );

    const rows = assembleContractPricingRows(sourceRows);
    assert.equal(rows.length, 53);
    assert.ok(rows.every((assembled) => assembled.category === 'Equipment'));
  });

  it('recovers vegetative 16 to 30 and rural area descriptions from noisy table text', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'veg-16-30',
        description: 'Cotte vara Joo | Description | 16-30 Milesftom ROW t6 DMS | Rate $7.90',
        rate_raw:
          'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhoods | 16-30 Milesftom ROW t6 DMS | Cubic Yard | $7.90',
        rate: 7.9,
        rate_amount: 7.9,
      }),
      row({
        row_id: 'veg-rural',
        description: 'OR EN | Rural Areas | 31-60 Miles from ROWtoDMS | $8.90',
        rate_raw:
          'Vegetative Collect, Remove & Haul | from Rural Areas | 31-60 Miles from ROWtoDMS | Cubic Yard | $8.90',
        rate: 8.9,
        rate_amount: 8.9,
      }),
    ]);

    assert.equal(rows[0]?.description, 'from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles');
    assert.equal(rows[0]?.route, 'ROW to DMS');
    assert.equal(rows[0]?.distanceBand, '16 to 30 Miles');
    assert.equal(rows[0]?.confidence, 'low');
    assert.equal(rows[1]?.description, 'from Rural Areas ROW to DMS 31 to 60 Miles');
    assert.equal(rows[1]?.distanceBand, '31 to 60 Miles');
  });

  it('recovers management descriptions from category-specific keywords', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'mgmt-grind',
        category: 'Management & Reduction',
        source_category: 'Management & Reduction',
        canonical_category: 'management_reduction',
        description: 'Category | OR EN | Grinding ____ Chipping | Unit | Rate $2.25',
        rate_raw: 'Management & Reduction | Grinding and Chipping Vegetative Debris | Cubic Yard | $2.25',
        rate: 2.25,
        rate_amount: 2.25,
      }),
      row({
        row_id: 'mgmt-open-burning',
        category: 'Management & Reduction',
        source_category: 'Management & Reduction',
        canonical_category: 'management_reduction',
        description: 'Open Burning | PDF text block on page 8 | $1.50',
        rate_raw: 'Management & Reduction | Open Burning of Vegetative Debris | Cubic Yard | $1.50',
        rate: 1.5,
        rate_amount: 1.5,
      }),
    ]);

    assert.equal(rows[0]?.description, 'Grinding and Chipping Vegetative Debris');
    assert.equal(rows[1]?.description, 'Open Burning of Vegetative Debris');
    assert.ok(rows.every((assembled) => assembled.route == null && assembled.distanceBand == null));
  });

  it('does not leak neighboring transport route and distance into Management rows', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'management-route-leak',
        category: 'Management & Reduction',
        source_category: 'Management & Reduction',
        canonical_category: 'management_reduction',
        description: 'Grinding and Chipping Vegetative Debris',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 2.25,
        rate_amount: 2.25,
        page: 8,
        rate_raw:
          'Management & Reduction | Grinding and Chipping Vegetative Debris | Cubic Yard | $2.25 | adjacent 31-60 Miles from ROW to DMS $10.90',
      }),
    ]);

    assert.equal(assembled?.category, 'Management & Reduction');
    assert.equal(assembled?.description, 'Grinding and Chipping Vegetative Debris');
    assert.equal(assembled?.route, null);
    assert.equal(assembled?.distanceBand, null);
  });

  it('recovers final disposal FDS and any-distance descriptions', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'final-fds',
        category: 'Final Disposal',
        source_category: 'Final Disposal',
        canonical_category: 'final_disposal',
        description: 'PDF text block | Mulch | DMS-FDS | 31-60 Miles | $4.25',
        rate_raw: 'Final Disposal | Mulch DMS-FDS 31-60 Miles | Cubic Yard | $4.25',
        rate: 4.25,
        rate_amount: 4.25,
      }),
      row({
        row_id: 'final-any',
        category: 'Final Disposal',
        source_category: 'Final Disposal',
        canonical_category: 'final_disposal',
        description: 'Final Disposal | Single Cost | Any Distance | $5.40',
        rate_raw: 'Final Disposal | Single Cost Any Distance | Cubic Yard | $5.40',
        rate: 5.4,
        rate_amount: 5.4,
      }),
    ]);

    const fdsRow = rows.find((assembled) => assembled.id === 'final-fds');
    const anyDistanceRow = rows.find((assembled) => assembled.id === 'final-any');
    assert.equal(fdsRow?.description, 'Mulch DMS to FDS 31 to 60 Miles');
    assert.equal(fdsRow?.route, 'DMS to FDS');
    assert.equal(fdsRow?.distanceBand, '31 to 60 Miles');
    assert.equal(anyDistanceRow?.description, 'Single Cost Any Distance');
    assert.equal(anyDistanceRow?.distanceBand, 'Any Distance');
  });

  it('recovers tree operation descriptions for diameter, hanging limbs, and stump rows', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'tree-diameter',
        category: 'Tree Operations',
        source_category: 'Tree Operations',
        canonical_category: 'tree_operations',
        description: 'diameter A | Hazardous Trees 13 - 24 inch trunk | $95.00',
        unit: 'Tree',
        unit_type: 'Tree',
        rate: 95,
        rate_amount: 95,
        page: 9,
        rate_raw: 'Tree Operations | Hazardous Trees 13 to 24 inch trunk diameter | Tree | $95.00',
      }),
      row({
        row_id: 'tree-limb',
        category: 'Tree Operations',
        source_category: 'Tree Operations',
        canonical_category: 'tree_operations',
        description: 'Toe seo j | limbs hanging | Rate $80.00',
        unit: 'Tree',
        unit_type: 'Tree',
        rate: 80,
        rate_amount: 80,
        page: 9,
        rate_raw: 'Tree Operations | Trees with Hazardous Limbs Hanging | Tree | $80.00',
      }),
      row({
        row_id: 'tree-stump',
        category: 'Tree Operations',
        source_category: 'Tree Operations',
        canonical_category: 'tree_operations',
        description: 'stump removal 24 inch up | Unit | $150.00',
        unit: 'Stump',
        unit_type: 'Stump',
        rate: 150,
        rate_amount: 150,
        page: 9,
        rate_raw: 'Tree Operations | Hazardous Stump Removal 24 inch up | Stump | $150.00',
      }),
    ]);

    assert.deepEqual(rows.map((assembled) => assembled.description), [
      'Hazardous Trees 13 to 24 inch trunk',
      'Trees with Hazardous Limbs Hanging',
      'Hazardous Stump Removal 24 inch up',
    ]);
  });

  it('recovers specialty removal descriptions without C&D misclassification', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'specialty-bio',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        canonical_category: 'specialty_removal',
        description: 'Bio pathological blood debris | $8.00',
        unit: 'Pound',
        unit_type: 'Pound',
        rate: 8,
        rate_amount: 8,
        page: 9,
        rate_raw: 'Specialty Removal | Bio Waste pathological blood | Pound | $8.00',
      }),
      row({
        row_id: 'specialty-electronic',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        canonical_category: 'specialty_removal',
        description: 'Electronic TVs computers | $200.00',
        unit: 'Unit',
        unit_type: 'Unit',
        rate: 200,
        rate_amount: 200,
        page: 9,
        rate_raw: 'Specialty Removal | Electronic Waste TVs computers | Unit | $200.00',
      }),
      row({
        row_id: 'specialty-white-goods',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        canonical_category: 'specialty_removal',
        description: 'White Goods debris | $150.00',
        unit: 'Unit',
        unit_type: 'Unit',
        rate: 150,
        rate_amount: 150,
        page: 9,
        rate_raw: 'Specialty Removal | White Goods | Unit | $150.00',
      }),
    ]);

    assert.deepEqual(rows.map((assembled) => assembled.description), [
      'Bio Waste',
      'Electronic Waste',
      'White Goods',
    ]);
    assert.ok(rows.every((assembled) => assembled.category === 'Specialty Removal'));
  });

  it('recovers personnel and equipment descriptions from noisy OCR', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'personnel-supervisor',
        category: 'Personnel',
        source_category: 'Personnel',
        canonical_category: 'personnel',
        description: 'OR EN | Supervisor | Hour | $95.00',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 95,
        rate_amount: 95,
        page: 10,
        rate_raw: 'Personnel | Operations Supervisor | Hour | $95.00',
      }),
      row({
        row_id: 'personnel-laborer',
        category: 'Personnel',
        source_category: 'Personnel',
        canonical_category: 'personnel',
        description: 'Laborer Chain Saw | $85.00',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 85,
        rate_amount: 85,
        page: 10,
        rate_raw: 'Personnel | Laborer with Chain Saw | Hour | $85.00',
      }),
      row({
        row_id: 'equipment-bucket',
        category: 'Equipment',
        source_category: 'Equipment',
        canonical_category: 'equipment',
        description: 'Bucket Truck | Hour | $175.00',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 175,
        rate_amount: 175,
        page: 10,
        rate_raw: 'Equipment | Bucket Truck | Hour | $175.00',
      }),
      row({
        row_id: 'equipment-dozer',
        category: 'Equipment',
        source_category: 'Equipment',
        canonical_category: 'equipment',
        description: 'Dozer / Hydraulic Excavator | Hour | $250.00',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 250,
        rate_amount: 250,
        page: 10,
        rate_raw: 'Equipment | Hydraulic Excavator | Hour | $250.00',
      }),
    ]);

    assert.equal(rows.find((assembled) => assembled.id === 'personnel-supervisor')?.description, 'Operations Supervisor');
    assert.equal(rows.find((assembled) => assembled.id === 'personnel-laborer')?.description, 'Laborer with Chain Saw');
    assert.equal(rows.find((assembled) => assembled.id === 'equipment-bucket')?.description, 'Bucket Truck');
    assert.equal(rows.find((assembled) => assembled.id === 'equipment-dozer')?.description, 'Hydraulic Excavator');
  });

  it('keeps unrecoverable garbage rows in needs review', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'garbage-row',
        category: 'Equipment',
        source_category: 'Equipment',
        canonical_category: 'equipment',
        description: 'Cotte vara Joo | OR EN | po . applicable allowed | $123.00',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 123,
        rate_amount: 123,
        rate_raw: 'Cotte vara Joo | OR EN | po . applicable allowed | Hour | $123.00',
      }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.description, 'Cotte vara Joo | OR EN | po . applicable allowed | $123.00');
    assert.equal(rows[0]?.confidence, 'needs_review');
  });

  it('prefers a clean canonical row over a noisy fallback row for the same pricing item', () => {
    const rows = assembleContractPricingRows(
      [
        row({
          row_id: 'rate_row:fallback:99',
          description: 'Cubic Yard | $6.90 | [Category] Vegetative Collect, Remove & Haul | [Description] 0-16 Milesfrom ROW t6 DMS',
          unit: 'miles',
          unit_type: 'miles',
          rate_raw:
            'Vegetative Collect, Remove & Haul | 0-16 Milesfrom ROW t6 DMS | Cubic Yard | $6.90 | adjacent row $7.90',
        }),
      ],
      {
        canonicalRows: [
          {
            row_id: 'contract:pdf_table_p8_t1:p8:r1',
            category: 'Vegetative Collect, Remove & Haul',
            description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
            unit: 'Cubic Yard',
            unit_price: 6.9,
            evidence_refs: [
              {
                document_id: 'doc-1',
                page_number: 8,
                table_key: 'pdf:table:p8:t1',
                row_index: 1,
                raw_text:
                  'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
              },
            ],
          },
        ],
      },
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, 'contract:pdf_table_p8_t1:p8:r1');
    assert.equal(rows[0]?.sourceKind, 'canonical');
    assert.equal(rows[0]?.sourceQuality, 'clean');
    assert.equal(rows[0]?.confidence, 'high');
  });

  it('prefers structured Exhibit A rows over matching fallback duplicates', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'exhibit_a_table:pdf:table:p8:t24:r2',
        source_kind: 'exhibit_a_table',
        description: 'from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 7.9,
        rate_amount: 7.9,
        rate_raw:
          'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles | Cubic Yard | $7.90',
      }),
      row({
        row_id: 'rate_row:fallback:duplicate-veg',
        description: '16-30 Miles from ROW to DMS',
        unit: 'Mile',
        unit_type: 'Mile',
        rate: 7.9,
        rate_amount: 7.9,
        rate_raw:
          'Vegetative Collect, Remove & Haul | 16-30 Miles from ROW to DMS | $7.90 per Mile',
      }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, 'exhibit_a_table:pdf:table:p8:t24:r2');
    assert.equal(rows[0]?.sourceKind, 'exhibit_a_table');
    assert.equal(rows[0]?.unit, 'Cubic Yard');
  });

  it('does not let a noisy canonical row replace a cleaner assembled fallback row', () => {
    const rows = assembleContractPricingRows(
      [
        row({
          row_id: 'rate_row:fallback:cleanable',
          description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
          rate_raw:
            'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
        }),
      ],
      {
        canonicalRows: [
          {
            row_id: 'contract:pdf_table_p8_t1:p8:r1',
            category: 'Vegetative Collect, Remove & Haul',
            description: 'Cubic Yard | $6.90 | [Category] Vegetative Collect, Remove & Haul | PDF table row 1 on page 8',
            unit: 'Mile',
            unit_price: 6.9,
            evidence_refs: [
              {
                document_id: 'doc-1',
                page_number: 8,
                table_key: 'pdf:table:p8:t1',
                row_index: 1,
                raw_text: 'Cubic Yard | $6.90 | [Category] Vegetative Collect, Remove & Haul',
              },
            ],
          },
        ],
      },
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, 'rate_row:fallback:cleanable');
    assert.equal(rows[0]?.sourceKind, 'fallback');
    assert.equal(rows[0]?.description, 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles');
  });

  it('does not replace broad fallback coverage with a low-coverage canonical source wholesale', () => {
    const fallbackRows = [
      row({
        row_id: 'rate_row:fallback:veg',
        description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
      }),
      row({
        row_id: 'rate_row:fallback:equipment',
        category: 'Equipment',
        source_category: 'Equipment',
        canonical_category: 'equipment',
        description: 'Bucket Truck',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 175,
        rate_amount: 175,
        page: 10,
        rate_raw: 'Equipment | Bucket Truck | Hour | $175.00',
      }),
    ];

    const rows = assembleContractPricingRows(fallbackRows, {
      canonicalRows: [
        {
          row_id: 'contract:only-one',
          category: 'Tree Operations',
          description: 'Trees with Hazardous Limbs Hanging',
          unit: 'Tree',
          unit_price: 80,
          evidence_refs: [
            {
              document_id: 'doc-1',
              page_number: 9,
              table_key: 'pdf:table:p9:t1',
              row_index: 1,
              raw_text: 'Tree Operations | Trees with Hazardous Limbs Hanging | Tree | $80.00',
            },
          ],
        },
      ],
    });

    assert.equal(rows.length, 3);
    assert.ok(rows.some((assembled) => assembled.id === 'rate_row:fallback:veg'));
    assert.ok(rows.some((assembled) => assembled.id === 'rate_row:fallback:equipment'));
    assert.ok(rows.some((assembled) => assembled.id === 'contract:only-one'));
  });

  it('scores OCR markers lower than clean source fields', () => {
    assert.equal(
      scoreContractPricingRowSourceQuality({
        category: 'Equipment',
        description: 'Bucket Truck | Hour | $175.00 | PDF text block on page 10',
        unit: 'Hour',
        rate: 175,
        page: 10,
        sourceAnchor: 'pdf:table:p10:t1:r1',
        rawText: 'Equipment | Bucket Truck | Hour | $175.00',
      }),
      'fallback',
    );
    assert.equal(
      scoreContractPricingRowSourceQuality({
        category: 'Equipment',
        description: 'Bucket Truck',
        unit: 'Hour',
        rate: 175,
        page: 10,
        sourceAnchor: 'pdf:table:p10:t1:r1',
        rawText: 'Bucket Truck',
      }),
      'clean',
    );
  });

  it('prefers clean typed rate table rows when present', () => {
    const rows = assembleContractPricingRows(
      [
        row({
          row_id: 'rate_row:fallback:noisy-equipment',
          category: 'Equipment',
          source_category: 'Equipment',
          canonical_category: 'equipment',
          description: 'Equipment | Bucket Truck | Hour | $175.00 | PDF text block on page 10',
          unit: 'Hour',
          unit_type: 'Hour',
          rate: 175,
          rate_amount: 175,
          page: 10,
          rate_raw: 'Equipment | Bucket Truck | Hour | $175.00 | PDF text block on page 10',
        }),
      ],
      {
        typedRows: [
          {
            id: 'typed-bucket',
            category: 'Equipment',
            description: 'Bucket Truck',
            unit: 'Hour',
            rate_amount: 175,
            page: 10,
            rate_raw: 'Bucket Truck',
          },
        ],
      },
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, 'typed_rate_table:typed-bucket');
    assert.equal(rows[0]?.sourceKind, 'typed_fields');
    assert.equal(rows[0]?.description, 'Bucket Truck');
  });

  it('preserves unique billable fallback rows as needs review when source quality is weak', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'rate_row:fallback:unique',
        category: 'Equipment',
        source_category: 'Equipment',
        canonical_category: 'equipment',
        description: 'Equipment | Mystery Machine | Hour | $123.00 | PDF text block on page 10',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 123,
        rate_amount: 123,
        page: 10,
        rate_raw: 'Equipment | Mystery Machine | Hour | $123.00 | PDF text block on page 10',
      }),
    ]);

    assert.equal(assembled?.id, 'rate_row:fallback:unique');
    assert.equal(assembled?.description, 'Equipment | Mystery Machine | Hour | $123.00 | PDF text block on page 10');
    assert.equal(assembled?.confidence, 'needs_review');
    assert.equal(assembled?.sourceAnchor, 'pdf:text:p8:b12');
  });

  it('cleans operator-facing Description or Scope by category without leaking recoverable OCR', () => {
    const cases: Array<{
      id: string;
      category: string;
      page: number;
      unit: string;
      description: string;
      rawText: string;
      expectedDescription: string;
      expectedConfidence: 'high' | 'medium' | 'low' | 'needs_review';
    }> = [
      {
        id: 'veg-readable',
        category: 'Vegetative Collect, Remove & Haul',
        page: 8,
        unit: 'Cubic Yard',
        description: 'ROW to DMS 31 to 60 Miles',
        rawText: 'Vegetative Collect, Remove & Haul | ROW to DMS 31 to 60 Miles | Cubic Yard | $10.90',
        expectedDescription: 'ROW to DMS 31 to 60 Miles',
        expectedConfidence: 'high',
      },
      {
        id: 'cd-damaged-60-plus',
        category: 'C&D Collect, Remove & Haul',
        page: 8,
        unit: 'Cubic Yard',
        description: '§ Haul LC SER 60+ fromROWto Miles LL DMS',
        rawText: 'C&D Collect, Remove & Haul | § Haul LC SER 60+ fromROWto Miles LL DMS | Cubic Yard | $12.00',
        expectedDescription: '§ Haul LC SER 60+ fromROWto Miles LL DMS',
        expectedConfidence: 'needs_review',
      },
      {
        id: 'management-roman',
        category: 'Management & Reduction',
        page: 8,
        unit: 'Cubic Yard',
        description: '1 Management & Reduction I',
        rawText: 'Management & Reduction | 1 Management & Reduction I | Cubic Yard | $1.00',
        expectedDescription: '1 Management & Reduction I',
        expectedConfidence: 'needs_review',
      },
      {
        id: 'final-disposal-60-plus',
        category: 'Final Disposal',
        page: 8,
        unit: 'Cubic Yard',
        description: '1 Disposal 60+ Miles from DMS to Final I',
        rawText: 'Final Disposal | 1 Disposal 60+ Miles from DMS to Final I | Cubic Yard | $4.50',
        expectedDescription: 'DMS to Final Disposal 60+ Miles',
        expectedConfidence: 'low',
      },
      {
        id: 'tree-diameter-ocr',
        category: 'Tree Operations',
        page: 9,
        unit: 'Tree',
        description: 'Hazardous Trees 25"-36" trunk CT1',
        rawText: 'Tree Operations | Hazardous Trees 25"-36" trunk CT1 | Tree | $350.00',
        expectedDescription: 'Hazardous Trees 25 to 36 inch trunk',
        expectedConfidence: 'low',
      },
      {
        id: 'tree-unclear-tt',
        category: 'Tree Operations',
        page: 9,
        unit: 'Tree',
        description: 'Operations ** TT to 36"',
        rawText: 'Tree Operations | Operations ** TT to 36" | Tree | $100.00',
        expectedDescription: 'Operations ** TT to 36"',
        expectedConfidence: 'needs_review',
      },
      {
        id: 'equipment-tub-grinder',
        category: 'Equipment',
        page: 10,
        unit: 'Hour',
        description: '_ Tub Grinder (800-1,000HP)',
        rawText: 'Equipment | _ Tub Grinder (800-1,000HP) | Hour | $275.00',
        expectedDescription: 'Tub Grinder 800 to 1,000 HP',
        expectedConfidence: 'low',
      },
      {
        id: 'equipment-wheel-loader',
        category: 'Equipment',
        page: 10,
        unit: 'Hour',
        description: 'Equiporent WheelLoaderwithdebrisgrapple',
        rawText: 'Equipment | Equiporent WheelLoaderwithdebrisgrapple | Hour | $185.00',
        expectedDescription: 'Wheel Loader with Debris Grapple',
        expectedConfidence: 'low',
      },
      {
        id: 'equipment-trackhoe',
        category: 'Equipment',
        page: 10,
        unit: 'Hour',
        description: '_ Trackhoo withbucket&thumb --',
        rawText: 'Equipment | _ Trackhoo withbucket&thumb -- | Hour | $220.00',
        expectedDescription: 'Trackhoe with Bucket and Thumb',
        expectedConfidence: 'low',
      },
      {
        id: 'equipment-backhoe',
        category: 'Equipment',
        page: 10,
        unit: 'Hour',
        description: '~~ Rubber TireBackhoe',
        rawText: 'Equipment | ~~ Rubber TireBackhoe | Hour | $145.00',
        expectedDescription: 'Rubber Tire Backhoe',
        expectedConfidence: 'low',
      },
      {
        id: 'equipment-transports',
        category: 'Equipment',
        page: 11,
        unit: 'Hour',
        description: 'Transports, II',
        rawText: 'Equipment | Transports, II | Hour | $115.00',
        expectedDescription: 'Equipment Transports',
        expectedConfidence: 'low',
      },
      {
        id: 'specialty-carcass',
        category: 'Specialty Removal',
        page: 9,
        unit: 'Pound',
        description: 'Specialty Removal oo BE $pplicable/allowed Carcass Removal',
        rawText: 'Specialty Removal | Specialty Removal oo BE $pplicable/allowed Carcass Removal | Pound | $8.00',
        expectedDescription: 'Carcass Removal',
        expectedConfidence: 'low',
      },
      {
        id: 'specialty-electronic',
        category: 'Specialty Removal',
        page: 9,
        unit: 'Unit',
        description: 'iSpeofatty Removal Electronic Waste (TVs, computers,',
        rawText: 'Specialty Removal | iSpeofatty Removal Electronic Waste (TVs, computers, | Unit | $200.00',
        expectedDescription: 'Electronic Waste',
        expectedConfidence: 'low',
      },
      {
        id: 'specialty-unrecoverable',
        category: 'Specialty Removal',
        page: 9,
        unit: 'Unit',
        description: 'rooemyonment SpeofattyRemoval --- Fen unknown dment ond I',
        rawText: 'Specialty Removal | rooemyonment SpeofattyRemoval --- Fen unknown dment ond I | Unit | $20.00',
        expectedDescription: 'rooemyonment SpeofattyRemoval --- Fen unknown dment ond I',
        expectedConfidence: 'needs_review',
      },
    ];

    for (const entry of cases) {
      const [assembled] = assembleContractPricingRows([
        row({
          row_id: `exhibit_a_table:${entry.id}`,
          source_kind: 'exhibit_a_table',
          category: entry.category,
          source_category: entry.category,
          material_type: entry.category,
          canonical_category: entry.category.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          page: entry.page,
          description: entry.description,
          unit: entry.unit,
          unit_type: entry.unit,
          rate: entry.id === 'veg-readable' ? 10.9 : 20,
          rate_amount: entry.id === 'veg-readable' ? 10.9 : 20,
          rate_raw: entry.rawText,
        }),
      ]);

      assert.equal(assembled?.description, entry.expectedDescription, entry.id);
      assert.equal(assembled?.confidence, entry.expectedConfidence, entry.id);
      assert.equal(assembled?.rawText, entry.rawText, entry.id);
      if (assembled?.confidence !== 'needs_review') {
        assert.ok(!assembled?.description.includes('Speofatty'), entry.id);
        assert.ok(!assembled?.description.includes('Equiporent'), entry.id);
      }
    }
  });

  it('exposes description cleanup decisions without adding validator dependencies', () => {
    const cleanup = cleanContractRateDescriptionForDisplay({
      category: 'Equipment',
      description: 'Equiporent WheelLoaderwithdebrisgrapple',
      rawText: 'Equipment | Equiporent WheelLoaderwithdebrisgrapple | Hour | $185.00',
      unit: 'Hour',
      rate: 185,
      page: 10,
      source_kind: 'exhibit_a_table',
    });
    const source = readFileSync('lib/contracts/contractPricingAssembly.ts', 'utf8');

    assert.deepEqual(cleanup, {
      displayDescription: 'Wheel Loader with Debris Grapple',
      descriptionQuality: 'clean',
      stateHint: 'derived',
    });
    assert.equal(source.includes('@/lib/validator'), false);
    assert.equal(source.includes('contractValidation'), false);
  });

  it('uses the row rate instead of adjacent raw rates', () => {
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'adjacent-rates',
        description: 'Cubic Yard | $7.90 | [Category] Vegetative Collect, Remove & Haul | 0-16 Milesfrom ROW t6 DMS',
        rate_raw:
          'Vegetative Collect, Remove & Haul | 0-16 Milesfrom ROW t6 DMS | Cubic Yard | $6.90 | adjacent row $7.90',
        rate: 6.9,
        rate_amount: 6.9,
      }),
    ]);

    assert.equal(assembled?.rate, 6.9);
    assert.equal(assembled?.description, 'ROW to DMS 0 to 15 Miles');
  });

  it('recovers the page 8 $6.90 unincorporated row description without changing raw trace', () => {
    const rawText = 'Vegetative Collect; Remove, & Haul -16 Miles from R OW a rors DMS uble Yard | $6.90';
    const [assembled] = assembleContractPricingRows([
      row({
        row_id: 'exhibit_a_table:pdf:table:p8:t26:r2:v1',
        source_kind: 'exhibit_a_table',
        category: 'Vegetative Collect, Remove & Haul',
        source_category: 'Vegetative Collect, Remove & Haul',
        material_type: 'Vegetative Collect, Remove & Haul',
        page: 8,
        description: 'Vegetative Collect; Remove, & Haul -16 Miles from R OW a rors DMS uble Yard',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 6.9,
        rate_amount: 6.9,
        rate_raw: rawText,
        raw_cells: [
          'Vegetative Collect; Remove, & Haul from Unincorporated Neighborhoods',
          '-16 Miles from R OW a rors DMS',
          'Cubic Yard | $6.90',
        ],
        confidence: 'needs_review',
      }),
    ]);

    assert.equal(assembled?.description, 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles');
    assert.equal(assembled?.rate, 6.9);
    assert.equal(assembled?.confidence, 'low');
    assert.equal(assembled?.rawText, rawText);
  });

  it('corrects source-backed OCR rate misreads and keeps corrected rows derived', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'tree-6-12-ocr-rate',
        source_kind: 'exhibit_a_table',
        category: 'Tree Operations',
        source_category: 'Tree Operations',
        material_type: 'Tree Operations',
        page: 9,
        description: 'Hazardous Trees 6"-12" trunk',
        unit: 'Tree',
        unit_type: 'Tree',
        rate: 96,
        rate_amount: 96,
        rate_raw: 'Tree Operations | Hazardous Trees 6"-12" trunk | Tree | $96.00',
      }),
      row({
        row_id: 'bucket-truck-dropped-zero',
        source_kind: 'exhibit_a_table',
        category: 'Equipment',
        source_category: 'Equipment',
        material_type: 'Equipment',
        page: 10,
        description: '(Bucket Truck (with 50° - 80" Arm)',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 20,
        rate_amount: 20,
        rate_raw: 'Equipment | Bucket Truck (with 50° - 80" Arm) | Hour | $20',
      }),
      row({
        row_id: 'tree-hanging-limbs-merged-rate',
        source_kind: 'exhibit_a_table',
        category: 'Tree Operations',
        source_category: 'Tree Operations',
        material_type: 'Tree Operations',
        page: 9,
        description: 'Tree Operations Hazardous Trees -- 49"+ trunk diameter Tree Operations Trees with Hazardous Limbs Hanging',
        unit: 'Tree',
        unit_type: 'Tree',
        rate: 315,
        rate_amount: 315,
        rate_raw: 'Tree Operations | Trees with Hazardous Limbs Hanging | Tree | $315.00 | source text $80.00',
      }),
      row({
        row_id: 'pickup-truck-source-rate',
        source_kind: 'exhibit_a_table',
        category: 'Equipment',
        source_category: 'Equipment',
        material_type: 'Equipment',
        page: 11,
        description: 'Pickup Truck',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 95,
        rate_amount: 95,
        rate_raw: 'Equipment | Pickup Truck | Hour | $25.00',
      }),
      row({
        row_id: 'traffic-control-ocr-rate',
        source_kind: 'exhibit_a_table',
        category: 'Personnel',
        source_category: 'Personnel',
        material_type: 'Personnel',
        page: 10,
        description: 'Traffic Control (Flag Person)',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 66,
        rate_amount: 66,
        rate_raw: 'Personnel | Traffic Control (Flag Person) | Hour | $66.00',
      }),
    ]);

    const byId = new Map(rows.map((assembled) => [assembled.id, assembled]));
    assert.equal(byId.get('tree-6-12-ocr-rate')?.rate, 95);
    assert.equal(byId.get('tree-6-12-ocr-rate')?.description, 'Hazardous Trees 6 to 12 inch trunk');
    assert.notEqual(byId.get('tree-6-12-ocr-rate')?.confidence, 'high');
    assert.equal(byId.get('bucket-truck-dropped-zero')?.rate, 200);
    assert.equal(byId.get('bucket-truck-dropped-zero')?.description, 'Bucket Truck with 50 to 60 foot Arm');
    assert.notEqual(byId.get('bucket-truck-dropped-zero')?.confidence, 'high');
    assert.equal(byId.get('tree-hanging-limbs-merged-rate')?.rate, 80);
    assert.equal(byId.get('tree-hanging-limbs-merged-rate')?.description, 'Trees with Hazardous Limbs Hanging');
    assert.equal(byId.get('pickup-truck-source-rate')?.rate, 25);
    assert.equal(byId.get('pickup-truck-source-rate')?.description, 'Pickup Truck');
    assert.equal(byId.get('traffic-control-ocr-rate')?.rate, 55);
    assert.notEqual(byId.get('traffic-control-ocr-rate')?.confidence, 'high');
  });

  it('does not trust zero-rate C&D rows', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'cd-zero-rate',
        source_kind: 'exhibit_a_table',
        category: 'C&D Collect, Remove & Haul',
        source_category: 'C&D Collect, Remove & Haul',
        material_type: 'C&D Collect, Remove & Haul',
        page: 8,
        description: 'Raw row needs review',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 0,
        rate_amount: 0,
        rate_raw: 'C&D Collect, Remove & Haul | Raw row needs review | Cubic Yard | $0.00',
      }),
    ]);

    assert.ok(rows.length === 0 || rows[0]?.confidence === 'needs_review');
  });

  it('suppresses personnel-merge Pickup Truck rows that only expose the supervisor rate', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'pickup-truck-personnel-merge',
        source_kind: 'exhibit_a_table',
        category: 'Equipment',
        source_category: 'Equipment',
        material_type: 'Equipment',
        page: 10,
        description: 'Pickup Truck',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 95,
        rate_amount: 95,
        rate_raw: 'Hour $95.00 Crew Foreman: phone, and pickup truck Hour $95.00',
      }),
    ]);

    assert.equal(rows.some((assembled) => assembled.id === 'pickup-truck-personnel-merge'), false);
  });

  it('keeps management burning descriptions distinct by rate row', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'management-grinding',
        source_kind: 'exhibit_a_table',
        category: 'Management & Reduction',
        source_category: 'Management & Reduction',
        material_type: 'Management & Reduction',
        page: 8,
        description: 'Grinding and Chipping Vegetative Debris',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 2.25,
        rate_amount: 2.25,
        rate_raw: 'Management & Reduction | Grinding and Chipping Vegetative Debris | Cubic Yard | $2.25',
      }),
      row({
        row_id: 'management-air-curtain',
        source_kind: 'exhibit_a_table',
        category: 'Management & Reduction',
        source_category: 'Management & Reduction',
        material_type: 'Management & Reduction',
        page: 8,
        description: 'Grinding and Chipping Vegetative Debris',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 1.5,
        rate_amount: 1.5,
        rate_raw: 'Management & Reduction | Air Curtain Burning of Vegetative Debris | Cubic Yard | $1.50',
      }),
      row({
        row_id: 'management-open-burning',
        source_kind: 'exhibit_a_table',
        category: 'Management & Reduction',
        source_category: 'Management & Reduction',
        material_type: 'Management & Reduction',
        page: 8,
        description: 'Grinding and Chipping Vegetative Debris',
        unit: 'Cubic Yard',
        unit_type: 'Cubic Yard',
        rate: 1,
        rate_amount: 1,
        rate_raw: 'Management & Reduction | Open Burning of Vegetative Debris | Cubic Yard | $1.00',
      }),
    ]);

    const byRate = new Map(rows.map((assembled) => [assembled.rate, assembled.description]));
    assert.equal(byRate.get(2.25), 'Grinding and Chipping Vegetative Debris');
    assert.equal(byRate.get(1.5), 'Air Curtain Burning of Vegetative Debris');
    assert.equal(byRate.get(1), 'Open Burning of Vegetative Debris');
  });

  it('normalizes remaining equipment and personnel OCR fragments', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'equipment-ansports',
        source_kind: 'exhibit_a_table',
        category: 'Equipment',
        source_category: 'Equipment',
        material_type: 'Equipment',
        page: 11,
        description: 'ansports',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 115,
        rate_amount: 115,
        rate_raw: 'quipment | Equipment ansports | Hour | $115.00',
      }),
      row({
        row_id: 'personnel-laborer-colon',
        source_kind: 'exhibit_a_table',
        category: 'Personnel',
        source_category: 'Personnel',
        material_type: 'Personnel',
        page: 10,
        description: ': Laborer-with Chain Saw',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 45,
        rate_amount: 45,
        rate_raw: 'Personnel | : Laborer-with Chain Saw | Hour | $45.00',
      }),
      row({
        row_id: 'equipment-service-truck',
        source_kind: 'exhibit_a_table',
        category: 'Equipment',
        source_category: 'Equipment',
        material_type: 'Equipment',
        page: 11,
        description: 'Quipmen Ervice Truck For Hi Equipm Ont',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 50,
        rate_amount: 50,
        rate_raw: 'quipmen ervice Truck for Hi Equipm ont | Hour | $50.00',
      }),
      row({
        row_id: 'equipment-motor-grader',
        source_kind: 'exhibit_a_table',
        category: 'Equipment',
        source_category: 'Equipment',
        material_type: 'Equipment',
        page: 11,
        description: 'Motor Gradgr with 12’ Blade - CAT125 ore uivatent.',
        unit: 'Hour',
        unit_type: 'Hour',
        rate: 160,
        rate_amount: 160,
        rate_raw: 'Equipment | Motor Gradgr with 12’ Blade - CAT125 ore uivatent. | Hour | $160.00',
      }),
    ]);

    const byId = new Map(rows.map((assembled) => [assembled.id, assembled.description]));
    assert.equal(byId.get('equipment-ansports'), 'Equipment Transports');
    assert.equal(byId.get('personnel-laborer-colon'), 'Laborer with Chain Saw');
    assert.equal(byId.get('equipment-service-truck'), 'Service Truck');
    assert.equal(byId.get('equipment-motor-grader'), 'Motor Grader with 12 foot Blade - CAT125 or equivalent');
  });

  it('recovers page 9 specialty units from source-backed descriptions', () => {
    const rows = assembleContractPricingRows([
      row({
        row_id: 'specialty-carcass-unit',
        source_kind: 'exhibit_a_table',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        material_type: 'Specialty Removal',
        page: 9,
        description: 'Carcass Removal',
        unit: 'N/A',
        unit_type: 'N/A',
        rate: 8,
        rate_amount: 8,
        rate_raw: 'Specialty Removal | Carcass Removal (animal remains) | Pound | $8.00',
      }),
      row({
        row_id: 'specialty-soil-unit',
        source_kind: 'exhibit_a_table',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        material_type: 'Specialty Removal',
        page: 9,
        description: 'Soil & Sand Collection and Screening',
        unit: 'N/A',
        unit_type: 'N/A',
        rate: 10,
        rate_amount: 10,
        rate_raw: 'Specialty Removal | Soil & Sand Collection and Screening | Cubic Yard | $10.00',
      }),
      row({
        row_id: 'specialty-freon-unit',
        source_kind: 'exhibit_a_table',
        category: 'Specialty Removal',
        source_category: 'Specialty Removal',
        material_type: 'Specialty Removal',
        page: 9,
        description: 'Freon anagement and Recyclin; nit 1,',
        unit: 'N/A',
        unit_type: 'N/A',
        rate: 45,
        rate_amount: 45,
        rate_raw: 'Specialty Removal | Freon anagement and Recyclin; nit 1 | Unit | $45.00',
      }),
    ]);

    const byId = new Map(rows.map((assembled) => [assembled.id, assembled]));
    assert.equal(byId.get('specialty-carcass-unit')?.unit, 'Pound');
    assert.equal(byId.get('specialty-soil-unit')?.unit, 'Cubic Yard');
    assert.equal(byId.get('specialty-freon-unit')?.description, 'Freon Management and Recycling');
    assert.equal(byId.get('specialty-freon-unit')?.unit, 'Unit');
  });

  it('formats $6.90 correctly', () => {
    assert.equal(formatContractPricingRate(6.9), '$6.90');
  });

  it('preserves raw text and source anchor', () => {
    const [assembled] = assembleContractPricingRows([row()]);
    assert.equal(assembled?.sourceAnchor, 'pdf:text:p8:b12');
    assert.equal(
      assembled?.rawText,
      'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
    );
  });
});
