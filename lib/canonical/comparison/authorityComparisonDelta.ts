/**
 * Delta construction and conservative automated classification.
 *
 * Two rules govern this module.
 *
 * **Determinism.** A delta id is a digest of `(domain, entityKey, field)` — never
 * a counter, never a position, never a timestamp. Repeated comparisons of the
 * same input therefore produce identical ids in an identical order, which is what
 * lets an operator disposition recorded yesterday still refer to the same delta
 * today.
 *
 * **Conservatism.** The classifier may say "this looks like canonical correcting
 * legacy"; it may not say "canonical is correct". Every judgement-bearing outcome
 * is a `_candidate`, and anything the rules cannot justify from the evidence in
 * front of them stays `unclassified` rather than being rounded toward a
 * comfortable answer. `blocking` materiality is likewise assigned from safety
 * rules — evidence loss, unexplained clearance improvement, unexplained exposure
 * decrease — not from a general sense of severity.
 */

import { sha256Hex } from '@/lib/canonical/publication/projectTruthPublicationIdentity';

import {
  type AuthorityComparisonClassificationSummary,
  type AuthorityComparisonDelta,
  type AuthorityComparisonDeltaGroup,
  type AuthorityRunSummary,
  type ComparisonDeltaClassification,
  type ComparisonDeltaDomain,
  type ComparisonDeltaMateriality,
  type ComparisonEvidenceReference,
  type NormalizedAmountTotal,
  type NormalizedPricingReference,
  type NormalizedQuantityTotal,
  roundComparisonAmount,
} from './authorityComparisonModel';

/**
 * Delimiter for composite delta keys.
 *
 * ASCII unit separator, chosen because an `entityKey` legitimately contains spaces,
 * `|`, `:`, and `/` — a delimiter drawn from that set could make two different
 * triples produce one key, which for a delta id would silently merge two distinct
 * differences into one.
 */
const DELTA_KEY_SEPARATOR = '\u001f';

export function buildDeltaId(
  domain: ComparisonDeltaDomain,
  entityKey: string,
  field: string,
): string {
  // A digest rather than a concatenation: entity keys embed user-controlled
  // document ids and descriptions, and a raw join would produce ids whose
  // boundaries shift with the data. The digest is fixed-width and collision-safe.
  return sha256Hex(
    `${domain}${DELTA_KEY_SEPARATOR}${entityKey}${DELTA_KEY_SEPARATOR}${field}`,
  ).slice(0, 32);
}

/** Marks a delta that is not downstream of any other condition. */
export const INDEPENDENT_ROOT_CAUSE = 'independent';

type DeltaDraft = {
  readonly domain: ComparisonDeltaDomain;
  readonly entityKey: string;
  readonly field: string;
  readonly legacyValue: unknown;
  readonly canonicalValue: unknown;
  readonly classification: ComparisonDeltaClassification;
  readonly materiality: ComparisonDeltaMateriality;
  readonly classificationRationale: string;
  readonly explanation: string;
  readonly evidenceReferences?: readonly ComparisonEvidenceReference[];
  /**
   * The upstream condition this delta descends from, when one provably exists.
   *
   * Set ONLY where the emitter can show the difference is a mechanical consequence
   * — e.g. canonical produced no transactions because the transactions domain is
   * blocked. Defaults to `independent`, so a delta is never collapsed by accident:
   * grouping has to be earned, and an unattributed regression stays top-level.
   */
  readonly rootCauseKey?: string;
  readonly rootCauseSummary?: string;
  /** Impact carried into the group summary so collapsing loses no magnitude. */
  readonly affectedAmount?: number | null;
};

function finalize(draft: DeltaDraft): AuthorityComparisonDelta {
  return {
    deltaId: buildDeltaId(draft.domain, draft.entityKey, draft.field),
    domain: draft.domain,
    entityKey: draft.entityKey,
    field: draft.field,
    legacyValue: draft.legacyValue,
    canonicalValue: draft.canonicalValue,
    classification: draft.classification,
    materiality: draft.materiality,
    classificationRationale: draft.classificationRationale,
    explanation: draft.explanation,
    evidenceReferences: draft.evidenceReferences ?? [],
    rootCauseKey: draft.rootCauseKey ?? INDEPENDENT_ROOT_CAUSE,
    rootCauseSummary: draft.rootCauseSummary ?? null,
    affectedAmount: draft.affectedAmount ?? null,
  };
}

/**
 * Names the upstream condition when canonical declined to govern.
 *
 * Returns null when canonical established authority, which is what keeps a genuine
 * regression on an assembled run from being swept into a block group.
 */
function canonicalBlockRootCause(
  canonical: AuthorityRunSummary,
): { readonly key: string; readonly summary: string } | null {
  if (!canonicalRefusedToAssert(canonical)) return null;
  const domains = canonical.blockedTruthDomains.length > 0
    ? canonical.blockedTruthDomains.join(',')
    : (canonical.blockReason ?? canonical.assemblyStatus);
  return {
    key: `canonical_block:${canonical.assemblyStatus}:${domains}`,
    summary: `Canonical authority reported ${canonical.assemblyStatus}`
      + `${canonical.blockReason ? ` (${canonical.blockReason})` : ''}`
      + `${canonical.blockedTruthDomains.length > 0
        ? `, blocking truth domain(s): ${canonical.blockedTruthDomains.join(', ')}`
        : ''}`
      + '. Every difference in this group is a mechanical consequence of that one refusal.',
  };
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function missingFrom(source: readonly string[], target: readonly string[]): readonly string[] {
  const present = new Set(target);
  return source.filter((value) => !present.has(value));
}

function evidenceFor(documentId: string | null, detail: string): ComparisonEvidenceReference[] {
  return [{
    kind: 'source_document',
    sourceDocumentId: documentId,
    sourceArtifactId: null,
    page: null,
    detail,
  }];
}

// ---------------------------------------------------------------------------
// Identity and counts
// ---------------------------------------------------------------------------

/**
 * Whether canonical's refusal to establish authority explains a difference.
 *
 * A canonical run that reported `blocked` deliberately withheld truth rather than
 * losing it. Differences flowing from that refusal are `authority_policy_difference`,
 * not regressions — refusing to guess is the designed behavior, and classifying it
 * as a regression would train an operator to dismiss real regressions.
 */
function canonicalRefusedToAssert(canonical: AuthorityRunSummary): boolean {
  return canonical.assemblyStatus === 'blocked' || canonical.assemblyStatus === 'failed';
}

function identityDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas: AuthorityComparisonDelta[] = [];
  const refused = canonicalRefusedToAssert(canonical);

  const collections: readonly {
    readonly domain: ComparisonDeltaDomain;
    readonly label: string;
    readonly legacy: readonly string[];
    readonly canonical: readonly string[];
  }[] = [
    {
      domain: 'invoice',
      label: 'invoice',
      legacy: legacy.identities.invoiceIdentities,
      canonical: canonical.identities.invoiceIdentities,
    },
    {
      domain: 'invoice_line',
      label: 'invoice line',
      legacy: legacy.identities.invoiceLineIdentities,
      canonical: canonical.identities.invoiceLineIdentities,
    },
    {
      domain: 'transaction',
      label: 'transaction',
      legacy: legacy.identities.transactionIdentities,
      canonical: canonical.identities.transactionIdentities,
    },
  ];

  for (const collection of collections) {
    const lost = missingFrom(collection.legacy, collection.canonical);
    const gained = missingFrom(collection.canonical, collection.legacy);

    for (const identity of lost) {
      deltas.push(finalize({
        domain: collection.domain,
        entityKey: identity,
        field: 'present',
        legacyValue: true,
        canonicalValue: false,
        // Losing a source-backed record is the canonical regression signature.
        // When canonical explicitly refused to assert authority, the same
        // observable is a policy consequence instead — but it is still surfaced
        // for review, never silenced.
        classification: refused ? 'authority_policy_difference' : 'regression_candidate',
        materiality: 'blocking',
        classificationRationale: refused
          ? `Canonical authority reported ${canonical.assemblyStatus}`
            + `${canonical.blockReason ? ` (${canonical.blockReason})` : ''}, so it withheld this `
            + `${collection.label} rather than losing it. Verify the block is the intended refusal.`
          : `Canonical produced no ${collection.label} for a source identity legacy resolved, and `
            + 'reported no block that would explain the absence.',
        explanation: `Legacy resolved ${collection.label} "${identity}" but canonical did not.`,
        evidenceReferences: evidenceFor(identity.split('|')[0] ?? null, `lost ${collection.label}`),
      }));
    }

    for (const identity of gained) {
      deltas.push(finalize({
        domain: collection.domain,
        entityKey: identity,
        field: 'present',
        legacyValue: false,
        canonicalValue: true,
        // A record canonical resolved and legacy did not is usually canonical
        // preserving a distinct source row legacy collapsed. It is a candidate,
        // and it is review-required rather than blocking: gaining evidence is not
        // itself a safety failure.
        classification: 'canonical_correction_candidate',
        materiality: 'review_required',
        classificationRationale: `Canonical resolved a distinct ${collection.label} identity that `
          + 'legacy did not surface, consistent with canonical preserving source rows legacy collapsed.',
        explanation: `Canonical resolved ${collection.label} "${identity}" but legacy did not.`,
        evidenceReferences: evidenceFor(identity.split('|')[0] ?? null, `new ${collection.label}`),
      }));
    }
  }

  const newDuplicates = missingFrom(
    canonical.identities.duplicateIdentities,
    legacy.identities.duplicateIdentities,
  );
  for (const identity of newDuplicates) {
    deltas.push(finalize({
      domain: 'invoice',
      entityKey: identity,
      field: 'duplicate_identity',
      legacyValue: false,
      canonicalValue: true,
      // A duplicate identity is never a correction. Canonical exists to make
      // identity deterministic; introducing a duplicate defeats that directly.
      classification: 'regression_candidate',
      materiality: 'blocking',
      classificationRationale: 'Canonical introduced a duplicate identity. Canonical identity is '
        + 'required to be deterministic and unique, so a new duplicate cannot be a correction.',
      explanation: `Canonical produced duplicate identity "${identity}" that legacy did not.`,
      evidenceReferences: evidenceFor(null, 'duplicate canonical identity'),
    }));
  }

  return deltas;
}

