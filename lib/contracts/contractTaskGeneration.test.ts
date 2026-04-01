import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ContractAnalysisResult, OperationalDecision } from '@/lib/contracts/types';
import { evaluateOperationalDecisions } from './contractDecisions';
import { generateOperationalTasks } from './contractTaskGeneration';

// Minimal OperationalDecision builder for unit tests.
function makeDecision(overrides: Partial<OperationalDecision> & Pick<OperationalDecision, 'rule_id' | 'severity'>): OperationalDecision {
  return {
    action: 'test_action',
    evidence: [{ field: 'test_field', value: 'test_value', source_description: 'test source' }],
    operator_message: 'Test operator message.',
    ...overrides,
  };
}

// Minimal ContractAnalysisResult builder for integration test.
function makeAnalysis(overrides: Partial<ContractAnalysisResult> = {}): ContractAnalysisResult {
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

describe('contractTaskGeneration — generateOperationalTasks', () => {

  // ─── bafo_block ──────────────────────────────────────────────────────────

  it('bafo_block generates an urgent task with contract_admin assignee', () => {
    const decisions = [makeDecision({ rule_id: 'bafo_block', severity: 'critical' })];
    const tasks = generateOperationalTasks(decisions);

    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.equal(task.source_rule_id, 'bafo_block');
    assert.equal(task.priority, 'urgent');
    assert.equal(task.due_logic, 'immediate');
    assert.equal(task.assignee_role, 'contract_admin');
    assert.equal(task.category, 'classification_review');
    assert.equal(task.status, 'pending');
    assert.equal(task.title, 'Verify document status — BAFO detected');
  });

  // ─── invoice_overrun ─────────────────────────────────────────────────────

  it('invoice_overrun generates an urgent finance task and preserves numeric values in description', () => {
    const message = 'Invoice quantity (112000) exceeds authorized quantity (85000) by 27000. Hold payment and review discrepancy.';
    const decisions = [makeDecision({
      rule_id: 'invoice_overrun',
      severity: 'critical',
      operator_message: message,
    })];
    const tasks = generateOperationalTasks(decisions);

    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.equal(task.source_rule_id, 'invoice_overrun');
    assert.equal(task.priority, 'urgent');
    assert.equal(task.due_logic, 'immediate');
    assert.equal(task.assignee_role, 'finance');
    assert.equal(task.category, 'financial_control');
    assert.ok(task.description.includes('112000'), 'description must preserve actual quantity');
    assert.ok(task.description.includes('85000'), 'description must preserve authorized quantity');
    assert.ok(task.description.includes('27000'), 'description must preserve delta');
  });

  // ─── missing_authorization ───────────────────────────────────────────────

  it('missing_authorization generates a high priority task with 24_hours due logic', () => {
    const decisions = [makeDecision({ rule_id: 'missing_authorization', severity: 'high' })];
    const tasks = generateOperationalTasks(decisions);

    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.equal(task.source_rule_id, 'missing_authorization');
    assert.equal(task.priority, 'high');
    assert.equal(task.due_logic, '24_hours');
    assert.equal(task.assignee_role, 'contract_admin');
    assert.equal(task.category, 'authorization_review');
    assert.equal(task.status, 'pending');
    assert.equal(task.title, 'Missing task order — billing authorization unconfirmed');
  });

  // ─── signature_verify ────────────────────────────────────────────────────

  it('signature_verify generates a high priority task with 24_hours due logic', () => {
    const decisions = [makeDecision({ rule_id: 'signature_verify', severity: 'high' })];
    const tasks = generateOperationalTasks(decisions);

    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.equal(task.source_rule_id, 'signature_verify');
    assert.equal(task.priority, 'high');
    assert.equal(task.due_logic, '24_hours');
    assert.equal(task.assignee_role, 'contract_admin');
    assert.equal(task.category, 'compliance_review');
    assert.equal(task.title, 'Signature verification required');
  });

  // ─── domain_mismatch ─────────────────────────────────────────────────────

  it('domain_mismatch does not generate a task', () => {
    const decisions = [makeDecision({ rule_id: 'domain_mismatch', severity: 'medium' })];
    const tasks = generateOperationalTasks(decisions);
    assert.deepEqual(tasks, []);
  });

  // ─── Edge cases ──────────────────────────────────────────────────────────

  it('empty decision array returns empty task array', () => {
    const tasks = generateOperationalTasks([]);
    assert.deepEqual(tasks, []);
  });

  it('info severity decisions do not generate tasks', () => {
    const decisions = [makeDecision({ rule_id: 'bafo_block', severity: 'info' })];
    const tasks = generateOperationalTasks(decisions);
    assert.deepEqual(tasks, []);
  });

  it('only critical and high severity decisions generate tasks', () => {
    const decisions = [
      makeDecision({ rule_id: 'bafo_block', severity: 'critical' }),
      makeDecision({ rule_id: 'domain_mismatch', severity: 'medium' }),
      makeDecision({ rule_id: 'missing_authorization', severity: 'high' }),
    ];
    const tasks = generateOperationalTasks(decisions);
    assert.equal(tasks.length, 2);
    const ruleIds = tasks.map((t) => t.source_rule_id);
    assert.ok(ruleIds.includes('bafo_block'));
    assert.ok(ruleIds.includes('missing_authorization'));
    assert.equal(ruleIds.includes('domain_mismatch'), false);
  });

  // ─── Stable order and determinism ────────────────────────────────────────

  it('multiple triggered decisions produce tasks in the same order as the input decisions', () => {
    const decisions = [
      makeDecision({ rule_id: 'bafo_block', severity: 'critical' }),
      makeDecision({ rule_id: 'invoice_overrun', severity: 'critical' }),
      makeDecision({ rule_id: 'missing_authorization', severity: 'high' }),
    ];
    const tasks = generateOperationalTasks(decisions);
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0].source_rule_id, 'bafo_block');
    assert.equal(tasks[1].source_rule_id, 'invoice_overrun');
    assert.equal(tasks[2].source_rule_id, 'missing_authorization');
  });

  it('task IDs are deterministic across runs', () => {
    const decisions = [
      makeDecision({ rule_id: 'bafo_block', severity: 'critical' }),
      makeDecision({ rule_id: 'missing_authorization', severity: 'high' }),
    ];
    const firstRun = generateOperationalTasks(decisions);
    const secondRun = generateOperationalTasks(decisions);

    assert.deepEqual(
      firstRun.map((t) => t.task_id),
      secondRun.map((t) => t.task_id),
    );
    assert.equal(firstRun[0].task_id, 'task_bafo_block');
    assert.equal(firstRun[1].task_id, 'task_missing_authorization');
  });

  it('generated tasks carry the full evidence chain from the source decision', () => {
    const evidence = [
      { field: 'document_shape', value: 'bafo_response', source_description: 'Document shape classification' },
    ];
    const decisions = [makeDecision({ rule_id: 'bafo_block', severity: 'critical', evidence })];
    const tasks = generateOperationalTasks(decisions);

    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].evidence_links, evidence);
    assert.deepEqual(tasks[0].source_decision.evidence, evidence);
  });

  it('task description preserves specific values from the source decision operator_message', () => {
    const message = 'Invoice quantity (97000) exceeds authorized quantity (85000) by 12000. Hold payment and review discrepancy.';
    const decisions = [makeDecision({ rule_id: 'invoice_overrun', severity: 'critical', operator_message: message })];
    const tasks = generateOperationalTasks(decisions);

    assert.equal(tasks[0].description, message);
    assert.ok(tasks[0].description.includes('97000'));
    assert.ok(tasks[0].description.includes('85000'));
    assert.ok(tasks[0].description.includes('12000'));
  });

  // ─── Integration: pipe through Batch 8 → Batch 9 ─────────────────────────

  it('integration: Batch 8 decisions pipe into Batch 9 task generation correctly', () => {
    // ContractAnalysis that triggers invoice_overrun and missing_authorization.
    // domain_mismatch also fires but must NOT produce a task (medium severity).
    const analysis = makeAnalysis({
      document_shape: 'executed_contract',
      contract_domain: 'waterway_maintenance',
      authorization_state: 'missing',
      quantity_levels: { authorized: 85000, actual: 112000 },
    });

    const decisions = evaluateOperationalDecisions(analysis, { expected_domain: 'debris_removal' });
    // Verify Batch 8 produced the expected decisions
    const decisionIds = decisions.map((d) => d.rule_id);
    assert.ok(decisionIds.includes('invoice_overrun'));
    assert.ok(decisionIds.includes('missing_authorization'));
    assert.ok(decisionIds.includes('domain_mismatch'));
    assert.equal(decisionIds.includes('bafo_block'), false);

    const tasks = generateOperationalTasks(decisions);

    // Only invoice_overrun (critical) and missing_authorization (high) produce tasks.
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].source_rule_id, 'invoice_overrun');
    assert.equal(tasks[0].priority, 'urgent');
    assert.equal(tasks[0].assignee_role, 'finance');
    assert.ok(tasks[0].description.includes('112000'));
    assert.ok(tasks[0].description.includes('85000'));

    assert.equal(tasks[1].source_rule_id, 'missing_authorization');
    assert.equal(tasks[1].priority, 'high');
    assert.equal(tasks[1].due_logic, '24_hours');
    assert.equal(tasks[1].assignee_role, 'contract_admin');

    // domain_mismatch must not appear
    assert.equal(tasks.find((t) => t.source_rule_id === 'domain_mismatch'), undefined);

    // All tasks carry evidence
    for (const task of tasks) {
      assert.ok(task.evidence_links.length > 0, `${task.source_rule_id} must have evidence`);
      assert.equal(task.status, 'pending');
    }
  });
});
