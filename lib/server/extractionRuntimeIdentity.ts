import { hashCanonical } from '@/lib/extraction/domain/hash';

/** Runtime observation, not qualification proof or an extraction authority gate. */
export type ExtractionRuntimeIdentity = ReturnType<typeof observeExtractionRuntimeIdentity>;

export function observeExtractionRuntimeIdentity() {
  const revision = process.env.VERCEL_GIT_COMMIT_SHA;
  const environment = process.env.VERCEL_ENV;
  const identity = {
    schema: 'extraction_runtime_identity_v1' as const,
    node_version: process.version,
    node_abi: process.versions.modules ?? null,
    v8_version: process.versions.v8 ?? null,
    platform: process.platform,
    architecture: process.arch,
    deployment_revision: revision && /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : null,
    deployment_environment: environment === 'production' || environment === 'preview' || environment === 'development'
      ? environment : null,
    // Never infer that installed pins identify the binaries/core actually used.
    dependency_fingerprints: 'not_observed' as const,
  };
  return { identity, identity_digest: hashCanonical(identity) };
}
