import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Forgewing S6: no provider call relies on SDK defaults (a 10-minute timeout
 * and two automatic retries). Every client is constructed with explicit bounds
 * and every non-Forgewing Claude call passes CLAUDE_REQUEST_OPTIONS; Forgewing
 * request contracts pin their own timeout and zero retries.
 */

const code = (relative: string) => readFileSync(relative, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full.split(path.sep).join('/')] : [];
  });
}
let files: string[] | null = null;
const production = () => (files ??= ['lib', 'app', 'components'].flatMap(walk));
/** Development-only smoke routes; they return 404 in production. */
const DEVELOPMENT_ONLY = new Set(['app/api/test/anthropic/route.ts', 'app/api/test/openai/route.ts']);

describe('AI provider reliability (S6)', () => {
  it('every provider client is constructed with an explicit timeout and retry bound', () => {
    const offenders = production().filter((file) => !DEVELOPMENT_ONLY.has(file)).flatMap((file) => {
      const source = code(file);
      return [...source.matchAll(/new (Anthropic|OpenAI)\(\{([\s\S]*?)\}\)/g)]
        .filter((match) => !/\btimeout:/.test(match[2]) || !/\bmaxRetries:/.test(match[2]))
        .map((match) => `${file}: new ${match[1]}`);
    });
    expect(offenders).toEqual([]);
  }, 60_000);

  it('every non-Forgewing Claude call passes explicit request options', () => {
    for (const file of ['lib/server/ai/askProject.ts', 'lib/server/ai/runOrchestrator.ts',
      'lib/server/ai/extractorDiagnosticAgent.ts']) {
      const source = code(file);
      const calls = source.split('.messages.create(').slice(1);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(`${file}:${/\}, \{ \.\.\.CLAUDE_REQUEST_OPTIONS\.(budgeted|internal) \}\)/.test(call)}`)
        .toBe(`${file}:true`);
    }
    // Ask spends a durable reservation: exactly one provider call, no retries.
    expect(code('lib/server/ai/askProject.ts')).toContain('CLAUDE_REQUEST_OPTIONS.budgeted');
  });

  it('the budgeted bound never retries and both bounds are finite', async () => {
    const { CLAUDE_REQUEST_OPTIONS } = await import('@/lib/server/ai/claudeRequestOptions');
    expect(CLAUDE_REQUEST_OPTIONS.budgeted.maxRetries).toBe(0);
    for (const bound of Object.values(CLAUDE_REQUEST_OPTIONS)) {
      expect(bound.timeout).toBeGreaterThan(0);
      expect(bound.timeout).toBeLessThanOrEqual(120_000);
    }
  });

  it('the provider smoke-test routes are closed in production', () => {
    for (const file of DEVELOPMENT_ONLY) {
      expect(code(file)).toMatch(/if \(process\.env\.NODE_ENV === 'production'\) return new NextResponse\(null, \{ status: 404 \}\);/);
    }
  });
});
