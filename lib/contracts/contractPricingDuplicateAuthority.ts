/**
 * Deterministic detection of unresolved duplicate pricing authority.
 *
 * Two equally eligible pricing-source documents can assert the same physical
 * rate row. When nothing in the precedence data distinguishes them — no
 * supersession, no authority status, no effective date, no governing selection —
 * the assembler has no honest basis for choosing one, merging them, or counting
 * both. It blocks, and says exactly what is missing.
 *
 * What this module deliberately does NOT do:
 *
 *  - it never picks a winner, and never infers authority from upload time,
 *    processing time, extraction richness (geometry refs), document-id order,
 *    iteration order, or what legacy happened to read;
 *  - it never collapses two documents on the strength of row equality, filename,
 *    or an out-of-band hash. Collapse requires immutable source identity
 *    recorded IN the system (`extraction_source_artifacts.source_sha256`) and
 *    remains deferred — see P2 in the C3 design;
 *  - it uses no fuzzy matching. Row equivalence is exact.
 *
 * Everything here is a pure function of its inputs, and every output list is
 * ordered by a stable key so repeated runs are byte-identical.
 */

import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import { contractPricingScopedRowId } from '@/lib/contracts/contractPricingAssembly';
import type { SourceIdentityReadFailure } from '@/lib/sourceIdentityReadFailure';

/** The identity channel that would resolve a duplicate, when it is missing. */
export const CONTRACT_PRICING_SOURCE_IDENTITY_DISCRIMINATOR =
  'extraction_source_artifacts.source_sha256';

/**
 * What the immutable source-identity channel could say about the documents in
 * one duplicate group.
 *
 * `unreadable` is distinct from `absent` on purpose (D1): "the store said
 * nothing exists" and "the store could not be consulted" are different facts,
 * and only the first is evidence about the documents.
 */
export type ContractPricingSourceIdentityStatus =
  | 'absent'
  | 'unreadable'
  | 'partial'
  | 'distinct'
  | 'proven_identical';

/**
 * Precedence reasons that may legitimately resolve a duplicate-authority pair.
 *
 * Deliberately EXCLUDES `upload_recency_fallback`. That reason means the
 * precedence engine found no distinguishing signal and fell back to whichever
 * document was uploaded later — which is precisely the inference the C3 design
 * forbids (§5.2 step 8: "Never infer authority... upload or processing
 * recency"). Treating it as a resolution would let the newer upload win
 * silently, which is the defect this module exists to prevent.
 *
 * Also excluded: an unknown/absent reason. A governing selection whose basis
 * cannot be named is not an approved discriminator.
 */
const APPROVED_GOVERNING_REASONS: ReadonlySet<string> = new Set([
  'operator_override',
  'supersedes_relationship',
  'amends_relationship',
  'effective_date',
  // Role priority is a deterministic rule over document role, not a proxy for
  // recency. Two duplicate uploads share a role, so it cannot separate them
  // anyway; it is approved for the genuinely-different-role case.
  'role_priority',
]);

/** Precedence facts that could legitimately resolve a duplicate pair. */
export type ContractPricingAuthorityDiscriminator = {
  readonly authorityStatus: string | null;
  readonly effectiveDate: string | null;
  /** Documents that supersede/replace/amend this one, per the relationship graph. */
  readonly supersededByDocumentIds?: readonly string[];
  /** True when the precedence family selected this document as governing. */
  readonly isGoverningDocument?: boolean;
  /**
   * Why the precedence family selected its governing document. Load-bearing:
   * a governing selection only resolves a duplicate when this names an
   * approved discriminator — see {@link APPROVED_GOVERNING_REASONS}.
   */
  readonly governingReason?: string | null;
};

export type ContractPricingDuplicateAuthorityCandidateSource = {
  readonly documentId: string;
  /** Immutable source identity, when the system actually records one. */
  readonly sourceVersionIdentity: string | null;
  /** Canonical relationship that made this document eligible, e.g. `attached_to`. */
  readonly relationshipBasis: string | null;
  readonly rows: readonly ContractPricingAssemblyRow[];
};

export type ContractPricingDuplicateAuthorityFinding = {
  /** Deterministic: a pure function of the participating document ids. */
  readonly findingId: string;
  readonly code: 'duplicate_authority';
  /** Every implicated document, ascending. Never narrowed to a "winner". */
  readonly documentIds: readonly string[];
  readonly relationshipBasis: readonly string[];
  /** Document-scoped identities of the rows that collide, ascending. */
  readonly rowIdentities: readonly string[];
  readonly sourceIdentityStatus: ContractPricingSourceIdentityStatus;
  readonly sourceIdentityByDocumentId: readonly {
    readonly documentId: string;
    readonly sourceVersionIdentity: string | null;
  }[];
  /**
   * Why the identity store could not be read, when `sourceIdentityStatus` is
   * `unreadable`. Null in every other state. Without this an operator sees only
   * that identity was unavailable, never that the store itself failed.
   */
  readonly sourceIdentityReadError: SourceIdentityReadFailure | null;
  /**
   * The channel whose absence prevents resolution; null when identity existed.
   *
   * Set for `unreadable` as well as `absent` — the discriminator genuinely is
   * missing in both — but `sourceIdentityStatus` and `sourceIdentityReadError`
   * are what say WHY, so an unreadable store is never reported as a document
   * that simply has no recorded hash.
   */
  readonly missingDiscriminator: string | null;
  readonly detail: string;
};

