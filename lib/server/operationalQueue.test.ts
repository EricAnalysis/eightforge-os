import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { canonicalApprovalForProject } from '../commandCenterApproval';
import type { ProjectExecutionItemRow } from '../executionItems';
import type {
  ProjectDecisionRow,
  ProjectDocumentReviewRow,
  ProjectDocumentRow,
  ProjectOperationalRollup,
  ProjectRecord,
  ProjectTaskRow,
} from '../projectOverview';
import { buildOperationalQueueModel, mergeProjectRollupWithExecutionItems } from './operationalQueue';

const baseProject: ProjectRecord = {
  id: 'project-1',
  name: 'Williamson Debris Ops',
  code: 'WDO-1',
  status: 'active',
  created_at: '2026-03-20T00:00:00Z',
};

function buildDocument(
  overrides: Partial<ProjectDocumentRow> = {},
): ProjectDocumentRow {
  return {
    id: 'doc-1',
    title: 'Debris DMS Checklist',
    name: 'dms-checklist.pdf',
    document_type: 'disposal_checklist',
    domain: 'operations',
    processing_status: 'decisioned',
    processing_error: null,
    created_at: '2026-03-20T00:00:00Z',
    processed_at: '2026-03-20T01:00:00Z',
    project_id: 'project-1',
    intelligence_trace: null,
    ...overrides,
  };
}

function buildDecision(
  overrides: Partial<ProjectDecisionRow> = {},
): ProjectDecisionRow {
  return {
    id: 'decision-1',
    document_id: 'doc-1',
    decision_type: 'missing_support',
    title: 'Missing signed disposal ticket',
    summary: 'Signed disposal ticket is not linked.',
    severity: 'high',
    status: 'open',
    confidence: 0.88,
    last_detected_at: '2026-03-20T02:00:00Z',
    created_at: '2026-03-20T02:00:00Z',
    due_at: null,
    assigned_to: null,
    details: null,
    assignee: null,
    documents: null,
    ...overrides,
  };
}

function buildTask(
  overrides: Partial<ProjectTaskRow> = {},
): ProjectTaskRow {
  return {
    id: 'task-1',
    decision_id: 'decision-1',
    document_id: 'doc-1',
    task_type: 'documentation',
    title: 'Attach signed disposal ticket',
    description: 'Attach signed disposal ticket for reviewer validation.',
    priority: 'high',
    status: 'open',
    created_at: '2026-03-20T02:05:00Z',
    updated_at: '2026-03-20T02:05:00Z',
    due_at: null,
    assigned_to: null,
    details: null,
    source_metadata: null,
    assignee: null,
    documents: null,
    ...overrides,
  };
}

