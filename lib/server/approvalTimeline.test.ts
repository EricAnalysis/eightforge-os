import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';

import { buildApprovalTimeline } from '@/lib/server/approvalTimeline';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(),
}));

type Row = Record<string, any>;

function snapshot(overrides: Row): Row {
  return {
    id: 'snapshot-1',
    project_id: 'project-1',
    approval_status: 'blocked',
    total_billed: 1000,
    total_supported: 900,
    at_risk_amount: 100,
    blocked_amount: 100,
    invoice_count: 1,
    blocked_invoice_count: 1,
    needs_review_invoice_count: 0,
    approved_invoice_count: 0,
    finding_ids: [],
    billing_group_ids: null,
    validation_trigger_source: 'manual',
    run_id: 'run-1',
    triggering_decision_id: null,
    created_by: null,
    created_at: '2026-07-22T10:00:00.000Z',
    ...overrides,
  };
}

function createAdminMock(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const inFilters: Array<[string, unknown[]]> = [];
      let descending = false;
      let rowLimit: number | null = null;
      const query = {
        select() { return query; },
        eq(field: string, value: unknown) { filters.push([field, value]); return query; },
        in(field: string, values: unknown[]) { inFilters.push([field, values]); return query; },
        order(_field: string, options?: { ascending?: boolean }) {
          descending = options?.ascending === false;
          return query;
        },
        limit(value: number) { rowLimit = value; return query; },
        then(resolve: (value: { data: Row[]; error: null }) => unknown) {
          let rows = [...(tables[table] ?? [])]
            .filter((row) => filters.every(([field, value]) => row[field] === value))
            .filter((row) => inFilters.every(([field, values]) => values.includes(row[field])));
          rows.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
          if (descending) rows.reverse();
          if (rowLimit != null) rows = rows.slice(0, rowLimit);
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildApprovalTimeline finding deltas', () => {
  it('surfaces real finding UUID additions/resolutions while preserving amount deltas', async () => {
    const previous = snapshot({ finding_ids: ['finding-a'], run_id: 'run-1' });
    const current = snapshot({
      id: 'snapshot-2',
      finding_ids: ['finding-b'],
      run_id: 'run-2',
      blocked_amount: 40,
      at_risk_amount: 40,
      created_at: '2026-07-22T11:00:00.000Z',
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(createAdminMock({
      project_approval_snapshots: [previous, current],
      activity_events: [
        { entity_id: 'finding-b', event_type: 'validation_finding_generated', new_value: { run_id: 'run-2' } },
        { entity_id: 'finding-a', event_type: 'validation_finding_resolved', new_value: { run_id: 'run-2' } },
      ],
      invoice_approval_snapshots: [],
    }) as never);

    const timeline = await buildApprovalTimeline('project-1');

    assert.deepEqual(
      timeline?.events.filter((event) => event.type === 'blocking_reason_added')
        .flatMap((event) => event.newBlockingReasons ?? []),
      ['finding-b'],
    );
    assert.deepEqual(
      timeline?.events.filter((event) => event.type === 'blocking_reason_resolved')
        .flatMap((event) => event.resolvedBlockingReasons ?? []),
      ['finding-a'],
    );
    assert.equal(
      timeline?.events.find((event) => event.type === 'blocked_amount_changed')?.blockedAmountDelta,
      -60,
    );
  });

  it('suppresses false finding churn across the no-backfill legacy boundary', async () => {
    const previous = snapshot({ finding_ids: ['finding-OLD_RULE:key'], run_id: null });
    const current = snapshot({
      id: 'snapshot-2',
      finding_ids: ['real-finding-uuid'],
      run_id: 'run-2',
      created_at: '2026-07-22T11:00:00.000Z',
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(createAdminMock({
      project_approval_snapshots: [previous, current],
      activity_events: [],
      invoice_approval_snapshots: [],
    }) as never);

    const timeline = await buildApprovalTimeline('project-1');

    assert.equal(timeline?.events.some((event) => event.type === 'blocking_reason_added'), false);
    assert.equal(timeline?.events.some((event) => event.type === 'blocking_reason_resolved'), false);
  });
});
