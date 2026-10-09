import type { ResolutionCase, ResolutionCaseKind, ResolutionQueue } from '@/lib/resolution/resolutionCases';

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
  byDocument: readonly Readonly<{ documentId: string | null; label: string; count: number }>[];
}>;

export function summarizeResolutionQueue(cases: readonly ResolutionCase[]): ResolutionQueueSummary {
  const kinds = new Map<ResolutionCaseKind, number>();
  const documents = new Map<string | null, { documentId: string | null; label: string; count: number }>();
  for (const entry of cases) {
    kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
    const existing = documents.get(entry.documentId);
    if (existing) existing.count += 1;
    else documents.set(entry.documentId, { documentId: entry.documentId,
      label: entry.documentId === null ? 'Project-level work' : entry.documentLabel || 'Document', count: 1 });
  }
  const order = Object.keys(CASE_KIND_LABEL) as ResolutionCaseKind[];
  return {
    total: cases.length,
    byDocument: [...documents.values()],
    byKind: [...kinds].sort(([a, countA], [b, countB]) => countB - countA || order.indexOf(a) - order.indexOf(b))
      .map(([kind, count]) => ({ kind, label: CASE_KIND_LABEL[kind], count })),
    alsoCategory: cases.filter((entry) => entry.kind !== 'category_review' && entry.alsoUnresolved?.includes('category')).length,
  };
}

/** Display filter only: original cases, actions and server ordering are retained. */
export function filterResolutionQueue(queue: ResolutionQueue, documentId: string | null | undefined): ResolutionQueue {
  if (documentId === undefined) return queue;
  const cases = queue.cases.filter((entry) => entry.documentId === documentId);
  const byId = new Map(cases.map((entry) => [entry.caseId, entry]));
  const groups = queue.groups.flatMap((group) => {
    const members = group.caseIds.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
    if (members.length === 0) return [];
    const amounts = members.flatMap((entry) => entry.exposureAmount === null ? [] : [entry.exposureAmount]);
    return [{ ...group, tier: members[0]!.tier, caseIds: members.map((entry) => entry.caseId),
      findingCount: members.filter((entry) => entry.kind === 'validator_finding').length,
      exposureAmount: amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : null }];
  });
  const countsByTier = { ...queue.countsByTier };
  for (const tier of Object.keys(countsByTier) as (keyof typeof countsByTier)[]) countsByTier[tier] = 0;
  for (const entry of cases) countsByTier[entry.tier] += 1;
  return { ...queue, cases, groups, countsByTier };
}