describe('buildOperationalQueueModel', () => {
  it('keeps canonical approved projects approved when only non-blocking validator actions remain', () => {
    const project = {
      ...baseProject,
      validation_status: 'VALIDATED' as const,
      validation_summary_json: {
        validator_status: 'READY',
        critical_count: 0,
        warning_count: 6,
        requires_review_count: 0,
        open_count: 6,
        exposure: {
          total_billed_amount: 815559.35,
          total_contract_supported_amount: 815559.35,
          total_transaction_supported_amount: 815559.35,
          total_fully_reconciled_amount: 815559.35,
          total_unreconciled_amount: 0,
          total_at_risk_amount: 0,
          total_requires_verification_amount: 0,
          support_gap_tolerance_amount: 500,
          at_risk_tolerance_amount: 500,
          invoices: [
            {
              invoice_number: '2026-002',
              billed_amount: 534757.1,
              billed_amount_source: 'invoice_total',
              contract_supported_amount: 534757.1,
              transaction_supported_amount: 534757.1,
              fully_reconciled_amount: 534757.1,
              supported_amount: 534757.1,
              unreconciled_amount: 0,
              at_risk_amount: 0,
              requires_verification_amount: 0,
              reconciliation_status: 'MATCH',
            },
          ],
        },
      },
    };
    const validatorActionsByProjectId = new Map([
      [
        project.id,
        [
          {
            id: 'finding-warning-1',
            href: `/platform/projects/${project.id}#project-validator`,
            title: 'Confirm activation basis',
            due_label: 'Review',
            due_tone: 'warning' as const,
            assignee_label: 'Unassigned',
            priority_label: 'Medium',
            priority_tone: 'warning' as const,
            status_label: 'Open',
            source_document_title: null,
            source_document_type: 'validator',
            approval_status: 'needs_review' as const,
            next_step: 'Confirm the activation basis before treating the contract as work authorizing.',
          },
        ],
      ],
    ]);

    const model = buildOperationalQueueModel({
      projects: [project],
      documents: [
        buildDocument({ id: 'doc-contract', title: 'Contract', document_type: 'contract' }),
        buildDocument({ id: 'doc-invoice', title: 'Invoice 2026-002', document_type: 'invoice' }),
        buildDocument({ id: 'doc-support', title: 'Support Workbook', document_type: 'transaction_data' }),
        buildDocument({ id: 'doc-rates', title: 'Rate Schedule', document_type: 'rate_schedule' }),
      ],
      decisions: [],
      tasks: [],
      documentReviews: [],
      validatorFindingActionsByProjectId: validatorActionsByProjectId,
    });

    const rollup = model.project_rollups[0]?.rollup;
    assert.equal(rollup?.status.label, 'Approved');
    assert.equal(rollup?.blocked_count, 0);
    assert.equal(rollup?.pending_actions.length, 1);
    assert.equal(rollup?.pending_actions[0]?.approval_status, 'needs_review');
  });

  it('promotes trace decisions and trace tasks into shared queue items', () => {
    const document = buildDocument({
      intelligence_trace: {
        facts: {},
        decisions: [
          {
            id: 'trace-decision-1',
            family: 'missing',
            severity: 'warning',
            title: 'Missing TDEC permit support',
            detail: 'Permit support is missing for dumpsite validation.',
            confidence: 0.74,
            primary_action: {
              id: 'trace-action-1',
              type: 'attach',
              target_object_type: 'document',
              target_label: 'TDEC permit',
              description: 'Attach TDEC permit for dumpsite validation',
              expected_outcome: 'Permit support is linked for reviewer validation.',
              resolvable: false,
            },
            suggested_actions: [],
            missing_source_context: ['TDEC permit'],
            source_refs: ['permit_ref'],
            fact_refs: ['fact_ref'],
          },
        ],
        flow_tasks: [
          {
            id: 'trace-task-1',
            title: 'Attach TDEC permit for dumpsite validation',
            verb: 'attach',
            entity_type: 'review',
            expected_outcome: 'Permit support is linked for reviewer validation.',
            priority: 'high',
            auto_safe: false,
            source_decision_ids: ['trace-decision-1'],
            flow_type: 'documentation',
            suggested_owner: 'Field reviewer',
          },
        ],
        generated_at: '2026-03-20T01:00:00Z',
        engine_version: 'document_intelligence:v2',
      },
    });

    const model = buildOperationalQueueModel({
      projects: [baseProject],
      documents: [document],
      decisions: [],
      tasks: [],
      documentReviews: [],
    });

    assert.equal(model.decisions.length, 1);
    assert.equal(model.decisions[0]?.kind, 'trace_decision');
    assert.equal(model.decisions[0]?.document_id, 'doc-1');

    assert.equal(model.actions.length, 1);
    assert.equal(model.actions[0]?.kind, 'trace_task');
    assert.equal(model.actions[0]?.document_id, 'doc-1');

    assert.equal(model.intelligence.open_decisions_count, 1);
    assert.equal(model.intelligence.open_actions_count, 1);
    assert.equal(model.intelligence.needs_review_count, 1);
    assert.equal(model.intelligence.blocked_count, 0);

    assert.equal(model.project_rollups[0]?.rollup.needs_review_document_count, 1);
    assert.equal(model.project_rollups[0]?.rollup.open_document_action_count, 1);
    assert.equal(model.project_rollups[0]?.rollup.unresolved_finding_count, 1);
  });

  it('backfills an action from a persisted decision when no task row exists', () => {
    const document = buildDocument();
    const decision = buildDecision({
      details: {
        reason: 'Signed disposal ticket is missing from the source packet.',
        primary_action: {
          id: 'action-1',
          type: 'attach',
          target_object_type: 'document',
          target_label: 'signed disposal ticket',
          description: 'Attach signed disposal ticket',
          expected_outcome: 'Signed disposal ticket is linked for reviewer validation.',
          resolvable: false,
        },
        project_context: {
          label: 'Williamson Debris Ops',
          project_id: 'project-1',
          project_code: 'WDO-1',
        },
      },
    });
    const reviews: ProjectDocumentReviewRow[] = [
      {
        document_id: 'doc-1',
        status: 'in_review',
        reviewed_at: null,
      },
    ];

    const model = buildOperationalQueueModel({
      projects: [baseProject],
      documents: [document],
      decisions: [decision],
      tasks: [],
      documentReviews: reviews,
    });

    assert.equal(model.decisions.length, 1);
    assert.equal(model.decisions[0]?.kind, 'persisted_decision');
    assert.equal(model.decisions[0]?.review_status, 'in_review');

    assert.equal(model.actions.length, 1);
    assert.equal(model.actions[0]?.kind, 'decision_action');
    assert.equal(model.actions[0]?.decision_id, 'decision-1');
    assert.equal(model.actions[0]?.title, 'Attach signed disposal ticket');
    assert.equal(model.actions[0]?.project_id, 'project-1');

    assert.equal(model.intelligence.open_decisions_count, 1);
    assert.equal(model.intelligence.open_actions_count, 1);
    assert.equal(model.intelligence.high_risk_count, 1);
    assert.equal(model.project_rollups[0]?.rollup.open_document_action_count, 1);
  });

  it('does not create a duplicate synthetic action when a persisted task already exists', () => {
    const document = buildDocument();
    const decision = buildDecision({
      details: {
        reason: 'Signed disposal ticket is missing from the source packet.',
        primary_action: {
          id: 'action-1',
          type: 'attach',
          target_object_type: 'document',
          target_label: 'signed disposal ticket',
          description: 'Attach signed disposal ticket',
          expected_outcome: 'Signed disposal ticket is linked for reviewer validation.',
          resolvable: false,
        },
      },
    });
    const task = buildTask();

    const model = buildOperationalQueueModel({
      projects: [baseProject],
      documents: [document],
      decisions: [decision],
      tasks: [task],
      documentReviews: [],
    });

    assert.equal(model.actions.length, 1);
    assert.equal(model.actions[0]?.kind, 'persisted_task');
    assert.equal(model.actions[0]?.task_id, 'task-1');
  });

  it('surfaces validator finding actions in the unified queue rollup', () => {
    const document = buildDocument();

    const model = buildOperationalQueueModel({
      projects: [baseProject],
      documents: [document],
      decisions: [],
      tasks: [],
      documentReviews: [],
      validatorFindingActionsByProjectId: new Map([
        ['project-1', [{
          id: 'validator-finding:finding-1',
          href: '/platform/documents/doc-1?source=project&projectId=project-1&page=3',
          title: 'Rate 6A exceeds contract rate',
          due_label: 'Requires Verification',
          due_tone: 'danger',
          assignee_label: 'Operator queue',
          priority_label: 'Critical',
          priority_tone: 'danger',
          status_label: 'Blocked',
          source_document_title: 'Contract document + Invoice extraction',
          source_document_type: null,
          invoice_number: 'INV-300',
          approval_status: 'blocked',
          requires_verification_amount: 5,
          at_risk_amount: null,
          next_step: 'Review contract rate schedule',
          expected_value: '$75.00',
          actual_value: '$80.00',
          variance_label: '+$5.00',
        }]],
      ]),
    });

    const rollupActions = model.project_rollups[0]?.rollup.pending_actions ?? [];
    assert.equal(rollupActions.length, 1);
    assert.equal(rollupActions[0]?.title, 'Rate 6A exceeds contract rate');
    assert.equal(rollupActions[0]?.approval_status, 'blocked');
    assert.equal(rollupActions[0]?.requires_verification_amount, 5);
    assert.equal(rollupActions[0]?.expected_value, '$75.00');
    assert.equal(rollupActions[0]?.actual_value, '$80.00');
    assert.equal(rollupActions[0]?.variance_label, '+$5.00');
    assert.equal(model.project_rollups[0]?.rollup.status.label, 'Blocked');
  });
});

