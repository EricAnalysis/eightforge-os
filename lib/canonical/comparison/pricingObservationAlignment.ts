/**
 * Authority-neutral alignment of governing pricing observations.
 *
 * ## The defect this replaces
 *
 * The first production cohort keyed pricing comparison on
 * `canonical_category ?? source_category ?? material_type` plus raw `unit_type`.
 * On one production project that produced 22 blocking deltas where canonical was
 * simply *correct*: legacy loaded the same five contract lines twice, from a
 * persisted-row path and a contract-intelligence path, and canonical deduplicated
 * them. No identity ever matched, because:
 *
 *  - `canonical_category` is a resolved taxonomy slug under legacy
 *    (`tree_operations`) and raw source text under canonical (`Tree Operations`);
 *  - raw `unit_type` differs between legacy's own two copies (`Each` vs `EA`,
 *    `Cubic Yard` vs `CY`).
 *
 * A comparison identity that varies with the authority producing it cannot
 * compare authorities. Everything below is chosen to be computable identically
 * from either side.
 *
 * ## Field classification
 *
 * | Field | Class | Used for identity |
 * |---|---|---|
 * | `source_document_id` | source identity | yes — governing document |
 * | `record_id` | source identity *when shared across paths* | yes, as an equivalence edge only |
 * | `source_category` | raw business value | no — compared, not identity |
 * | `billing_rate_key` | normalized business value, one shared builder | yes |
 * | `description_match_key` | normalized business value, same builder | yes, bridging edge |
 * | `unit_type` | display value, spelling varies | only via equivalence class |
 * | `rate_amount` | source-backed business value | no — compared, not identity |
 * | `description` | mutable business value | no — compared, not identity |
 * | `canonical_category` | authority-specific derived value | **never** |
 * | `material_type` | authority-specific (null under canonical) | **never** |
 * | `source_kind` | authority-specific adapter label | **never** |
 * | array position | unstable runtime value | **never** |
 *
 * ## Alignment, not keying
 *
 * A single identity string cannot express "these two legacy rows and this one
 * canonical row are the same contract line". Observations are therefore grouped by
 * equivalence closure over three deterministic edges:
 *
 *  - **E1, shared source record identity.** Two observations carrying a
 *    byte-identical `record_id` are the same source row by definition. This is what
 *    aligns a description-less canonical row to its legacy counterpart, and it is an
 *    exact string match, not a heuristic.
 *  - **E2, semantic billing identity.** Same governing document, same shared
 *    `billing_rate_key`, same unit equivalence class. This is what aligns two
 *    spellings of one line to each other and to the other authority.
 *  - **E3, normalized description.** `billing_rate_key` prefers a rate code when one
 *    exists, so an authority that carries a rate code and one that does not produce
 *    different primary keys for the same line. The description match key, from the
 *    same shared builder, bridges that without any fuzzy matching.
 *
 * Category is deliberately absent from every edge. It is the field most likely to be
 * populated by one adapter and blank on the other, and keying on it manufactured the
 * phantom missing-row pairs this module exists to eliminate. Category is compared,
 * like description, so a real difference is reported as a difference.
 *
 * Closure is order-independent, so the grouping does not depend on which authority
 * ran first or how the database returned rows.
 */

import {
  deriveBillingKeysForRateScheduleItem,
  normalizeUnitEquivalenceClass,
} from '@/lib/validator/billingKeys';
import type { ProjectTruthAuthorityMode } from '@/lib/canonical/authority/projectTruthAuthorityMode';
import type { RateScheduleItem } from '@/lib/validator/shared';

import { roundComparisonAmount } from './authorityComparisonModel';

const MISSING = '∅';

/** One governing pricing row as observed by one authority. */
export type PricingObservation = {
  readonly authority: ProjectTruthAuthorityMode;
  /** Source-derived record id. Shared across paths when both read one source row. */
  readonly observationId: string | null;
  readonly governingDocumentId: string | null;
  readonly sourceArtifactId: string | null;
  readonly sourcePage: number | null;
  /** Raw source category text. Identical on both sides; the taxonomy slug is not. */
  readonly rawCategory: string | null;
  readonly description: string | null;
  readonly rawUnit: string | null;
  readonly unitClass: string | null;
  readonly rate: number | null;
  /** From the one shared billing-key builder both authorities already use. */
  readonly billingRateKey: string | null;
  readonly descriptionMatchKey: string | null;
  readonly provenanceReference: string | null;
};

/**
 * One semantic contract line, with every observation of it from both authorities.
 */
export type AlignedPricingIdentity = {
  /** Deterministic and content-derived. Never positional. */
  readonly pricingKey: string;
  readonly governingDocumentIds: readonly string[];
  readonly rawCategories: readonly string[];
  readonly unitClasses: readonly string[];
  readonly legacy: PricingIdentitySide;
  readonly canonical: PricingIdentitySide;
};

