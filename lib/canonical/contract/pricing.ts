/**
 * Canonical contract pricing domain model.
 *
 * Two objects, deliberately separate:
 *
 *   1. `CanonicalContractPricingCandidate` — an evidence-preserving intermediate.
 *      Everything an adapter observed, in as-observed form. No resolution
 *      judgement. Nothing dropped. This is the object that guarantees an
 *      unresolved row does not silently disappear.
 *
 *   2. `CanonicalContractPricingRow` — the resolved row. Field-level truth is
 *      carried in `TruthEnvelope<T>`; mechanical identifiers are not enveloped.
 *
 * Neither object names a document, a page number, a category list, a table id,
 * or a filename. Source-family identity is PRESERVED as opaque data
 * (`CanonicalPricingSourceFamily`) so provenance is auditable, but no code in
 * `lib/canonical/**` branches on its value.
 *
 * Additive and unreachable from production in this slice.
 */

import type {
  CanonicalEffectivePeriod,
  CanonicalEvidenceRef,
  CanonicalPrecedenceRef,
  TruthEnvelope,
} from '@/lib/canonical/truth/envelope';
import type {
  CanonicalRouteKind,
  ParsedDistanceBand,
  ParsedPricingDimensions,
} from '@/lib/contracts/pricingDimensions';

// ─── Shared references ───────────────────────────────────────────────────────

export type CanonicalGoverningDocumentRef = {
  readonly documentId: string;
  /** Free-form family label. Canonical code must not branch on it. */
  readonly family: string | null;
  readonly title: string | null;
};

export type CanonicalRateScheduleRef = {
  /** Stable within a document; the adapter does not invent one. */
  readonly scheduleId: string | null;
  /** Human-readable schedule label. Null when the source did not name one. */
  readonly scheduleName: string | null;
};

/**
 * Adapter / source-family identity, preserved verbatim.
 *
 * `sourceKind` and `sourceQuality` come straight from the upstream assembler.
 * They exist so an auditor can see WHICH path produced a row. They are
 * explicitly NOT authority: no resolution or approval rule reads them.
 */
export type CanonicalPricingSourceFamily = {
  /** Identifier of the adapter that produced the candidate. */
  readonly adapterId: string;
  /** Upstream `sourceKind`, opaque. Never branched on. */
  readonly sourceKind: string | null;
  /** Upstream `sourceQuality`, opaque. Never branched on. */
  readonly sourceQuality: string | null;
};

/**
 * Mirror of the assembler's merge diagnostic, so the canonical model does not
 * depend on `lib/contracts/contractPricingAssembly.ts`. Only the adapter knows
 * about the assembler's types.
 */
export type CanonicalPricingMergeDiagnostic = {
  readonly droppedRowId: string;
  readonly droppedSourceKind: string | null;
  readonly droppedSourceAnchor: string | null;
  readonly droppedRate: number | null;
  readonly droppedDescription: string | null;
  readonly droppedQualityScore: number | null;
  readonly winningRowId: string;
  readonly winningQualityScore: number | null;
  readonly reason: string;
  readonly comparisonMethod: string;
};

/** Raw authored values, retained so canonical interpretation never destroys them. */
export type CanonicalPricingRawValues = {
  readonly description: string | null;
  readonly rawText: string | null;
  readonly rawCells: readonly string[];
  readonly quantityText: string | null;
};

/**
 * Structural pricing-content classification.
 *
 * The ONLY generic predicate applied: a candidate bearing zero pricing-bearing
 * dimensions (no rate, unit, quantity, total, rate code, pass-through state,
 * and no category) carries no pricing content. That is a structural statement
 * about the record, not a business rule about any document family.
 */
export type CanonicalPricingContent = 'pricing' | 'non_pricing';

// ─── Candidate ───────────────────────────────────────────────────────────────

/**
 * Evidence-preserving intermediate. One candidate per adapter input row,
 * always — the adapter never filters.
 *
 * Most fields are nullable and stay null when the source did not carry them.
 * Absent fields are NOT filled, and a missing field is never promoted to
 * "not applicable" without evidence.
 */
