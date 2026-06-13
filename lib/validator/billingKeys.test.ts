import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  deriveBillingKeysForInvoiceLine,
  deriveBillingKeysForRateScheduleItem,
  deriveBillingKeysForTransactionRecord,
  deriveBillingRateKey,
  deriveDescriptionMatchKey,
  deriveInvoiceRateKey,
  deriveSiteMaterialKey,
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
});
