/**
 * Canonical pricing resolution.
 *
 * Declarative and intentionally minimal. This slice establishes the STATE
 * MACHINE and the approval gate, not business resolution logic. Every rule
 * below is structural: none reads a category list, a page number, a table id, a
 * filename, or a source-family name.
 *
 * Product decisions encoded here:
 *
 *   - Unresolved rows are never dropped. They resolve to a needs-review or
 *     excluded state and remain addressable, but they never enter the
 *     authoritative `resolved_pricing` group.
 *
 *   - A row is approval-eligible only after canonical resolution confirms a
 *     governing source, evidence completeness, description/scope, unit where
 *     applicable, rate where applicable, no extraction conflict, and no
 *     unresolved precedence conflict. Successful extraction by a source-specific
 *     or authored adapter confers no eligibility on its own.
 *
 * Additive and unreachable from production in this slice.
 */

import {
  absentFromSource,
  canonicalEvidenceRef,
  derivedValue,
  extractionConflict as extractionConflictEnvelope,
  hasCanonicalValue,
  hasLocatableEvidence,
  isSettled,
  precedenceConflict as precedenceConflictEnvelope,
  resolvedValue,
  requiresReview,
  unresolvedMapping,
  type CanonicalEvidenceRef,
  type CanonicalPrecedenceRef,
  type TruthEnvelope,
} from '@/lib/canonical/truth/envelope';
import type { PricingDimensionParseState } from '@/lib/contracts/pricingDimensions';
import {
  CANONICAL_PRICING_CORE_FIELDS,
  type CanonicalContractPricingCandidate,
  type CanonicalContractPricingRow,
  type CanonicalContractPricingSchedule,
  type CanonicalPricingApprovalEligibility,
  type CanonicalPricingDisplayGroup,
  type CanonicalPricingEvidenceCompleteness,
  type CanonicalPricingResolution,
  type CanonicalPricingRowState,
  type CanonicalPricingUnresolvedReason,
  type CanonicalRateScheduleRef,
} from '@/lib/canonical/contract/pricing';

// ─── Display-group classification ────────────────────────────────────────────

const DISPLAY_GROUP_BY_STATE: Readonly<
  Record<CanonicalPricingRowState, CanonicalPricingDisplayGroup>
> = {
  resolved: 'resolved_pricing',
  derived: 'resolved_pricing',
  unresolved_mapping: 'needs_review',
  extraction_conflict: 'needs_review',
  precedence_conflict: 'needs_review',
  requires_review: 'needs_review',
  not_applicable: 'excluded',
  non_pricing: 'excluded',
};

/** Pure. Total over the state union. */
export function classifyDisplayGroup(
  state: CanonicalPricingRowState,
): CanonicalPricingDisplayGroup {
  return DISPLAY_GROUP_BY_STATE[state];
}

// ─── Unresolved-reason normalization ─────────────────────────────────────────

/** Fixed severity order. Determines dedupe output order. */
const UNRESOLVED_REASON_ORDER: readonly CanonicalPricingUnresolvedReason[] = [
  'no_pricing_content',
  'extraction_conflict',
  'precedence_conflict',
  'governing_source_missing',
  'evidence_incomplete',
  'description_unresolved',
  'rate_unresolved',
  'unit_unresolved',
  'category_unresolved',
  'authored_value_correction',
];

/** Pure. Dedupes and returns reasons in fixed severity order. */
export function normalizeUnresolvedReasons(
  reasons: readonly CanonicalPricingUnresolvedReason[],
): readonly CanonicalPricingUnresolvedReason[] {
  const present = new Set(reasons);
  return UNRESOLVED_REASON_ORDER.filter((reason) => present.has(reason));
}

// ─── Approval eligibility ────────────────────────────────────────────────────

type ApprovalInput = {
  readonly state: CanonicalPricingRowState;
  readonly hasGoverningDocument: boolean;
  readonly evidenceCompleteness: CanonicalPricingEvidenceCompleteness;
  readonly descriptionSettled: boolean;
  readonly unitSettled: boolean;
  readonly rateSettled: boolean;
  readonly authoredCorrection: boolean;
};

