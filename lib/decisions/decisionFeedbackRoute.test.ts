import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getActorContextMock,
  getSupabaseAdminMock,
  logActivityEventMock,
  processWorkflowTriggersMock,
  requestDecisionFeedbackRevalidationMock,
  requestDecisionStatusRevalidationMock,
} = vi.hoisted(() => ({
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  logActivityEventMock: vi.fn().mockResolvedValue({ ok: true }),
  processWorkflowTriggersMock: vi.fn().mockResolvedValue(undefined),
  requestDecisionFeedbackRevalidationMock: vi.fn(),
  requestDecisionStatusRevalidationMock: vi.fn(),
}));

vi.mock('@/lib/server/getActorContext', () => ({
  getActorContext: getActorContextMock,
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: logActivityEventMock,
}));

vi.mock('@/lib/server/workflows/processWorkflowTriggers', () => ({
  processWorkflowTriggers: processWorkflowTriggersMock,
}));

vi.mock('@/lib/validator/revalidationRequests', () => ({
  requestDecisionFeedbackRevalidation: requestDecisionFeedbackRevalidationMock,
  requestDecisionStatusRevalidation: requestDecisionStatusRevalidationMock,
}));

vi.mock('@/lib/server/decisionFeedback', () => ({
  logDecisionFeedback: vi.fn().mockResolvedValue({ ok: true }),
}));

import { POST } from '@/app/api/decisions/[id]/feedback/route';

type Row = Record<string, unknown>;

class Query {
  private filters: { column: string; value: unknown }[] = [];
  private inFilters: { column: string; values: unknown[] }[] = [];
  private payload: Row | null = null;

  constructor(
    private readonly db: FeedbackDb,
    private readonly table: string,
    private readonly op: 'select' | 'update' | 'upsert' = 'select',
  ) {}

  select() {
    return this;
  }

  update(payload: Row) {
    return new Query(this.db, this.table, 'update').withPayload(payload);
  }

  upsert(payload: Row) {
    return new Query(this.db, this.table, 'upsert').withPayload(payload);
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.inFilters.push({ column, values });
    return this;
  }

  order() {
    return this;
  }

  single() {
    const result = this.execute();
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    return Promise.resolve({ data: row ?? null, error: row ? null : { message: 'not found' } });
  }

  then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  private withPayload(payload: Row) {
    this.payload = payload;
    return this;
  }

  private execute() {
    if (this.op === 'upsert') {
      this.db.feedback.push(this.payload ?? {});
      return { data: [], error: null };
    }
    if (this.op === 'update') {
      for (const row of this.rows()) Object.assign(row, this.payload);
      return { data: this.rows(), error: null };
    }
    return { data: this.rows(), error: null };
  }

  private rows() {
    let rows = [...this.db.rowsFor(this.table)];
    for (const filter of this.filters) {
      rows = rows.filter((row) => row[filter.column] === filter.value);
    }
    for (const filter of this.inFilters) {
      rows = rows.filter((row) => filter.values.includes(row[filter.column]));
    }
    return rows;
  }
}

class FeedbackDb {
  decisions: Row[] = [{
    id: 'decision-1',
    organization_id: 'org-1',
    project_id: 'project-1',
    document_id: 'doc-1',
    status: 'in_review',
    severity: 'critical',
  }];
  findings: Row[] = [{
    id: 'finding-1',
    linked_decision_id: 'decision-1',
    linked_action_id: 'execution-1',
    project_id: 'project-1',
    status: 'open',
  }];
  workflowTasks: Row[] = [{
    id: 'task-1',
    organization_id: 'org-1',
    decision_id: 'decision-1',
    status: 'open',
    completed_at: null,
  }];
  executionItems: Row[] = [{
    id: 'execution-1',
    organization_id: 'org-1',
    project_id: 'project-1',
    source_type: 'validator_finding',
    source_id: 'finding-1',
    source_key: 'finding-1',
    validator_rule_key: 'rule-1',
    expected_value: null,
    actual_value: null,
    evidence_refs: null,
    fact_refs: null,
    status: 'open',
    outcome: null,
    overridden_at: null,
    resolved_at: null,
  }];
  feedback: Row[] = [];
  rpcCalls: Array<{ name: string; args: Row }> = [];

