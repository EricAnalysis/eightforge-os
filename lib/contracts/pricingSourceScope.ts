/**
 * Authoritative pricing-source scope resolution.
 *
 * Operator-entered rate-schedule page ranges address physical page positions in
 * the uploaded source artifact. This module turns persisted guidance, artifact
 * metadata, and page provenance into an explicit scope decision.
 *
 * It is pure and is NOT yet wired into pricing eligibility. Today the operator
 * range reaches pricing as `rateSchedulePagePreferencePages` and is used only
 * to sort candidates, while the sole page filter keys off machine-detected
 * pages and self-disables when detection is empty. Nothing here changes that;
 * enforcement is a later, separately reviewed phase.
 *
 * The one thing this module refuses to express is a whole-document fallback.
 * "No scope" is returned as its own state rather than as "everything", because
 * the absent-scope-means-accept-everything path is what allowed unrelated
 * monetary text from across a contract into canonical pricing.
 */

import {
  expandRatePageRanges,
  type RatePageRange,
} from '@/lib/contracts/parseRatePageRanges';
import {
  isResolvedPhysicalPage,
  type PhysicalPageCoordinate,
} from '@/lib/extraction/provenance/physicalPageCoordinate';
import type { SourceArtifact } from '@/lib/extraction/domain/types';

export type PricingSourceScopeKind =
  /** Operator guidance resolved; these pages govern pricing extraction scope. */
  | 'authoritative'
  /** No operator guidance; machine detection offers pages, unproven as authority. */
  | 'provisional'
  /** Neither operator nor machine pages. Explicitly NOT "the whole document". */
  | 'no_scope'
  /** Operator guidance exists but cannot be trusted. Fail closed. */
  | 'blocked';

export type PricingSourceScopeBlockedReason =
  | 'total_physical_pages_unknown'
  | 'operator_range_malformed'
  | 'operator_range_out_of_bounds'
  | 'operator_range_unresolved_pages';

export type PricingSourceScopeDiagnosticCode =
  | 'machine_scope_equivalent'
  | 'machine_scope_exceeds_operator'
  | 'machine_scope_subset'
  | 'machine_scope_absent'
  | 'machine_scope_disjoint'
  | 'machine_scope_partial_overlap';

export type PricingSourceScopeDiagnostic = Readonly<{
  code: PricingSourceScopeDiagnosticCode;
  /** Pages implicated by the diagnostic, ascending. Never used to widen scope. */
  pages: readonly number[];
  detail: string;
}>;

export type PricingSourceScopeResult = Readonly<{
  kind: PricingSourceScopeKind;
  /**
   * Pages that may govern canonical pricing, ascending. Empty unless
   * `kind === 'authoritative'` — provisional pages are reported separately so a
   * consumer cannot accidentally treat machine guesses as operator authority.
   */
  authoritativePages: readonly number[];
  /** Machine-suggested pages when no operator guidance exists, ascending. */
  provisionalPages: readonly number[];
  blockedReason: PricingSourceScopeBlockedReason | null;
  /** Pages that caused a block, ascending. Empty when not blocked. */
  blockedPages: readonly number[];
  diagnostics: readonly PricingSourceScopeDiagnostic[];
}>;

export type PricingSourceScopeInput = Readonly<{
  /** Immutable artifact, already bound to its owning source document. */
  sourceArtifact: Pick<SourceArtifact, 'id' | 'source_document_id'>;
  /** Persisted operator ranges for THIS document. Null/empty means absent. */
  operatorPageRanges?: readonly RatePageRange[] | null;
  /** From the artifact's own parser output, never a constant or layer count. */
  totalPhysicalPages?: number | null;
  /** Provenance for page-derived artifacts of this document. */
  pageCoordinates?: readonly PhysicalPageCoordinate[] | null;
  /** Machine-detected rate-schedule pages, if any. */
  machineDetectedPages?: readonly number[] | null;
}>;

const ASCENDING = (left: number, right: number): number => left - right;

function uniqueAscending(pages: Iterable<number>): number[] {
  return [...new Set(pages)].sort(ASCENDING);
}

function normalizePageList(pages: readonly number[] | null | undefined): number[] {
  if (pages == null) return [];
  return uniqueAscending(
    pages.filter((page) => Number.isSafeInteger(page) && page > 0),
  );
}