// ---------------------------------------------------------------------------
// Quantity and amount
// ---------------------------------------------------------------------------

function quantityKey(total: NormalizedQuantityTotal): string {
  return `${total.grain}:${total.key}`;
}

function amountKey(total: NormalizedAmountTotal): string {
  return `${total.grain}:${total.key}`;
}

function quantityDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas: AuthorityComparisonDelta[] = [];
  const legacyByKey = new Map(legacy.quantityTotals.map((total) => [quantityKey(total), total]));
  const canonicalByKey = new Map(
    canonical.quantityTotals.map((total) => [quantityKey(total), total]),
  );

  for (const entityKey of sortedKeys(legacyByKey, canonicalByKey)) {
    const left = legacyByKey.get(entityKey) ?? null;
    const right = canonicalByKey.get(entityKey) ?? null;
    const legacyTotal = left?.quantityTotal ?? null;
    const canonicalTotal = right?.quantityTotal ?? null;
    const conflictsAppeared = (right?.conflictedIdentityCount ?? 0) > (left?.conflictedIdentityCount ?? 0);

    if (legacyTotal !== canonicalTotal) {
      // The signature ticket-grain case: canonical preserved a ticket-grain
      // conflict where legacy summed repeated rows. The conflict count IS the
      // evidence, so this is a correction candidate rather than unexplained.
      const explained = conflictsAppeared;
      deltas.push(finalize({
        domain: 'quantity',
        entityKey,
        field: 'quantityTotal',
        legacyValue: legacyTotal,
        canonicalValue: canonicalTotal,
        classification: explained
          ? 'canonical_correction_candidate'
          : canonicalRefusedToAssert(canonical)
            ? 'authority_policy_difference'
            : 'regression_candidate',
        materiality: explained ? 'review_required' : 'blocking',
        classificationRationale: explained
          ? `Canonical preserved ${String(right?.conflictedIdentityCount ?? 0)} conflicting `
            + `ticket-grain identit${(right?.conflictedIdentityCount ?? 0) === 1 ? 'y' : 'ies'} that `
            + 'legacy summed across repeated physical rows. The conflict is the explanation.'
          : canonicalRefusedToAssert(canonical)
            ? `Canonical reported ${canonical.assemblyStatus} and withheld quantity truth.`
            : 'Canonical quantity differs with no ticket-grain conflict and no block to explain it.',
        explanation: `Ticket-grain quantity at ${entityKey} is ${String(legacyTotal)} under legacy `
          + `and ${String(canonicalTotal)} under canonical. Legacy counted ${String(left?.rowCount ?? 0)} `
          + `physical rows across ${String(left?.distinctTicketCount ?? 0)} distinct tickets; canonical `
          + `counted ${String(right?.rowCount ?? 0)} rows across ${String(right?.distinctTicketCount ?? 0)} tickets.`,
        evidenceReferences: evidenceFor(null, `ticket-grain quantity at ${entityKey}`),
      }));
    }

    // The physical double-count signal. Because the ticket-grain rule is applied
    // identically to both authorities, a legacy run that summed repeated rows and
    // a canonical run that collapsed them agree on `quantityTotal` and differ ONLY
    // here. Without this comparison the correction would be invisible.
    if ((left?.rowGrainQuantityTotal ?? null) !== (right?.rowGrainQuantityTotal ?? null)) {
      const legacyHadRepeats = (left?.rowCount ?? 0) > (left?.distinctTicketCount ?? 0);
      const canonicalIsOnePerTicket = right != null
        && right.rowCount === right.distinctTicketCount;
      const collapsed = legacyHadRepeats && canonicalIsOnePerTicket;
      deltas.push(finalize({
        domain: 'quantity',
        entityKey,
        field: 'rowGrainQuantityTotal',
        legacyValue: left?.rowGrainQuantityTotal ?? null,
        canonicalValue: right?.rowGrainQuantityTotal ?? null,
        classification: collapsed
          ? 'canonical_correction_candidate'
          : canonicalRefusedToAssert(canonical)
            ? 'authority_policy_difference'
            : 'unclassified',
        materiality: 'review_required',
        classificationRationale: collapsed
          ? `Legacy carried ${String(left?.rowCount ?? 0)} physical rows for `
            + `${String(left?.distinctTicketCount ?? 0)} distinct ticket(s), so its across-rows sum `
            + 'double-counted. Canonical carries exactly one row per ticket identity.'
          : canonicalRefusedToAssert(canonical)
            ? `Canonical reported ${canonical.assemblyStatus} and withheld transaction rows.`
            : 'Across-rows sums differ without a clear collapse of repeated physical rows.',
        explanation: `Across-rows (non-deduplicated) quantity at ${entityKey} is `
          + `${String(left?.rowGrainQuantityTotal ?? null)} under legacy and `
          + `${String(right?.rowGrainQuantityTotal ?? null)} under canonical, while the ticket-grain `
          + `total is ${String(left?.quantityTotal ?? null)} and ${String(right?.quantityTotal ?? null)} `
          + 'respectively. A gap between these two numbers is a physical row double-count.',
        evidenceReferences: evidenceFor(null, `row-grain quantity at ${entityKey}`),
      }));
    }

    if ((left?.distinctTicketCount ?? 0) !== (right?.distinctTicketCount ?? 0)) {
      deltas.push(finalize({
        domain: 'quantity',
        entityKey,
        field: 'distinctTicketCount',
        legacyValue: left?.distinctTicketCount ?? null,
        canonicalValue: right?.distinctTicketCount ?? null,
        classification: 'unclassified',
        materiality: 'review_required',
        classificationRationale: 'Distinct ticket counts differ. Whether canonical split a '
          + 'collapsed ticket or dropped one cannot be decided from counts alone.',
        explanation: `Distinct ticket count at ${entityKey} differs between authorities.`,
      }));
    }
  }

  return deltas;
}

function amountDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas: AuthorityComparisonDelta[] = [];
  const legacyByKey = new Map(legacy.amountTotals.map((total) => [amountKey(total), total]));
  const canonicalByKey = new Map(canonical.amountTotals.map((total) => [amountKey(total), total]));

  for (const entityKey of sortedKeys(legacyByKey, canonicalByKey)) {
    const left = legacyByKey.get(entityKey) ?? null;
    const right = canonicalByKey.get(entityKey) ?? null;
    if ((left?.amountTotal ?? null) === (right?.amountTotal ?? null)) continue;
    const conflictsAppeared = (right?.conflictedIdentityCount ?? 0) > (left?.conflictedIdentityCount ?? 0);
    const refused = canonicalRefusedToAssert(canonical);
    deltas.push(finalize({
      domain: 'amount',
      entityKey,
      field: 'amountTotal',
      legacyValue: left?.amountTotal ?? null,
      canonicalValue: right?.amountTotal ?? null,
      classification: conflictsAppeared
        ? 'canonical_correction_candidate'
        : refused
          ? 'authority_policy_difference'
          : 'regression_candidate',
      // An amount that moved with no conflict and no block is an unexplained
      // financial change. Nothing about that is informational.
      materiality: conflictsAppeared ? 'review_required' : 'blocking',
      classificationRationale: conflictsAppeared
        ? 'Canonical preserved a conflicting ticket-grain amount that legacy summed.'
        : refused
          ? `Canonical reported ${canonical.assemblyStatus} and withheld amount truth.`
          : 'Canonical amount changed with no conflict, no block, and no provenance difference '
            + 'to explain it.',
      explanation: `Amount at ${entityKey} is ${String(left?.amountTotal ?? null)} under legacy and `
        + `${String(right?.amountTotal ?? null)} under canonical.`,
      evidenceReferences: evidenceFor(null, `amount at ${entityKey}`),
    }));
  }

  return deltas;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function pricingDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas: AuthorityComparisonDelta[] = [];
  const legacyByKey = new Map(legacy.governingPricing.map((row) => [row.pricingKey, row]));
  const canonicalByKey = new Map(canonical.governingPricing.map((row) => [row.pricingKey, row]));
  const block = canonicalBlockRootCause(canonical);

  // ── Pricing assembly scope diagnostic ───────────────────────────────────
  // Canonical priced nothing at all while legacy priced from real documents. The
  // per-row `present` deltas below describe the symptom once per row; this states
  // the discriminating fact once, at project level: WHICH source documents legacy
  // drew pricing from. That is what distinguishes "the contract genuinely has no
  // rates" from "the rates live on attached price sheets the canonical pricing
  // assembly never received", which are very different problems and were
  // indistinguishable in the first production cohort report.
  if (canonical.governingPricing.length === 0 && legacy.governingPricing.length > 0) {
    const legacyPricingDocuments = [...new Set(
      legacy.governingPricing
        .map((row) => row.governingDocumentId)
        .filter((value): value is string => value != null),
    )].sort((left, right) => left.localeCompare(right, 'en-US'));

    deltas.push(finalize({
      domain: 'pricing',
      entityKey: 'project',
      field: 'assemblySourceScope',
      legacyValue: legacyPricingDocuments,
      canonicalValue: [],
      classification: 'source_gap',
      materiality: 'blocking',
      classificationRationale: 'Canonical received no assembled contract pricing rows, so it could '
        + `establish no governing pricing at all. Legacy priced this project from `
        + `${String(legacyPricingDocuments.length)} source document(s). Compare that document set `
        + 'against the document the pricing assembly was scoped to: if they differ, the rows exist '
        + 'but never reached canonical, which is an assembly-scope gap rather than absent source data.',
      explanation: 'Canonical resolved zero governing pricing rows while legacy resolved '
        + `${String(legacy.governingPricing.length)} from document(s) `
        + `${legacyPricingDocuments.join(', ')}.`,
      evidenceReferences: legacyPricingDocuments.map((documentId) => ({
        kind: 'legacy_pricing_source_document',
        sourceDocumentId: documentId,
        sourceArtifactId: legacy.governingPricing.find(
          (row) => row.governingDocumentId === documentId,
        )?.sourceArtifactId ?? null,
        page: null,
        detail: 'legacy resolved governing pricing from this document; canonical received none',
      })),
    }));
  }

  for (const pricingKey of sortedKeys(legacyByKey, canonicalByKey)) {
    const left = legacyByKey.get(pricingKey) ?? null;
    const right = canonicalByKey.get(pricingKey) ?? null;

    // ── Semantic existence ────────────────────────────────────────────────
    // Reached only when an authority produced NO observation of this contract
    // line. Duplicate legacy rows no longer land here: they align to the same
    // semantic identity as canonical's single row and are reported as
    // multiplicity below, which is what stopped a correct canonical deduplication
    // from being reported as nine missing pricing rows in the first cohort.
    if (left != null && right == null) {
      deltas.push(finalize({
        domain: 'pricing',
        entityKey: pricingKey,
        field: 'present',
        legacyValue: pricingSummary(left),
        canonicalValue: null,
        classification: block != null ? 'authority_policy_difference' : 'source_gap',
        materiality: 'blocking',
        classificationRationale: block != null
          ? `${block.summary} Canonical withheld this governing pricing row rather than losing it.`
          : 'Canonical resolved no observation of a contract line legacy priced, and reported no '
            + 'block. Required governing truth is absent.',
        explanation: `Governing pricing "${pricingKey}" is priced by legacy at `
          + `${String(left.rate)} and absent under canonical.`,
        evidenceReferences: pricingEvidence(left),
        rootCauseKey: block?.key,
        rootCauseSummary: block?.summary,
        affectedAmount: left.rate,
      }));
      continue;
    }

    if (left == null && right != null) {
      deltas.push(finalize({
        domain: 'pricing',
        entityKey: pricingKey,
        field: 'present',
        legacyValue: null,
        canonicalValue: pricingSummary(right),
        classification: right.governingDocumentId != null
          ? 'canonical_correction_candidate'
          : 'unclassified',
        materiality: 'review_required',
        classificationRationale: right.governingDocumentId != null
          ? `Canonical resolved governing pricing from document ${right.governingDocumentId} for a `
            + 'contract line legacy did not price.'
          : 'Canonical produced a pricing row with no governing document to justify it.',
        explanation: `Governing pricing "${pricingKey}" is present under canonical at rate `
          + `${String(right.rate)} and absent under legacy.`,
        evidenceReferences: pricingEvidence(right),
        affectedAmount: right.rate,
      }));
      continue;
    }

    if (left == null || right == null) continue;

    const ratesEquivalent = sameMembers(
      left.rate != null ? [String(left.rate)] : [],
      right.rate != null ? [String(right.rate)] : [],
    );
    const governingEquivalent = left.governingDocumentId === right.governingDocumentId;

    // ── Multiplicity ──────────────────────────────────────────────────────
    // One authority observed the same contract line more times than the other.
    // The observed production shape: legacy loads each line twice, from a
    // persisted-row path and a contract-intelligence path, and canonical carries one.
    if (left.observationCount !== right.observationCount) {
      const canonicalDeduplicated = right.observationCount < left.observationCount;
      const deduplicationIsClean = canonicalDeduplicated
        && ratesEquivalent
        && governingEquivalent;
      deltas.push(finalize({
        domain: 'pricing',
        entityKey: pricingKey,
        field: 'observationCount',
        legacyValue: left.observationCount,
        canonicalValue: right.observationCount,
        classification: deduplicationIsClean
          // Same contract line, same rate, same governing document, fewer copies.
          // A candidate — never a confirmed correction — because whether the extra
          // legacy observations were true duplicates or distinct source rows is an
          // operator judgement about provenance.
          ? 'canonical_correction_candidate'
          : canonicalDeduplicated
            ? 'authority_policy_difference'
            : 'regression_candidate',
        materiality: canonicalDeduplicated ? 'review_required' : 'blocking',
        classificationRationale: deduplicationIsClean
          ? `Legacy observed this contract line ${String(left.observationCount)} times across `
            + `${String(left.distinctSourceCount)} source record(s); canonical carries `
            + `${String(right.observationCount)}. Rate and governing document are identical, so this `
            + 'is canonical collapsing duplicate observations of one line rather than losing pricing. '
            + 'Confirm the extra legacy observations are duplicates and not distinct contract rows.'
          : canonicalDeduplicated
            ? 'Canonical carries fewer observations of this line, but rate or governing document '
              + 'also differ, so the reduction is not a clean deduplication.'
            : 'Canonical observes this contract line more times than legacy, which introduces '
              + 'duplicate governing pricing rather than removing it.',
        explanation: `Contract line "${pricingKey}" is observed ${String(left.observationCount)} `
          + `time(s) by legacy and ${String(right.observationCount)} time(s) by canonical. `
          + `Legacy source records: ${left.distinctSourceCount}; canonical: ${right.distinctSourceCount}.`,
        evidenceReferences: [...pricingEvidence(left), ...pricingEvidence(right)],
      }));
    }

    // ── Description ───────────────────────────────────────────────────────
    // Description is compared truth, never identity. Keeping it out of the key is
    // what lets description-less canonical rows align at all; comparing it here is
    // what makes a canonical description loss visible instead of silent.
    if (!sameMembers(left.descriptions, right.descriptions)) {
      const lost = missingFrom(left.descriptions, right.descriptions);
      const canonicalHasNone = right.descriptions.length === 0;
      // Blocking only when the loss actually breaks rate linkage: a row with no
      // billing key cannot match an invoice line, so the governing rate is
      // effectively unreachable. Otherwise this is evidence quality, not a
      // financial control change.
      const breaksRateLinkage = lost.length > 0 && right.billingKeyLost;
      deltas.push(finalize({
        domain: 'pricing',
        entityKey: pricingKey,
        field: 'description',
        legacyValue: left.descriptions,
        canonicalValue: right.descriptions,
        classification: lost.length > 0 ? 'regression_candidate' : 'canonical_correction_candidate',
        materiality: breaksRateLinkage
          ? 'blocking'
          : lost.length > 0
            ? 'review_required'
            : 'informational',
        classificationRationale: breaksRateLinkage
          ? `Canonical carries no description for this contract line, so it has no billing key and `
            + 'cannot be matched to an invoice line. The governing rate is effectively unreachable, '
            + `and legacy's description(s) ${lost.map((value) => `"${value}"`).join(', ')} are lost.`
          : lost.length > 0
            ? `Canonical dropped source-backed description(s) `
              + `${lost.map((value) => `"${value}"`).join(', ')} that legacy carries. Rate linkage `
              + 'still resolves, so this is evidence quality rather than a pricing change.'
            : 'Canonical carries description text legacy did not.',
        explanation: `Description for "${pricingKey}" is `
          + `${left.descriptions.length > 0 ? left.descriptions.map((value) => `"${value}"`).join(', ') : 'absent'} `
          + `under legacy and ${canonicalHasNone ? 'absent' : right.descriptions.map((value) => `"${value}"`).join(', ')} `
          + 'under canonical.',
        evidenceReferences: [...pricingEvidence(left), ...pricingEvidence(right)],
      }));
    }

    // ── Category ──────────────────────────────────────────────────────────
    // Compared, never identity. Category is the field most likely to be populated
    // by one adapter and not the other, so keying on it manufactured phantom
    // missing rows; comparing it reports the real difference instead.
    if (left.category !== right.category) {
      const lost = left.category != null && right.category == null;
      deltas.push(finalize({
        domain: 'pricing',
        entityKey: pricingKey,
        field: 'category',
        legacyValue: left.category,
        canonicalValue: right.category,
        classification: lost ? 'regression_candidate' : 'unclassified',
        materiality: 'review_required',
        classificationRationale: lost
          ? 'Canonical carries no source category for a contract line legacy categorized.'
          : 'The two authorities report different source categories for the same contract line.',
        explanation: `Source category for "${pricingKey}" is ${String(left.category)} under legacy `
          + `and ${String(right.category)} under canonical.`,
        evidenceReferences: [...pricingEvidence(left), ...pricingEvidence(right)],
      }));
    }

    // ── Unit ──────────────────────────────────────────────────────────────
    // Only the equivalence class is compared. `Each` versus `EA` and `Cubic Yard`
    // versus `CY` resolve to one class and are reported as an expected
    // representational difference, not as a pricing change.
    if (left.unitClass !== right.unitClass) {
      deltas.push(finalize({
        domain: 'pricing',
        entityKey: pricingKey,
        field: 'unitClass',
        legacyValue: left.unitClass,
        canonicalValue: right.unitClass,
        classification: 'unclassified',
        materiality: 'blocking',
        classificationRationale: 'The two authorities price this line in units that are not in the '
          + 'same approved equivalence class, so the rates are not directly comparable.',
        explanation: `Unit for "${pricingKey}" is "${String(left.unit)}" (class `
          + `${String(left.unitClass)}) under legacy and "${String(right.unit)}" (class `
          + `${String(right.unitClass)}) under canonical.`,
        evidenceReferences: [...pricingEvidence(left), ...pricingEvidence(right)],
      }));
    } else if (left.unit !== right.unit) {
      deltas.push(finalize({
        domain: 'pricing',
        entityKey: pricingKey,
        field: 'unitSpelling',
        legacyValue: left.unit,
        canonicalValue: right.unit,
        classification: 'equivalent_normalization',
        materiality: 'informational',
        classificationRationale: `"${String(left.unit)}" and "${String(right.unit)}" resolve to the `
          + `same approved unit equivalence class "${String(left.unitClass)}", so they describe the `
          + 'same unit of measure.',
        explanation: `Unit spelling for "${pricingKey}" differs but is equivalent.`,
      }));
    }

    // ── Rate ──────────────────────────────────────────────────────────────
    if (left.rate !== right.rate) {
      const relationshipBacked = right.governingDocumentId != null && !governingEquivalent;
      deltas.push(finalize({
        domain: 'pricing',
        entityKey: pricingKey,
        field: 'rate',
        legacyValue: left.rate,
        canonicalValue: right.rate,
        classification: relationshipBacked
          ? 'canonical_correction_candidate'
          : 'regression_candidate',
        materiality: 'blocking',
        classificationRationale: relationshipBacked
          ? `Canonical sourced this rate from governing document ${right.governingDocumentId} while `
            + `legacy used ${String(left.governingDocumentId)}. The governing relationship is the evidence.`
          : 'The governing rate changed but both authorities name the same governing document, so '
            + 'no relationship evidence explains the change.',
        explanation: `Governing rate for "${pricingKey}" is ${String(left.rate)} under legacy and `
          + `${String(right.rate)} under canonical.`,
        evidenceReferences: [...pricingEvidence(left), ...pricingEvidence(right)],
        affectedAmount: right.rate != null && left.rate != null ? right.rate - left.rate : null,
      }));
    }

    // ── Governing source ──────────────────────────────────────────────────
    if (!governingEquivalent) {
      deltas.push(finalize({
        domain: 'pricing',
        entityKey: pricingKey,
        field: 'governingDocumentId',
        legacyValue: left.governingDocumentId,
        canonicalValue: right.governingDocumentId,
        classification: 'canonical_correction_candidate',
        materiality: 'blocking',
        classificationRationale: 'Canonical selected a different governing document. Governing '
          + 'document selection is a precedence decision and requires operator confirmation against '
          + 'the document family before it can be accepted.',
        explanation: `Governing document for "${pricingKey}" is ${String(left.governingDocumentId)} `
          + `under legacy and ${String(right.governingDocumentId)} under canonical.`,
        evidenceReferences: [...pricingEvidence(left), ...pricingEvidence(right)],
      }));
    }

    // ── Provenance ────────────────────────────────────────────────────────
    // Presence only. Differing internal record ids for one source row are an
    // expected adapter difference; a provenance reference that vanished is not.
    if ((left.provenanceReference == null) !== (right.provenanceReference == null)) {
      const lost = right.provenanceReference == null;
      deltas.push(finalize({
        domain: 'provenance',
        entityKey: pricingKey,
        field: 'provenanceReference',
        legacyValue: left.provenanceReference,
        canonicalValue: right.provenanceReference,
        classification: lost ? 'regression_candidate' : 'canonical_correction_candidate',
        materiality: lost ? 'blocking' : 'informational',
        classificationRationale: lost
          ? 'Canonical lost the governing source provenance for this pricing row.'
          : 'Canonical attached source provenance that legacy did not carry.',
        explanation: lost
          ? `Provenance for "${pricingKey}" is present under legacy and absent under canonical.`
          : `Provenance for "${pricingKey}" is absent under legacy and present under canonical.`,
        evidenceReferences: pricingEvidence(lost ? left : right),
      }));
    }
  }

  return deltas;
}

