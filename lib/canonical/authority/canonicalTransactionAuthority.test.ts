import { describe, expect, it } from 'vitest';

import type { PersistedCanonicalTransactionRowInput } from '@/lib/canonical/transaction/transactionAdapter';

import { assembleCanonicalTransactions } from './canonicalTransactionAuthority';

function row(
  overrides: Partial<PersistedCanonicalTransactionRowInput> = {},
): PersistedCanonicalTransactionRowInput {
  return {
    id: 'txn-1',
    document_id: 'doc-1',
    invoice_number: 'INV-100',
    transaction_number: 'TKT-001',
    rate_code: 'R1',
    transaction_quantity: 10,
    extended_cost: 125.5,
    invoice_date: '2026-03-01',
    source_sheet_name: 'Sheet1',
    source_row_number: 2,
    record_json: { material: 'Vegetative', unit: 'CYD' },
    raw_row_json: {},
    ...overrides,
  };
}

describe('assembleCanonicalTransactions — identity, quantity, amount', () => {
  it('adapts each persisted row into a canonical transaction', () => {
    const assembly = assembleCanonicalTransactions({ rows: [row()] });

    expect(assembly.transactions).toHaveLength(1);
    const transaction = assembly.transactions[0]!;
    expect(transaction.quantity.value).toBe(10);
    expect(transaction.extendedCost.value).toBe(125.5);
    expect(transaction.sourceDocumentId).toBe('doc-1');
  });

  it('handles an empty row set without inventing transactions', () => {
    const assembly = assembleCanonicalTransactions({ rows: [] });

    expect(assembly.transactions).toEqual([]);
    expect(assembly.distinctIdentityCount).toBe(0);
    expect(assembly.grainConflicts).toEqual([]);
  });

  it('preserves source sheet and row provenance', () => {
    const assembly = assembleCanonicalTransactions({
      rows: [row({ source_sheet_name: 'Tickets', source_row_number: 42 })],
    });

    const transaction = assembly.transactions[0]!;
    expect(transaction.sourceSheet).toBe('Tickets');
    expect(transaction.sourceRow).toBe(42);
  });
});

