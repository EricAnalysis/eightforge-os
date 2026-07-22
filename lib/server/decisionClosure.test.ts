import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import { closeDecisionLinkedWork, finalizeDecision } from '@/lib/server/decisionClosure';
import type { ProjectExecutionItemRow } from '@/lib/executionItems';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: vi.fn().mockResolvedValue({ ok: true, id: 'activity-1' }),
}));

vi.mock('@/lib/server/workflows/processWorkflowTriggers', () => ({
  processWorkflowTriggers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/validator/revalidationRequests', () => ({
  requestDecisionStatusRevalidation: vi.fn().mockResolvedValue({ status: 'triggered' }),
}));

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
  rule_id: string;
  check_key: string;
  category: string;
  severity: 'critical' | 'warning' | 'info';
  subject_type: string;
  subject_id: string;
  field: string | null;
  expected: string | null;
  actual: string | null;
  variance: number | null;
  variance_unit: string | null;
  blocked_reason: string | null;
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
  decisions: Array<Record<string, unknown>>;
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
        if (table === 'decisions') return state.decisions;
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
        single() {
          const rows = rowsForTable() as Array<Record<string, unknown>>;
          const matchedRows = rows.filter((row) => matches(row, filters));
          if (patch) {
            for (const row of matchedRows) Object.assign(row, patch);
          }
          return Promise.resolve({ data: matchedRows[0] ? { ...matchedRows[0] } : null, error: null });
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
      rule_id: 'RATE_MATCH',
      check_key: 'RATE_MATCH:invoice-1',
      category: 'financial',
      severity: 'critical',
      subject_type: 'invoice_line',
      subject_id: 'invoice-1:line-1',
      field: 'rate',
      expected: '100',
      actual: '125',
      variance: 25,
      variance_unit: 'amount',
      blocked_reason: 'Rate mismatch',
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
    decisions: [{
      id: 'decision-1',
      organization_id: 'org-1',
      project_id: 'project-1',
      document_id: 'doc-1',
      status: 'open',
      severity: 'critical',
    }],
    rpcCalls: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(logActivityEvent).mockResolvedValue({ ok: true, id: 'activity-1' });
});

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

    const resolvedEvents = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_type === 'validation_finding_resolved');
    assert.equal(resolvedEvents.length, 1);
    assert.equal(resolvedEvents[0]?.entity_id, 'finding-1');
    assert.equal(resolvedEvents[0]?.old_value?.status, 'open');
    assert.equal(resolvedEvents[0]?.new_value?.status, 'resolved');
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
      status: 'dismissed',
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

  it('emits one finding event per linked finding plus the decision status event', async () => {
    const state = createState();
    state.findings.push({
      ...state.findings[0],
      id: 'finding-2',
      check_key: 'RATE_MATCH:invoice-2',
      subject_id: 'invoice-2:line-1',
      linked_action_id: null,
    });

    await finalizeDecision({
      admin: createAdminMock(state) as never,
      decision: state.decisions[0] as never,
      organizationId: 'org-1',
      actorId: 'user-1',
      status: 'resolved',
    });

    const events = vi.mocked(logActivityEvent).mock.calls.map(([event]) => event);
    assert.deepEqual(
      events.filter((event) => event.event_type === 'validation_finding_resolved')
        .map((event) => event.entity_id)
        .sort(),
      ['finding-1', 'finding-2'],
    );
    assert.equal(events.filter((event) => event.event_type === 'status_changed').length, 1);
    assert.equal(state.findings.filter((finding) => finding.status === 'resolved').length, 2);
  });

  it('keeps decision closure successful when a finding event fails', async () => {
    const state = createState();
    vi.mocked(logActivityEvent).mockRejectedValueOnce(new Error('activity unavailable'));

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

    assert.deepEqual(result.closedFindingIds, ['finding-1']);
    assert.equal(state.findings[0]?.status, 'resolved');
    assert.equal(result.errors.some((error) => error.startsWith('activity_event_failed:finding-1:')), true);
  });
});
