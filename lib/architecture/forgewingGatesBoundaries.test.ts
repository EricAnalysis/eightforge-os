import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Forgewing B4.1 gates. Gates only: no provider call exists yet, data-processing
 * authorization is never granted by product code, and no Core path consults a
 * Forgewing gate. Commercial entitlement and data policy stay separate.
 */

const GATES = path.join('lib', 'server', 'forgewingGates.ts'); // platform separators, to match walk()
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

  it('nothing in the product grants a data-processing authorization', () => {
    const offenders = production().filter((file) => file !== GATES).filter((file) => {
      const source = code(file);
      return source.includes('organization_forgewing_data_policy_events')
        || source.includes('FORGEWING_DATA_POLICY_EVENTS_TABLE');
    });
    expect(offenders).toEqual([]);
  });

  it('only named provider workflows spend the budget, each its own (B4.3, generalization phase 3)', () => {
    const spenders = production().filter((file) => file !== GATES).filter((file) => {
      const source = code(file);
      return source.includes('reserveForgewingProviderCall') || source.includes('reserve_forgewing_provider_call');
    });
    // Exactly these. A further spender is a new provider surface and must be
    // added here deliberately, behind the same gates.
    expect([...spenders].sort()).toEqual([
      path.join('app', 'api', 'projects', '[id]', 'ask', 'route.ts'),
      // Census D2: the extraction shadow and recovery tasks' durable budgets.
      path.join('lib', 'extraction', 'persistence', 'complianceShadow.ts'),
      path.join('lib', 'server', 'caseInvestigationRunner.ts'),
      path.join('lib', 'server', 'valueReadingEngine.ts'),
    ].sort());
  });

  it('every shadow / recovery provider call reserves a durable slot first (D2)', () => {
    const shadow = code(path.join('lib', 'extraction', 'persistence', 'complianceShadow.ts'));
    // The six production provider tasks run only through the reserving wrapper.
    for (const task of ['region_classification', 'table_continuation', 'column_mapping', 'observation_arbitration',
      'pricing_interpretation', 'recovery_candidate_v2']) {
      expect(shadow).toContain(`withShadowProviderTelemetry('${task}'`);
    }
    expect(shadow.match(/createObservedForgewingProvider\)\(/g)).toHaveLength(1);
    const wrapper = shadow.slice(shadow.indexOf('export async function withShadowProviderTelemetry'));
    const body = wrapper.slice(0, wrapper.search(/\r?\n\}\r?\n/));
    const reserveAt = body.indexOf('reserveForgewingProviderCall)(admin');
    const refuseAt = body.indexOf("if (reservation.status !== 'reserved')");
    const callAt = body.indexOf('return await observed(request)');
    expect(reserveAt).toBeGreaterThan(-1);
    expect(refuseAt).toBeGreaterThan(reserveAt);
    expect(callAt).toBeGreaterThan(refuseAt);
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
