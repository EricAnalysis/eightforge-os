import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';

import {
  buildEvidenceInserts,
  extractUuidPrefix,
  persistValidationRun,
} from '@/lib/validator/persistValidationRun';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { syncExecutionItems } from '@/lib/execution/syncExecutionItems';
import { syncValidatorDecisions } from '@/lib/validator/validatorDecisionSync';
import { persistApprovalSnapshot } from '@/lib/server/approvalSnapshots';
import { finalizeDecision } from '@/lib/server/decisionClosure';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import type { ValidationEvidence, ValidatorResult } from '@/types/validator';

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/lib/server/decisionClosure', () => ({
  finalizeDecision: vi.fn().mockResolvedValue({
    decision: { id: 'decision-1', status: 'dismissed' },
    linkedFindingIds: [],
    linkedClosure: {
      closedFindingIds: [],
      closedWorkflowTaskIds: [],
      closedExecutionItemIds: [],
      recomputedDocumentStatus: true,
      errors: [],
    },
  }),
}));

vi.mock('@/lib/execution/syncExecutionItems', () => ({
  syncExecutionItems: vi.fn().mockResolvedValue({
    created: 0,
    updated: 0,
    resolvable: 0,
    staleResolved: 0,
    suppressed: 0,
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

type Row = Record<string, unknown>;
type TestFinding = ValidatorResult['findings'][number] & { evidence?: ValidationEvidence[] };
type AdminClient = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

class MockQuery {
  private filters: { column: string; value: unknown }[] = [];
  private inFilters: { column: string; values: unknown[] }[] = [];
  private selected = '';
  private payload: Row | Row[] | null = null;

  constructor(
    private readonly db: MockDatabase,
    private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update' | 'delete' = 'select',
  ) {}

  select(columns = '*') {
    this.selected = columns;
    return this;
  }

  insert(payload: Row | Row[]) {
    return new MockQuery(this.db, this.table, 'insert').withPayload(payload);
  }

  update(payload: Row) {
    return new MockQuery(this.db, this.table, 'update').withPayload(payload);
  }

  delete() {
    return new MockQuery(this.db, this.table, 'delete');
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

  limit() {
    return this;
  }

  single() {
    return this.execute(true);
  }

  maybeSingle() {
    return this.execute(true, true);
  }

  then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
    return this.execute().then(resolve, reject);
  }

  private withPayload(payload: Row | Row[]) {
    this.payload = payload;
    return this;
  }

  private async execute(single = false, maybe = false) {
    const result = this.db.execute({
      table: this.table,
      op: this.op,
      filters: this.filters,
      inFilters: this.inFilters,
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
  existingFindingCheckKeyBatchSizes: number[] = [];

  projects: Row[] = [{
    id: PROJECT_ID,
    organization_id: 'org-1',
    name: 'Golden Project',
    code: 'GOLDEN',
    validation_status: null,
    validation_summary_json: null,
  }];

  runs: Row[] = [];
  evidenceRows: Row[] = [];
  decisions: Row[] = [];
  decisionFeedback: Row[] = [];
  executionItems: Row[] = [];
  rateLinks: Row[] = [];
  findings: Row[] = [
    {
      id: 'stale-finding',
      run_id: 'old-run',
      project_id: PROJECT_ID,
      rule_id: 'OLD_RULE',
      check_key: 'OLD_RULE:old-subject',
      category: 'financial',
      subject_id: 'old-subject',
      subject_type: 'invoice',
      field: 'total_amount',
      expected: '10',
      actual: '5',
      variance: 5,
      variance_unit: 'amount',
      blocked_reason: null,
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
    filters: { column: string; value: unknown }[];
    inFilters: { column: string; values: unknown[] }[];
    payload: Row | Row[] | null;
    selected: string;
  }) {
    if (query.op === 'insert') return this.insert(query);
    if (query.op === 'update') return this.update(query);
    return { data: this.selectRows(query).map((row) => ({ ...row })), error: null };
  }

  private tableRows(table: string) {
    if (table === 'projects') return this.projects;
    if (table === 'project_validation_runs') return this.runs;
    if (table === 'project_validation_findings') return this.findings;
    if (table === 'project_validation_evidence') return this.evidenceRows;
    if (table === 'decisions') return this.decisions;
    if (table === 'decision_feedback') return this.decisionFeedback;
    if (table === 'execution_items') return this.executionItems;
    if (table === 'invoice_line_rate_links') return this.rateLinks;
    return [];
  }

  private selectRows(query: Parameters<MockDatabase['execute']>[0]) {
    let rows = [...this.tableRows(query.table)];
    if (
      query.table === 'project_validation_findings'
      && query.inFilters.some((filter) => filter.column === 'check_key')
    ) {
      this.existingFindingCheckKeyBatchSizes.push(
        query.inFilters.find((filter) => filter.column === 'check_key')?.values.length ?? 0,
      );
    }

    for (const filter of query.filters) {
      rows = rows.filter((row) => row[filter.column] === filter.value);
    }
    for (const inFilter of query.inFilters) {
      rows = rows.filter((row) => inFilter.values.includes(row[inFilter.column]));
    }

    if (query.table === 'project_validation_runs') {
      rows.sort((a, b) => String(b.completed_at ?? b.run_at ?? '').localeCompare(String(a.completed_at ?? a.run_at ?? '')));
    }

    return rows;
  }

  private insert(query: Parameters<MockDatabase['execute']>[0]) {
    if (query.table === 'project_validation_runs') {
      const row = { id: RUN_ID, ...(query.payload as Row) };
      this.runs.push(row);
      return { data: [{ id: row.id }], error: null };
    }

    if (query.table === 'project_validation_findings') {
      const row = { id: `finding-${this.findings.length}`, ...(query.payload as Row) };
      this.findings.push(row);
      return { data: [{ id: row.id }], error: null };
    }

    if (query.table === 'project_validation_evidence') {
      const rows = Array.isArray(query.payload) ? query.payload : [query.payload as Row];
      this.evidenceRows.push(...rows.map((row, index) => ({
        id: `evidence-${this.evidenceRows.length + index}`,
        ...row,
      })));
      return { data: [], error: null };
    }

    return { data: [], error: null };
  }

  private update(query: Parameters<MockDatabase['execute']>[0]) {
    const rows = this.selectRows(query);
    for (const row of rows) {
      Object.assign(row, query.payload);
    }
    return { data: rows.map((row) => ({ ...row })), error: null };
  }
}

function validationFinding(overrides: Partial<TestFinding>): TestFinding {
  return {
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
    ...overrides,
  } as TestFinding;
}

function validatorResult(
  findings: TestFinding[] = [validationFinding({})],
  summary: Record<string, unknown> = {},
): ValidatorResult {
  return {
    status: 'BLOCKED',
    rulesApplied: ['financial_integrity'],
    blocked_reasons: [],
    findings,
    summary,
  } as unknown as ValidatorResult;
}

function contractValidationSummary(params: {
  documentId?: string | null;
  suppressedIssues: Array<{ issue_id: string; reason: string }>;
}): Record<string, unknown> {
  return {
    contract_validation_context: {
      document_id: params.documentId ?? DOCUMENT_ID,
      analysis: {
        trace_summary: {
          suppressed_issues: params.suppressedIssues,
        },
      },
    },
  };
}

function contractDecision(overrides: Row = {}): Row {
  const issueId = String(overrides.issue_id ?? 'pricing_applicability_requires_context');
  const issueType = String(overrides.issue_type ?? 'pricing_applicability_unclear');
  const decisionType = `contract_intelligence:${issueType}`;
  return {
    id: String(overrides.id ?? 'decision-1'),
    organization_id: 'org-1',
    project_id: PROJECT_ID,
    document_id: DOCUMENT_ID,
    decision_type: decisionType,
    status: 'in_review',
    severity: 'critical',
    created_by: 'user-1',
    details: {
      rule_id: decisionType,
      normalized_decision: {
        id: `contract:intelligence:${issueId}`,
      },
    },
    ...overrides,
  };
}

function persistedOpenFindings(db: MockDatabase) {
  return db.findings.filter((finding) => finding.run_id === RUN_ID && finding.status === 'open');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(logActivityEvent).mockResolvedValue({ ok: true, id: 'activity-1' });
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
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
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

    const snapshotOptions = vi.mocked(persistApprovalSnapshot).mock.calls[0]?.[3];
    assert.equal(snapshotOptions?.runId, RUN_ID);
    assert.deepEqual(snapshotOptions?.findingIds, ['finding-1']);

    const resolvedEvents = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_type === 'validation_finding_resolved');
    assert.equal(resolvedEvents.length, 1);
    assert.equal(resolvedEvents[0]?.entity_id, 'stale-finding');
    assert.equal(db.findings.find((finding) => finding.id === 'stale-finding')?.status, 'resolved');
    assert.deepEqual(resolvedEvents[0]?.old_value, {
      status: 'open',
      rule_id: 'OLD_RULE',
      check_key: 'OLD_RULE:old-subject',
      severity: 'critical',
      business_severity: 'critical',
      finding_disposition: 'blocker',
      affected_amount: null,
    });
    assert.equal(resolvedEvents[0]?.new_value?.status, 'resolved');
    assert.equal(resolvedEvents[0]?.new_value?.run_id, RUN_ID);
    assert.equal(resolvedEvents[0]?.new_value?.trigger_source, 'manual');
  });

  it('persists N approval blockers once when their N execution items are synchronized', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    const blockerCount = 3;
    const blockers = Array.from({ length: blockerCount }, (_, index) => validationFinding({
      id: `candidate-finding-${index}`,
      rule_id: 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO',
      check_key: `INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO:invoice-${index}`,
      category: 'financial_integrity',
      subject_id: `invoice-${index}`,
      decision_eligible: true,
      action_eligible: true,
      approval_gate_effect: 'blocks_approval',
      finding_disposition: 'blocker',
      business_severity: 'critical',
    }));
    const executionItemIdsBySourceKey = new Map(
      blockers.map((finding, index) => [finding.check_key, `execution-item-${index}`]),
    );
    vi.mocked(syncExecutionItems).mockResolvedValueOnce({
      created: blockerCount,
      updated: 0,
      resolvable: 0,
      staleResolved: 0,
      suppressed: 0,
      superseded: 0,
      suppressedFindingIds: new Set(),
      executionItemIdsBySourceKey,
    });

    await persistValidationRun(
      PROJECT_ID,
      validatorResult(blockers),
      'manual',
      'user-1',
      'input-hash',
      { trigger_entity_type: 'decision', trigger_entity_id: 'decision-1' },
    );

    const snapshotCall = vi.mocked(persistApprovalSnapshot).mock.calls[0];
    assert.ok(snapshotCall);
    const [snapshotProjectId, , rollup, snapshotOptions] = snapshotCall;
    assert.equal(snapshotProjectId, PROJECT_ID);
    assert.equal(rollup.blocked_count, blockerCount);
    assert.notEqual(rollup.blocked_count, blockerCount * 2);
    assert.equal(rollup.unresolved_finding_count, blockerCount);
    assert.equal(rollup.status.label, 'Blocked');
    assert.equal(rollup.project_clear, false);
    assert.deepEqual(
      rollup.pending_actions.map((action) => ({
        id: action.id,
        status_label: action.status_label,
        due_tone: action.due_tone,
      })),
      blockers.map((finding) => ({
        id: `finding-${finding.check_key}`,
        status_label: 'Blocked',
        due_tone: 'danger',
      })),
    );

    assert.equal(snapshotOptions?.runId, RUN_ID);
    assert.equal(snapshotOptions?.createdBy, 'user-1');
    assert.deepEqual(snapshotOptions?.triggerEntity, {
      trigger_entity_type: 'decision',
      trigger_entity_id: 'decision-1',
    });
    assert.deepEqual(snapshotOptions?.findingIds, ['finding-1', 'finding-2', 'finding-3']);

    const persisted = persistedOpenFindings(db);
    assert.equal(persisted.length, blockerCount);
    for (const [index, finding] of blockers.entries()) {
      const persistedFinding = persisted.find((row) => row.check_key === finding.check_key);
      assert.equal(persistedFinding?.linked_action_id, `execution-item-${index}`);
    }
  });

  it('emits one resolved event per stale finding without changing canonical counts', async () => {
    const db = new MockDatabase();
    db.findings.push({
      ...db.findings[0],
      id: 'stale-finding-2',
      check_key: 'OLD_RULE:other-subject',
      subject_id: 'other-subject',
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');

    const resolvedEvents = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_type === 'validation_finding_resolved');
    assert.deepEqual(resolvedEvents.map((event) => event.entity_id).sort(), [
      'stale-finding',
      'stale-finding-2',
    ]);
    assert.equal(db.runs[0]?.findings_count, 1);
    assert.equal(db.findings.filter((finding) => finding.status === 'resolved').length, 2);
  });

  it('propagates an automatic trigger source to the resolved event', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(PROJECT_ID, validatorResult(), 'document_processed');

    const resolvedEvent = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .find((event) => event.event_type === 'validation_finding_resolved');
    assert.equal(resolvedEvent?.new_value?.trigger_source, 'document_processed');
  });

  it('does not emit a resolved event for a finding that was already resolved', async () => {
    const db = new MockDatabase();
    db.findings[0].status = 'resolved';
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');

    const resolvedEvents = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_type === 'validation_finding_resolved');
    assert.equal(resolvedEvents.length, 0);
  });

  it('does not duplicate a resolved event on a repeated validation run', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');
    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');

    const resolvedEvents = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_type === 'validation_finding_resolved');
    assert.equal(resolvedEvents.length, 1);
  });

  it('emits only one resolved event when validation runs race to resolve the same finding', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await Promise.all([
      persistValidationRun(PROJECT_ID, validatorResult(), 'manual'),
      persistValidationRun(PROJECT_ID, validatorResult(), 'document_processed'),
    ]);

    const resolvedEvents = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_type === 'validation_finding_resolved');
    assert.equal(resolvedEvents.length, 1);
    assert.equal(resolvedEvents[0]?.entity_id, 'stale-finding');
  });

  it('preserves the validation run completed resolved findings aggregate', async () => {
    const db = new MockDatabase();
    db.runs.push({
      id: 'old-run',
      project_id: PROJECT_ID,
      status: 'complete',
      completed_at: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');

    const completedEvents = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_type === 'validation_run_completed');
    assert.equal(completedEvents.length, 1);
    assert.equal(completedEvents[0]?.new_value?.resolved_findings, 1);
  });

  it('emits no lifecycle event for an unchanged finding that remains open', async () => {
    const current = validationFinding({ id: 'existing-finding' });
    const db = new MockDatabase();
    db.findings = [{ ...current }];
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(PROJECT_ID, validatorResult([current]), 'manual');

    const lifecycleEvents = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_type === 'validation_finding_resolved'
        || event.event_type === 'validation_finding_changed');
    assert.equal(lifecycleEvents.length, 0);
    assert.equal(db.findings[0]?.status, 'open');
  });

  it('emits one changed event when a reused open finding changes severity', async () => {
    const previous = validationFinding({ id: 'existing-finding', severity: 'warning' });
    const current = validationFinding({ id: 'candidate-finding', severity: 'critical' });
    const db = new MockDatabase();
    db.findings = [{ ...previous }];
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(PROJECT_ID, validatorResult([current]), 'manual');

    const changedEvents = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.event_type === 'validation_finding_changed');
    assert.equal(changedEvents.length, 1);
    assert.equal(changedEvents[0]?.entity_id, 'existing-finding');
    assert.equal(changedEvents[0]?.old_value?.severity, 'warning');
    assert.equal(changedEvents[0]?.new_value?.severity, 'critical');
    assert.equal(db.findings[0]?.status, 'open');
  });

  it('keeps a validation run successful when lifecycle event delivery rejects', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    vi.mocked(logActivityEvent).mockImplementation(async (event) => {
      if (event.event_type === 'validation_finding_resolved') {
        throw new Error('activity unavailable');
      }
      return { ok: true, id: 'activity-1' };
    });

    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');

    assert.equal(db.runs[0]?.status, 'complete');
    assert.equal(db.runs[0]?.findings_count, 1);
    assert.equal(db.findings.find((finding) => finding.id === 'stale-finding')?.status, 'resolved');
  });

  it('correlates a decision-triggered snapshot and resolved event to the same run', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(
      PROJECT_ID,
      validatorResult(),
      'manual',
      'user-1',
      'input-hash',
      { trigger_entity_type: 'decision', trigger_entity_id: 'decision-1' },
    );

    const snapshotOptions = vi.mocked(persistApprovalSnapshot).mock.calls[0]?.[3];
    const resolvedEvent = vi.mocked(logActivityEvent).mock.calls
      .map(([event]) => event)
      .find((event) => event.event_type === 'validation_finding_resolved');
    assert.equal(snapshotOptions?.runId, RUN_ID);
    assert.equal(snapshotOptions?.triggerEntity?.trigger_entity_id, 'decision-1');
    assert.equal(resolvedEvent?.new_value?.run_id, RUN_ID);
    assert.equal(resolvedEvent?.new_value?.trigger_source, 'manual');
    assert.equal(resolvedEvent?.entity_id, 'stale-finding');
  });

  it('closes a suppressed pricing applicability contract decision through finalizeDecision', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    db.decisions.push(contractDecision({
      id: 'pricing-decision',
      status: 'in_review',
    }));
    const reason = 'Suppressed: operator-confirmed disposal fee treatment resolves pricing applicability ambiguity.';

    await persistValidationRun(
      PROJECT_ID,
      validatorResult([], contractValidationSummary({
        suppressedIssues: [{
          issue_id: 'pricing_applicability_requires_context',
          reason,
        }],
      })),
      'override_applied',
      'user-1',
    );

    assert.equal(vi.mocked(finalizeDecision).mock.calls.length, 1);
    assert.equal(vi.mocked(finalizeDecision).mock.calls[0]?.[0].decision.id, 'pricing-decision');
    assert.equal(vi.mocked(finalizeDecision).mock.calls[0]?.[0].status, 'dismissed');
    assert.equal(vi.mocked(finalizeDecision).mock.calls[0]?.[0].operatorAction, reason);
  });

  it('closes another suppressible contract issue type without pricing-specific handling', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    db.decisions.push(contractDecision({
      id: 'fema-decision',
      issue_id: 'fema_gate_ambiguous',
      issue_type: 'fema_gate_ambiguous',
      decision_type: 'contract_intelligence:fema_gate_ambiguous',
      details: {
        rule_id: 'contract_intelligence:fema_gate_ambiguous',
        normalized_decision: {
          id: 'contract:intelligence:fema_gate_ambiguous',
        },
      },
    }));

    await persistValidationRun(
      PROJECT_ID,
      validatorResult([], contractValidationSummary({
        suppressedIssues: [{
          issue_id: 'fema_gate_ambiguous',
          reason: 'Suppressed because FEMA context is not an operational gate.',
        }],
      })),
      'override_applied',
      'user-1',
    );

    assert.equal(vi.mocked(finalizeDecision).mock.calls.length, 1);
    assert.equal(vi.mocked(finalizeDecision).mock.calls[0]?.[0].decision.id, 'fema-decision');
    assert.equal(vi.mocked(finalizeDecision).mock.calls[0]?.[0].status, 'dismissed');
  });

  it('leaves non-matching contract decisions untouched', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    db.decisions.push(contractDecision({
      id: 'pricing-decision',
      status: 'open',
    }));

    await persistValidationRun(
      PROJECT_ID,
      validatorResult([], contractValidationSummary({
        suppressedIssues: [{
          issue_id: 'fema_gate_ambiguous',
          reason: 'Suppressed because FEMA context is not an operational gate.',
        }],
      })),
      'override_applied',
      'user-1',
    );

    assert.equal(vi.mocked(finalizeDecision).mock.calls.length, 0);
  });

  it('scopes suppressed decision closure to the current project and document', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    db.decisions.push(
      contractDecision({
        id: 'other-document-decision',
        document_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
      contractDecision({
        id: 'current-document-decision',
      }),
    );

    await persistValidationRun(
      PROJECT_ID,
      validatorResult([], contractValidationSummary({
        suppressedIssues: [{
          issue_id: 'pricing_applicability_requires_context',
          reason: 'Suppressed: operator-confirmed disposal fee treatment resolves pricing applicability ambiguity.',
        }],
      })),
      'override_applied',
      'user-1',
    );

    assert.equal(vi.mocked(finalizeDecision).mock.calls.length, 1);
    const closureInput = vi.mocked(finalizeDecision).mock.calls[0]?.[0];
    assert.equal(closureInput?.decision.id, 'current-document-decision');
    assert.equal(closureInput?.decision.project_id, PROJECT_ID);
    assert.equal(closureInput?.decision.document_id, DOCUMENT_ID);
  });

  it('delegates scoped linked-work cascade inputs to finalizeDecision', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    db.decisions.push(contractDecision({
      id: 'decision-with-linked-work',
      project_id: PROJECT_ID,
      document_id: DOCUMENT_ID,
      status: 'open',
      severity: 'critical',
    }));

    await persistValidationRun(
      PROJECT_ID,
      validatorResult([], contractValidationSummary({
        suppressedIssues: [{
          issue_id: 'pricing_applicability_requires_context',
          reason: 'Suppressed: operator-confirmed disposal fee treatment resolves pricing applicability ambiguity.',
        }],
      })),
      'override_applied',
      'user-1',
    );

    const closureInput = vi.mocked(finalizeDecision).mock.calls[0]?.[0];
    assert.equal(closureInput?.decision.id, 'decision-with-linked-work');
    assert.equal(closureInput?.decision.project_id, PROJECT_ID);
    assert.equal(closureInput?.decision.document_id, DOCUMENT_ID);
    assert.equal(closureInput?.organizationId, 'org-1');
    assert.equal(closureInput?.actorId, 'user-1');
    assert.equal(closureInput?.status, 'dismissed');
  });

  it('suppresses financial missing-rate findings when cross-document missing-rate exists for the same subject', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    const subjectId = 'typed:invoice-doc:invoice:line:1';

    await persistValidationRun(PROJECT_ID, validatorResult([
      validationFinding({
        id: 'financial-overlap',
        rule_id: 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
        check_key: `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT:${subjectId}`,
        subject_type: 'invoice_line',
        subject_id: subjectId,
        field: 'rate_code',
      }),
      validationFinding({
        id: 'cross-overlap',
        rule_id: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
        check_key: `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS:${subjectId}`,
        subject_type: 'invoice_line',
        subject_id: subjectId,
        field: 'contract_rate',
      }),
      validationFinding({
        id: 'unrelated',
        rule_id: 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE',
        check_key: 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE:2026002::1A',
        subject_type: 'invoice_rate_group',
        subject_id: '2026002::1A',
        field: 'extended_cost',
      }),
    ]), 'manual');

    const persisted = persistedOpenFindings(db);
    assert.deepEqual(
      persisted.map((finding) => finding.rule_id).sort(),
      [
        'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
        'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE',
      ],
    );
    assert.equal(db.runs[0].findings_count, 2);
  });

  it('preserves financial missing-rate findings when no cross-document missing-rate exists for the subject', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    const subjectId = 'typed:aa3b36ac-05cd-45f4-849b-e6e40f37be28:invoice:line:1';

    await persistValidationRun(PROJECT_ID, validatorResult([
      validationFinding({
        id: 'financial-only',
        rule_id: 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
        check_key: `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT:${subjectId}`,
        subject_type: 'invoice_line',
        subject_id: subjectId,
        field: 'rate_code',
      }),
    ]), 'manual');

    const persisted = persistedOpenFindings(db);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].rule_id, 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT');
    assert.equal(persisted[0].subject_id, subjectId);
    assert.equal(db.runs[0].findings_count, 1);
  });

  it('does not suppress financial missing-rate findings for a different subject', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(PROJECT_ID, validatorResult([
      validationFinding({
        id: 'financial-different-subject',
        rule_id: 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
        check_key: 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT:line-financial',
        subject_type: 'invoice_line',
        subject_id: 'line-financial',
        field: 'rate_code',
      }),
      validationFinding({
        id: 'cross-other-subject',
        rule_id: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
        check_key: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS:line-cross',
        subject_type: 'invoice_line',
        subject_id: 'line-cross',
        field: 'contract_rate',
      }),
    ]), 'manual');

    const persisted = persistedOpenFindings(db);
    assert.deepEqual(
      persisted.map((finding) => finding.rule_id).sort(),
      [
        'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
        'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
      ],
    );
    assert.equal(db.runs[0].findings_count, 2);
  });

  it('does not reopen an operator-cleared finding when check key and evidence are unchanged', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    // The operator closed the linked decision through the decision status route.
    db.decisions.push({ id: 'decision-resolved', status: 'resolved' });
    db.decisionFeedback.push({ id: 'feedback-1', decision_id: 'decision-resolved', created_by: 'operator-1',
      decision_status_at_feedback: 'resolved', disposition: 'resolved', is_correct: null, feedback_type: 'resolution' });
    const checkKey = 'FINANCIAL_RATE_CODE_MISSING:fact:53d74340-0000-4000-8000-000000000000:line:1';
    db.findings.push({
      id: 'resolved-rate-code',
      run_id: 'old-run',
      project_id: PROJECT_ID,
      rule_id: 'FINANCIAL_RATE_CODE_MISSING',
      check_key: checkKey,
      category: 'financial',
      severity: 'critical',
      status: 'resolved',
      subject_type: 'invoice_line',
      subject_id: 'fact:53d74340-0000-4000-8000-000000000000:line:1',
      field: 'rate_code',
      expected: 'rate code present',
      actual: null,
      variance: null,
      variance_unit: null,
      linked_decision_id: 'decision-resolved',
      resolved_at: '2026-06-12T16:03:51.000Z',
      updated_at: '2026-06-12T16:03:51.000Z',
    });
    db.evidenceRows.push({
      finding_id: 'resolved-rate-code',
      evidence_type: 'fact',
      source_document_id: DOCUMENT_ID,
      source_page: 1,
      fact_id: DOCUMENT_ID,
      record_id: 'invoice-line:1',
      field_name: 'rate_code',
      field_value: null,
      note: 'Missing rate code on invoice line 1.',
    });

    await persistValidationRun(PROJECT_ID, validatorResult([
      validationFinding({
        rule_id: 'FINANCIAL_RATE_CODE_MISSING',
        check_key: checkKey,
        subject_type: 'invoice_line',
        subject_id: 'fact:53d74340-0000-4000-8000-000000000000:line:1',
        field: 'rate_code',
        expected: 'rate code present',
        actual: null,
        variance: null,
        variance_unit: null,
        evidence: [evidence({
          source_document_id: DOCUMENT_ID,
          source_page: 1,
          fact_id: `${DOCUMENT_ID}:invoice:line:1`,
          record_id: 'invoice-line:1',
          field_name: 'rate_code',
          field_value: null,
          note: 'Missing rate code on invoice line 1.',
        })],
      }),
    ]), 'manual');

    const reopened = db.findings.filter((finding) => finding.check_key === checkKey && finding.status === 'open');
    assert.equal(reopened.length, 0);
    assert.equal(db.runs[0].findings_count, 0);
    assert.equal(db.projects[0].validation_status, 'VALIDATED');
    assert.ok(db.projects[0].validation_summary_json);
  });

  it('opens a new finding when a resolved check key has materially changed evidence', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    const checkKey = 'FINANCIAL_RATE_CODE_MISSING:fact:53d74340-0000-4000-8000-000000000000:line:1';
    db.findings.push({
      id: 'resolved-rate-code',
      run_id: 'old-run',
      project_id: PROJECT_ID,
      rule_id: 'FINANCIAL_RATE_CODE_MISSING',
      check_key: checkKey,
      category: 'financial',
      severity: 'critical',
      status: 'resolved',
      subject_type: 'invoice_line',
      subject_id: 'fact:53d74340-0000-4000-8000-000000000000:line:1',
      field: 'rate_code',
      expected: 'rate code present',
      actual: null,
      variance: null,
      variance_unit: null,
      resolved_at: '2026-06-12T16:03:51.000Z',
      updated_at: '2026-06-12T16:03:51.000Z',
    });
    db.evidenceRows.push({
      finding_id: 'resolved-rate-code',
      evidence_type: 'fact',
      source_document_id: DOCUMENT_ID,
      source_page: 1,
      fact_id: DOCUMENT_ID,
      record_id: 'invoice-line:1',
      field_name: 'rate_code',
      field_value: null,
      note: 'Missing rate code on invoice line 1.',
    });

    await persistValidationRun(PROJECT_ID, validatorResult([
      validationFinding({
        rule_id: 'FINANCIAL_RATE_CODE_MISSING',
        check_key: checkKey,
        subject_type: 'invoice_line',
        subject_id: 'fact:53d74340-0000-4000-8000-000000000000:line:1',
        field: 'rate_code',
        expected: 'rate code present',
        actual: null,
        variance: null,
        variance_unit: null,
        evidence: [evidence({
          source_document_id: DOCUMENT_ID,
          source_page: 2,
          fact_id: `${DOCUMENT_ID}:invoice:line:1`,
          record_id: 'invoice-line:1',
          field_name: 'rate_code',
          field_value: null,
          note: 'Missing rate code on invoice line 1.',
        })],
      }),
    ]), 'manual');

    const reopened = db.findings.filter((finding) => finding.check_key === checkKey && finding.status === 'open');
    assert.equal(reopened.length, 1);
    assert.equal(db.runs[0].findings_count, 1);
  });

  it('loads existing open and resolved findings in check-key batches', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    const manyFindings = Array.from({ length: 205 }, (_, index) => validationFinding({
      id: `finding-${index}`,
      rule_id: 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO',
      check_key: `INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO:invoice-${index}`,
      subject_type: 'invoice',
      subject_id: `invoice-${index}`,
      field: 'at_risk_amount',
    }));

    await persistValidationRun(PROJECT_ID, validatorResult(manyFindings), 'manual');

    assert.deepEqual(
      db.existingFindingCheckKeyBatchSizes,
      [25, 25, 25, 25, 25, 25, 25, 25, 5, 25, 25, 25, 25, 25, 25, 25, 25, 5],
    );
    assert.equal(db.runs[0].status, 'complete');
    assert.equal(db.runs[0].findings_count, 205);
  });

  it('does not let validator decision sync failures fail a completed run', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    vi.mocked(syncValidatorDecisions).mockRejectedValueOnce(new Error('decisions_source_check violation'));

    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');

    assert.equal(db.runs[0].status, 'complete');
    assert.equal(db.runs[0].findings_count, 1);
    assert.ok(db.runs[0].completed_at);
  });

  it('does not let approval snapshot failures fail a completed run', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    vi.mocked(persistApprovalSnapshot).mockRejectedValueOnce(new Error('project_approval_snapshots not in schema cache'));

    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');

    assert.equal(db.runs[0].status, 'complete');
    assert.equal(db.runs[0].findings_count, 1);
    assert.ok(db.runs[0].completed_at);
  });

  it('continues closing remaining decisions when one closure throws a constraint error', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    db.decisions.push(
      contractDecision({ id: 'decision-pricing', status: 'in_review' }),
      contractDecision({
        id: 'decision-fema',
        issue_id: 'fema_gate_ambiguous',
        issue_type: 'fema_gate_ambiguous',
        decision_type: 'contract_intelligence:fema_gate_ambiguous',
        details: {
          rule_id: 'contract_intelligence:fema_gate_ambiguous',
          normalized_decision: { id: 'contract:intelligence:fema_gate_ambiguous' },
        },
      }),
    );

    vi.mocked(finalizeDecision)
      .mockRejectedValueOnce(new Error('new row for relation decisions violates check constraint decisions_status_check'))
      .mockResolvedValueOnce({
        decision: { id: 'decision-fema', status: 'dismissed' },
        linkedFindingIds: [],
        linkedClosure: { closedFindingIds: [], closedWorkflowTaskIds: [], closedExecutionItemIds: [], recomputedDocumentStatus: false, errors: [] },
      });

    await persistValidationRun(
      PROJECT_ID,
      validatorResult([], contractValidationSummary({
        suppressedIssues: [
          { issue_id: 'pricing_applicability_requires_context', reason: 'pricing suppressed' },
          { issue_id: 'fema_gate_ambiguous', reason: 'fema suppressed' },
        ],
      })),
      'override_applied',
      'user-1',
    );

    assert.equal(db.runs[0].status, 'complete');
    assert.equal(vi.mocked(finalizeDecision).mock.calls.length, 2);
    assert.equal(vi.mocked(finalizeDecision).mock.calls[1]?.[0].decision.id, 'decision-fema');
    assert.equal(vi.mocked(finalizeDecision).mock.calls[1]?.[0].status, 'dismissed');
  });

  it('writes status dismissed (not suppressed) for suppressed contract decisions', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    db.decisions.push(contractDecision({ id: 'pricing-decision', status: 'open' }));

    await persistValidationRun(
      PROJECT_ID,
      validatorResult([], contractValidationSummary({
        suppressedIssues: [{ issue_id: 'pricing_applicability_requires_context', reason: 'operator confirmed' }],
      })),
      'override_applied',
      'user-1',
    );

    const call = vi.mocked(finalizeDecision).mock.calls[0]?.[0];
    assert.equal(call?.status, 'dismissed');
    assert.notEqual(call?.status, 'suppressed');
  });

  it('does not affect resolved-status closure path when no suppressed issues are present', async () => {
    const db = new MockDatabase();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);

    await persistValidationRun(PROJECT_ID, validatorResult(), 'manual');

    assert.equal(db.runs[0].status, 'complete');
    assert.equal(vi.mocked(finalizeDecision).mock.calls.length, 0);
  });
});

