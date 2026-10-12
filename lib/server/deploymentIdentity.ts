/**
 * The deployment that is running this process, as the platform reports it.
 * Observation only: null when the platform did not report a well-formed value,
 * never a guess. Shared by extraction runtime identity and Validator run
 * stamping (B8.4b), so both name a producer the same way.
 */
export type DeploymentIdentity = Readonly<{
  deployment_revision: string | null;
  deployment_environment: 'production' | 'preview' | 'development' | null;
}>;

export function observeDeploymentIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentIdentity {
  const revision = env.VERCEL_GIT_COMMIT_SHA;
  const environment = env.VERCEL_ENV;
  return {
    deployment_revision: revision && /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : null,
    deployment_environment: environment === 'production' || environment === 'preview' || environment === 'development'
      ? environment : null,
  };
}
