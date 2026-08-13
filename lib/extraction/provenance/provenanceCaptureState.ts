/**
 * Declared outcome of physical-page provenance capture for one extraction.
 *
 * This exists because absence of the provenance container is not evidence of
 * anything. Before this state was recorded, a missing container was read as
 * "this extraction predates page provenance" — which silently mislabelled every
 * non-paginated source (CSV/XLSX/text) extracted today as historical, and would
 * equally mislabel any future path that fails to capture.
 *
 * Every extraction path now declares its own outcome. Readers must branch on the
 * declared state and must never infer a state from absence.
 */
export type ProvenanceCaptureState =
  /** Paginated source; per-page coordinates were captured and artifact-bound. */
  | 'captured'
  /**
   * Source has no page topology at all (spreadsheet, CSV, plain text).
   * Not old — differently shaped. Page-range scope is inapplicable, not unmet.
   */
  | 'not_applicable_non_paginated'
  /**
   * Paginated source whose page proof could not be established this run
   * (conflicting parser page counts, unknown page count, or unbound artifact).
   * Fail-closed: this is an absence of proof, never a grant of compatibility.
   */
  | 'capture_failed'
  /**
   * Extraction positively identified as predating provenance capture.
   *
   * NOTHING EMITS THIS YET. It is reachable only from a durable marker on the
   * persisted record. No such marker exists today, so pre-existing extractions
   * read as `unknown` rather than being fabricated into this state. See
   * `resolveProvenanceCaptureState`.
   */
  | 'legacy_pre_provenance';

/**
 * What a reader resolves to. `unknown` is the honest reading of a record whose
 * writer never declared a state — it is NOT a synonym for `legacy_pre_provenance`.
 */
export type ResolvedProvenanceCaptureState = ProvenanceCaptureState | 'unknown';

const DECLARED_CAPTURE_STATES: readonly ProvenanceCaptureState[] = [
  'captured',
  'not_applicable_non_paginated',
  'capture_failed',
  'legacy_pre_provenance',
];

export function isProvenanceCaptureState(
  value: unknown,
): value is ProvenanceCaptureState {
  return typeof value === 'string'
    && DECLARED_CAPTURE_STATES.includes(value as ProvenanceCaptureState);
}

/**
 * Reads the declared capture state from a persisted provenance container.
 *
 * Three deliberately distinct outcomes:
 * - container absent            → `unknown` (writer predates the declaration)
 * - container present, declared → that state
 * - container present, garbled  → `capture_failed`, so version skew or a
 *   corrupted record fails closed instead of inheriting a permissive default.
 */
export function resolveProvenanceCaptureState(
  container: Readonly<Record<string, unknown>> | null | undefined,
): ResolvedProvenanceCaptureState {
  if (container == null) return 'unknown';
  const declared = container.capture_state;
  if (isProvenanceCaptureState(declared)) return declared;
  return 'capture_failed';
}

/**
 * True when physical page-range scope is a meaningful question for this source.
 *
 * Only a captured paginated source can be scoped by page. A non-paginated or
 * pre-provenance source is not "out of scope" — page scope does not apply to it,
 * which is a different judgement and needs its own source-level authority rule.
 */
export function pageScopeApplies(state: ResolvedProvenanceCaptureState): boolean {
  return state === 'captured' || state === 'capture_failed';
}
