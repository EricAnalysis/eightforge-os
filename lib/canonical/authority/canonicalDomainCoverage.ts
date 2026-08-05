/**
 * Canonical authority coverage: which truth domains this run actually governs.
 *
 * Coverage exists because "canonical mode was requested" and "canonical truth
 * governed" are different claims. Before this model, a run could report
 * `assembled` while several registry sections were still empty and their
 * validator inputs still came from legacy loaders — technically honest at the
 * section level, but indistinguishable at the run level from full canonical
 * authority.
 *
 * The rule enforced here closes that gap: a canonical run is either
 * authoritative for every REQUIRED domain, or it is blocked with a
 * domain-specific reason. There is deliberately no `legacy` coverage state — a
 * legacy-loaded domain inside a canonical run is a block, not a success with a
 * footnote.
 */

export type CanonicalTruthDomain =
  | 'pricing'
  | 'invoices'
  | 'invoiceLines'
  | 'transactions'
  | 'relationships'
  | 'provenance';

export const CANONICAL_TRUTH_DOMAINS: readonly CanonicalTruthDomain[] = [
  'pricing',
  'invoices',
  'invoiceLines',
  'transactions',
  'relationships',
  'provenance',
];

/**
 * `authoritative`   — canonical truth governs this domain for this run.
 * `blocked`         — canonical truth could not be established. Never a cue to
 *                     fall back; the reason is preserved for operator triage.
 * `not_applicable`  — the project genuinely has no source for this domain, so
 *                     there is nothing to govern. Distinct from `blocked`: a
 *                     project with no invoices is complete, not broken.
 */
export type CanonicalDomainCoverageState =
  | 'authoritative'
  | 'blocked'
  | 'not_applicable';

export type CanonicalDomainCoverageEntry = {
  readonly state: CanonicalDomainCoverageState;
  /** Machine-readable reason code. Required whenever `state` is `blocked`. */
  readonly reason: string | null;
  /** Source identities implicated in a block, for operator triage. */
  readonly sourceGaps: readonly string[];
};

export type CanonicalAuthorityCoverage = Readonly<
  Record<CanonicalTruthDomain, CanonicalDomainCoverageEntry>
>;

/**
 * Domains a canonical run must govern to claim complete authority.
 *
 * `provenance` is required because a canonical fact an operator cannot trace
 * back to a source is not auditable truth. `relationships` is required because
 * pricing and invoice truth are meaningless without a governing document.
 */
export const REQUIRED_CANONICAL_DOMAINS: readonly CanonicalTruthDomain[] = [
  'pricing',
  'invoices',
  'invoiceLines',
  'transactions',
  'relationships',
  'provenance',
];

export function authoritativeDomain(): CanonicalDomainCoverageEntry {
  return { state: 'authoritative', reason: null, sourceGaps: [] };
}

export function notApplicableDomain(reason: string): CanonicalDomainCoverageEntry {
  return { state: 'not_applicable', reason, sourceGaps: [] };
}

export function blockedDomain(
  reason: string,
  sourceGaps: readonly string[] = [],
): CanonicalDomainCoverageEntry {
  return { state: 'blocked', reason, sourceGaps: [...sourceGaps].sort((l, r) => l.localeCompare(r, 'en-US')) };
}

/** Every domain blocked for one shared reason — used when assembly itself failed. */
export function allDomainsBlocked(
  reason: string,
  sourceGaps: readonly string[] = [],
): CanonicalAuthorityCoverage {
  return Object.fromEntries(
    CANONICAL_TRUTH_DOMAINS.map((domain) => [domain, blockedDomain(reason, sourceGaps)]),
  ) as CanonicalAuthorityCoverage;
}

/**
 * Required domains that are not authoritative, in stable domain order.
 *
 * `not_applicable` counts as satisfied: there is no truth to govern, so nothing
 * is being silently legacy-loaded behind the claim.
 */
export function blockedTruthDomains(
  coverage: CanonicalAuthorityCoverage,
): readonly CanonicalTruthDomain[] {
  return REQUIRED_CANONICAL_DOMAINS.filter((domain) => coverage[domain].state === 'blocked');
}

/**
 * True when canonical mode may claim complete authority for this run.
 *
 * The canonical success rule: no required domain may be blocked. A caller that
 * sees `false` must surface the block rather than proceeding on partially
 * canonical truth.
 */
export function hasCompleteCanonicalAuthority(
  coverage: CanonicalAuthorityCoverage,
): boolean {
  return blockedTruthDomains(coverage).length === 0;
}