const ASCENDING = (left: string, right: string) => left.localeCompare(right, 'en-US');

/**
 * Exact row-equivalence signature.
 *
 * Row identity plus anchor, page, and every observed pricing value. Two rows
 * with the same signature are the same physical rate observation. Nothing is
 * normalized beyond what the assembler already produced, and nothing is
 * approximate: a single differing rate, unit, or anchor makes rows distinct.
 *
 * KNOWN DEPENDENCY — `row.id` participates deliberately. The committed design
 * defines the duplicate condition as "same anchors AND same row identity across
 * distinct documents", and its Goodlettsville trace confirmed both uploads mint
 * byte-identical `row_id`s even though the later one was processed by a newer
 * extraction generation carrying `geometry_refs`.
 *
 * The cost of that choice: if an extraction generation ever changes how
 * `row_id` is minted, two uploads of one artifact would produce equal anchors
 * and equal values under DIFFERENT row ids, and this signature would miss them
 * — a false negative that fails open into double-counting rather than into a
 * spurious block. Relaxing the signature to anchors-plus-values would close
 * that gap but is a change to the committed detection contract and must not be
 * made without design authority. Recorded here so the dependency is visible
 * rather than implicit.
 */
function rowEquivalenceSignature(row: ContractPricingAssemblyRow): string {
  return JSON.stringify([
    row.id,
    row.sourceAnchor,
    row.page,
    row.description,
    row.category,
    row.unit,
    row.rate,
  ]);
}

function authorityTier(status: string | null): number {
  switch (status) {
    case 'draft':
    case 'reference_only':
      return 1;
    case 'superseded':
      return 2;
    case 'archived':
      return 3;
    default:
      return 0;
  }
}

/**
 * Whether existing precedence data already resolves which of two documents
 * governs. When it does, this is not an unresolved duplicate and the normal
 * precedence/exclusion path handles it.
 */
function pairIsResolvedByPrecedence(
  left: string,
  right: string,
  discriminators: ReadonlyMap<string, ContractPricingAuthorityDiscriminator>,
): boolean {
  const leftFacts = discriminators.get(left) ?? null;
  const rightFacts = discriminators.get(right) ?? null;

  if ((leftFacts?.supersededByDocumentIds ?? []).includes(right)) return true;
  if ((rightFacts?.supersededByDocumentIds ?? []).includes(left)) return true;

  if (authorityTier(leftFacts?.authorityStatus ?? null) !== authorityTier(rightFacts?.authorityStatus ?? null)) {
    return true;
  }

  const leftDate = leftFacts?.effectiveDate ?? null;
  const rightDate = rightFacts?.effectiveDate ?? null;
  if (leftDate != null && rightDate != null && leftDate !== rightDate) return true;

  // A governing selection resolves the pair only when it picks exactly one of
  // the two AND rests on an approved discriminator. Both governing, or neither,
  // discriminates nothing.
  //
  // The reason check is what keeps `upload_recency_fallback` out: the
  // precedence engine always names a governing document, so without it every
  // duplicate pair would look "resolved" the moment precedence guessed by
  // upload time — silently handing authority to the later upload.
  const leftGoverns = leftFacts?.isGoverningDocument === true;
  const rightGoverns = rightFacts?.isGoverningDocument === true;
  if (leftGoverns !== rightGoverns) {
    const governingReason = (leftGoverns ? leftFacts : rightFacts)?.governingReason ?? null;
    if (governingReason != null && APPROVED_GOVERNING_REASONS.has(governingReason)) return true;
  }

  return false;
}

function resolveIdentityStatus(
  identities: readonly (string | null)[],
  storeState: 'read' | 'unreadable',
): ContractPricingSourceIdentityStatus {
  if (storeState === 'unreadable') return 'unreadable';

  const present = identities.filter((value): value is string => value != null);
  if (present.length === 0) return 'absent';
  if (present.length < identities.length) return 'partial';
  return new Set(present).size === 1 ? 'proven_identical' : 'distinct';
}

