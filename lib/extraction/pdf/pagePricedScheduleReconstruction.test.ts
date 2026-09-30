import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { PdfLayout, PdfLayoutLine, PdfLayoutPage, PdfToken } from '@/lib/extraction/pdf/extractText';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';

/**
 * Every fixture in this file is synthetic. No corpus description, unit, route,
 * price, page number, or agency name appears anywhere -- the reconstruction is
 * required to work from column headers and token geometry alone.
 */

const DESCRIPTION_X = 50;
const UNIT_X = 200;
const ORIGIN_X = 300;
const CURRENCY_X = 450;
const AMOUNT_X = 470;

type TokenSpec = { x: number; text: string; width?: number; observation_id?: PdfToken['observation_id'] };

function token(spec: TokenSpec, y: number): PdfToken {
  return {
    text: spec.text,
    x: spec.x,
    y,
    width: spec.width ?? Math.max(8, spec.text.length * 5),
    height: 10,
    ...(spec.observation_id ? { observation_id: spec.observation_id } : {}),
  };
}

function line(pageNumber: number, y: number, specs: readonly TokenSpec[]): PdfLayoutLine {
  const tokens = specs.map((spec) => token(spec, y));
  return {
    id: `line:p${pageNumber}:y${y}`,
    page_number: pageNumber,
    text: tokens.map((entry) => entry.text).join(' '),
    tokens,
    kind: 'table_candidate',
    x_min: Math.min(...tokens.map((entry) => entry.x)),
    x_max: Math.max(...tokens.map((entry) => entry.x + entry.width)),
    y,
  };
}

