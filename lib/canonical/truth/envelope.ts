/**
 * Canonical truth envelope.
 *
 * A `TruthEnvelope<T>` wraps a single canonical FIELD — never a whole row.
 * Row-level envelopes were rejected during design because one low-confidence
 * unit would otherwise poison a confidently extracted rate on the same row.
 *
 * This module is additive and unreachable from production in this slice. It
 * imports nothing from `lib/extraction/**`, `lib/contracts/**`,
 * `lib/validator/**`, or `lib/projectFacts.ts`, so it cannot participate in
 * any existing truth path until it is deliberately wired in a later slice.
 *
 * Design rules enforced here:
 *   - `confidence` is `number | null` and is NEVER defaulted to a number.
 *     A missing measurement stays null. Fabricating confidence was an audited
 *     defect (`docs/audits/ocr-extraction-hardcoding-phase-1-2026-07-23.md`).
 *   - There is no broad `missing` state. See §"Why `missing` was excluded".
 *   - Value presence is a hard invariant per state, enforced at construction.
 *   - Evidence is typed and structural. Display strings are not evidence.
 */

// ─── Truth state ─────────────────────────────────────────────────────────────

/**
 * Canonical truth states.
 *
 * ## Why `missing` was excluded
 *
 * The prior consumer projection (`CanonicalProjectTruthState`) carries a broad
 * `missing` state, and `ProjectFactsForge` renders `missing`, `unresolved`, and
 * `requires_review` with overlapping labels. That collapse destroys the only
 * distinction an operator can act on:
 *
 *   - `absent_from_source`  → the source was read; the value is genuinely not
 *                             in it. Going back to the document is pointless.
 *   - `not_applicable`      → the dimension does not apply to this record.
 *                             Nothing to find, and it must not block approval.
 *   - `unresolved_mapping`  → something WAS observed but could not be mapped to
 *                             a canonical field. The document holds the answer.
 *
 * `missing` is therefore deliberately absent, and no alias is provided. A
 * caller that cannot decide between the three must use `requires_review`, which
 * is honest about the ambiguity rather than hiding it behind a shared label.
 */
export type CanonicalTruthState =
  | 'resolved'
  | 'derived'
  | 'absent_from_source'
  | 'not_applicable'
  | 'unresolved_mapping'
  | 'extraction_conflict'
  | 'precedence_conflict'
  | 'requires_review';

/** States whose envelope MUST carry a non-null value. */
const VALUE_REQUIRED_STATES: ReadonlySet<CanonicalTruthState> = new Set([
  'resolved',
  'derived',
]);

/** States whose envelope MUST NOT carry a value. */
const VALUE_FORBIDDEN_STATES: ReadonlySet<CanonicalTruthState> = new Set([
  'absent_from_source',
  'not_applicable',
  'unresolved_mapping',
]);

/**
 * True when the state guarantees a usable canonical value.
 * Conflict and review states may carry a provisional value, so they are
 * deliberately excluded here: a provisional value is not canonical truth.
 */
export function isValueBearingState(state: CanonicalTruthState): boolean {
  return VALUE_REQUIRED_STATES.has(state);
}

/** Deterministic display/sort order for states. Lower is "more resolved". */
const STATE_ORDER: readonly CanonicalTruthState[] = [
  'resolved',
  'derived',
  'requires_review',
  'unresolved_mapping',
  'extraction_conflict',
  'precedence_conflict',
  'absent_from_source',
  'not_applicable',
];

export function truthStateOrder(state: CanonicalTruthState): number {
  const index = STATE_ORDER.indexOf(state);
  return index === -1 ? STATE_ORDER.length : index;
}

// ─── Evidence ────────────────────────────────────────────────────────────────

/**
 * How a value was observed.
 *
 * `null` is the correct value when the observing engine is not recorded by the
 * upstream artifact. It is never inferred from a source-family name — deriving
 * an extractor from `sourceKind` would be synthetic provenance.
 */
export type CanonicalExtractor =
  | 'pdfjs'
  | 'ocr_fallback'
  | 'vision'
  | 'unstructured'
  | 'xlsx'
  | 'typed'
  | 'authored_adapter';

const KNOWN_EXTRACTORS: ReadonlySet<string> = new Set<CanonicalExtractor>([
  'pdfjs',
  'ocr_fallback',
  'vision',
  'unstructured',
  'xlsx',
  'typed',
  'authored_adapter',
]);

