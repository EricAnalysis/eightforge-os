import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { closeDecisionLinkedWork } from '@/lib/server/decisionClosure';
import type { ProjectExecutionItemRow } from '@/lib/executionItems';

const TS = '2026-06-27T12:00:00.000Z';

type FindingRow = {
  id: string;
  project_id: string;
  linked_decision_id: string;
  linked_action_id: string | null;
  status: string;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  updated_at: string;
};

type TaskRow = {
  id: string;
  organization_id: string;
  decision_id: string;
  status: string;
  source: string;
  completed_at: string | null;
  updated_at: string;
};

type MockState = {
  findings: FindingRow[];
  tasks: TaskRow[];
  executionItems: ProjectExecutionItemRow[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
};

function makeExecutionItem(overrides: Partial<ProjectExecutionItemRow> = {}): ProjectExecutionItemRow {
  return {
    id: 'execution-1',
    organization_id: 'org-1',
    project_id: 'project-1',
    source_type: 'validator_finding',
    source_id: 'finding-1',
    source_key: 'invoice:INV-001:rate',
    severity: 'critical',
    title: 'Rate mismatch',
    problem: 'Invoice rate differs from contract.',
    expected_value: '100',
    actual_value: '125',
    impact: 'Approval is blocked.',
    required_action: 'Resolve rate mismatch.',
    status: 'open',
    outcome: null,
    evidence_refs: ['document:doc-1:page:1'],
    fact_refs: ['fact:doc-1:rate'],
    validator_rule_key: 'RATE_MATCH',
    override_reason: null,
    suppression_signature: null,
    created_at: TS,
    updated_at: TS,
    last_seen_at: TS,
    overridden_at: null,
    resolved_at: null,
    ...overrides,
  };
}

function matches(row: Record<string, unknown>, filters: Array<{ op: 'eq' | 'in'; field: string; value: unknown }>): boolean {
  return filters.every((filter) => {
    const rowValue = row[filter.field];
    if (filter.op === 'eq') return rowValue === filter.value;
    return Array.isArray(filter.value) && filter.value.includes(rowValue);
  });
}

function createAdminMock(state: MockState) {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      return { data: null, error: null };
    },
    from(table: string) {
      const filters: Array<{ op: 'eq' | 'in'; field: string; value: unknown }> = [];
      let patch: Record<string, unknown> | null = null;

      const rowsForTable = () => {
        if (table === 'project_validation_findings') return state.findings;
        if (table === 'workflow_tasks') return state.tasks;
        if (table === 'execution_items') return state.executionItems;
        throw new Error(`Unexpected table: ${table}`);
      };

      const query = {
        select: () => query,
        update(nextPatch: Record<string, unknown>) {
          patch = nextPatch;
          return query;
        },
        eq(field: string, value: unknown) {
          filters.push({ op: 'eq', field, value });
          return query;
        },
        in(field: string, value: unknown) {
          filters.push({ op: 'in', field, value });
          return query;
        },
        then(resolve: (value: { data?: unknown[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
          const rows = rowsForTable() as Array<Record<string, unknown>>;
          const matchedRows = rows.filter((row) => matches(row, filters));
          if (patch) {
            for (const row of matchedRows) {
              Object.assign(row, patch);
            }
          }
          return Promise.resolve({ data: matchedRows.map((row) => ({ ...row })), error: null }).then(resolve, reject);
        },
      };

      return query;
    },
  };
}

function createState(): MockState {
  return {
    findings: [{
      id: 'finding-1',
      project_id: 'project-1',
      linked_decision_id: 'decision-1',
      linked_action_id: 'execution-1',
      status: 'open',
      resolved_by_user_id: null,
      resolved_at: null,
      updated_at: TS,
    }],
    tasks: [{
      id: 'task-1',
      organization_id: 'org-1',
      decision_id: 'decision-1',
      status: 'blocked',
      source: 'approval_engine',
      completed_at: null,
      updated_at: TS,
    }],
    executionItems: [makeExecutionItem()],
    rpcCalls: [],
  };
}

describe('closeDecisionLinkedWork', () => {
  it('resolves linked findings, workflow tasks, execution items, and document status', async () => {
    const state = createState();
    const result = await closeDecisionLinkedWork({
      admin: createAdminMock(state) as never,
      decisionId: 'decision-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      documentId: 'doc-1',
      actorId: 'user-1',
      status: 'resolved',
      now: TS,
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.closedFindingIds, ['finding-1']);
    assert.deepEqual(result.closedWorkflowTaskIds, ['task-1']);
    assert.deepEqual(result.closedExecutionItemIds, ['execution-1']);
    assert.equal(state.findings[0]?.status, 'resolved');
    assert.equal(state.findings[0]?.resolved_by_user_id, 'user-1');
    assert.equal(state.tasks[0]?.status, 'resolved');
    assert.equal(state.tasks[0]?.completed_at, TS);
    assert.equal(state.executionItems[0]?.status, 'resolved');
    assert.equal(state.executionItems[0]?.outcome, 'resolved');
    assert.equal(state.executionItems[0]?.resolved_at, TS);
    assert.equal(state.rpcCalls[0]?.name, 'recompute_document_operational_status');
    assert.deepEqual(state.rpcCalls[0]?.args, { p_document_id: 'doc-1' });
  });

  it('suppresses linked work as dismissed, cancelled, and overridden', async () => {
    const state = createState();
    const result = await closeDecisionLinkedWork({
      admin: createAdminMock(state) as never,
      decisionId: 'decision-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      documentId: null,
      actorId: 'user-1',
      status: 'suppressed',
      now: TS,
    });

    assert.deepEqual(result.errors, []);
    assert.equal(state.findings[0]?.status, 'dismissed');
    assert.equal(state.tasks[0]?.status, 'cancelled');
    assert.equal(state.executionItems[0]?.status, 'resolved');
    assert.equal(state.executionItems[0]?.outcome, 'overridden');
    assert.equal(state.executionItems[0]?.override_reason, 'Suppressed through linked decision closure.');
    assert.equal(state.executionItems[0]?.overridden_at, TS);
    assert.equal(typeof state.executionItems[0]?.suppression_signature, 'string');
    assert.equal(state.rpcCalls[0]?.name, 'recompute_project_documents_operational_status');
    assert.deepEqual(state.rpcCalls[0]?.args, { p_project_id: 'project-1' });
  });
});
