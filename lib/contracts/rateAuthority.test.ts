import { describe, expect, it } from 'vitest';

import { assembleContractPricingRows } from '@/lib/contracts/contractPricingAssembly';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { parseContractRateAuthority } from '@/lib/contracts/rateAuthority';
import type { ContractRateScheduleRow } from '@/lib/contracts/types';
import type {
  PagePricedScheduleReconstruction,
  PricedScheduleCell,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { buildRateScheduleItems } from '@/lib/validator/projectValidator';
import type { ValidatorFactRecord } from '@/lib/validator/shared';

/**
 * Scanned numeric authority (Forgewing generalization, phase 2). A rate read
 * from a scan is a candidate for a person to confirm, never pricing authority,
 * and no consumer may read digits back out of a withheld row's raw text.
 * Fixtures are synthetic.
 */

const PAGE = 4;

function cell(role: PricedScheduleCell['role'], rawText: string, x: number,
  source?: 'pdfjs' | 'ocr_fallback', observationId?: string): PricedScheduleCell {
  return {
    role, raw_text: rawText,
    source_refs: [{ text: rawText, x_min: x, x_max: x + 8, y_min: 100, y_max: 110,
      ...(source ? { source } : {}), ...(observationId ? { observation_id: observationId as never } : {}) }],
    x_min: x, x_max: x + 40, y_min: 100, y_max: 110,
  };
}

function pricedRows(rateText: string, rateSource?: 'pdfjs' | 'ocr_fallback', layer?: unknown): ContractRateScheduleRow[] {
  const reconstruction: PagePricedScheduleReconstruction = {
    parser_version: 'priced_schedule_reconstruction_v3',
    pages: [{
      status: 'reconstructed', physical_page_number: PAGE, header_raw_text: 'Description Unit Rate', header_y: 120,
      columns: [], rejected_spines: [], unassigned_lines: [],
      rows: [{
        row_index: 0, physical_page_number: PAGE, raw_text: `Vegetative Collect, Remove & Haul | Cubic Yard | ${rateText}`,
        cells: [cell('description', 'Vegetative Collect, Remove & Haul', 10, 'pdfjs'), cell('unit', 'Cubic Yard', 60, 'pdfjs'),
          cell('rate', rateText, 100, rateSource, 'obs-rate')],
        x_min: 10, x_max: 140, y_min: 100, y_max: 110,
      }],
    }],
  };
  return buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: reconstruction,
    pricedScheduleLayoutObservations: layer });
}

describe('priced schedule rows: a scanned amount is a candidate, not a rate', () => {
  it('publishes a native amount read whole', () => {
    const [row] = pricedRows('$8.75', 'pdfjs');
    expect(row).toMatchObject({ rate: 8.75, rate_amount: 8.75, confidence: 'medium',
      rate_authority: { status: 'read', basis: 'native_text' } });
  });

  it('withholds an amount read from OCR, whatever it looks like, and keeps it as the reviewer candidate', () => {
    const [row] = pricedRows('$8.75', 'ocr_fallback');
    expect(row).toMatchObject({ rate: null, rate_amount: null, confidence: 'needs_review',
      rate_authority: { status: 'review_required', basis: 'scanned_source', candidate_rate: 8.75, candidate_rate_raw: '$8.75' } });
  });

  it('knows a fragment is scanned from the persisted layout observation it is bound to', () => {
    const layer = { observations: [{ id: 'obs-rate', source_method: 'ocr_fallback' }] };
    const [row] = pricedRows('$8.75', undefined, layer);
    expect(row!.rate).toBeNull();
    expect(row!.rate_authority).toMatchObject({ status: 'review_required', basis: 'scanned_source' });
  });

  it('records an unreadable native amount as review-required with no candidate', () => {
    const [row] = pricedRows('$95,00', 'pdfjs');
    expect(row!.rate_authority).toEqual({ status: 'review_required', basis: 'unreadable_amount',
      candidate_rate: null, candidate_rate_raw: '$95,00' });
  });
});

