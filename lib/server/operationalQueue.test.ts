import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type {
  ProjectDecisionRow,
  ProjectDocumentReviewRow,
  ProjectDocumentRow,
  ProjectRecord,
  ProjectTaskRow,
} from '../projectOverview';
import { buildOperationalQueueModel } from './operationalQueue';

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
});