/**
 * Pure. Approval eligibility is a conjunction of explicit confirmations, so a
 * row is ineligible by default and becomes eligible only by evidence.
 *
 * `unitSettled` / `rateSettled` mean "resolved OR provably not applicable" —
 * this is the "where applicable" clause. A field that is merely missing is not
 * settled and blocks approval.
 */
export function classifyApprovalEligibility(
  input: ApprovalInput,
): CanonicalPricingApprovalEligibility {
  const blockers: CanonicalPricingUnresolvedReason[] = [];

  if (input.state === 'non_pricing' || input.state === 'not_applicable') {
    blockers.push('no_pricing_content');
  }
  if (input.state === 'extraction_conflict') blockers.push('extraction_conflict');
  if (input.state === 'precedence_conflict') blockers.push('precedence_conflict');
  if (!input.hasGoverningDocument) blockers.push('governing_source_missing');
  if (!input.evidenceCompleteness.coreFieldsBacked) blockers.push('evidence_incomplete');
  if (!input.descriptionSettled) blockers.push('description_unresolved');
  if (!input.unitSettled) blockers.push('unit_unresolved');
  if (!input.rateSettled) blockers.push('rate_unresolved');
  // An authored value is not a source-verified value, regardless of which
  // adapter produced it. This is the generic form of the approval-safety rule.
  if (input.authoredCorrection) blockers.push('authored_value_correction');
  // Umbrella gate: only a settled row can ever be approval-eligible.
  if (input.state !== 'resolved' && input.state !== 'derived') {
    if (input.state === 'unresolved_mapping') blockers.push('category_unresolved');
    if (input.state === 'requires_review' && blockers.length === 0) {
      blockers.push('evidence_incomplete');
    }
  }

  const normalized = normalizeUnresolvedReasons(blockers);
  return { eligible: normalized.length === 0, blockers: normalized };
}

// ─── Evidence completeness ───────────────────────────────────────────────────

type CoreEnvelopes = {
  readonly rateSchedule: TruthEnvelope<CanonicalRateScheduleRef>;
  readonly category: TruthEnvelope<string>;
  readonly description: TruthEnvelope<string>;
  readonly unit: TruthEnvelope<string>;
  readonly rate: TruthEnvelope<number>;
};

/**
 * Pure. A core field is "backed" when it either carries no value (nothing to
 * back) or carries a value with at least one locatable evidence reference.
 */
export function classifyEvidenceCompleteness(
  core: CoreEnvelopes,
  evidenceRefCount: number,
): CanonicalPricingEvidenceCompleteness {
  const unbacked: string[] = [];
  for (const key of CANONICAL_PRICING_CORE_FIELDS) {
    const envelope = core[key] as TruthEnvelope<unknown>;
    if (!hasCanonicalValue(envelope)) continue;
    if (!hasLocatableEvidence(envelope)) unbacked.push(key);
  }
  const anyLocatable = CANONICAL_PRICING_CORE_FIELDS.some((key) =>
    hasLocatableEvidence(core[key] as TruthEnvelope<unknown>),
  );
  return {
    hasLocatableEvidence: anyLocatable,
    coreFieldsBacked: unbacked.length === 0 && anyLocatable,
    evidenceRefCount,
    unbackedFieldKeys: unbacked,
  };
}

// ─── Conflict detection ──────────────────────────────────────────────────────

/**
 * Pure and generic. A merge diagnostic records a row discarded in favour of
 * this one. When the discarded reading carried a DIFFERENT rate, the two
 * readings genuinely disagree about a value — an extraction conflict. When the
 * rates agree, the merge was a benign duplicate.
 *
 * This is the only conflict signal available from the current assembler.
 */
export function hasRateDisagreementInMergeDiagnostics(
  candidate: CanonicalContractPricingCandidate,
): boolean {
  return candidate.mergeDiagnostics.some(
    (diagnostic) =>
      diagnostic.droppedRate != null
      && candidate.rate != null
      && diagnostic.droppedRate !== candidate.rate,
  );
}