/** Narrows a free-form upstream source-type string without inventing a value. */
export function asCanonicalExtractor(value: unknown): CanonicalExtractor | null {
  return typeof value === 'string' && KNOWN_EXTRACTORS.has(value)
    ? (value as CanonicalExtractor)
    : null;
}

/**
 * A bounding box as OBSERVED.
 *
 * Deliberately not `lib/extraction/domain/types.ts#BoundingBox`: that type
 * requires `coordinate_space: 'page_normalized'` and a rotation, neither of
 * which most legacy table geometry carries. Asserting them would be synthetic
 * provenance, so this shape allows partial boxes and reports completeness.
 */
export type CanonicalBoundingBox = {
  readonly x0: number | null;
  readonly y0: number | null;
  readonly x1: number | null;
  readonly y1: number | null;
  /** `'unspecified'` unless the upstream artifact proves normalization. */
  readonly coordinateSpace: 'unspecified' | 'page_normalized';
  /** True only when all four edges are present. Derived, never asserted. */
  readonly complete: boolean;
};

export function canonicalBoundingBox(input: {
  readonly x0?: number | null;
  readonly y0?: number | null;
  readonly x1?: number | null;
  readonly y1?: number | null;
  readonly coordinateSpace?: 'unspecified' | 'page_normalized';
}): CanonicalBoundingBox {
  const x0 = finiteOrNull(input.x0);
  const y0 = finiteOrNull(input.y0);
  const x1 = finiteOrNull(input.x1);
  const y1 = finiteOrNull(input.y1);
  return {
    x0,
    y0,
    x1,
    y1,
    coordinateSpace: input.coordinateSpace ?? 'unspecified',
    complete: x0 != null && y0 != null && x1 != null && y1 != null,
  };
}

/**
 * A structural pointer back to the source. Every field of a canonical value
 * must be traceable through one of these.
 */
export type CanonicalEvidenceRef = {
  readonly documentId: string | null;
  readonly page: number | null;
  readonly boundingBox: CanonicalBoundingBox | null;
  /** The raw authored span exactly as observed. Not cleaned for display. */
  readonly rawSpan: string | null;
  /** Opaque id of the extraction artifact (fragment/cell/row) when available. */
  readonly extractionArtifactId: string | null;
  /** Legacy opaque anchor string, preserved verbatim and never parsed here. */
  readonly sourceAnchor: string | null;
  readonly tableKey: string | null;
  readonly rowIndex: number | null;
  readonly cellIndex: number | null;
  readonly extractor: CanonicalExtractor | null;
  /** Engine recognition confidence, 0..1. Null when not measured. */
  readonly recognitionConfidence: number | null;
};

export function canonicalEvidenceRef(
  input: Partial<CanonicalEvidenceRef> = {},
): CanonicalEvidenceRef {
  return {
    documentId: input.documentId ?? null,
    page: finiteOrNull(input.page),
    boundingBox: input.boundingBox ?? null,
    rawSpan: nonEmptyOrNull(input.rawSpan),
    extractionArtifactId: nonEmptyOrNull(input.extractionArtifactId),
    sourceAnchor: nonEmptyOrNull(input.sourceAnchor),
    tableKey: nonEmptyOrNull(input.tableKey),
    rowIndex: finiteOrNull(input.rowIndex),
    cellIndex: finiteOrNull(input.cellIndex),
    extractor: input.extractor ?? null,
    recognitionConfidence: finiteOrNull(input.recognitionConfidence),
  };
}

/** Stable identity for dedupe. Order-preserving callers keep the first hit. */
export function evidenceRefKey(ref: CanonicalEvidenceRef): string {
  return [
    ref.documentId ?? '',
    ref.page ?? '',
    ref.sourceAnchor ?? '',
    ref.extractionArtifactId ?? '',
    ref.tableKey ?? '',
    ref.rowIndex ?? '',
    ref.cellIndex ?? '',
    ref.rawSpan ?? '',
  ].join('|');
}

