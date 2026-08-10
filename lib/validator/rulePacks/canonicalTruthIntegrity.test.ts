/**
 * Canonical identity and relationship findings.
 *
 * These prove the operator actually sees why a project cannot clear: a
 * duplicate invoice number, a conflicting governing contract, and an
 * unresolvable governing relationship each reach the existing finding model
 * with every competing observation preserved as its own evidence entry.
 */

import { describe, expect, it } from 'vitest';

import { resolveProjectTruthAuthority } from '@/lib/canonical/authority/resolveProjectTruthAuthority';
import { PROJECT_TRUTH_AUTHORITY_ENV_VAR } from '@/lib/canonical/authority/projectTruthAuthorityMode';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { ProjectValidatorInput } from '@/lib/validator/shared';

import {
  RULE_CANONICAL_INVOICE_IDENTITY_CONFLICT,
  RULE_CANONICAL_INVOICE_SOURCE_IDENTITY_UNREADABLE,
  RULE_CANONICAL_RELATIONSHIP_CONFLICTING,
  RULE_CANONICAL_RELATIONSHIP_UNRESOLVED,
  runCanonicalTruthIntegrityRules,
} from './canonicalTruthIntegrity';

const CANONICAL = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical' } as const;
const LEGACY = { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'legacy' } as const;

