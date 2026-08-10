/**
 * The legacy-versus-canonical authority shadow comparison contract.
 *
 * This module defines shapes only. It states what a comparison IS, so the
 * normalizer, the delta builder, the report, and the persistence boundary all
 * agree on one representation instead of each inventing its own.
 *
 * Three invariants are encoded in these types rather than left to convention:
 *
 *  1. A comparison is ADVISORY. Nothing here is a validation result, and nothing
 *     here can be consumed as one — `AuthorityRunSummary` deliberately carries
 *     normalized summaries and evidence references, never a `ValidatorResult`.
 *     A caller that wanted to serve a comparison would have nothing to serve.
 *  2. An automated classification is a CANDIDATE. The classification vocabulary
 *     says `canonical_correction_candidate` and `regression_candidate`, never
 *     `correction` or `regression`. Only an operator disposition is a verdict.
 *  3. Both runs describe ONE input. `inputSnapshotDigest` appears once on the
 *     comparison, not once per run, because a comparison across two different
 *     inputs is not a comparison — see `comparisonInputDigest.ts`.
 */

import type { CanonicalAuthorityCoverage } from '@/lib/canonical/authority/canonicalDomainCoverage';
import type {
  CanonicalDuplicateAuthorityDiagnostic,
  ProjectTruthAuthorityMode,
} from '@/lib/canonical/authority/projectTruthAuthorityMode';

import type { PricingObservation } from './pricingObservationAlignment';

export const PROJECT_TRUTH_AUTHORITY_COMPARISON_VERSION = 'authority-comparison-v1';

/**
 * Fixed comparison precision.
 *
 * Both authorities are rounded identically before any value is compared, so a
 * surviving difference is real at this precision and a difference below it is
 * equivalent decimal representation rather than a finding. Rounding both sides
 * is what makes `1.0` and `1.000` compare equal without a special case.
 */
export const COMPARISON_AMOUNT_PRECISION = 2;
export const COMPARISON_QUANTITY_PRECISION = 6;

// ---------------------------------------------------------------------------
// Normalized grain vocabulary
// ---------------------------------------------------------------------------

/**
 * The only grains a comparison aggregates at.
 *
 * `ticket` is the ticket-grain denominator: distinct physical ticket identity,
 * never physical row count. A grain not in this list is not aggregated, because
 * an ad hoc grain is exactly how a ticket-grain quantity gets double-counted.
 */
export type ComparisonGrain =
  | 'project'
  | 'invoice'
  | 'ticket'
  | 'category'
  | 'unit'
  | 'governing_pricing_row';

/**
 * A quantity total at one explicit grain.
 *
 * `distinctTicketCount` and `rowCount` are both preserved and never conflated.
 * When they disagree, repeated physical rows described the same ticket; the
 * quantity total is still ticket-grain. `conflictedIdentityCount` counts
 * identities whose repeated rows disagreed — surfaced, never silently resolved.
 */
export type NormalizedQuantityTotal = {
  readonly grain: ComparisonGrain;
  readonly key: string;
  readonly unit: string | null;
  readonly distinctTicketCount: number;
  readonly rowCount: number;
  readonly quantityTotal: number;
  /**
   * The naive sum across physical rows, with no ticket-grain deduplication.
   *
   * Retained precisely because the comparison applies the same ticket-grain rule
   * to both authorities: without this field, an authority that double-counted
   * repeated physical rows would look identical to one that did not, and the very
   * divergence the shadow phase exists to find would be normalized away. This
   * number is diagnostic evidence, never a billable quantity.
   */
  readonly rowGrainQuantityTotal: number;
  readonly conflictedIdentityCount: number;
};

/** An amount total at one explicit grain. Row-grain or invoice-grain by design. */
export type NormalizedAmountTotal = {
  readonly grain: ComparisonGrain;
  readonly key: string;
  readonly rowCount: number;
  readonly amountTotal: number;
  /** The naive across-rows sum. Diagnostic only — see the quantity counterpart. */
  readonly rowGrainAmountTotal: number;
  readonly conflictedIdentityCount: number;
};

