import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { resolveProjectIssueObjects } from './resolveProjectIssueObjects';
import type { ProjectExecutionItemRow } from './executionItems';
import type { ProjectActivityEventRow, ProjectDecisionRow, ProjectDocumentRow } from './projectOverview';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

function finding(overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    id: 'finding-1',
    run_id: 'run-1',
    project_id: 'project-1',
    rule_id: 'RATE_RULE',
    check_key: 'RATE_MISMATCH',
    category: 'financial_integrity',
    severity: 'critical',
    status: 'open',
    subject_type: 'invoice_line',
    subject_id: 'line-1',
    field: 'rate',
    expected: '100',
    actual: '125',
    variance: 25,
    variance_unit: 'USD',
    blocked_reason: 'Billed rate exceeds contract rate.',
    finding_disposition: 'blocker',
    business_severity: 'high',
    problem: 'Rate mismatch on invoice line.',
    impact: 'Approval is blocked until the rate is reviewed.',
    required_action: 'Review the rate mismatch.',
    evidence_refs: ['evidence-1'],
    source_family: 'invoice',
    affected_amount: 250,
    approval_gate_effect: 'blocks_approval',
    exposure_type: 'rate_mismatch',
    decision_eligible: true,
    action_eligible: true,
    linked_decision_id: 'decision-1',
    linked_action_id: 'execution-1',
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: '2026-05-01T10:00:00.000Z',
    updated_at: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function decision(overrides: Partial<ProjectDecisionRow> = {}): ProjectDecisionRow {
  return {
    id: 'decision-1',
    document_id: 'doc-1',
    project_id: 'project-1',
    source: 'project_validator',
    decision_type: 'approval_review',
    title: 'Rate mismatch',
    summary: 'Review invoice rate against contract.',
    severity: 'critical',
    status: 'open',
    confidence: 0.92,
    last_detected_at: '2026-05-01T10:05:00.000Z',
    created_at: '2026-05-01T10:05:00.000Z',
    updated_at: '2026-05-01T10:06:00.000Z',
    due_at: null,
    assigned_to: null,
    details: {
      source_finding_ids: ['finding-1'],
      recommended_action: 'Approve corrected rate.',
      decision_rule_type: 'validator_rule',
    },
    ...overrides,
  };
}

function execution(overrides: Partial<ProjectExecutionItemRow> = {}): ProjectExecutionItemRow {
  return {
    id: 'execution-1',
    organization_id: 'org-1',
    project_id: 'project-1',
    source_type: 'validator_finding',
    source_id: 'finding-1',
    source_key: 'RATE_MISMATCH',
    severity: 'critical',
    title: 'Resolve rate mismatch',
    problem: 'Rate mismatch on invoice line.',
    expected_value: '100',
    actual_value: '125',
    impact: 'Approval blocked.',
    required_action: 'Review rate.',
    status: 'resolved',
    outcome: 'confirmed',
    evidence_refs: ['evidence-1'],
    fact_refs: [],
    validator_rule_key: 'RATE_RULE',
    override_reason: null,
    suppression_signature: null,
    created_at: '2026-05-01T10:07:00.000Z',
    updated_at: '2026-05-01T10:08:00.000Z',
    last_seen_at: null,
    overridden_at: null,
    resolved_at: '2026-05-01T10:08:00.000Z',
    ...overrides,
  };
}

function evidence(overrides: Partial<ValidationEvidence> = {}): ValidationEvidence {
  return {
    id: 'evidence-1',
    finding_id: 'finding-1',
    evidence_type: 'invoice_line',
    source_document_id: 'doc-1',
    source_page: 4,
    fact_id: 'invoice:rate',
    record_id: 'row-12',
    field_name: 'rate',
    field_value: '$125',
    note: 'Invoice line billed at $125.',
    created_at: '2026-05-01T10:01:00.000Z',
    ...overrides,
  };
}

describe('resolveProjectIssueObjects', () => {
  it('links finding, decision, execution, evidence, and audit into one issue object', () => {
    const events: ProjectActivityEventRow[] = [
      {
        id: 'event-1',
        project_id: 'project-1',
        entity_type: 'project_validation_finding',
        entity_id: 'finding-1',
        event_type: 'validation_finding_generated',
        old_value: null,
        new_value: { description: 'Finding generated.' },
        changed_by: null,
        created_at: '2026-05-01T10:02:00.000Z',
      },
      {
        id: 'event-2',
        project_id: 'project-1',
        entity_type: 'execution_item',
        entity_id: 'execution-1',
        event_type: 'execution_item_approved',
        old_value: null,
        new_value: { description: 'Execution approved.' },
        changed_by: 'operator-1',
        created_at: '2026-05-01T10:09:00.000Z',
      },
    ];
    const documents = [{
      id: 'doc-1',
      title: 'Invoice 1001',
      name: 'invoice.pdf',
      document_type: 'invoice',
      processing_status: 'extracted',
      processing_error: null,
      created_at: '2026-05-01T09:00:00.000Z',
      processed_at: '2026-05-01T09:05:00.000Z',
      project_id: 'project-1',
      domain: null,
    }] satisfies ProjectDocumentRow[];

    const issues = resolveProjectIssueObjects({
      projectId: 'project-1',
      findings: [finding()],
      decisions: [decision()],
      executionItems: [execution()],
      evidence: [evidence()],
      activityEvents: events,
      documents,
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].issueId, 'finding-1');
    assert.equal(issues[0].decisionId, 'decision-1');
    assert.equal(issues[0].executionItemId, 'execution-1');
    assert.equal(issues[0].status, 'COMPLETE');
    assert.equal(issues[0].lifecycleState, 'resolved');
    assert.equal(issues[0].evidenceTargets[0]?.sourceName, 'Invoice 1001');
    assert.equal(issues[0].evidenceTargets[0]?.pdfAnchor?.page, 4);
    assert.deepEqual(issues[0].auditChain.map((entry) => entry.activityType), [
      'validation_finding_generated',
      'execution_item_approved',
    ]);
  });

  it('does not hydrate shadow diagnostic data into authoritative issue fields', () => {
    const issues = resolveProjectIssueObjects({
      projectId: 'project-1',
      findings: [finding({ affected_amount: null })],
      evidence: [],
      decisions: [decision({
        details: {
          source_finding_ids: ['finding-1'],
          shadow_rate_diff: { exposure_amount: 999999 },
        },
      })],
      executionItems: [],
      activityEvents: [],
      documents: [],
    });

    assert.equal(issues[0].exposureAmount, null);
    assert.equal(issues[0].status, 'DECIDED');
  });

  it('logs persisted lifecycle drift without changing the legacy issue projection', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const issues = resolveProjectIssueObjects({
      projectId: 'project-1',
      findings: [finding({ lifecycle_state: 'open' })],
      evidence: [],
      decisions: [decision()],
      executionItems: [execution({ queue_state: 'blocked' })],
      activityEvents: [],
      documents: [],
    });

    assert.equal(issues[0].status, 'COMPLETE');
    assert.equal(issues[0].lifecycleState, 'resolved');
    assert.equal(warn.mock.calls.length, 1);
    assert.equal(warn.mock.calls[0]?.[0], '[state-projection-shadow-mismatch]');
    assert.deepEqual(warn.mock.calls[0]?.[1], {
      record_type: 'project_validation_finding',
      record_id: 'finding-1',
      project_id: 'project-1',
      legacy_value: 'resolved',
      persisted_value: 'open',
      surface: 'resolveProjectIssueObjects.findingBacked',
      timestamp: warn.mock.calls[0]?.[1].timestamp,
    });
    warn.mockRestore();
  });

  it('does not let a stale resolved source-matched execution item resolve a persisted-open finding', () => {
    const mismatches: unknown[] = [];
    const issues = resolveProjectIssueObjects({
      projectId: 'project-1',
      findings: [finding({
        severity: 'info',
        finding_disposition: 'requires_review',
        approval_gate_effect: 'requires_operator_review',
        linked_decision_id: null,
        linked_action_id: null,
        resolved_at: null,
        lifecycle_state: 'open',
      })],
      decisions: [],
      executionItems: [execution({
        id: 'stale-execution-1',
        source_type: 'validator_finding',
        source_id: 'finding-1',
        status: 'resolved',
        outcome: 'resolved',
      })],
      evidence: [],
      activityEvents: [],
      documents: [],
    }, {
      onMismatch: (payload) => mismatches.push(payload),
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].executionItemId, 'stale-execution-1');
    assert.equal(issues[0].executionItem?.id, 'stale-execution-1');
    assert.equal(issues[0].status, 'FINDING');
    assert.equal(issues[0].lifecycleState, 'open');
    assert.equal(mismatches.length, 0);
  });

  it('keeps terminal source-matched execution items complete when the finding is persisted resolved', () => {
    const issues = resolveProjectIssueObjects({
      projectId: 'project-1',
      findings: [finding({
        status: 'resolved',
        linked_decision_id: null,
        linked_action_id: null,
        resolved_at: '2026-05-01T10:08:00.000Z',
        lifecycle_state: 'resolved',
      })],
      decisions: [],
      executionItems: [execution({
        id: 'terminal-execution-1',
        source_type: 'validator_finding',
        source_id: 'finding-1',
        status: 'resolved',
        outcome: 'resolved',
      })],
      evidence: [],
      activityEvents: [],
      documents: [],
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].executionItemId, 'terminal-execution-1');
    assert.equal(issues[0].status, 'COMPLETE');
    assert.equal(issues[0].lifecycleState, 'resolved');
  });

  it('honors a resolved source-matched execution item when linked_action_id corroborates it mid-cascade', () => {
    const issues = resolveProjectIssueObjects({
      projectId: 'project-1',
      findings: [finding({
        severity: 'info',
        finding_disposition: 'requires_review',
        approval_gate_effect: 'requires_operator_review',
        linked_decision_id: null,
        linked_action_id: 'execution-1',
        resolved_at: null,
        lifecycle_state: 'resolved',
      })],
      decisions: [],
      executionItems: [execution({
        id: 'execution-1',
        source_type: 'validator_finding',
        source_id: 'finding-1',
        status: 'resolved',
        outcome: 'resolved',
      })],
      evidence: [],
      activityEvents: [],
      documents: [],
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].executionItemId, 'execution-1');
    assert.equal(issues[0].status, 'COMPLETE');
    assert.equal(issues[0].lifecycleState, 'resolved');
  });
});