describe('assembleCanonicalTransactions — ticket-grain discipline', () => {
  it('counts one distinct identity when a ticket repeats with an agreeing quantity', () => {
    // Same physical ticket on two rows, same quantity. Ticket-grain count is 1,
    // and the quantity must NOT be summed to 20.
    const assembly = assembleCanonicalTransactions({
      rows: [
        row({ id: 'txn-a', transaction_number: 'TKT-777', transaction_quantity: 10 }),
        row({ id: 'txn-b', transaction_number: 'TKT-777', transaction_quantity: 10 }),
      ],
    });

    expect(assembly.transactions).toHaveLength(2);
    expect(assembly.distinctIdentityCount).toBe(1);
    expect(assembly.grainConflicts).toEqual([]);
    // No summation anywhere in the assembly.
    for (const transaction of assembly.transactions) {
      expect(transaction.quantity.value).toBe(10);
    }
  });

  it('emits a deterministic diagnostic when repeated ticket rows disagree on quantity', () => {
    const assembly = assembleCanonicalTransactions({
      rows: [
        row({ id: 'txn-a', transaction_number: 'TKT-999', transaction_quantity: 10 }),
        row({ id: 'txn-b', transaction_number: 'TKT-999', transaction_quantity: 14 }),
      ],
    });

    expect(assembly.distinctIdentityCount).toBe(1);
    const quantityConflicts = assembly.grainConflicts.filter((c) => c.field === 'quantity');
    expect(quantityConflicts).toHaveLength(1);
    expect(quantityConflicts[0]!.observedValues).toEqual([10, 14]);
    expect(quantityConflicts[0]!.rowIds).toEqual(['txn-a', 'txn-b']);
    expect(quantityConflicts[0]!.detail).toContain('does not select a winner');
  });

  it('does not resolve the conflict by choosing a value', () => {
    const assembly = assembleCanonicalTransactions({
      rows: [
        row({ id: 'txn-a', transaction_number: 'TKT-999', transaction_quantity: 10 }),
        row({ id: 'txn-b', transaction_number: 'TKT-999', transaction_quantity: 14 }),
      ],
    });

    // Both observations survive verbatim. Neither is suppressed, and no third
    // reconciled value is fabricated.
    const quantities = assembly.transactions.map((t) => t.quantity.value).sort();
    expect(quantities).toEqual([10, 14]);
  });

  it('detects a conflicting extended cost independently of quantity', () => {
    const assembly = assembleCanonicalTransactions({
      rows: [
        row({ id: 'txn-a', transaction_number: 'TKT-555', transaction_quantity: 10, extended_cost: 100 }),
        row({ id: 'txn-b', transaction_number: 'TKT-555', transaction_quantity: 10, extended_cost: 250 }),
      ],
    });

    expect(assembly.grainConflicts.filter((c) => c.field === 'quantity')).toHaveLength(0);
    const costConflicts = assembly.grainConflicts.filter((c) => c.field === 'extendedCost');
    expect(costConflicts).toHaveLength(1);
    expect(costConflicts[0]!.observedValues).toEqual([100, 250]);
  });

  it('never merges rows that lack a ticket number', () => {
    // Two rows with no ticket number are two distinct tickets, not one. Merging
    // them on a null identity would under-count and could mask a real quantity.
    const assembly = assembleCanonicalTransactions({
      rows: [
        row({ id: 'txn-a', transaction_number: null, transaction_quantity: 10, record_json: {} }),
        row({ id: 'txn-b', transaction_number: null, transaction_quantity: 14, record_json: {} }),
      ],
    });

    expect(assembly.distinctIdentityCount).toBe(2);
    expect(assembly.grainConflicts).toEqual([]);
  });

  it('scopes ticket identity by source document', () => {
    // The same ticket number in two different documents is two tickets.
    const assembly = assembleCanonicalTransactions({
      rows: [
        row({ id: 'txn-a', document_id: 'doc-1', transaction_number: 'TKT-1', transaction_quantity: 10 }),
        row({ id: 'txn-b', document_id: 'doc-2', transaction_number: 'TKT-1', transaction_quantity: 14 }),
      ],
    });

    expect(assembly.distinctIdentityCount).toBe(2);
    expect(assembly.grainConflicts).toEqual([]);
  });

  it('ignores a non-value-bearing quantity when comparing for conflicts', () => {
    const assembly = assembleCanonicalTransactions({
      rows: [
        row({ id: 'txn-a', transaction_number: 'TKT-321', transaction_quantity: 10 }),
        row({ id: 'txn-b', transaction_number: 'TKT-321', transaction_quantity: null }),
      ],
    });

    // An absent observation is not a competing value, so it is not a conflict.
    expect(assembly.grainConflicts.filter((c) => c.field === 'quantity')).toEqual([]);
  });
});

describe('assembleCanonicalTransactions — determinism', () => {
  it('produces identical output regardless of input row order', () => {
    const rows = [
      row({ id: 'txn-c', transaction_number: 'TKT-3' }),
      row({ id: 'txn-a', transaction_number: 'TKT-1' }),
      row({ id: 'txn-b', transaction_number: 'TKT-2' }),
    ];

    const forward = assembleCanonicalTransactions({ rows });
    const reversed = assembleCanonicalTransactions({ rows: [...rows].reverse() });

    expect(forward.transactions.map((t) => t.transactionId))
      .toEqual(reversed.transactions.map((t) => t.transactionId));
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it('orders grain conflicts deterministically', () => {
    const rows = [
      row({ id: 'txn-a', transaction_number: 'TKT-B', transaction_quantity: 1 }),
      row({ id: 'txn-b', transaction_number: 'TKT-B', transaction_quantity: 2 }),
      row({ id: 'txn-c', transaction_number: 'TKT-A', transaction_quantity: 3 }),
      row({ id: 'txn-d', transaction_number: 'TKT-A', transaction_quantity: 4 }),
    ];

    const first = assembleCanonicalTransactions({ rows });
    const second = assembleCanonicalTransactions({ rows: [...rows].reverse() });

    expect(first.grainConflicts.map((c) => c.conflictKey))
      .toEqual(second.grainConflicts.map((c) => c.conflictKey));
    // Sorted by conflict key, so TKT-A precedes TKT-B.
    expect(first.grainConflicts[0]!.identity).toContain('TKT-A');
  });
});