export type PricingIdentitySide = {
  /** How many observations this authority produced for this one contract line. */
  readonly observationCount: number;
  /** Distinct source record identities behind those observations. */
  readonly distinctSourceCount: number;
  readonly observationIds: readonly string[];
  readonly descriptions: readonly string[];
  readonly rawUnits: readonly string[];
  readonly unitClasses: readonly string[];
  readonly rates: readonly number[];
  readonly governingDocumentIds: readonly string[];
  readonly sourceArtifactIds: readonly string[];
  readonly sourcePages: readonly number[];
  readonly provenanceReferences: readonly string[];
  /** True when this authority produced at least one observation. */
  readonly present: boolean;
  /** True when every observation lacks a billing key, so the row is unmatchable. */
  readonly billingKeyLost: boolean;
};

function sortedUnique<T>(values: readonly (T | null | undefined)[]): readonly T[] {
  const present = values.filter((value): value is T => value != null);
  const unique = [...new Set(present)];
  return unique.sort((left, right) => String(left).localeCompare(String(right), 'en-US'));
}

/**
 * Projects a rate schedule item into an authority-neutral observation.
 *
 * The billing keys are recomputed with the shared builder rather than read off the
 * item. The item's own `billing_rate_key` is set by whichever path produced it, and
 * recomputing guarantees both sides go through identical code.
 */
export function toPricingObservation(
  item: RateScheduleItem,
  authority: ProjectTruthAuthorityMode,
  context: {
    readonly sourceArtifactIdForDocument: (documentId: string | null) => string | null;
    readonly pageFor: (item: RateScheduleItem) => number | null;
  },
): PricingObservation {
  // Comparison-facing identity is derived from the SOURCE description, not the
  // operator-facing one. Assembly may replace an unreadable row's text with the
  // `Raw row needs review` display sentinel; deriving keys from that collapsed
  // every such row onto `desc:raw row needs review`, and it also made the two
  // authorities disagree — legacy carried the sentinel while canonical resolved
  // it to null, so the same physical rate failed to align at all.
  //
  // `source_description` is absent (undefined) only on items built by paths that
  // never ran display cleanup, whose own description IS source truth. A present
  // but null value means the source published none, and stays null rather than
  // falling back to the sentinel.
  const observedDescription = item.source_description !== undefined
    ? item.source_description
    : (item.description ?? null);
  const keys = deriveBillingKeysForRateScheduleItem({
    rate_code: item.rate_code,
    description: observedDescription,
    material_type: item.material_type,
    unit_type: item.unit_type,
    service_item: item.service_item ?? null,
  });
  return {
    authority,
    observationId: item.record_id ?? null,
    governingDocumentId: item.source_document_id ?? null,
    sourceArtifactId: context.sourceArtifactIdForDocument(item.source_document_id ?? null),
    sourcePage: context.pageFor(item),
    // `source_category` deliberately, never `canonical_category`: the raw source
    // text is what both authorities carry unchanged.
    rawCategory: item.source_category ?? null,
    // Source truth, for the same reason as the keys above: this is what the two
    // authorities are compared on, and the display sentinel is not what the
    // source said.
    description: observedDescription,
    rawUnit: item.unit_type ?? null,
    unitClass: normalizeUnitEquivalenceClass(item.unit_type),
    rate: item.rate_amount != null ? roundComparisonAmount(item.rate_amount) : null,
    billingRateKey: keys.billing_rate_key,
    descriptionMatchKey: keys.description_match_key,
    provenanceReference: item.record_id ?? null,
  };
}

/**
 * The authority-neutral key for one observation, for callers that need a stable
 * per-item bucket without full cross-authority alignment.
 *
 * Falls back to the source record id, then to an explicit unattributed marker, so
 * the result is always defined and never depends on authority-specific fields.
 */
export function pricingObservationKey(observation: PricingObservation): string {
  return semanticKey(observation)
    ?? (observation.observationId != null
      ? `record:${observation.observationId}`
      : `unattributed:${observation.governingDocumentId ?? MISSING}`);
}

/**
 * The primary semantic edge key, or null when the observation carries no billing
 * content.
 *
 * `rawCategory` is deliberately NOT part of the key. Category is the field most
 * likely to be present on one adapter's output and absent on the other's, and
 * including it caused exactly the phantom missing-row pairs this module exists to
 * eliminate. Category is a compared field, like description — a difference in it is
 * reported as a difference, never as two unrelated contract lines.
 */
function semanticKey(observation: PricingObservation): string | null {
  if (observation.billingRateKey == null) return null;
  return [
    observation.governingDocumentId ?? MISSING,
    observation.billingRateKey,
    observation.unitClass ?? MISSING,
  ].join('|');
}

