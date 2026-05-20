import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';

import {
  buildEvidenceInserts,
  extractUuidPrefix,
  persistValidationRun,
} from '@/lib/validator/persistValidationRun';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { syncExecutionItems } from '@/lib/execution/syncExecutionItems';
import type { ValidationEvidence, ValidatorResult } from '@/types/validator';

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/lib/execution/syncExecutionItems', () => ({
  syncExecutionItems: vi.fn().mockResolvedValue({
    suppressedFindingIds: new Set(),
    executionItemIdsBySourceKey: new Map(),
  }),
}));

vi.mock('@/lib/validator/validatorDecisionSync', () => ({
  syncValidatorDecisions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/server/approvalSnapshots', () => ({
  persistApprovalSnapshot: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/server/approvalActionEngine', () => ({
  executeApprovalActions: vi.fn().mockResolvedValue({
    errors: [],
    approval_status: 'blocked',
    tasks_created: 0,
    tasks_updated: 0,
  }),
}));

const DOCUMENT_ID = '18550bfc-c057-4aae-bfa3-db896e36edb0';
const FINDING_ID = '074f8b55-cdb2-4829-9dab-e0e99e938336';
const PROJECT_ID = '437502f2-d46d-447f-81e3-f26fa7ba0c14';
const RUN_ID = '5bc135c4-d79c-4d3c-99bd-e4749ed78581';

function evidence(overrides: Partial<ValidationEvidence>): ValidationEvidence {
  return {
    id: 'evidence-1',
    finding_id: FINDING_ID,
    evidence_type: 'fact',
    source_document_id: null,
    source_page: null,
    fact_id: null,
    record_id: null,
    field_name: null,
    field_value: null,
    note: null,
    created_at: '2026-05-20T00:00:00.000Z',
    ...overrides,
  };
}

type Row = Record<string, any>;

class MockQuery {
  private filters: { column: string; value: any }[] = [];
  private inFilter: { column: string; values: any[] } | null = null;
  private selected = '';
  private payload: any = null;

  constructor(
    private readonly db: MockDatabase,
    private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update' | 'delete' = 'select',
  ) {}

  select(columns = '*') {
    this.selected = columns;
    return this;
  }

  insert(payload: any) {
    return new MockQuery(this.db, this.table, 'insert').withPayload(payload);
  }

  update(payload: any) {
    return new MockQuery(this.db, this.table, 'update').withPayload(payload);
  }

  delete() {
    return new MockQuery(this.db, this.table, 'delete');
  }

  eq(column: string, value: any) {
    this.filters.push({ column, value });
    return this;
  }

  in(column: string, values: any[]) {
    this.inFilter = { column, values };
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  single() {
    return this.execute(true);
  }

  maybeSingle() {
    return this.execute(true, true);
  }

  then(resolve: (value: any) => void, reject: (error: unknown) => void) {
    return this.execute().then(resolve, reject);
  }

  private withPayload(payload: any) {
    this.payload = payload;
    return this;
  }

  private async execute(single = false, maybe = false) {
    const result = this.db.execute({
      table: this.table,
      op: this.op,
      filters: this.filters,
      inFilter: this.inFilter,
      payload: this.payload,
      selected: this.selected,
    });

    if (single) {
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      return { data: row ?? null, error: row || maybe ? null : { message: 'not found' } };
    }

    return result;
  }
}

class MockDatabase {
  projects: Row[] = [{
    id: PROJECT_ID,
    organization_id: 'org-1',
    name: 'Golden Project',
    code: 'GOLDEN',
    validation_status: null,
    validation_summary_json: null,
  }];

  runs: Row[] = [];
  findings: Row[] = [
    {
      id: 'stale-finding',
      run_id: 'old-run',
      project_id: PROJECT_ID,
      rule_id: 'OLD_RULE',
      check_key: 'OLD_RULE:old-subject',
      subject_id: 'old-subject',
      status: 'open',
      severity: 'critical',
    },
  ];

  from(table: string) {
    return new MockQuery(this, table);
  }

  execute(query: {
    table: string;
    op: 'select' | 'insert' | 'update' | 'delete';
    filters: { column: string; value: any }[];
    inFilter: { column: string; values: any[] } | null;
    payload: any;
    selected: string;
  }) {
    if (query.op === 'insert') return this.insert(query);
    if (query.op === 'update') return this.update(query);
    return { data: this.selectRows(query), error: null };
  }

  private tableRows(table: string) {
    if (table === 'projects') return this.projects;
    if (table === 'project_validation_runs') return this.runs;
    if (table === 'project_validation_findings') return this.findings;
    return [];
  }

