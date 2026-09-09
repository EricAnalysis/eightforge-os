import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { PdfLayout, PdfLayoutLine, PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  buildPagePricedScheduleReconstruction,
  type ConfirmedRateObservation,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * Phase 12 reconstruction re-entry.
 *
 * Every fixture here is synthetic. What is under test is the single admission
 * decision a human confirmation is allowed to change -- the ambiguous rate
 * cluster abstention -- and, just as importantly, everything it must not.
 */

const DESCRIPTION_X = 50;
const UNIT_X = 200;
const ORIGIN_X = 300;
const CURRENCY_X = 450;
const AMOUNT_X = 470;
const SECOND_CURRENCY_X = 530;
const SECOND_AMOUNT_X = 548;

type TokenSpec = {
  x: number; text: string; width?: number; observation_id?: PdfToken['observation_id'];
};

const observation = (value: string) => value as NonNullable<PdfToken['observation_id']>;

function token(spec: TokenSpec, y: number): PdfToken {
  return {
    text: spec.text, x: spec.x, y,
    width: spec.width ?? Math.max(8, spec.text.length * 5), height: 10,
    ...(spec.observation_id ? { observation_id: spec.observation_id } : {}),
  };
}

function line(pageNumber: number, y: number, specs: readonly TokenSpec[]): PdfLayoutLine {
  const tokens = specs.map((spec) => token(spec, y));
  return {
    id: `line:p${pageNumber}:y${y}`, page_number: pageNumber,
    text: tokens.map((entry) => entry.text).join(' '), tokens, kind: 'table_candidate',
    x_min: Math.min(...tokens.map((entry) => entry.x)),
    x_max: Math.max(...tokens.map((entry) => entry.x + entry.width)),
    y,
  };
}

function headerLine(pageNumber: number): PdfLayoutLine {
  return line(pageNumber, 700, [
    { x: DESCRIPTION_X, text: 'Description', width: 70 },
    { x: UNIT_X, text: 'Unit of Measure', width: 80 },
    { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
    { x: CURRENCY_X, text: 'Cost', width: 140 },
  ]);
}

function pricedLine(pageNumber: number, y: number, parts: {
  description?: string; unit?: string; origin?: string;
  currency?: string; amount?: string; amountObservation?: string;
}): PdfLayoutLine {
  const specs: TokenSpec[] = [];
  if (parts.description) specs.push({ x: DESCRIPTION_X, text: parts.description, width: 100 });
  if (parts.unit) specs.push({ x: UNIT_X, text: parts.unit, width: 60 });
  if (parts.origin) specs.push({ x: ORIGIN_X, text: parts.origin, width: 100 });
  if (parts.currency !== undefined) specs.push({ x: CURRENCY_X, text: parts.currency, width: 8 });
  if (parts.amount) {
    specs.push({
      x: AMOUNT_X, text: parts.amount, width: 40,
      ...(parts.amountObservation ? { observation_id: observation(parts.amountObservation) } : {}),
    });
  }
  return line(pageNumber, y, specs);
}

/**
 * A priced line carrying two plausible monetary clusters, which is exactly the
 * candidate the reconstructor abstains on today.
 */
function ambiguousLine(pageNumber: number, y: number, parts: {
  description: string;
  first: { text: string; observation: string };
  second: { text: string; observation: string };
}): PdfLayoutLine {
  return line(pageNumber, y, [
    { x: DESCRIPTION_X, text: parts.description, width: 100 },
    { x: UNIT_X, text: 'Widget', width: 60 },
    { x: ORIGIN_X, text: 'Yard to Depot', width: 100 },
    { x: AMOUNT_X, text: parts.first.text, width: 40, observation_id: observation(parts.first.observation) },
    { x: SECOND_AMOUNT_X, text: parts.second.text, width: 40, observation_id: observation(parts.second.observation) },
  ]);
}

function layoutOf(pages: readonly PdfLayoutPage[]): PdfLayout {
  return { page_count: pages.length, pages: [...pages], gaps: [] };
}

const PAGE = 7;

/**
 * One page holding two ordinary priced rows -- enough to establish a body --
 * and one candidate withheld for carrying two monetary clusters.
 */
function ambiguousPageLayout(overrides: {
  first?: { text: string; observation: string };
  second?: { text: string; observation: string };
} = {}): PdfLayout {
  return layoutOf([{
    page_number: PAGE, width: 612, height: 792,
    lines: [
      headerLine(PAGE),
      pricedLine(PAGE, 680, {
        description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
        currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
      }),
      pricedLine(PAGE, 660, {
        description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
        currency: '$', amount: '3.50', amountObservation: 'obs:beta',
      }),
      ambiguousLine(PAGE, 640, {
        description: 'Gamma service',
        first: overrides.first ?? { text: '$8.75', observation: 'obs:gamma-unit' },
        second: overrides.second ?? { text: '$52.50', observation: 'obs:gamma-extended' },
      }),
    ],
  }]);
}

const confirm = (observationId: string, text: string): ConfirmedRateObservation =>
  ({ observation_id: observation(observationId), confirmed_raw_text: text });

function reconstruct(
  layout: PdfLayout,
  confirmedRateObservations?: readonly ConfirmedRateObservation[],
) {
  return buildPagePricedScheduleReconstruction({ layout, confirmedRateObservations });
}

function gammaRow(result: ReturnType<typeof reconstruct>) {
  return result.pages[0]?.rows.find((row) =>
    row.cells.some((cell) => cell.raw_text.includes('Gamma'))) ?? null;
}

function rejectionReasons(result: ReturnType<typeof reconstruct>): readonly string[] {
  return (result.pages[0]?.rejected_spines ?? []).map((entry) => entry.reason);
}

describe('confirmed recovery re-entry through priced schedule reconstruction', () => {
  it('A: still withholds an ambiguous spine when nothing is confirmed', () => {
    const result = reconstruct(ambiguousPageLayout());
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toBeUndefined();
  });

  it('B: admits an ordinary row when exactly one rate observation is confirmed', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75')]);
    const row = gammaRow(result);
    expect(row).not.toBeNull();
    expect(row!.cells.find((cell) => cell.role === 'rate')?.raw_text).toBe('$8.75');
    expect(rejectionReasons(result)).not.toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toEqual([]);
  });

  it('B: the admitted row is an ordinary priced row carrying no recovery marking', () => {
    const recovered = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75')]);
    const row = gammaRow(recovered)!;
    // Structurally indistinguishable from a row that was never ambiguous: same
    // keys, same cell shape, no provenance of the recovery anywhere on it.
    const ordinary = recovered.pages[0]!.rows.find((entry) => entry.row_index !== row.row_index)!;
    expect(Object.keys(row).sort()).toEqual(Object.keys(ordinary).sort());
    expect(JSON.stringify(row)).not.toMatch(/recover|confirm|forgewing|human/i);
    expect(row.cells.every((cell) => cell.source_refs.length > 0)).toBe(true);
  });

  it('C: withholds when the confirmed id is a rate token on some other row', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:alpha', '$12.00')]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toEqual([{
      reason: 'confirmed_recovery_not_applied',
      observation_id: 'obs:alpha',
      physical_page_number: PAGE,
      recovery_applied: false,
    }]);
  });

  it('C: withholds when the confirmed id is not a rate-band token at all', () => {
    // A confirmation naming a description token resolves nothing: only rate-band
    // observations are ever consulted, so this can never narrow a rate cell.
    const layout = layoutOf([{
      page_number: PAGE, width: 612, height: 792,
      lines: [
        headerLine(PAGE),
        pricedLine(PAGE, 680, {
          description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
          currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
        }),
        pricedLine(PAGE, 660, {
          description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
          currency: '$', amount: '3.50', amountObservation: 'obs:beta',
        }),
        line(PAGE, 640, [
          { x: DESCRIPTION_X, text: 'Gamma service', width: 100, observation_id: observation('obs:gamma-description') },
          { x: UNIT_X, text: 'Widget', width: 60 },
          { x: ORIGIN_X, text: 'Yard to Depot', width: 100 },
          { x: AMOUNT_X, text: '$8.75', width: 40, observation_id: observation('obs:gamma-unit') },
          { x: SECOND_AMOUNT_X, text: '$52.50', width: 40, observation_id: observation('obs:gamma-extended') },
        ]),
      ],
    }]);
    const result = reconstruct(layout, [confirm('obs:gamma-description', 'Gamma service')]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics?.[0]?.reason).toBe('confirmed_recovery_not_applied');
  });

  it('D: fails closed when two ids in the same ambiguous cluster are confirmed', () => {
    const result = reconstruct(ambiguousPageLayout(), [
      confirm('obs:gamma-unit', '$8.75'),
      confirm('obs:gamma-extended', '$52.50'),
    ]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_recovery_confirmation');
    expect(result.recovery_diagnostics?.map((entry) => entry.reason))
      .toEqual(['confirmed_recovery_not_applied', 'confirmed_recovery_not_applied']);
  });

  it('E: fails closed when the built rate text disagrees with what was confirmed', () => {
    // The observation binds, but the human confirmed a different authored value,
    // so the confirmation does not describe this row.
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$9.99')]);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('recovery_closure_failed');
    expect(result.recovery_diagnostics?.[0]?.reason).toBe('confirmed_recovery_not_applied');
  });

  it('F: supports a single-token rate', () => {
    const result = reconstruct(ambiguousPageLayout(), [confirm('obs:gamma-unit', '$8.75')]);
    expect(gammaRow(result)!.cells.find((cell) => cell.role === 'rate')?.raw_text).toBe('$8.75');
  });

  it('G: leaves a split "$" + number rate unsupported', () => {
    // A recovery that would need two observation ids -- the currency token and
    // the number token -- cannot be expressed by the single-observation V1
    // contract, and must not become expressible by accident. Confirming the
    // number alone builds a rate cell reading "8.75", which is not the "$ 8.75"
    // a reviewer would have confirmed, so closure refuses it.
    const split = layoutOf([{
      page_number: PAGE, width: 612, height: 792,
      lines: [
        headerLine(PAGE),
        pricedLine(PAGE, 680, {
          description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
          currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
        }),
        pricedLine(PAGE, 660, {
          description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
          currency: '$', amount: '3.50', amountObservation: 'obs:beta',
        }),
        line(PAGE, 640, [
          { x: DESCRIPTION_X, text: 'Gamma service', width: 100 },
          { x: UNIT_X, text: 'Widget', width: 60 },
          { x: ORIGIN_X, text: 'Yard to Depot', width: 100 },
          { x: CURRENCY_X, text: '$', width: 8, observation_id: observation('obs:split-currency') },
          { x: AMOUNT_X, text: '8.75', width: 40, observation_id: observation('obs:split-number') },
          { x: SECOND_CURRENCY_X, text: '$', width: 8, observation_id: observation('obs:split-currency-2') },
          { x: SECOND_AMOUNT_X, text: '52.50', width: 40, observation_id: observation('obs:split-number-2') },
        ]),
      ],
    }]);
    for (const confirmation of [
      [confirm('obs:split-number', '$8.75')],
      [confirm('obs:split-currency', '$8.75')],
      [confirm('obs:split-currency', '$'), confirm('obs:split-number', '8.75')],
    ]) {
      const result = reconstruct(split, confirmation);
      expect(gammaRow(result)).toBeNull();
    }
  });
});