export type CanonicalPricingResolutionContext = {
  readonly precedence?: CanonicalPrecedenceRef | null;
  /**
   * Non-empty ⇒ two governing documents disagree about this row.
   *
   * Context-supplied only. The current assembler surfaces no precedence signal
   * whatsoever, so nothing can infer this today. Inventing it would be
   * synthetic provenance.
   */
  readonly precedenceConflictEvidence?: readonly CanonicalEvidenceRef[];
  /** Non-empty ⇒ an explicit upstream extraction conflict, beyond merge rates. */
  readonly extractionConflictEvidence?: readonly CanonicalEvidenceRef[];
};

// ─── Row resolution ──────────────────────────────────────────────────────────

/**
 * Envelope for an optional scalar observed by an adapter.
 * A value present ⇒ resolved. A value absent ⇒ absent_from_source.
 * Never `not_applicable`: inapplicability requires evidence, which no adapter
 * input currently provides.
 */
function observedEnvelope<T>(
  value: T | null,
  evidence: readonly CanonicalEvidenceRef[],
  observedRaw: string | null,
): TruthEnvelope<T> {
  if (value == null) {
    return absentFromSource<T>({ supportingEvidence: evidence, observedRaw });
  }
  return resolvedValue<T>(value, {
    governingSource: evidence[0] ?? null,
    supportingEvidence: evidence,
    observedRaw,
    // confidence stays null: no calibrated numeric measurement exists upstream.
  });
}

type DimensionSource = 'structured' | 'source_text' | 'authored_correction' | 'unresolved';

function dimensionEvidence(
  evidence: readonly CanonicalEvidenceRef[],
  rawSpan: string | null,
): readonly CanonicalEvidenceRef[] {
  if (!rawSpan) return evidence;
  return evidence.map((ref) => canonicalEvidenceRef({ ...ref, rawSpan }));
}

function pricingDimensionEnvelope<T>(input: {
  readonly value: T | null;
  readonly source: DimensionSource;
  readonly parseState: PricingDimensionParseState;
  readonly rawSpan: string | null;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly candidateId: string;
  readonly observedRaw: string | null;
}): TruthEnvelope<T> {
  const supportingEvidence = dimensionEvidence(input.evidence, input.rawSpan);
  if (input.parseState === 'ambiguous') {
    return input.value == null
      ? unresolvedMapping<T>({
          supportingEvidence,
          observedRaw: input.observedRaw,
          stateReason: 'pricing_dimension_ambiguous',
        })
      : requiresReview<T>({
          provisionalValue: input.value,
          supportingEvidence,
          observedRaw: input.rawSpan ?? input.observedRaw,
          stateReason: 'pricing_dimension_ambiguous',
        });
  }
  if (input.value == null) {
    return input.parseState === 'unresolved' && input.source !== 'unresolved'
      ? unresolvedMapping<T>({
          supportingEvidence,
          observedRaw: input.observedRaw,
          stateReason: 'pricing_dimension_not_mapped',
        })
      : absentFromSource<T>({ supportingEvidence, observedRaw: input.observedRaw });
  }
  if (input.source === 'structured') {
    return resolvedValue(input.value, {
      governingSource: supportingEvidence[0] ?? null,
      supportingEvidence,
      observedRaw: input.rawSpan ?? input.observedRaw,
    });
  }
  return derivedValue(input.value, {
    ruleId: 'authored_pricing_dimension_interpretation',
    ruleVersion: '1',
    inputs: [{
      provenanceClass: 'machine_extraction',
      canonicalFactId: `${input.candidateId}:description`,
    }],
  }, {
    governingSource: supportingEvidence[0] ?? null,
    supportingEvidence,
    observedRaw: input.rawSpan ?? input.observedRaw,
  });
}

/**
 * Category gets a sharper treatment than other fields because the upstream
 * assembler explicitly attempts category resolution. When the row carries
 * observed text but no category, something WAS seen and could not be mapped —
 * `unresolved_mapping`, which is operator-actionable. When nothing at all was
 * observed, it is plain absence.
 */