/**
 * One governing pricing row as one authority observed it.
 *
 * `pricingKey` is the AUTHORITY-NEUTRAL semantic identity assigned by
 * `pricingObservationAlignment.ts` — never a per-authority taxonomy slug or raw
 * unit spelling. Two authorities describing the same contract line share this key
 * even when they disagree on category label, unit spelling, or row multiplicity.
 */
export type NormalizedPricingReference = {
  readonly pricingKey: string;
  readonly governingDocumentId: string | null;
  readonly category: string | null;
  readonly description: string | null;
  readonly unit: string | null;
  /** Approved equivalence class, e.g. `Each` and `EA` both yield `ea`. */
  readonly unitClass: string | null;
  readonly rate: number | null;
  readonly sourceArtifactId: string | null;
  readonly sourcePage: number | null;
  readonly provenanceReference: string | null;
  /**
   * Observations this authority produced for this one contract line.
   *
   * Greater than one means the authority loaded the same line more than once. That
   * is reported as multiplicity rather than as extra pricing rows, so a
   * deduplicating authority is never mistaken for one that lost rows.
   */
  readonly observationCount: number;
  readonly distinctSourceCount: number;
  /** Every distinct description observed. Compared, never part of identity. */
  readonly descriptions: readonly string[];
  /** True when no observation carries a billing key, so the row is unmatchable. */
  readonly billingKeyLost: boolean;
};

/**
 * Identity and count truth for one authority run.
 *
 * Counts and identity lists are both retained: a count difference says something
 * changed, and the identity lists say exactly which records appeared or vanished.
 * A comparison that reported only counts could not tell an operator what was lost.
 */
export type NormalizedIdentitySummary = {
  readonly invoiceIdentities: readonly string[];
  readonly invoiceLineIdentities: readonly string[];
  readonly transactionIdentities: readonly string[];
  readonly duplicateIdentities: readonly string[];
  readonly unresolvedIdentities: readonly string[];
};

export type NormalizedFindingSummary = {
  readonly total: number;
  readonly open: number;
  readonly blocking: number;
  readonly reviewRequired: number;
  readonly informational: number;
  /** Count per finding code, sorted by code. */
  readonly byCode: readonly { readonly code: string; readonly count: number }[];
};

/**
 * One finding reduced to stable semantic identity.
 *
 * `findingKey` is derived from code, affected identity, and field — never from a
 * runtime id or an array position — so the same semantic finding produced by two
 * authorities compares equal.
 */
export type NormalizedFindingReference = {
  readonly findingKey: string;
  readonly code: string;
  readonly affectedIdentity: string;
  readonly severity: string;
  readonly status: string;
  readonly blockedReason: string | null;
  readonly evidenceSources: readonly string[];
};

export type NormalizedInvoiceExposure = {
  readonly invoiceNumber: string | null;
  readonly billedAmount: number | null;
  readonly billedAmountSource: string;
  readonly supportedAmount: number;
  readonly unreconciledAmount: number;
  readonly atRiskAmount: number;
  readonly reconciliationStatus: string;
};

export type NormalizedExposureSummary = {
  readonly totalBilledAmount: number;
  readonly totalContractSupportedAmount: number;
  readonly totalTransactionSupportedAmount: number;
  readonly totalFullyReconciledAmount: number;
  readonly totalUnreconciledAmount: number;
  readonly totalAtRiskAmount: number;
  readonly totalRequiresVerificationAmount: number;
  /** Exposure that could not be attributed to contract or transaction support. */
  readonly unresolvedExposureAmount: number;
  /** Exposure withheld because an authority refused to assert support. */
  readonly blockedExposureAmount: number;
  readonly readinessState: 'ready' | 'at_risk' | 'unresolved' | 'absent';
  readonly invoices: readonly NormalizedInvoiceExposure[];
};