describe('finding recurrence integrity', () => {
  const CHECK_KEY = 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE:line-1';
  const recurring = (overrides: Partial<TestFinding> = {}) => validationFinding({
    id: 'candidate-unit-price',
    rule_id: 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE',
    check_key: CHECK_KEY,
    subject_type: 'invoice_line',
    subject_id: 'line-1',
    field: 'unit_price',
    expected: '12.80',
    actual: '13',
    severity: 'critical',
    ...overrides,
  });
  const openRows = (db: MockDatabase) => db.findings.filter((row) => row.check_key === CHECK_KEY && row.status === 'open');
  const freshDb = () => {
    const db = new MockDatabase();
    db.findings = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue(db as unknown as AdminClient);
    return db;
  };

  it('open -> not observed -> identical recurrence: the recurrence is open again', async () => {
    const db = freshDb();
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual', 'user-1');
    await persistValidationRun(PROJECT_ID, validatorResult([]), 'manual', 'user-1');
    assert.equal(openRows(db).length, 0);
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual', 'user-1');
    assert.equal(openRows(db).length, 1);
    // Blocking state is computed from the corrected open state.
    assert.equal(db.projects[0].validation_status, 'BLOCKED');
    assert.equal(db.runs.at(-1)?.findings_count, 1);
  });

  it('open -> not observed for many runs -> recurrence: open again', async () => {
    const db = freshDb();
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual');
    for (let run = 0; run < 5; run += 1) await persistValidationRun(PROJECT_ID, validatorResult([]), 'document_processed');
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'document_processed');
    assert.equal(openRows(db).length, 1);
    assert.equal(db.projects[0].validation_status, 'BLOCKED');
  });

  it('records an automatic closure as not observed, never as a person', async () => {
    const db = freshDb();
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual', 'user-1');
    vi.mocked(logActivityEvent).mockClear();
    await persistValidationRun(PROJECT_ID, validatorResult([]), 'manual', 'user-1');
    const closed = db.findings.find((row) => row.check_key === CHECK_KEY);
    assert.equal(closed?.status, 'resolved');
    assert.equal(closed?.resolved_by_user_id, null);
    const event = vi.mocked(logActivityEvent).mock.calls.map(([entry]) => entry)
      .find((entry) => entry.event_type === 'validation_finding_resolved');
    assert.equal(event?.changed_by, null);
    assert.equal(event?.new_value?.closure_kind, 'not_observed');
    assert.equal(event?.new_value?.run_id, RUN_ID);
  });

  const clearedThrough = {
    'a decision closed with operator feedback': (db: MockDatabase, row: Row) => {
      row.linked_decision_id = 'decision-1';
      db.decisions.push({ id: 'decision-1', status: 'dismissed' });
      db.decisionFeedback.push({ id: 'feedback-1', decision_id: 'decision-1', created_by: 'operator-1',
        decision_status_at_feedback: null, disposition: 'suppress', is_correct: false, feedback_type: 'override' });
    },
    'an execution outcome': (db: MockDatabase, row: Row) => {
      row.linked_action_id = 'item-1';
      db.executionItems.push({ id: 'item-1', project_id: PROJECT_ID, outcome: 'overridden', status: 'resolved' });
    },
  } as const;

  for (const [path, clear] of Object.entries(clearedThrough)) {
    it(`open -> operator clearance (${path}) -> identical recurrence: stays cleared, history intact`, async () => {
      const db = freshDb();
      await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual');
      const row = openRows(db)[0]!;
      // The operator path closes the finding and leaves its own record.
      Object.assign(row, { status: path.startsWith('a decision') ? 'dismissed' : 'resolved', resolved_by_user_id: 'operator-1',
        resolved_at: '2026-10-04T00:00:00.000Z' });
      clear(db, row);
      const before = JSON.stringify({ decisions: db.decisions, feedback: db.decisionFeedback, items: db.executionItems, row });
      await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual');
      assert.equal(openRows(db).length, 0);
      assert.equal(db.projects[0].validation_status, 'VALIDATED');
      // Operator decision and audit history untouched.
      assert.equal(JSON.stringify({ decisions: db.decisions, feedback: db.decisionFeedback, items: db.executionItems,
        row: db.findings.find((entry) => entry.id === row.id) }), before);
    });
  }

  it('open -> manual rate link by an operator -> identical recurrence: stays cleared', async () => {
    const db = freshDb();
    const rateCode = (overrides: Partial<TestFinding> = {}) => recurring({ rule_id: 'FINANCIAL_RATE_CODE_MISSING',
      check_key: 'FINANCIAL_RATE_CODE_MISSING:line-1', ...overrides });
    await persistValidationRun(PROJECT_ID, validatorResult([rateCode()]), 'manual');
    const row = db.findings.find((entry) => entry.check_key === 'FINANCIAL_RATE_CODE_MISSING:line-1' && entry.status === 'open')!;
    db.rateLinks.push({ id: 'link-1', project_id: PROJECT_ID, invoice_line_subject_id: 'line-1', actor_id: 'operator-1',
      created_at: '2026-10-03T23:59:00.000Z', is_active: true });
    Object.assign(row, { status: 'resolved', resolved_by_user_id: 'operator-1', resolved_at: '2026-10-04T00:00:00.000Z' });
    await persistValidationRun(PROJECT_ID, validatorResult([rateCode()]), 'manual');
    assert.equal(db.findings.filter((entry) => entry.check_key === 'FINANCIAL_RATE_CODE_MISSING:line-1' && entry.status === 'open').length, 0);
  });

  it('a decision an operator later reopened clears nothing', async () => {
    const db = freshDb();
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual');
    const row = openRows(db)[0]!;
    Object.assign(row, { status: 'resolved', linked_decision_id: 'decision-1', resolved_at: '2026-10-04T00:00:00.000Z' });
    db.decisions.push({ id: 'decision-1', status: 'open' });
    db.decisionFeedback.push({ id: 'feedback-1', decision_id: 'decision-1', created_by: 'operator-1',
      decision_status_at_feedback: 'resolved', disposition: 'resolved', is_correct: null, feedback_type: 'resolution' });
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual');
    assert.equal(openRows(db).length, 1);
  });

  it('an automatically dismissed decision with no operator record clears nothing', async () => {
    const db = freshDb();
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual');
    const row = openRows(db)[0]!;
    // Validator decision sync dismisses stale decisions on its own; that is not an operator decision.
    Object.assign(row, { status: 'resolved', linked_decision_id: 'decision-1', resolved_by_user_id: 'user-1' });
    db.decisions.push({ id: 'decision-1', status: 'dismissed', details: { active: false } });
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual');
    assert.equal(openRows(db).length, 1);
  });

  it('a modified recurrence after operator clearance opens', async () => {
    const db = freshDb();
    await persistValidationRun(PROJECT_ID, validatorResult([recurring()]), 'manual');
    const row = openRows(db)[0]!;
    Object.assign(row, { status: 'resolved', linked_action_id: 'item-1' });
    db.executionItems.push({ id: 'item-1', project_id: PROJECT_ID, outcome: 'overridden' });
    await persistValidationRun(PROJECT_ID, validatorResult([recurring({ actual: '14' })]), 'manual');
    assert.equal(openRows(db).length, 1);
  });

  it('the shared projection the impact preview uses predicts exactly what persistence keeps open', async () => {
    const { loadHistoricalResolvedFindings, persistedOpenFindingsForResult } = await import('@/lib/validator/persistedFindingProjection');
    const db = freshDb();
    const other = validationFinding({ check_key: 'OTHER:line-2', rule_id: 'OTHER', subject_id: 'line-2' });
    const cleared = validationFinding({ check_key: 'CLEARED:line-3', rule_id: 'CLEARED', subject_id: 'line-3' });
    await persistValidationRun(PROJECT_ID, validatorResult([recurring(), other, cleared]), 'manual');
    const clearedRow = db.findings.find((entry) => entry.check_key === 'CLEARED:line-3')!;
    Object.assign(clearedRow, { status: 'resolved', linked_action_id: 'item-9' });
    db.executionItems.push({ id: 'item-9', project_id: PROJECT_ID, outcome: 'resolved' });
    await persistValidationRun(PROJECT_ID, validatorResult([other]), 'manual');

    const next = validatorResult([recurring(), other, cleared]);
    const history = await loadHistoricalResolvedFindings(PROJECT_ID, next.findings.map((finding) => finding.check_key));
    const predicted = persistedOpenFindingsForResult({ projectId: PROJECT_ID, result: next, clearedHistoryByCheckKey: history })
      .map((finding) => finding.check_key).sort();
    await persistValidationRun(PROJECT_ID, next, 'manual');
    const actual = db.findings.filter((entry) => entry.status === 'open').map((entry) => String(entry.check_key)).sort();
    assert.deepEqual(predicted, [CHECK_KEY, 'OTHER:line-2']);
    assert.deepEqual(actual, predicted);
  });
});