function pricingSummary(row: NormalizedPricingReference): Record<string, unknown> {
  return {
    governingDocumentId: row.governingDocumentId,
    category: row.category,
    descriptions: row.descriptions,
    unit: row.unit,
    unitClass: row.unitClass,
    rate: row.rate,
    observationCount: row.observationCount,
  };
}

function pricingEvidence(row: NormalizedPricingReference): ComparisonEvidenceReference[] {
  return [{
    kind: 'governing_pricing_row',
    sourceDocumentId: row.governingDocumentId,
    sourceArtifactId: row.sourceArtifactId,
    page: row.sourcePage,
    detail: [row.category, row.descriptions[0] ?? null, row.unit].filter(Boolean).join(' / ') || null,
  }];
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function findingDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas: AuthorityComparisonDelta[] = [];
  const legacyByKey = new Map(legacy.findings.map((finding) => [finding.findingKey, finding]));
  const canonicalByKey = new Map(canonical.findings.map((finding) => [finding.findingKey, finding]));

  for (const findingKey of sortedKeys(legacyByKey, canonicalByKey)) {
    const left = legacyByKey.get(findingKey) ?? null;
    const right = canonicalByKey.get(findingKey) ?? null;

    if (left != null && right == null) {
      deltas.push(finalize({
        domain: 'finding',
        entityKey: findingKey,
        field: 'raised',
        legacyValue: true,
        canonicalValue: false,
        // A finding legacy raised and canonical did not may be canonical
        // resolving the underlying ambiguity — or canonical failing to detect a
        // real problem. Counts cannot distinguish those, so it stays unclassified.
        classification: 'unclassified',
        materiality: 'review_required',
        classificationRationale: 'Canonical did not raise a finding legacy raised. Whether the '
          + 'underlying condition was resolved or merely undetected requires the evidence behind it.',
        explanation: `Legacy raised finding ${left.code} on ${left.affectedIdentity}; canonical did not.`,
        evidenceReferences: findingEvidence(left),
      }));
      continue;
    }

    if (left == null && right != null) {
      deltas.push(finalize({
        domain: 'finding',
        entityKey: findingKey,
        field: 'raised',
        legacyValue: false,
        canonicalValue: true,
        classification: 'canonical_correction_candidate',
        materiality: 'review_required',
        classificationRationale: 'Canonical raised a finding legacy did not, consistent with '
          + 'canonical preserving a condition legacy resolved silently.',
        explanation: `Canonical raised finding ${right.code} on ${right.affectedIdentity}; legacy did not.`,
        evidenceReferences: findingEvidence(right),
      }));
      continue;
    }

    if (left == null || right == null) continue;

    if (left.severity !== right.severity || left.status !== right.status
      || left.blockedReason !== right.blockedReason) {
      deltas.push(finalize({
        domain: 'finding',
        entityKey: findingKey,
        field: 'disposition',
        legacyValue: { severity: left.severity, status: left.status, blockedReason: left.blockedReason },
        canonicalValue: { severity: right.severity, status: right.status, blockedReason: right.blockedReason },
        classification: 'unclassified',
        materiality: 'review_required',
        classificationRationale: 'The same finding carries a different severity, status, or blocked '
          + 'reason under each authority.',
        explanation: `Finding ${left.code} on ${left.affectedIdentity} differs in disposition `
          + 'between authorities.',
        evidenceReferences: findingEvidence(right),
      }));
    }

    if (!sameMembers(left.evidenceSources, right.evidenceSources)) {
      const lost = missingFrom(left.evidenceSources, right.evidenceSources);
      deltas.push(finalize({
        domain: 'provenance',
        entityKey: findingKey,
        field: 'evidenceSources',
        legacyValue: left.evidenceSources,
        canonicalValue: right.evidenceSources,
        classification: lost.length === 0
          ? 'canonical_correction_candidate'
          : canonicalRefusedToAssert(canonical)
            // Canonical withheld the domains those references came from. The
            // evidence was not lost; it was never asserted.
            ? 'authority_policy_difference'
            : 'regression_candidate',
        materiality: lost.length > 0 ? 'review_required' : 'informational',
        classificationRationale: lost.length === 0
          ? 'Canonical attached additional evidence references.'
          : canonicalRefusedToAssert(canonical)
            ? `Canonical reported ${canonical.assemblyStatus} and withheld the truth domains behind `
              + `${String(lost.length)} evidence reference(s) legacy attached.`
            : `Canonical dropped ${String(lost.length)} evidence reference(s) legacy attached to this `
              + 'finding while claiming full authority.',
        explanation: `Evidence references for finding ${left.code} differ between authorities.`,
        evidenceReferences: findingEvidence(right),
      }));
    }
  }

  return deltas;
}

