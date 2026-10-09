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

  it('every reviewed rate row entry offers the allowed categories only, never free-text category', () => {
    for (const file of ['components/resolution/ResolutionWorkspace.tsx', 'components/documents/ReviewedValuesPanel.tsx']) {
      const source = read(file);
      expect(source).toMatch(/<select[^>]*\s+aria-label="category"/);
      expect(source).not.toMatch(/<input[^>]*\s+aria-label="category"/);
      // Nor a text input generated for the category field.
      expect(source).not.toMatch(/'category'\] as const\)\.map/);
    }
  });

  it('never chooses an AI origin: manual entry is operator_entered, a cited proposal only ai_proposed', () => {
    const adapter = read('lib/server/regionBoundHumanAssertions.ts');
    expect(adapter).toMatch(/p_review_origin: input\.forgewingProposalId \? 'ai_proposed' : 'operator_entered'/);
    expect(adapter).toMatch(/p_forgewing_proposal_id: input\.forgewingProposalId \?\? null/);
    expect(adapter).not.toMatch(/ai_proposed_operator/);
  });

  it('the database derives the stored origin itself and verifies a cited proposal (B4.2)', () => {
    const b3 = read('supabase/migrations/20261004160000_human_fact_assertions_region_bound.sql');
    const b42 = read('supabase/migrations/20261004220000_forgewing_value_reading_proposals.sql');
    const fn = b42.slice(b42.indexOf('CREATE OR REPLACE FUNCTION public.record_region_bound_human_fact_assertion('));
    // The caller's token never reaches the row: the insert stores v_origin.
    expect(fn).toMatch(/v_origin, p_forgewing_proposal_id, p_request_digest_sha256\)/);
    expect(fn).not.toMatch(/p_review_origin, p_forgewing_proposal_id, p_request_digest_sha256\)/);
    expect(fn).toMatch(/THEN 'ai_proposed_operator_approved' ELSE 'ai_proposed_operator_modified' END/);
    for (const migration of [b3, b42]) {
      // Writes go only through the function; the table stays append-only.
      expect(migration).not.toMatch(/GRANT[^;]*INSERT[^;]*human_fact_assertions/i);
      expect(migration).not.toMatch(/DROP TRIGGER/i);
    }
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
