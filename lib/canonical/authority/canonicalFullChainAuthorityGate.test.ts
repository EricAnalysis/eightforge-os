/**
 * A14 acceptance gate for the full canonical transaction/document cutover.
 *
 * Six required cases plus determinism and the extended single-assembly
 * invariant, run against repository-owned fixtures only. The Golden case uses
 * `lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json` — real
 * Golden-derived contract pricing pinned to `sourcePdfSha256` 922161a5… of the
 * Williamson corpus PDF and checked into the repository — so the gate is
 * reproducible on any checkout and requires no external corpus.
 *
 *  1. Golden transaction authority — legacy vs canonical across every domain.
 *  2. Cross-document contract plus rate exhibit.
 *  3. Ticket-grain conflict.
 *  4. Missing invoice identity.
 *  5. Relationship conflict.
 *  6. Publication failure.
 *  7. Determinism.
 *  8. Full-chain single assembly.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { ValidatorResult } from '@/types/validator';

import { buildProjectTruthAuthorityMetadata } from './canonicalExecutionContext';
import { PROJECT_TRUTH_AUTHORITY_ENV_VAR } from './projectTruthAuthorityMode';
import { resolveProjectTruthAuthority } from './resolveProjectTruthAuthority';

const CANONICAL = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical' } as const;
const LEGACY = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'legacy' } as const;

const GOLDEN_FIXTURE_PATH = join(
  process.cwd(),
  'lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json',
);

type GoldenFixture = {
  readonly schemaVersion: string;
  readonly sourcePdfSha256: string;
  readonly rows: readonly ContractPricingAssemblyRow[];
};

function loadGoldenFixture(): GoldenFixture {
  return JSON.parse(readFileSync(GOLDEN_FIXTURE_PATH, 'utf8')) as GoldenFixture;
}

const CONTRACT_DOCUMENT_ID = 'williamson-contract';
const INVOICE_DOCUMENT_ID = 'williamson-invoice';

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invoice-row-1',
    source_document_id: INVOICE_DOCUMENT_ID,
    invoice_number: 'INV-1001',
    invoice_date: '2026-05-01',
    vendor_name: 'Williamson Hauling',
    billed_amount: 5000,
    ...overrides,
  };
}

function invoiceLineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invoice-line-1',
    invoice_id: 'invoice-row-1',
    source_document_id: INVOICE_DOCUMENT_ID,
    line_description: 'HAUL 0-15 MILES',
    quantity: 400,
    unit_price: 12.5,
    line_total: 5000,
    source_page: 2,
    source_row_number: 11,
    ...overrides,
  };
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'txn-1',
    document_id: 'williamson-tickets',
    invoice_number: 'INV-1001',
    transaction_number: 'TKT-1',
    rate_code: 'HAUL-0-15',
    transaction_quantity: 400,
    extended_cost: 5000,
    invoice_date: '2026-04-15',
    source_sheet_name: 'Tickets',
    source_row_number: 4,
    record_json: {},
    raw_row_json: {},
    ...overrides,
  };
}

function goldenInput(overrides: Record<string, unknown> = {}) {
  const fixture = loadGoldenFixture();
  return {
    projectId: 'golden-williamson',
    assembledContractPricingRows: fixture.rows,
    pricingContext: {
      documentId: CONTRACT_DOCUMENT_ID,
      scheduleId: 'exhibit-a',
      scheduleName: 'Exhibit A',
    },
    legacyRateScheduleItems: [],
    invoiceRows: [invoiceRow()],
    invoiceLineRows: [invoiceLineRow()],
    transactionRows: [ticketRow()],
    governingDocumentIds: { contract: [CONTRACT_DOCUMENT_ID] },
    familyDocumentIds: {
      contract: [CONTRACT_DOCUMENT_ID],
      invoice: [INVOICE_DOCUMENT_ID],
    },
    sourceArtifactIdByDocumentId: new Map([
      [CONTRACT_DOCUMENT_ID, 'artifact-contract-sha'],
      [INVOICE_DOCUMENT_ID, 'artifact-invoice-sha'],
    ]),
    sourceArtifactSnapshotDigest: fixture.sourcePdfSha256,
    env: CANONICAL,
    ...overrides,
  } as Parameters<typeof resolveProjectTruthAuthority>[0];
}

// ── Case 1: Golden transaction authority ────────────────────────────────────

describe('gate 1 — Golden transaction authority', () => {
  it('runs against the real in-repo Golden fixture, not an external corpus', () => {
    const fixture = loadGoldenFixture();

    expect(fixture.sourcePdfSha256)
      .toBe('922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f');
    expect(fixture.rows.length).toBeGreaterThan(0);
  });

  it('governs every required domain under canonical authority', () => {
    const context = resolveProjectTruthAuthority(goldenInput());
    const coverage = context.validatorProjection!.coverage;

    expect(context.assemblyStatus).toBe('assembled');
    expect(coverage.pricing.state).toBe('authoritative');
    expect(coverage.invoices.state).toBe('authoritative');
    expect(coverage.invoiceLines.state).toBe('authoritative');
    expect(coverage.transactions.state).toBe('authoritative');
    expect(coverage.relationships.state).toBe('authoritative');
    expect(coverage.provenance.state).toBe('authoritative');
  });

  it('preserves Golden pricing values exactly under canonical authority', () => {
    const fixture = loadGoldenFixture();
    const items = resolveProjectTruthAuthority(goldenInput()).validatorProjection!.rateScheduleItems;

    expect(items).toHaveLength(fixture.rows.length);
    for (const row of fixture.rows) {
      const projected = items.find((item) => item.description === row.description)!;
      expect(projected.rate_amount).toBe(row.rate);
      expect(projected.unit_type).toBe(row.unit);
    }
  });

  it('preserves canonical quantities and amounts verbatim', () => {
    const transactions = resolveProjectTruthAuthority(goldenInput())
      .validatorProjection!.transactions.rows;

    expect(transactions[0].quantity.value).toBe(400);
    expect(transactions[0].extendedCost.value).toBe(5000);
    expect(transactions[0].quantity.state).toBe('resolved');
  });

  it('reports one canonical identity per invoice, line, and ticket', () => {
    const projection = resolveProjectTruthAuthority(goldenInput()).validatorProjection!;

    expect(projection.invoices.distinctIdentityCount).toBe(1);
    expect(projection.invoiceLines.rows).toHaveLength(1);
    expect(projection.transactions.distinctIdentityCount).toBe(1);
    expect(projection.transactions.rows).toHaveLength(1);
  });

  it('emits no findings and no unresolved state on the clean Golden case', () => {
    const projection = resolveProjectTruthAuthority(goldenInput()).validatorProjection!;

    expect(resolveProjectTruthAuthority(goldenInput()).diagnosticProjection!.integritySignals).toEqual([]);
    expect(projection.invoices.identityConflicts).toEqual([]);
    expect(projection.invoices.unresolvedIdentityCount).toBe(0);
    expect(projection.relationships.unresolvedRequired).toEqual([]);
    expect(projection.relationships.conflicting).toEqual([]);
  });

  it('carries provenance identifying the source artifact for every domain', () => {
    const projection = resolveProjectTruthAuthority(goldenInput()).validatorProjection!;

    expect(projection.invoices.identities[0].provenance.sourceArtifactId)
      .toBe('artifact-invoice-sha');
    expect(projection.invoiceLines.identities[0].provenance.sourceDocumentId)
      .toBe(INVOICE_DOCUMENT_ID);
    expect(projection.transactions.rows[0].sourceDocumentId).toBe('williamson-tickets');
    expect(projection.rateScheduleItems.every((item) => item.source_document_id === CONTRACT_DOCUMENT_ID))
      .toBe(true);
  });

  it('never admits a legacy row into a canonical run', () => {
    const context = resolveProjectTruthAuthority(goldenInput({
      legacyRateScheduleItems: [{
        source_document_id: 'legacy-doc',
        record_id: 'legacy-mixed',
        rate_code: null,
        unit_type: 'CYD',
        rate_amount: 7.77,
        material_type: null,
        description: 'LEGACY MIXED ROW',
        raw_value: null,
      }],
    }));

    expect(JSON.stringify(context.validatorProjection)).not.toContain('LEGACY MIXED ROW');
  });

  it('leaves legacy mode entirely unchanged', () => {
    const legacy = resolveProjectTruthAuthority(goldenInput({ env: LEGACY }));

    expect(legacy.authorityMode).toBe('legacy');
    expect(legacy.assemblyStatus).toBe('not_requested');
    expect(legacy.validatorProjection).toBeNull();
    expect(legacy.registry).toBeNull();
  });
});

// ── Case 2: cross-document contract plus rate exhibit ───────────────────────

describe('gate 2 — cross-document contract plus rate exhibit', () => {
  const CROSS_DOCUMENT = {
    pricingContext: { documentId: 'exhibit-a-doc', scheduleId: 'exhibit-a', scheduleName: 'Exhibit A' },
    governingDocumentIds: { contract: ['master-contract-doc'], rate_sheet: ['exhibit-a-doc'] },
    familyDocumentIds: {
      contract: ['master-contract-doc', 'exhibit-a-doc'],
      invoice: [INVOICE_DOCUMENT_ID],
    },
  };

  it('places the invoice in the correct contract family', () => {
    const relationships = resolveProjectTruthAuthority(goldenInput(CROSS_DOCUMENT))
      .validatorProjection!.relationships.all;
    const family = relationships.find(
      (entry) => entry.kind === 'invoice_belongs_to_contract_family',
    )!;

    expect(family.state).toBe('derived');
    expect(family.candidateIds).toContain('master-contract-doc');
  });

  it('identifies the governing contract and the governing pricing exhibit separately', () => {
    const relationships = resolveProjectTruthAuthority(goldenInput(CROSS_DOCUMENT))
      .validatorProjection!.relationships.all;

    expect(relationships.find((entry) => entry.kind === 'invoice_references_governing_contract')!.to)
      .toEqual({ kind: 'document', id: 'master-contract-doc' });
    // Rate truth is governed by the exhibit the pricing rows actually cite.
    expect(relationships.find((entry) => entry.kind === 'pricing_exhibit_governs_rate_truth')!.to)
      .toEqual({ kind: 'document', id: 'exhibit-a-doc' });
  });

  it('attributes every canonical rate row to the governing exhibit', () => {
    const items = resolveProjectTruthAuthority(goldenInput(CROSS_DOCUMENT))
      .validatorProjection!.rateScheduleItems;

    expect(items.every((item) => item.source_document_id === 'exhibit-a-doc')).toBe(true);
  });

  it('does not let a supplied legacy resolution override canonical relationship truth', () => {
    const context = resolveProjectTruthAuthority(goldenInput({
      ...CROSS_DOCUMENT,
      legacyRateScheduleItems: [{
        source_document_id: 'legacy-wrong-exhibit',
        record_id: 'legacy-rate',
        rate_code: null,
        unit_type: 'CYD',
        rate_amount: 999,
        material_type: null,
        description: 'LEGACY WRONG EXHIBIT',
        raw_value: null,
      }],
    }));

    expect(JSON.stringify(context.validatorProjection)).not.toContain('legacy-wrong-exhibit');
  });

  it('keeps a distinct registry digest per governing document', () => {
    const first = resolveProjectTruthAuthority(goldenInput(CROSS_DOCUMENT));
    const second = resolveProjectTruthAuthority(goldenInput({
      ...CROSS_DOCUMENT,
      pricingContext: { documentId: 'exhibit-b-doc', scheduleId: 'exhibit-b', scheduleName: 'Exhibit B' },
    }));

    expect(first.registryDigest).not.toBe(second.registryDigest);
  });
});

// ── Case 3: ticket-grain conflict ───────────────────────────────────────────

describe('gate 3 — ticket-grain conflict', () => {
  const CONFLICT = {
    transactionRows: [
      ticketRow({ id: 'txn-a', transaction_number: 'TKT-9', transaction_quantity: 400, extended_cost: 5000 }),
      ticketRow({ id: 'txn-b', transaction_number: 'TKT-9', transaction_quantity: 560, extended_cost: 7000 }),
    ],
  };

  it('resolves one ticket identity while keeping both observations', () => {
    const projection = resolveProjectTruthAuthority(goldenInput(CONFLICT)).validatorProjection!;

    expect(projection.transactions.distinctIdentityCount).toBe(1);
    expect(projection.transactions.rows).toHaveLength(2);
  });

  it('invents no winner and no reconciled third value', () => {
    const projection = resolveProjectTruthAuthority(goldenInput(CONFLICT)).validatorProjection!;
    const quantityConflict = projection.transactions.grainConflicts.find(
      (conflict) => conflict.field === 'quantity',
    )!;

    expect(quantityConflict.observedValues).toEqual([400, 560]);
    expect(projection.transactions.rows.map((row) => row.quantity.value).sort((l, r) => l! - r!))
      .toEqual([400, 560]);
  });

  it('blocks the transactions domain rather than reporting success', () => {
    const context = resolveProjectTruthAuthority(goldenInput(CONFLICT));

    expect(context.assemblyStatus).toBe('blocked');
    expect(context.blockReason).toBe('incomplete_domain_authority');
    expect(context.validatorProjection!.coverage.transactions.reason).toBe('ticket_grain_conflict');
  });

  it('produces a deterministic conflict identity across runs', () => {
    const first = resolveProjectTruthAuthority(goldenInput(CONFLICT));
    const second = resolveProjectTruthAuthority(goldenInput(CONFLICT));

    expect(first.validatorProjection!.transactions.grainConflicts.map((c) => c.conflictKey))
      .toEqual(second.validatorProjection!.transactions.grainConflicts.map((c) => c.conflictKey));
  });
});

// ── Case 4: missing invoice identity ────────────────────────────────────────

describe('gate 4 — missing invoice identity', () => {
  const MISSING_IDENTITY = {
    invoiceRows: [
      invoiceRow({ id: null, invoice_number: null }),
      invoiceRow({ id: null, invoice_number: null }),
    ],
    invoiceLineRows: [],
  };

  it('does not collapse two invoices that both lack an invoice number', () => {
    const projection = resolveProjectTruthAuthority(goldenInput(MISSING_IDENTITY))
      .validatorProjection!;

    expect(projection.invoices.distinctIdentityCount).toBe(2);
    expect(new Set(projection.invoices.rows.map((invoice) => invoice.invoiceId)).size).toBe(2);
  });

  it('blocks the invoices domain instead of substituting a legacy identity', () => {
    const context = resolveProjectTruthAuthority(goldenInput(MISSING_IDENTITY));

    expect(context.assemblyStatus).toBe('blocked');
    expect(context.validatorProjection!.coverage.invoices.reason).toBe('unresolved_invoice_identity');
    expect(context.validatorProjection!.invoices.unresolvedIdentityCount).toBe(2);
  });

  it('blocks on a duplicate invoice number claimed by two documents', () => {
    const context = resolveProjectTruthAuthority(goldenInput({
      invoiceRows: [
        invoiceRow({ id: 'row-a', source_document_id: 'invoice-doc-a' }),
        invoiceRow({ id: 'row-b', source_document_id: 'invoice-doc-b' }),
      ],
      invoiceLineRows: [],
    }));

    expect(context.validatorProjection!.coverage.invoices.reason)
      .toBe('duplicate_invoice_number_across_source_documents');
    // Both observations survive as distinct canonical invoices.
    expect(context.validatorProjection!.invoices.rows).toHaveLength(2);
  });
});

// ── Case 5: relationship conflict ───────────────────────────────────────────

describe('gate 5 — relationship conflict', () => {
  const CONFLICTING_GOVERNANCE = {
    governingDocumentIds: { contract: ['contract-a', 'contract-b'] },
  };

  it('keeps the relationship conflicting with no legacy winner', () => {
    const projection = resolveProjectTruthAuthority(goldenInput(CONFLICTING_GOVERNANCE))
      .validatorProjection!;
    const governing = projection.relationships.all.find(
      (entry) => entry.kind === 'invoice_references_governing_contract',
    )!;

    expect(governing.state).toBe('conflicting');
    expect(governing.to).toBeNull();
    expect(governing.candidateIds).toEqual(['contract-a', 'contract-b']);
  });

  it('preserves both relationship candidates in the finding evidence', () => {
    const signals = resolveProjectTruthAuthority(goldenInput(CONFLICTING_GOVERNANCE))
      .diagnosticProjection!.integritySignals;
    const conflict = signals.find((signal) => signal.kind === 'relationship_conflicting')!;

    expect(conflict.blocking).toBe(true);
    expect(conflict.evidence.map((entry) => entry.field_value))
      .toEqual(expect.arrayContaining(['contract-a', 'contract-b']));
  });

  it('prevents the affected domain from clearing', () => {
    const context = resolveProjectTruthAuthority(goldenInput(CONFLICTING_GOVERNANCE));

    expect(context.assemblyStatus).toBe('blocked');
    expect(context.validatorProjection!.coverage.relationships.reason)
      .toBe('conflicting_governing_relationship');
    expect(buildProjectTruthAuthorityMetadata(context).blockedTruthDomains)
      .toEqual(expect.arrayContaining(['invoices', 'relationships']));
  });
});

// ── Case 6: publication failure ─────────────────────────────────────────────

const RESULT: ValidatorResult = {
  status: 'FINDINGS_OPEN',
  blocked_reasons: [],
  findings: [],
  rulesApplied: ['financial_integrity'],
  summary: {},
  validator_status: 'findings_open',
  validator_open_items: 2,
  validator_blockers: 0,
  exposure: {
    total_billed_amount: 5000,
    total_contract_supported_amount: 5000,
    total_transaction_supported_amount: 5000,
    total_at_risk_amount: 0,
  },
} as unknown as ValidatorResult;

describe('gate 6 — publication failure', () => {
  it('leaves findings, exposure, coverage, and digests untouched', async () => {
    const { publishProjectTruthShadow } = await import(
      '@/lib/canonical/publication/publishProjectTruthShadow'
    );
    const context = resolveProjectTruthAuthority(goldenInput());
    const before = {
      findings: JSON.stringify(RESULT.findings),
      exposure: JSON.stringify(RESULT.exposure),
      registryDigest: context.registryDigest,
      snapshotDigest: context.sourceArtifactSnapshotDigest,
      coverage: JSON.stringify(context.validatorProjection!.coverage),
      registry: context.registry,
    };

    const result = await publishProjectTruthShadow(
      {
        projectId: 'golden-williamson',
        runId: 'run-1',
        triggerSource: 'manual',
        inputsSnapshotHash: 'snapshot-hash',
        validatorInput: {
          project: { id: 'golden-williamson', organization_id: 'org-1' },
          documents: [],
          governingDocumentIds: {},
          assembledContractPricingRows: loadGoldenFixture().rows,
          contractValidationContext: null,
          invoices: [],
          invoiceLines: [],
          invoiceLineToRateMap: new Map(),
          sourceArtifactSnapshot: [],
          projectTruthAuthority: context,
        },
        effectiveResult: RESULT,
        persistedFindings: [],
      } as never,
      {
        loadValidationRun: async () => ({
          id: 'run-1',
          status: 'complete',
          run_at: '2026-08-05T00:00:00.000Z',
          completed_at: '2026-08-05T00:00:01.000Z',
          triggered_by: 'manual',
          triggered_by_user_id: null,
          rule_version: '1.0.0',
          inputs_snapshot_hash: 'snapshot-hash',
        }) as never,
        adaptSource: () => {
          throw new Error('simulated publication adaptation failure');
        },
      },
    );

    // The publisher normalizes its own failure; validation is unaffected.
    expect(result.status).toBe('failed');
    expect(JSON.stringify(RESULT.findings)).toBe(before.findings);
    expect(JSON.stringify(RESULT.exposure)).toBe(before.exposure);
    expect(context.registryDigest).toBe(before.registryDigest);
    expect(context.sourceArtifactSnapshotDigest).toBe(before.snapshotDigest);
    expect(JSON.stringify(context.validatorProjection!.coverage)).toBe(before.coverage);
    // Object identity, not just equality: the publisher reused the frozen
    // registry rather than reassembling one.
    expect(context.registry).toBe(before.registry);
    expect(Object.isFrozen(context.registry)).toBe(true);
  });

  it('keeps persisted authority metadata canonical and complete after a failure', () => {
    const metadata = buildProjectTruthAuthorityMetadata(resolveProjectTruthAuthority(goldenInput()));

    expect(metadata.projectTruthAuthorityMode).toBe('canonical');
    expect(metadata.canonicalAssemblyStatus).toBe('assembled');
    expect(metadata.blockedTruthDomains).toEqual([]);
    // Publication status is operational metadata and lives outside authority.
    expect(Object.keys(metadata)).not.toContain('publicationStatus');
  });
});

// ── Case 7: determinism ─────────────────────────────────────────────────────

describe('gate 7 — determinism', () => {
  it('produces identical identities, coverage, and digests across runs', () => {
    const first = resolveProjectTruthAuthority(goldenInput());
    const second = resolveProjectTruthAuthority(goldenInput());

    expect(first.registryDigest).toBe(second.registryDigest);
    expect(first.sourceArtifactSnapshotDigest).toBe(second.sourceArtifactSnapshotDigest);
    expect(JSON.stringify(first.validatorProjection))
      .toBe(JSON.stringify(second.validatorProjection));
  });

  it('is independent of input row ordering', () => {
    const rows = [
      invoiceRow({ id: 'row-a', invoice_number: 'INV-1' }),
      invoiceRow({ id: 'row-b', invoice_number: 'INV-2' }),
    ];
    const forward = resolveProjectTruthAuthority(goldenInput({
      invoiceRows: rows,
      invoiceLineRows: [],
    }));
    const reversed = resolveProjectTruthAuthority(goldenInput({
      invoiceRows: [...rows].reverse(),
      invoiceLineRows: [],
    }));

    expect(forward.registryDigest).toBe(reversed.registryDigest);
    expect(JSON.stringify(forward.validatorProjection))
      .toBe(JSON.stringify(reversed.validatorProjection));
  });

  it('produces identical persisted metadata across runs', () => {
    expect(buildProjectTruthAuthorityMetadata(resolveProjectTruthAuthority(goldenInput())))
      .toEqual(buildProjectTruthAuthorityMetadata(resolveProjectTruthAuthority(goldenInput())));
  });
});

// ── Case 8: full-chain single assembly ──────────────────────────────────────

describe('gate 8 — full-chain single assembly', () => {
  it('adapts pricing exactly once', async () => {
    const pricingAdapter = await import('@/lib/canonical/contract/pricingAdapter');
    const spy = vi.spyOn(pricingAdapter, 'adaptAssembledPricingRows');
    try {
      resolveProjectTruthAuthority(goldenInput());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('adapts invoices and their lines exactly once per invoice', async () => {
    const invoiceAdapter = await import('@/lib/canonical/invoice/invoiceAdapter');
    const spy = vi.spyOn(invoiceAdapter, 'adaptCurrentInvoiceRows');
    try {
      resolveProjectTruthAuthority(goldenInput({
        invoiceRows: [invoiceRow({ id: 'row-a' }), invoiceRow({ id: 'row-b', invoice_number: 'INV-2' })],
        invoiceLineRows: [],
      }));
      // One pass per invoice; nothing re-adapts for relationships or coverage.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('adapts transactions exactly once per row', async () => {
    const transactionAdapter = await import('@/lib/canonical/transaction/transactionAdapter');
    const spy = vi.spyOn(transactionAdapter, 'adaptProjectTransactionRow');
    try {
      resolveProjectTruthAuthority(goldenInput({
        transactionRows: [ticketRow({ id: 'a' }), ticketRow({ id: 'b', transaction_number: 'TKT-2' })],
      }));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads nothing back from storage during assembly', async () => {
    const publication = await import('@/lib/canonical/publication/publishProjectTruthShadow');
    const spy = vi.spyOn(publication, 'publishProjectTruthShadow');
    try {
      resolveProjectTruthAuthority(goldenInput());
      // Authority never consults publication; published artifacts are evidence.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('freezes the assembled context so no downstream consumer can mutate it', () => {
    const context = resolveProjectTruthAuthority(goldenInput());

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.validatorProjection)).toBe(true);
    expect(Object.isFrozen(context.validatorProjection!.coverage)).toBe(true);
    expect(Object.isFrozen(context.registry)).toBe(true);
  });
});
