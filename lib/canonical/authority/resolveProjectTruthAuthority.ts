/**
 * The single authority decision for one validation execution.
 *
 * This is the only place the authority mode is resolved and the only place the
 * authoritative canonical registry is assembled. Rule packs never call this and
 * never read the environment: they receive normalized inputs and stay unaware of
 * which authority produced them.
 *
 * Invariants enforced here:
 *  - exactly one canonical assembly per execution (the caller threads the
 *    returned frozen context; nothing downstream reassembles);
 *  - no silent fallback — a canonical assembly that cannot establish governing
 *    pricing returns `blocked` with the source gap preserved, never legacy
 *    values;
 *  - authority is independent of publication.
 */

import { adaptAssembledPricingRows } from '@/lib/canonical/contract/pricingAdapter';
import {
  buildCanonicalPricingSchedule,
  resolveCanonicalPricingRow,
} from '@/lib/canonical/contract/pricingResolution';
import type { CanonicalContractPricingSchedule } from '@/lib/canonical/contract/pricing';
import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';
import type { CanonicalGoverningDocumentReference } from '@/lib/canonical/project/projectTruth';
import {
  canonicalJson,
  hashCanonicalJson,
} from '@/lib/canonical/publication/projectTruthPublicationIdentity';
import type { PersistedCanonicalTransactionRowInput } from '@/lib/canonical/transaction/transactionAdapter';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { ContractPricingDuplicateAuthorityFinding } from '@/lib/contracts/contractPricingDuplicateAuthority';
import type { SourceIdentityReadFailure } from '@/lib/sourceIdentityReadFailure';
import type {
  RateScheduleItem,
  ValidatorSourceIdentityStoreState,
  ValidatorTransactionDataDataset,
} from '@/lib/validator/shared';

import {
  type CanonicalTransactionAssembly,
  assembleCanonicalTransactions,
} from './canonicalTransactionAuthority';
import {
  type CanonicalInvoiceAssembly,
  type PersistedCanonicalInvoiceRowInput,
  assembleCanonicalInvoices,
} from './canonicalInvoiceAuthority';
import {
  type CanonicalOperatorRelationshipAssertion,
  type CanonicalRelationshipAssembly,
  assembleCanonicalRelationships,
} from './canonicalRelationshipAuthority';
import {
  type CanonicalAuthorityCoverage,
  type CanonicalDomainCoverageEntry,
  authoritativeDomain,
  blockedDomain,
  hasCompleteCanonicalAuthority,
  notApplicableDomain,
} from './canonicalDomainCoverage';

import {
  type CanonicalProjectTruthExecutionContext,
  freezeExecutionContext,
  legacyExecutionContext,
} from './canonicalExecutionContext';
import {
  type ProjectTruthAuthorityMode,
  isCanonicalProjectTruthAuthority,
  readProjectTruthAuthorityMode,
} from './projectTruthAuthorityMode';
import {
  projectCanonicalIntegritySignals,
  projectCanonicalRateScheduleItems,
} from './canonicalValidatorProjection';

