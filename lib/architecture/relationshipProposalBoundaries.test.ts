import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * P3.2 V1 relationship proposals: a proposal never becomes a relationship by
 * itself. Only the operator's document-precedence route writes
 * document_relationships; no truth, precedence or Validator path reads the
 * proposal tables; the proposal modules write neither relationships nor
 * documents; and V1 proposes `amends` only.
 */

const code = (relative: string) => readFileSync(relative, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full.split(path.sep).join('/')] : [];
  });
}
let files: string[] | null = null;
const production = () => (files ??= ['app', 'components', 'lib', 'scripts'].flatMap(walk));
const TIMEOUT = 120_000;

const PRECEDENCE_ROUTE = 'app/api/projects/[id]/document-precedence/route.ts';

describe('relationship proposal boundaries (P3.2)', () => {
  it('only the operator precedence route writes document_relationships', () => {
    const writers = production().filter((file) => {
      const source = code(file);
      return /from\(\s*'document_relationships'\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/.test(source)
        || /from\(\s*'document_relationships'\s*\)\s*\.\s*(insert|update|upsert|delete)\(/.test(source);
    });
    expect(writers).toEqual([PRECEDENCE_ROUTE]);
  }, TIMEOUT);

  it('no truth, precedence, Validator or contract path reads the proposal tables', () => {
    const truthRoots = ['lib/canonical/', 'lib/validator/', 'lib/contracts/', 'lib/truthQuery', 'lib/projectFacts',
      'lib/effectiveFacts', 'lib/documentPrecedence.ts', 'lib/server/documentPrecedence.ts'];
    const readers = production()
      .filter((file) => truthRoots.some((root) => file.startsWith(root)))
      .filter((file) => /forgewing_relationship_proposal|relationshipProposals|relationshipProposalCandidates/.test(code(file)));
    expect(readers).toEqual([]);
  }, TIMEOUT);

  it('the proposal modules write neither relationships nor documents nor precedence', () => {
    for (const file of ['lib/relationshipProposalCandidates.ts', 'lib/server/relationshipProposals.ts',
      'app/api/projects/[id]/relationship-proposals/route.ts',
      'app/api/projects/[id]/relationship-proposals/[proposalId]/review/route.ts']) {
      const source = code(file);
      // Supabase table writes only (a hash's .update() is not a write).
      expect(`${file}:${/\.from\([^)]*\)[\s\S]{0,160}?\.(insert|update|upsert|delete)\(/.test(source)}`).toBe(`${file}:false`);
      expect(source).not.toMatch(/'document_relationships'|operator_override_precedence|precedence_rank|authority_status/);
    }
  });

  it('V1 proposes amends only, and the database enforces it', () => {
    expect(code('lib/relationshipProposalCandidates.ts')).toContain("relationshipType: 'amends'");
    const migration = readFileSync('supabase/migrations/20261014190000_forgewing_relationship_proposals.sql', 'utf8');
    expect(migration).toContain("relationship_type text NOT NULL CHECK (relationship_type = 'amends')");
    expect(migration).toContain("CHECK (authority = 'non_authoritative')");
  });

  it('acceptance is never offered outside the operator link action', () => {
    const review = code('app/api/projects/[id]/relationship-proposals/[proposalId]/review/route.ts');
    expect(review).toContain("disposition !== 'rejected' && disposition !== 'deferred'");
    const route = code(PRECEDENCE_ROUTE);
    expect(route).toContain("disposition: createdRelationshipId ? 'accepted' : 'already_linked'");
  });
});
