import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_TRUTH_AUTHORITY_MODE,
  PROJECT_TRUTH_AUTHORITY_ENV_VAR,
  isCanonicalProjectTruthAuthority,
  readProjectTruthAuthorityMode,
  resolveProjectTruthAuthorityMode,
} from './projectTruthAuthorityMode';

describe('resolveProjectTruthAuthorityMode', () => {
  it('defaults to legacy when unset', () => {
    expect(resolveProjectTruthAuthorityMode(undefined)).toBe('legacy');
    expect(resolveProjectTruthAuthorityMode(null)).toBe('legacy');
    expect(resolveProjectTruthAuthorityMode('')).toBe('legacy');
    expect(DEFAULT_PROJECT_TRUTH_AUTHORITY_MODE).toBe('legacy');
  });

  it('selects canonical only for the exact accepted value', () => {
    expect(resolveProjectTruthAuthorityMode('canonical')).toBe('canonical');
  });

  it('accepts surrounding whitespace and mixed case', () => {
    expect(resolveProjectTruthAuthorityMode('  canonical  ')).toBe('canonical');
    expect(resolveProjectTruthAuthorityMode('CANONICAL')).toBe('canonical');
    expect(resolveProjectTruthAuthorityMode('Canonical')).toBe('canonical');
  });

  it('resolves legacy explicitly', () => {
    expect(resolveProjectTruthAuthorityMode('legacy')).toBe('legacy');
    expect(resolveProjectTruthAuthorityMode(' LEGACY ')).toBe('legacy');
  });

  it('fails closed to legacy for unrecognized values so a typo cannot enable canonical', () => {
    for (const raw of ['shadow', 'canonical_only', 'canonicals', 'cannonical', 'true', '1', 'on']) {
      expect(resolveProjectTruthAuthorityMode(raw)).toBe('legacy');
    }
  });
});

describe('readProjectTruthAuthorityMode', () => {
  it('reads the documented environment variable', () => {
    expect(readProjectTruthAuthorityMode({
      [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical',
    })).toBe('canonical');
  });

  it('defaults to legacy for an empty environment', () => {
    expect(readProjectTruthAuthorityMode({})).toBe('legacy');
  });

  it('ignores the publication flag, which is a separate control', () => {
    expect(readProjectTruthAuthorityMode({
      EIGHTFORGE_CANONICAL_SHADOW_PUBLISH: 'all',
    })).toBe('legacy');
  });

  it('resolves canonical authority independently of publication being off', () => {
    expect(readProjectTruthAuthorityMode({
      [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical',
      EIGHTFORGE_CANONICAL_SHADOW_PUBLISH: 'off',
    })).toBe('canonical');
  });
});

describe('isCanonicalProjectTruthAuthority', () => {
  it('discriminates the two modes', () => {
    expect(isCanonicalProjectTruthAuthority('canonical')).toBe(true);
    expect(isCanonicalProjectTruthAuthority('legacy')).toBe(false);
  });
});
