import type { ResolutionCase, ResolutionCaseKind } from '@/lib/resolution/resolutionCases';

/**
 * What the operator is looking at, at a glance: open cases by kind, from the
 * cases the server returned. Pure display arithmetic over the queue; it
 * decides nothing and recomputes no fact.
 */

/** The operator's name for each kind of case. */
export const CASE_KIND_LABEL: Readonly<Record<ResolutionCaseKind, string>> = Object.freeze({
  validator_finding: 'Validator finding',
  unreadable_priced_line: 'Unread line',
  reviewed_value_needs_rereview: 'Re-review',
  recovery_proposal_pending: 'Recovery proposal',
  withheld_priced_line: 'Withheld line',
  structure_review: 'Table structure',
  review_required_value: 'Rate to confirm',
  coverage_gap: 'Page not read',
  pricing_withheld: 'Pricing withheld',
  category_review: 'Category',
});

/**
 * Kinds with no reviewed action in the workspace: page-level conditions of the
 * current extraction, closed only by a new analysis that no longer reports them.
 */
export const PAGE_CONDITION_KINDS: ReadonlySet<ResolutionCaseKind> = new Set(['structure_review', 'coverage_gap', 'pricing_withheld']);

export type ResolutionQueueSummary = Readonly<{
  total: number;
  byKind: readonly Readonly<{ kind: ResolutionCaseKind; label: string; count: number }>[];
  /** Value cases whose one reviewed row must also name a category. */
  alsoCategory: number;
}>;

export function summarizeResolutionQueue(cases: readonly ResolutionCase[]): ResolutionQueueSummary {
  const kinds = new Map<ResolutionCaseKind, number>();
  for (const entry of cases) {
    kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
  }
  const order = Object.keys(CASE_KIND_LABEL) as ResolutionCaseKind[];
  return {
    total: cases.length,
    byKind: [...kinds].sort(([a, countA], [b, countB]) => countB - countA || order.indexOf(a) - order.indexOf(b))
      .map(([kind, count]) => ({ kind, label: CASE_KIND_LABEL[kind], count })),
    alsoCategory: cases.filter((entry) => entry.kind !== 'category_review' && entry.alsoUnresolved?.includes('category')).length,
  };
}
