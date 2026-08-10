/**
 * Canonical authority coverage and its persisted metadata.
 *
 * The rule under test is the canonical success rule: a canonical run may not
 * report success while a required truth domain is still blocked. Before
 * coverage existed, `assembled` meant only "the assembly did not throw", which
 * was indistinguishable from full canonical authority at the run level.
 */

import { describe, expect, it } from 'vitest';

import { buildPersistedValidationSummary } from '@/lib/validator/persistValidationRun';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';

import { buildProjectTruthAuthorityMetadata } from './canonicalExecutionContext';
import {
  allDomainsBlocked,
  authoritativeDomain,
  blockedDomain,
  blockedTruthDomains,
  hasCompleteCanonicalAuthority,
  notApplicableDomain,
  type CanonicalAuthorityCoverage,
} from './canonicalDomainCoverage';
import { PROJECT_TRUTH_AUTHORITY_ENV_VAR } from './projectTruthAuthorityMode';
import { resolveProjectTruthAuthority } from './resolveProjectTruthAuthority';

const CANONICAL = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical' } as const;
const LEGACY = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'legacy' } as const;

function pricingRow(overrides: Partial<ContractPricingAssemblyRow> = {}): ContractPricingAssemblyRow {
  return {
    id: 'pricing-row-1',
    category: 'transport',
    description: 'HAUL CLASS 4',
    route: null,
    distanceBand: null,
    unit: 'CYD',
    rate: 12.5,
    page: 3,
    sourceAnchor: 'anchor-1',
    confidence: 'high',
    authoredValueCorrection: false,
    ...overrides,
  } as unknown as ContractPricingAssemblyRow;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    assembledContractPricingRows: [pricingRow()],
    pricingContext: { documentId: 'doc-contract-a', scheduleId: 'exhibit-a', scheduleName: 'Exhibit A' },
    legacyRateScheduleItems: [],
    governingDocumentIds: { contract: ['doc-contract-a'] },
    familyDocumentIds: { contract: ['doc-contract-a'] },
    sourceArtifactSnapshotDigest: 'snapshot-1',
    env: CANONICAL,
    ...overrides,
  } as Parameters<typeof resolveProjectTruthAuthority>[0];
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invoice-row-1',
    source_document_id: 'doc-invoice-a',
    invoice_number: 'INV-1001',
    invoice_date: '2026-05-01',
    vendor_name: 'Acme Hauling',
    billed_amount: 1000,
    ...overrides,
  };
}

describe('coverage model', () => {
  it('treats not_applicable as satisfied and blocked as not', () => {
    const coverage = {
      pricing: authoritativeDomain(),
      invoices: notApplicableDomain('project_has_no_invoice_source'),
      invoiceLines: notApplicableDomain('project_has_no_invoice_line_source'),
      transactions: authoritativeDomain(),
      relationships: authoritativeDomain(),
      provenance: authoritativeDomain(),
    } satisfies CanonicalAuthorityCoverage;

    expect(hasCompleteCanonicalAuthority(coverage)).toBe(true);
    expect(blockedTruthDomains(coverage)).toEqual([]);
  });

  it('reports every blocked required domain in stable order', () => {
    const coverage: CanonicalAuthorityCoverage = {
      ...allDomainsBlocked('assembly_failed'),
      pricing: authoritativeDomain(),
      invoices: blockedDomain('unresolved_invoice_identity', ['doc-b', 'doc-a']),
    };

    expect(hasCompleteCanonicalAuthority(coverage)).toBe(false);
    expect(blockedTruthDomains(coverage))
      .toEqual(['invoices', 'invoiceLines', 'transactions', 'relationships', 'provenance']);
    // Source gaps are sorted, so the persisted record is stable across runs.
    expect(coverage.invoices.sourceGaps).toEqual(['doc-a', 'doc-b']);
  });
});

