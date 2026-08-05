/**
 * Central authority configuration for canonical Project Truth.
 *
 * This module is the ONLY place that interprets the authority environment
 * variable. Rule packs must never read it: the mode is resolved once per
 * validation execution at the validator-input boundary and threaded downstream.
 *
 * Authority (which truth governs validation) is deliberately independent of
 * publication (whether an audit artifact is written to storage). Canonical
 * authority operates with publication fully disabled; publication never
 * controls findings, exposure, or clearance. See
 * `shadowPublicationFlag.ts` for the separate publication control.
 */

export type ProjectTruthAuthorityMode =
  | 'legacy'
  | 'canonical';

export const PROJECT_TRUTH_AUTHORITY_ENV_VAR = 'EIGHTFORGE_PROJECT_TRUTH_AUTHORITY';

export const DEFAULT_PROJECT_TRUTH_AUTHORITY_MODE: ProjectTruthAuthorityMode = 'legacy';

/**
 * Normalizes a raw configured value into an authority mode.
 *
 * Unrecognized, empty, and absent values resolve to `legacy`. A typo must never
 * silently enable canonical authority, so this fails closed toward the
 * pre-cutover behavior rather than toward the new path.
 */
export function resolveProjectTruthAuthorityMode(
  raw: string | null | undefined,
): ProjectTruthAuthorityMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'canonical') return 'canonical';
  return DEFAULT_PROJECT_TRUTH_AUTHORITY_MODE;
}

/**
 * Reads the authority mode from an environment record.
 *
 * Accepts an explicit record so tests and harnesses never mutate `process.env`.
 */
export function readProjectTruthAuthorityMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProjectTruthAuthorityMode {
  return resolveProjectTruthAuthorityMode(env[PROJECT_TRUTH_AUTHORITY_ENV_VAR]);
}

export function isCanonicalProjectTruthAuthority(mode: ProjectTruthAuthorityMode): boolean {
  return mode === 'canonical';
}

/**
 * Outcome of attempting to establish canonical authority for one execution.
 *
 * `blocked` is an honest terminal state, never a cue to retry under legacy
 * truth. Canonical mode has exactly one rollback: setting the environment
 * variable back to `legacy`.
 */
export type CanonicalAssemblyStatus =
  | 'not_attempted'
  | 'assembled'
  | 'blocked';

/**
 * Reason canonical authority could not establish required governing truth.
 *
 * The reason and the source gap are preserved so an operator can see which
 * upstream source is missing instead of receiving a silently rescued result.
 */
export type CanonicalAuthorityBlockReason =
  | 'missing_governing_pricing'
  | 'missing_source_snapshot'
  | 'assembly_failed';

export type CanonicalAuthorityBlock = {
  readonly reason: CanonicalAuthorityBlockReason;
  readonly detail: string;
  /** Source identities implicated in the gap, for operator triage. */
  readonly sourceGaps: readonly string[];
};