function buildExecutionItem(
  overrides: Partial<ProjectExecutionItemRow> = {},
): ProjectExecutionItemRow {
  return {
    id: 'ex-1',
    organization_id: 'org-1',
    project_id: 'project-1',
    source_type: 'validator_finding',
    source_id: 'finding-1',
    source_key: 'rate_mismatch',
    severity: 'medium',
    title: 'Test execution item',
    problem: 'Mismatch',
    expected_value: null,
    actual_value: null,
    impact: 'Exposure',
    required_action: 'Confirm contracted rate',
    status: 'resolvable',
    outcome: null,
    evidence_refs: null,
    fact_refs: null,
    validator_rule_key: 'RATE_CHECK',
    override_reason: null,
    suppression_signature: null,
    created_at: '2026-03-20T00:00:00Z',
    updated_at: '2026-03-20T00:00:00Z',
    last_seen_at: null,
    overridden_at: null,
    resolved_at: null,
    ...overrides,
  };
}

function baseRollupFixture(overrides: Partial<ProjectOperationalRollup> = {}): ProjectOperationalRollup {
  return {
    status: {
      key: 'needs_review',
      label: 'Needs Review',
      tone: 'warning',
      detail: 'Documents require operator review.',
      is_clear: false,
    },
    processed_document_count: 1,
    needs_review_document_count: 1,
    open_document_action_count: 2,
    unresolved_finding_count: 2,
    blocked_count: 0,
    anomaly_count: 0,
    project_clear: false,
    pending_actions: [
      {
        id: 'a1',
        href: '/platform/projects/project-1',
        title: 'Follow up',
        due_label: 'Open',
        due_tone: 'warning',
        assignee_label: 'Ops',
        priority_label: 'Medium',
        priority_tone: 'warning',
        status_label: 'Open',
        source_document_title: null,
        source_document_type: null,
      },
    ],
    document_status_by_id: {},
    ...overrides,
  };
}