describe('coverage under real canonical resolution', () => {
  it('reports authoritative pricing and not_applicable domains without sources', () => {
    const context = resolveProjectTruthAuthority(input());
    const coverage = context.validatorProjection!.coverage;

    expect(context.assemblyStatus).toBe('assembled');
    expect(coverage.pricing.state).toBe('authoritative');
    expect(coverage.invoices.state).toBe('not_applicable');
    expect(coverage.transactions.state).toBe('not_applicable');
    expect(coverage.relationships.state).toBe('authoritative');
    expect(coverage.provenance.state).toBe('authoritative');
  });

  it('reports authoritative invoice coverage when identity resolves cleanly', () => {
    const context = resolveProjectTruthAuthority(input({ invoiceRows: [invoiceRow()] }));

    expect(context.assemblyStatus).toBe('assembled');
    expect(context.validatorProjection!.coverage.invoices.state).toBe('authoritative');
  });

  it('blocks the run when two documents claim one invoice number', () => {
    const context = resolveProjectTruthAuthority(input({
      invoiceRows: [
        invoiceRow({ id: 'row-a', source_document_id: 'doc-invoice-a' }),
        invoiceRow({ id: 'row-b', source_document_id: 'doc-invoice-b' }),
      ],
    }));

    // The canonical success rule: a required domain is blocked, so the run is
    // blocked rather than reporting success with a footnote.
    expect(context.assemblyStatus).toBe('blocked');
    expect(context.blockReason).toBe('incomplete_domain_authority');
    expect(context.validatorProjection!.coverage.invoices.reason)
      .toBe('duplicate_invoice_number_across_source_documents');
    expect(context.block!.sourceGaps).toEqual(['doc-invoice-a', 'doc-invoice-b']);
  });

  it('retains the projection on a domain block so the operator can see why', () => {
    const context = resolveProjectTruthAuthority(input({
      invoiceRows: [
        invoiceRow({ id: 'row-a', source_document_id: 'doc-invoice-a' }),
        invoiceRow({ id: 'row-b', source_document_id: 'doc-invoice-b' }),
      ],
    }));

    expect(context.validatorProjection).not.toBeNull();
    expect(context.diagnosticProjection!.integritySignals.length).toBeGreaterThan(0);
  });

  it('blocks when a required governing relationship cannot be established', () => {
    const context = resolveProjectTruthAuthority(input({
      invoiceRows: [invoiceRow()],
      governingDocumentIds: {},
    }));

    expect(context.assemblyStatus).toBe('blocked');
    expect(context.validatorProjection!.coverage.invoices.reason)
      .toBe('unresolved_governing_invoice_relationship');
    expect(context.validatorProjection!.coverage.relationships.reason)
      .toBe('unresolved_required_relationship');
  });

  it('blocks when repeated ticket rows disagree on a ticket-grain value', () => {
    const context = resolveProjectTruthAuthority(input({
      transactionRows: [
        { id: 't-1', document_id: 'doc-tickets', transaction_number: 'TKT-1', transaction_quantity: 10 },
        { id: 't-2', document_id: 'doc-tickets', transaction_number: 'TKT-1', transaction_quantity: 14 },
      ],
    }));

    expect(context.assemblyStatus).toBe('blocked');
    expect(context.validatorProjection!.coverage.transactions.reason).toBe('ticket_grain_conflict');
    // Both observations survive; no winner is invented.
    expect(context.validatorProjection!.transactions.rows).toHaveLength(2);
    expect(context.validatorProjection!.transactions.distinctIdentityCount).toBe(1);
  });
});

