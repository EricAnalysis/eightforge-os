import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { executeOperationsQuery } from '@/lib/operationsQuery/executeOperationsQuery';
import type { OperationalProjectRollupItem, OperationalQueueModel } from '@/lib/server/operationalQueue';

function emptyIntelligence(): OperationalQueueModel['intelligence'] {
  return {
    open_decisions_count: 0,
    open_actions_count: 0,
    needs_review_count: 0,
    blocked_count: 0,
    high_risk_count: 0,
    recent_feedback_exception_count: 0,
    low_trust_document_count: 0,
    recent_feedback_exceptions: [],
    low_trust_documents: [],
    needs_review_documents: [],
    blocked_documents: [],
  };
}

function rollupBlocked(id: string, name: string): OperationalProjectRollupItem {
  return {
    project: {
      id,
      name,
      code: 'TST',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      validation_summary_json: null,
    },
    href: `/platform/projects/${id}`,
    rollup: {
      status: {
        key: 'blocked',
        label: 'Blocked',
        tone: 'danger',
        detail: '',
        is_clear: false,
      },
      processed_document_count: 0,
      needs_review_document_count: 0,
      open_document_action_count: 0,
      unresolved_finding_count: 0,
      blocked_count: 2,
      anomaly_count: 0,
      project_clear: false,
      pending_actions: [],
      document_status_by_id: {},
    },
  };
}

function modelWithRollups(rollups: OperationalProjectRollupItem[]): OperationalQueueModel {
  return {
    generated_at: '2024-01-01T00:00:00.000Z',
    recent_documents_count: 0,
    superseded_counts: { decisions: 0, actions: 0 },
    warnings: [],
    decisions: [],
    actions: [],
    intelligence: emptyIntelligence(),
    project_rollups: rollups,
  };
}

describe('executeOperationsQuery queue routing', () => {
  it('puts OPEN_QUEUE first for blocked portfolio query with secondary project links', () => {
    const model = modelWithRollups([rollupBlocked('p1', 'Project One'), rollupBlocked('p2', 'Project Two')]);
    const r = executeOperationsQuery('which projects are blocked', model);
    assert.equal(r.routingActions[0]?.routingKind, 'OPEN_QUEUE');
    assert.equal(r.routingActions[0]?.queueType, 'blocked_projects');
    assert.ok(r.routingActions[0]?.href.includes('/platform/reviews'));
    assert.equal(r.nextAction, 'Open blocked projects queue');
    const secondaries = r.routingActions.slice(1);
    assert.ok(secondaries.length > 0);
    assert.ok(secondaries.every((a) => a.routingKind !== 'OPEN_QUEUE'));
  });

  it('still returns project routes for single-project fact queries', () => {
    const model = modelWithRollups([rollupBlocked('p1', 'Acme Demo')]);
    const r = executeOperationsQuery('when did Acme Demo start', model);
    assert.ok(r.routingActions.length > 0);
    assert.ok(r.routingActions.every((a) => a.routingKind !== 'OPEN_QUEUE'));
    assert.ok(r.routingActions.some((a) => a.href === '/platform/projects/p1'));
  });
});
