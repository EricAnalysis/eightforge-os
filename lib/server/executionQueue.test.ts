import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

const { getSupabaseAdminMock } = vi.hoisted(() => ({
  getSupabaseAdminMock: vi.fn(),
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

import { getCurrentActionableItems } from './executionQueue';

type QueryResult = { data: unknown[]; error: null };
type ExecutionRowOverrides = Partial<{
  id: string;
  organization_id: string;
  project_id: string;
  source_type: string;
  source_id: string;
  source_key: string;
  severity: string;
  title: string;
  problem: string;
  expected_value: string;
  actual_value: string;
  impact: string;
  required_action: string;
  status: string;
  outcome: string | null;
  queue_state: string | null;
  evidence_refs: unknown[];
  fact_refs: unknown[];
  validator_rule_key: string;
  created_at: string;
  updated_at: string;
  projects: { id: string; name: string };
}>;

function query(result: QueryResult) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    throwOnError: vi.fn(),
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.neq.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.throwOnError.mockResolvedValue(result);
  return builder;
}

function executionRow(overrides: ExecutionRowOverrides = {}) {
  return {
    id: 'execution-1',
    organization_id: 'org-1',
    project_id: 'project-1',
    source_type: 'validator_finding',
    source_id: 'finding-1',
    source_key: 'RATE_MISMATCH',
    severity: 'high',
    title: 'Review rate mismatch',
    problem: 'Rate mismatch',
    expected_value: '100',
    actual_value: '125',
    impact: 'Approval is blocked.',
    required_action: 'Review the rate.',
    status: 'open',
    outcome: null,
    queue_state: 'needs_review',
    evidence_refs: [],
    fact_refs: [],
    validator_rule_key: 'RATE_RULE',
    created_at: '2026-06-24T12:00:00.000Z',
    updated_at: '2026-06-24T12:00:00.000Z',
    projects: { id: 'project-1', name: 'Golden Project' },
    ...overrides,
  };
}

function setupAdmin(params: {
  row: ReturnType<typeof executionRow>;
  insert?: ReturnType<typeof vi.fn>;
}) {
  const executionQuery = query({
    data: [params.row],
    error: null,
  });
  const findingQuery = query({
    data: [{
      id: 'finding-1',
      linked_decision_id: null,
      linked_action_id: 'execution-1',
      status: 'open',
      lifecycle_state: 'blocked',
    }],
    error: null,
  });
  const evidenceQuery = query({ data: [], error: null });
  const insert = params.insert ?? vi.fn().mockResolvedValue({ error: null });
  const mismatchQuery = { insert };
  const from = vi.fn((table: string) => {
    if (table === 'execution_items') return executionQuery;
    if (table === 'project_validation_findings') return findingQuery;
    if (table === 'project_validation_evidence') return evidenceQuery;
    if (table === 'state_projection_shadow_mismatches') return mismatchQuery;
    throw new Error(`Unexpected table ${table}`);
  });
  getSupabaseAdminMock.mockReturnValue({ from });
  return { executionQuery, findingQuery, evidenceQuery, insert, from };
}

async function flushShadowSink(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('execution queue persisted-state shadowing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getSupabaseAdminMock.mockReset();
    delete process.env.NEXT_PUBLIC_EIGHTFORGE_STATE_SHADOW_LOGGING;
  });

  it('logs and persists queue-state drift while returning the unchanged legacy derivation', async () => {
    const { executionQuery, insert } = setupAdmin({
      row: executionRow(),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const items = await getCurrentActionableItems('org-1', {
      include_legacy_decisions: false,
    });
    await flushShadowSink();

    assert.equal(items.length, 1);
    assert.equal(items[0]?.queue_state, 'blocked');
    assert.equal(warn.mock.calls.length, 1);
    assert.deepEqual(warn.mock.calls[0]?.[1], {
      record_type: 'execution_item',
      record_id: 'execution-1',
      project_id: 'project-1',
      legacy_value: 'blocked',
      persisted_value: 'needs_review',
      surface: 'executionQueue.mapExecutionItem',
      timestamp: warn.mock.calls[0]?.[1].timestamp,
    });
    assert.match(
      String(executionQuery.select.mock.calls[0]?.[0]),
      /status, outcome, queue_state/,
    );
    assert.deepEqual(insert.mock.calls[0]?.[0], {
      record_type: 'execution_item',
      record_id: 'execution-1',
      project_id: 'project-1',
      organization_id: 'org-1',
      legacy_value: 'blocked',
      persisted_value: 'needs_review',
      surface: 'executionQueue.mapExecutionItem',
    });
  });

  it('stays silent and does not insert when the persisted state matches', async () => {
    const { insert } = setupAdmin({
      row: executionRow({ queue_state: 'blocked' }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const items = await getCurrentActionableItems('org-1', {
      include_legacy_decisions: false,
    });
    await flushShadowSink();

    assert.equal(items.length, 1);
    assert.equal(items[0]?.queue_state, 'blocked');
    assert.equal(warn.mock.calls.length, 0);
    assert.equal(insert.mock.calls.length, 0);
  });

  it('swallows shadow insert failures without changing the returned legacy derivation', async () => {
    const insert = vi.fn().mockRejectedValue(new Error('insert failed'));
    setupAdmin({
      row: executionRow(),
      insert,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const items = await getCurrentActionableItems('org-1', {
      include_legacy_decisions: false,
    });
    await flushShadowSink();

    assert.equal(items.length, 1);
    assert.equal(items[0]?.queue_state, 'blocked');
    assert.equal(warn.mock.calls.length, 1);
    assert.equal(insert.mock.calls.length, 1);
    assert.equal(error.mock.calls[0]?.[0], '[state-projection-shadow-mismatch:persist-failed]');
  });

  it('honors disabled state shadow logging for warnings and inserts', async () => {
    process.env.NEXT_PUBLIC_EIGHTFORGE_STATE_SHADOW_LOGGING = '0';
    const { insert } = setupAdmin({
      row: executionRow(),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const items = await getCurrentActionableItems('org-1', {
      include_legacy_decisions: false,
    });
    await flushShadowSink();

    assert.equal(items.length, 1);
    assert.equal(items[0]?.queue_state, 'blocked');
    assert.equal(warn.mock.calls.length, 0);
    assert.equal(insert.mock.calls.length, 0);
  });
});