export type NormalizedClearanceSummary = {
  readonly outcome: string;
  readonly validationStatus: string;
  readonly blockingFindingCount: number;
  readonly reviewFindingCount: number;
  readonly unresolvedTruthDomains: readonly string[];
  readonly approvalGateReasons: readonly string[];
};

export type NormalizedProvenanceReference = {
  readonly recordKind: 'invoice' | 'invoice_line' | 'transaction' | 'pricing';
  readonly recordKey: string;
  readonly sourceArtifactId: string | null;
  readonly sourceDocumentId: string | null;
  readonly page: number | null;
  /**
   * Whether geometry accompanied the record. Geometry itself is not compared:
   * its presence is the auditable fact, and its coordinates are noise across
   * adapters. Attributability is required; geometry is not.
   */
  readonly geometryPresent: boolean;
  readonly adapterIdentity: string | null;
  readonly governingRelationshipEvidence: readonly string[];
};

export type NormalizedProvenanceSummary = {
  readonly attributedRecordCount: number;
  readonly unattributedRecordCount: number;
  readonly sourceDocumentIds: readonly string[];
  readonly sourceArtifactIds: readonly string[];
  readonly references: readonly NormalizedProvenanceReference[];
};

// ---------------------------------------------------------------------------
// Per-authority run summary
// ---------------------------------------------------------------------------

/**
 * One authority's normalized outcome.
 *
 * Deliberately NOT a `ValidatorResult`. Raw validator payloads are not
 * duplicated here: an operator needs stable summaries and evidence references,
 * and a stored duplicate of the serving payload would invite a reader to treat
 * the comparison artifact as truth.
 */
export type AuthorityRunSummary = {
  readonly authorityMode: ProjectTruthAuthorityMode;

  readonly registryDigest: string | null;
  readonly registryPresent: boolean;
  readonly validatorProjectionState: 'present' | 'withheld' | 'not_requested';
  readonly sourceSnapshotDigest: string | null;

  readonly authorityCoverage: CanonicalAuthorityCoverage | null;
  readonly assemblyStatus: string;
  readonly blockedTruthDomains: readonly string[];
  readonly blockReason: string | null;
  readonly authorityBlockSourceGaps: readonly string[];
  readonly duplicateAuthorityDiagnostics: readonly CanonicalDuplicateAuthorityDiagnostic[];
  readonly retainedPricingRowCount: number;
  readonly retainedPricingDocumentIds: readonly string[];

  readonly invoiceCount: number;
  readonly invoiceLineCount: number;
  readonly transactionCount: number;

  readonly identities: NormalizedIdentitySummary;
  readonly quantityTotals: readonly NormalizedQuantityTotal[];
  readonly amountTotals: readonly NormalizedAmountTotal[];
  /**
   * Governing pricing keyed by AUTHORITY-NEUTRAL semantic identity.
   *
   * Populated only after both runs are normalized, because alignment is inherently
   * cross-authority: no per-item key can express "two legacy rows and one canonical
   * row are the same contract line". Empty until `applyPricingAlignment` runs.
   */
  readonly governingPricing: readonly NormalizedPricingReference[];
  /**
   * This authority's raw pricing observations, before alignment.
   *
   * Retained so the machine artifact keeps every observation an authority made,
   * including duplicates a deduplicating counterpart collapsed. Alignment summarizes;
   * it must never be the only surviving record.
   */
  readonly pricingObservations: readonly PricingObservation[];

  readonly findingSummary: NormalizedFindingSummary;
  readonly findings: readonly NormalizedFindingReference[];

  readonly exposure: NormalizedExposureSummary;
  readonly clearance: NormalizedClearanceSummary;

  readonly provenanceSummary: NormalizedProvenanceSummary;
};

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export type ComparisonDeltaDomain =
  | 'pricing'
  | 'invoice'
  | 'invoice_line'
  | 'transaction'
  | 'quantity'
  | 'amount'
  | 'relationship'
  | 'provenance'
  | 'finding'
  | 'exposure'
  | 'clearance'
  | 'authority_coverage';