/** Removes duplicates while preserving first-seen order. Deterministic. */
export function dedupeEvidenceRefs(
  refs: readonly CanonicalEvidenceRef[],
): readonly CanonicalEvidenceRef[] {
  const seen = new Set<string>();
  const out: CanonicalEvidenceRef[] = [];
  for (const ref of refs) {
    const key = evidenceRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** True when the reference can actually take an operator back to the source. */
export function evidenceRefIsLocatable(ref: CanonicalEvidenceRef): boolean {
  return (
    ref.page != null
    || ref.sourceAnchor != null
    || ref.extractionArtifactId != null
    || (ref.boundingBox?.complete ?? false)
  );
}

// ─── Derivation, precedence, period, review ──────────────────────────────────

/** Mirrors `lib/interpretation/canonical/truthRecords.ts#TruthDependency`. */
export type CanonicalTruthDependency =
  | { readonly provenanceClass: 'machine_extraction'; readonly canonicalFactId: string }
  | { readonly provenanceClass: 'deterministic_derivation'; readonly derivedFactId: string }
  | { readonly provenanceClass: 'human_assertion'; readonly humanAssertionId: string };

export type CanonicalDerivationRef = {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly inputs: readonly CanonicalTruthDependency[];
};

export type CanonicalPrecedenceRef = {
  readonly governingDocumentId: string;
  /** Free-form family label; canonical code must not branch on its value. */
  readonly family: string | null;
  readonly reason: string | null;
  readonly reasonDetail: string | null;
  readonly supersededDocumentIds: readonly string[];
};

export type CanonicalEffectivePeriod = {
  readonly start: string | null;
  readonly end: string | null;
};

export type CanonicalReviewStatus =
  | 'none'
  | 'pending'
  | 'confirmed'
  | 'corrected'
  | 'rejected';

export type CanonicalOperatorReview = {
  readonly status: CanonicalReviewStatus;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly reviewedAt: string | null;
};

export const NO_OPERATOR_REVIEW: CanonicalOperatorReview = Object.freeze({
  status: 'none' as const,
  actorId: null,
  reason: null,
  reviewedAt: null,
});

/**
 * One link in an override chain. Unlike the shipping
 * `document_fact_overrides.is_active` boolean, this models supersession, so a
 * full history is representable.
 */
export type CanonicalOverrideEvent = {
  readonly assertionId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly assertedAt: string;
  readonly previousValue: unknown;
  readonly supersedesAssertionId: string | null;
};

// ─── The envelope ────────────────────────────────────────────────────────────

export type TruthEnvelope<T> = {
  readonly value: T | null;
  readonly state: CanonicalTruthState;
  /** Machine-readable reason CODE for the state. Never display prose. */
  readonly stateReason: string | null;
  /** Null when no confidence was measured. Never defaulted to a number. */
  readonly confidence: number | null;
  readonly governingSource: CanonicalEvidenceRef | null;
  readonly supportingEvidence: readonly CanonicalEvidenceRef[];
  readonly conflictingEvidence: readonly CanonicalEvidenceRef[];
  readonly derivation: CanonicalDerivationRef | null;
  readonly precedence: CanonicalPrecedenceRef | null;
  readonly effectivePeriod: CanonicalEffectivePeriod | null;
  readonly operatorReview: CanonicalOperatorReview;
  readonly overrideHistory: readonly CanonicalOverrideEvent[];
  /**
   * Raw value exactly as observed, retained even when `value` was normalized
   * or when the state is non-value-bearing. Canonical interpretation must not
   * destroy authored evidence.
   */
  readonly observedRaw: string | null;
};

type EnvelopeCommonInput = {
  readonly stateReason?: string | null;
  readonly confidence?: number | null;
  readonly governingSource?: CanonicalEvidenceRef | null;
  readonly supportingEvidence?: readonly CanonicalEvidenceRef[];
  readonly conflictingEvidence?: readonly CanonicalEvidenceRef[];
  readonly derivation?: CanonicalDerivationRef | null;
  readonly precedence?: CanonicalPrecedenceRef | null;
  readonly effectivePeriod?: CanonicalEffectivePeriod | null;
  readonly operatorReview?: CanonicalOperatorReview;
  readonly overrideHistory?: readonly CanonicalOverrideEvent[];
  readonly observedRaw?: string | null;
};

function buildEnvelope<T>(
  state: CanonicalTruthState,
  value: T | null,
  input: EnvelopeCommonInput,
): TruthEnvelope<T> {
  if (VALUE_REQUIRED_STATES.has(state) && value == null) {
    throw new Error(
      `Canonical truth state '${state}' requires a value; received null. `
      + 'Use absentFromSource/unresolvedMapping/requiresReview instead of fabricating one.',
    );
  }
  if (VALUE_FORBIDDEN_STATES.has(state) && value != null) {
    throw new Error(
      `Canonical truth state '${state}' must not carry a value; received one. `
      + 'A value that exists is not absent, not inapplicable, and not unmapped.',
    );
  }
  return {
    value,
    state,
    stateReason: nonEmptyOrNull(input.stateReason),
    // Explicitly `?? null`, never `?? 0` and never `?? 1`.
    confidence: input.confidence ?? null,
    governingSource: input.governingSource ?? null,
    supportingEvidence: dedupeEvidenceRefs(input.supportingEvidence ?? []),
    conflictingEvidence: dedupeEvidenceRefs(input.conflictingEvidence ?? []),
    derivation: input.derivation ?? null,
    precedence: input.precedence ?? null,
    effectivePeriod: input.effectivePeriod ?? null,
    operatorReview: input.operatorReview ?? NO_OPERATOR_REVIEW,
    overrideHistory: input.overrideHistory ?? [],
    observedRaw: nonEmptyOrNull(input.observedRaw),
  };
}

export function resolvedValue<T>(
  value: T,
  input: EnvelopeCommonInput = {},
): TruthEnvelope<T> {
  return buildEnvelope('resolved', value, input);
}

export function derivedValue<T>(
  value: T,
  derivation: CanonicalDerivationRef,
  input: EnvelopeCommonInput = {},
): TruthEnvelope<T> {
  return buildEnvelope('derived', value, { ...input, derivation });
}

export function absentFromSource<T>(
  input: EnvelopeCommonInput = {},
): TruthEnvelope<T> {
  return buildEnvelope<T>('absent_from_source', null, input);
}

/**
 * Requires an explicit reason. A field must never become `not_applicable`
 * merely because it was missing — that is `absent_from_source`.
 */
export function notApplicable<T>(
  reason: string,
  input: EnvelopeCommonInput = {},
): TruthEnvelope<T> {
  if (!reason.trim()) {
    throw new Error('not_applicable requires an explicit reason code.');
  }
  return buildEnvelope<T>('not_applicable', null, { ...input, stateReason: reason });
}

export function unresolvedMapping<T>(
  input: EnvelopeCommonInput = {},
): TruthEnvelope<T> {
  return buildEnvelope<T>('unresolved_mapping', null, input);
}

export function extractionConflict<T>(
  input: EnvelopeCommonInput & { readonly provisionalValue?: T | null } = {},
): TruthEnvelope<T> {
  return buildEnvelope<T>('extraction_conflict', input.provisionalValue ?? null, input);
}

export function precedenceConflict<T>(
  input: EnvelopeCommonInput & { readonly provisionalValue?: T | null } = {},
): TruthEnvelope<T> {
  return buildEnvelope<T>('precedence_conflict', input.provisionalValue ?? null, input);
}

export function requiresReview<T>(
  input: EnvelopeCommonInput & { readonly provisionalValue?: T | null } = {},
): TruthEnvelope<T> {
  return buildEnvelope<T>('requires_review', input.provisionalValue ?? null, input);
}

// ─── Predicates ──────────────────────────────────────────────────────────────

/** True when the envelope carries canonical truth safe to act on. */
export function hasCanonicalValue<T>(envelope: TruthEnvelope<T>): boolean {
  return isValueBearingState(envelope.state) && envelope.value != null;
}

/** True when the field is settled — either resolved or provably inapplicable. */
export function isSettled<T>(envelope: TruthEnvelope<T>): boolean {
  return hasCanonicalValue(envelope) || envelope.state === 'not_applicable';
}

/** True when at least one locatable evidence reference backs the field. */
export function hasLocatableEvidence<T>(envelope: TruthEnvelope<T>): boolean {
  if (envelope.governingSource && evidenceRefIsLocatable(envelope.governingSource)) return true;
  return envelope.supportingEvidence.some(evidenceRefIsLocatable);
}

/** All evidence attached to the field, governing first. Deterministic. */
export function allEvidence<T>(
  envelope: TruthEnvelope<T>,
): readonly CanonicalEvidenceRef[] {
  return dedupeEvidenceRefs([
    ...(envelope.governingSource ? [envelope.governingSource] : []),
    ...envelope.supportingEvidence,
    ...envelope.conflictingEvidence,
  ]);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
