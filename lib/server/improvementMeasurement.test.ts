import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  measureImprovement,
  RECORD_MEASUREMENT_DECISION_FUNCTION,
  RECORD_MEASUREMENT_SNAPSHOT_FUNCTION,
  recordMeasurementDecision,
  type MeasurementAdmin,
} from '@/lib/server/improvementMeasurement';

const ORG = 'b84c0000-0000-4000-8000-000000000001';
const EVENT = 'b84c0000-0000-4000-8000-000000000101';
const SUBMISSION = 'b84c0000-0000-4000-8000-000000000201';
const SNAPSHOT = 'b84c0000-0000-4000-8000-000000000301';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const REVIEWER = { actorId: 'b84c0000-0000-4000-8000-0000000000a1', email: 'reviewer@example.invalid', role: null };
const DEPLOYED = '2026-10-01T00:00:00.000Z';
const NOW = () => new Date('2026-10-20T00:00:00.000Z');

type Row = Record<string, unknown>;

/** An in-memory PostgREST double: filters by eq / in / is / gte / lt, orders and limits. */
function fakeAdmin(tables: Record<string, Row[]>, rpcResult: (name: string, args: Row) => { data: unknown; error: unknown }) {
  const rpc = vi.fn(async (name: string, args: Row) => rpcResult(name, args));
  const from = (table: string) => ({
    select: () => {
      const filters: ((row: Row) => boolean)[] = [];
      let limit = Infinity;
      let order: string | null = null;
      const run = () => {
        let result = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
        if (order) result = [...result].sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
        return { data: result.slice(0, limit), error: null };
      };
      const query = {
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
        in: (column: string, values: readonly unknown[]) => { filters.push((row) => values.includes(row[column])); return query; },
        is: (column: string, value: null) => { filters.push((row) => (row[column] ?? null) === value); return query; },
        gte: (column: string, value: string) => { filters.push((row) => String(row[column]) >= value); return query; },
        lt: (column: string, value: string) => { filters.push((row) => String(row[column]) < value); return query; },
        order: (column: string) => { order = column; return query; },
        limit: (count: number) => { limit = count; return query; },
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(run())),
      };
      return query;
    },
  });
  return { admin: { from, rpc } as unknown as MeasurementAdmin, rpc };
}

function lifecycleTables(signalKind: string, signalCode: string): Record<string, Row[]> {
  return {
    improvement_lifecycle_events: [{ id: EVENT, event_kind: 'deployed', organization_id: ORG, submission_id: SUBMISSION,
      deployment_observed_at: DEPLOYED }],
    improvement_signal_submissions: [{ id: SUBMISSION, organization_id: ORG, signal_kind: signalKind, signal_code: signalCode }],
    improvement_producer_classifications: [
      { deployed_event_id: EVENT, producer_revision: OLD, contains_fix: false },
      { deployed_event_id: EVENT, producer_revision: NEW, contains_fix: true },
    ],
    projects: [{ id: 'project-1', organization_id: ORG }],
    documents: [],
  };
}

function findings(count: number, overridden: number, run: string, day: string, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, run_id: run, rule_id: 'rule_x',
    project_id: 'project-1', created_at: `${day}T00:00:${String(index).padStart(2, '0')}+00:00`,
    overridden: index < overridden }));
}

afterEach(() => vi.unstubAllEnvs());

