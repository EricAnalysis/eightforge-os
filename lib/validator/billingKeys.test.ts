import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  deriveBillingKeysForInvoiceLine,
  deriveBillingKeysForRateScheduleItem,
  deriveBillingKeysForTransactionRecord,
  deriveBillingRateKey,
  deriveDescriptionMatchKey,
  deriveInvoiceRateKey,
  matchTransactionRowsForInvoiceGroup,
  normalizeInvoiceNumber,
  deriveSiteMaterialKey,
  findOperationalRateScheduleCandidatesForInvoiceLine,
  indexRateScheduleItemsByCanonicalKeys,
  matchRateScheduleItemForInvoiceLine,
  normalizeDisposalSite,
  normalizeMaterial,
  normalizeRateCode,
  normalizeRateDescription,
  normalizeServiceItem,
  normalizeSiteType,
} from '@/lib/validator/billingKeys';

describe('billingKeys', () => {
  it('normalizes rate codes so 1A variants match', () => {
    assert.equal(normalizeRateCode('1A'), '1A');
    assert.equal(normalizeRateCode('1a'), '1A');
    assert.equal(normalizeRateCode('  1 A  '), '1A');
    assert.equal(normalizeRateCode('1-A'), '1A');
    assert.equal(normalizeRateCode('1 A'), '1A');
  });

  it('normalizes descriptions for stable description_match_key', () => {
    assert.equal(
      deriveDescriptionMatchKey('  Debris  Hauling  '),
      'debris hauling',
    );
    assert.equal(
      deriveDescriptionMatchKey('Debris-Hauling!!'),
      'debris hauling',
    );
    assert.equal(
      normalizeRateDescription('Mixed   C&D   loads'),
      'mixed c d loads',
    );
  });

  it('deriveBillingRateKey prefers rate code, then description, then service item + material', () => {
    assert.equal(
      deriveBillingRateKey({ rate_code: ' 1a ', rate_description: 'ignored when code exists' }),
      '1A',
    );
    assert.equal(
      deriveBillingRateKey({ rate_code: null, rate_description: '  1 B ' }),
      '1B',
    );
    assert.equal(
      deriveBillingRateKey({ rate_code: null, rate_description: 'Tipping Fee - MSW' }),
      'desc:tipping fee msw',
    );
    assert.equal(
      deriveBillingRateKey({
        rate_code: null,
        rate_description: null,
        service_item: 'Roll-off',
        material: 'MSW',
      }),
      'sm:roll off|msw',
    );
  });

  it('aligns material and service item normalization', () => {
    assert.equal(normalizeMaterial('  MSW  '), 'msw');
    assert.equal(normalizeServiceItem('Roll-Off Service'), 'roll off service');
  });

  it('deriveSiteMaterialKey joins site and material with stable prefixes', () => {
    assert.equal(
      deriveSiteMaterialKey({
        disposal_site: 'North Landfill',
        material: 'Vegetative',
      }),
      's:north landfill|m:vegetative',
    );
    assert.equal(
      deriveSiteMaterialKey({ material: 'Only Mat' }),
      'm:only mat',
    );
  });

  it('deriveInvoiceRateKey combines invoice number and billing_rate_key', () => {
    assert.equal(
      deriveInvoiceRateKey('2026-002', '1A'),
      '2026002::1A',
    );
    assert.equal(deriveInvoiceRateKey(null, '1A'), null);
    assert.equal(deriveInvoiceRateKey('2026-002', null), null);
  });

  it('normalizes site type and disposal site like other free-text fields', () => {
    assert.equal(normalizeSiteType('  MSW  Cell  '), 'msw cell');
    assert.equal(
      normalizeDisposalSite('North County / Landfill #2'),
      'north county landfill 2',
    );
  });

  it('uses desc: prefix for non-code descriptions so keys stay disambiguated', () => {
    assert.equal(
      deriveBillingRateKey({
        rate_code: null,
        rate_description: 'Commercial tipping fee for mixed construction debris loads',
      }),
      'desc:commercial tipping fee for mixed construction debris loads',
    );
  });

  it('aligns billing_rate_key across contract schedule, invoice line, and transaction rows', () => {
    const schedule = deriveBillingKeysForRateScheduleItem({
      rate_code: 'RC-01',
      description: 'Debris Hauling',
      material_type: null,
      unit_type: 'CY',
    });
    const invoice = deriveBillingKeysForInvoiceLine({
      rate_code: 'RC-01',
      description: 'Debris Hauling',
    });
    const tx = deriveBillingKeysForTransactionRecord({
      invoice_number: 'INV-100',
      rate_code: 'RC-01',
      rate_description: 'Debris Hauling',
    });

    assert.equal(schedule.billing_rate_key, 'RC01');
    assert.equal(invoice.billing_rate_key, 'RC01');
    assert.equal(tx.billing_rate_key, 'RC01');
    assert.equal(schedule.description_match_key, invoice.description_match_key);
    assert.equal(invoice.description_match_key, tx.description_match_key);
    assert.equal(tx.invoice_rate_key, 'INV100::RC01');
  });

  it('deriveBillingKeysForTransactionRecord matches inline transaction normalization', () => {
    const keys = deriveBillingKeysForTransactionRecord({
      invoice_number: null,
      rate_code: null,
      rate_description: 'Load Monitoring',
      service_item: 'Monitoring',
      material: 'C&D',
      disposal_site: null,
      site_type: 'DMS',
    });
    assert.equal(keys.billing_rate_key, 'LOADMONITORING');
    assert.equal(keys.site_material_key, 's:dms|m:c d');
    assert.equal(keys.invoice_rate_key, null);
  });

  it('matches by normalized description when an invoice rate code is wrong but the pricing concept is the same', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      {
        record_id: 'schedule:desc',
        rate_code: null,
        description: 'Debris Hauling',
        material_type: 'Vegetative',
        unit_type: 'CY',
        rate_amount: 100,
        ...deriveBillingKeysForRateScheduleItem({
          rate_code: null,
          description: 'Debris Hauling',
          material_type: 'Vegetative',
          unit_type: 'CY',
        }),
      },
    ]);

    const line = {
      rate_code: 'WRONG-01',
      description: 'debris hauling',
      material: 'Vegetative',
      unit_price: 100,
      ...deriveBillingKeysForInvoiceLine({
        rate_code: 'WRONG-01',
        description: 'debris hauling',
        material: 'Vegetative',
      }),
    };

    const result = matchRateScheduleItemForInvoiceLine(line, scheduleIndex);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.match?.record_id, 'schedule:desc');
  });

  it('matches by service item plus material when neither source has a usable rate code or description', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      {
        record_id: 'schedule:sm',
        rate_code: null,
        description: null,
        material_type: 'C&D',
        unit_type: 'load',
        service_item: 'Monitoring',
        rate_amount: 55,
        ...deriveBillingKeysForRateScheduleItem({
          rate_code: null,
          description: null,
          material_type: 'C&D',
          unit_type: 'load',
          service_item: 'Monitoring',
        }),
      },
    ]);

    const line = {
      rate_code: null,
      description: null,
      material: 'C&D',
      service_item: 'Monitoring',
      unit_price: 55,
      ...deriveBillingKeysForInvoiceLine({
        rate_code: null,
        description: null,
        material: 'C&D',
        service_item: 'Monitoring',
      }),
    };

    const result = matchRateScheduleItemForInvoiceLine(line, scheduleIndex);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.match?.record_id, 'schedule:sm');
  });

  it('uses operational fallback when invoice code is only an operational alias', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      {
        record_id: 'schedule:veg-0-15',
        rate_code: null,
        description:
          'Cubic Yard | Vegetative Collect, Remove & Haul | 0-15 Miles from ROW to DMS | from Unincorporated Neighborhoods',
        material_type: 'Vegetative',
        unit_type: 'miles',
        canonical_category: 'vegetative_removal',
        rate_amount: 6.9,
        raw_value: {
          source_anchor: 'pdf:text:p8:b2',
          unit: 'Cubic Yard',
        },
        ...deriveBillingKeysForRateScheduleItem({
          rate_code: null,
          description:
            'Cubic Yard | Vegetative Collect, Remove & Haul | 0-15 Miles from ROW to DMS | from Unincorporated Neighborhoods',
          material_type: 'Vegetative',
          unit_type: 'miles',
        }),
      },
    ]);

    const result = matchRateScheduleItemForInvoiceLine({
      rate_code: '1A',
      description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
      material: 'Vegetative',
      canonical_category: 'vegetative_removal',
      unit_price: 6.9,
    }, scheduleIndex);

    assert.equal(result.match_reason, 'operational_fallback');
    assert.equal(result.candidate_count, 1);
    assert.equal(result.ambiguous, false);
    assert.equal(result.match?.record_id, 'schedule:veg-0-15');
  });

  it('does not let rate alone create an operational match', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      {
        record_id: 'schedule:unrelated',
        rate_code: null,
        description: 'Temporary road repair crew standby',
        material_type: 'Road Repair',
        unit_type: 'hour',
        canonical_category: 'road_repair',
        rate_amount: 6.9,
        ...deriveBillingKeysForRateScheduleItem({
          rate_code: null,
          description: 'Temporary road repair crew standby',
          material_type: 'Road Repair',
          unit_type: 'hour',
        }),
      },
    ]);

    const result = matchRateScheduleItemForInvoiceLine({
      rate_code: '1A',
      description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
      material: 'Vegetative',
      canonical_category: 'vegetative_removal',
      unit_price: 6.9,
    }, scheduleIndex);

    assert.equal(result.candidate_count, 0);
    assert.equal(result.match, null);
  });

  it('keeps exact billing-key matches preferred over operational fallback', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      {
        record_id: 'schedule:exact',
        rate_code: '1A',
        description: 'Legacy rate-code row',
        material_type: 'Vegetative',
        unit_type: 'CY',
        canonical_category: 'vegetative_removal',
        rate_amount: 6.9,
        ...deriveBillingKeysForRateScheduleItem({
          rate_code: '1A',
          description: 'Legacy rate-code row',
          material_type: 'Vegetative',
          unit_type: 'CY',
        }),
      },
      {
        record_id: 'schedule:operational',
        rate_code: null,
        description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
        material_type: 'Vegetative',
        unit_type: 'CY',
        canonical_category: 'vegetative_removal',
        rate_amount: 6.9,
        ...deriveBillingKeysForRateScheduleItem({
          rate_code: null,
          description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
          material_type: 'Vegetative',
          unit_type: 'CY',
        }),
      },
    ]);

    const result = matchRateScheduleItemForInvoiceLine({
      rate_code: '1A',
      description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
      material: 'Vegetative',
      canonical_category: 'vegetative_removal',
      unit_price: 6.9,
    }, scheduleIndex);

    assert.equal(result.match_reason, 'exact_billing_key');
    assert.equal(result.match?.record_id, 'schedule:exact');
  });

  it('exposes multiple equally strong operational candidates as ambiguous', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      'a',
      'b',
    ].map((suffix) => ({
      record_id: `schedule:veg-${suffix}`,
      rate_code: null,
      description:
        `Cubic Yard | Vegetative Collect Remove Haul | ${suffix === 'a' ? 'North' : 'South'} Unincorporated Neighborhoods ROW to DMS 0-15 Miles`,
      material_type: 'Vegetative',
      unit_type: 'CY',
      canonical_category: 'vegetative_removal',
      rate_amount: 6.9,
      ...deriveBillingKeysForRateScheduleItem({
        rate_code: null,
        description:
          `Cubic Yard | Vegetative Collect Remove Haul | ${suffix === 'a' ? 'North' : 'South'} Unincorporated Neighborhoods ROW to DMS 0-15 Miles`,
        material_type: 'Vegetative',
        unit_type: 'CY',
      }),
    })));

    const operational = findOperationalRateScheduleCandidatesForInvoiceLine({
      rate_code: '1A',
      description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
      material: 'Vegetative',
      canonical_category: 'vegetative_removal',
      unit_price: 6.9,
    }, scheduleIndex);

    assert.equal(operational.candidate_count, 2);
    assert.equal(operational.ambiguous, true);
    assert.equal(operational.match, null);

    const result = matchRateScheduleItemForInvoiceLine({
      rate_code: '1A',
      description: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15',
      material: 'Vegetative',
      canonical_category: 'vegetative_removal',
      unit_price: 6.9,
    }, scheduleIndex);

    assert.equal(result.ambiguous, true);
    assert.equal(result.match, null);
  });

  const scheduleItem = (params: {
    id: string;
    description: string;
    rate: number;
    category: string;
    unit?: string;
    rateCode?: string | null;
    sourceQuality?: string | null;
    confidence?: string | null;
  }) => ({
    record_id: params.id,
    rate_code: params.rateCode ?? null,
    description: params.description,
    material_type: params.category,
    source_category: params.category,
    unit_type: params.unit ?? 'Cubic Yard',
    canonical_category: params.category,
    rate_amount: params.rate,
    source_kind: 'exhibit_a_table',
    source_quality: params.sourceQuality ?? 'clean',
    confidence: params.confidence ?? 'low',
    raw_value: {
      source_kind: 'exhibit_a_table',
      description: params.description,
      source_category: params.category,
      unit: params.unit ?? 'Cubic Yard',
      rate: params.rate,
    },
    ...deriveBillingKeysForRateScheduleItem({
      rate_code: params.rateCode ?? null,
      description: params.description,
      material_type: params.category,
      unit_type: params.unit ?? 'Cubic Yard',
    }),
  });

  const invoiceLine = (params: {
    rateCode?: string | null;
    description: string;
    rate: number;
    category: string;
    unit?: string;
  }) => ({
    rate_code: params.rateCode ?? null,
    description: params.description,
    material: params.category,
    canonical_category: params.category,
    unit_price: params.rate,
    unit_type: params.unit ?? 'Cubic Yard',
    ...deriveBillingKeysForInvoiceLine({
      rate_code: params.rateCode ?? null,
      description: params.description,
      material: params.category,
    }),
  });

  it.each([
    [
      '1A',
      'Vegetative Collect Remove Haul Unincorporated Neighborhood ROW to DMS 0 to 15',
      6.9,
      'vegetative_removal',
      'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
      'rate:veg-unincorp-0-15',
    ],
    [
      '1B',
      'Vegetative Collect Remove Haul Unincorporated Neighborhood ROW to DMS 16 to 30',
      7.9,
      'vegetative_removal',
      'from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles',
      'rate:veg-unincorp-16-30',
    ],
    [
      '1E',
      'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15',
      13.5,
      'vegetative_removal',
      'from Rural Areas ROW to DMS 0 to 15 Miles',
      'rate:veg-rural-0-15',
    ],
    [
      '1F',
      'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30',
      14.5,
      'vegetative_removal',
      'from Rural Areas ROW to DMS 16 to 30 Miles',
      'rate:veg-rural-16-30',
    ],
    [
      '6A',
      'Trees with Hazardous Limbs Hanging',
      80,
      'tree_operations',
      'Trees with Hazardous Limbs Hanging',
      'rate:tree-hanging-limbs',
    ],
    [
      '5A',
      'Hazardous Trees 6 to 12 inch trunk',
      95,
      'tree_operations',
      'Hazardous Trees 6 to 12 inch trunk',
      'rate:tree-6-12',
    ],
    [
      '3B',
      'Final Disposal DMS to Final Disposal 16 to 30 Miles',
      3.75,
      'final_disposal',
      'DMS to Final Disposal 16 to 30 Miles',
      'rate:final-disposal-16-30',
    ],
    [
      '3C',
      'Final Disposal DMS to Final Disposal 31 to 60 Miles',
      4.25,
      'final_disposal',
      'DMS to Final Disposal 31 to 60 Miles',
      'rate:final-disposal-31-60',
    ],
    [
      '2B',
      'Grinding and Chipping Vegetative Debris',
      2.25,
      'management_reduction',
      'Grinding and Chipping Vegetative Debris',
      'rate:management-grinding',
    ],
    [
      '2A',
      'Air Curtain Burning or Management and Reduction',
      1.5,
      'management_reduction',
      'Air Curtain Burning of Vegetative Debris',
      'rate:management-air-curtain',
    ],
    [
      '2A',
      'Management Reduction Preparation Management Segregating Material at DMS',
      1.5,
      'management_reduction',
      'Preparation, Management, and segregating materials from recovery at DMS',
      'rate:management-preparation',
    ],
  ])('matches invoice %s without requiring a contract rate code', (
    invoiceRateCode,
    lineDescription,
    rate,
    category,
    contractDescription,
    expectedRecordId,
  ) => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      scheduleItem({
        id: expectedRecordId,
        description: contractDescription,
        rate,
        category,
        unit: category === 'tree_operations' ? 'Tree' : 'Cubic Yard',
      }),
    ]);

    const result = matchRateScheduleItemForInvoiceLine(invoiceLine({
      rateCode: invoiceRateCode,
      description: lineDescription,
      rate,
      category,
      unit: category === 'tree_operations' ? 'Tree' : 'Cubic Yard',
    }), scheduleIndex);

    assert.equal(result.match?.record_id, expectedRecordId);
    assert.notEqual(result.match_reason, 'exact_billing_key');
  });

  it('matches hanging-limbs invoice line against needs_review contract row when full description preserves removal tokens', () => {
    // Pre-fix: contract description was truncated to 'Trees with Hazardous Limbs Hanging',
    // giving a token score of 5/9 = 0.556 — below the 0.75 needs_review threshold.
    // Post-fix: full description includes 'Removal 2" per Tree', raising score to 7/9 ≈ 0.778.
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      scheduleItem({
        id: 'rate:tree-hanging-limbs',
        description: 'Trees with Hazardous Limbs Hanging Removal 2" per',
        rate: 80,
        category: 'tree_operations',
        unit: 'Tree',
        confidence: 'needs_review',
      }),
    ]);

    const result = matchRateScheduleItemForInvoiceLine(invoiceLine({
      description: 'Trees with Hazardous Limbs Hanging Removal >2" diameter per Tree',
      rate: 80,
      category: 'tree_operations',
      unit: 'Tree',
    }), scheduleIndex);

    assert.equal(result.match?.record_id, 'rate:tree-hanging-limbs');
    assert.equal(result.match_reason, 'operational_fallback');
  });

  it('does not match an exact rate when the categories are incompatible', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      scheduleItem({
        id: 'rate:veg',
        description: 'from Rural Areas ROW to DMS 0 to 15 Miles',
        rate: 13.5,
        category: 'vegetative_removal',
      }),
    ]);

    const result = matchRateScheduleItemForInvoiceLine(invoiceLine({
      rateCode: '5A',
      description: 'Hazardous Trees 6 to 12 inch trunk',
      rate: 13.5,
      category: 'tree_operations',
      unit: 'Tree',
    }), scheduleIndex);

    assert.equal(result.match, null);
  });

  it('does not match when the category fits but the rate is wrong', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      scheduleItem({
        id: 'rate:tree-6-12',
        description: 'Hazardous Trees 6 to 12 inch trunk',
        rate: 95,
        category: 'tree_operations',
        unit: 'Tree',
      }),
    ]);

    const result = matchRateScheduleItemForInvoiceLine(invoiceLine({
      rateCode: '5A',
      description: 'Hazardous Trees 6 to 12 inch trunk',
      rate: 96,
      category: 'tree_operations',
      unit: 'Tree',
    }), scheduleIndex);

    assert.equal(result.match, null);
  });

  it('does not let invoice rate-code mismatch alone prevent a semantic match', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      scheduleItem({
        id: 'rate:veg-16-30',
        rateCode: 'CONTRACT-ROW-7-90',
        description: 'from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles',
        rate: 7.9,
        category: 'vegetative_removal',
      }),
    ]);

    const result = matchRateScheduleItemForInvoiceLine(invoiceLine({
      rateCode: '1B',
      description: 'Vegetative Collect Remove Haul Unincorporated Neighborhood ROW to DMS 16 to 30',
      rate: 7.9,
      category: 'vegetative_removal',
    }), scheduleIndex);

    assert.equal(result.match?.record_id, 'rate:veg-16-30');
  });

  it('does not let missing contract rate-code alone prevent a semantic match', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      scheduleItem({
        id: 'rate:rural-0-15',
        description: 'from Rural Areas ROW to DMS 0 to 15 Miles',
        rate: 13.5,
        category: 'vegetative_removal',
      }),
    ]);

    const result = matchRateScheduleItemForInvoiceLine(invoiceLine({
      rateCode: '1E',
      description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15',
      rate: 13.5,
      category: 'vegetative_removal',
    }), scheduleIndex);

    assert.equal(result.match?.record_id, 'rate:rural-0-15');
  });

  it('does not let suspicious OCR rows clear a contract-rate blocker', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      scheduleItem({
        id: 'rate:suspicious',
        description: 'Hazardous Trees 6 to 12 inch trunk',
        rate: 95,
        category: 'tree_operations',
        unit: 'Tree',
        sourceQuality: 'junk',
        confidence: 'needs_review',
      }),
    ]);

    const result = matchRateScheduleItemForInvoiceLine(invoiceLine({
      rateCode: '5A',
      description: 'Hazardous Trees 6 to 12 inch trunk',
      rate: 95,
      category: 'tree_operations',
      unit: 'Tree',
    }), scheduleIndex);

    assert.equal(result.match, null);
  });

  it('prefers the source-backed Exhibit A row when duplicate contract slots tie', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      scheduleItem({
        id: 'contract_summary:item:90',
        description: 'from Rural Areas ROW to DMS 16 to 30 Miles',
        rate: 14.5,
        category: 'vegetative_removal',
        sourceQuality: 'partial',
      }),
      scheduleItem({
        id: 'exhibit_a_text_recovery:vegetative-rural-16-30-14-50',
        description: 'from Rural Areas ROW to DMS 16 to 30 Miles',
        rate: 14.5,
        category: 'vegetative_removal',
        sourceQuality: 'clean',
      }),
    ]);

    const result = matchRateScheduleItemForInvoiceLine(invoiceLine({
      rateCode: '1F',
      description: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to',
      rate: 14.5,
      category: 'vegetative_removal',
    }), scheduleIndex);

    assert.equal(result.ambiguous, false);
    assert.equal(
      result.match?.record_id,
      'exhibit_a_text_recovery:vegetative-rural-16-30-14-50',
    );
  });

  it('matches final disposal FDS invoice text even when the invoice category was stale', () => {
    const scheduleIndex = indexRateScheduleItemsByCanonicalKeys([
      scheduleItem({
        id: 'exhibit_a_table:final-disposal-31-60',
        description: 'DMS to Final Disposal 31 to 60 Miles',
        rate: 4.25,
        category: 'Final Disposal',
      }),
    ]);

    const result = matchRateScheduleItemForInvoiceLine(invoiceLine({
      rateCode: '3C',
      description: 'Final Disposal Mulch DMS to FDS 31-60 miles',
      rate: 4.25,
      category: 'vegetative_removal',
    }), scheduleIndex);

    assert.equal(result.match?.record_id, 'exhibit_a_table:final-disposal-31-60');
  });

  it('normalizes hyphenated invoice numbers for transaction join keys', () => {
    assert.equal(normalizeInvoiceNumber('2026-002'), '2026002');
    assert.equal(normalizeInvoiceNumber('2026-003'), '2026003');
    assert.equal(deriveInvoiceRateKey('2026-003', '2A'), '2026003::2A');
  });

  it('scopes billing-rate fallback to the invoice group normalized invoice number', () => {
    const row002 = {
      meaningful_data: true,
      normalized_invoice_number: '2026002',
      billing_rate_key: '1A',
      invoice_rate_key: '2026002::1A',
    };
    const row003 = {
      meaningful_data: true,
      normalized_invoice_number: '2026003',
      billing_rate_key: '1A',
      invoice_rate_key: '2026003::1A',
    };
    const indexes = {
      byInvoiceRateKey: new Map<string, typeof row002[]>(),
      byBillingRateKey: new Map([['1A', [row002, row003]]]),
    };

    const matched = matchTransactionRowsForInvoiceGroup(
      {
        billing_rate_key: '1A',
        normalized_invoice_number: '2026003',
      },
      indexes,
    );

    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.normalized_invoice_number, '2026003');
  });

  it('prefers invoice-rate-key matches before billing-rate fallback', () => {
    const row = {
      meaningful_data: true,
      normalized_invoice_number: '2026003',
      billing_rate_key: '2B',
      invoice_rate_key: '2026003::2B',
    };
    const indexes = {
      byInvoiceRateKey: new Map([['2026003::2B', [row]]]),
      byBillingRateKey: new Map<string, typeof row[]>(),
    };

    const matched = matchTransactionRowsForInvoiceGroup(
      {
        invoice_rate_key: '2026003::2B',
        billing_rate_key: '2B',
        normalized_invoice_number: '2026003',
      },
      indexes,
    );

    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.invoice_rate_key, '2026003::2B');
  });
});