describe('persisted authority metadata', () => {
  it('records coverage, blocked domains, and canonical counts', () => {
    const context = resolveProjectTruthAuthority(input({
      invoiceRows: [invoiceRow()],
      invoiceLineRows: [{
        id: 'line-1',
        invoice_id: 'invoice-row-1',
        source_document_id: 'doc-invoice-a',
        line_description: 'HAUL CLASS 4',
        quantity: 10,
        unit_price: 12.5,
        line_total: 125,
        source_row_number: 7,
      }],
      transactionRows: [
        { id: 't-1', document_id: 'doc-tickets', transaction_number: 'TKT-1', transaction_quantity: 10 },
      ],
    }));
    const metadata = buildProjectTruthAuthorityMetadata(context);

    expect(metadata.canonicalInvoiceCount).toBe(1);
    expect(metadata.canonicalInvoiceLineCount).toBe(1);
    expect(metadata.canonicalTransactionCount).toBe(1);
    expect(metadata.canonicalTransactionConflictCount).toBe(0);
    expect(metadata.unresolvedInvoiceIdentityCount).toBe(0);
    expect(metadata.unresolvedRelationshipCount).toBe(0);
    expect(metadata.blockedTruthDomains).toEqual([]);
    expect(metadata.canonicalAuthorityCoverage!.invoices.state).toBe('authoritative');
  });

  it('records the blocked domains on a domain-blocked run', () => {
    const metadata = buildProjectTruthAuthorityMetadata(resolveProjectTruthAuthority(input({
      transactionRows: [
        { id: 't-1', document_id: 'doc-tickets', transaction_number: 'TKT-1', transaction_quantity: 10 },
        { id: 't-2', document_id: 'doc-tickets', transaction_number: 'TKT-1', transaction_quantity: 14 },
      ],
    })));

    expect(metadata.canonicalAssemblyStatus).toBe('blocked');
    expect(metadata.canonicalAssemblyBlockReason).toBe('incomplete_domain_authority');
    expect(metadata.blockedTruthDomains).toEqual(['transactions']);
    expect(metadata.canonicalTransactionConflictCount).toBe(1);
  });

  it('leaves canonical counts null in legacy mode rather than zero', () => {
    const metadata = buildProjectTruthAuthorityMetadata(
      resolveProjectTruthAuthority(input({ env: LEGACY })),
    );

    // Zero would assert canonical authority ran and governed nothing.
    expect(metadata.canonicalInvoiceCount).toBeNull();
    expect(metadata.canonicalTransactionCount).toBeNull();
    expect(metadata.canonicalAuthorityCoverage).toBeNull();
  });

  it('is identical across repeated runs over the same input', () => {
    const first = buildProjectTruthAuthorityMetadata(resolveProjectTruthAuthority(input({
      invoiceRows: [invoiceRow()],
    })));
    const second = buildProjectTruthAuthorityMetadata(resolveProjectTruthAuthority(input({
      invoiceRows: [invoiceRow()],
    })));

    expect(first).toEqual(second);
  });
});

describe('persisted summary merge', () => {
  it('preserves every unrelated summary field when authority metadata is attached', () => {
    const summary = {
      exposure: { total_billed_amount: 1000 },
      reconciliation: { matched: 42 },
      cross_document_rate_verification: { checked: true },
    } as unknown as Parameters<typeof buildPersistedValidationSummary>[0];
    const metadata = buildProjectTruthAuthorityMetadata(
      resolveProjectTruthAuthority(input({ invoiceRows: [invoiceRow()] })),
    );

    const merged = buildPersistedValidationSummary(summary, metadata) as Record<string, unknown>;

    expect(merged.exposure).toEqual({ total_billed_amount: 1000 });
    expect(merged.reconciliation).toEqual({ matched: 42 });
    expect(merged.cross_document_rate_verification).toEqual({ checked: true });
    expect(merged.project_truth_authority).toEqual(metadata);
  });

  it('writes the summary through unchanged when there is no authority metadata', () => {
    const summary = { exposure: { total_billed_amount: 7 } } as unknown as Parameters<typeof buildPersistedValidationSummary>[0];

    // A run without authority metadata must not stamp an empty authority
    // record over an existing one.
    expect(buildPersistedValidationSummary(summary, null)).toBe(summary);
  });

  it('replaces only the authority key on a subsequent run', () => {
    const metadata = buildProjectTruthAuthorityMetadata(
      resolveProjectTruthAuthority(input({ invoiceRows: [invoiceRow()] })),
    );
    const previous = buildPersistedValidationSummary(
      { exposure: { total_billed_amount: 1 }, project_truth_authority: { projectTruthAuthorityMode: 'legacy' } } as never,
      metadata,
    ) as Record<string, unknown>;

    expect(previous.project_truth_authority).toEqual(metadata);
    expect(previous.exposure).toEqual({ total_billed_amount: 1 });
  });
});