function pricingRow(overrides: Record<string, unknown> = {}): ContractPricingAssemblyRow {
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

function duplicateAuthorityFinding() {
  return {
    findingId: 'duplicate_authority:doc-contract-a|doc-contract-b',
    code: 'duplicate_authority' as const,
    documentIds: ['doc-contract-a', 'doc-contract-b'],
    relationshipBasis: ['attached_to'],
    rowIdentities: ['doc-contract-a:pricing-row-1', 'doc-contract-b:pricing-row-2'],
    sourceIdentityStatus: 'absent' as const,
    sourceIdentityByDocumentId: [
      { documentId: 'doc-contract-a', sourceVersionIdentity: null },
      { documentId: 'doc-contract-b', sourceVersionIdentity: null },
    ],
    sourceIdentityReadError: null,
    missingDiscriminator: 'extraction_source_artifacts.source_sha256',
    detail: 'Two equally eligible pricing sources assert the same rows.',
  };
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

/** Builds a validator input from a REAL canonical resolution. */
function inputFor(overrides: Record<string, unknown> = {}): ProjectValidatorInput {
  const context = resolveProjectTruthAuthority({
    projectId: 'project-1',
    assembledContractPricingRows: [pricingRow()],
    pricingContext: { documentId: 'doc-contract-a', scheduleId: 'exhibit-a', scheduleName: 'Exhibit A' },
    legacyRateScheduleItems: [],
    governingDocumentIds: { contract: ['doc-contract-a'] },
    familyDocumentIds: { contract: ['doc-contract-a'] },
    sourceArtifactSnapshotDigest: 'snapshot-1',
    env: CANONICAL,
    ...overrides,
  } as Parameters<typeof resolveProjectTruthAuthority>[0]);

  return {
    project: { id: 'project-1' },
    projectTruthAuthority: context,
  } as unknown as ProjectValidatorInput;
}

describe('canonical truth integrity findings', () => {
  it('contributes nothing in legacy mode', () => {
    expect(runCanonicalTruthIntegrityRules(inputFor({
      env: LEGACY,
      invoiceRows: [invoiceRow()],
    }))).toEqual([]);
  });

  it('contributes nothing when canonical identity and relationships resolve', () => {
    expect(runCanonicalTruthIntegrityRules(inputFor({ invoiceRows: [invoiceRow()] }))).toEqual([]);
  });

  it('keeps readable absent invoice identity non-blocking', () => {
    const input = inputFor({
      invoiceRows: [invoiceRow()],
      sourceArtifactIdByDocumentId: new Map([['doc-invoice-a', null]]),
      sourceIdentityStoreState: 'read',
    });

    expect(input.projectTruthAuthority!.assemblyStatus).toBe('assembled');
    expect(input.projectTruthAuthority!.validatorProjection!.coverage.invoices.state)
      .toBe('authoritative');
    expect(runCanonicalTruthIntegrityRules(input)).toEqual([]);
  });

  it('blocks and emits an evidence-preserving finding when the identity store is unreadable', () => {
    const input = inputFor({
      invoiceRows: [invoiceRow()],
      sourceArtifactIdByDocumentId: new Map([['doc-invoice-a', null]]),
      sourceIdentityStoreState: 'unreadable',
      sourceIdentityReadError: {
        code: 'permission_denied',
        safeMessage: 'Source identity store access was denied.',
      },
    });
    const findings = runCanonicalTruthIntegrityRules(input);
    const unreadable = findings.find(
      (finding) => finding.rule_id === RULE_CANONICAL_INVOICE_SOURCE_IDENTITY_UNREADABLE,
    );

    expect(input.projectTruthAuthority!.assemblyStatus).toBe('blocked');
    expect(input.projectTruthAuthority!.validatorProjection!.coverage.invoices.reason)
      .toBe('invoice_source_identity_store_unreadable');
    expect(unreadable?.severity).toBe('critical');
    expect(unreadable?.actual).toContain('access was denied');
    expect(unreadable?.evidence).toHaveLength(1);
    expect(unreadable?.evidence[0]?.source_document_id).toBe('doc-invoice-a');
  });

  it('retains one project-level invoice diagnostic behind duplicate pricing authority', () => {
    const pricingRows = [
      pricingRow({ id: 'pricing-row-1', sourceDocumentId: 'doc-contract-a' }),
      pricingRow({ id: 'pricing-row-2', sourceDocumentId: 'doc-contract-b' }),
    ];
    const invoices = [
      invoiceRow({ id: 'invoice-row-b', source_document_id: 'doc-invoice-b', invoice_number: 'INV-2' }),
      invoiceRow({ id: 'invoice-row-a', source_document_id: 'doc-invoice-a', invoice_number: 'INV-1' }),
    ];
    const build = (reverse: boolean) => inputFor({
      assembledContractPricingRows: reverse ? [...pricingRows].reverse() : pricingRows,
      contractPricingDuplicateAuthority: [duplicateAuthorityFinding()],
      invoiceRows: reverse ? [...invoices].reverse() : invoices,
      sourceArtifactIdByDocumentId: new Map([
        ['doc-invoice-a', null],
        ['doc-invoice-b', null],
      ]),
      sourceIdentityStoreState: 'unreadable',
      sourceIdentityReadError: {
        code: 'permission_denied',
        safeMessage: 'Source identity store access was denied.',
      },
    });
    const forward = build(false);
    const reversed = build(true);
    const forwardFindings = runCanonicalTruthIntegrityRules(forward);
    const reversedFindings = runCanonicalTruthIntegrityRules(reversed);
    const unreadable = forwardFindings.filter(
      (finding) => finding.rule_id === RULE_CANONICAL_INVOICE_SOURCE_IDENTITY_UNREADABLE,
    );

    expect(forward.projectTruthAuthority!.blockReason).toBe('duplicate_authority');
    expect(forward.projectTruthAuthority!.block?.duplicateAuthority).toHaveLength(1);
    expect(forward.projectTruthAuthority!.registry).not.toBeNull();
    expect(forward.projectTruthAuthority!.validatorProjection).toBeNull();
    expect(forward.projectTruthAuthority!.diagnosticProjection!.integritySignals).toHaveLength(1);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].subject_type).toBe('project');
    expect(unreadable[0].evidence.map((entry) => entry.source_document_id))
      .toEqual(['doc-invoice-a', 'doc-invoice-b']);
    expect(forward.projectTruthAuthority!.registryDigest)
      .toBe(reversed.projectTruthAuthority!.registryDigest);
    expect(forward.projectTruthAuthority!.diagnosticProjection)
      .toEqual(reversed.projectTruthAuthority!.diagnosticProjection);
    expect(forwardFindings.map((finding) => finding.id))
      .toEqual(reversedFindings.map((finding) => finding.id));
  });

  it('blocks and names both sources when two documents claim one invoice number', () => {
    const findings = runCanonicalTruthIntegrityRules(inputFor({
      invoiceRows: [
        invoiceRow({ id: 'row-a', source_document_id: 'doc-invoice-a' }),
        invoiceRow({ id: 'row-b', source_document_id: 'doc-invoice-b' }),
      ],
    }));
    const conflict = findings.find(
      (finding) => finding.rule_id === RULE_CANONICAL_INVOICE_IDENTITY_CONFLICT,
    )!;

    expect(conflict).toBeDefined();
    expect(conflict.severity).toBe('critical');
    expect(conflict.blocked_reason).toBeTruthy();
    // One evidence entry per competing observation; neither is summarized away.
    expect(conflict.evidence).toHaveLength(2);
    expect(conflict.evidence.map((entry) => entry.source_document_id).sort())
      .toEqual(['doc-invoice-a', 'doc-invoice-b']);
  });

  it('blocks on a conflicting governing contract and preserves both candidates', () => {
    const findings = runCanonicalTruthIntegrityRules(inputFor({
      invoiceRows: [invoiceRow()],
      governingDocumentIds: { contract: ['doc-contract-a', 'doc-contract-b'] },
    }));
    const conflict = findings.find(
      (finding) => finding.rule_id === RULE_CANONICAL_RELATIONSHIP_CONFLICTING,
    )!;

    expect(conflict).toBeDefined();
    expect(conflict.severity).toBe('critical');
    expect(conflict.blocked_reason).toBeTruthy();
    expect(conflict.evidence.map((entry) => entry.field_value).sort())
      .toContain('doc-contract-a');
    expect(conflict.evidence.map((entry) => entry.field_value).sort())
      .toContain('doc-contract-b');
  });

  it('blocks when a required governing relationship cannot be established', () => {
    const findings = runCanonicalTruthIntegrityRules(inputFor({
      invoiceRows: [invoiceRow()],
      governingDocumentIds: {},
    }));
    const unresolved = findings.find(
      (finding) => finding.rule_id === RULE_CANONICAL_RELATIONSHIP_UNRESOLVED,
    )!;

    expect(unresolved).toBeDefined();
    expect(unresolved.blocked_reason).toContain('unresolved');
  });

  it('carries canonical provenance into finding evidence', () => {
    const findings = runCanonicalTruthIntegrityRules(inputFor({
      invoiceRows: [
        invoiceRow({ id: 'row-a', source_document_id: 'doc-invoice-a' }),
        invoiceRow({ id: 'row-b', source_document_id: 'doc-invoice-b' }),
      ],
    }));

    for (const entry of findings[0].evidence) {
      expect(entry.note).toContain('canonical_invoice_authority');
      expect(entry.source_document_id).toBeTruthy();
    }
  });

  it('produces stable finding and evidence identity across repeated runs', () => {
    const build = () => runCanonicalTruthIntegrityRules(inputFor({
      invoiceRows: [
        invoiceRow({ id: 'row-a', source_document_id: 'doc-invoice-a' }),
        invoiceRow({ id: 'row-b', source_document_id: 'doc-invoice-b' }),
      ],
      governingDocumentIds: { contract: ['doc-contract-a', 'doc-contract-b'] },
    }));

    const first = build();
    const second = build();
    expect(first.map((finding) => finding.id)).toEqual(second.map((finding) => finding.id));
    expect(first.flatMap((finding) => finding.evidence.map((entry) => entry.id)))
      .toEqual(second.flatMap((finding) => finding.evidence.map((entry) => entry.id)));
  });

  it('reports unresolved invoice-line identity without blocking clearance', () => {
    const findings = runCanonicalTruthIntegrityRules(inputFor({
      invoiceRows: [invoiceRow()],
      invoiceLineRows: [
        { invoice_id: 'invoice-row-1', source_document_id: 'doc-invoice-a', line_description: 'A', quantity: 1, line_total: 1 },
        { invoice_id: 'invoice-row-1', source_document_id: 'doc-invoice-a', line_description: 'A', quantity: 1, line_total: 1 },
      ],
    }));
    const lineIssue = findings.find((finding) => finding.subject_type === 'invoice_line')!;

    // Unresolved line identity is reported, not blocking: the lines were kept
    // distinct, so no total is wrong — only unattributable.
    expect(lineIssue).toBeDefined();
    expect(lineIssue.severity).toBe('warning');
    expect(lineIssue.blocked_reason).toBeNull();
  });

  it('reads no authority mode and no environment of its own', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/validator/rulePacks/canonicalTruthIntegrity.ts', 'utf8'));

    // Rule-pack neutrality: the pack must not rediscover which authority ran.
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('authorityMode');
    expect(source).not.toContain('readProjectTruthAuthorityMode');
  });
});
