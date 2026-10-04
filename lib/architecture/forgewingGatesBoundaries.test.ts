import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Forgewing B4.1 gates. Gates only: no provider call exists yet, data-processing
 * authorization is never granted by product code, and no Core path consults a
 * Forgewing gate. Commercial entitlement and data policy stay separate.
 */

const GATES = 'lib/server/forgewingGates.ts';
const code = (relative: string) => readFileSync(relative, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}
const production = () => ['lib', 'app', 'components'].flatMap(walk);

describe('Forgewing B4.1 gate boundaries', () => {
  it('the gates reach no provider, no Forgewing runtime and no write but the budget reservation', () => {
    const source = code(GATES);
    for (const term of ['@/lib/server/ai', '@/lib/forgewing/', '@anthropic-ai/sdk', 'getClaudeClient',
      '.insert(', '.update(', '.upsert(', '.delete(']) {
      expect(`${term}:${source.includes(term)}`).toBe(`${term}:false`);
    }
    expect(source.match(/\.rpc\(/g)).toHaveLength(1);
    expect(source).toContain('RESERVE_FORGEWING_PROVIDER_CALL_RPC');
  });

  it('nothing in the product grants a data-processing authorization or spends the budget yet', () => {
    const offenders = production().filter((file) => file !== GATES).filter((file) => {
      const source = code(file);
      return source.includes('organization_forgewing_data_policy_events')
        || source.includes('FORGEWING_DATA_POLICY_EVENTS_TABLE')
        || source.includes('reserveForgewingProviderCall')
        || source.includes('reserve_forgewing_provider_call');
    });
    expect(offenders).toEqual([]);
  });

  it('no Core path consults a Forgewing gate', () => {
    const core = ['lib/canonical', 'lib/validator', 'lib/contracts', 'lib/extraction/pdf',
      'lib/humanFactAssertions', 'lib/resolution'].flatMap(walk);
    const offenders = core.filter((file) => {
      const source = code(file);
      return source.includes('forgewingGates') || source.includes('forgewingEntitlement');
    });
    expect(offenders).toEqual([]);
  });

  it('the resolution queue lists Forgewing suggestions by entitlement, never by the kill switch alone', () => {
    const queue = code('lib/server/resolutionQueueRead.ts');
    expect(queue).toContain('?? resolveForgewingEntitlement)(');
    expect(queue).not.toContain('readRecoveryOperationalConfig');
  });
});