function headerLine(pageNumber: number, y = 700): PdfLayoutLine {
  return line(pageNumber, y, [
    { x: DESCRIPTION_X, text: 'Description', width: 70 },
    { x: UNIT_X, text: 'Unit of Measure', width: 80 },
    { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
    { x: CURRENCY_X, text: 'Cost', width: 30 },
  ]);
}

function page(pageNumber: number, lines: readonly PdfLayoutLine[]): PdfLayoutPage {
  return { page_number: pageNumber, width: 612, height: 792, lines: [...lines] };
}

function layoutOf(pages: readonly PdfLayoutPage[]): PdfLayout {
  return { page_count: pages.length, pages: [...pages], gaps: [] };
}

/** A single fully-populated priced line. */
function pricedLine(
  pageNumber: number,
  y: number,
  parts: { description?: string; unit?: string; origin?: string; amount?: string; currency?: string },
): PdfLayoutLine {
  const specs: TokenSpec[] = [];
  if (parts.description) specs.push({ x: DESCRIPTION_X, text: parts.description, width: 100 });
  if (parts.unit) specs.push({ x: UNIT_X, text: parts.unit, width: 60 });
  if (parts.origin) specs.push({ x: ORIGIN_X, text: parts.origin, width: 100 });
  if (parts.currency !== undefined) specs.push({ x: CURRENCY_X, text: parts.currency, width: 8 });
  if (parts.amount) specs.push({ x: AMOUNT_X, text: parts.amount, width: 40 });
  return line(pageNumber, y, specs);
}

function reconstructSinglePage(lines: readonly PdfLayoutLine[], pageNumber = 7) {
  const result = buildPagePricedScheduleReconstruction({
    layout: layoutOf([page(pageNumber, lines)]),
  });
  return result.pages[0] ?? null;
}

function cellText(
  row: NonNullable<ReturnType<typeof reconstructSinglePage>>['rows'][number],
  role: string,
): string | null {
  return row.cells.find((cell) => cell.role === role)?.raw_text ?? null;
}

describe('generic single-page priced schedule reconstruction', () => {
  it('A: assembles description/unit/route/cost rows from a single priced page', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '3.50' }),
    ]);

    expect(result).not.toBeNull();
    expect(result!.physical_page_number).toBe(7);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'description')).toBe('Alpha service');
    expect(cellText(result!.rows[0]!, 'unit')).toBe('Widget');
    expect(cellText(result!.rows[0]!, 'origin_destination')).toBe('Yard to Depot');
    expect(cellText(result!.rows[0]!, 'rate')).toBe('$ 12.00');
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
    expect(cellText(result!.rows[1]!, 'rate')).toBe('$ 3.50');
  });

  it('B: reassembles a description that wraps across lines around its priced line', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      line(7, 686, [{ x: DESCRIPTION_X, text: 'Gamma service with a very long', width: 100 }]),
      pricedLine(7, 680, { unit: 'Widget', origin: 'Yard to Depot', currency: '$', amount: '12.00' }),
      line(7, 674, [{ x: DESCRIPTION_X, text: 'authored description', width: 100 }]),
      pricedLine(7, 640, { description: 'Delta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '3.50' }),
    ]);

    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'description')).toBe('Gamma service with a very long authored description');
    // The wrapped fragments are retained individually as evidence.
    const descriptionCell = result!.rows[0]!.cells.find((cell) => cell.role === 'description');
    expect(descriptionCell!.source_refs).toHaveLength(2);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Delta service');
  });

  it('B2: preserves every primitive observation identity in a multiline cell', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      line(7, 686, [{ x: DESCRIPTION_X, text: 'Wrapped Alpha', width: 100, observation_id: 'observation-a' as PdfToken['observation_id'] }]),
      line(7, 680, [
        { x: UNIT_X, text: 'Widget', observation_id: 'observation-b' as PdfToken['observation_id'] },
        { x: ORIGIN_X, text: 'Yard', observation_id: 'observation-c' as PdfToken['observation_id'] },
        { x: CURRENCY_X, text: '$', observation_id: 'observation-d' as PdfToken['observation_id'] },
        { x: AMOUNT_X, text: '12.00', observation_id: 'observation-e' as PdfToken['observation_id'] },
      ]),
      line(7, 674, [{ x: DESCRIPTION_X, text: 'Tail', width: 100, observation_id: 'observation-f' as PdfToken['observation_id'] }]),
      pricedLine(7, 640, { description: 'Beta', unit: 'Widget', origin: 'Depot', currency: '$', amount: '3.50' }),
    ]);
    const refs = result!.rows[0]!.cells.flatMap((cell) => cell.source_refs)
      .flatMap((entry) => entry.observation_id ? [entry.observation_id] : []);
    expect(refs).toEqual([
      'observation-a', 'observation-f', 'observation-b', 'observation-c', 'observation-d', 'observation-e',
    ]);
  });

  it('C: reassembles an origin/destination that wraps across lines', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      line(7, 686, [{ x: ORIGIN_X, text: 'From the northern collection area', width: 100 }]),
      pricedLine(7, 680, { description: 'Epsilon service', unit: 'Widget', currency: '$', amount: '9.25' }),
      line(7, 674, [{ x: ORIGIN_X, text: 'to the central depot', width: 100 }]),
      pricedLine(7, 640, { description: 'Zeta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '1.00' }),
    ]);

    expect(cellText(result!.rows[0]!, 'origin_destination')).toBe(
      'From the northern collection area to the central depot',
    );
    expect(cellText(result!.rows[0]!, 'description')).toBe('Epsilon service');
  });

  it('D: preserves authored currency text and resolves numeric rates', () => {
    const recon = buildPagePricedScheduleReconstruction({
      layout: layoutOf([
        page(7, [
          headerLine(7),
          pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot', currency: '$', amount: '1,250.75' }),
          pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '3.50' }),
        ]),
      ]),
    });
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: recon });

    expect(rows).toHaveLength(2);
    expect(rows[0]!.rate_raw).toBe('$ 1,250.75');
    expect(rows[0]!.rate).toBe(1250.75);
    expect(rows[1]!.rate).toBe(3.5);
  });

  it('E: never manufactures a number from a non-numeric authored price marker', () => {
    const recon = buildPagePricedScheduleReconstruction({
      layout: layoutOf([
        page(7, [
          headerLine(7),
          pricedLine(7, 680, { description: 'Alpha service', unit: 'Actual Costs', origin: 'N/A', currency: '$', amount: '-' }),
          pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '3.50' }),
        ]),
      ]),
    });
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: recon });

    expect(rows).toHaveLength(2);
    // Authored evidence survives verbatim.
    expect(rows[0]!.rate_raw).toBe('$ -');
    // And no value is invented for it.
    expect(rows[0]!.rate).toBeNull();
    expect(rows[0]!.rate_amount).toBeNull();
    expect(rows[0]!.rate).not.toBe(0);
    expect(rows[0]!.confidence).toBe('needs_review');
  });

  it('F: keeps repeated descriptions distinct by their authored routes', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Alpha service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '4.00' }),
      pricedLine(7, 640, { description: 'Alpha service', unit: 'Widget', origin: 'Yard to Site', currency: '$', amount: '7.00' }),
    ]);

    expect(result!.rows).toHaveLength(3);
    expect(result!.rows.map((row) => cellText(row, 'origin_destination'))).toEqual([
      'Yard to Depot',
      'Depot to Site',
      'Yard to Site',
    ]);
    expect(result!.rows.map((row) => cellText(row, 'rate'))).toEqual(['$ 12.00', '$ 4.00', '$ 7.00']);
  });

  it('G: tolerates the same unit repeating across every row', () => {
    const lines = [headerLine(7)];
    for (let index = 0; index < 6; index += 1) {
      lines.push(
        pricedLine(7, 680 - index * 20, {
          description: `Service ${index}`,
          unit: 'Widget',
          origin: 'Yard to Depot',
          currency: '$',
          amount: `${index + 1}.00`,
        }),
      );
    }
    const result = reconstructSinglePage(lines);

    expect(result!.rows).toHaveLength(6);
    expect(result!.rows.every((row) => cellText(row, 'unit') === 'Widget')).toBe(true);
  });

  it('H: produces identical output when input line order is perturbed', () => {
    const lines = [
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '3.50' }),
      pricedLine(7, 640, { description: 'Gamma service', unit: 'Widget', origin: 'Yard to Site', currency: '$', amount: '7.00' }),
    ];
    const forward = reconstructSinglePage(lines);
    const reversed = reconstructSinglePage([...lines].reverse());
    const shuffled = reconstructSinglePage([lines[2]!, lines[0]!, lines[3]!, lines[1]!]);

    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('I: fails closed when a schedule line carries no authored price marker', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '3.50' }),
      // An unpriced line must not become a priced row.
      line(7, 620, [
        { x: DESCRIPTION_X, text: 'Unpriced service', width: 100 },
        { x: UNIT_X, text: 'Widget', width: 60 },
        { x: ORIGIN_X, text: 'Yard to Site', width: 100 },
      ]),
    ]);

    expect(result!.rows).toHaveLength(2);
    expect(
      result!.rows.some((row) => cellText(row, 'description')?.includes('Unpriced service')),
    ).toBe(false);
  });

  it('J: rejects a page that does not generically present as a priced schedule', () => {
    const result = buildPagePricedScheduleReconstruction({
      layout: layoutOf([
        page(3, [
          line(3, 700, [{ x: DESCRIPTION_X, text: 'Some narrative heading', width: 200 }]),
          line(3, 680, [{ x: DESCRIPTION_X, text: 'Body prose that mentions $ 12.00 in passing', width: 300 }]),
        ]),
      ]),
    });

    expect(result.pages).toHaveLength(0);
  });

  it('K: never lets another page become same-page row evidence', () => {
    // A structural, unpriced schedule page alongside the priced page.
    const structuralPage = page(4, [
      line(4, 700, [
        { x: DESCRIPTION_X, text: 'Description', width: 70 },
        { x: UNIT_X, text: 'Unit of Measure', width: 80 },
        { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
      ]),
      line(4, 680, [
        { x: DESCRIPTION_X, text: 'Structural only service', width: 100 },
        { x: UNIT_X, text: 'Widget', width: 60 },
        { x: ORIGIN_X, text: 'Yard to Depot', width: 100 },
      ]),
    ]);
    const pricedPage = page(9, [
      headerLine(9),
      pricedLine(9, 680, { description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot', currency: '$', amount: '12.00' }),
      pricedLine(9, 660, { description: 'Beta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '3.50' }),
    ]);

    const result = buildPagePricedScheduleReconstruction({
      layout: layoutOf([structuralPage, pricedPage]),
    });

    // The unpriced structural page yields nothing at all.
    expect(result.pages.map((entry) => entry.physical_page_number)).toEqual([9]);
    const allText = JSON.stringify(result.pages);
    expect(allText).not.toContain('Structural only service');

    // And every cell of every row is anchored to the one priced page.
    for (const reconstructed of result.pages) {
      for (const row of reconstructed.rows) {
        expect(row.physical_page_number).toBe(9);
      }
    }
  });

  it('L: closes evidence on one physical page for every reconstructed row', () => {
    const recon = buildPagePricedScheduleReconstruction({
      layout: layoutOf([
        page(9, [
          headerLine(9),
          pricedLine(9, 680, { description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot', currency: '$', amount: '12.00' }),
          pricedLine(9, 660, { description: 'Beta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '3.50' }),
        ]),
      ]),
    });
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: recon });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.page).toBe(9);
      expect(row.source_kind).toBe('page_priced_schedule');
      expect(row.raw_cells?.length ?? 0).toBeGreaterThan(0);
      expect(row.raw_text).toBeTruthy();
      expect(row.geometry_refs?.length ?? 0).toBeGreaterThan(0);
      // Bounding geometry stays on the row's own physical page.
      for (const ref of row.geometry_refs ?? []) {
        expect(ref.geometry.page_number).toBe(9);
      }
      // Description and route remain separately addressable authored evidence.
      expect(row.description).not.toEqual(row.origin_destination);
    }
  });

  it('is inert for documents it does not recognise', () => {
    const result = buildPagePricedScheduleReconstruction({ layout: layoutOf([]) });
    expect(result.pages).toHaveLength(0);
    expect(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: result })).toEqual([]);
  });

  it('requires an unambiguous header before reconstructing anything', () => {
    // A repeated role makes the header ambiguous; fail closed rather than guess.
    const ambiguous = buildPagePricedScheduleReconstruction({
      layout: layoutOf([
        page(7, [
          line(7, 700, [
            { x: DESCRIPTION_X, text: 'Description', width: 70 },
            { x: UNIT_X, text: 'Description', width: 80 },
            { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
            { x: CURRENCY_X, text: 'Cost', width: 30 },
          ]),
          pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'Yard to Depot', currency: '$', amount: '12.00' }),
          pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'Depot to Site', currency: '$', amount: '3.50' }),
        ]),
      ]),
    });

    // Reported, not reconstructed: the page fails closed with its header
    // evidence and claims no columns or rows.
    expect(ambiguous.pages).toHaveLength(1);
    expect(ambiguous.pages[0]).toMatchObject({ status: 'failed_closed', columns: [], rows: [] });
    expect(ambiguous.pages[0]!.header_interpretation).toMatchObject({
      status: 'unresolved', reason: 'duplicate_role',
    });
  });

  // ---------------------------------------------------------------------------
  // Structural row identity: a row participates in the table's columns, whereas
  // a summary or footer line pairs a label with an amount and nothing else. The
  // fixtures below use summary wording only to be realistic; the rule under test
  // is structural and knows no summary vocabulary.
  // ---------------------------------------------------------------------------

  it('M: rejects a trailing total line that carries a currency amount', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 640, [
        { x: DESCRIPTION_X, text: 'TOTAL', width: 60 },
        { x: CURRENCY_X, text: '$', width: 8 },
        { x: AMOUNT_X, text: '15.50', width: 40 },
      ]),
    ]);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(2);
    expect(result!.rows.map((row) => cellText(row, 'description'))).toEqual([
      'Alpha service',
      'Beta service',
    ]);
  });

  it('M2: rejects a subtotal line sitting at the same pitch as real rows', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 640, [
        { x: DESCRIPTION_X, text: 'Subtotal for this section', width: 120 },
        { x: CURRENCY_X, text: '$', width: 8 },
        { x: AMOUNT_X, text: '15.50', width: 40 },
      ]),
    ]);
    expect(result!.rows).toHaveLength(2);
  });

  it('M3: rejects a footer carrying an amount and no other column', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 640, [
        { x: CURRENCY_X, text: '$', width: 8 },
        { x: AMOUNT_X, text: '15.50', width: 40 },
      ]),
    ]);
    expect(result!.rows).toHaveLength(2);
  });

  // --- F4: the real participation boundary -----------------------------------
  // Unit and route are optional per row. What separates a sparse row from a
  // summary line is position inside the table body, not how many columns it
  // fills, so these fixtures put the sparse row among fully-populated rows.

  it('M4: keeps a 3-column row that omits its unit', () => {
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Description', width: 70 },
        { x: UNIT_X, text: 'Unit', width: 40 },
        { x: CURRENCY_X, text: 'Cost', width: 30 },
      ]),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', currency: '$', amount: '3.50' }),
      pricedLine(7, 640, { description: 'Gamma service', unit: 'Widget', currency: '$', amount: '7.00' }),
    ]);
    expect(result!.rows).toHaveLength(3);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
    expect(cellText(result!.rows[1]!, 'rate')).toBe('$ 3.50');
    expect(cellText(result!.rows[1]!, 'unit')).toBeNull();
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it('M4b: keeps a 4-column row that omits both unit and route', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', currency: '$', amount: '3.50' }),
      pricedLine(7, 640, { description: 'Gamma service', unit: 'Widget', origin: 'C to D', currency: '$', amount: '7.00' }),
    ]);
    expect(result!.rows).toHaveLength(3);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
    expect(cellText(result!.rows[1]!, 'rate')).toBe('$ 3.50');
    expect(cellText(result!.rows[1]!, 'unit')).toBeNull();
    expect(cellText(result!.rows[1]!, 'origin_destination')).toBeNull();
  });

  it('M4c: rejects a summary line beneath the table body and says why', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 640, [
        { x: DESCRIPTION_X, text: 'TOTAL', width: 60 },
        { x: CURRENCY_X, text: '$', width: 8 },
        { x: AMOUNT_X, text: '15.50', width: 40 },
      ]),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rejected_spines).toHaveLength(1);
    expect(result!.rejected_spines[0]!.reason).toBe('outside_table_body');
    expect(result!.rejected_spines[0]!.raw_text).toContain('15.50');
    expect(result!.rejected_spines[0]!.source_refs.length).toBeGreaterThan(0);
  });

  it('M4d: rejects a rate-only footer and says why', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 640, [
        { x: CURRENCY_X, text: '$', width: 8 },
        { x: AMOUNT_X, text: '15.50', width: 40 },
      ]),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rejected_spines.map((entry) => entry.reason)).toEqual(['insufficient_row_structure']);
  });

  it('M4e: reports a malformed spine inside the body rather than dropping it', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      // Inside the body, but carries no description evidence at all.
      line(7, 660, [
        { x: CURRENCY_X, text: '$', width: 8 },
        { x: AMOUNT_X, text: '9.99', width: 40 },
      ]),
      pricedLine(7, 640, { description: 'Gamma service', unit: 'Widget', origin: 'C to D', currency: '$', amount: '7.00' }),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rejected_spines).toHaveLength(1);
    expect(result!.rejected_spines[0]!.reason).toBe('insufficient_row_structure');
    expect(result!.rejected_spines[0]!.raw_text).toContain('9.99');
    expect(result!.rejected_spines[0]!.physical_page_number).toBe(7);
  });

  it('M4f: fails closed when too few rows populate every column to establish a body', () => {
    // Documented limit: with only one fully-populated row there is no vertical
    // extent to judge a sparse line against, so the qualified page retains its
    // diagnostics but publishes no rows.
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', currency: '$', amount: '3.50' }),
    ]);
    expect(result!.status).toBe('failed_closed');
    expect(result!.rows).toEqual([]);
    expect(result!.rejected_spines.map((entry) => entry.reason)).toEqual([
      'outside_table_body',
      'insufficient_priced_rows',
    ]);
    expect(result!.rejected_spines.every((entry) => entry.source_refs.length > 0)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Header detection must read column labels, not prose beginning with one.
  // ---------------------------------------------------------------------------

  it('N: refuses prose whose phrases merely begin with column-role words', () => {
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Description of the work shall', width: 150 },
        { x: 250, text: 'Unit rates are firm', width: 100 },
        { x: CURRENCY_X, text: 'Cost adjustments apply', width: 100 },
      ]),
      line(7, 680, [
        { x: DESCRIPTION_X, text: 'The contractor shall be paid', width: 150 },
        { x: CURRENCY_X, text: '$', width: 8 },
        { x: AMOUNT_X, text: '12.00', width: 40 },
      ]),
      line(7, 660, [
        { x: DESCRIPTION_X, text: 'and additionally', width: 150 },
        { x: CURRENCY_X, text: '$', width: 8 },
        { x: AMOUNT_X, text: '3.50', width: 40 },
      ]),
    ]);
    expect(result).toBeNull();
  });

  it('N2: still accepts a compact header carrying layout punctuation', () => {
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Description:', width: 70 },
        { x: UNIT_X, text: 'Unit of Measure', width: 80 },
        { x: ORIGIN_X, text: '*Origin/ Destination', width: 90 },
        { x: CURRENCY_X, text: 'Cost', width: 30 },
      ]),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(2);
    expect(result!.columns.map((column) => column.role)).toEqual([
      'description', 'unit', 'origin_destination', 'rate',
    ]);
  });

  it('N3: does not reconstruct a header split across two lines', () => {
    // Documented limit: a header must present its labels on one line. A split
    // header is not stitched together; the page fails closed, and the one line
    // that reads as a header is reported with no columns or rows claimed.
    const result = reconstructSinglePage([
      line(7, 706, [
        { x: DESCRIPTION_X, text: 'Description', width: 70 },
        { x: UNIT_X, text: 'Unit', width: 40 },
      ]),
      line(7, 700, [
        { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
        { x: CURRENCY_X, text: 'Cost', width: 30 },
      ]),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
    ]);
    expect(result).toMatchObject({ status: 'failed_closed', columns: [], rows: [], header_y: 700 });
    expect(result!.header_interpretation).toMatchObject({ status: 'unresolved', reason: 'required_role_missing' });
    // No label on the reported line lacks a role, so there is nothing to offer.
    expect(result!.header_interpretation!.options).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // A page holding more than one priced table cannot be read as one table.
  // ---------------------------------------------------------------------------

  it('O: fails closed when a page presents two complete priced tables', () => {
    const result = reconstructSinglePage([
      headerLine(7, 720),
      pricedLine(7, 700, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 690, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      headerLine(7, 600),
      pricedLine(7, 580, { description: 'Gamma service', unit: 'Gadget', origin: 'C to D', currency: '$', amount: '7.00' }),
      pricedLine(7, 560, { description: 'Delta service', unit: 'Gadget', origin: 'D to E', currency: '$', amount: '9.00' }),
    ]);
    expect(result).toBeNull();
  });

  it('O2: fails closed when a header repeats after a page-layout artifact', () => {
    const result = reconstructSinglePage([
      headerLine(7, 720),
      pricedLine(7, 700, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      line(7, 660, [{ x: DESCRIPTION_X, text: 'continued', width: 60 }]),
      headerLine(7, 640),
      pricedLine(7, 620, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
    ]);
    expect(result).toBeNull();
  });

  it('O3: reconstructs normally when a later line only partially resembles a header', () => {
    const result = reconstructSinglePage([
      headerLine(7, 720),
      pricedLine(7, 700, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 680, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      // Two role labels only: not enough to qualify as a second table header.
      line(7, 650, [
        { x: DESCRIPTION_X, text: 'Description', width: 70 },
        { x: CURRENCY_X, text: 'Cost', width: 30 },
      ]),
    ]);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(2);
  });

  it('O4: body text reading like column values does not count as a header', () => {
    const result = reconstructSinglePage([
      headerLine(7, 720),
      pricedLine(7, 700, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 680, { description: 'Cost recovery service', unit: 'Unit', origin: 'Route', currency: '$', amount: '3.50' }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Authored text shapes.
  // ---------------------------------------------------------------------------

  it('P: reassembles a unit that wraps across lines in authored order', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      line(7, 686, [{ x: UNIT_X, text: 'Each Vehicle', width: 60 }]),
      pricedLine(7, 680, { description: 'Alpha service', unit: '(Cars, trucks,', origin: 'A to B', currency: '$', amount: '12.00' }),
      line(7, 674, [{ x: UNIT_X, text: 'tractor trailers)', width: 60 }]),
      pricedLine(7, 650, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
    ]);
    expect(cellText(result!.rows[0]!, 'unit')).toBe('Each Vehicle (Cars, trucks, tractor trailers)');
  });

  it('Q: reads an amount carried as one currency-led token', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      line(7, 680, [
        { x: DESCRIPTION_X, text: 'Alpha service', width: 100 },
        { x: UNIT_X, text: 'Widget', width: 60 },
        { x: ORIGIN_X, text: 'A to B', width: 100 },
        { x: 460, text: '$12.00', width: 45 },
      ]),
      line(7, 660, [
        { x: DESCRIPTION_X, text: 'Beta service', width: 100 },
        { x: UNIT_X, text: 'Widget', width: 60 },
        { x: ORIGIN_X, text: 'B to C', width: 100 },
        { x: 460, text: '$3.50', width: 45 },
      ]),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'rate')).toBe('$12.00');
    expect(cellText(result!.rows[1]!, 'rate')).toBe('$3.50');
  });

  // ---------------------------------------------------------------------------
  // Last-row vertical bound.
  // ---------------------------------------------------------------------------

  it('R: excludes trailing prose below the final priced row', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 600, [{ x: DESCRIPTION_X, text: 'Payment terms are net thirty days.', width: 200 }]),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
  });

  it('R2: bounds the final row at half the row pitch below its own spine', () => {
    // The last row's band reaches as far below its spine as above it. Content
    // beyond that bound belongs to the page, not the row. Content inside the
    // bound is the row's own wrapped text (see R3) -- geometry alone cannot tell
    // a wrapped cell from a nearby sentence, and this is the documented limit.
    const spineY = 660;
    const pitch = 680 - spineY;
    const outsideBound = spineY - pitch - 5;
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, spineY, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, outsideBound, [{ x: DESCRIPTION_X, text: 'Payment terms apply.', width: 200 }]),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
  });

  it('R3: reports a lone trailing wrap the page has not established spacing for', () => {
    // With no other wrapped row on the page there is nothing to distinguish this
    // line from unrelated trailing content, so it is reported rather than folded
    // into the last row. Test X3 covers the same shape once the page does
    // establish its continuation spacing, where the wrap is kept.
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 500, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 494, [{ x: DESCRIPTION_X, text: 'continued text', width: 100 }]),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
    expect(result!.unassigned_lines.map((entry) => entry.reason)).toEqual(['unsupported_trailing_line']);
  });


  // ---------------------------------------------------------------------------
  // F1: compact real-world column labels, without reopening prefix matching.
  // ---------------------------------------------------------------------------

  const headerWith = (rateLabel: string, descriptionLabel = 'Description', unitLabel = 'Unit of Measure') =>
    line(7, 700, [
      { x: DESCRIPTION_X, text: descriptionLabel, width: 70 },
      { x: UNIT_X, text: unitLabel, width: 80 },
      { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
      { x: CURRENCY_X, text: rateLabel, width: 40 },
    ]);
  const twoBodyRows = [
    pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
    pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
  ];

  it('S: recognises common compact rate-column labels', () => {
    for (const label of [
      'Cost', 'Cost ($)', 'Cost($)', 'Total Cost', 'Cost per Unit',
      'Amount', 'Amount ($)', 'Rate', 'Rate/Unit', 'Unit Price', 'Unit Price ($)',
    ]) {
      const result = reconstructSinglePage([headerWith(label), ...twoBodyRows]);
      expect(result, `rate label ${label} must establish a rate column`).not.toBeNull();
      expect(result!.rows).toHaveLength(2);
    }
  });

  it('S2: recognises common compact description and unit labels', () => {
    for (const label of ['Description', 'Description of Work', 'Description of Services']) {
      const result = reconstructSinglePage([headerWith('Cost', label), ...twoBodyRows]);
      expect(result, `description label ${label} must be recognised`).not.toBeNull();
    }
    for (const label of ['Unit', 'Unit of Measure', 'Unit of Measurement', 'UOM', 'U/M']) {
      const result = reconstructSinglePage([headerWith('Cost', 'Description', label), ...twoBodyRows]);
      expect(result, `unit label ${label} must be recognised`).not.toBeNull();
      expect(result!.columns.some((column) => column.role === 'unit')).toBe(true);
    }
  });

  it('S3: still refuses prose that merely contains column-role words', () => {
    const prose = [
      'Description of how the contractor shall be paid',
      'Unit pricing shall be based on the schedule',
      'Cost per unit may be adjusted by the parties',
    ];
    for (const sentence of prose) {
      const result = reconstructSinglePage([
        line(7, 700, [
          { x: DESCRIPTION_X, text: sentence, width: 250 },
          { x: UNIT_X, text: 'Unit pricing shall apply', width: 100 },
          { x: CURRENCY_X, text: 'Cost will be determined later', width: 100 },
        ]),
        ...twoBodyRows,
      ]);
      expect(result, `prose must not qualify: ${sentence}`).toBeNull();
    }
  });

  // ---------------------------------------------------------------------------
  // F2: an unrecognized column separates its neighbours and contributes nothing.
  // ---------------------------------------------------------------------------

  const unknownColumnPage = (headerLabels: ReadonlyArray<{ x: number; text: string }>,
    bodies: ReadonlyArray<ReadonlyArray<{ x: number; text: string }>>) => reconstructSinglePage([
    line(7, 700, headerLabels.map((spec) => ({ ...spec, width: 70 }))),
    ...bodies.map((specs, index) => line(7, 680 - index * 20, specs.map((spec) => ({ ...spec, width: 60 })))),
  ]);

  it('T: keeps every recognized column clean when all columns are recognized', () => {
    const result = unknownColumnPage(
      [{ x: 50, text: 'Description' }, { x: 200, text: 'Unit' }, { x: 350, text: 'Route' }, { x: 500, text: 'Cost' }],
      [
        [{ x: 50, text: 'Alpha service' }, { x: 200, text: 'EA' }, { x: 350, text: 'A to B' }, { x: 500, text: '$12.00' }],
        [{ x: 50, text: 'Beta service' }, { x: 200, text: 'TON' }, { x: 350, text: 'B to C' }, { x: 500, text: '$3.50' }],
      ],
    );
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'origin_destination')).toBe('A to B');
    expect(cellText(result!.rows[0]!, 'unit')).toBe('EA');
  });

  it('T2: excludes an unrecognized column sitting before the route column', () => {
    const result = unknownColumnPage(
      [{ x: 50, text: 'Description' }, { x: 200, text: 'Quantity' }, { x: 350, text: 'Origin/ Destination' }, { x: 500, text: 'Cost' }],
      [
        [{ x: 50, text: 'Alpha service' }, { x: 200, text: '1853' }, { x: 350, text: 'A to B' }, { x: 500, text: '$12.00' }],
        [{ x: 50, text: 'Beta service' }, { x: 200, text: '4021' }, { x: 350, text: 'B to C' }, { x: 500, text: '$3.50' }],
      ],
    );
    expect(result!.rows).toHaveLength(2);
    expect(result!.columns.some((column) => column.role == null)).toBe(true);
    expect(cellText(result!.rows[0]!, 'origin_destination')).toBe('A to B');
    expect(cellText(result!.rows[1]!, 'origin_destination')).toBe('B to C');
    for (const row of result!.rows) {
      for (const cell of row.cells) {
        expect(cell.raw_text).not.toMatch(/1853|4021/);
      }
    }
  });

  it('T3: excludes an unrecognized column sitting between unit and cost', () => {
    const result = unknownColumnPage(
      [{ x: 50, text: 'Description' }, { x: 200, text: 'Unit' }, { x: 350, text: 'Quantity' }, { x: 500, text: 'Cost' }],
      [
        [{ x: 50, text: 'Alpha service' }, { x: 200, text: 'EA' }, { x: 350, text: '1853' }, { x: 500, text: '$12.00' }],
        [{ x: 50, text: 'Beta service' }, { x: 200, text: 'TON' }, { x: 350, text: '4021' }, { x: 500, text: '$3.50' }],
      ],
    );
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'unit')).toBe('EA');
    expect(cellText(result!.rows[0]!, 'rate')).toBe('$12.00');
    for (const row of result!.rows) {
      for (const cell of row.cells) {
        expect(cell.raw_text).not.toMatch(/1853|4021/);
      }
    }
  });

  it('T4: excludes two adjacent unrecognized columns', () => {
    const result = unknownColumnPage(
      [{ x: 50, text: 'Description' }, { x: 180, text: 'Quantity' }, { x: 300, text: 'Line No' }, { x: 420, text: 'Unit' }, { x: 540, text: 'Cost' }],
      [
        [{ x: 50, text: 'Alpha service' }, { x: 180, text: '1853' }, { x: 300, text: '7' }, { x: 420, text: 'EA' }, { x: 540, text: '$12.00' }],
        [{ x: 50, text: 'Beta service' }, { x: 180, text: '4021' }, { x: 300, text: '8' }, { x: 420, text: 'TON' }, { x: 540, text: '$3.50' }],
      ],
    );
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'unit')).toBe('EA');
    for (const row of result!.rows) {
      for (const cell of row.cells) {
        expect(cell.raw_text).not.toMatch(/1853|4021|\b7\b|\b8\b/);
      }
    }
  });

  it('T5: excludes an unrecognized column whose body wraps across lines', () => {
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Description', width: 70 },
        { x: UNIT_X, text: 'Quantity', width: 60 },
        { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
        { x: CURRENCY_X, text: 'Cost', width: 30 },
      ]),
      line(7, 686, [{ x: UNIT_X, text: '1853 tons', width: 60 }]),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'approx', origin: 'A to B', currency: '$', amount: '12.00' }),
      line(7, 674, [{ x: UNIT_X, text: 'per load', width: 60 }]),
      pricedLine(7, 650, { description: 'Beta service', unit: '4021', origin: 'B to C', currency: '$', amount: '3.50' }),
    ]);
    expect(result!.rows).toHaveLength(2);
    for (const row of result!.rows) {
      for (const cell of row.cells) {
        expect(cell.raw_text).not.toMatch(/1853|4021|approx|per load/);
      }
    }
  });

  it('U: prose beneath the table using column-role words does not add a table', () => {
    const result = reconstructSinglePage([
      headerLine(7, 720),
      pricedLine(7, 700, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 680, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 620, [{ x: DESCRIPTION_X, text: 'Cost and unit pricing are described in the attached schedule.', width: 300 }]),
    ]);
    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(2);
  });


  // ---------------------------------------------------------------------------
  // Row attribution. A source line is atomic and joins the row it is clearly
  // nearest to. Lines that sit between two rows without being meaningfully
  // nearer to either join neither, and are reported instead of guessed at.
  // ---------------------------------------------------------------------------

  /** Header plus two priced rows at a wide pitch, leaving room for wrapped text. */
  const wrapHeader = () => headerLine(7, 700);
  const wrapRow = (y: number, description: string, amount: string) => pricedLine(7, y, {
    description, unit: 'Widget', origin: 'A to B', currency: '$', amount,
  });

  it('V: attaches a wrapped line to the row it is clearly nearest to', () => {
    const result = reconstructSinglePage([
      wrapHeader(),
      wrapRow(660, 'Alpha service', '12.00'),
      line(7, 654, [{ x: DESCRIPTION_X, text: 'continued alpha', width: 100 }]),
      wrapRow(600, 'Beta service', '3.50'),
      line(7, 594, [{ x: DESCRIPTION_X, text: 'continued beta', width: 100 }]),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'description')).toBe('Alpha service continued alpha');
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service continued beta');
    expect(result!.unassigned_lines).toHaveLength(0);
  });

  it('V2: attaches a wrapped line sitting above its own row', () => {
    // Rows whose rate sits on a middle line wrap both upwards and downwards.
    const result = reconstructSinglePage([
      wrapHeader(),
      line(7, 666, [{ x: ORIGIN_X, text: 'From the north', width: 100 }]),
      wrapRow(660, 'Alpha service', '12.00'),
      line(7, 654, [{ x: ORIGIN_X, text: 'yard to landfill', width: 100 }]),
      wrapRow(600, 'Beta service', '3.50'),
    ]);
    expect(cellText(result!.rows[0]!, 'origin_destination')).toBe('From the north A to B yard to landfill');
  });

  it('V3: reports a wrapped line that is not meaningfully nearer to either row', () => {
    // Equidistant between two rows: attaching to either would be a coin flip.
    const result = reconstructSinglePage([
      wrapHeader(),
      wrapRow(660, 'Alpha service', '12.00'),
      line(7, 630, [{ x: DESCRIPTION_X, text: 'orphan fragment', width: 100 }]),
      wrapRow(600, 'Beta service', '3.50'),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'description')).toBe('Alpha service');
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
    expect(result!.unassigned_lines).toHaveLength(1);
    expect(result!.unassigned_lines[0]!.reason).toBe('ambiguous_row_assignment');
    expect(result!.unassigned_lines[0]!.raw_text).toBe('orphan fragment');
    expect(result!.unassigned_lines[0]!.source_refs.length).toBeGreaterThan(0);
  });

  it('V4: does not flip a wrapped line between rows over a sub-point difference', () => {
    // The line is a hair past the midpoint. A midpoint threshold would hand it
    // to the far row; near-equal distances must not silently do that.
    const result = reconstructSinglePage([
      wrapHeader(),
      wrapRow(660, 'Alpha service', '12.00'),
      line(7, 629.9, [{ x: DESCRIPTION_X, text: 'borderline fragment', width: 100 }]),
      wrapRow(600, 'Beta service', '3.50'),
    ]);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
    expect(cellText(result!.rows[0]!, 'description')).toBe('Alpha service');
    expect(result!.unassigned_lines.map((entry) => entry.reason)).toEqual(['ambiguous_row_assignment']);
  });

  it('V5: reassembles a three-line wrapped description in authored order', () => {
    const result = reconstructSinglePage([
      wrapHeader(),
      wrapRow(660, 'Alpha service', '12.00'),
      line(7, 654, [{ x: DESCRIPTION_X, text: 'second line', width: 100 }]),
      line(7, 648, [{ x: DESCRIPTION_X, text: 'third line', width: 100 }]),
      wrapRow(600, 'Beta service', '3.50'),
    ]);
    expect(cellText(result!.rows[0]!, 'description')).toBe('Alpha service second line third line');
  });

  it('V6: wraps unit and route independently of description', () => {
    const result = reconstructSinglePage([
      wrapHeader(),
      wrapRow(660, 'Alpha service', '12.00'),
      line(7, 654, [
        { x: UNIT_X, text: '(each vehicle)', width: 60 },
        { x: ORIGIN_X, text: 'to final disposal', width: 100 },
      ]),
      wrapRow(600, 'Beta service', '3.50'),
    ]);
    expect(cellText(result!.rows[0]!, 'unit')).toBe('Widget (each vehicle)');
    expect(cellText(result!.rows[0]!, 'origin_destination')).toBe('A to B to final disposal');
  });

  it('V7: keeps both rows intact when neighbouring rows are each multiline', () => {
    const result = reconstructSinglePage([
      wrapHeader(),
      wrapRow(660, 'Alpha service', '12.00'),
      line(7, 654, [{ x: DESCRIPTION_X, text: 'alpha tail', width: 100 }]),
      wrapRow(600, 'Beta service', '3.50'),
      line(7, 594, [{ x: DESCRIPTION_X, text: 'beta tail', width: 100 }]),
    ]);
    expect(cellText(result!.rows[0]!, 'description')).toBe('Alpha service alpha tail');
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service beta tail');
    // No fragment of one row may appear in the other.
    expect(cellText(result!.rows[0]!, 'description')).not.toContain('beta');
    expect(cellText(result!.rows[1]!, 'description')).not.toContain('alpha');
  });

  it('V8: attribution is identical when source lines arrive in reverse order', () => {
    const lines = [
      wrapHeader(),
      wrapRow(660, 'Alpha service', '12.00'),
      line(7, 654, [{ x: DESCRIPTION_X, text: 'alpha tail', width: 100 }]),
      wrapRow(600, 'Beta service', '3.50'),
      line(7, 594, [{ x: DESCRIPTION_X, text: 'beta tail', width: 100 }]),
    ];
    expect(JSON.stringify(reconstructSinglePage([...lines].reverse())))
      .toBe(JSON.stringify(reconstructSinglePage(lines)));
  });

  // ---------------------------------------------------------------------------
  // Body bounds. The header bounds the table from above; the lowest
  // fully-populated row bounds it from below, because nothing on the page marks
  // where a table ends.
  // ---------------------------------------------------------------------------

  const threeCol = () => line(7, 700, [
    { x: DESCRIPTION_X, text: 'Description', width: 70 },
    { x: UNIT_X, text: 'Unit', width: 40 },
    { x: CURRENCY_X, text: 'Cost', width: 30 },
  ]);
  const threeColFull = (y: number, description: string, amount: string) =>
    pricedLine(7, y, { description, unit: 'Widget', currency: '$', amount });
  const threeColSparse = (y: number, description: string, amount: string) =>
    pricedLine(7, y, { description, currency: '$', amount });

  it('W: keeps a sparse first row, bounded above by the header', () => {
    const result = reconstructSinglePage([
      threeCol(),
      threeColSparse(680, 'Alpha service', '12.00'),
      threeColFull(660, 'Beta service', '3.50'),
      threeColFull(640, 'Gamma service', '7.00'),
    ]);
    expect(result!.rows).toHaveLength(3);
    expect(cellText(result!.rows[0]!, 'description')).toBe('Alpha service');
    expect(cellText(result!.rows[0]!, 'unit')).toBeNull();
  });

  it('W2: keeps a sparse middle row', () => {
    const result = reconstructSinglePage([
      threeCol(),
      threeColFull(680, 'Alpha service', '12.00'),
      threeColSparse(660, 'Beta service', '3.50'),
      threeColFull(640, 'Gamma service', '7.00'),
    ]);
    expect(result!.rows).toHaveLength(3);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
  });

  it('W3: keeps both rows of a two-row table whose first row is sparse', () => {
    const result = reconstructSinglePage([
      threeCol(),
      threeColSparse(680, 'Alpha service', '12.00'),
      threeColFull(660, 'Beta service', '3.50'),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'description')).toBe('Alpha service');
  });

  it('W4: reports a sparse line below the last fully-populated row', () => {
    // Nothing on the page marks the end of a table, so a sparse line below the
    // body cannot be told apart from a summary. It is reported, never priced.
    const result = reconstructSinglePage([
      threeCol(),
      threeColFull(680, 'Alpha service', '12.00'),
      threeColFull(660, 'Beta service', '3.50'),
      threeColSparse(640, 'Gamma service', '7.00'),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rejected_spines.map((entry) => entry.reason)).toEqual(['outside_table_body']);
    expect(result!.rejected_spines[0]!.raw_text).toContain('Gamma service');
  });

  // ---------------------------------------------------------------------------
  // Trailing content. A line at the table's edge has no competing row, so it is
  // admitted only when it matches the spacing the page has already established.
  // ---------------------------------------------------------------------------

  it('X: excludes trailing prose that matches no established continuation spacing', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 655, [{ x: DESCRIPTION_X, text: 'Payment terms are net thirty', width: 200 }]),
    ]);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service');
    expect(result!.unassigned_lines.map((entry) => entry.reason)).toEqual(['unsupported_trailing_line']);
  });

  it('X2: excludes a trailing bare number instead of folding it into the rate cell', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 655, [{ x: AMOUNT_X, text: '999.99', width: 40 }]),
    ]);
    expect(cellText(result!.rows[1]!, 'rate')).toBe('$ 3.50');
    expect(result!.rows.every((row) => row.cells.every((cell) => !cell.raw_text.includes('999.99')))).toBe(true);
    expect(result!.unassigned_lines).toHaveLength(1);
  });

  it('X3: keeps a legitimate final-row wrap once the page establishes its spacing', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      line(7, 674, [{ x: DESCRIPTION_X, text: 'alpha tail', width: 100 }]),
      pricedLine(7, 640, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 634, [{ x: DESCRIPTION_X, text: 'beta tail', width: 100 }]),
    ]);
    expect(cellText(result!.rows[1]!, 'description')).toBe('Beta service beta tail');
    expect(result!.unassigned_lines).toHaveLength(0);
  });

  it('Y: merges a value split onto its own near-baseline into the same row', () => {
    // Extractors split one visual line into two baselines; a fragment a fraction
    // of a glyph height away is the same line, not a row of its own.
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '3.50' }),
      line(7, 658.5, [{ x: ORIGIN_X, text: 'via depot', width: 60 }]),
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[1]!, 'origin_destination')).toBe('B to C via depot');
  });


  // ---------------------------------------------------------------------------
  // Row spacing is evidence. A line at either end of the sequence is measured
  // against the spacing the rest of the sequence establishes, so a candidate can
  // never widen the envelope that admits it. Interior rows are bracketed on both
  // sides and are left alone.
  // ---------------------------------------------------------------------------

  /** Builds a table whose rows sit at the given successive gaps below the first. */
  const tableWithGaps = (
    gaps: readonly number[],
    options: { finalDescription?: string } = {},
  ) => {
    const lines = [headerLine(7, 700)];
    const names = ['Alpha service', 'Beta service', 'Gamma service', 'Delta service', 'Epsilon service'];
    let y = 680;
    lines.push(pricedLine(7, y, {
      description: names[0], unit: 'Widget', origin: 'A to B', currency: '$', amount: '1.00',
    }));
    gaps.forEach((gap, index) => {
      y -= gap;
      const isLast = index === gaps.length - 1;
      lines.push(pricedLine(7, y, {
        description: isLast && options.finalDescription ? options.finalDescription : names[index + 1],
        unit: 'Widget',
        origin: 'A to B',
        currency: '$',
        amount: `${index + 2}.00`,
      }));
    });
    return lines;
  };

  it('Z: admits every row when the sequence keeps a regular pitch', () => {
    const result = reconstructSinglePage(tableWithGaps([20, 20, 20]));
    expect(result!.rows).toHaveLength(4);
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it('Z2: tolerates ordinary variation in row spacing', () => {
    const result = reconstructSinglePage(tableWithGaps([18, 20, 22]));
    expect(result!.rows).toHaveLength(4);
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it('Z3: rejects a fully-populated trailing line set apart from the sequence', () => {
    // The line fills every column, so column participation cannot distinguish it.
    // Its spacing can: it sits three times the established pitch below the table.
    const result = reconstructSinglePage(tableWithGaps([20, 20, 60], {
      finalDescription: 'Service subtotal',
    }));
    expect(result!.rows).toHaveLength(3);
    expect(result!.rows.map((row) => cellText(row, 'description'))).not.toContain('Service subtotal');
    expect(result!.rejected_spines.map((entry) => entry.reason)).toEqual(['inconsistent_row_pitch']);
    expect(result!.rejected_spines[0]!.raw_text).toContain('Service subtotal');
    expect(result!.rejected_spines[0]!.source_refs.length).toBeGreaterThan(0);
    expect(result!.rejected_spines[0]!.physical_page_number).toBe(7);
  });

  it('Z4: rejects a trailing line crowded far tighter than the sequence', () => {
    const result = reconstructSinglePage(tableWithGaps([20, 20, 5]));
    expect(result!.rows).toHaveLength(3);
    expect(result!.rejected_spines.map((entry) => entry.reason)).toEqual(['inconsistent_row_pitch']);
  });

  it('Z5: rejects a leading line set apart from the sequence', () => {
    const result = reconstructSinglePage(tableWithGaps([60, 20, 20]));
    expect(result!.rows).toHaveLength(3);
    expect(result!.rows.map((row) => cellText(row, 'description'))).not.toContain('Alpha service');
    expect(result!.rejected_spines.map((entry) => entry.reason)).toEqual(['inconsistent_row_pitch']);
  });

  it('Z6: keeps a final row that is only moderately further down', () => {
    // Within the envelope: real schedules space rows unevenly and a modestly
    // taller final row is still a row.
    const result = reconstructSinglePage(tableWithGaps([20, 22, 26]));
    expect(result!.rows).toHaveLength(4);
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it('Z7: a large gap inside the table does not remove its neighbours', () => {
    const result = reconstructSinglePage(tableWithGaps([20, 60, 20]));
    expect(result!.rows).toHaveLength(4);
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it('Z8: keeps a sequence whose spacing varies with multiline rows', () => {
    const result = reconstructSinglePage(tableWithGaps([11, 21, 16, 11]));
    expect(result!.rows).toHaveLength(5);
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it('Z9: still admits a complete trailing line at the established pitch', () => {
    // Documented limit: at identical spacing and column participation there is
    // no geometric evidence separating a summary from a final row, so this case
    // stays admitted rather than being guessed at.
    const result = reconstructSinglePage(tableWithGaps([20, 20, 20], {
      finalDescription: 'Service subtotal',
    }));
    expect(result!.rows).toHaveLength(4);
    expect(result!.rows.map((row) => cellText(row, 'description'))).toContain('Service subtotal');
  });

  it('Z10: pitch gating leaves the sparse-row outcomes unchanged', () => {
    const threeColHeader = () => line(7, 700, [
      { x: DESCRIPTION_X, text: 'Description', width: 70 },
      { x: UNIT_X, text: 'Unit', width: 40 },
      { x: CURRENCY_X, text: 'Cost', width: 30 },
    ]);
    const fullRow = (y: number, description: string, amount: string) =>
      pricedLine(7, y, { description, unit: 'Widget', currency: '$', amount });
    const sparseRow = (y: number, description: string, amount: string) =>
      pricedLine(7, y, { description, currency: '$', amount });

    const first = reconstructSinglePage([
      threeColHeader(), sparseRow(680, 'Alpha service', '1.00'),
      fullRow(660, 'Beta service', '2.00'), fullRow(640, 'Gamma service', '3.00'),
    ]);
    expect(first!.rows).toHaveLength(3);

    const middle = reconstructSinglePage([
      threeColHeader(), fullRow(680, 'Alpha service', '1.00'),
      sparseRow(660, 'Beta service', '2.00'), fullRow(640, 'Gamma service', '3.00'),
    ]);
    expect(middle!.rows).toHaveLength(3);

    const twoRowSparseFirst = reconstructSinglePage([
      threeColHeader(), sparseRow(680, 'Alpha service', '1.00'), fullRow(660, 'Beta service', '2.00'),
    ]);
    expect(twoRowSparseFirst!.rows).toHaveLength(2);

    // Unchanged debt: a sparse line below the body is still reported, not priced.
    const last = reconstructSinglePage([
      threeColHeader(), fullRow(680, 'Alpha service', '1.00'),
      fullRow(660, 'Beta service', '2.00'), sparseRow(640, 'Gamma service', '3.00'),
    ]);
    expect(last!.rows).toHaveLength(2);
    expect(last!.rejected_spines.map((entry) => entry.reason)).toEqual(['outside_table_body']);
  });

  it('Z11: a pitch-rejected edge cannot widen bodyBottom or admit another sparse row', () => {
    const result = reconstructSinglePage([
      threeCol(),
      threeColFull(680, 'Alpha service', '1.00'),
      threeColFull(660, 'Beta service', '2.00'),
      threeColFull(640, 'Gamma service', '3.00'),
      threeColSparse(620, 'Delta service', '4.00'),
      threeColFull(560, 'Detached service', '5.00'),
    ]);

    expect(result!.status).toBe('reconstructed');
    expect(result!.rows.map((row) => cellText(row, 'description'))).toEqual([
      'Alpha service', 'Beta service', 'Gamma service',
    ]);
    expect(result!.rejected_spines.map((entry) => entry.reason)).toEqual([
      'inconsistent_row_pitch',
      'outside_table_body',
    ]);
    expect(result!.rejected_spines[0]!.raw_text).toContain('Detached service');
    expect(result!.rejected_spines[1]!.raw_text).toContain('Delta service');
  });

  it('Z12: three spines abstain because excluding an edge leaves only one comparison gap', () => {
    const result = reconstructSinglePage(tableWithGaps([20, 60]));
    expect(result!.rows).toHaveLength(3);
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it('Z13: an incoherent interior baseline cannot reject otherwise normal edges', () => {
    for (const gaps of [[20, 60, 20], [20, 60.1, 20]] as const) {
      const result = reconstructSinglePage(tableWithGaps(gaps));
      expect(result!.rows).toHaveLength(4);
      expect(result!.rejected_spines).toHaveLength(0);
    }
  });

  it.each([
    [9.9, 3, ['inconsistent_row_pitch']],
    [10, 4, []],
    [10.1, 4, []],
    [39.9, 4, []],
    [40, 4, []],
    [40.1, 3, ['inconsistent_row_pitch']],
  ] as const)('Z14: applies the inclusive pitch boundary to a final gap of %s', (gap, rowCount, reasons) => {
    const result = reconstructSinglePage(tableWithGaps([20, 20, gap]));
    expect(result!.rows).toHaveLength(rowCount);
    expect(result!.rejected_spines.map((entry) => entry.reason)).toEqual(reasons);
  });

  const rateTokenRow = (
    y: number,
    description: string,
    rateTokens: readonly TokenSpec[],
  ) => line(7, y, [
    { x: DESCRIPTION_X, text: description, width: 100 },
    { x: UNIT_X, text: 'Widget', width: 60 },
    { x: ORIGIN_X, text: 'A to B', width: 100 },
    ...rateTokens,
  ]);
  const withCandidateRate = (rateTokens: readonly TokenSpec[]) => [
    headerLine(7),
    rateTokenRow(680, 'Candidate service', rateTokens),
    pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '2.00' }),
    pricedLine(7, 640, { description: 'Gamma service', unit: 'Widget', origin: 'C to D', currency: '$', amount: '3.00' }),
  ];

  it('AA: accepts one currency-led rate cluster', () => {
    const result = reconstructSinglePage(withCandidateRate([
      { x: CURRENCY_X, text: '$12.00', width: 50 },
    ]));
    expect(cellText(result!.rows[0]!, 'rate')).toBe('$12.00');
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it('AA2: accepts a split currency symbol and numeric value as one cluster', () => {
    const result = reconstructSinglePage(withCandidateRate([
      { x: CURRENCY_X, text: '$', width: 8 },
      { x: AMOUNT_X, text: '12.00', width: 40 },
    ]));
    expect(cellText(result!.rows[0]!, 'rate')).toBe('$ 12.00');
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it('AA3: preserves a split authored nonnumeric marker as one cluster', () => {
    const recon = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, withCandidateRate([
        { x: CURRENCY_X, text: '$', width: 8 },
        { x: AMOUNT_X, text: '-', width: 8 },
      ]))]),
    });
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: recon });
    expect(rows[0]!.rate_raw).toBe('$ -');
    expect(rows[0]!.rate).toBeNull();
    expect(recon.pages[0]!.rejected_spines).toHaveLength(0);
  });

  it('AA4: treats a currency-led hourly expression as one rate cluster', () => {
    const result = reconstructSinglePage(withCandidateRate([
      { x: CURRENCY_X, text: '$12.00', width: 50 },
      { x: 510, text: '/', width: 8 },
      { x: 525, text: 'hour', width: 25 },
    ]));
    expect(cellText(result!.rows[0]!, 'rate')).toBe('$12.00 / hour');
    expect(result!.rejected_spines).toHaveLength(0);
  });

  it.each([
    ['adjacent currency clusters', [
      { x: CURRENCY_X, text: '$12.00', width: 50 },
      { x: 510, text: '$120.00', width: 55 },
    ]],
    ['widely separated currency clusters', [
      { x: CURRENCY_X, text: '$12.00', width: 50 },
      { x: 550, text: '$120.00', width: 55 },
    ]],
    ['duplicate-looking currency clusters', [
      { x: CURRENCY_X, text: '$12.00', width: 50 },
      { x: CURRENCY_X + 1, text: '$12.00', width: 50 },
    ]],
    ['a currency cluster plus a bare numeric cluster', [
      { x: CURRENCY_X, text: '$12.00', width: 50 },
      { x: 540, text: '120', width: 25 },
    ]],
  ] as const)('AA5: rejects %s without publishing a numeric rate', (_label, rateTokens) => {
    const recon = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, withCandidateRate(rateTokens))]),
    });
    const result = recon.pages[0]!;
    const diagnostic = result.rejected_spines.find((entry) => entry.reason === 'ambiguous_rate_clusters');
    const rows = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: recon });

    expect(result.rows.map((row) => cellText(row, 'description'))).not.toContain('Candidate service');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.source_refs.filter((ref) => /12\.00|120/.test(ref.text)).length).toBe(2);
    expect(rows.map((row) => row.description)).not.toContain('Candidate service');
  });

  it('AA5b: rejects a second monetary cluster on an assigned continuation line', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      rateTokenRow(680, 'Candidate service', [
        { x: CURRENCY_X, text: '$12.00', width: 50 },
      ]),
      line(7, 674, [{ x: 540, text: '120', width: 25 }]),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '2.00' }),
      pricedLine(7, 640, { description: 'Gamma service', unit: 'Widget', origin: 'C to D', currency: '$', amount: '3.00' }),
    ]);
    const diagnostic = result!.rejected_spines.find((entry) => entry.reason === 'ambiguous_rate_clusters');
    expect(result!.rows.map((row) => cellText(row, 'description'))).not.toContain('Candidate service');
    expect(diagnostic!.raw_text).toContain('$12.00');
    expect(diagnostic!.raw_text).toContain('120');
  });

  it('AA6: a pitch-rejected diagnostic retains its assigned continuation evidence', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Alpha service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '1.00' }),
      pricedLine(7, 660, { description: 'Beta service', unit: 'Widget', origin: 'B to C', currency: '$', amount: '2.00' }),
      pricedLine(7, 640, { description: 'Gamma service', unit: 'Widget', origin: 'C to D', currency: '$', amount: '3.00' }),
      pricedLine(7, 580, { description: 'Detached service', unit: 'Widget', origin: 'D to E', currency: '$', amount: '4.00' }),
      line(7, 574, [{ x: DESCRIPTION_X, text: 'detached continuation', width: 100 }]),
    ]);
    const diagnostic = result!.rejected_spines.find((entry) => entry.reason === 'inconsistent_row_pitch');
    expect(diagnostic!.raw_text).toContain('Detached service');
    expect(diagnostic!.raw_text).toContain('detached continuation');
    expect(diagnostic!.source_refs.some((ref) => ref.text === 'detached continuation')).toBe(true);
  });

  it('AA7: preserves rows and diagnostics byte-for-byte under line and token reversal', () => {
    const lines = [
      threeCol(),
      threeColFull(680, 'Alpha service', '1.00'),
      threeColFull(660, 'Beta service', '2.00'),
      threeColFull(640, 'Gamma service', '3.00'),
      threeColSparse(620, 'Delta service', '4.00'),
      threeColFull(560, 'Detached service', '5.00'),
    ];
    const reversed = [...lines].reverse().map((entry) => ({
      ...entry,
      tokens: [...entry.tokens].reverse(),
    }));
    expect(JSON.stringify(reconstructSinglePage(reversed)))
      .toBe(JSON.stringify(reconstructSinglePage(lines)));
  });

  it('AA8: retains an explicit failed-closed diagnostic for a single priced row', () => {
    const result = reconstructSinglePage([
      headerLine(7),
      pricedLine(7, 680, { description: 'Only service', unit: 'Widget', origin: 'A to B', currency: '$', amount: '12.00' }),
    ]);
    expect(result!.status).toBe('failed_closed');
    expect(result!.rows).toEqual([]);
    expect(result!.rejected_spines.map((entry) => entry.reason)).toEqual(['insufficient_priced_rows']);
    expect(result!.rejected_spines[0]!.raw_text).toContain('Only service');
  });

  // ---------------------------------------------------------------------------
  // OCR: word-level token sources present multi-word labels as separate tokens.
  // A header is either resolved deterministically (token-by-token, or by
  // grouping words the line's own geometry clearly separates from column gaps)
  // or reported unresolved with its evidence and source-backed options.
  // ---------------------------------------------------------------------------

  const wordLevelBody = [
    line(7, 680, [
      { x: DESCRIPTION_X, text: 'Alpha', width: 25 }, { x: 78, text: 'service', width: 35 },
      { x: UNIT_X, text: 'Widget', width: 30 }, { x: 445, text: '$12.00', width: 35 },
    ]),
    line(7, 660, [
      { x: DESCRIPTION_X, text: 'Beta', width: 22 }, { x: 75, text: 'service', width: 35 },
      { x: UNIT_X, text: 'Widget', width: 30 }, { x: 445, text: '$3.50', width: 30 },
    ]),
  ];
  const refTexts = (label: { source_refs: readonly { text: string }[] }) => label.source_refs.map((ref) => ref.text);

  it('OCR1: groups a clearly separated split header and records each label\'s source tokens', () => {
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Item', width: 20 }, { x: 73, text: 'Description', width: 55 },
        { x: UNIT_X, text: 'Unit', width: 20 },
        { x: 440, text: 'Unit', width: 20 }, { x: 463, text: 'Price', width: 25 },
      ]),
      ...wordLevelBody,
    ]);
    expect(result).toMatchObject({ status: 'reconstructed' });
    expect(result!.columns.map((column) => [column.header_text, column.role])).toEqual([
      ['Item Description', 'description'], ['Unit', 'unit'], ['Unit Price', 'rate'],
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(cellText(result!.rows[0]!, 'rate')).toBe('$12.00');
    const interpretation = result!.header_interpretation!;
    expect(interpretation).toMatchObject({
      version: 'priced_schedule_header_interpretation_v1',
      status: 'resolved_deterministically', method: 'word_grouped_labels',
    });
    expect(interpretation.grouping_basis).toMatchObject({ clear: true, max_intra_label_gap_ratio: 0.3, min_column_gap_ratio: 7.2 });
    expect(interpretation.labels.map((label) => [label.text, refTexts(label)])).toEqual([
      ['Item Description', ['Item', 'Description']], ['Unit', ['Unit']], ['Unit Price', ['Unit', 'Price']],
    ]);
    // The source tokens are cited with their own geometry, never replaced.
    expect(interpretation.labels[2]!.source_refs.map((ref) => ref.x_min)).toEqual([440, 463]);
    expect(interpretation.source_refs.map((ref) => ref.text)).toEqual(['Item', 'Description', 'Unit', 'Unit', 'Price']);
  });

  it('OCR2: does not group when word spaces and column gaps are not clearly separated', () => {
    // Widest word gap 0.6 x height, narrowest column gap 1.0 x: less than 2x apart.
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Description', width: 55 },
        { x: UNIT_X, text: 'Unit', width: 20 },
        { x: 430, text: 'Unit', width: 20 }, { x: 456, text: 'Price', width: 25 }, { x: 491, text: 'Rate', width: 20 },
      ]),
      ...wordLevelBody,
    ]);
    expect(result).toMatchObject({ status: 'failed_closed', columns: [], rows: [] });
    const interpretation = result!.header_interpretation!;
    expect(interpretation).toMatchObject({ status: 'unresolved', reason: 'ambiguous_label_grouping' });
    expect(interpretation.grouping_basis).toMatchObject({ clear: false });
    // Alternatives vary only the uncertain gaps and cite only the line's tokens.
    const options = interpretation.options!;
    expect(options.length).toBeGreaterThan(1);
    for (const option of options) {
      expect(option.kind).toBe('label_grouping');
      expect(option.labels.flatMap((label) => refTexts(label))).toEqual(['Description', 'Unit', 'Unit', 'Price', 'Rate']);
      for (const label of option.labels) expect(label.text).toBe(refTexts(label).join(' '));
    }
    expect(new Set(options.map((option) => option.option_id)).size).toBe(options.length);
  });

  it('OCR3: an unrecognized label leaves its role unresolved while the table structure survives', () => {
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Equipment', width: 45 }, { x: 99, text: 'Description', width: 55 },
        { x: UNIT_X, text: 'Unit', width: 20 },
        { x: 440, text: 'Unit', width: 20 }, { x: 463, text: 'Price', width: 25 },
      ]),
      ...wordLevelBody,
    ]);
    // Structure resolved, semantics not: the table is rebuilt from geometry and
    // "Equipment Description" stays authored text in a role-less column.
    expect(result).toMatchObject({ status: 'reconstructed', semantic_status: 'unresolved' });
    expect(result!.columns.map((column) => [column.header_text, column.role])).toEqual([
      ['Equipment Description', null], ['Unit', 'unit'], ['Unit Price', 'rate'],
    ]);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rows[0]!.cells.map((cell) => [cell.role, cell.raw_text])).toEqual([['unit', 'Widget'], ['rate', '$12.00']]);
    expect(result!.rows[0]!.unresolved_role_cells).toEqual([expect.objectContaining({
      role: null, column_index: 0, header_text: 'Equipment Description', raw_text: 'Alpha service',
    })]);
    expect(result!.rows.flatMap((row) => row.cells).some((cell) => cell.role === 'description')).toBe(false);
    // Promoting the column to a role needs a reviewed choice of this option.
    const interpretation = result!.header_interpretation!;
    expect(interpretation).toMatchObject({ status: 'unresolved', reason: 'required_role_missing' });
    expect(interpretation.labels.map((label) => [label.text, label.role])).toEqual([
      ['Equipment Description', null], ['Unit', 'unit'], ['Unit Price', 'rate'],
    ]);
    expect(interpretation.options).toHaveLength(1);
    const option = interpretation.options![0]!;
    expect(option).toMatchObject({ kind: 'role_assignment', qualifies: true });
    expect(option.labels.map((label) => [label.text, label.role, refTexts(label)])).toEqual([
      ['Equipment Description', 'description', ['Equipment', 'Description']],
      ['Unit', 'unit', ['Unit']], ['Unit Price', 'rate', ['Unit', 'Price']],
    ]);
  });

  it('OCR4: a role naming two separate columns still fails closed, offering which to keep', () => {
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Description', width: 55 },
        { x: UNIT_X, text: 'Unit', width: 20 }, { x: ORIGIN_X, text: 'Unit', width: 20 },
        { x: 440, text: 'Price', width: 25 },
      ]),
      ...wordLevelBody,
    ]);
    expect(result).toMatchObject({ status: 'failed_closed', columns: [], rows: [] });
    const interpretation = result!.header_interpretation!;
    expect(interpretation).toMatchObject({ status: 'unresolved', reason: 'duplicate_role' });
    expect(interpretation.options!.map((option) => option.labels.map((label) => label.role))).toEqual([
      ['description', 'unit', null, 'rate'],
      ['description', null, 'unit', 'rate'],
    ]);
  });

  it('OCR5: word-level prose never becomes a header or a recovery candidate', () => {
    // Repeated role words make the token-by-token read fail; grouped, the words form
    // one long run that is not a compact label, so no header can come of it.
    const words = 'Unit pricing per Unit Price shall follow the Description of Cost'.split(' ');
    let x = DESCRIPTION_X;
    const result = reconstructSinglePage([
      line(7, 700, words.map((text) => {
        const spec = { x, text, width: text.length * 5 };
        x += spec.width + 3;
        return spec;
      })),
      ...wordLevelBody,
    ]);
    expect(result).toBeNull();
  });

  it('OCR6: header-like labels with no priced lines below are not a recovery candidate', () => {
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Equipment', width: 45 }, { x: 99, text: 'Description', width: 55 },
        { x: UNIT_X, text: 'Unit', width: 20 },
        { x: 440, text: 'Unit', width: 20 }, { x: 463, text: 'Price', width: 25 },
      ]),
      line(7, 680, [{ x: DESCRIPTION_X, text: 'Nearby', width: 30 }, { x: 90, text: 'words', width: 25 }]),
    ]);
    expect(result).toBeNull();
  });

  it('OCR7: a header that qualifies token-by-token is read exactly as before, even with tight gaps', () => {
    const result = reconstructSinglePage([
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Description', width: 70 },
        { x: 124, text: 'Unit', width: 20 },
        { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
        { x: CURRENCY_X, text: 'Cost', width: 30 },
      ]),
      ...twoBodyRows,
    ]);
    expect(result).not.toBeNull();
    expect(result!.columns.map((column) => column.header_text)).toEqual([
      'Description', 'Unit', 'Origin/ Destination', 'Cost',
    ]);
    expect(result!).not.toHaveProperty('header_interpretation');
  });

  it('OCR8: interpretation never alters the source layout tokens', () => {
    const lines = [
      line(7, 700, [
        { x: DESCRIPTION_X, text: 'Equipment', width: 45 }, { x: 99, text: 'Description', width: 55 },
        { x: UNIT_X, text: 'Unit', width: 20 },
        { x: 440, text: 'Unit', width: 20 }, { x: 463, text: 'Price', width: 25 },
      ]),
      ...wordLevelBody,
    ];
    const layout = layoutOf([page(7, lines)]);
    const before = JSON.stringify(layout);
    buildPagePricedScheduleReconstruction({ layout });
    expect(JSON.stringify(layout)).toBe(before);
  });

  it('OCR9: the description vocabulary is unchanged: only its generic labels resolve', () => {
    for (const label of ['Description', 'Item Description', 'Item', 'Description of Work']) {
      const result = reconstructSinglePage([headerWith('Cost', label), ...twoBodyRows]);
      expect(result, `description label ${label} must be recognised`).toMatchObject({ status: 'reconstructed' });
    }
    for (const label of ['Equipment Description', 'Heavy Equipment Description']) {
      const result = reconstructSinglePage([headerWith('Cost', label), ...twoBodyRows]);
      expect(result, `${label} must not be given a role`).toMatchObject({ status: 'reconstructed', semantic_status: 'unresolved' });
      expect(result!.columns[0]).toMatchObject({ role: null, header_text: label });
      expect(result!.rows.flatMap((row) => row.cells).some((cell) => cell.role === 'description')).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // R2: source structure survives independently of semantic roles. A column the
  // header defines keeps its body cells even when its role is unknown; those
  // cells are role-less structure, never pricing evidence.
  // ---------------------------------------------------------------------------

  const LINE_X = 10;
  const withLineNumbers = (lineNumbers: boolean) => [
    line(7, 700, [
      { x: LINE_X, text: 'Line #', width: 30 },
      { x: DESCRIPTION_X, text: 'Description', width: 70 },
      { x: UNIT_X, text: 'Unit of Measure', width: 80 },
      { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
      { x: CURRENCY_X, text: 'Cost', width: 30 },
    ]),
    line(7, 680, [
      ...(lineNumbers ? [{ x: LINE_X, text: '0001', width: 25 }] : []),
      { x: DESCRIPTION_X, text: 'Alpha service', width: 100 }, { x: UNIT_X, text: 'Widget', width: 60 },
      { x: ORIGIN_X, text: 'A to B', width: 100 }, { x: CURRENCY_X, text: '$', width: 8 }, { x: AMOUNT_X, text: '12.00', width: 40 },
    ]),
    line(7, 660, [
      ...(lineNumbers ? [{ x: LINE_X, text: '0002', width: 25 }] : []),
      { x: DESCRIPTION_X, text: 'Beta service', width: 100 }, { x: UNIT_X, text: 'Widget', width: 60 },
      { x: ORIGIN_X, text: 'B to C', width: 100 }, { x: CURRENCY_X, text: '$', width: 8 }, { x: AMOUNT_X, text: '3.50', width: 40 },
    ]),
  ];

  it('R2-1: a table of recognized columns is unchanged and carries no role-less fields', () => {
    const result = reconstructSinglePage([headerWith('Cost'), ...twoBodyRows])!;
    expect(result.status).toBe('reconstructed');
    expect(result).not.toHaveProperty('semantic_status');
    expect(result).not.toHaveProperty('unattached_role_less_tokens');
    for (const row of result.rows) expect(row).not.toHaveProperty('unresolved_role_cells');
  });

  it('R2-2: an unknown column keeps its authored header, its source tokens, and its cells', () => {
    const result = reconstructSinglePage(withLineNumbers(true))!;
    expect(result.status).toBe('reconstructed');
    expect(result).not.toHaveProperty('semantic_status');
    expect(result.columns[0]).toMatchObject({ role: null, header_text: 'Line #' });
    expect(result.columns[0]!.header_source_refs!.map((ref) => ref.text)).toEqual(['Line #']);
    expect(result.rows.map((row) => row.unresolved_role_cells)).toEqual([
      [expect.objectContaining({ role: null, column_index: 0, header_text: 'Line #', raw_text: '0001' })],
      [expect.objectContaining({ role: null, column_index: 0, header_text: 'Line #', raw_text: '0002' })],
    ]);
    const cell = result.rows[0]!.unresolved_role_cells![0]!;
    expect(cell.source_refs.map((ref) => [ref.text, ref.x_min])).toEqual([['0001', LINE_X]]);
    // No canonical role name is written anywhere for the unknown column.
    expect(JSON.stringify(result.rows[0]!.unresolved_role_cells)).not.toMatch(/description|unit|rate|origin/);
  });

  it('R2-3: role-less cells never change row admission or the resolved-role cells', () => {
    const withTokens = reconstructSinglePage(withLineNumbers(true))!;
    const withoutTokens = reconstructSinglePage(withLineNumbers(false))!;
    expect(withTokens.rows.map((row) => row.cells)).toEqual(withoutTokens.rows.map((row) => row.cells));
    expect(withTokens.rows.map((row) => row.raw_text)).toEqual(withoutTokens.rows.map((row) => row.raw_text));
  });

  it('R2-4: role-less cells never become pricing facts', () => {
    const priced = (lines: readonly PdfLayoutLine[]) => buildContractRateScheduleRows({
      rateTable: null,
      pricedScheduleReconstruction: buildPagePricedScheduleReconstruction({ layout: layoutOf([page(7, lines)]) }),
    });
    const withTokens = priced(withLineNumbers(true));
    expect(withTokens).toHaveLength(2);
    expect(withTokens).toEqual(priced(withLineNumbers(false)));
    expect(JSON.stringify(withTokens)).not.toMatch(/0001|0002/);
  });

  it('R2-5: a page whose required role is unresolved yields structure but no pricing facts', () => {
    const recon = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, [headerWith('Cost', 'Equipment Description'), ...twoBodyRows])]),
    });
    expect(recon.pages[0]).toMatchObject({ status: 'reconstructed', semantic_status: 'unresolved' });
    expect(recon.pages[0]!.rows).toHaveLength(2);
    expect(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: recon })).toEqual([]);
  });

  it('R2-6: pricing abstains on any page marked semantically unresolved, whatever its cells', () => {
    const recon = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, [headerWith('Cost'), ...twoBodyRows])]),
    });
    expect(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: recon })).toHaveLength(2);
    const marked = { ...recon, pages: recon.pages.map((entry) => ({ ...entry, semantic_status: 'unresolved' as const })) };
    expect(buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: marked })).toEqual([]);
  });

  it('R2-7: a role-less token not inside exactly one row is reported, never guessed', () => {
    const lines = withLineNumbers(false);
    // Between the two rows' vertical extents: it belongs to neither.
    lines.push(line(7, 670, [{ x: LINE_X, text: '0099', width: 25 }]));
    const result = reconstructSinglePage(lines)!;
    expect(result.rows.every((row) => !row.unresolved_role_cells)).toBe(true);
    expect(result.unattached_role_less_tokens!.map((token) => [token.text, token.column_index])).toEqual([['0099', 0]]);
  });

  it('R2-8: a header that does not account for a missing required role stays failed closed', () => {
    // Only the rate side of the header is present: no column could hold the
    // description, so the table's columns are not bounded by the header.
    const result = reconstructSinglePage([
      line(7, 700, [{ x: ORIGIN_X, text: 'Origin/ Destination', width: 90 }, { x: CURRENCY_X, text: 'Cost', width: 30 }]),
      ...twoBodyRows,
    ]);
    expect(result).toMatchObject({ status: 'failed_closed', columns: [], rows: [] });
  });

  // ---------------------------------------------------------------------------
  // R3: row-start anchors. An identifier-like role-less column (one token per
  // row, at each row's first line) proves where authored rows begin. Wrapped
  // lines spacing cannot place are then attributed by the anchors; unproven or
  // contradicted anchors are never used.
  // ---------------------------------------------------------------------------

  type AnchorRow = { anchor?: string; anchorOnSecondLine?: boolean; description: string; wrap?: string; amount?: string; marker?: string };
  const anchoredTable = (rows: readonly AnchorRow[], anchorTokens?: (row: AnchorRow) => TokenSpec[]) => {
    const lines: PdfLayoutLine[] = [line(7, 700, [
      { x: LINE_X, text: 'Line #', width: 30 },
      { x: DESCRIPTION_X, text: 'Description', width: 70 },
      { x: UNIT_X, text: 'Unit of Measure', width: 80 },
      { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
      { x: CURRENCY_X, text: 'Cost', width: 30 },
    ])];
    let y = 680;
    for (const row of rows) {
      const anchor = row.anchor ? (anchorTokens ? anchorTokens(row) : [{ x: LINE_X, text: row.anchor, width: 25 }]) : [];
      lines.push(line(7, y, [
        ...(row.anchorOnSecondLine ? [] : anchor),
        { x: DESCRIPTION_X, text: row.description, width: 100 }, { x: UNIT_X, text: 'Widget', width: 60 },
        { x: ORIGIN_X, text: 'A to B', width: 100 },
        ...(row.marker === '' ? [] : [{ x: CURRENCY_X, text: row.marker ?? '$', width: 8 }]),
        { x: AMOUNT_X, text: row.amount ?? '12.00', width: 40 },
      ]));
      y -= 12;
      if (row.wrap || row.anchorOnSecondLine) {
        lines.push(line(7, y, [
          ...(row.anchorOnSecondLine ? anchor : []),
          ...(row.wrap ? [{ x: DESCRIPTION_X, text: row.wrap, width: 60 }] : []),
        ]));
        y -= 12;
      }
    }
    return lines;
  };
  const wrapped: AnchorRow[] = [
    { anchor: '0001', description: 'Alpha service', wrap: 'first wrap' },
    { anchor: '0002', description: 'Beta service', wrap: 'second wrap' },
    { anchor: '0003', description: 'Gamma service' },
  ];

  it('R3-1: spacing alone cannot place a wrapped line midway between two priced lines', () => {
    const result = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, anchoredTable(wrapped))]), continuationEvidence: 'spacing_only',
    }).pages[0]!;
    expect(result.unassigned_lines.map((entry) => [entry.reason, entry.raw_text])).toEqual([
      ['ambiguous_row_assignment', 'first wrap'], ['ambiguous_row_assignment', 'second wrap'],
    ]);
  });

  it('R3-2: an identifier column establishes row starts and attributes each wrap to its row', () => {
    const result = reconstructSinglePage(anchoredTable(wrapped))!;
    expect(result.unassigned_lines).toEqual([]);
    expect(result.rows.map((row) => cellText(row, 'description'))).toEqual([
      'Alpha service first wrap', 'Beta service second wrap', 'Gamma service',
    ]);
    // The wrapped cell keeps both source lines' tokens; nothing is composed.
    expect(result.rows[0]!.cells.find((cell) => cell.role === 'description')!.source_refs.map((ref) => ref.text))
      .toEqual(['Alpha service', 'first wrap']);
    // The identifier column shaped the rows but stays role-less structure.
    expect(result.columns[0]).toMatchObject({ role: null, header_text: 'Line #' });
    expect(result.rows.map((row) => row.unresolved_role_cells!.map((cell) => cell.raw_text))).toEqual([['0001'], ['0002'], ['0003']]);
  });

  it('R3-3: a column is not an anchor unless every row line holds exactly one token', () => {
    const result = reconstructSinglePage(anchoredTable(wrapped, (row) => [
      { x: LINE_X, text: row.anchor!, width: 12 }, { x: LINE_X + 16, text: 'x', width: 6 },
    ]))!;
    expect(result.unassigned_lines.map((entry) => entry.reason)).toEqual(['ambiguous_row_assignment', 'ambiguous_row_assignment']);
  });

  it('R3-4: anchors that do not sit at row starts are never used', () => {
    // The identifier sits on each row's second line: priced lines fall above the
    // first anchor, so the anchors cannot bound the rows and spacing rules stand.
    const rows = wrapped.map((row) => ({ ...row, wrap: undefined, anchorOnSecondLine: true }));
    const anchored = reconstructSinglePage(anchoredTable(rows))!;
    const spacing = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, anchoredTable(rows))]), continuationEvidence: 'spacing_only',
    }).pages[0]!;
    expect(anchored.rows.map((row) => row.cells)).toEqual(spacing.rows.map((row) => row.cells));
    expect(anchored.unassigned_lines).toEqual(spacing.unassigned_lines);
  });

  it('R3-5: a row without a price marker is reported, never folded into its priced neighbours', () => {
    // No amount at all: a lone well-formed amount there would now be a structured
    // rate (R4), so the unpriced row carries non-numeric authored text instead.
    const rows: AnchorRow[] = [
      { anchor: '0001', description: 'Alpha service' },
      // Its two lines are each clearly nearer a different priced neighbour.
      { anchor: '0002', description: 'Unpriced service', marker: '', amount: 'TBD', wrap: 'unpriced wrap' },
      { anchor: '0003', description: 'Gamma service' },
      { anchor: '0004', description: 'Delta service' },
    ];
    const spacing = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, anchoredTable(rows))]), continuationEvidence: 'spacing_only',
    }).pages[0]!;
    const anchored = reconstructSinglePage(anchoredTable(rows))!;
    // Without anchors each unpriced line is credited to a priced neighbour (making it ambiguous).
    expect(spacing.rows.some((row) => row.raw_text.includes('Unpriced service'))
      || spacing.rejected_spines.some((entry) => entry.raw_text.includes('Unpriced service'))).toBe(true);
    expect(anchored.rows.map((row) => cellText(row, 'description'))).toEqual(['Alpha service', 'Gamma service', 'Delta service']);
    expect(anchored.rows.every((row) => !row.raw_text.includes('Unpriced'))).toBe(true);
    expect(anchored.unassigned_lines.map((entry) => [entry.reason, entry.raw_text])).toEqual([
      ['unpriced_row', 'Unpriced service Widget A to B TBD'], ['unpriced_row', 'unpriced wrap'],
    ]);
  });

  it('R3-6: anchored rows price normally and an unpriced row prices nothing', () => {
    const rows: AnchorRow[] = [
      { anchor: '0001', description: 'Alpha service', wrap: 'first wrap' },
      { anchor: '0002', description: 'Unpriced service', marker: '', amount: 'TBD' },
      { anchor: '0003', description: 'Gamma service' },
    ];
    const recon = buildPagePricedScheduleReconstruction({ layout: layoutOf([page(7, anchoredTable(rows))]) });
    const priced = buildContractRateScheduleRows({ rateTable: null, pricedScheduleReconstruction: recon });
    expect(priced.map((row) => [row.description, row.rate])).toEqual([['Alpha service first wrap', 12], ['Gamma service', 12]]);
    expect(JSON.stringify(priced)).not.toMatch(/Unpriced|000[123]/);
  });

  it('R3-7: prose with no identifier column is unaffected by anchors', () => {
    const lines = [headerWith('Cost'), ...twoBodyRows];
    const anchored = reconstructSinglePage(lines);
    const spacing = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, lines)]), continuationEvidence: 'spacing_only',
    }).pages[0] ?? null;
    expect(anchored).toEqual(spacing);
  });

  // ---------------------------------------------------------------------------
  // R4: structured rate cells. On a page whose header semantics are resolved and
  // whose row-start anchors are proven, a row whose currency marker was not read
  // is still priced when its rate column holds exactly one well-formed amount --
  // optionally beside one glyph standing where the page's own recognized markers
  // stand. The glyph is kept verbatim; no marker is ever manufactured.
  // ---------------------------------------------------------------------------

  const EXTENDED_X = 540;
  type RateRow = {
    anchor: string; description: string; rate?: TokenSpec[]; wrap?: string; wrapRate?: TokenSpec[];
    unitText?: string; extended?: string;
  };
  const recognized = (amount = '12.00'): TokenSpec[] => [{ x: CURRENCY_X, text: '$', width: 8 }, { x: AMOUNT_X, text: amount, width: 40 }];
  const structuredTable = (rows: readonly RateRow[], options: { descriptionLabel?: string; extended?: boolean } = {}) => {
    const lines: PdfLayoutLine[] = [line(7, 700, [
      { x: LINE_X, text: 'Line #', width: 30 },
      { x: DESCRIPTION_X, text: options.descriptionLabel ?? 'Description', width: 70 },
      { x: UNIT_X, text: 'Unit of Measure', width: 80 },
      { x: ORIGIN_X, text: 'Origin/ Destination', width: 90 },
      { x: CURRENCY_X, text: 'Cost', width: 30 },
      ...(options.extended ? [{ x: EXTENDED_X, text: 'Extended Amount', width: 60 }] : []),
    ])];
    let y = 680;
    for (const row of rows) {
      lines.push(line(7, y, [
        { x: LINE_X, text: row.anchor, width: 25 },
        { x: DESCRIPTION_X, text: row.description, width: 100 },
        { x: UNIT_X, text: row.unitText ?? 'Widget', width: 60 },
        { x: ORIGIN_X, text: 'A to B', width: 100 },
        ...(row.rate ?? recognized()),
        ...(row.extended ? [{ x: EXTENDED_X, text: row.extended, width: 50 }] : []),
      ]));
      y -= 12;
      if (row.wrap || row.wrapRate) {
        lines.push(line(7, y, [
          ...(row.wrap ? [{ x: DESCRIPTION_X, text: row.wrap, width: 60 }] : []),
          ...(row.wrapRate ?? []),
        ]));
        y -= 12;
      }
    }
    return lines;
  };
  const middle = (rate: TokenSpec[], extra: Partial<RateRow> = {}): RateRow[] => [
    { anchor: '0001', description: 'Alpha service' },
    { anchor: '0002', description: 'Beta service', rate, ...extra },
    { anchor: '0003', description: 'Gamma service' },
    { anchor: '0004', description: 'Delta service' },
  ];
  const rateCellOf = (row: NonNullable<ReturnType<typeof reconstructSinglePage>>['rows'][number]) =>
    row.cells.find((cell) => cell.role === 'rate')!;
  const priceOf = (lines: readonly PdfLayoutLine[]) => buildContractRateScheduleRows({
    rateTable: null, pricedScheduleReconstruction: buildPagePricedScheduleReconstruction({ layout: layoutOf([page(7, lines)]) }),
  }).map((row) => [row.description, row.rate_raw, row.rate]);

  it('R4-1: a recognized currency marker prices exactly as before, with no structured derivation', () => {
    const result = reconstructSinglePage(structuredTable(middle(recognized('120.00'))))!;
    expect(result.rows.map((row) => cellText(row, 'rate'))).toEqual(['$ 12.00', '$ 120.00', '$ 12.00', '$ 12.00']);
    expect(result.rows.every((row) => rateCellOf(row).structured_rate === undefined)).toBe(true);
    expect(result.unassigned_lines).toEqual([]);
  });

  it('R4-2: a lone well-formed amount in an anchored row\'s rate column is the rate', () => {
    const result = reconstructSinglePage(structuredTable(middle([{ x: AMOUNT_X, text: '120.00', width: 40 }])))!;
    expect(result.unassigned_lines).toEqual([]);
    expect(result.rows.map((row) => cellText(row, 'description'))).toEqual(['Alpha service', 'Beta service', 'Gamma service', 'Delta service']);
    const rate = rateCellOf(result.rows[1]!);
    expect(rate.raw_text).toBe('120.00');
    expect(rate.structured_rate).toEqual({
      derivation: 'structured_numeric_rate', amount_text: '120.00', amount_source_ref: rate.source_refs[0],
    });
  });

  it('R4-3: an unread marker glyph stays verbatim evidence and never enters the number', () => {
    for (const glyph of ['5', '§', 's']) {
      const lines = structuredTable(middle([{ x: CURRENCY_X, text: glyph, width: 8 }, { x: AMOUNT_X, text: '120.00', width: 40 }]));
      const rate = rateCellOf(reconstructSinglePage(lines)!.rows[1]!);
      expect(rate.raw_text, glyph).toBe(`${glyph} 120.00`);
      expect(rate.source_refs.map((ref) => ref.text)).toEqual([glyph, '120.00']);
      expect(rate.structured_rate).toMatchObject({ amount_text: '120.00', marker_source_ref: { text: glyph } });
      expect(JSON.stringify(rate)).not.toContain('$');
      expect(priceOf(lines)[1], glyph).toEqual(['Beta service', `${glyph} 120.00`, 120]);
    }
  });

  it('R4-4: the same amount outside the rate column is never a rate', () => {
    const result = reconstructSinglePage(structuredTable(middle([], { unitText: '120.00' })))!;
    expect(result.rows.map((row) => cellText(row, 'description'))).toEqual(['Alpha service', 'Gamma service', 'Delta service']);
    expect(result.unassigned_lines.map((entry) => [entry.reason, entry.raw_text])).toEqual([['unpriced_row', 'Beta service 120.00 A to B']]);
  });

  it('R4-5: two amounts in one row\'s rate column fail closed', () => {
    const sameLine = middle([{ x: 425, text: '95.00', width: 20 }, { x: AMOUNT_X, text: '120.00', width: 40 }]);
    const wrapped = middle([{ x: AMOUNT_X, text: '120.00', width: 40 }], { wrap: 'wrap', wrapRate: [{ x: AMOUNT_X, text: '95.00', width: 40 }] });
    for (const rows of [sameLine, wrapped]) {
      const result = reconstructSinglePage(structuredTable(rows))!;
      expect(result.rows.map((row) => cellText(row, 'description'))).toEqual(['Alpha service', 'Gamma service', 'Delta service']);
      expect(result.unassigned_lines.every((entry) => entry.reason === 'unpriced_row')).toBe(true);
      expect(result.rows.some((row) => rateCellOf(row).structured_rate)).toBe(false);
    }
  });

  it('R4-6: a page whose header semantics are unresolved is never priced structurally', () => {
    const lines = structuredTable(middle([{ x: AMOUNT_X, text: '120.00', width: 40 }]), { descriptionLabel: 'Equipment Description' });
    const result = reconstructSinglePage(lines)!;
    expect(result.semantic_status).toBe('unresolved');
    expect(result.rows.some((row) => rateCellOf(row).structured_rate)).toBe(false);
    expect(result.rows.flatMap((row) => row.cells).some((cell) => cell.raw_text === '120.00')).toBe(false);
    expect(priceOf(lines)).toEqual([]);
  });

  it('R4-7: glyphs outside the marker position, or outside the rate column, are left untouched', () => {
    // A glyph in the rate column but not where the page's markers stand.
    const offSlot = reconstructSinglePage(structuredTable(middle([{ x: 428, text: '5', width: 6 }, { x: AMOUNT_X, text: '120.00', width: 40 }])))!;
    expect(offSlot.rows).toHaveLength(3);
    expect(offSlot.unassigned_lines.map((entry) => entry.reason)).toEqual(['unpriced_row']);
    // The same characters in a description stay authored text and create no rate.
    const prose = reconstructSinglePage(structuredTable(middle(recognized('120.00'), { description: 'Section § 5 s work' })))!;
    expect(cellText(prose.rows[1]!, 'description')).toBe('Section § 5 s work');
    expect(cellText(prose.rows[1]!, 'rate')).toBe('$ 120.00');
    // Spacing-only continuation evidence never prices structurally.
    const spacing = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, structuredTable(middle([{ x: CURRENCY_X, text: '§', width: 8 }, { x: AMOUNT_X, text: '120.00', width: 40 }])))]),
      continuationEvidence: 'spacing_only',
    }).pages[0]!;
    expect(spacing.rows.some((row) => rateCellOf(row).structured_rate)).toBe(false);
  });

  it('R4-8: an extended amount is never taken for the unit rate', () => {
    const noRate = reconstructSinglePage(structuredTable(middle([], { extended: '1,200.00' }), { extended: true }))!;
    expect(noRate.rows.map((row) => cellText(row, 'description'))).toEqual(['Alpha service', 'Gamma service', 'Delta service']);
    expect(noRate.unassigned_lines.map((entry) => entry.reason)).toEqual(['unpriced_row']);
    const both = structuredTable(middle([{ x: AMOUNT_X, text: '120.00', width: 40 }], { extended: '1,200.00' }), { extended: true });
    const row = reconstructSinglePage(both)!.rows[1]!;
    expect(rateCellOf(row).structured_rate?.amount_text).toBe('120.00');
    expect(row.unresolved_role_cells!.map((cell) => [cell.header_text, cell.raw_text])).toEqual([['Line #', '0002'], ['Extended Amount', '1,200.00']]);
    expect(priceOf(both)[1]).toEqual(['Beta service', '120.00', 120]);
  });

  it('R4-10: a number OCR damaged is never repaired into a rate', () => {
    for (const damaged of ['00.00', '9O.00', '120.0', '1,20.00', '120', '12O']) {
      const result = reconstructSinglePage(structuredTable(middle([{ x: CURRENCY_X, text: '§', width: 8 }, { x: AMOUNT_X, text: damaged, width: 40 }])))!;
      expect(result.rows.map((row) => cellText(row, 'description')), damaged).toEqual(['Alpha service', 'Gamma service', 'Delta service']);
      expect(result.unassigned_lines.map((entry) => entry.reason), damaged).toEqual(['unpriced_row']);
    }
  });

  it('R4-11: the derivation points at the exact source token; row text is only what was read', () => {
    const result = reconstructSinglePage(structuredTable(middle([{ x: CURRENCY_X, text: '§', width: 8, observation_id: 'obs:m' as PdfToken['observation_id'] }, { x: AMOUNT_X, text: '1,300.00', width: 40, observation_id: 'obs:a' as PdfToken['observation_id'] }])))!;
    const row = result.rows[1]!;
    const rate = rateCellOf(row);
    expect(rate.structured_rate).toEqual({
      derivation: 'structured_numeric_rate',
      amount_text: '1,300.00',
      amount_source_ref: rate.source_refs[1],
      marker_source_ref: rate.source_refs[0],
    });
    expect(rate.source_refs.map((ref) => [ref.observation_id, ref.text, ref.x_min])).toEqual([['obs:m', '§', CURRENCY_X], ['obs:a', '1,300.00', AMOUNT_X]]);
    expect(row.raw_text).not.toContain('$');
    expect(row.raw_text).toContain('§ 1,300.00');
  });

  // ---------------------------------------------------------------------------
  // R5: deterministic same-line column membership. Tight authored word
  // clusters may overhang one unresolved structural column while remaining in
  // their established starting column; separately spaced Qty evidence stays in
  // Qty. Text and numeric meaning are never consulted.
  // ---------------------------------------------------------------------------

  const membershipHeader = () => line(7, 700, [
    { x: 50, text: 'Description', width: 60 },
    { x: 170, text: 'Qty', width: 30 },
    { x: 250, text: 'Unit', width: 35 },
    { x: 350, text: 'Cost', width: 30 },
  ]);
  const membershipRow = (y: number, prefix: string) => line(7, y, [
    { x: 50, text: `${prefix} head`, width: 75, observation_id: `${prefix}:head` as PdfToken['observation_id'] },
    // Center x=150 lies in Qty (Description/Qty boundary x=140), but the tight
    // two-token cluster occupies Description 3:1 by horizontal overlap.
    { x: 130, text: 'tail', width: 40, observation_id: `${prefix}:tail` as PdfToken['observation_id'] },
    { x: 190, text: '9', width: 10, observation_id: `${prefix}:qty` as PdfToken['observation_id'] },
    { x: 255, text: 'EA', width: 15, observation_id: `${prefix}:unit` as PdfToken['observation_id'] },
    { x: 350, text: '$', width: 8, observation_id: `${prefix}:marker` as PdfToken['observation_id'] },
    { x: 365, text: '12.00', width: 35, observation_id: `${prefix}:amount` as PdfToken['observation_id'] },
  ]);

  it('R5-1: a clear source-cluster majority keeps overhanging text out of Qty without losing evidence', () => {
    const result = reconstructSinglePage([membershipHeader(), membershipRow(680, 'a'), membershipRow(660, 'b')])!;
    expect(result.rows.map((row) => cellText(row, 'description'))).toEqual(['a head tail', 'b head tail']);
    expect(result.rows.map((row) => row.unresolved_role_cells?.map((cell) => [cell.header_text, cell.raw_text]))).toEqual([
      [['Qty', '9']], [['Qty', '9']],
    ]);
    const refs = result.rows[0]!.cells.flatMap((cell) => cell.source_refs)
      .concat(result.rows[0]!.unresolved_role_cells!.flatMap((cell) => cell.source_refs));
    expect(refs.map((ref) => ref.observation_id).sort()).toEqual([
      'a:amount', 'a:head', 'a:marker', 'a:qty', 'a:tail', 'a:unit',
    ]);
    expect(refs.filter((ref) => ref.observation_id === 'a:tail')).toEqual([
      expect.objectContaining({ text: 'tail', x_min: 130, x_max: 170 }),
    ]);
  });

  it('R5-2: an exact boundary tie abstains while deterministic neighbours stay in their columns', () => {
    const ambiguous = line(7, 680, [
      { x: 50, text: 'Alpha', width: 70 },
      // Equal 10-point overlap on each side of the x=140 boundary.
      { x: 130, text: 'boundary', width: 20, observation_id: 'ambiguous' as PdfToken['observation_id'] },
      { x: 190, text: '9', width: 10 }, { x: 255, text: 'EA', width: 15 },
      { x: 350, text: '$', width: 8 }, { x: 365, text: '12.00', width: 35 },
    ]);
    const result = reconstructSinglePage([membershipHeader(), ambiguous, membershipRow(660, 'b')])!;
    const refs = result.rows.flatMap((row) => row.cells.flatMap((cell) => cell.source_refs)
      .concat((row.unresolved_role_cells ?? []).flatMap((cell) => cell.source_refs)));
    expect(refs.some((ref) => ref.observation_id === 'ambiguous')).toBe(false);
    expect(cellText(result.rows[0]!, 'description')).toBe('Alpha');
    expect(result.rows[0]!.unresolved_role_cells?.find((cell) => cell.header_text === 'Qty')?.raw_text).toBe('9');
    expect(result.unattached_role_less_tokens).toEqual([
      expect.objectContaining({ observation_id: 'ambiguous', column_index: 1 }),
    ]);
  });

  it('R5-3: a row-attributed wrapped cluster retains Description membership and authored order', () => {
    const wrap = line(7, 674, [
      { x: 50, text: 'continued', width: 75, observation_id: 'wrap:head' as PdfToken['observation_id'] },
      { x: 130, text: 'tail', width: 40, observation_id: 'wrap:tail' as PdfToken['observation_id'] },
    ]);
    const result = reconstructSinglePage([
      membershipHeader(), membershipRow(680, 'a'), wrap, membershipRow(650, 'b'), membershipRow(620, 'c'),
    ])!;
    expect(cellText(result.rows[0]!, 'description')).toBe('a head tail continued tail');
    const description = result.rows[0]!.cells.find((cell) => cell.role === 'description')!;
    expect(description.source_refs.filter((ref) => ref.observation_id?.startsWith('wrap:'))
      .map((ref) => [ref.observation_id, ref.x_min, ref.x_max])).toEqual([
      ['wrap:head', 50, 125], ['wrap:tail', 130, 170],
    ]);
    expect(result.rows[0]!.unresolved_role_cells?.find((cell) => cell.header_text === 'Qty')?.raw_text).toBe('9');
  });

  it('R5-4: a tight cluster spanning three columns is not pulled into its first column', () => {
    const spanning = line(7, 680, [
      { x: 105, text: 'left', width: 45 },
      { x: 155, text: 'middle', width: 45 },
      { x: 205, text: 'right', width: 45 },
      { x: 255, text: 'EA', width: 15 },
      { x: 350, text: '$', width: 8 }, { x: 365, text: '12.00', width: 35 },
    ]);
    const result = reconstructSinglePage([membershipHeader(), spanning, membershipRow(660, 'b')])!;
    expect(cellText(result.rows[0]!, 'description')).toBe('left');
    expect(result.rows[0]!.unresolved_role_cells?.find((cell) => cell.header_text === 'Qty')?.raw_text).toBe('middle');
    expect(cellText(result.rows[0]!, 'unit')).toBe('right EA');
  });

  it('R5-5: line and token input order do not change column membership', () => {
    const lines = [membershipHeader(), membershipRow(680, 'a'), membershipRow(660, 'b')];
    const reversed = [...lines].reverse().map((entry) => ({ ...entry, tokens: [...entry.tokens].reverse() }));
    expect(reconstructSinglePage(reversed)).toEqual(reconstructSinglePage(lines));
  });

  it('R5-6: ordinary non-table prose remains outside reconstructed rows', () => {
    const prose = line(7, 610, [
      { x: 50, text: 'Payment terms continue', width: 75 }, { x: 130, text: 'elsewhere', width: 40 },
    ]);
    const result = reconstructSinglePage([
      membershipHeader(), membershipRow(680, 'a'), membershipRow(660, 'b'), prose,
    ])!;
    expect(result.rows.map((row) => cellText(row, 'description'))).toEqual(['a head tail', 'b head tail']);
    expect(result.unassigned_lines).toEqual([expect.objectContaining({ reason: 'unsupported_trailing_line' })]);
  });

  // ---------------------------------------------------------------------------
  // R6: the R5 cluster rule is role-symmetric except between two recognized
  // columns. A left-aligned role-less column (a category) keeps its own words
  // when they overhang a recognized neighbour (the description); no token ever
  // passes between two semantic (pricing) cells.
  // ---------------------------------------------------------------------------

  const categoryHeader = () => line(7, 700, [
    { x: 10, text: 'Category', width: 40 }, { x: 110, text: 'Description', width: 60 },
    { x: 250, text: 'Unit', width: 35 }, { x: 350, text: 'Cost', width: 30 },
  ]);
  // Category/Description boundary sits at x=80 (midpoint of 50 and 110).
  const categoryRow = (y: number, prefix: string, tail: { x: number; width: number } = { x: 64, width: 40 }) => line(7, y, [
    { x: 10, text: `${prefix} cat`, width: 50, observation_id: `${prefix}:cat` as PdfToken['observation_id'] },
    // Tight to the category head; centre past x=80, so per-token it is Description.
    { x: tail.x, text: 'haul', width: tail.width, observation_id: `${prefix}:haul` as PdfToken['observation_id'] },
    { x: 130, text: `${prefix} work`, width: 60, observation_id: `${prefix}:work` as PdfToken['observation_id'] },
    { x: 255, text: 'EA', width: 15 },
    { x: 350, text: '$', width: 8 }, { x: 365, text: '12.00', width: 35 },
  ]);

  it('R6-1: a role-less category cluster keeps its overhanging word out of the description', () => {
    const lines = [categoryHeader(), categoryRow(680, 'a'), categoryRow(660, 'b')];
    const production = reconstructSinglePage(lines)!;
    expect(production.rows.map((row) => cellText(row, 'description'))).toEqual(['a work', 'b work']);
    expect(production.rows.map((row) => row.unresolved_role_cells?.map((cell) => [cell.header_text, cell.raw_text])))
      .toEqual([[['Category', 'a cat haul']], [['Category', 'b cat haul']]]);
    // Pre-R6 (and spacing-only) center membership put the category word in the description.
    const center = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, lines)]), continuationEvidence: 'spacing_only',
    }).pages[0]!;
    expect(center.rows.map((row) => cellText(row, 'description'))).toEqual(['haul a work', 'haul b work']);
  });

  it('R6-2: two recognized columns never exchange ink, however clear the overlap lead', () => {
    // A description cluster overhanging Unit keeps primitive per-token membership.
    const lines = [categoryHeader(), ...[680, 660].map((y, index) => line(7, y, [
      { x: 10, text: `c${index}`, width: 20 },
      { x: 130, text: `item${index} words`, width: 80 }, { x: 212, text: 'spill', width: 20 },
      { x: 270, text: 'EA', width: 15 },
      { x: 350, text: '$', width: 8 }, { x: 365, text: '12.00', width: 35 },
    ]))];
    const result = reconstructSinglePage(lines)!;
    expect(result.rows.map((row) => [cellText(row, 'description'), cellText(row, 'unit')])).toEqual([
      ['item0 words', 'spill EA'], ['item1 words', 'spill EA'],
    ]);
  });

  it('R6-3: a role-less cluster without a 2x overlap lead keeps primitive membership', () => {
    // "haul" now reaches far into Description: the category no longer holds 2x.
    const lines = [categoryHeader(), categoryRow(680, 'a', { x: 64, width: 90 }), categoryRow(660, 'b', { x: 64, width: 90 })];
    const result = reconstructSinglePage(lines)!;
    expect(result.rows.map((row) => cellText(row, 'description'))).toEqual(['haul a work', 'haul b work']);
  });

  it('R6-4: a wrapped category line that no longer carries a description token is not pulled into a row', () => {
    // The wrap line's only would-be Description word is category overhang. With it
    // kept in Category the line has no row-admission evidence; its role-less
    // tokens attach only by a row's own vertical extent, else stay reported.
    const wrap = line(7, 670, [
      { x: 10, text: 'wrapped', width: 50, observation_id: 'w:head' as PdfToken['observation_id'] },
      { x: 64, text: 'tail', width: 40, observation_id: 'w:tail' as PdfToken['observation_id'] },
    ]);
    const result = reconstructSinglePage([categoryHeader(), categoryRow(690, 'a'), wrap, categoryRow(650, 'b')])!;
    expect(result.rows.map((row) => cellText(row, 'description'))).toEqual(['a work', 'b work']);
    const inRows = result.rows.flatMap((row) => (row.unresolved_role_cells ?? []).flatMap((cell) => cell.source_refs))
      .map((ref) => ref.observation_id);
    expect(inRows).not.toContain('w:head');
    expect(inRows).not.toContain('w:tail');
    expect((result.unattached_role_less_tokens ?? []).map((ref) => ref.observation_id)).toEqual(['w:head', 'w:tail']);
  });

  it('R6-5: a category overhang changes only the description text that prices, never the rate', () => {
    const lines = [categoryHeader(), categoryRow(680, 'a'), categoryRow(660, 'b')];
    const priced = buildContractRateScheduleRows({
      rateTable: null, pricedScheduleReconstruction: buildPagePricedScheduleReconstruction({ layout: layoutOf([page(7, lines)]) }),
    });
    expect(priced.map((row) => [row.description, row.unit, row.rate_raw, row.rate]))
      .toEqual([['a work', 'EA', '$ 12.00', 12], ['b work', 'EA', '$ 12.00', 12]]);
  });

  it('R5-8: every body token lands exactly once -- in a cell, a role-less cell, or a diagnostic', () => {
    const tie = line(7, 670, [
      { x: 50, text: 'Alpha', width: 70, observation_id: 't:head' as PdfToken['observation_id'] },
      { x: 130, text: 'boundary', width: 20, observation_id: 't:tie' as PdfToken['observation_id'] },
      { x: 190, text: '9', width: 10, observation_id: 't:qty' as PdfToken['observation_id'] },
      { x: 255, text: 'EA', width: 15, observation_id: 't:unit' as PdfToken['observation_id'] },
      { x: 350, text: '$', width: 8, observation_id: 't:marker' as PdfToken['observation_id'] },
      { x: 365, text: '12.00', width: 35, observation_id: 't:amount' as PdfToken['observation_id'] },
    ]);
    const lines = [membershipHeader(), membershipRow(690, 'a'), tie, membershipRow(650, 'b')];
    const result = reconstructSinglePage(lines)!;
    const seen = [
      ...result.rows.flatMap((row) => row.cells.flatMap((cell) => cell.source_refs)),
      ...result.rows.flatMap((row) => (row.unresolved_role_cells ?? []).flatMap((cell) => cell.source_refs)),
      ...result.unassigned_lines.flatMap((entry) => entry.source_refs),
      ...(result.unattached_role_less_tokens ?? []),
    ].map((ref) => ref.observation_id);
    const body = lines.slice(1).flatMap((entry) => entry.tokens.map((token) => token.observation_id));
    expect([...seen].sort()).toEqual([...body].sort());
  });

  it('R5-9: spacing-only fixtures keep pre-R5 center-band membership', () => {
    const lines = [membershipHeader(), membershipRow(680, 'a'), membershipRow(660, 'b')];
    const spacing = buildPagePricedScheduleReconstruction({
      layout: layoutOf([page(7, lines)]), continuationEvidence: 'spacing_only',
    }).pages[0]!;
    expect(spacing.rows.map((row) => cellText(row, 'description'))).toEqual(['a head', 'b head']);
    expect(spacing.rows[0]!.unresolved_role_cells?.map((cell) => [cell.header_text, cell.raw_text]))
      .toEqual([['Qty', 'tail 9']]);
  });

  it('R5-10: corrected membership changes only the description text that prices, never the rate', () => {
    const lines = [membershipHeader(), membershipRow(680, 'a'), membershipRow(660, 'b')];
    const priced = buildContractRateScheduleRows({
      rateTable: null, pricedScheduleReconstruction: buildPagePricedScheduleReconstruction({ layout: layoutOf([page(7, lines)]) }),
    });
    expect(priced.map((row) => [row.description, row.unit, row.rate_raw, row.rate]))
      .toEqual([['a head tail', 'EA', '$ 12.00', 12], ['b head tail', 'EA', '$ 12.00', 12]]);
    expect(JSON.stringify(priced)).not.toContain('"9"');
  });

  it('R4-12: production logic names no benchmark document or value', () => {
    const source = readFileSync(new URL('./pagePricedScheduleReconstruction.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/DN12189513|Hillsdale|Williamson|Goodlettsville|\bp10[67]\b|90\.00|1,000\.00/i);
  });

});
