import { describe, expect, it } from 'vitest';

import { assembleCanonicalTransactions } from '@/lib/canonical/authority/canonicalTransactionAuthority';
import { projectCanonicalTransactionRows } from '@/lib/canonical/authority/canonicalValidatorProjection';
import type { PersistedCanonicalTransactionRowInput } from '@/lib/canonical/transaction/transactionAdapter';
import type { ProjectValidatorInput } from '@/lib/validator/shared';

import {
  RULE_TRANSACTION_GRAIN_CONFLICT,
  runTransactionGrainConflictRules,
} from './transactionGrainConflict';

function sourceRow(
  overrides: Partial<PersistedCanonicalTransactionRowInput> = {},
): PersistedCanonicalTransactionRowInput {
  return {
    id: 'txn-1',
    document_id: 'doc-1',
    invoice_number: 'INV-1',
    transaction_number: 'TKT-1',
    rate_code: 'R1',
    transaction_quantity: 10,
    extended_cost: 100,
    invoice_date: '2026-03-01',
    source_sheet_name: 'Tickets',
    source_row_number: 5,
    record_json: { unit: 'CYD' },
    raw_row_json: {},
    ...overrides,
  };
}

/** Builds a validator input whose canonical projection carries the assembly. */
function inputFor(rows: readonly PersistedCanonicalTransactionRowInput[]): ProjectValidatorInput {
  const assembly = assembleCanonicalTransactions({ rows });
  return {
    project: { id: 'project-1' },
    projectTruthAuthority: {
      authorityMode: 'canonical',
      assemblyStatus: 'assembled',
      registry: null,
      registryDigest: 'digest',
      sourceArtifactSnapshotDigest: 'snapshot',
      validatorProjection: {
        rateScheduleItems: [],
        transactions: {
          rows: assembly.transactions,
          distinctIdentityCount: assembly.distinctIdentityCount,
          grainConflicts: assembly.grainConflicts,
        },
      },
      blockReason: null,
      block: null,
    },
  } as unknown as ProjectValidatorInput;
}

const AGREEING = [
  sourceRow({ id: 'txn-a', transaction_number: 'TKT-777', transaction_quantity: 10 }),
  sourceRow({ id: 'txn-b', transaction_number: 'TKT-777', transaction_quantity: 10 }),
];

const CONFLICTING = [
  sourceRow({ id: 'txn-a', transaction_number: 'TKT-999', transaction_quantity: 10 }),
  sourceRow({ id: 'txn-b', transaction_number: 'TKT-999', transaction_quantity: 14 }),
];

