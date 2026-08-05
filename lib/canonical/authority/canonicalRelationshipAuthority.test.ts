/**
 * Canonical contract, invoice, and governing-document relationships.
 *
 * The behavior under test is refusal: where a governing document cannot be
 * determined the relationship must stay unresolved, and where two candidates
 * compete it must stay conflicting. Neither may quietly become a confident
 * relationship, because a confident-but-wrong governing document silently
 * validates invoices against the wrong contract.
 */

import { describe, expect, it } from 'vitest';

import type { CanonicalContractPricingSchedule } from '@/lib/canonical/contract/pricing';
import type { CanonicalTransaction } from '@/lib/canonical/transaction/transaction';

import {
  assembleCanonicalRelationships,
  type CanonicalRelationshipAssemblyInput,
  type CanonicalRelationshipKind,
} from './canonicalRelationshipAuthority';
import { buildCanonicalProvenance } from './canonicalProvenance';
import type { CanonicalInvoiceIdentity } from './canonicalInvoiceAuthority';

const PROJECT_ID = 'project-1';

function invoiceIdentity(
  overrides: Partial<CanonicalInvoiceIdentity> = {},
): CanonicalInvoiceIdentity {
  return {
    canonicalInvoiceId: 'canonical-invoice:project-1:doc-a:inv-1001',
    projectId: PROJECT_ID,
    sourceArtifactId: 'artifact-1',
    sourceDocumentId: 'doc-invoice-a',
    sourceRecordId: 'row-a',
    invoiceNumber: 'INV-1001',
    invoiceNumberPresent: true,
    invoiceDate: '2026-05-01',
    contractorVendor: 'Acme Hauling',
    documentFamily: 'invoice',
    identityBasis: [],
    identityConfidence: 'document_scoped',
    provenance: buildCanonicalProvenance({
      adapterId: 'canonical_invoice_authority',
      derivation: 'observed',
      evidence: [],
      sourceDocumentId: 'doc-invoice-a',
    }),
    ...overrides,
  };
}

function pricingSchedule(documentId: string | null): CanonicalContractPricingSchedule {
  return {
    scheduleId: 'exhibit-a',
    scheduleName: 'Exhibit A',
    governingDocument: documentId != null
      ? { documentId, family: 'contract', title: null }
      : null,
    rows: [],
    coverage: { candidateCount: 0, resolvedCount: 0, needsReviewCount: 0, excludedCount: 0 },
  } as unknown as CanonicalContractPricingSchedule;
}

function assemble(
  overrides: Partial<CanonicalRelationshipAssemblyInput> = {},
) {
  return assembleCanonicalRelationships({
    projectId: PROJECT_ID,
    invoiceIdentities: [invoiceIdentity()],
    invoiceLineIdentities: [],
    orphanedInvoiceLineCount: 0,
    transactions: [],
    contractPricing: [pricingSchedule('doc-contract-a')],
    governingDocumentIds: { contract: ['doc-contract-a'] },
    familyDocumentIds: { contract: ['doc-contract-a'], invoice: ['doc-invoice-a'] },
    ...overrides,
  });
}

function find(
  assembly: ReturnType<typeof assemble>,
  kind: CanonicalRelationshipKind,
) {
  return assembly.relationships.find((entry) => entry.kind === kind)!;
}

describe('canonical relationships — established truth', () => {
  it('derives one valid governing contract relationship', () => {
    const assembly = assemble();
    const governing = find(assembly, 'invoice_references_governing_contract');

    expect(governing.state).toBe('derived');
    expect(governing.to).toEqual({ kind: 'document', id: 'doc-contract-a' });
    expect(governing.basis).toBe('document_precedence');
    expect(assembly.blockedDomains).toEqual([]);
  });

  it('places the invoice in its contract family and its project', () => {
    const assembly = assemble();

    expect(find(assembly, 'invoice_belongs_to_project').to)
      .toEqual({ kind: 'project', id: PROJECT_ID });
    expect(find(assembly, 'invoice_belongs_to_contract_family').state).toBe('derived');
  });

  it('establishes rate truth from the canonical pricing rows themselves', () => {
    const assembly = assemble();
    const rateTruth = find(assembly, 'pricing_exhibit_governs_rate_truth');

    expect(rateTruth.state).toBe('observed');
    expect(rateTruth.to).toEqual({ kind: 'document', id: 'doc-contract-a' });
  });

  it('projects document precedence verbatim without reinterpreting it', () => {
    const assembly = assemble({
      documentRelationships: [{
        source_document_id: 'doc-amendment-1',
        target_document_id: 'doc-contract-a',
        relationship_type: 'amends',
      }],
    });
    const precedence = find(assembly, 'document_precedence');

    expect(precedence.state).toBe('observed');
    expect(precedence.detail).toContain('amends');
  });
});

