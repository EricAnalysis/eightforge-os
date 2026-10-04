import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Forgewing resolution layer B3 tier and authority guards.
 *
 * Manual operator review is EightForge Core: it must work with Forgewing off,
 * for an organization without the Forgewing entitlement. And the reviewed-value
 * path never lets an AI proposal become canonical by itself.
 */

const ROOT = process.cwd();
const CORE_REVIEW_FILES = [
  'lib/humanFactAssertions/regionBoundAssertions.ts',
  'lib/humanFactAssertions/humanReviewReceipt.ts',
  'lib/server/regionBoundHumanAssertions.ts',
  'app/api/documents/[id]/facts/region-assertions/route.ts',
  'components/documents/ReviewedValuesPanel.tsx',
];
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

describe('B3 region-bound human review boundaries', () => {
  it.each(CORE_REVIEW_FILES)('%s never depends on Forgewing or its entitlement', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from '@\/lib\/forgewing\//);
    expect(source).not.toMatch(/forgewingEntitlement|resolveForgewingEntitlement|FORGEWING_SHADOW_ENABLED/);
    expect(source).not.toMatch(/forgewing_recovery_proposals|forgewing_recovery_proposal_reviews/);
  });

  it('records manual entries only as operator_entered, never with an AI origin', () => {
    const adapter = read('lib/server/regionBoundHumanAssertions.ts');
    expect(adapter).toMatch(/p_review_origin: 'operator_entered'/);
    expect(adapter).toMatch(/p_forgewing_proposal_id: null/);
    expect(adapter).not.toMatch(/p_review_origin: 'ai_proposed/);
  });

  it('the database refuses AI-origin assertions until proposals exist as their own records', () => {
    const migration = read('supabase/migrations/20261004160000_human_fact_assertions_region_bound.sql');
    expect(migration).toMatch(/IF p_review_origin IS DISTINCT FROM 'operator_entered' OR p_forgewing_proposal_id IS NOT NULL THEN/);
    // Writes go only through the function; the table stays append-only.
    expect(migration).not.toMatch(/GRANT[^;]*INSERT[^;]*human_fact_assertions/i);
    expect(migration).not.toMatch(/DROP TRIGGER/i);
  });

  it('the Validator applies human review once, at the shared assembled-row seam', () => {
    const validator = read('lib/validator/projectValidator.ts');
    expect(validator).toMatch(/applyHumanReviewedPricing\(\{\s*machineRows: contractPricingExecution\.assembly\.selectedRows,/);
    expect(validator).toMatch(/retainAssembledContractPricingRows\(humanReviewedPricing\.rows\)/);
    // The legacy fallback seam reuses the same matcher through the gate.
    expect(validator).toMatch(/humanReviewGate: humanReviewedPricing\.gate/);
    expect(validator.match(/decideAgainstHumanReview\(/g) ?? []).toHaveLength(0);
  });

  it('never dedupes human review against machine rows by content', () => {
    const matcher = read('lib/humanFactAssertions/humanReviewSupersession.ts');
    const decide = matcher.slice(matcher.indexOf('export function decideAgainstHumanReview'),
      matcher.indexOf('export function humanReviewTargets'));
    expect(decide).not.toMatch(/description|rate\b|unit|raw_text|text/);
  });
});
