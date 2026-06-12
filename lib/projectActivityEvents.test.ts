import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  filterProjectActivityEvents,
  loadProjectActivityEvents,
  projectActivityFallbackEntityIds,
  type ProjectActivityEventScope,
} from './projectActivityEvents';

function scope(): ProjectActivityEventScope {
  return {
    projectId: 'project-1',
    projectDecisionIds: new Set(['decision-1']),
    projectTaskIds: new Set(['task-1']),
    projectDocumentIds: new Set(['doc-1']),
    executionItemIds: new Set(['exec-1']),
    executionFindingIds: new Set(['finding-1']),
  };
}

function createClient() {
  const calls: Array<{
    table: string;
    filters: Array<{ op: string; column: string; value: string | string[] | null }>;
  }> = [];
  return {
    calls,
    client: {
      from(table: 'activity_events') {
        const call = { table, filters: [] as Array<{ op: string; column: string; value: string | string[] | null }> };
        calls.push(call);
        const builder = {
          select() {
            return builder;
          },
          eq(column: string, value: string) {
            call.filters.push({ op: 'eq', column, value });
            return builder;
          },
          is(column: string, value: null) {
            call.filters.push({ op: 'is', column, value });
            return builder;
          },
          in(column: string, value: string[]) {
            call.filters.push({ op: 'in', column, value });
            return builder;
          },
          order() {
            return builder;
          },
          async limit() {
            return { data: [], error: null };
          },
        };
        return builder;
      },
    },
  };
}

describe('project activity event loading', () => {
  it('queries project_id first and uses only entity-scoped fallback ids', async () => {
    const harness = createClient();

    await loadProjectActivityEvents({
      client: harness.client,
      organizationId: 'org-1',
      scope: scope(),
    });

    assert.equal(harness.calls.length, 2);
    assert.deepEqual(harness.calls[0]?.filters, [
      { op: 'eq', column: 'organization_id', value: 'org-1' },
      { op: 'eq', column: 'project_id', value: 'project-1' },
    ]);
    assert.deepEqual(harness.calls[1]?.filters, [
      { op: 'eq', column: 'organization_id', value: 'org-1' },
      { op: 'is', column: 'project_id', value: null },
      {
        op: 'in',
        column: 'entity_id',
        value: projectActivityFallbackEntityIds(scope()),
      },
    ]);
  });

  it('keeps project-scoped and legacy entity-scoped audit rows', () => {
    const rows = filterProjectActivityEvents(
      [
        {
          id: 'event-1',
          project_id: 'project-1',
          entity_type: 'project',
          entity_id: 'project-1',
          event_type: 'validation_run_requested',
          old_value: null,
          new_value: null,
          changed_by: 'user-1',
          created_at: '2026-05-01T00:00:00Z',
        },
        {
          id: 'event-2',
          project_id: null,
          entity_type: 'document',
          entity_id: 'doc-1',
          event_type: 'review_recorded',
          old_value: null,
          new_value: { field_key: 'vendor_name' },
          changed_by: 'user-1',
          created_at: '2026-05-01T00:01:00Z',
        },
        {
          id: 'event-3',
          project_id: null,
          entity_type: 'document',
          entity_id: 'other-doc',
          event_type: 'review_recorded',
          old_value: null,
          new_value: null,
          changed_by: 'user-1',
          created_at: '2026-05-01T00:02:00Z',
        },
      ],
      scope(),
    );

    assert.deepEqual(rows.map((row) => row.id), ['event-1', 'event-2']);
  });
});
