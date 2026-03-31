import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ContractAnalysisResult } from '@/lib/contracts/types';
import {
  buildNormalizedPrimaryDocument,
  CONTRACT_INTELLIGENCE_GOLDEN_FIXTURES,
  type ContractIntelligenceGoldenFixture,
  runContractIntelligenceGoldenFixture,
} from '@/tests/fixtures/contracts/contractIntelligence.goldenFixtures';

type GoldenActualSummary = {
  pattern_ids: string[];
  issue_ids: string[];
  issue_count: number;
  coverage_gap_ids: string[];
  suppressed_issue_ids: string[];
};

function buildActualSummary(analysis: ContractAnalysisResult): GoldenActualSummary {
  return {
    pattern_ids: analysis.clause_patterns_detected.map((pattern) => pattern.pattern_id).sort(),
    issue_ids: analysis.issues.map((issue) => issue.issue_id).sort(),
    issue_count: analysis.issues.length,
    coverage_gap_ids: analysis.trace_summary.coverage_gap_ids.slice().sort(),
    suppressed_issue_ids: analysis.trace_summary.suppressed_issues
      .map((issue) => issue.issue_id)
      .sort(),
  };
}

function failureContext(
  fixture: ContractIntelligenceGoldenFixture,
  actual: GoldenActualSummary,
): string {
  return `Golden drift for ${fixture.id} (${fixture.source_label}). Review the compact summary below and update the expected block deliberately if the change is intended.\n${JSON.stringify(actual, null, 2)}`;
}

describe('contract intelligence golden precision runner', () => {
  for (const fixture of CONTRACT_INTELLIGENCE_GOLDEN_FIXTURES) {
    it(`matches compact golden output for ${fixture.id}`, () => {
      const analysis = runContractIntelligenceGoldenFixture(fixture);
      const actual = buildActualSummary(analysis);

      assert.deepEqual(
        actual.pattern_ids,
        fixture.expected.pattern_ids.slice().sort(),
        failureContext(fixture, actual),
      );
      assert.deepEqual(
        actual.issue_ids,
        fixture.expected.issue_ids.slice().sort(),
        failureContext(fixture, actual),
      );
      assert.equal(
        actual.issue_count <= fixture.expected.max_issue_count,
        true,
        failureContext(fixture, actual),
      );

      for (const noisyIssueId of fixture.expected.absent_issue_ids) {
        assert.equal(
          actual.issue_ids.includes(noisyIssueId),
          false,
          failureContext(fixture, actual),
        );
      }

      for (const coverageGapId of fixture.expected.required_coverage_gap_ids) {
        assert.equal(
          actual.coverage_gap_ids.includes(coverageGapId),
          true,
          failureContext(fixture, actual),
        );
      }
    });
  }

  it('keeps TDOT executed and effective dates distinct without inventing a term end date', () => {
    const fixture = CONTRACT_INTELLIGENCE_GOLDEN_FIXTURES.find(
      (candidate) => candidate.id === 'tennessee_statewide_debris_contract',
    );
    assert.ok(fixture, 'Expected the TDOT statewide debris fixture to exist.');

    const normalized = buildNormalizedPrimaryDocument(fixture);
    assert.equal(normalized.fact_map.executed_date?.value, '2/6/2026');
    assert.equal(normalized.fact_map.term_start_date?.value, 'February 9, 2026');
    assert.equal(normalized.fact_map.term_end_date?.value, null);

    const analysis = runContractIntelligenceGoldenFixture(fixture);
    assert.equal(analysis.contract_identity.executed_date?.value, '2/6/2026');
    assert.equal(analysis.contract_identity.executed_date?.state, 'explicit');
    assert.equal(analysis.contract_identity.effective_date?.value, 'February 9, 2026');
    assert.equal(analysis.contract_identity.effective_date?.state, 'explicit');
    assert.equal(analysis.term_model.expiration_date?.value, null);
    assert.equal(analysis.term_model.expiration_date?.state, 'missing_critical');
    assert.ok(
      analysis.issues.every((issue) => issue.issue_id !== 'derived_expiration_confirmation'),
    );
  });
});
