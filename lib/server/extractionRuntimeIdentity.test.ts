import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { observeExtractionRuntimeIdentity } from './extractionRuntimeIdentity';

afterEach(() => vi.unstubAllEnvs());

describe('extraction runtime observations', () => {
  it('records the executing runtime without claiming unobserved native dependencies', () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    vi.stubEnv('VERCEL_ENV', '');
    const observation = observeExtractionRuntimeIdentity();
    expect(observation.identity).toMatchObject({ node_version: process.version, platform: process.platform,
      architecture: process.arch, deployment_revision: null, deployment_environment: null,
      dependency_fingerprints: 'not_observed' });
    expect(observation.identity_digest).toBe(hashCanonical(observation.identity));
    expect(observeExtractionRuntimeIdentity()).toEqual(observation);
  });

  it('binds the recorded deployment revision and ignores arbitrary environment content', () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'A'.repeat(40));
    vi.stubEnv('VERCEL_ENV', 'preview');
    const deployed = observeExtractionRuntimeIdentity();
    expect(deployed.identity.deployment_revision).toBe('a'.repeat(40));
    expect(deployed.identity.deployment_environment).toBe('preview');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'unverified revision');
    vi.stubEnv('VERCEL_ENV', 'arbitrary untrusted content');
    const unverified = observeExtractionRuntimeIdentity();
    expect(unverified.identity.deployment_revision).toBeNull();
    expect(unverified.identity.deployment_environment).toBeNull();
    expect(unverified.identity_digest).not.toBe(deployed.identity_digest);
    expect(JSON.stringify(unverified)).not.toContain('untrusted');
  });
});