function findingEvidence(
  finding: { readonly code: string; readonly affectedIdentity: string; readonly evidenceSources: readonly string[] },
): ComparisonEvidenceReference[] {
  return [{
    kind: 'finding',
    sourceDocumentId: null,
    sourceArtifactId: null,
    page: null,
    detail: `${finding.code} on ${finding.affectedIdentity}`
      + (finding.evidenceSources.length > 0 ? ` [${finding.evidenceSources.join(', ')}]` : ''),
  }];
}

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

const EXPOSURE_FIELDS = [
  'totalBilledAmount',
  'totalContractSupportedAmount',
  'totalTransactionSupportedAmount',
  'totalFullyReconciledAmount',
  'totalUnreconciledAmount',
  'totalAtRiskAmount',
  'totalRequiresVerificationAmount',
  'unresolvedExposureAmount',
  'blockedExposureAmount',
] as const;

/**
 * Which exposure movements are safety-relevant in which direction.
 *
 * A DECREASE in exposed, at-risk, or unreconciled dollars is the dangerous
 * direction: it means canonical is claiming less financial risk than legacy, and
 * an unexplained reduction in stated risk is exactly what must never pass
 * unreviewed. An increase is conservative and merely informational.
 */
const EXPOSURE_DECREASE_IS_RISKY: ReadonlySet<string> = new Set([
  'totalAtRiskAmount',
  'totalUnreconciledAmount',
  'unresolvedExposureAmount',
]);

function exposureDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas: AuthorityComparisonDelta[] = [];
  const refused = canonicalRefusedToAssert(canonical);

  for (const field of EXPOSURE_FIELDS) {
    const left = legacy.exposure[field];
    const right = canonical.exposure[field];
    if (left === right) continue;
    const riskyDecrease = EXPOSURE_DECREASE_IS_RISKY.has(field) && right < left;
    deltas.push(finalize({
      domain: 'exposure',
      entityKey: 'project',
      field,
      legacyValue: left,
      canonicalValue: right,
      classification: refused
        ? 'authority_policy_difference'
        : riskyDecrease
          ? 'regression_candidate'
          : 'unclassified',
      materiality: riskyDecrease ? 'blocking' : 'review_required',
      classificationRationale: refused
        ? `Canonical reported ${canonical.assemblyStatus} and withheld exposure truth rather than `
          + 'asserting support it could not establish.'
        : riskyDecrease
          ? 'Canonical states less financial risk than legacy with no block or conflict to justify '
            + 'the reduction. A decrease in stated exposure requires evidence.'
          : 'Exposure moved in the conservative direction or in a field with no directional safety rule.',
      explanation: `Exposure ${field} is ${String(left)} under legacy and ${String(right)} under canonical.`,
    }));
  }

  if (legacy.exposure.readinessState !== canonical.exposure.readinessState) {
    const legacyBlocked = legacy.exposure.readinessState !== 'ready';
    const canonicalReady = canonical.exposure.readinessState === 'ready';
    deltas.push(finalize({
      domain: 'exposure',
      entityKey: 'project',
      field: 'readinessState',
      legacyValue: legacy.exposure.readinessState,
      canonicalValue: canonical.exposure.readinessState,
      classification: legacyBlocked && canonicalReady ? 'regression_candidate' : 'unclassified',
      materiality: legacyBlocked && canonicalReady ? 'blocking' : 'review_required',
      classificationRationale: legacyBlocked && canonicalReady
        ? 'Canonical reports the project ready while legacy does not. Readiness may not improve '
          + 'without proven evidence.'
        : 'Readiness state differs between authorities.',
      explanation: `Exposure readiness is ${legacy.exposure.readinessState} under legacy and `
        + `${canonical.exposure.readinessState} under canonical.`,
    }));
  }

  return deltas;
}

// ---------------------------------------------------------------------------
// Clearance
// ---------------------------------------------------------------------------

const CLEARANCE_RANK: Readonly<Record<string, number>> = {
  blocked: 3,
  needs_review: 2,
  approved_with_exceptions: 1,
  approved: 0,
};

function clearanceDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas: AuthorityComparisonDelta[] = [];
  const refused = canonicalRefusedToAssert(canonical);

  if (legacy.clearance.outcome !== canonical.clearance.outcome) {
    const legacyRank = CLEARANCE_RANK[legacy.clearance.outcome] ?? 0;
    const canonicalRank = CLEARANCE_RANK[canonical.clearance.outcome] ?? 0;
    // Clearance LOOSENING is the blocking direction. Canonical clearing what
    // legacy blocked is the single most dangerous divergence in the whole
    // comparison, and it is blocking even when canonical also refused, because a
    // refusal that ends in a clearer gate is self-contradictory.
    const loosened = canonicalRank < legacyRank;
    deltas.push(finalize({
      domain: 'clearance',
      entityKey: 'project',
      field: 'outcome',
      legacyValue: legacy.clearance.outcome,
      canonicalValue: canonical.clearance.outcome,
      classification: loosened
        ? 'regression_candidate'
        : refused
          ? 'authority_policy_difference'
          : 'canonical_correction_candidate',
      materiality: 'blocking',
      classificationRationale: loosened
        ? 'Canonical clears what legacy blocks. Clearance may not improve without proven evidence, '
          + 'so this is treated as a regression candidate until an operator proves otherwise.'
        : refused
          ? `Canonical blocked (${canonical.assemblyStatus}) where legacy cleared, which is the `
            + 'designed refusal to clear unresolved truth.'
          : 'Canonical reached a stricter clearance outcome than legacy, consistent with canonical '
            + 'preserving a condition legacy resolved.',
      explanation: `Clearance outcome is "${legacy.clearance.outcome}" under legacy and `
        + `"${canonical.clearance.outcome}" under canonical.`,
      evidenceReferences: clearanceEvidence(legacy, canonical),
    }));
  }

  if (legacy.clearance.validationStatus !== canonical.clearance.validationStatus) {
    const legacyBlocked = legacy.clearance.validationStatus === 'BLOCKED';
    const canonicalBlocked = canonical.clearance.validationStatus === 'BLOCKED';
    deltas.push(finalize({
      domain: 'clearance',
      entityKey: 'project',
      field: 'validationStatus',
      legacyValue: legacy.clearance.validationStatus,
      canonicalValue: canonical.clearance.validationStatus,
      classification: legacyBlocked && !canonicalBlocked
        ? 'regression_candidate'
        : !legacyBlocked && canonicalBlocked
          ? 'canonical_correction_candidate'
          : 'unclassified',
      materiality: legacyBlocked && !canonicalBlocked ? 'blocking' : 'review_required',
      classificationRationale: legacyBlocked && !canonicalBlocked
        ? 'Canonical unblocks a validation legacy blocked, without proven evidence for the change.'
        : !legacyBlocked && canonicalBlocked
          ? 'Canonical blocks unresolved truth legacy allowed through.'
          : 'Validation status differs without a directional safety rule applying.',
      explanation: `Validation status is ${legacy.clearance.validationStatus} under legacy and `
        + `${canonical.clearance.validationStatus} under canonical.`,
      evidenceReferences: clearanceEvidence(legacy, canonical),
    }));
  }

  if (!sameMembers(legacy.clearance.approvalGateReasons, canonical.clearance.approvalGateReasons)) {
    const lost = missingFrom(
      legacy.clearance.approvalGateReasons,
      canonical.clearance.approvalGateReasons,
    );
    deltas.push(finalize({
      domain: 'clearance',
      entityKey: 'project',
      field: 'approvalGateReasons',
      legacyValue: legacy.clearance.approvalGateReasons,
      canonicalValue: canonical.clearance.approvalGateReasons,
      classification: lost.length > 0 ? 'unclassified' : 'canonical_correction_candidate',
      materiality: 'review_required',
      classificationRationale: lost.length > 0
        ? `Canonical dropped approval gate reason(s): ${lost.join(', ')}.`
        : 'Canonical added approval gate reasons legacy did not raise.',
      explanation: 'Approval gate reasons differ between authorities.',
      evidenceReferences: clearanceEvidence(legacy, canonical),
    }));
  }

  if (!sameMembers(
    legacy.clearance.unresolvedTruthDomains,
    canonical.clearance.unresolvedTruthDomains,
  )) {
    deltas.push(finalize({
      domain: 'authority_coverage',
      entityKey: 'project',
      field: 'unresolvedTruthDomains',
      legacyValue: legacy.clearance.unresolvedTruthDomains,
      canonicalValue: canonical.clearance.unresolvedTruthDomains,
      // Legacy has no per-domain coverage concept at all, so its empty list is a
      // representational absence, not a claim that every domain is resolved.
      classification: legacy.clearance.unresolvedTruthDomains.length === 0
        ? 'authority_policy_difference'
        : 'unclassified',
      materiality: 'review_required',
      classificationRationale: legacy.clearance.unresolvedTruthDomains.length === 0
        ? 'Legacy authority does not track per-domain coverage, so it reports no unresolved domains '
          + 'by construction. Canonical naming blocked domains is the designed behavior.'
        : 'Both authorities named unresolved truth domains and the sets differ.',
      explanation: 'Blocked truth domains differ between authorities.',
    }));
  }

  return deltas;
}

