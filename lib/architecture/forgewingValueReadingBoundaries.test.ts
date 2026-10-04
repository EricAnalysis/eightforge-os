import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Forgewing B4.2 authority guards. A value-reading proposal is AI_PROPOSED and
 * non-authoritative. Exactly one road leads from it to truth: an operator's
 * human fact assertion that cites it, verified by the database. This phase
 * stores and verifies only; it reaches no provider, policy or budget.
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const MIGRATION = 'supabase/migrations/20261004220000_forgewing_value_reading_proposals.sql';
const B42_FILES = ['lib/server/valueReadingProposals.ts', 'lib/resolution/valueReadingLifecycle.ts'];

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel.split(path.sep).join('/'));
    }
  };
  for (const root of ['app', 'lib', 'components']) walk(root);
  return out;
}

describe('B4.2 value-reading authority boundaries', () => {
  it.each(B42_FILES)('%s reaches no provider, client, policy or budget', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from '@\/lib\/forgewing\//);
    expect(source).not.toMatch(/@anthropic-ai|callClaude|forgewing\/runtime|\bfetch\(/);
    expect(source).not.toMatch(/reserveForgewingProviderCall|reserve_forgewing_provider_call|data_policy|forgewingGates/);
    expect(source).not.toMatch(/getSupabaseAdmin/);
  });

  it('only the value-reading module writes proposals or their reviews', () => {
    const writers = productionFiles().filter((file) =>
      /record_forgewing_value_reading_(proposal|review)|RECORD_VALUE_READING_(PROPOSAL|REVIEW)_RPC/.test(read(file)));
    expect(writers).toEqual(['lib/server/valueReadingProposals.ts']);
  });

  it('no product code supplies a final AI review origin; the database derives it', () => {
    const offenders = productionFiles().filter((file) => /p_review_origin:\s*'ai_proposed_operator/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('truth, pricing and the Validator never read value readings', () => {
    const coreRoots = ['lib/canonical/', 'lib/validator/', 'lib/contracts/', 'lib/humanFactAssertions/',
      'lib/extraction/', 'lib/projectFacts/', 'lib/truthQuery/', 'lib/effectiveFacts/'];
    const offenders = productionFiles().filter((file) => coreRoots.some((root) => file.startsWith(root))
      && /valueReadingProposals|valueReadingLifecycle|priced_value_reading|forgewing_recovery_proposals/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('the impact preview never carries a cited proposal into its hypothetical row', () => {
    const request = read('lib/server/regionAssertionRequest.ts');
    const hypothetical = request.slice(request.indexOf('export function hypotheticalRegionAssertionRow'));
    expect(hypothetical).toMatch(/review_origin: 'operator_entered'/);
    expect(hypothetical).toMatch(/forgewing_proposal_id: null/);
  });

  it('the review table can only reject or defer a value reading, at the database', () => {
    const migration = read(MIGRATION);
    expect(migration).toMatch(/p_disposition NOT IN \('rejected', 'deferred'\)/);
    expect(migration).toMatch(/CREATE TRIGGER forgewing_recovery_proposal_reviews_value_reading_guard\s+BEFORE INSERT/);
    expect(migration).toMatch(/NEW\.disposition IN \('accepted', 'modified'\)[\s\S]*proposal\.proposal_version = 3/);
  });

  it('is forward-only and additive', () => {
    const migration = read(MIGRATION);
    expect(migration).not.toMatch(/DROP (TABLE|COLUMN|TRIGGER|FUNCTION)/i);
    expect(migration).not.toMatch(/\bUPDATE public\.|\bDELETE FROM/i);
    expect(migration).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*(forgewing_recovery|human_fact_assertions)/i);
    // Recovery versions 1 and 2 keep requiring certainty and a provider model.
    expect(migration.match(/AND certainty IS NOT NULL\s+AND provider_model IS NOT NULL\)/g)).toHaveLength(2);
  });
});
