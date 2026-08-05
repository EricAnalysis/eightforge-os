/**
 * Canonical contract, invoice, and governing-document relationships.
 *
 * Relationships are assembled from truth this execution already loaded: the
 * precedence snapshot's family and governing maps, the canonical invoice and
 * transaction assemblies, and the canonical pricing schedules. Nothing here
 * re-reads a document or re-derives precedence — `lib/documentPrecedence.ts`
 * remains the sole producer of precedence, and this module projects its result.
 *
 * Two rules drive every design choice below:
 *
 *  1. An unresolved relationship never becomes a confident one. Where a
 *     governing document cannot be determined, the relationship stays
 *     `unresolved`; where two candidates compete, it stays `conflicting`. In
 *     neither case is a winner chosen, and legacy resolution cannot overwrite
 *     either state — canonical mode has no fallback.
 *
 *  2. Relationship grain is bounded. A per-row relationship for every
 *     transaction and invoice line would put tens of thousands of records into
 *     the frozen registry and its digest for no additional truth. Row-level
 *     links are therefore asserted at their identity class — per invoice, per
 *     billing rate key, per document — which is where the linkage decision
 *     actually lives. Row-level identity itself is already carried by the
 *     invoice, line, and transaction assemblies.
 */

import type { CanonicalContractPricingSchedule } from '@/lib/canonical/contract/pricing';
import type { CanonicalTransaction } from '@/lib/canonical/transaction/transaction';
import { canonicalEvidenceRef } from '@/lib/canonical/truth/envelope';
import type { CanonicalEvidenceRef } from '@/lib/canonical/truth/envelope';

import type { CanonicalTruthDomain } from './canonicalDomainCoverage';
import type {
  CanonicalInvoiceIdentity,
  CanonicalInvoiceLineIdentity,
} from './canonicalInvoiceAuthority';
import {
  buildCanonicalProvenance,
  type CanonicalProvenance,
} from './canonicalProvenance';

export const CANONICAL_RELATIONSHIP_ADAPTER_ID = 'canonical_relationship_authority';

export type CanonicalRelationshipKind =
  | 'invoice_belongs_to_project'
  | 'invoice_belongs_to_contract_family'
  | 'invoice_references_governing_contract'
  | 'invoice_line_belongs_to_invoice'
  | 'transaction_belongs_to_invoice_line'
  | 'pricing_exhibit_belongs_to_contract_family'
  | 'pricing_exhibit_governs_rate_truth'
  | 'transaction_references_governing_pricing_row'
  | 'source_artifact_belongs_to_document_family'
  | 'document_precedence';

/**
 * Relationship state.
 *
 * `observed`         — the source states the relationship directly.
 * `derived`          — deterministically computed from other canonical truth
 *                      (most often the precedence snapshot).
 * `operator_asserted`— a human decided it. Outranks `derived`, and is the only
 *                      legitimate way a `conflicting` relationship is settled.
 * `unresolved`       — no candidate could be established. Honest terminal state.
 * `conflicting`      — two or more candidates compete. Never silently resolved.
 */
export type CanonicalRelationshipState =
  | 'observed'
  | 'derived'
  | 'operator_asserted'
  | 'unresolved'
  | 'conflicting';

export type CanonicalRelationshipBasis =
  | 'source_observation'
  | 'document_precedence'
  | 'operator_assertion'
  | 'canonical_assembly'
  | 'none';

export type CanonicalRelationshipEndpointKind =
  | 'project'
  | 'invoice'
  | 'invoice_line'
  | 'transaction'
  | 'contract_family'
  | 'document'
  | 'pricing_row'
  | 'billing_rate_key'
  | 'source_artifact';

export type CanonicalRelationshipEndpoint = {
  readonly kind: CanonicalRelationshipEndpointKind;
  readonly id: string;
};

export type CanonicalRelationship = {
  /** Deterministic: kind + from + to. Stable across runs and input orderings. */
  readonly relationshipId: string;
  readonly kind: CanonicalRelationshipKind;
  readonly state: CanonicalRelationshipState;
  readonly from: CanonicalRelationshipEndpoint;
  /** Null when the relationship is unresolved or conflicting. */
  readonly to: CanonicalRelationshipEndpoint | null;
  /** Every competing candidate, preserved verbatim. Sorted, never truncated. */
  readonly candidateIds: readonly string[];
  readonly basis: CanonicalRelationshipBasis;
  /** The truth domain a required unresolved/conflicting state blocks. */
  readonly affectedDomain: CanonicalTruthDomain;
  readonly required: boolean;
  readonly provenance: CanonicalProvenance;
  readonly detail: string;
};