function categoryEnvelope(
  candidate: CanonicalContractPricingCandidate,
  evidence: readonly CanonicalEvidenceRef[],
): TruthEnvelope<string> {
  const observedRaw = candidate.rawValues.rawText ?? candidate.rawValues.description;
  if (candidate.category != null) {
    return resolvedValue<string>(candidate.category, {
      governingSource: evidence[0] ?? null,
      supportingEvidence: evidence,
      observedRaw,
    });
  }
  const somethingObserved =
    candidate.rawValues.rawText != null
    || candidate.rawValues.description != null
    || candidate.rawValues.rawCells.length > 0;
  return somethingObserved
    ? unresolvedMapping<string>({
        supportingEvidence: evidence,
        observedRaw,
        stateReason: 'category_not_mapped_from_observed_text',
      })
    : absentFromSource<string>({ supportingEvidence: evidence, observedRaw });
}

/**
 * Resolve one candidate into a canonical pricing row.
 *
 * Rule order (declarative, evaluated top to bottom):
 *   1. `non_pricing`         — zero pricing-bearing dimensions (structural).
 *   2. `extraction_conflict` — readings disagree on a value.
 *   3. `precedence_conflict` — governing documents disagree.
 *   4. `unresolved_mapping`  — observed text could not be mapped to a category.
 *   5. `requires_review`     — a core field is unsettled, or the value was authored.
 *   6. `resolved`            — everything above passed.
 *
 * Extraction conflict precedes precedence conflict because a disputed reading
 * has no settled value for precedence to arbitrate.
 *
 * `derived` and `not_applicable` are reachable states in the model but no rule
 * in this slice produces them: nothing here derives a value, and no adapter
 * input carries evidence of inapplicability.
 */
