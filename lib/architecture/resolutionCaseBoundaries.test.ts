import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * B5-A guards. The resolution queue is a derived read model: it writes
 * nothing, calls no AI provider, and depends on Forgewing only through the
 * caller-supplied "is Forgewing enabled" decision.
 */
const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
const FILES = [
  'lib/resolution/resolutionCases.ts',
  'lib/server/resolutionQueueRead.ts',
  'app/api/projects/[id]/resolution-cases/route.ts',
];

describe('resolution case boundaries', () => {
  it.each(FILES)('%s performs no writes', (file) => {
    expect(read(file)).not.toMatch(/\.(insert|update|upsert|delete)\(|\.rpc\(/);
  });

  it.each(FILES)('%s never imports the Forgewing runtime or an AI provider', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from '@\/lib\/forgewing\//);
    expect(source).not.toMatch(/@anthropic-ai|openai/i);
  });

  it('the route exposes only GET', () => {
    const route = read('app/api/projects/[id]/resolution-cases/route.ts');
    expect(route).toMatch(/export async function GET/);
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it('the pure model builds Validator cases from the shared IssueObjects, not its own finding ranking', () => {
    expect(read('lib/server/resolutionQueueRead.ts')).toMatch(/resolveProjectIssueObjects\(/);
  });
});