/** A human decision about a relationship, supplied by the caller. */
export type CanonicalOperatorRelationshipAssertion = {
  readonly assertionId: string;
  readonly kind: CanonicalRelationshipKind;
  readonly fromId: string;
  readonly toId: string;
  readonly actorId?: string | null;
};

export type CanonicalRelationshipAssembly = {
  readonly relationships: readonly CanonicalRelationship[];
  /** Required relationships that could not be established. */
  readonly unresolvedRequired: readonly CanonicalRelationship[];
  /** Relationships with competing candidates, required or not. */
  readonly conflicting: readonly CanonicalRelationship[];
  /** Domains blocked by a required unresolved or conflicting relationship. */
  readonly blockedDomains: readonly CanonicalTruthDomain[];
};

export type CanonicalRelationshipAssemblyInput = {
  readonly projectId: string;
  readonly invoiceIdentities: readonly CanonicalInvoiceIdentity[];
  readonly invoiceLineIdentities: readonly CanonicalInvoiceLineIdentity[];
  readonly orphanedInvoiceLineCount: number;
  readonly transactions: readonly CanonicalTransaction[];
  readonly contractPricing: readonly CanonicalContractPricingSchedule[];
  /**
   * The already-projected canonical rate rows. Billing keys are READ from the
   * single projection rather than re-derived here, so relationship linkage
   * cannot drift from the keys the rule packs actually match on.
   */
  readonly projectedRateRows?: readonly {
    readonly record_id: string | null;
    readonly billing_rate_key?: string | null;
  }[];
  /** Governing document ids per family, from the precedence snapshot. */
  readonly governingDocumentIds?: Readonly<Record<string, readonly string[]>>;
  /** All family members per family, from the precedence snapshot. */
  readonly familyDocumentIds?: Readonly<Record<string, readonly string[]>>;
  /** Precedence relationship records, projected verbatim. */
  readonly documentRelationships?: readonly {
    readonly source_document_id: string;
    readonly target_document_id: string;
    readonly relationship_type: string;
  }[];
  readonly sourceArtifactIdByDocumentId?: ReadonlyMap<string, string | null>;
  readonly operatorAssertions?: readonly CanonicalOperatorRelationshipAssertion[];
};

function compare(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}

function stablePart(value: unknown): string {
  return String(value ?? 'null')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'null';
}

function relationshipId(
  kind: CanonicalRelationshipKind,
  from: CanonicalRelationshipEndpoint,
  to: CanonicalRelationshipEndpoint | null,
): string {
  // Identity is kind + endpoints only. It never includes state, so a
  // relationship that later resolves keeps the same identity rather than
  // appearing as a new one.
  return [
    'canonical-relationship',
    kind,
    `${from.kind}:${stablePart(from.id)}`,
    to == null ? 'unresolved' : `${to.kind}:${stablePart(to.id)}`,
  ].join(':');
}

const CONTRACT_FAMILY = 'contract';
const PRICING_FAMILIES: readonly string[] = ['rate_sheet', 'contract'];

function familyDocuments(
  map: Readonly<Record<string, readonly string[]>> | undefined,
  family: string,
): readonly string[] {
  return [...new Set(map?.[family] ?? [])].sort(compare);
}

/**
 * Resolves a single governing target from candidates.
 *
 * Zero candidates is `unresolved`, two or more is `conflicting`. Neither picks
 * a winner, and both preserve the full candidate list so a downstream finding
 * can cite every competing source.
 */
function resolveSingleTarget(input: {
  readonly candidates: readonly string[];
  readonly endpointKind: CanonicalRelationshipEndpointKind;
  readonly derivedState: CanonicalRelationshipState;
  readonly basis: CanonicalRelationshipBasis;
}): {
  readonly to: CanonicalRelationshipEndpoint | null;
  readonly state: CanonicalRelationshipState;
  readonly basis: CanonicalRelationshipBasis;
} {
  if (input.candidates.length === 1) {
    return {
      to: { kind: input.endpointKind, id: input.candidates[0] },
      state: input.derivedState,
      basis: input.basis,
    };
  }
  return {
    to: null,
    state: input.candidates.length === 0 ? 'unresolved' : 'conflicting',
    basis: input.candidates.length === 0 ? 'none' : input.basis,
  };
}