describe('transaction grain conflict findings', () => {
  it('produces no finding when repeated ticket rows agree', () => {
    expect(runTransactionGrainConflictRules(inputFor(AGREEING))).toEqual([]);
  });

  it('does not double-count an agreeing repeated ticket', () => {
    const assembly = assembleCanonicalTransactions({ rows: AGREEING });

    expect(assembly.distinctIdentityCount).toBe(1);
    // Quantity stays 10 on each row; nothing sums to 20.
    for (const transaction of assembly.transactions) {
      expect(transaction.quantity.value).toBe(10);
    }
  });

  it('produces exactly one finding for one conflicting ticket', () => {
    const findings = runTransactionGrainConflictRules(inputFor(CONFLICTING));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule_id).toBe(RULE_TRANSACTION_GRAIN_CONFLICT);
  });

  it('preserves both conflicting observations in evidence', () => {
    const findings = runTransactionGrainConflictRules(inputFor(CONFLICTING));
    const evidence = findings[0]!.evidence ?? [];

    expect(evidence).toHaveLength(2);
    // The shared evidence model normalizes field_value to a string; both
    // observations still survive distinctly, which is what matters here.
    const values = evidence.map((entry) => String(entry.field_value)).sort();
    expect(values).toEqual(['10', '14']);
    // Each observation stays traceable to its own source row.
    const records = evidence.map((entry) => entry.record_id).sort();
    expect(records).toEqual(['txn-a', 'txn-b']);
  });

  it('invents no resolved value and picks neither first nor last', () => {
    const findings = runTransactionGrainConflictRules(inputFor(CONFLICTING));
    const actual = findings[0]!.actual ?? '';

    // Both values are reported; no third reconciled number appears.
    expect(actual).toContain('10');
    expect(actual).toContain('14');
    expect(actual).toContain('2 conflicting values');
    expect(actual).not.toContain('24');
    expect(actual).not.toContain('12');
  });

  it('blocks rather than letting a disputed quantity be treated as authoritative', () => {
    const findings = runTransactionGrainConflictRules(inputFor(CONFLICTING));

    expect(findings[0]!.severity).toBe('critical');
    expect(findings[0]!.blocked_reason).toBeTruthy();
    expect(findings[0]!.blocked_reason).toContain('does not select a winner');
  });

  it('identifies the ticket-grain identity and the conflicting field', () => {
    const findings = runTransactionGrainConflictRules(inputFor(CONFLICTING));

    expect(findings[0]!.field).toBe('transaction_quantity');
    expect(findings[0]!.blocked_reason).toContain('TKT-999');
  });

  it('is deterministic across repeated runs', () => {
    const first = runTransactionGrainConflictRules(inputFor(CONFLICTING));
    const second = runTransactionGrainConflictRules(inputFor(CONFLICTING));

    expect(first[0]!.subject_id).toBe(second[0]!.subject_id);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('detects a conflicting extended cost independently', () => {
    const findings = runTransactionGrainConflictRules(inputFor([
      sourceRow({ id: 'txn-a', transaction_number: 'TKT-555', extended_cost: 100 }),
      sourceRow({ id: 'txn-b', transaction_number: 'TKT-555', extended_cost: 250 }),
    ]));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.field).toBe('extended_cost');
  });

  it('contributes nothing in legacy mode, leaving behavior unchanged', () => {
    const legacyInput = { project: { id: 'project-1' } } as unknown as ProjectValidatorInput;

    expect(runTransactionGrainConflictRules(legacyInput)).toEqual([]);
  });
});

describe('canonical transaction row projection', () => {
  it('preserves row grain without merging repeated tickets', () => {
    const assembly = assembleCanonicalTransactions({ rows: AGREEING });
    const rows = projectCanonicalTransactionRows(assembly.transactions, 'project-1');

    // Two physical rows stay two rows; collapsing them would destroy the
    // repeated-row evidence a conflict depends on.
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.transaction_quantity === 10)).toBe(true);
  });

  it('carries canonical quantity and amount into the validator interface', () => {
    const assembly = assembleCanonicalTransactions({
      rows: [sourceRow({ transaction_quantity: 33, extended_cost: 412.75 })],
    });
    const rows = projectCanonicalTransactionRows(assembly.transactions, 'project-1');

    expect(rows[0]!.transaction_quantity).toBe(33);
    expect(rows[0]!.extended_cost).toBe(412.75);
  });

  it('carries source provenance into the validator interface', () => {
    const assembly = assembleCanonicalTransactions({
      rows: [sourceRow({ document_id: 'doc-9', source_sheet_name: 'S2', source_row_number: 77 })],
    });
    const rows = projectCanonicalTransactionRows(assembly.transactions, 'project-1');

    expect(rows[0]!.document_id).toBe('doc-9');
    expect(rows[0]!.source_sheet_name).toBe('S2');
    expect(rows[0]!.source_row_number).toBe(77);
  });

  it('projects deterministically', () => {
    const assembly = assembleCanonicalTransactions({ rows: CONFLICTING });
    const first = projectCanonicalTransactionRows(assembly.transactions, 'project-1');
    const second = projectCanonicalTransactionRows(assembly.transactions, 'project-1');

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
