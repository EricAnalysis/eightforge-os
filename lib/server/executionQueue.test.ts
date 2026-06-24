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

describe('execution queue persisted-state shadowing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getSupabaseAdminMock.mockReset();
  });

  it('logs queue-state drift while returning the unchanged legacy derivation', async () => {
    const executionQuery = query({
      data: [{
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
      }],
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
    getSupabaseAdminMock.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'execution_items') return executionQuery;
        if (table === 'project_validation_findings') return findingQuery;
        if (table === 'project_validation_evidence') return evidenceQuery;
        throw new Error(`Unexpected table ${table}`);
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const items = await getCurrentActionableItems('org-1', {
      include_legacy_decisions: false,
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.queue_state, 'blocked');
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
  });
});