function documentEvidence(documentIds: readonly string[]): readonly CanonicalEvidenceRef[] {
  return documentIds.map((documentId) => canonicalEvidenceRef({ documentId }));
}

/**
 * Applies an operator assertion over a derived or unresolved relationship.
 *
 * A human decision outranks a derived one and is the only legitimate way a
 * conflict is settled. The competing candidates are retained on the record so
 * the assertion stays auditable rather than erasing what it overrode.
 */
function applyOperatorAssertion(
  relationship: CanonicalRelationship,
  assertions: readonly CanonicalOperatorRelationshipAssertion[],
): CanonicalRelationship {
  const assertion = assertions.find(
    (entry) => entry.kind === relationship.kind && entry.fromId === relationship.from.id,
  );
  if (assertion == null) return relationship;

  const to: CanonicalRelationshipEndpoint = {
    kind: relationship.to?.kind ?? endpointKindForAssertedTarget(relationship.kind),
    id: assertion.toId,
  };
  return {
    ...relationship,
    relationshipId: relationshipId(relationship.kind, relationship.from, to),
    state: 'operator_asserted',
    to,
    basis: 'operator_assertion',
    provenance: {
      ...relationship.provenance,
      derivation: 'operator_asserted',
      operatorAssertionId: assertion.assertionId,
    },
    detail:
      `Operator assertion ${assertion.assertionId} governs this relationship, overriding the `
      + `${relationship.state} derived state. Competing candidates are retained as evidence.`,
  };
}

function endpointKindForAssertedTarget(
  kind: CanonicalRelationshipKind,
): CanonicalRelationshipEndpointKind {
  switch (kind) {
    case 'invoice_belongs_to_project':
      return 'project';
    case 'invoice_belongs_to_contract_family':
    case 'pricing_exhibit_belongs_to_contract_family':
      return 'contract_family';
    case 'invoice_line_belongs_to_invoice':
      return 'invoice';
    case 'transaction_belongs_to_invoice_line':
      return 'invoice_line';
    case 'transaction_references_governing_pricing_row':
      return 'pricing_row';
    case 'source_artifact_belongs_to_document_family':
      return 'source_artifact';
    default:
      return 'document';
  }
}

function relationship(input: {
  readonly kind: CanonicalRelationshipKind;
  readonly from: CanonicalRelationshipEndpoint;
  readonly to: CanonicalRelationshipEndpoint | null;
  readonly state: CanonicalRelationshipState;
  readonly candidateIds: readonly string[];
  readonly basis: CanonicalRelationshipBasis;
  readonly affectedDomain: CanonicalTruthDomain;
  readonly required: boolean;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly sourceDocumentId?: string | null;
  readonly sourceArtifactId?: string | null;
  readonly sourceFamily?: string | null;
  readonly detail: string;
}): CanonicalRelationship {
  return {
    relationshipId: relationshipId(input.kind, input.from, input.to),
    kind: input.kind,
    state: input.state,
    from: input.from,
    to: input.to,
    candidateIds: [...input.candidateIds].sort(compare),
    basis: input.basis,
    affectedDomain: input.affectedDomain,
    required: input.required,
    provenance: buildCanonicalProvenance({
      adapterId: CANONICAL_RELATIONSHIP_ADAPTER_ID,
      derivation:
        input.state === 'observed'
          ? 'observed'
          : input.state === 'operator_asserted'
            ? 'operator_asserted'
            : input.state === 'derived'
              ? 'derived'
              : 'unresolved',
      evidence: input.evidence,
      sourceDocumentId: input.sourceDocumentId ?? null,
      sourceArtifactId: input.sourceArtifactId ?? null,
      sourceFamily: input.sourceFamily ?? null,
    }),
    detail: input.detail,
  };
}

/**
 * Assembles canonical relationships for one execution.
 *
 * Deterministic: every input list is consumed in sorted identity order and the
 * output is sorted by relationship id, so the registry digest is stable.
 */