function rangesAreWellFormed(ranges: readonly unknown[]): ranges is readonly RatePageRange[] {
  return ranges.every((range) => {
    if (typeof range !== 'object' || range == null) return false;
    const candidate = range as { start?: unknown; end?: unknown };
    return Number.isSafeInteger(candidate.start)
      && Number.isSafeInteger(candidate.end)
      && (candidate.start as number) >= 1
      && (candidate.end as number) >= (candidate.start as number);
  });
}

/** Physical pages this document has actually proven, from provenance alone. */
function resolvedPhysicalPages(
  coordinates: readonly PhysicalPageCoordinate[] | null | undefined,
  sourceArtifact: Pick<SourceArtifact, 'id' | 'source_document_id'>,
): Set<number> {
  const resolved = new Set<number>();
  for (const coordinate of coordinates ?? []) {
    if (isResolvedPhysicalPage(coordinate)
      && coordinate.sourceArtifactId === sourceArtifact.id
      && coordinate.sourceDocumentId === sourceArtifact.source_document_id) {
      resolved.add(coordinate.physicalPageNumber);
    }
  }
  return resolved;
}

function freezeResult(result: {
  kind: PricingSourceScopeKind;
  authoritativePages: number[];
  provisionalPages: number[];
  blockedReason: PricingSourceScopeBlockedReason | null;
  blockedPages: number[];
  diagnostics: PricingSourceScopeDiagnostic[];
}): PricingSourceScopeResult {
  return Object.freeze({
    kind: result.kind,
    authoritativePages: Object.freeze([...result.authoritativePages]),
    provisionalPages: Object.freeze([...result.provisionalPages]),
    blockedReason: result.blockedReason,
    blockedPages: Object.freeze([...result.blockedPages]),
    diagnostics: Object.freeze(
      [...result.diagnostics].sort((left, right) =>
        left.code.localeCompare(right.code, 'en-US')),
    ),
  });
}

function machineDiagnostic(
  operatorPages: readonly number[],
  machinePages: readonly number[],
): PricingSourceScopeDiagnostic {
  if (machinePages.length === 0) {
    return Object.freeze({
      code: 'machine_scope_absent',
      pages: Object.freeze([]),
      detail:
        'Machine rate-schedule detection found no pages. Operator scope stands unchanged.',
    });
  }
  const operator = new Set(operatorPages);
  const machine = new Set(machinePages);
  const outside = machinePages.filter((page) => !operator.has(page));
  const missing = operatorPages.filter((page) => !machine.has(page));

  if (outside.length === 0 && missing.length === 0) {
    return Object.freeze({
      code: 'machine_scope_equivalent',
      pages: Object.freeze(uniqueAscending(machinePages)),
      detail: 'Machine detection agrees with the operator scope.',
    });
  }
  if (outside.length > 0 && missing.length === operatorPages.length) {
    return Object.freeze({
      code: 'machine_scope_disjoint',
      pages: Object.freeze(uniqueAscending(outside)),
      detail:
        'Machine detection found rate-schedule pages that do not overlap the operator scope. '
        + 'Operator scope stands; the disjoint pages are reported for review.',
    });
  }
  if (outside.length > 0 && missing.length > 0) {
    return Object.freeze({
      code: 'machine_scope_partial_overlap',
      pages: Object.freeze(uniqueAscending([...outside, ...missing])),
      detail:
        'Machine detection overlaps the operator scope but also adds and misses pages. '
        + 'Operator scope stands unchanged; all disagreements are reported for review.',
    });
  }
  if (outside.length > 0) {
    return Object.freeze({
      code: 'machine_scope_exceeds_operator',
      pages: Object.freeze(uniqueAscending(outside)),
      detail:
        'Machine detection found rate-schedule pages outside the operator scope. '
        + 'The operator scope is not widened.',
    });
  }
  return Object.freeze({
    code: 'machine_scope_subset',
    pages: Object.freeze(uniqueAscending(missing)),
    detail:
      'Machine detection covered only part of the operator scope. '
      + 'The operator scope is not narrowed.',
  });
}

/**
 * Resolves the authoritative pricing-source scope for one document.
 *
 * Precedence: valid operator guidance wins outright. Machine detection may
 * corroborate or contradict it in diagnostics but never widens, narrows, or
 * replaces it — including when detection is empty, which is precisely the case
 * that currently degrades to accepting the entire document.
 */