/**
 * What an automated pass believes about one difference.
 *
 * Every value that could be mistaken for a verdict is named `_candidate`. The
 * comparator is allowed to notice that canonical looks correct; it is not allowed
 * to conclude it. `unclassified` is an honest outcome and must stay reachable —
 * forcing every delta into a category would manufacture confidence.
 */
export type ComparisonDeltaClassification =
  | 'equivalent_normalization'
  | 'canonical_correction_candidate'
  | 'regression_candidate'
  | 'source_gap'
  | 'authority_policy_difference'
  | 'expected_non_semantic_difference'
  | 'unclassified';

export type ComparisonDeltaMateriality =
  | 'informational'
  | 'review_required'
  | 'blocking';

export type ComparisonEvidenceReference = {
  readonly kind: string;
  readonly sourceDocumentId: string | null;
  readonly sourceArtifactId: string | null;
  readonly page: number | null;
  readonly detail: string | null;
};

export type AuthorityComparisonDelta = {
  /** Deterministic: a digest of domain, entity key, and field. Never positional. */
  readonly deltaId: string;
  readonly domain: ComparisonDeltaDomain;
  readonly entityKey: string;
  readonly field: string;
  readonly legacyValue: unknown;
  readonly canonicalValue: unknown;
  readonly classification: ComparisonDeltaClassification;
  readonly materiality: ComparisonDeltaMateriality;
  /** Why the automated pass chose this classification, in operator language. */
  readonly classificationRationale: string;
  /** Plain-language statement of what differs and why it matters. */
  readonly explanation: string;
  readonly evidenceReferences: readonly ComparisonEvidenceReference[];
  /**
   * The upstream condition this delta descends from, or `independent`.
   *
   * Only a provable mechanical consequence carries a non-independent key, so an
   * unexplained regression can never be collapsed into somebody else's group.
   */
  readonly rootCauseKey: string;
  readonly rootCauseSummary: string | null;
  /** Dollar magnitude this delta accounts for, when it has one. */
  readonly affectedAmount: number | null;
};

export type AuthorityComparisonClassificationSummary = {
  readonly totalDeltas: number;
  readonly blockingDeltas: number;
  readonly reviewRequiredDeltas: number;
  readonly informationalDeltas: number;
  readonly byDomain: readonly {
    readonly domain: ComparisonDeltaDomain;
    readonly count: number;
  }[];
  readonly byClassification: readonly {
    readonly classification: ComparisonDeltaClassification;
    readonly count: number;
  }[];
};

/**
 * A set of deltas that are provably consequences of one upstream condition.
 *
 * Exists because the first production cohort produced 11,364 deltas on one project
 * and 8,161 on another, of which the overwhelming majority were one mechanical
 * shape repeated once per ticket — all downstream of a single blocked truth domain.
 * An operator asked to read 5,124 blocking items reads none of them.
 *
 * Grouping SUMMARIZES; it never discards. Every dependent delta keeps its own id and
 * stays in `ProjectTruthAuthorityComparison.deltas`, so the machine artifact retains
 * full per-entity detail while the operator report shows root causes with counts.
 */
export type AuthorityComparisonDeltaGroup = {
  /** Deterministic: derived from the root cause and the delta shape, never positional. */
  readonly groupId: string;
  /** The delta chosen to represent the group. Always a real member. */
  readonly rootDeltaId: string;
  readonly domain: ComparisonDeltaDomain;
  readonly field: string;
  readonly classification: ComparisonDeltaClassification;
  readonly materiality: ComparisonDeltaMateriality;
  /**
   * What all members descend from — e.g. `canonical_block:transactions`. `independent`
   * marks a group that is not downstream of anything, so it is never collapsed away.
   */
  readonly rootCauseKey: string;
  readonly rootCauseSummary: string;

  readonly affectedEntityCount: number;
  readonly affectedTransactionCount: number;
  readonly affectedInvoiceCount: number;
  readonly affectedFindingCount: number;
  readonly affectedAmount: number | null;

  /** A bounded, deterministic sample. Full membership is in `dependentDeltaIds`. */
  readonly representativeEntities: readonly string[];
  readonly evidenceReferences: readonly ComparisonEvidenceReference[];
  readonly dependentDeltaIds: readonly string[];
};

