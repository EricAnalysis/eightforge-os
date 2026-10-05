import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');

describe('B4.4 workspace authority and deployed history', () => {
  it.each([
    ['20261004220000_forgewing_value_reading_proposals.sql', '127fcbb41a6e6bcff51cd6c871a173c4c7c44ea235eca23c6d8e55a6263592c7'],
    ['20261004230000_forgewing_value_reading_outcomes.sql', '544fd946bfdae4dc074dd706577c875e4aa51108d658adea6e80cdbcd5158f1a'],
  ])('preserves deployed migration %s', (file, digest) => {
    // Git normalizes checkout line endings; pin the deployed Git content.
    expect(createHash('sha256').update(read(`supabase/migrations/${file}`).replace(/\r\n/g, '\n')).digest('hex')).toBe(digest);
  });

  it('request/review routes authenticate, rederive the case, and use only existing non-authoritative services', () => {
    const base = 'app/api/projects/[id]/resolution-cases/';
    for (const route of ['value-reading', 'value-reading-review']) {
      const source = read(`${base}${route}/route.ts`);
      expect(source).toContain('getActorContext(req)');
      expect(source).toContain('readResolutionQueue(');
      expect(source).toContain('offeredAction(');
      expect(source).not.toMatch(/recordRegionBoundAssertion|record_region_bound_human_fact_assertion|human_fact_assertions|@anthropic-ai|from ['"]openai|resolveEligibility\s*:/);
    }
    expect(read(`${base}value-reading/route.ts`)).toContain('includeTextExcerpts: false');
    const review = read(`${base}value-reading-review/route.ts`);
    expect(review).toContain('action.proposalId !== body.proposalId');
    expect(review).toContain('action.proposalDigestSha256 !== body.proposalDigestSha256');
    expect(review).toContain('recordValueReadingReview(');
    expect(review).not.toMatch(/disposition: ['"]accepted|disposition: ['"]modified/);
  });
});
