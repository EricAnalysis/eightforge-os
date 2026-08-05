/**
 * The deterministic identity of one frozen comparison input.
 *
 * A comparison is only meaningful if both authorities read the same input. The
 * digest is how that claim is verified rather than assumed: it is computed once
 * before either run and recomputed after each run, so a run that mutated shared
 * source data is detected instead of silently corrupting the other authority's
 * view.
 *
 * Three normalization rules make the digest an identity of MEANING, not of
 * representation:
 *
 *  - object key order never matters (`canonicalJson` sorts keys recursively);
 *  - array order never matters where it is not semantically meaningful — every
 *    collection is reduced to its canonical member strings and then sorted, so a
 *    reversed database result set produces the identical digest;
 *  - `Map` values are converted to sorted entry pairs. This is not cosmetic:
 *    `JSON.stringify` renders a populated `Map` as `{}`, so hashing one directly
 *    would make every fact lookup invisible to the digest.
 *
 * Wall-clock time and per-run generated identifiers are absent from the snapshot
 * by construction, so nothing runtime-varying can enter the digest.
 */

import { canonicalJson, sha256Hex } from '@/lib/canonical/publication/projectTruthPublicationIdentity';
import type { ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';

/**
 * Reduces a collection to a set of canonical member strings, sorted.
 *
 * Sorting the serialized members — rather than sorting by a hand-picked identity
 * field — means the normalization cannot drift as row shapes change, and cannot
 * accidentally collapse two genuinely distinct rows that happen to share an id.
 */
function normalizedMembers(values: readonly unknown[]): readonly string[] {
  return values
    .map((value) => canonicalJson(value ?? null))
    .sort((left, right) => left.localeCompare(right, 'en-US'));
}

function normalizedMapEntries(map: ReadonlyMap<string, unknown>): readonly string[] {
  return [...map.entries()]
    .map(([key, value]) => canonicalJson({ key, value: value ?? null }))
    .sort((left, right) => left.localeCompare(right, 'en-US'));
}

function normalizedDocumentIdsByFamily(
  record: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  return Object.keys(record)
    .map((family) => canonicalJson({
      family,
      documentIds: [...(record[family] ?? [])].sort((left, right) => left.localeCompare(right, 'en-US')),
    }))
    .sort((left, right) => left.localeCompare(right, 'en-US'));
}

/**
 * Projects a source snapshot into its order-normalized semantic shape.
 *
 * Exported so tests can assert on the projection directly instead of only on the
 * opaque digest — a digest test that fails is far easier to diagnose when the
 * normalized input is inspectable.
 */
export function normalizeComparisonInputSnapshot(
  snapshot: ValidatorSourceSnapshot,
): Record<string, unknown> {
  return {
    project: snapshot.project,
    validationPhase: snapshot.validationPhase,
    documents: normalizedMembers(snapshot.documents),
    ruleState: normalizedMapEntries(snapshot.ruleStateByRuleId),
    mobileTickets: normalizedMembers(snapshot.mobileTickets),
    loadTickets: normalizedMembers(snapshot.loadTickets),
    transactionDatasets: normalizedMembers(snapshot.transactionData?.datasets ?? []),
    transactionRows: normalizedMembers(snapshot.transactionData?.rows ?? []),
    sourceArtifactSnapshot: normalizedMembers(snapshot.sourceArtifactSnapshot),
    precedenceFamilies: normalizedMembers(snapshot.precedenceFamilies),
    documentRelationships: normalizedMembers(snapshot.documentRelationships),
    familyDocumentIds: normalizedDocumentIdsByFamily(snapshot.familyDocumentIds),
    governingDocumentIds: normalizedDocumentIdsByFamily(snapshot.governingDocumentIds),
    truthCategoryDocumentIds: normalizedDocumentIdsByFamily(snapshot.truthCategoryDocumentIds),
    factsByDocumentId: normalizedMapEntries(
      new Map([...snapshot.factsByDocumentId.entries()].map(
        ([documentId, facts]) => [documentId, normalizedMembers(facts)] as const,
      )),
    ),
    invoices: normalizedMembers(snapshot.invoices),
    invoiceLines: normalizedMembers(snapshot.invoiceLines),
    assembledContractPricingRows: normalizedMembers(snapshot.assembledContractPricingRows),
    contractValidationContext: snapshot.contractValidationContext ?? null,
    rateScheduleItems: normalizedMembers(snapshot.baseFactLookups.rateScheduleItems),
    contractUploadGuidanceRateScheduleIncluded: snapshot.contractUploadGuidanceRateScheduleIncluded,
    invoiceLineRateLinkRows: normalizedMembers(snapshot.invoiceLineRateLinkRows),
    sourceArtifactSnapshotDigest: snapshot.sourceArtifactSnapshotDigest,
  };
}

/**
 * The deterministic digest of one frozen comparison input.
 *
 * `allFacts` is intentionally excluded: it is a flattened view of
 * `factsByDocumentId`, and hashing both would let the same fact influence the
 * digest twice without adding any distinguishing information.
 */
export function buildComparisonInputSnapshotDigest(
  snapshot: ValidatorSourceSnapshot,
): string {
  return sha256Hex(canonicalJson(normalizeComparisonInputSnapshot(snapshot)));
}