describe('pricing assembly never re-derives a withheld or unreadable rate from raw text', () => {
  it('publishes no rate for a scanned row although its raw text holds a clean amount', () => {
    // Control: the same row read natively is priced.
    expect(assembleContractPricingRows(pricedRows('$8.75', 'pdfjs')).map((row) => row.rate)).toEqual([8.75]);
    // Scanned: never priced. An unpriced row has no pricing clue, so it leaves
    // the operator table; its ResolutionCase is where it is seen.
    expect(assembleContractPricingRows(pricedRows('$8.75', 'ocr_fallback')).filter((row) => row.rate != null)).toEqual([]);
  });

  it('does not turn damaged native text back into a number ("$95,00" is not 9500)', () => {
    const assembled = assembleContractPricingRows(pricedRows('$95,00', 'pdfjs'));
    expect(assembled.every((row) => row.rate == null)).toBe(true);
  });

  it('keeps a withheld rate withheld through the persisted typed rate table', () => {
    const typed = (row: ContractRateScheduleRow) =>
      assembleContractPricingRows([], { typedRows: [JSON.parse(JSON.stringify(row))] }).map((entry) => entry.rate);
    expect(typed(pricedRows('$8.75', 'pdfjs')[0]!)).toEqual([8.75]);
    expect(typed(pricedRows('$8.75', 'ocr_fallback')[0]!).filter((rate) => rate != null)).toEqual([]);
  });

  it('still publishes a native rate unchanged', () => {
    const [assembled] = assembleContractPricingRows(pricedRows('$8.75', 'pdfjs'));
    expect(assembled!.rate).toBe(8.75);
  });
});

describe('the Validator cannot read a withheld rate back out of raw text', () => {
  const fact = (value: unknown): ValidatorFactRecord => ({ id: 'rate-table-fact', document_id: 'contract-doc',
    key: 'rate_table', value, source: 'canonical_contract_intelligence', field_type: 'json', evidence: [] });
  const items = (params: { assembled?: ReturnType<typeof assembleContractPricingRows>; facts?: unknown[] }) =>
    buildRateScheduleItems({
      factsByDocumentId: new Map(params.facts ? [['contract-doc', [fact(params.facts)]]] : []),
      rateDocumentIds: params.facts ? ['contract-doc'] : [],
      contractValidationContext: null,
      assembledContractPricingRows: params.assembled ?? [],
    });

  it('an assembled scanned row reaches the Validator with no rate', () => {
    expect(items({ assembled: assembleContractPricingRows(pricedRows('$8.75', 'pdfjs')) })
      .map((item) => item.rate_amount)).toEqual([8.75]);
    expect(items({ assembled: assembleContractPricingRows(pricedRows('$8.75', 'ocr_fallback')) })
      .filter((item) => item.rate_amount != null)).toEqual([]);
  });

  it('an assembled row whose rate is null is never re-read from its raw text', () => {
    const [native] = assembleContractPricingRows(pricedRows('$8.75', 'pdfjs'));
    const nulled = { ...native!, rate: null, rateAuthority: undefined, rawText: 'Vegetative | Cubic Yard | $8.75' };
    expect(items({ assembled: [nulled] }).map((item) => item.rate_amount)).toEqual([null]);
  });

  it('a persisted review-required row reaches the Validator with no rate', () => {
    const [persisted] = pricedRows('$8.75', 'ocr_fallback');
    const result = items({ facts: [{ ...persisted, description: 'Operator', unit_type: 'Hour' }] });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((item) => item.rate_amount == null)).toBe(true);
  });

  it('a legacy row with no authority record reads exactly as before', () => {
    const result = items({ facts: [{ row_id: 'legacy-1', description: 'Operator', unit_type: 'Hour', rate_raw: '$8.75' }] });
    expect(result.map((item) => item.rate_amount)).toEqual([8.75]);
  });
});

describe('rate authority records are read strictly', () => {
  it('rejects malformed records', () => {
    expect(parseContractRateAuthority({ status: 'review_required', basis: 'guess', candidate_rate: 1, candidate_rate_raw: '1' })).toBeNull();
    expect(parseContractRateAuthority({ status: 'review_required', basis: 'scanned_source', candidate_rate: '1', candidate_rate_raw: '1' })).toBeNull();
    expect(parseContractRateAuthority({ status: 'read' })).toBeNull();
    expect(parseContractRateAuthority(null)).toBeNull();
  });
});
