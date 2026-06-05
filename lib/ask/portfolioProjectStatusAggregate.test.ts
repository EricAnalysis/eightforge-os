import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildPortfolioProjectStatusAggregate } from '@/lib/ask/portfolioProjectStatusAggregate';

describe('buildPortfolioProjectStatusAggregate', () => {
  it('rolls up blocked, ready, and stale projects from per-project canonical state', () => {
    const aggregate = buildPortfolioProjectStatusAggregate([
      {
        project_id: 'blocked-project',
        project_name: 'Blocked Project',
        validation_status: 'BLOCKED',
        validation_summary: {
          status: 'BLOCKED',
          readiness: 'BLOCKED',
          raw_findings_that_must_not_be_read: [{ status: 'resolved' }],
        },
        execution_summary: {
          recommended_next_action: null,
          open_execution_items: [],
          payment_release_blockers: [],
        },
      },
      {
        project_id: 'ready-project',
        project_name: 'Ready Project',
        validation_status: 'VALIDATED',
        validation_summary: {
          status: 'VALIDATED',
          readiness: 'READY',
          raw_findings_that_must_not_be_read: [{ severity: 'critical' }],
        },
        execution_summary: {
          recommended_next_action: null,
          open_execution_items: [],
          payment_release_blockers: [],
        },
      },
      {
        project_id: 'stale-project',
        project_name: 'Stale Project',
        validation_status: 'VALIDATED',
        validation_summary: {
          status: 'VALIDATED',
          readiness: 'READY',
        },
        validation_snapshot_stale: true,
      },
      {
        project_id: 'execution-blocked-project',
        project_name: 'Execution Blocked Project',
        validation_status: 'VALIDATED',
        validation_summary: {
          status: 'VALIDATED',
          readiness: 'READY',
        },
        execution_summary: {
          recommended_next_action: {
            source_item_id: 'execution-1',
            priority_reason: 'Payment blocker remains open.',
          },
          open_execution_items: [{
            id: 'execution-1',
            status: 'open',
            required_action: 'Resolve payment hold.',
            blocker_flag: true,
          }],
          payment_release_blockers: [{
            action_id: 'execution-1',
            blocker_basis: 'Execution item blocks payment release.',
            payment_gate_impact: 'Payment release remains blocked.',
          }],
        },
      },
    ]);

    assert.deepEqual(aggregate.blocked_projects.map((project) => project.project_id), [
      'blocked-project',
      'execution-blocked-project',
    ]);
    assert.equal(aggregate.blocked_project_count, 2);
    assert.deepEqual(aggregate.approval_ready_projects.map((project) => project.project_id), [
      'ready-project',
    ]);
    assert.equal(aggregate.approval_ready_project_count, 1);
    assert.deepEqual(aggregate.stale_validation_projects.map((project) => project.project_id), [
      'stale-project',
    ]);
    assert.equal(aggregate.stale_validation_project_count, 1);
  });
});