function detailFor(
  status: ContractPricingSourceIdentityStatus,
  documentIds: readonly string[],
  rowCount: number,
): string {
  const documents = documentIds.join(', ');
  const rows = `${rowCount} pricing row${rowCount === 1 ? '' : 's'}`;

  switch (status) {
    case 'unreadable':
      return `${documents} assert the same ${rows} and no precedence signal distinguishes them. `
        + `The immutable source-identity store could not be read, so byte identity is unknown — `
        + `this is a store failure, not evidence that identity is absent. `
        + `Canonical assembly will not select or collapse a source on unverified identity.`;
    case 'absent':
      return `${documents} assert the same ${rows} and no precedence signal distinguishes them. `
        + `No immutable source identity is recorded for either document, so the runtime cannot prove `
        + `whether they are the same underlying artifact. Row equality, identical row ids, identical `
        + `anchors, and identical filenames are not proof and must not trigger a collapse.`;
    case 'partial':
      return `${documents} assert the same ${rows} and no precedence signal distinguishes them. `
        + `Immutable source identity is recorded for only some of the documents, so they cannot be compared.`;
    case 'proven_identical':
      return `${documents} assert the same ${rows}, no precedence signal distinguishes them, and their `
        + `recorded immutable source identities are equal. Collapsing duplicate sources into one logical `
        + `pricing source is not implemented in this phase and remains deferred, so assembly blocks rather `
        + `than counting the rows twice.`;
    case 'distinct':
      return `${documents} assert the same ${rows} but carry different immutable source identities, and no `
        + `precedence signal distinguishes them. Two distinct artifacts claiming the same rate rows is an `
        + `unresolved authority conflict, not a duplicate upload.`;
  }
}

/**
 * Detects every unresolved duplicate-authority group among eligible pricing
 * sources.
 *
 * A group forms when one exact row signature is asserted by two or more distinct
 * documents that remain equally eligible and that no precedence signal separates.
 * Groups are keyed by their document set, so two sources duplicating five rows
 * produce one finding naming five row identities, not five findings.
 */
export function detectContractPricingDuplicateAuthority(params: {
  readonly sources: readonly ContractPricingDuplicateAuthorityCandidateSource[];
  readonly sourceIdentityStoreState: 'read' | 'unreadable';
  /** Sanitized store failure, carried through when the store was unreadable. */
  readonly sourceIdentityReadError?: SourceIdentityReadFailure | null;
  readonly discriminators?: ReadonlyMap<string, ContractPricingAuthorityDiscriminator>;
}): readonly ContractPricingDuplicateAuthorityFinding[] {
  const discriminators = params.discriminators ?? new Map();
  const sourceByDocumentId = new Map(
    params.sources.map((source) => [source.documentId, source] as const),
  );

  // signature -> the distinct documents asserting it, and the row identities.
  const documentsBySignature = new Map<string, Set<string>>();
  const rowIdentitiesBySignature = new Map<string, Set<string>>();

  for (const source of params.sources) {
    for (const row of source.rows) {
      const signature = rowEquivalenceSignature(row);
      const documents = documentsBySignature.get(signature) ?? new Set<string>();
      documents.add(source.documentId);
      documentsBySignature.set(signature, documents);

      const identities = rowIdentitiesBySignature.get(signature) ?? new Set<string>();
      identities.add(contractPricingScopedRowId(row));
      rowIdentitiesBySignature.set(signature, identities);
    }
  }

  // documentSetKey -> accumulated row identities for that exact document set.
  const groups = new Map<string, { documentIds: readonly string[]; rowIdentities: Set<string> }>();

  for (const [signature, documents] of documentsBySignature) {
    if (documents.size < 2) continue;

    const documentIds = [...documents].sort(ASCENDING);
    const unresolved = documentIds.some((left, leftIndex) =>
      documentIds.slice(leftIndex + 1).some(
        (right) => !pairIsResolvedByPrecedence(left, right, discriminators),
      ),
    );
    if (!unresolved) continue;

    const key = documentIds.join('|');
    const group = groups.get(key) ?? { documentIds, rowIdentities: new Set<string>() };
    for (const identity of rowIdentitiesBySignature.get(signature) ?? []) {
      group.rowIdentities.add(identity);
    }
    groups.set(key, group);
  }

  return Object.freeze(
    [...groups.entries()]
      .sort((left, right) => ASCENDING(left[0], right[0]))
      .map(([key, group]) => {
        const identityByDocument = group.documentIds.map((documentId) => ({
          documentId,
          sourceVersionIdentity: sourceByDocumentId.get(documentId)?.sourceVersionIdentity ?? null,
        }));
        const status = resolveIdentityStatus(
          identityByDocument.map((entry) => entry.sourceVersionIdentity),
          params.sourceIdentityStoreState,
        );
        const rowIdentities = [...group.rowIdentities].sort(ASCENDING);

        return Object.freeze({
          findingId: `duplicate_authority:${key}`,
          code: 'duplicate_authority' as const,
          documentIds: Object.freeze(group.documentIds),
          relationshipBasis: Object.freeze(
            [...new Set(
              group.documentIds
                .map((documentId) => sourceByDocumentId.get(documentId)?.relationshipBasis ?? null)
                .filter((value): value is string => value != null),
            )].sort(ASCENDING),
          ),
          rowIdentities: Object.freeze(rowIdentities),
          sourceIdentityStatus: status,
          sourceIdentityByDocumentId: Object.freeze(
            identityByDocument.map((entry) => Object.freeze(entry)),
          ),
          sourceIdentityReadError:
            status === 'unreadable' ? params.sourceIdentityReadError ?? null : null,
          missingDiscriminator:
            status === 'proven_identical' || status === 'distinct'
              ? null
              : CONTRACT_PRICING_SOURCE_IDENTITY_DISCRIMINATOR,
          detail: detailFor(status, group.documentIds, rowIdentities.length),
        });
      }),
  );
}