function clearanceEvidence(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): ComparisonEvidenceReference[] {
  return [{
    kind: 'clearance',
    sourceDocumentId: null,
    sourceArtifactId: null,
    page: null,
    detail: `legacy blocking findings=${String(legacy.clearance.blockingFindingCount)}; `
      + `canonical blocking findings=${String(canonical.clearance.blockingFindingCount)}; `
      + `canonical blocked domains=[${canonical.clearance.unresolvedTruthDomains.join(', ')}]`,
  }];
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function provenanceDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas: AuthorityComparisonDelta[] = [];

  const lostDocuments = missingFrom(
    legacy.provenanceSummary.sourceDocumentIds,
    canonical.provenanceSummary.sourceDocumentIds,
  );
  for (const documentId of lostDocuments) {
    deltas.push(finalize({
      domain: 'provenance',
      entityKey: documentId,
      field: 'sourceDocumentPresent',
      legacyValue: true,
      canonicalValue: false,
      classification: canonicalRefusedToAssert(canonical)
        ? 'authority_policy_difference'
        : 'regression_candidate',
      materiality: 'blocking',
      classificationRationale: canonicalRefusedToAssert(canonical)
        ? `Canonical reported ${canonical.assemblyStatus} and withheld records attributed to this document.`
        : 'Canonical attributes no record to a source document legacy used. Source provenance was lost.',
      explanation: `Source document ${documentId} backs records under legacy but none under canonical.`,
      evidenceReferences: evidenceFor(documentId, 'source document no longer attributed'),
    }));
  }

  if (canonical.provenanceSummary.unattributedRecordCount
    > legacy.provenanceSummary.unattributedRecordCount) {
    deltas.push(finalize({
      domain: 'provenance',
      entityKey: 'project',
      field: 'unattributedRecordCount',
      legacyValue: legacy.provenanceSummary.unattributedRecordCount,
      canonicalValue: canonical.provenanceSummary.unattributedRecordCount,
      classification: 'regression_candidate',
      materiality: 'blocking',
      classificationRationale: 'Canonical produced more records that cannot name a source document. '
        + 'Attributability is a canonical requirement, so losing it cannot be a correction.',
      explanation: 'Canonical has more unattributed records than legacy.',
    }));
  }

  return deltas;
}

// ---------------------------------------------------------------------------
// Coverage and internal consistency
// ---------------------------------------------------------------------------

function coverageDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas: AuthorityComparisonDelta[] = [];

  if (legacy.assemblyStatus !== canonical.assemblyStatus) {
    deltas.push(finalize({
      domain: 'authority_coverage',
      entityKey: 'project',
      field: 'assemblyStatus',
      legacyValue: legacy.assemblyStatus,
      canonicalValue: canonical.assemblyStatus,
      // Expected by construction: legacy is always `not_requested`. Recorded as a
      // non-semantic difference so it is visible without adding review noise.
      classification: 'expected_non_semantic_difference',
      materiality: 'informational',
      classificationRationale: 'Legacy authority never attempts canonical assembly, so a differing '
        + 'assembly status is structural rather than a divergence in truth.',
      explanation: `Assembly status is ${legacy.assemblyStatus} under legacy and `
        + `${canonical.assemblyStatus} under canonical.`,
    }));
  }

  // Source snapshot correspondence. Both runs were built from one frozen input,
  // so their source snapshot digests must agree. A mismatch means the comparison
  // did not actually compare one input and nothing downstream can be trusted.
  if (legacy.sourceSnapshotDigest !== canonical.sourceSnapshotDigest) {
    deltas.push(finalize({
      domain: 'authority_coverage',
      entityKey: 'project',
      field: 'sourceSnapshotDigest',
      legacyValue: legacy.sourceSnapshotDigest,
      canonicalValue: canonical.sourceSnapshotDigest,
      classification: 'regression_candidate',
      materiality: 'blocking',
      classificationRationale: 'The two runs report different source snapshot digests. They did not '
        + 'read one shared frozen input, so no delta in this comparison is trustworthy.',
      explanation: 'Source snapshot digests do not correspond between authority runs.',
    }));
  }

  return deltas;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function sortedKeys(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
): readonly string[] {
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort((first, second) => first.localeCompare(second, 'en-US'));
}

/**
 * Builds every delta between two normalized authority runs.
 *
 * Output ordering is deterministic and content-derived: deltas are sorted by
 * `(domain, entityKey, field)`, never by discovery order, so two runs of the same
 * comparison produce byte-identical delta lists.
 */
export function buildAuthorityComparisonDeltas(
  legacy: AuthorityRunSummary,
  canonical: AuthorityRunSummary,
): readonly AuthorityComparisonDelta[] {
  const deltas = [
    ...coverageDeltas(legacy, canonical),
    ...identityDeltas(legacy, canonical),
    ...quantityDeltas(legacy, canonical),
    ...amountDeltas(legacy, canonical),
    ...pricingDeltas(legacy, canonical),
    ...findingDeltas(legacy, canonical),
    ...exposureDeltas(legacy, canonical),
    ...clearanceDeltas(legacy, canonical),
    ...provenanceDeltas(legacy, canonical),
  ];

  // Deduplicate by delta id. Two rules may legitimately observe the same
  // (domain, entityKey, field); the first wins so ordering stays stable and no
  // duplicate id can reach an operator disposition.
  const block = canonicalBlockRootCause(canonical);
  const byId = new Map<string, AuthorityComparisonDelta>();
  for (const delta of deltas) {
    if (!byId.has(delta.deltaId)) byId.set(delta.deltaId, attributeRootCause(delta, block));
  }

  return [...byId.values()].sort((left, right) => (
    `${left.domain}${DELTA_KEY_SEPARATOR}${left.entityKey}${DELTA_KEY_SEPARATOR}${left.field}`.localeCompare(
      `${right.domain}${DELTA_KEY_SEPARATOR}${right.entityKey}${DELTA_KEY_SEPARATOR}${right.field}`,
      'en-US',
    )
  ));
}

