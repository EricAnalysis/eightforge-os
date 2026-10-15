import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every API route that reaches a model provider directly must either be
 * closed in production or authenticate its caller (session actor or an
 * internal secret). An open route would let anyone spend provider budget and
 * send arbitrary text to a provider outside every Forgewing gate.
 */

const PROVIDER_IMPORT = /from ['"](?:@anthropic-ai\/sdk|openai|@\/lib\/server\/ai\/[^'"]+|@\/lib\/ai\/[^'"]+)['"]/;
const AUTHENTICATED = /\bgetActorContext\(|\bCRON_SECRET\b|INTERNAL_[A-Z_]*SECRET\b/;
const CLOSED_IN_PRODUCTION = /process\.env\.NODE_ENV === ['"]production['"]\)\s*\{?\s*return new NextResponse\(null, \{ status: 404 \}\)/;

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routes(full);
    return name === 'route.ts' ? [full] : [];
  });
}

describe('provider-reaching API routes', () => {
  it('are authenticated or closed in production', () => {
    const providerRoutes = routes(path.join('app', 'api')).filter((file) => PROVIDER_IMPORT.test(readFileSync(file, 'utf8')));
    expect(providerRoutes.length).toBeGreaterThan(0);
    const open = providerRoutes.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return !AUTHENTICATED.test(source) && !CLOSED_IN_PRODUCTION.test(source);
    });
    expect(open).toEqual([]);
  });

  it('the extractor diagnostic route is closed in production and authenticated', () => {
    const source = readFileSync(path.join('app', 'api', 'extractor-diagnostics', 'route.ts'), 'utf8');
    expect(source).toMatch(CLOSED_IN_PRODUCTION);
    expect(source).toMatch(/getActorContext\(request\)/);
  });
});