  private selectRows(query: Parameters<MockDatabase['execute']>[0]) {
    let rows = [...this.tableRows(query.table)];
    for (const filter of query.filters) {
      rows = rows.filter((row) => row[filter.column] === filter.value);
    }
    if (query.inFilter) {
      rows = rows.filter((row) => query.inFilter?.values.includes(row[query.inFilter.column]));
    }

    if (query.table === 'project_validation_runs') {
      rows.sort((a, b) => String(b.completed_at ?? b.run_at ?? '').localeCompare(String(a.completed_at ?? a.run_at ?? '')));
    }

    return rows;
  }

  private insert(query: Parameters<MockDatabase['execute']>[0]) {
    if (query.table === 'project_validation_runs') {
      const row = { id: RUN_ID, ...query.payload };
      this.runs.push(row);
      return { data: [{ id: row.id }], error: null };
    }

    if (query.table === 'project_validation_findings') {
      const row = { id: `finding-${this.findings.length}`, ...query.payload };
      this.findings.push(row);
      return { data: [{ id: row.id }], error: null };
    }

    return { data: [], error: null };
  }

  private update(query: Parameters<MockDatabase['execute']>[0]) {
    for (const row of this.selectRows(query)) {
      Object.assign(row, query.payload);
    }
    return { data: [], error: null };
  }
}

function validatorResult(): ValidatorResult {
  return {
    status: 'BLOCKED',
    rulesApplied: ['financial_integrity'],
    blocked_reasons: [],
    findings: [
      {
        id: 'candidate-finding',
        run_id: RUN_ID,
        project_id: PROJECT_ID,
        rule_id: 'NEW_RULE',
        check_key: 'NEW_RULE:new-subject',
        category: 'financial',
        severity: 'critical',
        status: 'open',
        subject_type: 'invoice',
        subject_id: 'new-subject',
        field: 'total_amount',
        expected: '10',
        actual: '5',
        variance: 5,
        variance_unit: 'amount',
        blocked_reason: null,
        decision_eligible: false,
        action_eligible: false,
        linked_decision_id: null,
        linked_action_id: null,
        resolved_by_user_id: null,
        resolved_at: null,
        created_at: '2026-05-20T00:00:00.000Z',
        updated_at: '2026-05-20T00:00:00.000Z',
        evidence: [],
      },
    ],
    summary: {},
  } as unknown as ValidatorResult;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('persistValidationRun evidence persistence', () => {
  it('extracts only UUID prefixes from compound semantic anchors', () => {
    assert.equal(
      extractUuidPrefix(`${DOCUMENT_ID}:canonical_contract_intelligence:rate_row_count`),
      DOCUMENT_ID,
    );
    assert.equal(extractUuidPrefix('canonical_contract_intelligence:rate_row_count'), null);
  });

  it('does not write compound semantic anchors into UUID evidence columns', () => {
    const anchor = `${DOCUMENT_ID}:canonical_contract_intelligence:rate_row_count`;
    const [insert] = buildEvidenceInserts(FINDING_ID, [
      evidence({
        source_document_id: DOCUMENT_ID,
        fact_id: anchor,
        field_name: 'rate_row_count',
        field_value: '46',
      }),
    ]);

    assert.equal(insert.source_document_id, DOCUMENT_ID);
    assert.equal(insert.fact_id, DOCUMENT_ID);
    assert.equal(insert.record_id, anchor);
    assert.equal(insert.field_name, 'rate_row_count');
  });

  it('preserves non-UUID semantic anchors in text fields while nulling UUID columns', () => {
    const anchor = 'canonical_contract_intelligence:rate_row_count';
    const [insert] = buildEvidenceInserts(FINDING_ID, [
      evidence({
        source_document_id: anchor,
        fact_id: anchor,
      }),
    ]);

    assert.equal(insert.source_document_id, null);
    assert.equal(insert.fact_id, null);
    assert.equal(insert.record_id, anchor);
  });
});

describe('persistValidationRun core persistence', () => {
  it('completes the run, updates project summary, and resolves stale findings before side effects', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as any);
    vi.mocked(syncExecutionItems).mockRejectedValueOnce(new Error('execution sync failed'));

    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');

    const run = db.runs[0];
    assert.equal(run.status, 'complete');
    assert.equal(run.findings_count, 1);
    assert.equal(run.critical_count, 1);
    assert.ok(run.completed_at);

    assert.equal(db.projects[0].validation_status, 'BLOCKED');
    assert.ok(db.projects[0].validation_summary_json);

    const stale = db.findings.find((finding) => finding.id === 'stale-finding');
    assert.equal(stale?.status, 'resolved');
    assert.ok(stale?.resolved_at);
  });
});