describe('measure a deployed fix (B8.4c)', () => {
  it('measures a rule semantics fix from its findings and overrides, and records a policy-coherent snapshot', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    const all = [...findings(20, 4, 'run-old', '2026-09-15', 'base'), ...findings(40, 1, 'run-new', '2026-10-10', 'post')];
    const tables = { ...lifecycleTables('rule_semantics_review', 'rule_x'),
      project_validation_findings: all.map((row) => ({ id: row.id, run_id: row.run_id, rule_id: row.rule_id,
        project_id: row.project_id, created_at: row.created_at })),
      project_validation_runs: [
        { id: 'run-old', deployment_revision: OLD, deployment_environment: 'production', rule_catalogue_fingerprint: `rule-catalogue-v1:sha256:${'1'.repeat(64)}` },
        { id: 'run-new', deployment_revision: NEW, deployment_environment: 'production', rule_catalogue_fingerprint: `rule-catalogue-v1:sha256:${'2'.repeat(64)}` },
      ],
      execution_items: all.filter((row) => row.overridden).map((row) => ({ source_id: row.id, organization_id: ORG,
        source_type: 'validator_finding', outcome: 'overridden' })),
    };
    const { admin, rpc } = fakeAdmin(tables, () => ({ data: [{ snapshot_id: SNAPSHOT, lifecycle_event_kind: 'measurement_completed' }], error: null }));
    const result = await measureImprovement({ deployedEventId: EVENT }, REVIEWER, { admin, now: NOW });
    expect(result).toEqual({ status: 'recorded', snapshotId: SNAPSHOT, outcome: 'resolution_candidate',
      reasons: ['post_rate_within_reduction_threshold'], lifecycleEventKind: 'measurement_completed' });
    const args = rpc.mock.calls[0]![1] as Row;
    expect(rpc.mock.calls[0]![0]).toBe(RECORD_MEASUREMENT_SNAPSHOT_FUNCTION);
    expect(args).toMatchObject({ p_deployed_event_id: EVENT, p_signal_kind: 'rule_semantics_review', p_signal_code: 'rule_x',
      p_policy_version: 'friction_measurement_v1', p_window_policy_version: 'friction_measurement_windows_v1',
      p_baseline_exposure: 20, p_baseline_occurrences: 4, p_post_exposure: 40, p_post_occurrences: 1,
      p_baseline_to: DEPLOYED, p_post_from: DEPLOYED, p_post_to: NOW().toISOString(), p_measured_by: REVIEWER.actorId });
    // The catalogue change is the fix itself, not a confounder.
    expect((args.p_measurement as { reasons: string[] }).reasons).not.toContain('configuration_changed:rule_catalogue');
  });

  it('records an undefined exposure as unmeasurable instead of claiming no friction', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    const { admin, rpc } = fakeAdmin(lifecycleTables('recurring_deterministic_failure', 'validator_rule:rule_x'),
      () => ({ data: [{ snapshot_id: SNAPSHOT, lifecycle_event_kind: 'measuring' }], error: null }));
    const result = await measureImprovement({ deployedEventId: EVENT }, REVIEWER, { admin, now: NOW });
    expect(result).toMatchObject({ status: 'recorded', outcome: 'unmeasurable', reasons: ['exposure_not_defined'],
      lifecycleEventKind: 'measuring' });
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_baseline_exposure: 0, p_post_exposure: 0 });
  });

  it('refuses non-reviewers, unknown deployments, unopened windows and completed measurements', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'someone-else@example.invalid');
    const tables = lifecycleTables('rule_semantics_review', 'rule_x');
    const { admin, rpc } = fakeAdmin(tables, () => ({ data: null, error: { code: 'B8405' } }));
    expect(await measureImprovement({ deployedEventId: EVENT }, REVIEWER, { admin, now: NOW }))
      .toEqual({ status: 'reviewer_not_eligible' });
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    expect(await measureImprovement({ deployedEventId: SNAPSHOT }, REVIEWER, { admin, now: NOW }))
      .toEqual({ status: 'deployment_not_found' });
    expect(await measureImprovement({ deployedEventId: EVENT }, REVIEWER, { admin, now: () => new Date(DEPLOYED) }))
      .toEqual({ status: 'window_not_open' });
    expect(await measureImprovement({ deployedEventId: EVENT }, REVIEWER, { admin, now: NOW }))
      .toEqual({ status: 'already_completed' });
    expect(await measureImprovement({ deployedEventId: EVENT, organizationId: ORG }, REVIEWER, { admin, now: NOW }))
      .toEqual({ status: 'invalid_input' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('a person decides (B8.4c)', () => {
  it('records the decision with the session reviewer and maps database refusals', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    const input = { snapshotId: SNAPSHOT, expectedDecisionVersion: 0, decision: 'resolved', rationale: 'Verified on production' };
    const ok = fakeAdmin({}, () => ({ data: [{ decision_id: EVENT, decision_version: 1 }], error: null }));
    expect(await recordMeasurementDecision(input, REVIEWER, { admin: ok.admin }))
      .toEqual({ status: 'decided', decisionId: EVENT, decisionVersion: 1 });
    expect(ok.rpc).toHaveBeenCalledWith(RECORD_MEASUREMENT_DECISION_FUNCTION, { p_snapshot_id: SNAPSHOT,
      p_expected_decision_version: 0, p_decision: 'resolved', p_rationale: 'Verified on production',
      p_reviewer_actor_id: REVIEWER.actorId });
    for (const [code, status] of [['B8408', 'decision_not_allowed'], ['B8407', 'not_completed_measurement'],
      ['40001', 'version_conflict'], ['P0002', 'snapshot_not_found']] as const) {
      expect(await recordMeasurementDecision(input, REVIEWER,
        { admin: fakeAdmin({}, () => ({ data: null, error: { code } })).admin })).toEqual({ status });
    }
    expect(await recordMeasurementDecision({ ...input, decision: 'closed' }, REVIEWER, { admin: ok.admin }))
      .toEqual({ status: 'invalid_input' });
  });
});