export type ComparisonStatus =
  | 'equivalent'
  | 'material_delta'
  | 'canonical_blocked'
  | 'comparison_failed';

/**
 * An operator's verdict on one delta.
 *
 * Recorded as audit metadata alongside the comparison. Applying a disposition
 * never rewrites canonical truth, never changes a validation result, and never
 * changes which authority serves — see `authorityComparisonPersistence.ts`.
 */
export type OperatorDeltaDisposition =
  | 'canonical_correction'
  | 'canonical_regression'
  | 'expected_policy_difference'
  | 'source_gap'
  | 'needs_more_evidence'
  | 'accepted_equivalent';

export type OperatorDispositionRecord = {
  readonly deltaId: string;
  readonly disposition: OperatorDeltaDisposition;
  readonly note: string | null;
  readonly recordedBy: string | null;
  readonly recordedAt: string;
};

export type OperatorDispositionSummary = {
  readonly recordedCount: number;
  readonly outstandingCount: number;
  readonly byDisposition: readonly {
    readonly disposition: OperatorDeltaDisposition;
    readonly count: number;
  }[];
};

export type ProjectTruthAuthorityComparison = {
  readonly comparisonVersion: string;
  readonly projectId: string;

  readonly inputSnapshotDigest: string;

  readonly legacy: AuthorityRunSummary;
  readonly canonical: AuthorityRunSummary;

  /** Full per-entity detail. Never collapsed — this is the machine artifact. */
  readonly deltas: readonly AuthorityComparisonDelta[];
  /** The operator-facing view: root causes with impact counts. */
  readonly deltaGroups: readonly AuthorityComparisonDeltaGroup[];
  readonly classificationSummary: AuthorityComparisonClassificationSummary;

  readonly comparisonStatus: ComparisonStatus;

  /**
   * Why the comparison itself could not complete, when it could not.
   *
   * Present only for `comparison_failed`. A comparator fault is recorded here
   * and never allowed to reach the serving validation result.
   */
  readonly failureReason: string | null;

  readonly operatorDispositions: readonly OperatorDispositionRecord[];
  readonly operatorDispositionSummary: OperatorDispositionSummary;

  /** Runtime wall-clock. Excluded from every digest and from determinism checks. */
  readonly createdAt: string;
};

/**
 * A comparison that could not run.
 *
 * Constructed instead of throwing so a comparator fault still produces an
 * honest, persistable record. The two run summaries are absent because there is
 * nothing truthful to put in them.
 */
export type FailedAuthorityComparison = {
  readonly comparisonVersion: string;
  readonly projectId: string;
  readonly inputSnapshotDigest: string | null;
  readonly comparisonStatus: 'comparison_failed';
  readonly failureReason: string;
  readonly createdAt: string;
};

export type AuthorityComparisonOutcome =
  | ProjectTruthAuthorityComparison
  | FailedAuthorityComparison;

export function isFailedComparison(
  outcome: AuthorityComparisonOutcome,
): outcome is FailedAuthorityComparison {
  return outcome.comparisonStatus === 'comparison_failed'
    && !('legacy' in outcome);
}

/** Rounds a comparison amount so equivalent decimal forms compare equal. */
export function roundComparisonAmount(value: number): number {
  return roundTo(value, COMPARISON_AMOUNT_PRECISION);
}

/** Rounds a comparison quantity so equivalent decimal forms compare equal. */
export function roundComparisonQuantity(value: number): number {
  return roundTo(value, COMPARISON_QUANTITY_PRECISION);
}

function roundTo(value: number, precision: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  // `Math.round` on a scaled value, then unscaled. `+0` normalizes -0, which
  // would otherwise produce a spurious delta against 0 in a strict comparison.
  return (Math.round(value * factor) / factor) + 0;
}
