import { describe, expect, it } from 'vitest';

import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import type {
  PagePricedScheduleReconstruction,
  PricedScheduleCell,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * A published priced row's rate is read from its authored rate cell whole.
 * Damaged amount text (malformed separators, a single decimal, trailing
 * punctuation, two amounts) is never read as a number: the row stays
 * unresolved and needs review. Every fixture is synthetic; the damaged shapes
 * are the ones observed in real scanned rate schedules.
 */

const PAGE = 4;

function cell(role: PricedScheduleCell['role'], rawText: string, x: number): PricedScheduleCell {
  return {
    role, raw_text: rawText,
    source_refs: rawText.split(' ').map((text, index) => ({
      text, x_min: x + index * 10, x_max: x + index * 10 + 8, y_min: 100, y_max: 110,
    })),
    x_min: x, x_max: x + 40, y_min: 100, y_max: 110,
  };
}

function rateOf(rateText: string): { rate: number | null; confidence: string | undefined } {
  const reconstruction: PagePricedScheduleReconstruction = {
    parser_version: 'priced_schedule_reconstruction_v3',
    pages: [{
      status: 'reconstructed', physical_page_number: PAGE, header_raw_text: 'Description Unit Rate', header_y: 120,
      columns: [], rejected_spines: [], unassigned_lines: [],
      rows: [{
        row_index: 0, physical_page_number: PAGE, raw_text: `Operator | Hour | ${rateText}`,
        cells: [cell('description', 'Operator', 10), cell('unit', 'Hour', 60), cell('rate', rateText, 100)],
        x_min: 10, x_max: 140, y_min: 100, y_max: 110,
      }],
    }],
  };
  const [row] = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: reconstruction });
  return { rate: row!.rate, confidence: row!.confidence };
}

describe('authored rate amount is read whole', () => {
  it('reads well-formed amounts, with or without a separate currency marker or thousands groups', () => {
    for (const [text, amount] of [
      ['$ 12.00', 12], ['$12.00', 12], ['12.00', 12], ['$1,250.00', 1250], ['$12', 12], ['$0.085', 0.085],
      ['1,250', 1250],
      // Layout artifacts without digits do not hide a well-formed amount.
      ['] | $10.90 [In', 10.9], ['_| $106.00', 106],
    ] as const) {
      expect(rateOf(text), text).toEqual({ rate: amount, confidence: 'medium' });
    }
  });

  it('never reads damaged amount text as a number: the row needs review instead', () => {
    for (const text of [
      // A comma that is not a thousands separator: previously read as 9500.
      '$95,00',
      // One decimal digit: previously read as 56 and 160.
      '$56.0', '$160.0',
      // Trailing punctuation fused to the amount: previously read as 2 and 170.
      '$2:', '$170.00.',
      // Thousands groups that are not groups of three.
      '$1,25.00', '$12,5000',
      // Two amounts in one cell.
      '$12.00 $14.00',
      // No amount at all.
      '$ Call',
    ]) {
      expect(rateOf(text), text).toEqual({ rate: null, confidence: 'needs_review' });
    }
  });
});