describe('mergeProjectRollupWithExecutionItems (Command Center rollups)', () => {
  it('does not downgrade document/validator rollup status when no execution items remain', () => {
    const base = baseRollupFixture();
    const merged = mergeProjectRollupWithExecutionItems({
      rollup: base,
      unresolvedItems: [],
      pendingExecutionActions: [],
    });

    assert.equal(merged.status.key, 'needs_review');
    assert.equal(merged.status.label, 'Needs Review');
    assert.equal(merged.open_document_action_count, base.open_document_action_count);
    assert.equal(merged.unresolved_finding_count, base.unresolved_finding_count);
    assert.equal(merged.pending_actions.length, base.pending_actions.length);
  });

  it('keeps approved status when only non-blocking execution items are unresolved', () => {
    const base = baseRollupFixture({
      status: {
        key: 'operationally_clear',
        label: 'Approved',
        tone: 'success',
        detail: 'No blockers.',
        is_clear: true,
      },
      needs_review_document_count: 0,
      project_clear: true,
    });
    const item = buildExecutionItem({ status: 'resolvable', severity: 'medium' });
    const merged = mergeProjectRollupWithExecutionItems({
      rollup: base,
      unresolvedItems: [item],
      pendingExecutionActions: [],
    });

    assert.equal(merged.status.key, 'operationally_clear');
    assert.equal(merged.status.label, 'Approved');
    assert.equal(merged.project_clear, true);
    assert.equal(merged.pending_actions.length, base.pending_actions.length);
  });

  it('suppresses stale activation-basis actions on approved rollups', () => {
    const base = baseRollupFixture({
      status: {
        key: 'operationally_clear',
        label: 'Approved',
        tone: 'success',
        detail: 'No blockers.',
        is_clear: true,
      },
      needs_review_document_count: 0,
      project_clear: true,
      pending_actions: [
        {
          id: 'stale-activation',
          href: '/platform/projects/project-1#project-decisions',
          title: 'Activation trigger detected but status unresolved',
          due_label: 'Decision follow-up',
          due_tone: 'warning',
          assignee_label: 'Ops',
          priority_label: 'High',
          priority_tone: 'warning',
          status_label: 'Open',
          source_document_title: 'Contract',
          source_document_type: 'contract',
          approval_status: 'needs_review',
          next_step: 'Confirm the activation basis before treating the contract as work-authorizing.',
        },
        {
          id: 'valid-follow-up',
          href: '/platform/projects/project-1#project-decisions',
          title: 'Confirm derived expiration date',
          due_label: 'Decision follow-up',
          due_tone: 'warning',
          assignee_label: 'Ops',
          priority_label: 'Medium',
          priority_tone: 'warning',
          status_label: 'Open',
          source_document_title: 'Contract',
          source_document_type: 'contract',
          approval_status: 'needs_review',
          next_step: 'Confirm the derived expiration date against the cited term clause.',
        },
      ],
      open_document_action_count: 2,
      unresolved_finding_count: 2,
    });
    const merged = mergeProjectRollupWithExecutionItems({
      rollup: base,
      unresolvedItems: [],
      pendingExecutionActions: [],
    });

    assert.equal(merged.status.label, 'Approved');
    assert.deepEqual(merged.pending_actions.map((action) => action.id), ['valid-follow-up']);
    assert.equal(merged.open_document_action_count, 1);
    assert.equal(merged.unresolved_finding_count, 1);
  });

  it('counts N blocking findings and their N mirrored execution items once', () => {
    const blockerCount = 3;
    const base = baseRollupFixture({
      status: {
        key: 'blocked',
        label: 'Blocked',
        tone: 'danger',
        detail: 'Three validation findings block approval.',
        is_clear: false,
      },
      blocked_count: blockerCount,
    });
    const items = Array.from({ length: blockerCount }, (_, index) => buildExecutionItem({
      id: `ex-block-${index}`,
      status: 'open',
      severity: 'high',
    }));
    const executionActions = items.map((item, index) => ({
      id: `exec-action-${index}`,
      href: `/platform/projects/project-1?executionItemId=${item.id}`,
      title: `Execution follow-up ${index + 1}`,
      due_label: 'Blocking',
      due_tone: 'danger' as const,
      assignee_label: 'Unassigned',
      priority_label: 'High',
      priority_tone: 'warning' as const,
      status_label: 'Open',
      source_document_title: null,
      source_document_type: 'validator',
      approval_status: 'blocked' as const,
    }));
    const merged = mergeProjectRollupWithExecutionItems({
      rollup: base,
      unresolvedItems: items,
      pendingExecutionActions: executionActions,
    });

    assert.equal(merged.status.key, 'blocked');
    assert.equal(merged.status.label, 'Blocked');
    assert.equal(merged.blocked_count, blockerCount);
    assert.notEqual(merged.blocked_count, blockerCount * 2);
    assert.equal(merged.open_document_action_count, base.open_document_action_count + blockerCount);
    assert.equal(merged.unresolved_finding_count, base.unresolved_finding_count + blockerCount);
    assert.deepEqual(
      merged.pending_actions.slice(0, blockerCount).map((action) => action.id),
      executionActions.map((action) => action.id),
    );
    assert.equal(merged.pending_actions.at(-1)?.id, 'a1');
  });

  it('does not let stale execution items without live blocking findings change approval state', () => {
    const staleItemCount = 3;
    const base = baseRollupFixture({
      status: {
        key: 'operationally_clear',
        label: 'Approved',
        tone: 'success',
        detail: 'Clear.',
        is_clear: true,
      },
      needs_review_document_count: 0,
      project_clear: true,
    });
    const items = Array.from({ length: staleItemCount }, (_, index) => buildExecutionItem({
      id: `stale-execution-item-${index}`,
      status: 'resolvable',
      severity: 'critical',
    }));
    const merged = mergeProjectRollupWithExecutionItems({
      rollup: base,
      unresolvedItems: items,
      pendingExecutionActions: [],
    });

    assert.equal(merged.blocked_count, 0);
    assert.equal(merged.status.key, 'operationally_clear');
    assert.equal(merged.status.label, 'Approved');
    assert.equal(merged.project_clear, true);
    assert.equal(merged.open_document_action_count, base.open_document_action_count + staleItemCount);
    assert.equal(merged.unresolved_finding_count, base.unresolved_finding_count + staleItemCount);
  });

  it('preserves execution items in worklist and action fields', () => {
    const base = baseRollupFixture();
    const execAction = {
      id: 'exec-pending-1',
      href: '/platform/projects/project-1?executionItemId=ex-1',
      title: 'Execution follow-up',
      due_label: 'Resolvable Now',
      due_tone: 'warning' as const,
      assignee_label: 'Unassigned',
      priority_label: 'Medium',
      priority_tone: 'warning' as const,
      status_label: 'Open',
      source_document_title: null,
      source_document_type: 'validator',
      approval_status: 'needs_review' as const,
    };
    const merged = mergeProjectRollupWithExecutionItems({
      rollup: base,
      unresolvedItems: [buildExecutionItem()],
      pendingExecutionActions: [execAction],
    });

    assert.equal(merged.pending_actions.length, 2);
    assert.equal(merged.pending_actions[0]?.id, 'exec-pending-1');
    assert.equal(merged.pending_actions[1]?.id, 'a1');
    assert.equal(merged.open_document_action_count, base.open_document_action_count + 1);
    assert.equal(merged.unresolved_finding_count, base.unresolved_finding_count + 1);
  });

  it('keeps the Overview rollup aligned with Command Center canonical approval', () => {
    const project = {
      validation_status: 'BLOCKED' as const,
      validation_summary_json: {
        readiness: 'BLOCKED',
        blocker_count: 1,
        critical_count: 1,
        open_count: 1,
        validator_blockers: [
          {
            rule_id: 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
            severity: 'critical',
            subject_id: 'fact:doc:line:6',
          },
        ],
      },
    };
    const commandCenterApproval = canonicalApprovalForProject(project);
    const base = baseRollupFixture({
      status: {
        key: 'blocked',
        label: commandCenterApproval.label,
        tone: 'danger',
        detail: 'One validation finding blocks approval.',
        is_clear: false,
      },
      blocked_count: commandCenterApproval.blocker_count,
    });
    const overviewRollup = mergeProjectRollupWithExecutionItems({
      rollup: base,
      unresolvedItems: [buildExecutionItem({ id: 'mirrored-execution-item' })],
      pendingExecutionActions: [],
    });

    assert.equal(overviewRollup.blocked_count, commandCenterApproval.blocker_count);
    assert.equal(overviewRollup.blocked_count > 0, commandCenterApproval.is_blocked);
    assert.equal(overviewRollup.status.key === 'blocked', commandCenterApproval.is_blocked);
  });
});
