import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ContractAnalysisResult } from '@/lib/contracts/types';
import { evaluateOperationalDecisions } from './contractDecisions';

// Minimal valid ContractAnalysisResult builder — only required structural fields.
// Override any Batch 7 optional field via the second argument.
function makeAnalysis(
  overrides: Partial<ContractAnalysisResult> = {},
): ContractAnalysisResult {
  return {
    document_id: 'test-doc',
    document_family: 'contract',
    document_type_profile: null,
    language_engine_version: 'test',
    pattern_library_version: 'test',
    coverage_library_version: 'test',
    contract_identity: {},
    term_model: {},
    activation_model: {},
    scope_model: {},
    pricing_model: {},
    documentation_model: {},
    compliance_model: {},
    payment_model: {},
    clause_patterns_detected: [],
    coverage_status: [],
    issues: [],
    trace_summary: {
      detected_pattern_ids: [],
      coverage_gap_ids: [],
      emitted_issue_ids: [],
      suppressed_issues: [],
      issue_anchor_summary: [],
    },
    ...overrides,
  };
}

describe('contractDecisions — evaluateOperationalDecisions', () => {

  // ─── Rule 1: bafo_block ──────────────────────────────────────────────────

  it('bafo_block triggers when document_shape is bafo_response', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis({ document_shape: 'bafo_response' }));
    const triggered = decisions.find((d) => d.rule_id === 'bafo_block');
    assert.ok(triggered, 'bafo_block decision must be present');
    assert.equal(triggered.severity, 'critical');
    assert.equal(triggered.action, 'block_contract_processing');
    assert.ok(triggered.evidence.length > 0, 'evidence must be non-empty');
    assert.ok(
      triggered.evidence.some((e) => e.field === 'document_shape' && e.value === 'bafo_response'),
      'evidence must reference document_shape with value bafo_response',
    );
  });

  it('bafo_block does not trigger when document_shape is executed_contract', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis({ document_shape: 'executed_contract' }));
    assert.equal(
      decisions.find((d) => d.rule_id === 'bafo_block'),
      undefined,
    );
  });

  it('bafo_block does not trigger when document_shape is undefined', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis());
    assert.equal(decisions.find((d) => d.rule_id === 'bafo_block'), undefined);
  });

  it('bafo_block does not trigger when document_shape is unknown', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis({ document_shape: 'unknown' }));
    assert.equal(decisions.find((d) => d.rule_id === 'bafo_block'), undefined);
  });

  // ─── Rule 2: invoice_overrun ─────────────────────────────────────────────

  it('invoice_overrun triggers when actual > authorized and includes correct delta in the message', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ quantity_levels: { authorized: 85000, actual: 112000 } }),
    );
    const triggered = decisions.find((d) => d.rule_id === 'invoice_overrun');
    assert.ok(triggered, 'invoice_overrun decision must be present');
    assert.equal(triggered.severity, 'critical');
    assert.equal(triggered.action, 'hold_payment_pending_review');
    assert.ok(triggered.evidence.length > 0, 'evidence must be non-empty');
    assert.ok(triggered.operator_message.includes('112000'), 'message must include actual quantity');
    assert.ok(triggered.operator_message.includes('85000'), 'message must include authorized quantity');
    assert.ok(triggered.operator_message.includes('27000'), 'message must include delta (27000)');
  });

  it('invoice_overrun does not trigger when actual <= authorized', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ quantity_levels: { authorized: 85000, actual: 62000 } }),
    );
    assert.equal(decisions.find((d) => d.rule_id === 'invoice_overrun'), undefined);
  });

  it('invoice_overrun does not trigger when actual equals authorized', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ quantity_levels: { authorized: 85000, actual: 85000 } }),
    );
    assert.equal(decisions.find((d) => d.rule_id === 'invoice_overrun'), undefined);
  });

  it('invoice_overrun does not trigger when quantity_levels is undefined', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis());
    assert.equal(decisions.find((d) => d.rule_id === 'invoice_overrun'), undefined);
  });

  it('invoice_overrun does not trigger when actual is null', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ quantity_levels: { authorized: 85000, actual: null } }),
    );
    assert.equal(decisions.find((d) => d.rule_id === 'invoice_overrun'), undefined);
  });

  it('invoice_overrun does not trigger when authorized is null', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ quantity_levels: { authorized: null, actual: 112000 } }),
    );
    assert.equal(decisions.find((d) => d.rule_id === 'invoice_overrun'), undefined);
  });

  it('invoice_overrun evidence includes actual, authorized, and computed delta', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ quantity_levels: { authorized: 85000, actual: 97000 } }),
    );
    const triggered = decisions.find((d) => d.rule_id === 'invoice_overrun');
    assert.ok(triggered);
    assert.ok(triggered.evidence.some((e) => e.field === 'quantity_levels.actual' && e.value === 97000));
    assert.ok(triggered.evidence.some((e) => e.field === 'quantity_levels.authorized' && e.value === 85000));
    assert.ok(triggered.evidence.some((e) => e.field === 'quantity_levels.delta' && e.value === 12000));
  });

  // ─── Rule 3: missing_authorization ──────────────────────────────────────

  it('missing_authorization triggers when authorization_state is missing', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis({ authorization_state: 'missing' }));
    const triggered = decisions.find((d) => d.rule_id === 'missing_authorization');
    assert.ok(triggered, 'missing_authorization decision must be present');
    assert.equal(triggered.severity, 'high');
    assert.equal(triggered.action, 'hold_billing_pending_authorization');
    assert.ok(triggered.evidence.length > 0, 'evidence must be non-empty');
    assert.ok(
      triggered.evidence.some((e) => e.field === 'authorization_state' && e.value === 'missing'),
    );
  });

  it('missing_authorization does not trigger when authorization_state is conditional', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis({ authorization_state: 'conditional' }));
    assert.equal(decisions.find((d) => d.rule_id === 'missing_authorization'), undefined);
  });

  it('missing_authorization does not trigger when authorization_state is confirmed', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis({ authorization_state: 'confirmed' }));
    assert.equal(decisions.find((d) => d.rule_id === 'missing_authorization'), undefined);
  });

  it('missing_authorization does not trigger when authorization_state is undefined', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis());
    assert.equal(decisions.find((d) => d.rule_id === 'missing_authorization'), undefined);
  });

  // ─── Rule 4: domain_mismatch ─────────────────────────────────────────────

  it('domain_mismatch triggers when contract_domain differs from expected_domain', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ contract_domain: 'waterway_maintenance' }),
      { expected_domain: 'debris_removal' },
    );
    const triggered = decisions.find((d) => d.rule_id === 'domain_mismatch');
    assert.ok(triggered, 'domain_mismatch decision must be present');
    assert.equal(triggered.severity, 'medium');
    assert.equal(triggered.action, 'reroute_to_correct_workflow');
    assert.ok(triggered.operator_message.includes('waterway_maintenance'));
    assert.ok(triggered.operator_message.includes('debris_removal'));
    assert.ok(triggered.evidence.some((e) => e.field === 'contract_domain' && e.value === 'waterway_maintenance'));
    assert.ok(triggered.evidence.some((e) => e.field === 'expected_domain' && e.value === 'debris_removal'));
  });

  it('domain_mismatch does not trigger when no expected_domain is provided', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ contract_domain: 'waterway_maintenance' }),
    );
    assert.equal(decisions.find((d) => d.rule_id === 'domain_mismatch'), undefined);
  });

  it('domain_mismatch does not trigger when domains match', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ contract_domain: 'debris_removal' }),
      { expected_domain: 'debris_removal' },
    );
    assert.equal(decisions.find((d) => d.rule_id === 'domain_mismatch'), undefined);
  });

  it('domain_mismatch does not trigger when contract_domain is undefined', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis(),
      { expected_domain: 'debris_removal' },
    );
    assert.equal(decisions.find((d) => d.rule_id === 'domain_mismatch'), undefined);
  });

  // ─── Rule 5: signature_verify ────────────────────────────────────────────
  // No dedicated signature runtime field exists in ContractAnalysisResult yet.
  // These tests verify the rule skips silently in all current scenarios.
  // When a signature_evidence field is graduated to ContractAnalysisResult in a future
  // batch, the triggering path will activate and these tests will need updating.

  it('signature_verify does not trigger when no signature-specific runtime field is present', () => {
    // No signature field exists on ContractAnalysisResult yet — rule must skip silently.
    const decisions = evaluateOperationalDecisions(makeAnalysis({ document_shape: 'executed_contract' }));
    assert.equal(decisions.find((d) => d.rule_id === 'signature_verify'), undefined);
  });

  it('signature_verify does not trigger on strong signature evidence context', () => {
    // Even with an executed_contract shape and explicit fields, no signature_verify
    // decision fires because the rule has no field to read from yet.
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({
        document_shape: 'executed_contract',
        contract_domain: 'debris_removal',
        authorization_state: 'confirmed',
      }),
    );
    assert.equal(decisions.find((d) => d.rule_id === 'signature_verify'), undefined);
  });

  it('signature_verify does not trigger and does not error when no signature data is available', () => {
    // Completely empty analysis — must not throw and must return no signature_verify.
    assert.doesNotThrow(() => {
      const decisions = evaluateOperationalDecisions(makeAnalysis());
      assert.equal(decisions.find((d) => d.rule_id === 'signature_verify'), undefined);
    });
  });

  // ─── Cross-rule properties ───────────────────────────────────────────────

  it('rules are independent: multiple triggered rules can coexist', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({
        document_shape: 'bafo_response',
        quantity_levels: { authorized: 85000, actual: 112000 },
        authorization_state: 'missing',
        contract_domain: 'waterway_maintenance',
      }),
      { expected_domain: 'debris_removal' },
    );
    const ruleIds = decisions.map((d) => d.rule_id);
    assert.ok(ruleIds.includes('bafo_block'), 'bafo_block must be in results');
    assert.ok(ruleIds.includes('invoice_overrun'), 'invoice_overrun must be in results');
    assert.ok(ruleIds.includes('missing_authorization'), 'missing_authorization must be in results');
    assert.ok(ruleIds.includes('domain_mismatch'), 'domain_mismatch must be in results');
    assert.equal(decisions.length, 4, 'exactly 4 rules must fire');
  });

  it('decisions are returned in fixed rule order regardless of input order', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({
        document_shape: 'bafo_response',
        quantity_levels: { authorized: 85000, actual: 112000 },
        authorization_state: 'missing',
        contract_domain: 'waterway_maintenance',
      }),
      { expected_domain: 'debris_removal' },
    );
    const ruleIds = decisions.map((d) => d.rule_id);
    assert.deepEqual(ruleIds, [
      'bafo_block',
      'invoice_overrun',
      'missing_authorization',
      'domain_mismatch',
    ]);
  });

  it('the evaluator is deterministic: same input produces same output on repeated calls', () => {
    const input = makeAnalysis({
      quantity_levels: { authorized: 85000, actual: 112000 },
      authorization_state: 'missing',
    });
    const first = evaluateOperationalDecisions(input);
    const second = evaluateOperationalDecisions(input);
    assert.deepEqual(first, second);
  });

  it('operator_message includes concrete numeric values for invoice_overrun', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ quantity_levels: { authorized: 72000, actual: 91500 } }),
    );
    const triggered = decisions.find((d) => d.rule_id === 'invoice_overrun');
    assert.ok(triggered);
    assert.ok(triggered.operator_message.includes('91500'), 'must include actual');
    assert.ok(triggered.operator_message.includes('72000'), 'must include authorized');
    assert.ok(triggered.operator_message.includes('19500'), 'must include delta');
  });

  it('every triggered decision has a non-empty evidence array', () => {
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({
        document_shape: 'bafo_response',
        quantity_levels: { authorized: 85000, actual: 112000 },
        authorization_state: 'missing',
        contract_domain: 'waterway_maintenance',
      }),
      { expected_domain: 'debris_removal' },
    );
    for (const decision of decisions) {
      assert.ok(
        decision.evidence.length > 0,
        `${decision.rule_id} must have at least one evidence reference`,
      );
    }
  });

  it('evaluator returns only triggered decisions, not non-triggered rule rows', () => {
    // Only invoice_overrun fires here
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({ quantity_levels: { authorized: 85000, actual: 112000 } }),
    );
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].rule_id, 'invoice_overrun');
  });

  it('returns empty array when no rules are triggered', () => {
    const decisions = evaluateOperationalDecisions(makeAnalysis());
    assert.deepEqual(decisions, []);
  });

  // ─── Integration: multi-rule scenario ────────────────────────────────────

  it('multi-rule integration: all triggered rules are returned in fixed order with correct severity', () => {
    // Scenario: a waterway contract processed in a debris workflow,
    // with invoice overrun and no authorization document.
    // bafo_block is absent (executed_contract, not bafo_response).
    const decisions = evaluateOperationalDecisions(
      makeAnalysis({
        document_shape: 'executed_contract',
        contract_domain: 'waterway_maintenance',
        authorization_state: 'missing',
        quantity_levels: { authorized: 60000, actual: 75000 },
      }),
      { expected_domain: 'debris_removal' },
    );

    assert.equal(decisions.length, 3, 'exactly 3 rules must fire');

    const [first, second, third] = decisions;

    assert.equal(first.rule_id, 'invoice_overrun');
    assert.equal(first.severity, 'critical');
    assert.ok(first.operator_message.includes('75000'));
    assert.ok(first.operator_message.includes('60000'));
    assert.ok(first.operator_message.includes('15000'));

    assert.equal(second.rule_id, 'missing_authorization');
    assert.equal(second.severity, 'high');

    assert.equal(third.rule_id, 'domain_mismatch');
    assert.equal(third.severity, 'medium');
    assert.ok(third.operator_message.includes('waterway_maintenance'));
    assert.ok(third.operator_message.includes('debris_removal'));
  });
});