describe('confirmation cannot weaken any other admission gate', () => {
  it('does not admit a row that lacks required roles', () => {
    const layout = layoutOf([{
      page_number: PAGE, width: 612, height: 792,
      lines: [
        headerLine(PAGE),
        pricedLine(PAGE, 680, {
          description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
          currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
        }),
        pricedLine(PAGE, 660, {
          description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
          currency: '$', amount: '3.50', amountObservation: 'obs:beta',
        }),
        // Two monetary clusters and no description: ambiguous AND structurally
        // insufficient. Resolving the first must not excuse the second.
        line(PAGE, 640, [
          { x: AMOUNT_X, text: '$8.75', width: 40, observation_id: observation('obs:orphan-a') },
          { x: SECOND_AMOUNT_X, text: '$52.50', width: 40, observation_id: observation('obs:orphan-b') },
        ]),
      ],
    }]);
    const result = reconstruct(layout, [confirm('obs:orphan-a', '$8.75')]);
    expect(result.pages[0]!.rows.some((row) => row.raw_text.includes('8.75'))).toBe(false);
    expect(rejectionReasons(result)).toContain('insufficient_row_structure');
  });
});

describe('page-digest staleness', () => {
  // Observation identity embeds the page representation digest, so a reparse
  // that changed the page yields different ids. These stand in for that: the
  // confirmed id is simply not present in the layout under reconstruction.
  const staleConfirmation = [confirm('obs:gamma-unit@old-digest', '$8.75')];

  it('does not bind a confirmation whose observation no longer exists', () => {
    const result = reconstruct(ambiguousPageLayout(), staleConfirmation);
    expect(gammaRow(result)).toBeNull();
    expect(rejectionReasons(result)).toContain('ambiguous_rate_clusters');
    expect(result.recovery_diagnostics).toEqual([{
      reason: 'confirmed_recovery_unbound',
      observation_id: 'obs:gamma-unit@old-digest',
      physical_page_number: null,
      recovery_applied: false,
    }]);
  });

  it('never rebinds a stale confirmation by matching authored text', () => {
    // The same authored text is present on the page under a different id.
    const result = reconstruct(ambiguousPageLayout(), staleConfirmation);
    expect(result.pages[0]!.rows.some((row) =>
      row.cells.some((cell) => cell.role === 'rate' && cell.raw_text === '$8.75'))).toBe(false);
  });

  for (const layer of ['pdf_native_text', 'ocr'] as const) {
    it(`binds under an unchanged digest and unbinds under a changed one (${layer})`, () => {
      // Ids are opaque to this module, so the layer only changes how they were
      // produced upstream. Both are tested because OCR reparse is the less
      // stable of the two, and neither may fall back to text matching.
      const digest = layer === 'ocr' ? 'ocr-digest-1' : 'native-digest-1';
      const bound = `pdf:layout-token:v1:${digest}:gamma-unit`;
      const layout = ambiguousPageLayout({
        first: { text: '$8.75', observation: bound },
        second: { text: '$52.50', observation: `pdf:layout-token:v1:${digest}:gamma-extended` },
      });

      const same = reconstruct(layout, [confirm(bound, '$8.75')]);
      expect(gammaRow(same)).not.toBeNull();
      expect(same.recovery_diagnostics).toEqual([]);

      const changed = reconstruct(layout, [
        confirm(`pdf:layout-token:v1:${digest.replace('1', '2')}:gamma-unit`, '$8.75'),
      ]);
      expect(gammaRow(changed)).toBeNull();
      expect(changed.recovery_diagnostics?.[0]?.reason).toBe('confirmed_recovery_unbound');
    });
  }
});

