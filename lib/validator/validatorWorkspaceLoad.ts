import {
  resolveCanonicalProjectValidatorWorkspace,
  type CanonicalProjectValidatorWorkspace,
} from '@/lib/projectFacts';

type ValidatorWorkspaceInputs = Parameters<typeof resolveCanonicalProjectValidatorWorkspace>[0];

/**
 * The initial Validator render has no current project validation state yet.
 * Keep that state visibly loading; construct canonical workspace data only
 * after the initial read has supplied the summary it represents.
 */
export function resolveLoadedValidatorWorkspace(
  loading: boolean,
  inputs: ValidatorWorkspaceInputs,
): CanonicalProjectValidatorWorkspace | null {
  return loading ? null : resolveCanonicalProjectValidatorWorkspace(inputs);
}
