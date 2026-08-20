import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { loadPdfLayout } from '@/lib/extraction/pdf/extractText';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/**
 * Source-backed regression for the generic single-page priced schedule
 * reconstruction.
 *
 * This suite is evaluation-only and opt-in. It runs against a locally
 * configured labelled corpus and is skipped entirely when that corpus is not
 * configured, so no machine-specific path is ever committed. The expected
 * values below are read from the corpus annotation ledger rather than authored
 * here, so nothing in this file can leak into production as a fixture literal.
 */

const sourcePdfPath = process.env.TDOT_PHASE1_SOURCE_PDF?.trim();
const phase0PackagePath = process.env.TDOT_PHASE1_PHASE0_PACKAGE?.trim();
const corpusConfigured = Boolean(sourcePdfPath && phase0PackagePath);

type LedgerObservation = {
  source_pdf_sha256: string;
  source_page: number;
  exact_raw_text: string;
  interpreted_field_or_role: string;
  row_identity: string;
};

function normalizeAuthoredText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

describe.skipIf(!corpusConfigured)('generic priced schedule reconstruction against the labelled corpus', () => {
  it('reproduces every labelled priced row from the priced page alone', async () => {
    const pdfBytes = await readFile(path.resolve(sourcePdfPath!));
    const sourceSha256 = createHash('sha256').update(pdfBytes).digest('hex');

    const ledger = JSON.parse(
      await readFile(
        path.join(
          path.resolve(phase0PackagePath!),
          'annotation',
          'tdot-appendix-b-ledger.v1.0.0-draft.json',
        ),
        'utf8',
      ),
    ) as { observations: LedgerObservation[] };

    // The ledger must describe the exact bytes under test.
    const ledgerShas = new Set(ledger.observations.map((entry) => entry.source_pdf_sha256));
    expect(ledgerShas.size).toBe(1);
    expect(ledgerShas.has(sourceSha256)).toBe(true);

    // The priced page is whichever page the ledger labelled with costs; it is
    // discovered from the annotation, never hardcoded here.
    const costObservations = ledger.observations.filter(
      (entry) => entry.interpreted_field_or_role === 'cost',
    );
    const pricedPages = new Set(costObservations.map((entry) => entry.source_page));
    expect(pricedPages.size).toBe(1);
    const pricedPage = [...pricedPages][0]!;

    const expectedByRow = new Map<string, Record<string, string>>();
    for (const entry of ledger.observations.filter((row) => row.source_page === pricedPage)) {
      const record = expectedByRow.get(entry.row_identity) ?? {};
      record[entry.interpreted_field_or_role] = entry.exact_raw_text;
      expectedByRow.set(entry.row_identity, record);
    }
    const expectedRows = [...expectedByRow.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value);

    const layout = await loadPdfLayout(new Uint8Array(pdfBytes).buffer as ArrayBuffer);
    const reconstruction = buildPagePricedScheduleReconstruction({ layout });
    const rows = buildContractRateScheduleRows({
      rateTable: null,
      pricedScheduleReconstruction: reconstruction,
    });

    // Only the priced page reconstructs; the unpriced structural pages do not
    // contribute rows and are never stitched into a priced row.
    expect(reconstruction.pages.map((page) => page.physical_page_number)).toEqual([pricedPage]);
    expect(rows).toHaveLength(expectedRows.length);
    expect(rows.every((row) => row.page === pricedPage)).toBe(true);

    // Every labelled role agrees exactly with the source-derived reconstruction.
    rows.forEach((row, index) => {
      const expected = expectedRows[index]!;
      expect(normalizeAuthoredText(row.description)).toBe(normalizeAuthoredText(expected.description));
      expect(normalizeAuthoredText(row.unit)).toBe(normalizeAuthoredText(expected.unit));
      expect(normalizeAuthoredText(row.origin_destination)).toBe(
        normalizeAuthoredText(expected.origin_destination),
      );
      expect(normalizeAuthoredText(row.rate_raw)).toBe(normalizeAuthoredText(expected.cost));
    });

    // Non-numeric authored price markers stay unresolved rather than becoming zero.
    for (const row of rows) {
      const hasDigits = /\d/.test(row.rate_raw ?? '');
      if (hasDigits) {
        expect(row.rate).not.toBeNull();
      } else {
        expect(row.rate).toBeNull();
        expect(row.rate_amount).toBeNull();
        expect(row.confidence).toBe('needs_review');
      }
    }

    // Complete page-local evidence closure for every reconstructed row.
    for (const row of rows) {
      expect(row.raw_text).toBeTruthy();
      expect(row.raw_cells?.length ?? 0).toBeGreaterThan(0);
      expect(row.geometry_refs?.length ?? 0).toBeGreaterThan(0);
      for (const ref of row.geometry_refs ?? []) {
        expect(ref.geometry.page_number).toBe(pricedPage);
      }
    }
  }, 300_000);

  it('is deterministic across repeated reconstruction of the same source', async () => {
    const pdfBytes = await readFile(path.resolve(sourcePdfPath!));
    const layout = await loadPdfLayout(new Uint8Array(pdfBytes).buffer as ArrayBuffer);

    const first = buildPagePricedScheduleReconstruction({ layout });
    const second = buildPagePricedScheduleReconstruction({
      layout: { ...layout, pages: [...layout.pages].reverse() },
    });

    expect(second).toEqual(first);
  }, 300_000);
});
