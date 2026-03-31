import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ContractAnalysisResult } from '@/lib/contracts/types';
import {
  CONTRACT_INTELLIGENCE_REAL_FIXTURES,
  runRealContractIntelligenceFixture,
} from '@/tests/fixtures/contracts/contractIntelligence.realFixtures';

function getFixtureAnalysis(id: string): ContractAnalysisResult {
  const fixture = CONTRACT_INTELLIGENCE_REAL_FIXTURES.find((candidate) => candidate.id === id);
  assert.ok(fixture, `Expected real contract fixture ${id} to exist.`);
  return runRealContractIntelligenceFixture(fixture);
}

function issueIds(analysis: ContractAnalysisResult): string[] {
  return analysis.issues.map((issue) => issue.issue_id).sort();
}

function suppressedIssueIds(analysis: ContractAnalysisResult): string[] {
  return analysis.trace_summary.suppressed_issues.map((issue) => issue.issue_id).sort();
}

describe('contract intelligence real fixture calibration', () => {
  it('keeps Lee County focused on a single activation issue with traceable anchors', () => {
    const analysis = getFixtureAnalysis('lee_county_disaster_recovery');

    assert.equal(analysis.contract_identity.contractor_name?.state, 'explicit');
    assert.equal(analysis.pricing_model.rate_schedule_present?.value, true);
    assert.equal(analysis.pricing_model.pricing_applicability?.state, 'explicit');
    assert.deepEqual(issueIds(analysis), ['activation_trigger_status_unresolved']);
    assert.ok(!issueIds(analysis).includes('pricing_applicability_requires_context'));
    assert.ok(!issueIds(analysis).includes('contractor_identity_conflict'));
    assert.ok(analysis.trace_summary.detected_pattern_ids.includes('ntp_activation'));
    assert.ok(analysis.trace_summary.issue_anchor_summary.length > 0);
    assert.ok(
      analysis.trace_summary.issue_anchor_summary[0]?.anchor_previews.some((preview) =>
        preview.includes('Notice to Proceed'),
      ),
    );
  });

  it('suppresses schedule-only pricing noise on EMERG03 while keeping derived term review', () => {
    const analysis = getFixtureAnalysis('emerg03_fema_debris_collection');

    assert.equal(analysis.pricing_model.rate_schedule_present?.value, true);
    assert.equal(analysis.pricing_model.pricing_applicability?.state, 'explicit');
    assert.equal(analysis.term_model.expiration_date?.state, 'derived');
    assert.deepEqual(issueIds(analysis), ['derived_expiration_confirmation']);
    assert.ok(!issueIds(analysis).includes('pricing_applicability_requires_context'));
    assert.ok(!issueIds(analysis).includes('missing_required_clause:activation_trigger'));
    assert.ok(suppressedIssueIds(analysis).includes('missing_required_clause:activation_trigger'));
  });

  it('keeps the Bentonville waterway contract to three actionable issues without duplicates', () => {
    const analysis = getFixtureAnalysis('bentonville_waterway_debris');

    assert.equal(analysis.pricing_model.rate_schedule_present?.value, true);
    assert.equal(analysis.pricing_model.pricing_applicability?.state, 'conditional');
    assert.deepEqual(issueIds(analysis), [
      'activation_trigger_status_unresolved',
      'documentation_gate_unclear',
      'pricing_applicability_requires_context',
    ]);
    assert.equal(new Set(issueIds(analysis)).size, analysis.issues.length);
    assert.ok(!issueIds(analysis).includes('fema_gate_ambiguous'));
    assert.ok(analysis.trace_summary.issue_anchor_summary.every((summary) => summary.anchor_previews.length > 0));
  });

  it('does not emit activation issues for a debris contract that lacks actual trigger dependency evidence', () => {
    const analysis = getFixtureAnalysis('north_carolina_dn12189513');

    assert.equal(analysis.activation_model.activation_trigger_type?.state, 'missing_critical');
    assert.deepEqual(issueIds(analysis), []);
    assert.ok(!analysis.trace_summary.detected_pattern_ids.includes('ntp_activation'));
    assert.ok(suppressedIssueIds(analysis).includes('missing_required_clause:activation_trigger'));
  });

  it('suppresses monitoring and documentation issues for a monitoring task order that is only service scope', () => {
    const analysis = getFixtureAnalysis('bentonville_monitoring_task_order');

    assert.deepEqual(analysis.trace_summary.detected_pattern_ids, []);
    assert.deepEqual(issueIds(analysis), []);
    assert.ok(suppressedIssueIds(analysis).includes('documentation_gate_unclear'));
    assert.ok(!suppressedIssueIds(analysis).includes('pricing_applicability_requires_context'));
  });
});