export type CanonicalContractPricingCandidate = {
  readonly candidateId: string;
  /** Position in the adapter's input. Preserved for deterministic ordering. */
  readonly ordinal: number;

  readonly rateSchedule: CanonicalRateScheduleRef | null;
  readonly governingDocument: CanonicalGoverningDocumentRef | null;

  // ── operator-facing core ──
  readonly rateCode: string | null;
  readonly category: string | null;
  readonly subcategory: string | null;
  readonly description: string | null;
  /**
   * The description as the source published it, before assembly's display
   * cleanup. Unlike `description`, this is never the `Raw row needs review`
   * sentinel and is never recovered from raw text or a neighbouring row.
   * `null` means the source genuinely published none — it is not a signal to
   * fall back to the display value.
   */
  readonly sourceDescription: string | null;
  /** Deterministic display/search normalization. NOT a billing match key. */
  readonly normalizedDescription: string | null;
  readonly unit: string | null;
  readonly rate: number | null;
  readonly currency: string | null;

  // ── conditional dimensions ──
  readonly pricingMethod: string | null;
  readonly materialType: string | null;
  readonly serviceType: string | null;
  readonly origin: string | null;
  readonly destination: string | null;
  readonly route: string | null;
  readonly distanceBand: string | null;
  readonly pricingDimensions: ParsedPricingDimensions | null;
  readonly pricingDimensionSources: {
    readonly route: 'structured' | 'source_text' | 'authored_correction' | 'unresolved';
    readonly distance: 'structured' | 'source_text' | 'authored_correction' | 'unresolved';
  } | null;
  readonly equipmentType: string | null;
  readonly personnelClassification: string | null;
  readonly sizeOrDiameterBand: string | null;

  // ── schedule-carried amounts (only when the source schedule holds them) ──
  readonly quantity: number | null;
  readonly totalAmount: number | null;

  // ── commercial terms ──
  readonly passThrough: boolean | null;
  readonly markup: number | null;
  readonly minimumCharge: number | null;
  readonly maximumOrNteAmount: number | null;
  readonly effectivePeriod: CanonicalEffectivePeriod | null;
  readonly applicabilityConditions: readonly string[];
  readonly exclusions: readonly string[];

  // ── provenance ──
  readonly sourceFamily: CanonicalPricingSourceFamily;
  readonly rawValues: CanonicalPricingRawValues;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly mergeDiagnostics: readonly CanonicalPricingMergeDiagnostic[];
  /** True when an upstream rule authored a displayed value. Approval-relevant. */
  readonly authoredCorrection: boolean;
  /**
   * Upstream qualitative confidence label preserved verbatim
   * (e.g. 'high' | 'medium' | 'low' | 'needs_review'). Never converted to a
   * number — the upstream label has no calibrated numeric meaning.
   */
  readonly extractionConfidenceLabel: string | null;
  /** Upstream description recovery succeeded, but the source row still requires review. */
  /** Measured numeric confidence, 0..1. Null when nothing measured it. */
  readonly observedConfidence: number | null;

  readonly pricingContent: CanonicalPricingContent;
};

// ─── Resolved row ────────────────────────────────────────────────────────────

export type CanonicalPricingDisplayGroup =
  | 'resolved_pricing'
  | 'needs_review'
  | 'excluded';

export type CanonicalPricingRowState =
  | 'resolved'
  | 'derived'
  | 'unresolved_mapping'
  | 'extraction_conflict'
  | 'precedence_conflict'
  | 'not_applicable'
  | 'non_pricing'
  | 'requires_review';

export type CanonicalPricingUnresolvedReason =
  | 'category_unresolved'
  | 'description_unresolved'
  | 'unit_unresolved'
  | 'rate_unresolved'
  | 'governing_source_missing'
  | 'evidence_incomplete'
  | 'extraction_conflict'
  | 'precedence_conflict'
  | 'authored_value_correction'
  | 'no_pricing_content';

export type CanonicalPricingEvidenceCompleteness = {
  /** At least one locatable reference exists for the row. */
  readonly hasLocatableEvidence: boolean;
  /** Every value-bearing operator-facing field has locatable evidence. */
  readonly coreFieldsBacked: boolean;
  readonly evidenceRefCount: number;
  /** Core fields whose value exists but has no locatable evidence. */
  readonly unbackedFieldKeys: readonly string[];
};

export type CanonicalPricingApprovalEligibility = {
  readonly eligible: boolean;
  readonly blockers: readonly CanonicalPricingUnresolvedReason[];
};

export type CanonicalPricingResolution = {
  readonly state: CanonicalPricingRowState;
  readonly displayGroup: CanonicalPricingDisplayGroup;
  readonly unresolvedReasons: readonly CanonicalPricingUnresolvedReason[];
  readonly approval: CanonicalPricingApprovalEligibility;
  readonly evidenceCompleteness: CanonicalPricingEvidenceCompleteness;
};