export function resolveCanonicalPricingRow(
  candidate: CanonicalContractPricingCandidate,
  context: CanonicalPricingResolutionContext = {},
): CanonicalContractPricingRow {
  const evidence = candidate.evidence;
  const rawText = candidate.rawValues.rawText;
  const dimensions = candidate.pricingDimensions;
  const dimensionSources = candidate.pricingDimensionSources;
  const dimensionState = dimensions?.parseState
    ?? (candidate.route != null || candidate.distanceBand != null ? 'explicit' : 'unresolved');
  // Legacy candidates predate typed metadata. Preserve their prior observed
  // treatment; newly assembled rows always carry explicit per-field sources.
  const routeSource = dimensionSources?.route ?? (candidate.route != null ? 'structured' : 'unresolved');
  const distanceSource = dimensionSources?.distance ?? (candidate.distanceBand != null ? 'structured' : 'unresolved');

  const rateSchedule: TruthEnvelope<CanonicalRateScheduleRef> = observedEnvelope(
    candidate.rateSchedule,
    evidence,
    rawText,
  );
  const category = categoryEnvelope(candidate, evidence);
  const description = observedEnvelope(candidate.description, evidence, candidate.rawValues.description);
  const unit = observedEnvelope(candidate.unit, evidence, rawText);
  const baseRate = observedEnvelope(candidate.rate, evidence, rawText);

  const extractionConflicted =
    hasRateDisagreementInMergeDiagnostics(candidate)
    || (context.extractionConflictEvidence?.length ?? 0) > 0;
  const precedenceConflicted = (context.precedenceConflictEvidence?.length ?? 0) > 0;

  // A disputed rate must not present as canonical truth, so the rate envelope
  // is downgraded while the observed reading is retained as provisional.
  const rate: TruthEnvelope<number> = extractionConflicted
    ? extractionConflictEnvelope<number>({
        provisionalValue: candidate.rate,
        supportingEvidence: evidence,
        conflictingEvidence: [
          ...(context.extractionConflictEvidence ?? []),
        ],
        observedRaw: rawText,
        stateReason: 'rate_reading_disagreement',
      })
    : precedenceConflicted
      ? precedenceConflictEnvelope<number>({
          provisionalValue: candidate.rate,
          supportingEvidence: evidence,
          conflictingEvidence: context.precedenceConflictEvidence ?? [],
          precedence: context.precedence ?? null,
          observedRaw: rawText,
          stateReason: 'governing_document_disagreement',
        })
      : baseRate;

  const core: CoreEnvelopes = { rateSchedule, category, description, unit, rate };
  const evidenceCompleteness = classifyEvidenceCompleteness(core, evidence.length);

  const state = resolveRowState({
    candidate,
    extractionConflicted,
    precedenceConflicted,
    categoryState: category.state,
    descriptionSettled: isSettled(description),
    unitSettled: isSettled(unit),
    rateSettled: isSettled(rate),
  });

  const approval = classifyApprovalEligibility({
    state,
    hasGoverningDocument: candidate.governingDocument != null,
    evidenceCompleteness,
    descriptionSettled: isSettled(description),
    unitSettled: isSettled(unit),
    rateSettled: isSettled(rate),
    authoredCorrection: candidate.authoredCorrection,
  });

  const resolution: CanonicalPricingResolution = {
    state,
    displayGroup: classifyDisplayGroup(state),
    unresolvedReasons: approval.blockers,
    approval,
    evidenceCompleteness,
  };

  return {
    rowId: candidate.candidateId,
    candidateId: candidate.candidateId,
    sourceDescription: candidate.sourceDescription,
    ordinal: candidate.ordinal,
    sourceFamily: candidate.sourceFamily,
    mergeDiagnostics: candidate.mergeDiagnostics,
    authoredCorrection: candidate.authoredCorrection,
    rawValues: candidate.rawValues,

    rateSchedule,
    category,
    description,
    unit,
    rate,

    rateCode: observedEnvelope(candidate.rateCode, evidence, rawText),
    subcategory: observedEnvelope(candidate.subcategory, evidence, rawText),
    currency: observedEnvelope(candidate.currency, evidence, rawText),
    pricingMethod: observedEnvelope(candidate.pricingMethod, evidence, rawText),
    materialType: observedEnvelope(candidate.materialType, evidence, rawText),
    serviceType: observedEnvelope(candidate.serviceType, evidence, rawText),
    origin: observedEnvelope(candidate.origin, evidence, rawText),
    destination: observedEnvelope(candidate.destination, evidence, rawText),
    route: pricingDimensionEnvelope({
      value: candidate.route, source: routeSource, parseState: dimensionState,
      rawSpan: dimensions?.routeRawSpan ?? null, evidence, candidateId: candidate.candidateId,
      observedRaw: candidate.rawValues.description,
    }),
    distanceBand: pricingDimensionEnvelope({
      value: candidate.distanceBand, source: distanceSource, parseState: dimensionState,
      rawSpan: dimensions?.distanceRawSpan ?? null, evidence, candidateId: candidate.candidateId,
      observedRaw: candidate.rawValues.description,
    }),
    routeKind: pricingDimensionEnvelope({
      value: dimensions?.routeKind && dimensions.routeKind !== 'unresolved' ? dimensions.routeKind : null,
      source: routeSource, parseState: dimensionState, rawSpan: dimensions?.routeRawSpan ?? null,
      evidence, candidateId: candidate.candidateId,
      observedRaw: candidate.rawValues.description,
    }),
    distanceInterval: pricingDimensionEnvelope({
      value: dimensions?.distanceBand ?? null, source: distanceSource, parseState: dimensionState,
      rawSpan: dimensions?.distanceRawSpan ?? null, evidence, candidateId: candidate.candidateId,
      observedRaw: candidate.rawValues.description,
    }),
    routeRawSpan: pricingDimensionEnvelope({
      value: dimensions?.routeRawSpan ?? null, source: routeSource, parseState: dimensionState,
      rawSpan: dimensions?.routeRawSpan ?? null, evidence, candidateId: candidate.candidateId,
      observedRaw: candidate.rawValues.description,
    }),
    distanceRawExpression: pricingDimensionEnvelope({
      value: dimensions?.distanceRawSpan ?? null, source: distanceSource, parseState: dimensionState,
      rawSpan: dimensions?.distanceRawSpan ?? null, evidence, candidateId: candidate.candidateId,
      observedRaw: candidate.rawValues.description,
    }),
    equipmentType: observedEnvelope(candidate.equipmentType, evidence, rawText),
    personnelClassification: observedEnvelope(candidate.personnelClassification, evidence, rawText),
    sizeOrDiameterBand: observedEnvelope(candidate.sizeOrDiameterBand, evidence, rawText),
    quantity: observedEnvelope(candidate.quantity, evidence, candidate.rawValues.quantityText),
    totalAmount: observedEnvelope(candidate.totalAmount, evidence, rawText),
    passThrough: observedEnvelope(candidate.passThrough, evidence, rawText),
    markup: observedEnvelope(candidate.markup, evidence, rawText),
    minimumCharge: observedEnvelope(candidate.minimumCharge, evidence, rawText),
    maximumOrNteAmount: observedEnvelope(candidate.maximumOrNteAmount, evidence, rawText),
    effectivePeriod: observedEnvelope(candidate.effectivePeriod, evidence, rawText),
    applicabilityConditions: candidate.applicabilityConditions.length > 0
      ? resolvedValue<readonly string[]>(candidate.applicabilityConditions, {
          supportingEvidence: evidence,
          observedRaw: rawText,
        })
      : absentFromSource<readonly string[]>({ supportingEvidence: evidence, observedRaw: rawText }),
    exclusions: candidate.exclusions.length > 0
      ? resolvedValue<readonly string[]>(candidate.exclusions, {
          supportingEvidence: evidence,
          observedRaw: rawText,
        })
      : absentFromSource<readonly string[]>({ supportingEvidence: evidence, observedRaw: rawText }),

    governingDocument: candidate.governingDocument,
    precedence: context.precedence ?? null,
    resolution,
  };
}