export function assembleCanonicalRelationships(
  input: CanonicalRelationshipAssemblyInput,
): CanonicalRelationshipAssembly {
  const assertions = input.operatorAssertions ?? [];
  const governingContracts = familyDocuments(input.governingDocumentIds, CONTRACT_FAMILY);
  const contractFamilyMembers = familyDocuments(input.familyDocumentIds, CONTRACT_FAMILY);
  const governingPricingDocuments = [...new Set(
    PRICING_FAMILIES.flatMap((family) => familyDocuments(input.governingDocumentIds, family)),
  )].sort(compare);

  const relationships: CanonicalRelationship[] = [];

  // ── Invoice relationships ────────────────────────────────────────────────
  for (const identity of [...input.invoiceIdentities].sort((l, r) =>
    compare(l.canonicalInvoiceId, r.canonicalInvoiceId))) {
    const from: CanonicalRelationshipEndpoint = { kind: 'invoice', id: identity.canonicalInvoiceId };
    const invoiceEvidence = identity.provenance.evidence;

    relationships.push(relationship({
      kind: 'invoice_belongs_to_project',
      from,
      to: { kind: 'project', id: identity.projectId },
      state: 'observed',
      candidateIds: [identity.projectId],
      basis: 'source_observation',
      affectedDomain: 'invoices',
      required: true,
      evidence: invoiceEvidence,
      sourceDocumentId: identity.sourceDocumentId,
      sourceArtifactId: identity.sourceArtifactId,
      sourceFamily: identity.documentFamily,
      detail: `Invoice ${identity.canonicalInvoiceId} is scoped to project ${identity.projectId} by its source document.`,
    }));

    const familyResolution = resolveSingleTarget({
      candidates: contractFamilyMembers.length > 0 ? [CONTRACT_FAMILY] : [],
      endpointKind: 'contract_family',
      derivedState: 'derived',
      basis: 'document_precedence',
    });
    relationships.push(applyOperatorAssertion(relationship({
      kind: 'invoice_belongs_to_contract_family',
      from,
      to: familyResolution.to,
      state: familyResolution.state,
      candidateIds: contractFamilyMembers,
      basis: familyResolution.basis,
      affectedDomain: 'invoices',
      // Not required: family membership is taxonomy. The substantive
      // requirement is `invoice_references_governing_contract` below, which
      // names the document invoice truth is actually validated against.
      required: false,
      evidence: documentEvidence(contractFamilyMembers),
      sourceDocumentId: identity.sourceDocumentId,
      sourceArtifactId: identity.sourceArtifactId,
      sourceFamily: identity.documentFamily,
      detail: contractFamilyMembers.length > 0
        ? `Invoice ${identity.canonicalInvoiceId} belongs to the contract family established by the precedence snapshot.`
        : `No contract-family document exists for project ${identity.projectId}, so the invoice's contract family is unresolved.`,
    }), assertions));

    const governingResolution = resolveSingleTarget({
      candidates: governingContracts,
      endpointKind: 'document',
      derivedState: 'derived',
      basis: 'document_precedence',
    });
    relationships.push(applyOperatorAssertion(relationship({
      kind: 'invoice_references_governing_contract',
      from,
      to: governingResolution.to,
      state: governingResolution.state,
      candidateIds: governingContracts,
      basis: governingResolution.basis,
      affectedDomain: 'invoices',
      required: true,
      evidence: documentEvidence(governingContracts),
      sourceDocumentId: identity.sourceDocumentId,
      sourceArtifactId: identity.sourceArtifactId,
      sourceFamily: identity.documentFamily,
      detail: governingContracts.length === 1
        ? `Invoice ${identity.canonicalInvoiceId} is governed by contract ${governingContracts[0]}.`
        : governingContracts.length === 0
          ? `No governing contract was established for project ${identity.projectId}; canonical authority leaves the relationship unresolved rather than selecting a document.`
          : `${String(governingContracts.length)} governing contract candidates compete for invoice ${identity.canonicalInvoiceId}. Canonical authority does not choose one; both candidates are preserved.`,
    }), assertions));

    // Line-to-invoice linkage is asserted per invoice, not per line: the
    // linkage decision is per invoice, and per-line records would add tens of
    // thousands of registry entries without adding truth.
    const ownLines = input.invoiceLineIdentities.filter(
      (line) => line.canonicalInvoiceId === identity.canonicalInvoiceId,
    );
    relationships.push(relationship({
      kind: 'invoice_line_belongs_to_invoice',
      from: { kind: 'invoice', id: identity.canonicalInvoiceId },
      to: ownLines.length > 0 ? { kind: 'invoice', id: identity.canonicalInvoiceId } : null,
      state: ownLines.length > 0 ? 'observed' : 'unresolved',
      candidateIds: ownLines.map((line) => line.canonicalLineId),
      basis: ownLines.length > 0 ? 'canonical_assembly' : 'none',
      affectedDomain: 'invoiceLines',
      // Not required: an invoice legitimately carries no line detail in some
      // source families, and blocking those projects would be false precision.
      required: false,
      evidence: invoiceEvidence,
      sourceDocumentId: identity.sourceDocumentId,
      sourceArtifactId: identity.sourceArtifactId,
      sourceFamily: identity.documentFamily,
      detail: `${String(ownLines.length)} canonical invoice line(s) resolve to invoice ${identity.canonicalInvoiceId}.`,
    }));
  }

  // Orphaned lines are a real relationship gap: a line that could not be
  // attached to any invoice is reported, never adopted by an arbitrary parent.
  if (input.orphanedInvoiceLineCount > 0) {
    relationships.push(relationship({
      kind: 'invoice_line_belongs_to_invoice',
      from: { kind: 'invoice_line', id: `orphaned:${input.projectId}` },
      to: null,
      state: 'unresolved',
      candidateIds: [],
      basis: 'none',
      affectedDomain: 'invoiceLines',
      required: true,
      evidence: [],
      detail:
        `${String(input.orphanedInvoiceLineCount)} invoice line(s) could not be attached to a canonical invoice. `
        + 'Canonical authority left them unattached rather than assigning an arbitrary parent.',
    }));
  }

  // ── Pricing relationships ────────────────────────────────────────────────
  const pricingResolution = resolveSingleTarget({
    candidates: governingPricingDocuments,
    endpointKind: 'document',
    derivedState: 'derived',
    basis: 'document_precedence',
  });
  relationships.push(applyOperatorAssertion(relationship({
    kind: 'pricing_exhibit_belongs_to_contract_family',
    from: { kind: 'project', id: input.projectId },
    to: pricingResolution.to,
    state: pricingResolution.state,
    candidateIds: governingPricingDocuments,
    basis: pricingResolution.basis,
    affectedDomain: 'pricing',
    // Not required, for the same reason as invoice family membership: the
    // governing requirement is `pricing_exhibit_governs_rate_truth`, which is
    // established by the canonical pricing rows themselves.
    required: false,
    evidence: documentEvidence(governingPricingDocuments),
    detail: governingPricingDocuments.length === 1
      ? `Pricing exhibit ${governingPricingDocuments[0]} belongs to the project's contract family.`
      : governingPricingDocuments.length === 0
        ? 'No governing pricing document was established by the precedence snapshot.'
        : `${String(governingPricingDocuments.length)} pricing exhibit candidates compete; canonical authority preserves both rather than selecting one.`,
  }), assertions));

  const pricingSourceDocuments = [...new Set(
    input.contractPricing.flatMap((schedule) => schedule.rows.map(
      (row) => row.governingDocument?.documentId ?? schedule.governingDocument?.documentId ?? null,
    )).filter((value): value is string => value != null),
  )].sort(compare);
  const rateTruthResolution = resolveSingleTarget({
    candidates: pricingSourceDocuments,
    endpointKind: 'document',
    derivedState: 'observed',
    basis: 'source_observation',
  });
  relationships.push(applyOperatorAssertion(relationship({
    kind: 'pricing_exhibit_governs_rate_truth',
    from: { kind: 'project', id: input.projectId },
    to: rateTruthResolution.to,
    state: rateTruthResolution.state,
    candidateIds: pricingSourceDocuments,
    basis: rateTruthResolution.basis,
    affectedDomain: 'pricing',
    required: true,
    evidence: documentEvidence(pricingSourceDocuments),
    detail: pricingSourceDocuments.length === 1
      ? `Rate truth is governed by ${pricingSourceDocuments[0]}, carried on every canonical pricing row.`
      : pricingSourceDocuments.length === 0
        ? 'No canonical pricing row carries a governing document, so rate truth has no established source.'
        : `Canonical pricing rows cite ${String(pricingSourceDocuments.length)} different governing documents; rate truth is conflicting.`,
  }), assertions));

  // ── Transaction relationships ────────────────────────────────────────────
  relationships.push(...assembleTransactionRelationships(input, assertions));

  // ── Document-family and precedence relationships ─────────────────────────
  relationships.push(...assembleDocumentRelationships(input));

  const ordered = relationships.sort((left, right) =>
    compare(left.relationshipId, right.relationshipId));
  const unresolvedRequired = ordered.filter(
    (entry) => entry.required && entry.state === 'unresolved',
  );
  const conflicting = ordered.filter((entry) => entry.state === 'conflicting');
  const blockedDomains = [...new Set([
    ...unresolvedRequired.map((entry) => entry.affectedDomain),
    // A conflicting governing candidate blocks its domain whether or not the
    // relationship was marked required: an unsettled conflict cannot clear.
    ...conflicting.map((entry) => entry.affectedDomain),
  ])].sort(compare) as CanonicalTruthDomain[];

  return { relationships: ordered, unresolvedRequired, conflicting, blockedDomains };
}

