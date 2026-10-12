import { afterEach, describe, expect, it, vi } from 'vitest';

import type { readFrictionReport } from '@/lib/server/frictionReportRead';
import {
  RECORD_RECURRENCE_SUCCESSOR_FUNCTION,
  recordRecurrenceSuccessor,
  type RecurrenceAdmin,
} from '@/lib/server/improvementRecurrence';

const ORG = 'b84d0000-0000-4000-8000-000000000001';
const DECISION = 'b84d0000-0000-4000-8000-000000000101';
const DEPLOYED = 'b84d0000-0000-4000-8000-000000000201';
const ORIGIN = 'b84d0000-0000-4000-8000-000000000301';
const SUCCESSOR = 'b84d0000-0000-4000-8000-000000000401';
const REVIEWER = { actorId: 'b84d0000-0000-4000-8000-0000000000a1', email: 'reviewer@example.invalid', role: null };

const payload = (occurrences: number) => ({ schemaVersion: 'friction_signal_v1', signalKind: 'recurring_deterministic_failure',
  code: 'unrecognized_reason', catalogueFingerprint: null, counts: { occurrences, documents: 2, projects: 1 },
  recordRefs: [], rootCauseCategory: 'extraction_issue', defectClass: null });

function admin(tables: Record<string, Record<string, unknown>[]>, rpcResult: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => rpcResult);
  const from = (table: string) => ({ select: () => {
    const filters: [string, unknown][] = [];
    const query = {
      eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
      limit: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ error: null,
        data: (tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value)) })),
    };
    return query;
  } });
  return { admin: { from, rpc } as unknown as RecurrenceAdmin, rpc };
}

const tables = (decision = 'recurred_confirmed') => ({
  improvement_measurement_decisions: [{ id: DECISION, deployed_event_id: DEPLOYED, decision }],
  improvement_lifecycle_events: [{ id: DEPLOYED, event_kind: 'deployed', submission_id: ORIGIN }],
  improvement_signal_submissions: [{ id: ORIGIN, organization_id: ORG, signal_kind: 'recurring_deterministic_failure',
    signal_code: 'unrecognized_reason' }],
});
const report = (signals: unknown[]) => (async () => ({ status: 'ok', readBounds: { maxProjects: 1, projectsRead: 1,
  projectsTruncated: false, maxOverrides: 1, overridesRead: 0, overridesTruncated: false },
  report: { signals } })) as unknown as typeof readFrictionReport;

afterEach(() => vi.unstubAllEnvs());

describe('recurrence successor (B8.4d)', () => {
  it('re-submits the current allowlisted signal for the same problem, linked by the database', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    const { admin: client, rpc } = admin(tables(), { data: [{ successor_id: DECISION, successor_submission_id: SUCCESSOR,
      inserted: true }], error: null });
    const result = await recordRecurrenceSuccessor({ decisionId: DECISION }, REVIEWER, { admin: client,
      readReport: report([{ signalId: 'other', payload: { ...payload(9), code: 'other_code' } },
        { signalId: 'same', payload: payload(9) }]), newId: () => SUCCESSOR });
    expect(result).toEqual({ status: 'recorded', successorId: DECISION, successorSubmissionId: SUCCESSOR, inserted: true });
    const args = (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>]);
    expect(args[0]).toBe(RECORD_RECURRENCE_SUCCESSOR_FUNCTION);
    expect(args[1]).toMatchObject({ p_decision_id: DECISION, p_successor_submission_id: SUCCESSOR,
      p_schema_version: 'improvement_signal_submission_v1', p_payload: payload(9), p_recorded_by: REVIEWER.actorId });
    expect(args[1].p_payload_digest_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('creates nothing without a current signal, a recurrence decision, or review access', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    const quiet = admin(tables(), { data: null, error: null });
    expect(await recordRecurrenceSuccessor({ decisionId: DECISION }, REVIEWER,
      { admin: quiet.admin, readReport: report([]) })).toEqual({ status: 'signal_not_current' });
    const deferred = admin(tables('deferred'), { data: null, error: null });
    expect(await recordRecurrenceSuccessor({ decisionId: DECISION }, REVIEWER,
      { admin: deferred.admin, readReport: report([{ payload: payload(9) }]) })).toEqual({ status: 'not_current_recurrence' });
    expect(quiet.rpc).not.toHaveBeenCalled();
    expect(deferred.rpc).not.toHaveBeenCalled();
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'someone-else@example.invalid');
    expect(await recordRecurrenceSuccessor({ decisionId: DECISION }, REVIEWER, { admin: quiet.admin }))
      .toEqual({ status: 'reviewer_not_eligible' });
  });

  it('maps database refusals', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    for (const [code, status] of [['B8409', 'not_current_recurrence'], ['B8410', 'successor_repeats_submission']] as const) {
      const refused = admin(tables(), { data: null, error: { code } });
      expect(await recordRecurrenceSuccessor({ decisionId: DECISION }, REVIEWER,
        { admin: refused.admin, readReport: report([{ payload: payload(9) }]) })).toEqual({ status });
    }
  });
});
