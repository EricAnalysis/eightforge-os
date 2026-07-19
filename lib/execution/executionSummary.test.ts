import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildProjectExecutionSummary } from '@/lib/execution/executionSummary';
import type { ProjectExecutionItemRow } from '@/lib/executionItems';

function executionItem(overrides: Partial<ProjectExecutionItemRow> = {}): ProjectExecutionItemRow {
  return {
    id: 'execution-1',
    organization_id: 'org-1',
    project_id: 'golden-project',
    source_type: 'validator_finding',
    source_id: 'finding-1',
    source_key: 'rule:finding-1',
    severity: 'high',
    title: 'Resolve invoice support',
    problem: 'Invoice support is missing.',
    expected_value: 'support complete',
    actual_value: 'missing',
    impact: 'Approval readiness is blocked.',
    required_action: 'Upload or link the missing support.',
    status: 'open',
    outcome: null,
    evidence_refs: ['document:invoice-doc-1'],
    fact_refs: ['fact:invoice-doc-1:ticket'],
    validator_rule_key: 'REQUIRED_SOURCES_INVOICE_SUPPORT_MISSING',
    override_reason: null,
    suppression_signature: null,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
    last_seen_at: null,
    overridden_at: null,
    resolved_at: null,
    ...overrides,
  };
}

describe('buildProjectExecutionSummary', () => {
  it('adds execution priority, open item, and payment blocker truth from execution items', () => {
    const summary = buildProjectExecutionSummary([
      executionItem({ id: 'execution-low', severity: 'low', status: 'resolvable' }),
      executionItem({ id: 'execution-blocker', severity: 'high', status: 'open' }),
      executionItem({ id: 'execution-resolved', status: 'resolved' }),
      executionItem({ id: 'execution-superseded', status: 'superseded' }),
    ]);

    assert.deepEqual(summary.recommended_next_action, {
      source_item_id: 'execution-blocker',
      priority_reason: 'Resolve invoice support: Approval readiness is blocked.',
    });
    assert.deepEqual(summary.open_execution_items.map((item) => item.id), [
      'execution-blocker',
      'execution-low',
    ]);
    assert.equal(summary.open_execution_items[0]?.blocker_flag, true);
    assert.deepEqual(summary.payment_release_blockers, [{
      action_id: 'execution-blocker',
      blocker_basis: 'Invoice support is missing.; required action Upload or link the missing support.',
      payment_gate_impact: 'Payment release remains blocked until this execution item is resolved or overridden with audit basis.',
    }]);
  });
});
