/**
 * Canonical invoice and invoice-line identity.
 *
 * The cases here are the ones that make identity wrong in practice: a missing
 * invoice number, one number claimed by two documents, and duplicate-looking
 * lines that a value-based identity would silently merge.
 */

import { describe, expect, it } from 'vitest';

import {
  assembleCanonicalInvoices,
  type PersistedCanonicalInvoiceRowInput,
} from './canonicalInvoiceAuthority';
import type { SourceIdentityReadFailure } from '@/lib/sourceIdentityReadFailure';

const PROJECT_ID = 'project-1';

function invoiceRow(overrides: Record<string, unknown> = {}): PersistedCanonicalInvoiceRowInput {
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

function lineRow(overrides: Record<string, unknown> = {}): PersistedCanonicalInvoiceRowInput {
  return {
    id: 'line-row-1',
    invoice_id: 'invoice-row-1',
    source_document_id: 'doc-invoice-a',
    line_description: 'HAUL CLASS 4',
    quantity: 10,
    unit_price: 12.5,
    line_total: 125,
    source_page: 2,
    source_row_number: 7,
    source_sheet_name: 'Sheet1',
    ...overrides,
  };
}

function assemble(input: {
  invoiceRows: readonly PersistedCanonicalInvoiceRowInput[];
  invoiceLineRows?: readonly PersistedCanonicalInvoiceRowInput[];
  artifacts?: ReadonlyMap<string, string | null>;
  storeState?: 'read' | 'unreadable';
  storeReadError?: SourceIdentityReadFailure | null;
}) {
  return assembleCanonicalInvoices({
    projectId: PROJECT_ID,
    invoiceRows: input.invoiceRows,
    invoiceLineRows: input.invoiceLineRows ?? [],
    sourceArtifactIdByDocumentId: input.artifacts,
    sourceIdentityStoreState: input.storeState,
    sourceIdentityReadError: input.storeReadError,
  });
}

describe('canonical invoice identity', () => {
  it('scopes identity by project, artifact, document, and invoice number', () => {
    const assembly = assemble({
      invoiceRows: [invoiceRow()],
      artifacts: new Map([['doc-invoice-a', 'artifact-sha-1']]),
    });

    const identity = assembly.invoiceIdentities[0];
    expect(identity.projectId).toBe(PROJECT_ID);
    expect(identity.sourceArtifactId).toBe('artifact-sha-1');
    expect(identity.sourceIdentityStatus).toBe('present');
    expect(identity.sourceIdentityReadError).toBeNull();
    expect(identity.sourceDocumentId).toBe('doc-invoice-a');
    expect(identity.invoiceNumber).toBe('INV-1001');
    expect(identity.invoiceNumberPresent).toBe(true);
    expect(identity.invoiceDate).toBe('2026-05-01');
    expect(identity.contractorVendor).toBe('Acme Hauling');
    expect(identity.identityConfidence).toBe('document_scoped');
    expect(identity.identityBasis).toEqual([
      'project:project-1',
      'artifact:artifact-sha-1',
      'document:doc-invoice-a',
      'invoice-number:inv-1001',
    ]);
  });

  it('preserves readable absence as an honest missing identity', () => {
    const assembly = assemble({
      invoiceRows: [invoiceRow()],
      artifacts: new Map([['doc-invoice-a', null]]),
      storeState: 'read',
      storeReadError: {
        code: 'query_failed',
        safeMessage: 'Source identity store query failed.',
      },
    });

    const identity = assembly.invoiceIdentities[0];
    expect(identity.sourceArtifactId).toBeNull();
    expect(identity.sourceIdentityStatus).toBe('absent');
    expect(identity.sourceIdentityReadError).toBeNull();
    expect(identity.identityConfidence).toBe('document_scoped');
    expect(identity.identityBasis).toContain('artifact:null');
  });

  it('preserves an unreadable store as uncertainty, not absent identity', () => {
    const assembly = assemble({
      invoiceRows: [invoiceRow()],
      artifacts: new Map([['doc-invoice-a', null]]),
      storeState: 'unreadable',
      storeReadError: {
        code: 'permission_denied',
        safeMessage: 'Source identity store access was denied.',
      },
    });

    const identity = assembly.invoiceIdentities[0];
    expect(identity.sourceArtifactId).toBeNull();
    expect(identity.sourceIdentityStatus).toBe('unreadable');
    expect(identity.sourceIdentityReadError).toEqual({
      code: 'permission_denied',
      safeMessage: 'Source identity store access was denied.',
    });
    expect(identity.identityConfidence).toBe('document_scoped');
    expect(identity.identityBasis).toContain('artifact:unreadable');
    expect(identity.identityBasis).not.toContain('artifact:null');
  });

  it('does not derive identity from the persisted row id', () => {
    // The row id is generated at insertion. If it leaked into the canonical id,
    // reinserting the same invoice would rename it.
    const first = assemble({ invoiceRows: [invoiceRow({ id: 'row-a' })] });
    const second = assemble({ invoiceRows: [invoiceRow({ id: 'row-b' })] });

    expect(first.invoices[0].invoiceId).toBe(second.invoices[0].invoiceId);
  });

  it('does not derive identity from invoice totals', () => {
    const first = assemble({ invoiceRows: [invoiceRow({ billed_amount: 1000 })] });
    const second = assemble({ invoiceRows: [invoiceRow({ billed_amount: 999_999 })] });

    // A value disagreement must never look like two different invoices.
    expect(first.invoices[0].invoiceId).toBe(second.invoices[0].invoiceId);
  });

  it('produces identical ids across repeated runs and input orderings', () => {
    const rows = [
      invoiceRow({ id: 'row-a', invoice_number: 'INV-1' }),
      invoiceRow({ id: 'row-b', invoice_number: 'INV-2', source_document_id: 'doc-invoice-b' }),
    ];
    const forward = assemble({ invoiceRows: rows });
    const reversed = assemble({ invoiceRows: [...rows].reverse() });

    expect(forward.invoices.map((invoice) => invoice.invoiceId))
      .toEqual(reversed.invoices.map((invoice) => invoice.invoiceId));
  });

  it('states a missing invoice number explicitly rather than blanking it', () => {
    const assembly = assemble({ invoiceRows: [invoiceRow({ invoice_number: null })] });

    const identity = assembly.invoiceIdentities[0];
    expect(identity.invoiceNumber).toBeNull();
    expect(identity.invoiceNumberPresent).toBe(false);
    expect(identity.identityBasis).toContain('invoice-number:absent');
    expect(assembly.invoices[0].invoiceNumber.state).toBe('absent_from_source');
  });

  it('does not collapse two unnumbered invoices in one document', () => {
    const assembly = assemble({
      invoiceRows: [
        invoiceRow({ id: 'row-a', invoice_number: null }),
        invoiceRow({ id: 'row-b', invoice_number: null }),
      ],
    });

    const ids = assembly.invoices.map((invoice) => invoice.invoiceId);
    expect(new Set(ids).size).toBe(2);
    expect(assembly.distinctInvoiceIdentityCount).toBe(2);
    // Identity precision degraded, and it says so.
    expect(assembly.invoiceIdentities.every((identity) => identity.identityConfidence === 'source_scoped'))
      .toBe(true);
  });

  it('reports unresolved identity when no source discriminator exists at all', () => {
    const assembly = assemble({
      invoiceRows: [
        invoiceRow({ id: null, invoice_number: null }),
        invoiceRow({ id: null, invoice_number: null }),
      ],
    });

    expect(new Set(assembly.invoices.map((invoice) => invoice.invoiceId)).size).toBe(2);
    expect(assembly.invoiceIdentities.every((identity) => identity.identityConfidence === 'unresolved'))
      .toBe(true);
    expect(assembly.invoices.every((invoice) => invoice.unresolvedFields.includes('invoiceId')))
      .toBe(true);
  });

  it('preserves both observations when two documents claim one invoice number', () => {
    const assembly = assemble({
      invoiceRows: [
        invoiceRow({ id: 'row-a', source_document_id: 'doc-invoice-a' }),
        invoiceRow({ id: 'row-b', source_document_id: 'doc-invoice-b' }),
      ],
    });

    expect(assembly.invoices).toHaveLength(2);
    expect(new Set(assembly.invoices.map((invoice) => invoice.invoiceId)).size).toBe(2);

    const conflict = assembly.identityConflicts[0];
    expect(assembly.identityConflicts).toHaveLength(1);
    expect(conflict.invoiceNumber).toBe('INV-1001');
    expect(conflict.sourceDocumentIds).toEqual(['doc-invoice-a', 'doc-invoice-b']);
    // Both competing observations are named; neither is chosen.
    expect(conflict.canonicalInvoiceIds).toHaveLength(2);
  });

  it('does not treat one document restating its own invoice number as a conflict', () => {
    const assembly = assemble({
      invoiceRows: [
        invoiceRow({ id: 'row-a' }),
        invoiceRow({ id: 'row-b' }),
      ],
    });

    expect(assembly.identityConflicts).toHaveLength(0);
  });

  it('carries provenance identifying the source document and observation', () => {
    const assembly = assemble({
      invoiceRows: [invoiceRow()],
      artifacts: new Map([['doc-invoice-a', 'artifact-sha-1']]),
    });

    const { provenance } = assembly.invoiceIdentities[0];
    expect(provenance.sourceDocumentId).toBe('doc-invoice-a');
    expect(provenance.sourceArtifactId).toBe('artifact-sha-1');
    expect(provenance.observationId).toBe('invoice-row-1');
    expect(provenance.adapterId).toBe('canonical_invoice_authority');
    expect(provenance.derivation).toBe('observed');
    // Geometry is absent from this source and is not invented.
    expect(provenance.boundingBox).toBeNull();
  });
});

describe('canonical invoice-line identity', () => {
  it('keeps duplicate-looking lines on separate rows distinct', () => {
    const assembly = assemble({
      invoiceRows: [invoiceRow()],
      invoiceLineRows: [
        lineRow({ id: null, source_row_number: 7 }),
        lineRow({ id: null, source_row_number: 8 }),
      ],
    });

    expect(assembly.lines).toHaveLength(2);
    expect(new Set(assembly.lines.map((line) => line.lineId)).size).toBe(2);
    expect(assembly.lineIdentityIssues).toHaveLength(0);
  });

  it('keeps identical values on different pages distinct', () => {
    const assembly = assemble({
      invoiceRows: [invoiceRow()],
      invoiceLineRows: [
        lineRow({ id: null, source_page: 2, source_row_number: null }),
        lineRow({ id: null, source_page: 3, source_row_number: null }),
      ],
    });

    expect(new Set(assembly.lines.map((line) => line.lineId)).size).toBe(2);
  });

  it('does not derive line identity from description, quantity, rate, or amount', () => {
    const base = assemble({
      invoiceRows: [invoiceRow()],
      invoiceLineRows: [lineRow()],
    });
    const changedValues = assemble({
      invoiceRows: [invoiceRow()],
      invoiceLineRows: [lineRow({
        line_description: 'COMPLETELY DIFFERENT',
        quantity: 999,
        unit_price: 1,
        line_total: 999,
      })],
    });

    // Same physical row, different values: still one identity.
    expect(base.lines[0].lineId).toBe(changedValues.lines[0].lineId);
  });

  it('accepts missing geometry as long as source location stays honest', () => {
    const assembly = assemble({
      invoiceRows: [invoiceRow()],
      invoiceLineRows: [lineRow()],
    });

    const identity = assembly.lineIdentities[0];
    expect(identity.provenance.boundingBox).toBeNull();
    expect(identity.provenance.page).toBe(2);
    expect(identity.provenance.rowNumber).toBe(7);
    expect(identity.identityConfidence).toBe('source_scoped');
    expect(assembly.lineIdentityIssues).toHaveLength(0);
  });

  it('surfaces unresolved identity when a line has no source location at all', () => {
    const assembly = assemble({
      invoiceRows: [invoiceRow()],
      invoiceLineRows: [
        lineRow({ id: null, source_page: null, source_row_number: null, source_sheet_name: null }),
        lineRow({ id: null, source_page: null, source_row_number: null, source_sheet_name: null }),
      ],
    });

    // Both lines survive — unresolved identity never justifies a merge.
    expect(assembly.lines).toHaveLength(2);
    expect(new Set(assembly.lines.map((line) => line.lineId)).size).toBe(2);
    expect(assembly.lineIdentityIssues[0].reason).toBe('missing_source_row_identity');
    expect(assembly.lineIdentities.every((identity) => identity.identityConfidence === 'unresolved'))
      .toBe(true);
  });

  it('produces identical line ids across repeated runs', () => {
    const rows = [lineRow({ id: 'line-a' }), lineRow({ id: 'line-b', source_row_number: 8 })];
    const first = assemble({ invoiceRows: [invoiceRow()], invoiceLineRows: rows });
    const second = assemble({ invoiceRows: [invoiceRow()], invoiceLineRows: [...rows].reverse() });

    expect(first.lines.map((line) => line.lineId)).toEqual(second.lines.map((line) => line.lineId));
  });

  it('attaches every line to its canonical invoice id', () => {
    const assembly = assemble({
      invoiceRows: [invoiceRow()],
      invoiceLineRows: [lineRow()],
    });

    expect(assembly.lines[0].invoiceId).toBe(assembly.invoices[0].invoiceId);
    expect(assembly.orphanedLineCount).toBe(0);
  });

  it('reports an unattachable line rather than adopting an arbitrary parent', () => {
    const assembly = assemble({
      invoiceRows: [
        invoiceRow({ id: 'row-a', source_document_id: 'doc-invoice-a' }),
        invoiceRow({ id: 'row-b', source_document_id: 'doc-invoice-a', invoice_number: 'INV-1002' }),
      ],
      // No invoice_id link, and the document holds two invoices, so the parent
      // is genuinely ambiguous.
      invoiceLineRows: [lineRow({ invoice_id: null })],
    });

    expect(assembly.orphanedLineCount).toBe(1);
    expect(assembly.lines).toHaveLength(0);
  });
});