/**
 * Domains whose deltas may be attributed to a canonical block.
 *
 * Deliberately excludes `clearance`, `exposure`, `authority_coverage`, and
 * `finding`. Those are the differences an operator must see individually — a
 * clearance change or an exposure movement swept into a block group is exactly the
 * kind of hiding this grouping exists to avoid. They are few in number anyway, so
 * there is no volume argument for collapsing them.
 */
const BLOCK_ATTRIBUTABLE_DOMAINS: ReadonlySet<ComparisonDeltaDomain> = new Set([
  'transaction',
  'invoice',
  'invoice_line',
  'quantity',
  'amount',
  'pricing',
  'provenance',
  'relationship',
]);

/**
 * Attributes a delta to an upstream condition when one provably explains it.
 *
 * Two attributions, both earned rather than assumed:
 *
 *  - A delta already classified `authority_policy_difference` on a refused
 *    canonical run carries that classification *because* canonical refused, so the
 *    refusal is its cause by construction.
 *  - A delta in a block-attributable domain whose canonical side is simply absent
 *    on a refused run is the mechanical shadow of that same refusal.
 *
 * Anything else keeps `independent` and stays a top-level operator item, including
 * every regression on a run where canonical actually established authority.
 */
function attributeRootCause(
  delta: AuthorityComparisonDelta,
  block: { readonly key: string; readonly summary: string } | null,
): AuthorityComparisonDelta {
  if (delta.rootCauseKey !== INDEPENDENT_ROOT_CAUSE) return delta;

  if (delta.domain === 'finding') {
    // Findings group by their rule code. A project with over a thousand ticket-grain
    // conflicts becomes one operator summary with a count and samples, while every
    // distinct conflict keeps its own delta in the machine artifact.
    const code = delta.entityKey.split('|')[0] ?? 'unknown';
    return {
      ...delta,
      rootCauseKey: `finding_code:${code}`,
      rootCauseSummary: `Findings raised under rule ${code}. Each affected entity keeps its own `
        + 'delta in the machine artifact; this entry summarizes the condition.',
    };
  }

  if (block == null) return delta;
  // The domain gate applies to BOTH attribution routes. A clearance or exposure
  // movement is classified `authority_policy_difference` on a blocked run too, but
  // it is exactly the difference an operator must weigh individually — folding it
  // behind an entry that reads "expected consequence of the block" is hiding it.
  if (!BLOCK_ATTRIBUTABLE_DOMAINS.has(delta.domain)) return delta;
  const mechanical = delta.classification === 'authority_policy_difference'
    || delta.canonicalValue == null;
  if (!mechanical) return delta;

  return { ...delta, rootCauseKey: block.key, rootCauseSummary: block.summary };
}

const REPRESENTATIVE_SAMPLE_LIMIT = 5;

function buildGroupId(
  domain: string,
  field: string,
  classification: string,
  materiality: string,
  rootCauseKey: string,
): string {
  return sha256Hex([domain, field, classification, materiality, rootCauseKey]
    .join(DELTA_KEY_SEPARATOR)).slice(0, 32);
}

/**
 * Collapses deltas into deterministic root-cause groups.
 *
 * Summarizes without discarding: every input delta appears in exactly one group's
 * `dependentDeltaIds`, and the full delta list is retained separately, so the
 * machine artifact keeps per-entity detail while the operator report shows causes.
 */
export function buildAuthorityComparisonDeltaGroups(
  deltas: readonly AuthorityComparisonDelta[],
): readonly AuthorityComparisonDeltaGroup[] {
  const buckets = new Map<string, AuthorityComparisonDelta[]>();
  for (const delta of deltas) {
    const bucketKey = [
      delta.domain,
      delta.field,
      delta.classification,
      delta.materiality,
      delta.rootCauseKey,
    ].join(DELTA_KEY_SEPARATOR);
    buckets.set(bucketKey, [...(buckets.get(bucketKey) ?? []), delta]);
  }

  return [...buckets.values()]
    .map((members) => {
      const ordered = [...members].sort(
        (left, right) => left.deltaId.localeCompare(right.deltaId, 'en-US'),
      );
      const first = ordered[0]!;
      const amounts = ordered
        .map((delta) => delta.affectedAmount)
        .filter((value): value is number => value != null);
      const entityKeys = [...new Set(ordered.map((delta) => delta.entityKey))]
        .sort((left, right) => left.localeCompare(right, 'en-US'));

      return {
        groupId: buildGroupId(
          first.domain,
          first.field,
          first.classification,
          first.materiality,
          first.rootCauseKey,
        ),
        // The lexicographically smallest member, so the representative does not
        // depend on emission order.
        rootDeltaId: first.deltaId,
        domain: first.domain,
        field: first.field,
        classification: first.classification,
        materiality: first.materiality,
        rootCauseKey: first.rootCauseKey,
        rootCauseSummary: first.rootCauseSummary ?? first.classificationRationale,
        affectedEntityCount: entityKeys.length,
        affectedTransactionCount: ordered.filter(
          (delta) => delta.domain === 'transaction' || delta.entityKey.startsWith('ticket:'),
        ).length,
        affectedInvoiceCount: ordered.filter(
          (delta) => delta.domain === 'invoice' || delta.entityKey.startsWith('invoice:'),
        ).length,
        affectedFindingCount: ordered.filter((delta) => delta.domain === 'finding').length,
        affectedAmount: amounts.length > 0
          ? roundComparisonAmount(amounts.reduce((total, value) => total + value, 0))
          : null,
        representativeEntities: entityKeys.slice(0, REPRESENTATIVE_SAMPLE_LIMIT),
        evidenceReferences: first.evidenceReferences,
        dependentDeltaIds: ordered.map((delta) => delta.deltaId),
      };
    })
    .sort((left, right) => (
      `${left.domain} ${left.field} ${left.rootCauseKey}`.localeCompare(
        `${right.domain} ${right.field} ${right.rootCauseKey}`,
        'en-US',
      )
    ));
}

export function summarizeClassifications(
  deltas: readonly AuthorityComparisonDelta[],
): AuthorityComparisonClassificationSummary {
  const byDomain = new Map<ComparisonDeltaDomain, number>();
  const byClassification = new Map<ComparisonDeltaClassification, number>();
  for (const delta of deltas) {
    byDomain.set(delta.domain, (byDomain.get(delta.domain) ?? 0) + 1);
    byClassification.set(
      delta.classification,
      (byClassification.get(delta.classification) ?? 0) + 1,
    );
  }
  return {
    totalDeltas: deltas.length,
    blockingDeltas: deltas.filter((delta) => delta.materiality === 'blocking').length,
    reviewRequiredDeltas: deltas.filter((delta) => delta.materiality === 'review_required').length,
    informationalDeltas: deltas.filter((delta) => delta.materiality === 'informational').length,
    byDomain: [...byDomain.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((left, right) => left.domain.localeCompare(right.domain, 'en-US')),
    byClassification: [...byClassification.entries()]
      .map(([classification, count]) => ({ classification, count }))
      .sort((left, right) => left.classification.localeCompare(right.classification, 'en-US')),
  };
}