describe('default path byte identity', () => {
  const layouts = {
    ambiguous: ambiguousPageLayout(),
    ordinary: layoutOf([{
      page_number: PAGE, width: 612, height: 792,
      lines: [
        headerLine(PAGE),
        pricedLine(PAGE, 680, {
          description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot',
          currency: '$', amount: '12.00', amountObservation: 'obs:alpha',
        }),
        pricedLine(PAGE, 660, {
          description: 'Beta service', unit: 'Widget', origin: 'Depot to Site',
          currency: '$', amount: '3.50', amountObservation: 'obs:beta',
        }),
      ],
    }]),
  };

  for (const [name, layout] of Object.entries(layouts)) {
    it(`is identical for absent, undefined and empty confirmations (${name})`, () => {
      const baseline = hashCanonical(buildPagePricedScheduleReconstruction({ layout }));
      expect(hashCanonical(buildPagePricedScheduleReconstruction({
        layout, confirmedRateObservations: undefined,
      }))).toBe(baseline);
      expect(hashCanonical(buildPagePricedScheduleReconstruction({
        layout, confirmedRateObservations: [],
      }))).toBe(baseline);
    });

    it(`emits no recovery field at all on the default path (${name})`, () => {
      const result = buildPagePricedScheduleReconstruction({ layout });
      expect(Object.keys(result).sort()).toEqual(['pages', 'parser_version']);
      expect('recovery_diagnostics' in result).toBe(false);
    });
  }

  it('is unchanged by a confirmation that matches nothing on the page', () => {
    const layout = layouts.ordinary;
    const baseline = buildPagePricedScheduleReconstruction({ layout });
    const withConfirmation = buildPagePricedScheduleReconstruction({
      layout, confirmedRateObservations: [confirm('obs:not-here', '$1.00')],
    });
    expect(hashCanonical(withConfirmation.pages)).toBe(hashCanonical(baseline.pages));
  });
});