  from(table: string) {
    return new Query(this, table);
  }

  rpc(name: string, args: Row) {
    this.rpcCalls.push({ name, args });
    return Promise.resolve({ data: null, error: null });
  }

  rowsFor(table: string) {
    if (table === 'decisions') return this.decisions;
    if (table === 'project_validation_findings') return this.findings;
    if (table === 'workflow_tasks') return this.workflowTasks;
    if (table === 'execution_items') return this.executionItems;
    if (table === 'decision_feedback') return this.feedback;
    return [];
  }
}

afterEach(() => {
  getActorContextMock.mockReset();
  getSupabaseAdminMock.mockReset();
  logActivityEventMock.mockClear();
  processWorkflowTriggersMock.mockClear();
  requestDecisionFeedbackRevalidationMock.mockClear();
  requestDecisionStatusRevalidationMock.mockClear();
});

describe('decision feedback route', () => {
  it('accepting correct feedback resolves the linked decision lifecycle', async () => {
    const db = new FeedbackDb();
    getActorContextMock.mockResolvedValue({
      ok: true,
      actor: {
        actorId: 'user-1',
        organizationId: 'org-1',
        displayName: 'Operator',
        role: 'admin',
      },
    });
    getSupabaseAdminMock.mockReturnValue(db);

    const response = await POST(
      new NextRequest('http://localhost/api/decisions/decision-1/feedback', {
        method: 'POST',
        body: JSON.stringify({
          is_correct: true,
          feedback_type: 'correct',
          disposition: 'accept',
        }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'decision-1' }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'resolved');
    assert.equal(db.decisions[0].status, 'resolved');
    assert.ok(db.decisions[0].resolved_at);
    assert.equal(db.findings[0].status, 'resolved');
    assert.ok(db.findings[0].resolved_at);
    assert.equal(db.workflowTasks[0].status, 'resolved');
    assert.ok(db.workflowTasks[0].completed_at);
    assert.equal(db.executionItems[0].status, 'resolved');
    assert.equal(db.executionItems[0].outcome, 'resolved');
    assert.ok(db.executionItems[0].resolved_at);
    expect(requestDecisionStatusRevalidationMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      actorId: 'user-1',
      newStatus: 'resolved',
    });
    expect(requestDecisionFeedbackRevalidationMock).not.toHaveBeenCalled();
  });

  it('suppressing incorrect feedback closes linked work and requests feedback revalidation', async () => {
    const db = new FeedbackDb();
    db.decisions[0].status = 'open';
    getActorContextMock.mockResolvedValue({
      ok: true,
      actor: {
        actorId: 'user-1',
        organizationId: 'org-1',
        displayName: 'Operator',
        role: 'admin',
      },
    });
    getSupabaseAdminMock.mockReturnValue(db);

    const response = await POST(
      new NextRequest('http://localhost/api/decisions/decision-1/feedback', {
        method: 'POST',
        body: JSON.stringify({
          is_correct: false,
          feedback_type: 'incorrect',
          disposition: 'suppress',
          review_error_type: 'edge_case',
          notes: 'Duplicate validator finding.',
        }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'decision-1' }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'dismissed');
    assert.equal(db.decisions[0].status, 'dismissed');
    assert.equal(db.findings[0].status, 'dismissed');
    assert.equal(db.workflowTasks[0].status, 'cancelled');
    assert.equal(db.executionItems[0].status, 'resolved');
    assert.equal(db.executionItems[0].outcome, 'overridden');
    assert.equal(db.rpcCalls[0]?.name, 'recompute_document_operational_status');
    assert.deepEqual(db.rpcCalls[0]?.args, { p_document_id: 'doc-1' });
    expect(requestDecisionFeedbackRevalidationMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      actorId: 'user-1',
      feedbackType: 'incorrect',
    });
    expect(requestDecisionStatusRevalidationMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      actorId: 'user-1',
      newStatus: 'dismissed',
    });
  });
});
