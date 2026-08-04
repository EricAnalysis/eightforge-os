import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  deterministicWorkbookSourceInspection,
  diffTransactionRowLedgers,
  driftLedgerCsv,
  resolveDriftWorkbookPaths,
  type TransactionRowLedger,
  type TransactionRowLedgerEntry,
} from '@/lib/evaluation/goldenTransactionRowDriftDiagnostic';

function entry(overrides: Partial<TransactionRowLedgerEntry> & { readonly sourceRow: number }): TransactionRowLedgerEntry {
  return {
    recordId: `transaction:sheet:${overrides.sourceRow}`,
    sourceSheet: 'Sheet',
    ticketNumber: null,
    ticketId: null,
    transactionNumber: null,
    invoiceNumber: null,
    rateCode: null,
    quantity: null,
    extendedCost: null,
    cyd: null,
    material: null,
    eligibility: null,
    invoiceLinked: false,
    rawRowHash: 'hash',
    identityKey: `key-${overrides.sourceRow}`,
    ...overrides,
  };
}

function ledger(entries: readonly TransactionRowLedgerEntry[]): TransactionRowLedger {
  return {
    source: {
      path: 'memory', byteLength: 0, sha256: 'x', fileModifiedIso: '1970-01-01T00:00:00.000Z',
      application: null, appVersion: null, lastAuthor: null, createdIso: null, modifiedIso: null,
      definedNameCount: 0, sheets: [],
    },
    stageCounts: {
      physicalRows: entries.length + 1, parserEmittedRows: entries.length, normalizedRows: entries.length,
      invoiceLinkedRows: entries.filter((item) => item.invoiceLinked).length,
      uninvoicedRows: entries.filter((item) => !item.invoiceLinked).length,
      distinctTickets: new Set(entries.map((item) => item.ticketNumber)).size,
    },
    rollups: { totalExtendedCost: 0, totalTransactionQuantity: 0, totalCydTicketGrain: 0 },
    entries,
  };
}

describe('golden transaction-row drift diagnostic', () => {
  it('reports rows missing from the comparison ledger with their source identity and impact', () => {
    const kept = entry({ sourceRow: 2, identityKey: 'a', ticketNumber: 'T-1', quantity: 5, extendedCost: 10, cyd: 3, invoiceLinked: true, invoiceNumber: '2026-002' });
    const dropped = entry({ sourceRow: 9, identityKey: 'b', ticketNumber: 'T-2', quantity: 1, extendedCost: 0, cyd: 64 });

    const diff = diffTransactionRowLedgers(ledger([kept, dropped]), ledger([kept]));

    assert.equal(diff.baselineCount, 2);
    assert.equal(diff.comparisonCount, 1);
    assert.equal(diff.delta, -1);
    assert.deepEqual(diff.onlyInBaseline.map((item) => item.sourceRow), [9]);
    assert.deepEqual(diff.onlyInComparison, []);
    assert.deepEqual(diff.impact, {
      rows: 1, distinctTickets: 1, quantity: 1, extendedCost: 0, rowGrainCyd: 64,
      invoiceLinkedRows: 0, invoiceNumbers: [],
    });
  });

  it('matches duplicate identity keys by multiplicity rather than set membership', () => {
    const first = entry({ sourceRow: 4716, identityKey: 'dup' });
    const second = entry({ sourceRow: 4717, identityKey: 'dup' });

    const bothPresent = diffTransactionRowLedgers(ledger([first, second]), ledger([first, second]));
    assert.deepEqual(bothPresent.onlyInBaseline, []);

    const onePresent = diffTransactionRowLedgers(ledger([first, second]), ledger([first]));
    assert.equal(onePresent.onlyInBaseline.length, 1);
    assert.equal(onePresent.onlyInBaseline[0].sourceRow, 4717);
  });

  it('never reports a difference for ledgers that differ only in array order', () => {
    const a = entry({ sourceRow: 2, identityKey: 'a' });
    const b = entry({ sourceRow: 3, identityKey: 'b' });
    const diff = diffTransactionRowLedgers(ledger([a, b]), ledger([b, a]));
    assert.deepEqual(diff.onlyInBaseline, []);
    assert.deepEqual(diff.onlyInComparison, []);
  });

  it('emits a deterministic CSV ordered by source row', () => {
    const diff = diffTransactionRowLedgers(
      ledger([entry({ sourceRow: 9, identityKey: 'b', ticketNumber: 'T-2' }), entry({ sourceRow: 3, identityKey: 'c', ticketNumber: 'T-3' })]),
      ledger([]),
    );
    const csv = driftLedgerCsv(diff);
    const rows = csv.split('\n');
    assert.ok(rows[0].startsWith('sourceSheet,sourceRow,ticketNumber'));
    assert.deepEqual(rows.slice(1).map((row) => row.split(',')[1]), ['3', '9']);
    assert.equal(csv, driftLedgerCsv(diff));
  });

  it('requires both workbook paths before it will run against real sources', () => {
    const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as unknown as NodeJS.ProcessEnv;
    assert.equal(resolveDriftWorkbookPaths(env({})), null);
    assert.equal(resolveDriftWorkbookPaths(env({ GOLDEN_EDITED_TRANSACTION_WORKBOOK: 'a' })), null);
    assert.deepEqual(
      resolveDriftWorkbookPaths(env({ GOLDEN_EDITED_TRANSACTION_WORKBOOK: 'a', GOLDEN_AUTHORITATIVE_TRANSACTION_WORKBOOK: 'b' })),
      { baseline: 'b', comparison: 'a' },
    );
  });

  it('removes machine-local fields from deterministic source evidence', () => {
    const deterministic = deterministicWorkbookSourceInspection(ledger([]).source);
    assert.equal('path' in deterministic, false);
    assert.equal('fileModifiedIso' in deterministic, false);
    assert.equal(deterministic.sha256, 'x');
  });
});