describe('canonical relationships — missing and conflicting', () => {
  it('leaves the governing contract unresolved when none exists', () => {
    const assembly = assemble({ governingDocumentIds: {}, familyDocumentIds: {} });
    const governing = find(assembly, 'invoice_references_governing_contract');

    expect(governing.state).toBe('unresolved');
    expect(governing.to).toBeNull();
    expect(governing.basis).toBe('none');
    // A required unresolved relationship blocks the affected truth domain.
    expect(assembly.blockedDomains).toContain('invoices');
    expect(assembly.unresolvedRequired).toContain(governing);
  });

  it('stays conflicting when two governing contracts compete', () => {
    const assembly = assemble({
      governingDocumentIds: { contract: ['doc-contract-a', 'doc-contract-b'] },
    });
    const governing = find(assembly, 'invoice_references_governing_contract');

    expect(governing.state).toBe('conflicting');
    // No winner is chosen, and both candidates survive as evidence.
    expect(governing.to).toBeNull();
    expect(governing.candidateIds).toEqual(['doc-contract-a', 'doc-contract-b']);
    expect(assembly.conflicting).toContain(governing);
    expect(assembly.blockedDomains).toContain('invoices');
  });

  it('treats conflicting rate truth as blocking even without a required flag', () => {
    const assembly = assemble({
      contractPricing: [pricingSchedule('doc-contract-a'), pricingSchedule('doc-contract-b')],
    });
    const rateTruth = find(assembly, 'pricing_exhibit_governs_rate_truth');

    expect(rateTruth.state).toBe('conflicting');
    expect(assembly.blockedDomains).toContain('pricing');
  });

  it('reports an unattachable invoice line rather than adopting a parent', () => {
    const assembly = assemble({ orphanedInvoiceLineCount: 3 });

    expect(assembly.blockedDomains).toContain('invoiceLines');
    expect(assembly.unresolvedRequired.some((entry) => entry.detail.includes('3 invoice line(s)')))
      .toBe(true);
  });
});

describe('canonical relationships — operator assertion', () => {
  it('lets an operator assertion outrank a derived relationship', () => {
    const assembly = assemble({
      operatorAssertions: [{
        assertionId: 'assertion-1',
        kind: 'invoice_references_governing_contract',
        fromId: 'canonical-invoice:project-1:doc-a:inv-1001',
        toId: 'doc-contract-operator-chosen',
      }],
    });
    const governing = find(assembly, 'invoice_references_governing_contract');

    expect(governing.state).toBe('operator_asserted');
    expect(governing.to).toEqual({ kind: 'document', id: 'doc-contract-operator-chosen' });
    expect(governing.provenance.operatorAssertionId).toBe('assertion-1');
  });

  it('settles a conflict only through an explicit assertion, retaining candidates', () => {
    const assembly = assemble({
      governingDocumentIds: { contract: ['doc-contract-a', 'doc-contract-b'] },
      operatorAssertions: [{
        assertionId: 'assertion-2',
        kind: 'invoice_references_governing_contract',
        fromId: 'canonical-invoice:project-1:doc-a:inv-1001',
        toId: 'doc-contract-b',
      }],
    });
    const governing = find(assembly, 'invoice_references_governing_contract');

    expect(governing.state).toBe('operator_asserted');
    // The overridden candidates stay on the record so the decision is auditable.
    expect(governing.candidateIds).toEqual(['doc-contract-a', 'doc-contract-b']);
    expect(assembly.blockedDomains).not.toContain('invoices');
  });
});

describe('canonical relationships — determinism', () => {
  it('produces identical relationship identities across runs and input orderings', () => {
    const forward = assemble({
      governingDocumentIds: { contract: ['doc-contract-a', 'doc-contract-b'] },
    });
    const reversed = assemble({
      governingDocumentIds: { contract: ['doc-contract-b', 'doc-contract-a'] },
    });

    expect(forward.relationships.map((entry) => entry.relationshipId))
      .toEqual(reversed.relationships.map((entry) => entry.relationshipId));
    expect(forward.relationships.map((entry) => entry.state))
      .toEqual(reversed.relationships.map((entry) => entry.state));
  });

  it('keeps relationship identity stable when state changes', () => {
    // Identity is kind + endpoints only, so a relationship that later resolves
    // keeps its id rather than appearing as a brand new one.
    const unresolved = assemble({ governingDocumentIds: {} });
    const id = find(unresolved, 'invoice_belongs_to_project').relationshipId;
    const resolved = assemble();

    expect(find(resolved, 'invoice_belongs_to_project').relationshipId).toBe(id);
  });

  it('keeps relationship grain bounded by identity class, not row count', () => {
    const transactions = Array.from({ length: 250 }, (_, index) => ({
      transactionId: `t-${String(index)}`,
      matchingKeys: { billingRateKey: 'RATE-KEY-1', descriptionMatchKey: null, siteMaterialKey: null, invoiceRateKey: null },
      invoiceNumber: { value: 'INV-1001', state: 'resolved' },
    })) as unknown as readonly CanonicalTransaction[];

    const assembly = assemble({ transactions });

    // 250 rows collapse to one invoice-number link and one rate-key link.
    expect(assembly.relationships.filter((entry) => entry.kind === 'transaction_belongs_to_invoice_line'))
      .toHaveLength(1);
    expect(assembly.relationships.filter(
      (entry) => entry.kind === 'transaction_references_governing_pricing_row',
    )).toHaveLength(1);
  });
});
