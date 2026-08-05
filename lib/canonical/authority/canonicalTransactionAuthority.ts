/**
 * Canonical transaction authority: identity, quantity, and amount.
 *
 * Assembles canonical transactions once, inside the single execution assembly,
 * by reusing `adaptProjectTransactionRow`. It does not re-read workbooks or
 * re-run extraction.
 *
 * Grain discipline (see CLAUDE.md): transaction quantity is **ticket-grain**.
 * Repeated physical rows sharing one transaction identity must never be summed
 * into a larger quantity. Where repeated rows disagree on quantity this module
 * refuses to pick a winner silently and emits a deterministic diagnostic
 * instead, so a conflict surfaces rather than becoming a quietly wrong total.
 */

import {
  adaptProjectTransactionRow,
  type PersistedCanonicalTransactionRowInput,
} from '@/lib/canonical/transaction/transactionAdapter';
import type { CanonicalTransaction } from '@/lib/canonical/transaction/transaction';
import { isValueBearingState } from '@/lib/canonical/truth/envelope';

/**
 * A deterministic, reviewable record of a ticket-grain quantity disagreement.
 *
 * Emitted rather than resolved. Canonical authority does not invent a winner
 * between conflicting source observations of the same physical ticket.
 */
export type CanonicalTransactionGrainConflict = {
  readonly conflictKey: string;
  readonly identity: string;
  readonly field: 'quantity' | 'extendedCost';
  /** Distinct observed values, sorted, so the diagnostic is stable. */
  readonly observedValues: readonly number[];
  readonly rowIds: readonly string[];
  readonly detail: string;
};

export type CanonicalTransactionAssembly = {
  readonly transactions: readonly CanonicalTransaction[];
  readonly grainConflicts: readonly CanonicalTransactionGrainConflict[];
  /** Distinct ticket-grain identities, the correct denominator for counts. */
  readonly distinctIdentityCount: number;
};

/**
 * Ticket-grain identity for a transaction.
 *
 * Prefers the source transaction number; falls back to the row's own id so a
 * row without a ticket number is never merged with an unrelated one. Identity
 * is never derived from quantity or amount, which would make a value
 * disagreement look like two different tickets.
 */
function grainIdentity(transaction: CanonicalTransaction): string {
  const number = isValueBearingState(transaction.transactionNumber.state)
    ? transaction.transactionNumber.value
    : null;
  if (number != null && number.trim().length > 0) {
    const document = transaction.sourceDocumentId ?? 'unknown-document';
    return `ticket:${document}:${number.trim()}`;
  }
  return `row:${transaction.transactionId}`;
}

function valueBearingNumber(envelope: {
  readonly value: number | null;
  readonly state: Parameters<typeof isValueBearingState>[0];
}): number | null {
  if (!isValueBearingState(envelope.state)) return null;
  return typeof envelope.value === 'number' && Number.isFinite(envelope.value)
    ? envelope.value
    : null;
}

function detectGrainConflicts(
  transactions: readonly CanonicalTransaction[],
): readonly CanonicalTransactionGrainConflict[] {
  const byIdentity = new Map<string, CanonicalTransaction[]>();
  for (const transaction of transactions) {
    const identity = grainIdentity(transaction);
    const existing = byIdentity.get(identity) ?? [];
    existing.push(transaction);
    byIdentity.set(identity, existing);
  }

  const conflicts: CanonicalTransactionGrainConflict[] = [];
  for (const [identity, group] of byIdentity) {
    if (group.length < 2) continue;

    for (const field of ['quantity', 'extendedCost'] as const) {
      const values = new Set<number>();
      for (const transaction of group) {
        const value = valueBearingNumber(
          field === 'quantity' ? transaction.quantity : transaction.extendedCost,
        );
        if (value != null) values.add(value);
      }
      if (values.size < 2) continue;

      const observedValues = [...values].sort((left, right) => left - right);
      const rowIds = group.map((entry) => entry.transactionId).sort((l, r) => l.localeCompare(r, 'en-US'));
      conflicts.push({
        conflictKey: `${identity}:${field}`,
        identity,
        field,
        observedValues,
        rowIds,
        detail:
          `Repeated ticket-grain rows for ${identity} report ${String(observedValues.length)} `
          + `different ${field} values. Canonical authority does not select a winner; `
          + 'resolve the source disagreement.',
      });
    }
  }

  return conflicts.sort((left, right) => left.conflictKey.localeCompare(right.conflictKey, 'en-US'));
}

/**
 * Assembles canonical transactions for one execution.
 *
 * Deterministic: rows are adapted in a stable order and the resulting
 * transactions are sorted by id, so two runs over the same input produce an
 * identical assembly and an identical registry digest.
 */
export function assembleCanonicalTransactions(input: {
  readonly rows: readonly PersistedCanonicalTransactionRowInput[];
  readonly sourceWorkbook?: string | null;
}): CanonicalTransactionAssembly {
  const ordered = [...input.rows].sort((left, right) =>
    String(left.id ?? '').localeCompare(String(right.id ?? ''), 'en-US'));

  const transactions = ordered
    .map((row) => adaptProjectTransactionRow(row, {
      documentId: row.document_id ?? null,
      sourceWorkbook: input.sourceWorkbook ?? null,
    }))
    .sort((left, right) => left.transactionId.localeCompare(right.transactionId, 'en-US'));

  const identities = new Set(transactions.map((transaction) => grainIdentity(transaction)));

  return {
    transactions,
    grainConflicts: detectGrainConflicts(transactions),
    distinctIdentityCount: identities.size,
  };
}
