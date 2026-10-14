import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Forgewing S2: the model a Forgewing request runs on is checked against the
 * qualified list in code. No production path reads FORGEWING_MODEL except
 * through `resolveForgewingModel`, so a shared-model migration cannot reach a
 * Forgewing request contract it was never qualified on.
 */

const code = (relative: string) => readFileSync(relative, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}
const posix = (file: string) => file.split(path.sep).join('/');

describe('Forgewing qualified-model boundary (S2)', () => {
  it('only the model seam reads FORGEWING_MODEL in production code', () => {
    const readers = ['lib', 'app', 'components'].flatMap(walk).map(posix)
      .filter((file) => code(file).includes('FORGEWING_MODEL'));
    // The value-reading clients are frozen by their qualification contracts
    // (sourceSha256), so they keep their own read; their production caller,
    // the value-reading route, applies the qualified-model check before
    // constructing a provider. V2 is the separate Sonnet 5.5 qualification
    // client (#232) and may not exist on every base.
    const allowed = new Set([
      'lib/forgewing/runtime/modelConfig.ts',
      'lib/forgewing/runtime/valueReadingClient.ts',
      'lib/forgewing/runtime/valueReadingClientV2.ts',
    ]);
    expect(readers).toContain('lib/forgewing/runtime/modelConfig.ts');
    expect(readers.filter((file) => !allowed.has(file))).toEqual([]);
  }, 60_000);

  it('the value-reading route constructs a provider only for a qualified model', () => {
    const route = code('app/api/projects/[id]/resolution-cases/value-reading/route.ts');
    expect(route).toContain('isForgewingModelQualified(valueReadingProviderModel())');
  });

  it('runtime configs derive enablement from the qualified-model resolution', () => {
    const config = code('lib/forgewing/runtime/modelConfig.ts');
    expect(config).toContain('operational.masterEnabled && resolution.qualified');
    expect(config).toMatch(/FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED === '1'\s*&& qualifiedModelOrWarn\(/);
    expect(config).toMatch(/FORGEWING_WORKFLOW_ASSESSMENT_ENABLED === '1'\s*&& qualifiedModelOrWarn\(/);
  });
});
