import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  executeGoldenFullChainSources,
  GOLDEN_SOURCE_SPECS,
  resolveGoldenCorpusAvailability,
} from '@/lib/evaluation/canonicalGoldenFullChainHarness';

function value<T>(envelope: { readonly value: T | null }): T | null {
  return envelope.value;
}

const corpusAvailability = resolveGoldenCorpusAvailability();
const realFixtureEnabled = process.env.RUN_GOLDEN_REAL_FIXTURE_TESTS === '1';

describe.skipIf(!realFixtureEnabled || !corpusAvailability.available)(
  'Golden canonical full-chain real-source parity (explicit opt-in)',
  () => {
  it('executes both invoice PDFs and the authoritative transaction workbook with exact persisted parity', async () => {
    const result = await executeGoldenFullChainSources();
    console.log('[golden-full-chain]', JSON.stringify({
      invoices: result.invoices.map(({ canonical }) => ({ number: value(canonical.invoice.invoiceNumber), total: value(canonical.invoice.billedTotal), lines: canonical.lines.length })),
      transactionRows: result.records.length,
      transactionRollups: {
        totalExtendedCost: (result.transactionData?.rollups as Record<string, unknown> | undefined)?.total_extended_cost,
        totalQuantity: (result.transactionData?.rollups as Record<string, unknown> | undefined)?.total_transaction_quantity,
        totalTickets: (result.transactionData?.rollups as Record<string, unknown> | undefined)?.total_tickets,
        totalCyd: (result.transactionData?.rollups as Record<string, unknown> | undefined)?.total_cyd,
        uninvoicedRows: (result.transactionData?.rollups as Record<string, unknown> | undefined)?.uninvoiced_line_count,
      },
      lossLedgerEntries: result.lossLedger.length,
    }));
    assert.deepEqual(Object.fromEntries(Object.entries(result.sources).map(([key, source]) => [key, source.sha256])), Object.fromEntries(Object.entries(GOLDEN_SOURCE_SPECS).map(([key, spec]) => [key, spec.sha256])));
    assert.equal(result.pricing.counts.rateScheduleRows, 105);
    assert.equal(result.pricing.counts.assemblerOutputs, 90);
    assert.equal(result.pricing.counts.resolvedPricing, 56);
    assert.equal(result.pricing.counts.needsReview, 34);
    assert.equal(result.pricing.counts.rowsMergedOrDeduped, 15);
    assert.equal(result.pricing.counts.rowsSilentlyLost, 0);

    assert.deepEqual(result.invoices.map(({ canonical }) => value(canonical.invoice.invoiceNumber)), ['2026-002', '2026-003']);
    assert.deepEqual(result.invoices.map(({ canonical }) => value(canonical.invoice.billedTotal)), [534_757.10, 280_802.25]);
    assert.deepEqual(result.invoices.map(({ canonical }) => canonical.lines.length), [6, 4]);
    assert.equal(result.registry.invoices.length, 2);
    assert.equal(result.registry.invoiceLines.length, 10);

    const transactionRowParity = {
      actualRealPipelineCount: result.records.length,
      persistedReferenceCount: 5_063,
      delta: result.records.length - 5_063,
      status: result.transactionSourceIdentity.status,
    } as const;
    assert.deepEqual(
      transactionRowParity,
      {
        actualRealPipelineCount: 5_063,
        persistedReferenceCount: 5_063,
        delta: 0,
        status: 'exact_source_parity',
      },
      'Golden authoritative transaction source must remain in exact persisted parity',
    );
    assert.equal(result.registry.transactions.length, transactionRowParity.actualRealPipelineCount);
    const rollups = result.transactionData?.rollups as Record<string, unknown>;
    assert.equal(Number(rollups.total_transaction_quantity), 216_610);
    assert.equal(Number(rollups.total_extended_cost), 815_559.35);
    assert.equal(Number(rollups.total_tickets), 2_388);
    assert.equal(Number(rollups.uninvoiced_line_count), 283);
    assert.equal(Number(rollups.total_cyd), 74_617);
    const transactionLedger = result.lossLedger.filter((entry) => entry.boundary === 'transaction_normalization');
    assert.equal(transactionLedger.length, 289);
    assert.equal(transactionLedger.filter((entry) => entry.reason === 'missing_invoice_link').length, 283);
    assert.equal(transactionLedger.filter((entry) => entry.reason === 'invalid_quantity').length, 6);
    assert.equal(transactionLedger.filter((entry) => entry.reason === 'invalid_extended_cost').length, 0);
    assert.ok(transactionLedger.every((entry) => result.records.some((record) => record.id === entry.sourceIdentity)));
    assert.ok(transactionLedger.every((entry) => entry.evidenceSurvivesElsewhere && !entry.silent));

    const line1A = result.registry.invoiceLines.find((line) => value(line.rateCode ?? { value: null }) === '1A');
    assert.ok(line1A);
    assert.equal(value(line1A.quantity), 43_894);
    assert.equal(value(line1A.billedRate), 6.90);
    assert.equal(value(line1A.extendedAmount), 302_868.60);

    const supported1A = result.registry.transactions.filter((transaction) => value(transaction.invoiceNumber ?? { value: null }) === '2026-002' && value(transaction.rateCode ?? { value: null }) === '1A');
    assert.equal(supported1A.reduce((sum, transaction) => sum + (value(transaction.quantity) ?? 0), 0), 43_894);
    assert.equal(Number(supported1A.reduce((sum, transaction) => sum + (value(transaction.extendedCost) ?? 0), 0).toFixed(2)), 302_868.60);
    assert.ok(supported1A.every((transaction) => transaction.sourceSheet && transaction.sourceRow));
    assert.ok(supported1A.every((transaction) => transaction.evidence.length > 0));

    assert.equal(result.registry.construction.mode, 'shadow_only');
    assert.equal(result.registry.construction.persisted, false);
    assert.ok(result.registry.construction.sourceSnapshotId?.includes(GOLDEN_SOURCE_SPECS.workbook.sha256));
  }, 900_000);
});