function resolveRowState(input: {
  readonly candidate: CanonicalContractPricingCandidate;
  readonly extractionConflicted: boolean;
  readonly precedenceConflicted: boolean;
  readonly categoryState: TruthEnvelope<string>['state'];
  readonly descriptionSettled: boolean;
  readonly unitSettled: boolean;
  readonly rateSettled: boolean;
}): CanonicalPricingRowState {
  if (input.candidate.pricingContent === 'non_pricing') return 'non_pricing';
  if (input.extractionConflicted) return 'extraction_conflict';
  if (input.precedenceConflicted) return 'precedence_conflict';
  if (input.categoryState === 'unresolved_mapping') return 'unresolved_mapping';
  if (!input.descriptionSettled || !input.unitSettled || !input.rateSettled) {
    return 'requires_review';
  }
  if (input.candidate.authoredCorrection) return 'requires_review';
  if (input.categoryState === 'absent_from_source') return 'requires_review';
  return 'resolved';
}

// ─── Schedule assembly ───────────────────────────────────────────────────────

/**
 * A schedule may claim a governing document only when every row that names one
 * names the SAME one.
 *
 * Reading `rows[0]` would let input order decide governance, which is an
 * array-ordinal identity masquerading as a truth decision: reorder the rows and
 * the schedule changes hands. Disagreement is reported as `null` — no governing
 * document — rather than resolved silently in favour of whichever row sorted
 * first.
 */
function unanimousGoverningDocument(
  rows: readonly CanonicalContractPricingRow[],
): CanonicalContractPricingRow['governingDocument'] {
  let governing: CanonicalContractPricingRow['governingDocument'] = null;
  for (const row of rows) {
    if (row.governingDocument == null) continue;
    if (governing == null) {
      governing = row.governingDocument;
      continue;
    }
    if (governing.documentId !== row.governingDocument.documentId) return null;
  }
  return governing;
}

/**
 * Groups resolved rows into a schedule and reports coverage.
 *
 * Invariant: `candidateCount === resolvedCount + needsReviewCount + excludedCount`.
 * Nothing is dropped, so the totals must always reconcile.
 */
export function buildCanonicalPricingSchedule(input: {
  readonly scheduleId?: string | null;
  readonly scheduleName?: string | null;
  readonly rows: readonly CanonicalContractPricingRow[];
}): CanonicalContractPricingSchedule {
  const rows = input.rows;
  const countFor = (group: CanonicalPricingDisplayGroup): number =>
    rows.filter((row) => row.resolution.displayGroup === group).length;

  return {
    scheduleId: input.scheduleId ?? null,
    scheduleName: input.scheduleName ?? null,
    governingDocument: unanimousGoverningDocument(rows),
    rows,
    coverage: {
      candidateCount: rows.length,
      resolvedCount: countFor('resolved_pricing'),
      needsReviewCount: countFor('needs_review'),
      excludedCount: countFor('excluded'),
    },
  };
}