export function resolvePricingSourceScope(
  input: PricingSourceScopeInput,
): PricingSourceScopeResult {
  const machinePages = normalizePageList(input.machineDetectedPages);
  const ranges: readonly unknown[] = [...(input.operatorPageRanges ?? [])];

  if (ranges.length === 0) {
    return freezeResult({
      kind: machinePages.length > 0 ? 'provisional' : 'no_scope',
      authoritativePages: [],
      provisionalPages: machinePages,
      blockedReason: null,
      blockedPages: [],
      diagnostics: [],
    });
  }

  if (!rangesAreWellFormed(ranges)) {
    return freezeResult({
      kind: 'blocked',
      authoritativePages: [],
      provisionalPages: [],
      blockedReason: 'operator_range_malformed',
      blockedPages: [],
      diagnostics: [],
    });
  }

  const requestedRangeEndpoints = uniqueAscending(
    ranges.flatMap((range) => range.start === range.end
      ? [range.start]
      : [range.start, range.end]),
  );

  // Without the artifact's own page count, an out-of-bounds range cannot be
  // ruled out, so the range cannot be proven valid. Fail closed rather than
  // assume the document is long enough.
  const totalPhysicalPages = input.totalPhysicalPages;
  if (!(typeof totalPhysicalPages === 'number'
    && Number.isInteger(totalPhysicalPages)
    && totalPhysicalPages > 0)) {
    return freezeResult({
      kind: 'blocked',
      authoritativePages: [],
      provisionalPages: [],
      blockedReason: 'total_physical_pages_unknown',
      blockedPages: requestedRangeEndpoints,
      diagnostics: [],
    });
  }

  const outOfBoundsRanges = ranges.filter((range) => range.end > totalPhysicalPages);
  if (outOfBoundsRanges.length > 0) {
    const outOfBounds = uniqueAscending(outOfBoundsRanges.flatMap((range) => {
      const first = Math.max(range.start, totalPhysicalPages + 1);
      return first === range.end ? [first] : [first, range.end];
    }));
    // Deliberately not clamped: a range naming pages the document does not have
    // is an operator error worth surfacing, not a range to silently shrink.
    return freezeResult({
      kind: 'blocked',
      authoritativePages: [],
      provisionalPages: [],
      blockedReason: 'operator_range_out_of_bounds',
      blockedPages: outOfBounds,
      diagnostics: [],
    });
  }

  const requestedPages = uniqueAscending(expandRatePageRanges(ranges));
  const resolved = resolvedPhysicalPages(input.pageCoordinates, input.sourceArtifact);
  const unresolved = requestedPages.filter((page) => !resolved.has(page));
  if (unresolved.length > 0) {
    // Partial resolution is still a wrong rate schedule. Block rather than
    // proceed on the resolvable subset.
    return freezeResult({
      kind: 'blocked',
      authoritativePages: [],
      provisionalPages: [],
      blockedReason: 'operator_range_unresolved_pages',
      blockedPages: unresolved,
      diagnostics: [],
    });
  }

  return freezeResult({
    kind: 'authoritative',
    authoritativePages: requestedPages,
    provisionalPages: [],
    blockedReason: null,
    blockedPages: [],
    diagnostics: [machineDiagnostic(requestedPages, machinePages)],
  });
}

export type PricingPageEligibility = 'canonical_eligible' | 'diagnostic_only';

/**
 * Classifies one physical page against a resolved scope.
 *
 * Supports the intended future split — authoritative pages feed canonical
 * assembly while out-of-scope pricing-like material is retained as
 * diagnostic-only for repeated-schedule detection, corroboration, and conflict
 * reporting. Nothing consumes this yet; it exists so the result type is not so
 * narrow that the diagnostic class becomes impossible to express later.
 */
export function classifyPageEligibility(
  scope: PricingSourceScopeResult,
  physicalPageNumber: number | null,
): PricingPageEligibility {
  if (scope.kind !== 'authoritative') return 'diagnostic_only';
  if (!Number.isSafeInteger(physicalPageNumber) || physicalPageNumber == null || physicalPageNumber < 1) {
    return 'diagnostic_only';
  }
  return scope.authoritativePages.includes(physicalPageNumber)
    ? 'canonical_eligible'
    : 'diagnostic_only';
}