/**
 * Transaction linkage, asserted at bounded grain.
 *
 * Invoice linkage is one relationship per canonical invoice number; pricing
 * linkage is one relationship per distinct billing rate key. Both are bounded
 * by identity classes rather than by row count, so a 5,000-row workbook does
 * not put 5,000 records into the registry.
 */
function assembleTransactionRelationships(
  input: CanonicalRelationshipAssemblyInput,
  assertions: readonly CanonicalOperatorRelationshipAssertion[],
): readonly CanonicalRelationship[] {
  const relationships: CanonicalRelationship[] = [];

  const linesByInvoice = new Map<string, CanonicalInvoiceLineIdentity[]>();
  for (const line of input.invoiceLineIdentities) {
    linesByInvoice.set(line.canonicalInvoiceId, [
      ...(linesByInvoice.get(line.canonicalInvoiceId) ?? []),
      line,
    ]);
  }
  const invoicesByNumber = new Map<string, CanonicalInvoiceIdentity[]>();
  for (const identity of input.invoiceIdentities) {
    if (identity.invoiceNumber == null) continue;
    const key = identity.invoiceNumber.trim().toLowerCase();
    invoicesByNumber.set(key, [...(invoicesByNumber.get(key) ?? []), identity]);
  }

  const transactionInvoiceNumbers = [...new Set(
    input.transactions
      .map((transaction) => (
        transaction.invoiceNumber != null && transaction.invoiceNumber.value != null
          ? transaction.invoiceNumber.value.trim().toLowerCase()
          : null
      ))
      .filter((value): value is string => value != null && value.length > 0),
  )].sort(compare);

  for (const invoiceNumber of transactionInvoiceNumbers) {
    const candidates = invoicesByNumber.get(invoiceNumber) ?? [];
    const lineCandidates = candidates.flatMap(
      (identity) => linesByInvoice.get(identity.canonicalInvoiceId) ?? [],
    );
    const resolution = resolveSingleTarget({
      candidates: candidates.map((identity) => identity.canonicalInvoiceId).sort(compare),
      endpointKind: 'invoice_line',
      derivedState: 'derived',
      basis: 'canonical_assembly',
    });
    relationships.push(applyOperatorAssertion(relationship({
      kind: 'transaction_belongs_to_invoice_line',
      from: { kind: 'transaction', id: `invoice-number:${invoiceNumber}` },
      to: resolution.to,
      state: resolution.state,
      candidateIds: candidates.map((identity) => identity.canonicalInvoiceId),
      basis: resolution.basis,
      affectedDomain: 'transactions',
      // Not required: transaction-to-line attribution is a reconciliation
      // concern, and a project can bill at ticket grain without line linkage.
      required: false,
      evidence: candidates.flatMap((identity) => identity.provenance.evidence),
      detail: candidates.length === 1
        ? `Transactions citing invoice number ${invoiceNumber} attribute to invoice ${candidates[0].canonicalInvoiceId} `
          + `(${String(lineCandidates.length)} canonical line(s)).`
        : candidates.length === 0
          ? `Transactions cite invoice number ${invoiceNumber}, which no canonical invoice claims.`
          : `Invoice number ${invoiceNumber} is claimed by ${String(candidates.length)} canonical invoices, so transaction attribution is conflicting.`,
    }), assertions));
  }

  const pricingRowsByKey = new Map<string, string[]>();
  for (const row of input.projectedRateRows ?? []) {
    const key = row.billing_rate_key ?? null;
    if (key == null || key.length === 0 || row.record_id == null) continue;
    pricingRowsByKey.set(key, [...(pricingRowsByKey.get(key) ?? []), row.record_id]);
  }
  const transactionRateKeys = [...new Set(
    input.transactions
      .map((transaction) => transaction.matchingKeys.billingRateKey)
      .filter((value): value is string => value != null && value.length > 0),
  )].sort(compare);

  for (const key of transactionRateKeys) {
    const candidates = [...new Set(pricingRowsByKey.get(key) ?? [])].sort(compare);
    const resolution = resolveSingleTarget({
      candidates,
      endpointKind: 'pricing_row',
      derivedState: 'derived',
      basis: 'canonical_assembly',
    });
    relationships.push(applyOperatorAssertion(relationship({
      kind: 'transaction_references_governing_pricing_row',
      from: { kind: 'billing_rate_key', id: key },
      to: resolution.to,
      state: resolution.state,
      candidateIds: candidates,
      basis: resolution.basis,
      affectedDomain: 'transactions',
      // Not required: an unmatched rate key is exactly what the existing rate
      // rule packs exist to report, and blocking here would pre-empt them.
      required: false,
      evidence: [],
      detail: candidates.length === 1
        ? `Billing rate key ${key} references governing pricing row ${candidates[0]}.`
        : candidates.length === 0
          ? `Billing rate key ${key} matches no canonical pricing row.`
          : `Billing rate key ${key} matches ${String(candidates.length)} canonical pricing rows; the governing row is conflicting.`,
    }), assertions));
  }

  return relationships;
}