/**
 * The secondary semantic edge key, on normalized description.
 *
 * `billing_rate_key` prefers a rate code when one exists, so an authority that
 * carries a rate code and one that does not produce different primary keys for the
 * same contract line (`HAUL015` versus `desc:haul 0 15 miles`). The description
 * match key is computed by the same shared builder from the same source text and
 * bridges that case without any fuzzy matching.
 */
function descriptionKey(observation: PricingObservation): string | null {
  if (observation.descriptionMatchKey == null) return null;
  return [
    observation.governingDocumentId ?? MISSING,
    `desc:${observation.descriptionMatchKey}`,
    observation.unitClass ?? MISSING,
  ].join('|');
}

/**
 * Groups observations from both authorities into semantic contract lines.
 *
 * Union-find over the two equivalence edges. The result is independent of input
 * order: components are the same whichever order the observations arrive in, and
 * the emitted key for each component is derived from its content rather than from
 * whichever member happened to be seen first.
 */
export function alignPricingObservations(
  observations: readonly PricingObservation[],
): readonly AlignedPricingIdentity[] {
  const parent = observations.map((_, index) => index);

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    // Always attach the higher index to the lower so the structure is
    // deterministic regardless of the order unions are applied.
    if (a === b) return;
    if (a < b) parent[b] = a;
    else parent[a] = b;
  };

  const byRecordId = new Map<string, number[]>();
  const bySemanticKey = new Map<string, number[]>();
  const byDescriptionKey = new Map<string, number[]>();
  observations.forEach((observation, index) => {
    if (observation.observationId != null) {
      byRecordId.set(
        observation.observationId,
        [...(byRecordId.get(observation.observationId) ?? []), index],
      );
    }
    const key = semanticKey(observation);
    if (key != null) {
      bySemanticKey.set(key, [...(bySemanticKey.get(key) ?? []), index]);
    }
    const description = descriptionKey(observation);
    if (description != null) {
      byDescriptionKey.set(description, [...(byDescriptionKey.get(description) ?? []), index]);
    }
  });
  for (const group of [
    ...byRecordId.values(),
    ...bySemanticKey.values(),
    ...byDescriptionKey.values(),
  ]) {
    for (let i = 1; i < group.length; i += 1) union(group[0]!, group[i]!);
  }

  const components = new Map<number, PricingObservation[]>();
  observations.forEach((observation, index) => {
    const root = find(index);
    components.set(root, [...(components.get(root) ?? []), observation]);
  });

  return [...components.values()]
    .map((members) => buildAlignedIdentity(members))
    .sort((left, right) => left.pricingKey.localeCompare(right.pricingKey, 'en-US'));
}

/**
 * Derives the stable key and per-authority summary for one aligned contract line.
 *
 * The key is the lexicographically smallest semantic key among the component's
 * members, falling back to the smallest source record id when no member carries
 * billing content. Content-derived and order-independent: adding an observation
 * that sorts later cannot change it.
 */
function buildAlignedIdentity(members: readonly PricingObservation[]): AlignedPricingIdentity {
  const semanticKeys = sortedUnique(members.map(semanticKey));
  const recordIds = sortedUnique(members.map((member) => member.observationId));
  const pricingKey = semanticKeys[0]
    ?? (recordIds[0] != null ? `record:${recordIds[0]}` : `unattributed:${MISSING}`);

  return {
    pricingKey,
    governingDocumentIds: sortedUnique(members.map((member) => member.governingDocumentId)),
    rawCategories: sortedUnique(members.map((member) => member.rawCategory)),
    unitClasses: sortedUnique(members.map((member) => member.unitClass)),
    legacy: buildSide(members.filter((member) => member.authority === 'legacy')),
    canonical: buildSide(members.filter((member) => member.authority === 'canonical')),
  };
}

function buildSide(members: readonly PricingObservation[]): PricingIdentitySide {
  return {
    observationCount: members.length,
    distinctSourceCount: sortedUnique(members.map((member) => member.observationId)).length,
    observationIds: sortedUnique(members.map((member) => member.observationId)),
    descriptions: sortedUnique(members.map((member) => member.description)),
    rawUnits: sortedUnique(members.map((member) => member.rawUnit)),
    unitClasses: sortedUnique(members.map((member) => member.unitClass)),
    rates: sortedUnique(members.map((member) => member.rate)),
    governingDocumentIds: sortedUnique(members.map((member) => member.governingDocumentId)),
    sourceArtifactIds: sortedUnique(members.map((member) => member.sourceArtifactId)),
    sourcePages: sortedUnique(members.map((member) => member.sourcePage)),
    provenanceReferences: sortedUnique(members.map((member) => member.provenanceReference)),
    present: members.length > 0,
    // "Unmatchable" rather than merely "missing a description": a row with no
    // billing key cannot be linked to an invoice line at all, which is what makes
    // description loss financially material rather than cosmetic.
    billingKeyLost: members.length > 0
      && members.every((member) => member.billingRateKey == null),
  };
}
