/**
 * Comparison configuration.
 *
 * The controls that matter here are the fail-closed ones: comparison must be off
 * unless deliberately enabled, and enabling comparison must never imply canonical
 * serving authority. All four authority/comparison combinations are asserted so a
 * future change cannot couple them by accident.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_TRUTH_AUTHORITY_MODE,
  PROJECT_TRUTH_AUTHORITY_ENV_VAR,
  readProjectTruthAuthorityMode,
} from '@/lib/canonical/authority/projectTruthAuthorityMode';

import {
  CANONICAL_AUTHORITY_COMPARE_ENV_VAR,
  CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR,
  isCanonicalAuthorityComparisonEnabled,
  readCanonicalAuthorityComparisonEnabled,
  resolveCanonicalAuthorityCompareFlag,
} from './authorityComparisonFlag';

const PROJECT = 'project-alpha';

describe('comparison feature control', () => {
  it('defaults to off when unset, empty, or unrecognized', () => {
    for (const raw of [undefined, null, '', '   ', 'yes', 'true', 'enabled', 'ALL_PROJECTS']) {
      expect(resolveCanonicalAuthorityCompareFlag(raw).mode).toBe('off');
    }
  });

  it('never enables comparison for a project when disabled', () => {
    expect(isCanonicalAuthorityComparisonEnabled(PROJECT, undefined)).toBe(false);
    expect(isCanonicalAuthorityComparisonEnabled(PROJECT, 'off', PROJECT)).toBe(false);
  });

  it('treats allowlist with no project ids as a misconfiguration, not as all projects', () => {
    expect(resolveCanonicalAuthorityCompareFlag('allowlist', '').mode).toBe('off');
    expect(resolveCanonicalAuthorityCompareFlag('allowlist', '  ,  ,').mode).toBe('off');
    expect(isCanonicalAuthorityComparisonEnabled(PROJECT, 'allowlist')).toBe(false);
  });

  it('requires an explicit cohort for the operator-friendly "on" synonym', () => {
    expect(resolveCanonicalAuthorityCompareFlag('on').mode).toBe('off');
    expect(resolveCanonicalAuthorityCompareFlag('on', PROJECT)).toEqual({
      mode: 'allowlist',
      projectIds: [PROJECT],
    });
  });

  it('normalizes an allowlist deterministically', () => {
    expect(resolveCanonicalAuthorityCompareFlag('allowlist', ' b , a , a ,  ')).toEqual({
      mode: 'allowlist',
      projectIds: ['a', 'b'],
    });
  });

  it('scopes comparison to the allowlisted projects only', () => {
    expect(isCanonicalAuthorityComparisonEnabled('a', 'allowlist', 'a,b')).toBe(true);
    expect(isCanonicalAuthorityComparisonEnabled('c', 'allowlist', 'a,b')).toBe(false);
  });

  it('supports an all-projects mode for deliberate broad rollout', () => {
    expect(isCanonicalAuthorityComparisonEnabled('anything', 'all')).toBe(true);
  });

  it('reads configuration from an injected record without touching process.env', () => {
    const before = process.env[CANONICAL_AUTHORITY_COMPARE_ENV_VAR];
    expect(readCanonicalAuthorityComparisonEnabled(PROJECT, {
      [CANONICAL_AUTHORITY_COMPARE_ENV_VAR]: 'allowlist',
      [CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR]: PROJECT,
    })).toBe(true);
    expect(process.env[CANONICAL_AUTHORITY_COMPARE_ENV_VAR]).toBe(before);
  });
});

describe('comparison and serving authority are independent controls', () => {
  it('keeps the serving authority default at legacy', () => {
    expect(DEFAULT_PROJECT_TRUTH_AUTHORITY_MODE).toBe('legacy');
    expect(readProjectTruthAuthorityMode({})).toBe('legacy');
  });

  it('documents every authority/comparison combination as independently reachable', () => {
    const combinations = [
      { authority: undefined, compare: undefined },
      { authority: undefined, compare: 'allowlist' },
      { authority: 'canonical', compare: undefined },
      { authority: 'canonical', compare: 'allowlist' },
    ] as const;

    expect(combinations.map((combination) => {
      const env = {
        ...(combination.authority ? { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: combination.authority } : {}),
        ...(combination.compare
          ? {
            [CANONICAL_AUTHORITY_COMPARE_ENV_VAR]: combination.compare,
            [CANONICAL_AUTHORITY_COMPARE_PROJECTS_ENV_VAR]: PROJECT,
          }
          : {}),
      };
      return {
        authority: readProjectTruthAuthorityMode(env),
        comparison: readCanonicalAuthorityComparisonEnabled(PROJECT, env),
      };
    })).toEqual([
      { authority: 'legacy', comparison: false },
      { authority: 'legacy', comparison: true },
      { authority: 'canonical', comparison: false },
      { authority: 'canonical', comparison: true },
    ]);
  });

  it('does not let enabling comparison change the serving authority', () => {
    const env = {
      [CANONICAL_AUTHORITY_COMPARE_ENV_VAR]: 'all',
    };
    expect(readCanonicalAuthorityComparisonEnabled(PROJECT, env)).toBe(true);
    expect(readProjectTruthAuthorityMode(env)).toBe('legacy');
  });
});