function assembleDocumentRelationships(
  input: CanonicalRelationshipAssemblyInput,
): readonly CanonicalRelationship[] {
  const relationships: CanonicalRelationship[] = [];
  const families = Object.keys(input.familyDocumentIds ?? {}).sort(compare);

  for (const family of families) {
    for (const documentId of familyDocuments(input.familyDocumentIds, family)) {
      const artifactId = input.sourceArtifactIdByDocumentId?.get(documentId) ?? null;
      relationships.push(relationship({
        kind: 'source_artifact_belongs_to_document_family',
        from: { kind: 'source_artifact', id: artifactId ?? `document:${documentId}` },
        to: { kind: 'contract_family', id: family },
        // The family label comes from the precedence snapshot, so this is
        // derived truth, not an independent observation.
        state: 'derived',
        candidateIds: [family],
        basis: 'document_precedence',
        affectedDomain: 'provenance',
        required: false,
        evidence: documentEvidence([documentId]),
        sourceDocumentId: documentId,
        sourceArtifactId: artifactId,
        sourceFamily: family,
        detail: artifactId != null
          ? `Source artifact ${artifactId} (document ${documentId}) belongs to the ${family} family.`
          : `Document ${documentId} belongs to the ${family} family; no source artifact id was recorded.`,
      }));
    }
  }

  const precedence = [...(input.documentRelationships ?? [])].sort((left, right) =>
    compare(
      `${left.source_document_id}|${left.target_document_id}|${left.relationship_type}`,
      `${right.source_document_id}|${right.target_document_id}|${right.relationship_type}`,
    ));
  for (const record of precedence) {
    relationships.push(relationship({
      kind: 'document_precedence',
      from: { kind: 'document', id: record.source_document_id },
      to: { kind: 'document', id: record.target_document_id },
      // Precedence records are authored/observed linkage, carried verbatim.
      // Canonical code does not reinterpret `relationship_type`.
      state: 'observed',
      candidateIds: [record.target_document_id],
      basis: 'source_observation',
      affectedDomain: 'relationships',
      required: false,
      evidence: documentEvidence([record.source_document_id, record.target_document_id]),
      sourceDocumentId: record.source_document_id,
      detail: `Document ${record.source_document_id} ${record.relationship_type} ${record.target_document_id}.`,
    }));
  }

  return relationships;
}
