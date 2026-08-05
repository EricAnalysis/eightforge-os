/**
 * The comparison execution control.
 *
 * Deliberately a THIRD independent control, alongside serving authority
 * (`EIGHTFORGE_PROJECT_TRUTH_AUTHORITY`) and publication
 * (`EIGHTFORGE_CANONICAL_SHADOW_PUBLICATION`). Enabling comparison never enables
 * canonical serving authority and never enables publication; that separation is
 * the whole point of a shadow phase. All four authority/comparison combinations
 * are legal and documented in amendment A15.
 *
 * Comparison is also cohort-scoped. A comparison runs two full validation
 * executions in memory, so an unbounded rollout across every production project
 * would double validation cost for no operator benefit. The allowlist makes the
 * cohort an explicit operator decision rather than a side effect of deployment.
 */

export const CANONICAL_AUTHORITY_COMPARE_ENV_VAR = 'EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE';
export const CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR =
  'EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE_PROJECTS';

export type CanonicalAuthorityCompareFlag =
  | { readonly mode: 'off'; readonly projectIds: readonly string[] }
  | { readonly mode: 'all'; readonly projectIds: readonly string[] }
  | { readonly mode: 'allowlist'; readonly projectIds: readonly string[] };

/**
 * Normalizes the raw configured values into a comparison flag.
 *
 * Fails closed to `off` for unrecognized values, and for `allowlist` with an
 * empty list. A typo must never silently start running two validations per
 * project, and `allowlist` with no ids is a misconfiguration rather than a
 * request to compare everything.
 */
export function resolveCanonicalAuthorityCompareFlag(
  modeRaw: string | null | undefined,
  projectIdsRaw?: string | null,
): CanonicalAuthorityCompareFlag {
  const mode = modeRaw?.trim().toLowerCase();
  if (!mode || mode === 'off') return { mode: 'off', projectIds: [] };
  const ids = parseProjectIds(projectIdsRaw);
  if (mode === 'all') return { mode: 'all', projectIds: ids };
  if (mode !== 'allowlist' && mode !== 'on') return { mode: 'off', projectIds: [] };
  // `on` is accepted as an operator-friendly synonym, but it still requires an
  // explicit cohort: "on" without a cohort is not a request to compare every
  // production project.
  return ids.length === 0 ? { mode: 'off', projectIds: [] } : { mode: 'allowlist', projectIds: ids };
}

function parseProjectIds(raw: string | null | undefined): readonly string[] {
  return [...new Set((raw ?? '').split(',').map((id) => id.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en-US'));
}

export function isCanonicalAuthorityComparisonEnabled(
  projectId: string,
  modeRaw: string | null | undefined,
  projectIdsRaw?: string | null,
): boolean {
  const flag = resolveCanonicalAuthorityCompareFlag(modeRaw, projectIdsRaw);
  return flag.mode === 'all'
    || (flag.mode === 'allowlist' && flag.projectIds.includes(projectId));
}

/**
 * Reads the comparison decision for one project from an environment record.
 *
 * Accepts an explicit record so tests and harnesses never mutate `process.env`.
 */
export function readCanonicalAuthorityComparisonEnabled(
  projectId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isCanonicalAuthorityComparisonEnabled(
    projectId,
    env[CANONICAL_AUTHORITY_COMPARE_ENV_VAR],
    env[CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR],
  );
}