export type ProjectTruthAuthorityInput = {
  readonly projectId: string;
  /**
   * Exact object retained by validator-input construction. Canonical mode
   * normalizes and resolves these rows; it never re-reads documents or
   * re-runs the pricing assembly.
   */
  readonly assembledContractPricingRows: readonly ContractPricingAssemblyRow[];
  readonly pricingContext?: {
    readonly documentId: string | null;
    readonly scheduleId?: string | null;
    readonly scheduleName?: string | null;
  } | null;
  readonly governingDocumentFamily?: string | null;
  /** Legacy items, used only as the authoritative value in legacy mode. */
  readonly legacyRateScheduleItems: readonly RateScheduleItem[];
  /**
   * Persisted transaction rows retained during validator-input construction.
   * Canonical mode adapts these in place; it never re-reads workbooks.
   */
  readonly transactionRows?: readonly PersistedCanonicalTransactionRowInput[];
  readonly transactionDatasets?: readonly ValidatorTransactionDataDataset[];
  /**
   * Effective invoice and invoice-line rows retained by validator-input
   * construction, AFTER overrides and reviews were applied. Canonical mode
   * adapts these in place; it never re-reads a document or re-runs extraction.
   */
  readonly invoiceRows?: readonly PersistedCanonicalInvoiceRowInput[];
  readonly invoiceLineRows?: readonly PersistedCanonicalInvoiceRowInput[];
  /** Frozen source-artifact identity per document, already loaded upstream. */
  readonly sourceArtifactIdByDocumentId?: ReadonlyMap<string, string | null>;
  readonly sourceIdentityStoreState?: ValidatorSourceIdentityStoreState;
  readonly sourceIdentityReadError?: SourceIdentityReadFailure | null;
  readonly documentFamilyByDocumentId?: ReadonlyMap<string, string | null>;
  /** Document-family and governing relationships from the precedence snapshot. */
  readonly governingDocumentIds?: Readonly<Record<string, readonly string[]>>;
  readonly familyDocumentIds?: Readonly<Record<string, readonly string[]>>;
  readonly documentRelationships?: readonly {
    readonly source_document_id: string;
    readonly target_document_id: string;
    readonly relationship_type: string;
  }[];
  /** Human relationship decisions. Outrank derived state; never fabricated. */
  readonly operatorRelationshipAssertions?: readonly CanonicalOperatorRelationshipAssertion[];
  /**
   * Unresolved duplicate pricing authority detected during assembly. Non-empty
   * blocks canonical authority; it is never resolved by choosing a document.
   */
  readonly contractPricingDuplicateAuthority?: readonly ContractPricingDuplicateAuthorityFinding[];
  readonly sourceArtifactSnapshotDigest: string | null;
  readonly sourceSnapshotId?: string | null;
  /** Injected for tests and harnesses so `process.env` is never mutated. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Assembles the canonical pricing section once from already-assembled rows.
 *
 * Reuses the same adapter and resolution functions the publisher uses, so the
 * mapping is not duplicated and canonical authority cannot drift from published
 * evidence.
 */
function assembleCanonicalPricing(
  input: ProjectTruthAuthorityInput,
): readonly CanonicalContractPricingSchedule[] {
  const governingDocumentId = input.pricingContext?.documentId ?? null;
  const candidates = adaptAssembledPricingRows(input.assembledContractPricingRows, {
    documentId: governingDocumentId,
    projectId: input.projectId,
    rateSchedule: input.pricingContext
      ? {
        scheduleId: input.pricingContext.scheduleId ?? null,
        scheduleName: input.pricingContext.scheduleName ?? null,
      }
      : null,
    governingDocument: governingDocumentId
      ? {
        documentId: governingDocumentId,
        family: input.governingDocumentFamily ?? null,
        title: null,
      }
      : null,
  });
  const rows = candidates.map((candidate) => resolveCanonicalPricingRow(candidate));
  if (rows.length === 0) return [];
  return [
    buildCanonicalPricingSchedule({
      scheduleId: input.pricingContext?.scheduleId ?? null,
      scheduleName: input.pricingContext?.scheduleName ?? null,
      rows,
    }),
  ];
}

/**
 * Builds the authoritative registry for this execution.
 *
 * Sections whose canonical adapters are not yet wired into the single assembly
 * are left empty rather than back-filled from legacy truth: an empty canonical
 * section is an honest "not yet canonical", while a legacy back-fill would mix
 * authorities inside one run.
 */
/**
 * Projects document-family membership into canonical governing references.
 *
 * The relationship label is carried verbatim from the precedence snapshot's
 * family key; canonical code does not reinterpret it. Ordering is deterministic.
 */
function assembleGoverningDocuments(
  governingDocumentIds: Readonly<Record<string, readonly string[]>> | undefined,
): readonly CanonicalGoverningDocumentReference[] {
  if (governingDocumentIds == null) return [];
  const references: CanonicalGoverningDocumentReference[] = [];
  for (const family of Object.keys(governingDocumentIds).sort((l, r) => l.localeCompare(r, 'en-US'))) {
    for (const documentId of [...(governingDocumentIds[family] ?? [])].sort((l, r) => l.localeCompare(r, 'en-US'))) {
      references.push({
        documentId,
        family,
        relationship: 'governs',
        effectiveAt: null,
        evidence: [],
      });
    }
  }
  return references;
}

function assembleAuthoritativeRegistry(
  input: ProjectTruthAuthorityInput,
  contractPricing: readonly CanonicalContractPricingSchedule[],
  transactionAssembly: CanonicalTransactionAssembly,
  invoiceAssembly: CanonicalInvoiceAssembly,
) {
  return buildCanonicalProjectTruth({
    projectId: input.projectId,
    governingDocuments: assembleGoverningDocuments(input.governingDocumentIds),
    contractTermReferences: [],
    contractPricing,
    invoices: invoiceAssembly.invoices,
    invoiceLines: invoiceAssembly.lines,
    transactions: transactionAssembly.transactions,
    derived: {
      // Derived sections are outputs of validation, not inputs to it. They are
      // completed once from the result after rule packs run; assembling them
      // here would be circular.
      pricingMatches: [],
      contractInvoiceReconciliations: [],
      invoiceTransactionReconciliations: [],
      projectReconciliation: null,
      validationImpacts: [],
      exposureReadinessReferences: [],
    },
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    mode: 'authoritative',
  });
}

/**
 * Hashes pricing observations in a content-derived order without changing the
 * authoritative registry's retained row order or validator projection.
 *
 * Pricing ordinals intentionally describe the assembled input order. They are
 * therefore replaced only in this digest view after rows are sorted by their
 * complete canonical content with the ordinal neutralized. Equal observations
 * remain equal, while any other content change still changes the digest.
 */
function hashAuthoritativeRegistry(
  registry: ReturnType<typeof assembleAuthoritativeRegistry>,
): string {
  const contractPricing = registry.contractPricing.map((schedule) => ({
    ...schedule,
    rows: schedule.rows
      .map((row) => ({
        row,
        sortKey: canonicalJson({ ...row, ordinal: 0 }),
      }))
      .sort((left, right) => left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0)
      .map(({ row }, ordinal) => ({ ...row, ordinal })),
  }));

  return hashCanonicalJson({ ...registry, contractPricing });
}

/**
 * Computes per-domain coverage for one canonical execution.
 *
 * Every branch answers one question honestly: did canonical truth actually
 * govern this domain? A domain with no source is `not_applicable`; a domain
 * whose canonical truth could not be established is `blocked` with a reason.
 * There is no state that means "canonical ran but legacy filled in", because
 * that combination is exactly what the cutover exists to eliminate.
 */
function computeDomainCoverage(input: {
  readonly rateScheduleItemCount: number;
  readonly invoiceAssembly: CanonicalInvoiceAssembly;
  readonly transactionAssembly: CanonicalTransactionAssembly;
  readonly relationshipAssembly: CanonicalRelationshipAssembly;
  readonly invoiceRowCount: number;
  readonly invoiceLineRowCount: number;
  readonly transactionRowCount: number;
}): CanonicalAuthorityCoverage {
  const relationshipBlocked = new Set(input.relationshipAssembly.blockedDomains);
  const relationshipGaps = [
    ...input.relationshipAssembly.unresolvedRequired,
    ...input.relationshipAssembly.conflicting,
  ];

  const pricing: CanonicalDomainCoverageEntry = relationshipBlocked.has('pricing')
    ? blockedDomain(
      'unresolved_governing_pricing_relationship',
      relationshipGaps.filter((entry) => entry.affectedDomain === 'pricing').flatMap((entry) => entry.candidateIds),
    )
    : authoritativeDomain();

  const unresolvedInvoiceIdentities = input.invoiceAssembly.invoiceIdentities.filter(
    (identity) => identity.identityConfidence === 'unresolved',
  );
  const unreadableInvoiceIdentities = input.invoiceAssembly.invoiceIdentities.filter(
    (identity) => identity.sourceIdentityStatus === 'unreadable',
  );
  const invoices: CanonicalDomainCoverageEntry = input.invoiceRowCount === 0
    ? notApplicableDomain('project_has_no_invoice_source')
    : input.invoiceAssembly.identityConflicts.length > 0
      ? blockedDomain(
        'duplicate_invoice_number_across_source_documents',
        input.invoiceAssembly.identityConflicts.flatMap((conflict) => conflict.sourceDocumentIds),
      )
      : unreadableInvoiceIdentities.length > 0
        ? blockedDomain(
          'invoice_source_identity_store_unreadable',
          unreadableInvoiceIdentities.map((identity) => identity.sourceDocumentId ?? 'unknown-document'),
        )
        : unresolvedInvoiceIdentities.length > 0
        ? blockedDomain(
          'unresolved_invoice_identity',
          unresolvedInvoiceIdentities.map((identity) => identity.sourceDocumentId ?? 'unknown-document'),
        )
        : relationshipBlocked.has('invoices')
          ? blockedDomain(
            'unresolved_governing_invoice_relationship',
            relationshipGaps.filter((entry) => entry.affectedDomain === 'invoices').flatMap((entry) => entry.candidateIds),
          )
          : authoritativeDomain();

  const invoiceLines: CanonicalDomainCoverageEntry = input.invoiceLineRowCount === 0
    ? notApplicableDomain('project_has_no_invoice_line_source')
    : input.invoiceAssembly.orphanedLineCount > 0
      ? blockedDomain('invoice_lines_without_resolvable_invoice')
      : relationshipBlocked.has('invoiceLines')
        ? blockedDomain('unresolved_invoice_line_relationship')
        : authoritativeDomain();

  const transactions: CanonicalDomainCoverageEntry = input.transactionRowCount === 0
    ? notApplicableDomain('project_has_no_transaction_source')
    : input.transactionAssembly.grainConflicts.length > 0
      ? blockedDomain(
        'ticket_grain_conflict',
        input.transactionAssembly.grainConflicts.map((conflict) => conflict.identity),
      )
      : relationshipBlocked.has('transactions')
        ? blockedDomain('unresolved_governing_transaction_relationship')
        : authoritativeDomain();

  const relationships: CanonicalDomainCoverageEntry = relationshipGaps.length > 0
    ? blockedDomain(
      input.relationshipAssembly.conflicting.length > 0
        ? 'conflicting_governing_relationship'
        : 'unresolved_required_relationship',
      relationshipGaps.map((entry) => entry.relationshipId),
    )
    : authoritativeDomain();

  // Provenance is authoritative only when every canonical record can name the
  // source document it came from. Geometry is not required; attributability is.
  const unattributed = [
    ...input.invoiceAssembly.invoiceIdentities.filter((identity) => identity.provenance.sourceDocumentId == null)
      .map((identity) => identity.canonicalInvoiceId),
    ...input.invoiceAssembly.lineIdentities.filter((identity) => identity.provenance.sourceDocumentId == null)
      .map((identity) => identity.canonicalLineId),
    ...input.transactionAssembly.transactions.filter((transaction) => transaction.sourceDocumentId == null)
      .map((transaction) => transaction.transactionId),
  ];
  const provenance: CanonicalDomainCoverageEntry = unattributed.length > 0
    ? blockedDomain('canonical_record_without_source_document', unattributed.slice(0, 25))
    : input.rateScheduleItemCount === 0
      ? notApplicableDomain('no_canonical_records_to_attribute')
      : authoritativeDomain();

  return { pricing, invoices, invoiceLines, transactions, relationships, provenance };
}

export function resolveProjectTruthAuthority(
  input: ProjectTruthAuthorityInput,
): CanonicalProjectTruthExecutionContext {
  const mode: ProjectTruthAuthorityMode = readProjectTruthAuthorityMode(input.env ?? process.env);

  if (!isCanonicalProjectTruthAuthority(mode)) {
    return legacyExecutionContext({
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
    });
  }

  let contractPricing: readonly CanonicalContractPricingSchedule[];
  try {
    contractPricing = assembleCanonicalPricing(input);
  } catch (error) {
    // An assembly fault is `failed`, not `blocked`: it is an infrastructure
    // problem, not a source gap. Legacy pricing is not substituted either way.
    return freezeExecutionContext({
      authorityMode: mode,
      assemblyStatus: 'failed',
      registry: null,
      registryDigest: null,
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
      validatorProjection: null,
      diagnosticProjection: { integritySignals: [] },
      blockReason: 'assembly_failed',
      block: {
        reason: 'assembly_failed',
        detail: error instanceof Error ? error.message : 'Canonical pricing assembly failed',
        sourceGaps: input.pricingContext?.documentId ? [input.pricingContext.documentId] : [],
      },
    });
  }

  // Transactions are assembled in the same single pass. A grain conflict is
  // recorded as a diagnostic, not resolved: canonical authority never picks a
  // winner between conflicting source observations of one physical ticket.
  const transactionAssembly = assembleCanonicalTransactions({
    rows: input.transactionRows ?? [],
  });

  // Invoices and invoice lines join the same single pass, adapted from the
  // effective rows already loaded. One adaptation pass each; nothing re-reads.
  const invoiceAssembly = assembleCanonicalInvoices({
    projectId: input.projectId,
    invoiceRows: input.invoiceRows ?? [],
    invoiceLineRows: input.invoiceLineRows ?? [],
    sourceArtifactIdByDocumentId: input.sourceArtifactIdByDocumentId,
    sourceIdentityStoreState: input.sourceIdentityStoreState,
    sourceIdentityReadError: input.sourceIdentityReadError,
    documentFamilyByDocumentId: input.documentFamilyByDocumentId,
  });

  const registry = assembleAuthoritativeRegistry(
    input,
    contractPricing,
    transactionAssembly,
    invoiceAssembly,
  );
  const registryDigest = hashAuthoritativeRegistry(registry);
  const rateScheduleItems = projectCanonicalRateScheduleItems(contractPricing);
  const invoiceDiagnosticProjection = {
    integritySignals: projectCanonicalIntegritySignals({
      invoiceIdentities: invoiceAssembly.invoiceIdentities,
      invoiceIdentityConflicts: invoiceAssembly.identityConflicts,
      invoiceLineIdentities: invoiceAssembly.lineIdentities,
      invoiceLineIdentityIssues: invoiceAssembly.lineIdentityIssues,
      relationships: [],
    }),
  };

  // Unresolved duplicate pricing authority blocks GOVERNING SELECTION, not
  // observation. The registry and its digest are retained exactly as every other
  // source-gap block does, so both documents' adapted rows, their evidence, and
  // their candidates stay inspectable; only `validatorProjection` — the
  // authoritative projection — is withheld. Nulling the registry here would
  // equate "authority is unresolved" with "the observations never existed",
  // which is a different and false claim.
  //
  // No row is selected, dropped, or collapsed on this path: the block is
  // decided AFTER adaptation precisely because adaptation makes no authority
  // choice, and it is decided BEFORE any projection because that is where a
  // choice would otherwise be forced.
  const duplicateAuthority = [...(input.contractPricingDuplicateAuthority ?? [])]
    .sort((left, right) => left.findingId.localeCompare(right.findingId, 'en-US'));
  if (duplicateAuthority.length > 0) {
    return freezeExecutionContext({
      authorityMode: mode,
      assemblyStatus: 'blocked',
      registry,
      registryDigest,
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
      validatorProjection: null,
      diagnosticProjection: invoiceDiagnosticProjection,
      blockReason: 'duplicate_authority',
      block: {
        reason: 'duplicate_authority',
        detail: duplicateAuthority.map((finding) => finding.detail).join(' '),
        sourceGaps: duplicateAuthority.flatMap((finding) => [...finding.documentIds]),
        duplicateAuthority: duplicateAuthority.map((finding) => Object.freeze({
          diagnosticId: finding.findingId,
          documentIds: finding.documentIds,
          relationshipBasis: finding.relationshipBasis,
          rowIdentities: finding.rowIdentities,
          sourceIdentityStatus: finding.sourceIdentityStatus,
          sourceIdentityByDocumentId: finding.sourceIdentityByDocumentId,
          sourceIdentityReadError: finding.sourceIdentityReadError,
          missingDiscriminator: finding.missingDiscriminator,
          detail: finding.detail,
        })),
      },
    });
  }

  // Governing pricing is required truth. When the assembly yields nothing
  // projectable, canonical mode reports the gap instead of rescuing from legacy
  // items, which would silently mix authorities inside one run.
  if (rateScheduleItems.length === 0) {
    return freezeExecutionContext({
      authorityMode: mode,
      assemblyStatus: 'blocked',
      registry,
      registryDigest,
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
      validatorProjection: null,
      diagnosticProjection: invoiceDiagnosticProjection,
      blockReason: 'missing_governing_pricing',
      block: {
        reason: 'missing_governing_pricing',
        detail:
          input.assembledContractPricingRows.length === 0
            ? 'No assembled contract pricing rows were available to canonical authority'
            : 'Canonical resolution produced no value-bearing governing pricing rows',
        sourceGaps: input.pricingContext?.documentId ? [input.pricingContext.documentId] : [],
      },
    });
  }

  // Relationships are assembled last because they consume the canonical
  // identities the earlier passes produced. Still one pass, still no re-read.
  const relationshipAssembly = assembleCanonicalRelationships({
    projectId: input.projectId,
    invoiceIdentities: invoiceAssembly.invoiceIdentities,
    invoiceLineIdentities: invoiceAssembly.lineIdentities,
    orphanedInvoiceLineCount: invoiceAssembly.orphanedLineCount,
    transactions: transactionAssembly.transactions,
    contractPricing,
    projectedRateRows: rateScheduleItems,
    governingDocumentIds: input.governingDocumentIds,
    familyDocumentIds: input.familyDocumentIds,
    documentRelationships: input.documentRelationships,
    sourceArtifactIdByDocumentId: input.sourceArtifactIdByDocumentId,
    sourceIdentityStoreState: input.sourceIdentityStoreState,
    operatorAssertions: input.operatorRelationshipAssertions,
  });

  const coverage = computeDomainCoverage({
    rateScheduleItemCount: rateScheduleItems.length,
    invoiceAssembly,
    transactionAssembly,
    relationshipAssembly,
    invoiceRowCount: input.invoiceRows?.length ?? 0,
    invoiceLineRowCount: input.invoiceLineRows?.length ?? 0,
    transactionRowCount: input.transactionRows?.length ?? 0,
  });

  const diagnosticProjection = {
    integritySignals: projectCanonicalIntegritySignals({
      invoiceIdentities: invoiceAssembly.invoiceIdentities,
      invoiceIdentityConflicts: invoiceAssembly.identityConflicts,
      invoiceLineIdentities: invoiceAssembly.lineIdentities,
      invoiceLineIdentityIssues: invoiceAssembly.lineIdentityIssues,
      relationships: relationshipAssembly.relationships,
    }),
  };

  const validatorProjection = {
    rateScheduleItems,
    transactions: {
      rows: transactionAssembly.transactions,
      distinctIdentityCount: transactionAssembly.distinctIdentityCount,
      grainConflicts: transactionAssembly.grainConflicts,
    },
    invoices: {
      rows: invoiceAssembly.invoices,
      identities: invoiceAssembly.invoiceIdentities,
      distinctIdentityCount: invoiceAssembly.distinctInvoiceIdentityCount,
      identityConflicts: invoiceAssembly.identityConflicts,
      unresolvedIdentityCount: invoiceAssembly.invoiceIdentities.filter(
        (identity) => identity.identityConfidence === 'unresolved',
      ).length,
    },
    invoiceLines: {
      rows: invoiceAssembly.lines,
      identities: invoiceAssembly.lineIdentities,
      identityIssues: invoiceAssembly.lineIdentityIssues,
      unresolvedIdentityCount: invoiceAssembly.lineIdentities.filter(
        (identity) => identity.identityConfidence === 'unresolved',
      ).length,
      orphanedCount: invoiceAssembly.orphanedLineCount,
    },
    relationships: {
      all: relationshipAssembly.relationships,
      unresolvedRequired: relationshipAssembly.unresolvedRequired,
      conflicting: relationshipAssembly.conflicting,
      blockedDomains: relationshipAssembly.blockedDomains,
    },
    coverage,
  };

  // The canonical success rule. A run may not claim complete authority while a
  // required domain is blocked, so it reports `blocked` with the per-domain
  // reasons instead. The projection is deliberately RETAINED on this path: it
  // is the evidence of the block, and dropping it would leave an operator with
  // a bare status and no way to see which domain failed or why. It is still not
  // authoritative — `isCanonicalAuthorityEstablished` requires `assembled`.
  if (!hasCompleteCanonicalAuthority(coverage)) {
    const blocked = Object.entries(coverage)
      .filter(([, entry]) => entry.state === 'blocked');
    return freezeExecutionContext({
      authorityMode: mode,
      assemblyStatus: 'blocked',
      registry,
      registryDigest,
      sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
      validatorProjection,
      diagnosticProjection,
      blockReason: 'incomplete_domain_authority',
      block: {
        reason: 'incomplete_domain_authority',
        detail: `Canonical authority is incomplete for ${String(blocked.length)} required truth domain(s): `
          + blocked.map(([domain, entry]) => `${domain} (${entry.reason ?? 'unspecified'})`).join('; '),
        sourceGaps: [...new Set(blocked.flatMap(([, entry]) => entry.sourceGaps))]
          .sort((left, right) => left.localeCompare(right, 'en-US')),
      },
    });
  }

  return freezeExecutionContext({
    authorityMode: mode,
    assemblyStatus: 'assembled',
    registry,
    registryDigest,
    sourceArtifactSnapshotDigest: input.sourceArtifactSnapshotDigest,
    validatorProjection,
    diagnosticProjection,
    blockReason: null,
    block: null,
  });
}