/**
 * The resolved canonical pricing row.
 *
 * Enveloped: fields where a genuine truth decision exists.
 * Not enveloped: mechanical identifiers, ordering, and preserved provenance —
 * there is no truth decision in a row id.
 */
export type CanonicalContractPricingRow = {
  // ── mechanical, not enveloped ──
  readonly rowId: string;
  readonly candidateId: string;
  /**
   * Source-published description, carried verbatim. Not enveloped: it is an
   * observation copied through, not a truth decision canonical resolution
   * makes. Semantic identity (billing and description-match keys) is built
   * from this, never from the enveloped `description`, which may hold the
   * operator-facing `Raw row needs review` sentinel.
   */
  readonly sourceDescription: string | null;
  readonly ordinal: number;
  readonly sourceFamily: CanonicalPricingSourceFamily;
  readonly mergeDiagnostics: readonly CanonicalPricingMergeDiagnostic[];
  readonly authoredCorrection: boolean;
  readonly rawValues: CanonicalPricingRawValues;

  // ── operator-facing core (always enveloped) ──
  readonly rateSchedule: TruthEnvelope<CanonicalRateScheduleRef>;
  readonly category: TruthEnvelope<string>;
  readonly description: TruthEnvelope<string>;
  readonly unit: TruthEnvelope<string>;
  readonly rate: TruthEnvelope<number>;

  // ── conditional dimensions (enveloped: presence is a truth decision) ──
  readonly rateCode: TruthEnvelope<string>;
  readonly subcategory: TruthEnvelope<string>;
  readonly currency: TruthEnvelope<string>;
  readonly pricingMethod: TruthEnvelope<string>;
  readonly materialType: TruthEnvelope<string>;
  readonly serviceType: TruthEnvelope<string>;
  readonly origin: TruthEnvelope<string>;
  readonly destination: TruthEnvelope<string>;
  readonly route: TruthEnvelope<string>;
  readonly distanceBand: TruthEnvelope<string>;
  readonly routeKind: TruthEnvelope<CanonicalRouteKind>;
  readonly distanceInterval: TruthEnvelope<ParsedDistanceBand>;
  readonly routeRawSpan: TruthEnvelope<string>;
  readonly distanceRawExpression: TruthEnvelope<string>;
  readonly equipmentType: TruthEnvelope<string>;
  readonly personnelClassification: TruthEnvelope<string>;
  readonly sizeOrDiameterBand: TruthEnvelope<string>;
  readonly quantity: TruthEnvelope<number>;
  readonly totalAmount: TruthEnvelope<number>;
  readonly passThrough: TruthEnvelope<boolean>;
  readonly markup: TruthEnvelope<number>;
  readonly minimumCharge: TruthEnvelope<number>;
  readonly maximumOrNteAmount: TruthEnvelope<number>;
  readonly effectivePeriod: TruthEnvelope<CanonicalEffectivePeriod>;
  readonly applicabilityConditions: TruthEnvelope<readonly string[]>;
  readonly exclusions: TruthEnvelope<readonly string[]>;

  // ── governance and resolution ──
  readonly governingDocument: CanonicalGoverningDocumentRef | null;
  readonly precedence: CanonicalPrecedenceRef | null;
  readonly resolution: CanonicalPricingResolution;
};

/**
 * A schedule groups rows and reports recovery honestly.
 *
 * `coverage` is the anti-silent-loss contract: `candidateCount` must equal
 * `resolvedCount + needsReviewCount + excludedCount` for every schedule.
 */
export type CanonicalContractPricingSchedule = {
  readonly scheduleId: string | null;
  readonly scheduleName: string | null;
  readonly governingDocument: CanonicalGoverningDocumentRef | null;
  readonly rows: readonly CanonicalContractPricingRow[];
  readonly coverage: {
    readonly candidateCount: number;
    readonly resolvedCount: number;
    readonly needsReviewCount: number;
    readonly excludedCount: number;
  };
};

// ─── Pure field helpers ──────────────────────────────────────────────────────

/**
 * Deterministic display/search normalization.
 *
 * Explicitly NOT a billing match key: `lib/validator/billingKeys.ts` remains the
 * single source of truth for reconciliation keys. Duplicating that logic here
 * would create the parallel truth path this architecture forbids.
 */
export function normalizeCanonicalDescription(value: string | null): string | null {
  if (value == null) return null;
  const normalized = value
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** Operator-facing core field keys, in display order. */
export const CANONICAL_PRICING_CORE_FIELDS = [
  'rateSchedule',
  'category',
  'description',
  'unit',
  'rate',
] as const;
