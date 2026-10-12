import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import {
  TRIAGE_CAPABILITY_SCOPES,
  TRIAGE_DISPOSITIONS,
  TRIAGE_SEMANTICS_DEFECT_CLASSES,
  triageShapeError,
} from '@/lib/improvementSignalTriageContract';
import {
  readImprovementSignalTriageQueue,
  recordImprovementSignalTriage,
  type TriageClient,
} from '@/lib/server/improvementSignalTriage';

/** B8.3c: human triage of improvement signal submissions. Synthetic records only. */

const REVIEWER = { actorId: '22222222-2222-4222-8222-222222222222', email: 'platform.reviewer@example.test', role: 'admin' };
const SUBMISSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ORG = '11111111-1111-4111-8111-111111111111';

function fakeClient(tables: { submissions?: unknown[]; triages?: unknown[] }, insertError: { code?: string; message?: string } | null = null) {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      return {
        select() {
          const rows = table === 'improvement_signal_submissions' ? tables.submissions ?? [] : tables.triages ?? [];
          let data = [...rows] as Array<Record<string, unknown>>;
          const query = {
            eq: (column: string, value: unknown) => { data = data.filter((row) => row[column] === value); return query; },
            in: () => query,
            order: (column: string, options: { ascending: boolean }) => {
              data.sort((a, b) => ((a[column] as number) - (b[column] as number)) * (options.ascending ? 1 : -1)); return query; },
            limit: (count: number) => { data = data.slice(0, count); return query; },
            then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
          };
          return query;
        },
        insert(row: Record<string, unknown>) { inserted.push(row); return Promise.resolve({ data: null, error: insertError }); },
      };
    },
  } as unknown as TriageClient;
  return { client, inserted };
}

const SEMANTICS = { id: SUBMISSION, organization_id: ORG, signal_kind: 'rule_semantics_review' };
const triage = (overrides: Record<string, unknown> = {}) => ({
  submissionId: SUBMISSION, expectedTriageVersion: 0, disposition: 'route_to_engineering' as const,
  capabilityScope: 'reusable_platform_capability' as const, semanticsDefectClass: 'wording_defect' as const,
  planClassification: 'RULE' as const,
  rationale: 'Explanation reads as if the rule fires on approved overages.', ...overrides,
});

describe('recordImprovementSignalTriage (B8.3c)', () => {
  beforeEach(() => { vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email); vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('records version 1, binding the submission organization and signal kind, from a session reviewer', async () => {
    const fake = fakeClient({ submissions: [SEMANTICS] });
    const result = await recordImprovementSignalTriage(triage(), REVIEWER, { admin: fake.client, newId: () => 'triage-1' });
    expect(result).toEqual({ status: 'triage_recorded', triageId: 'triage-1', triageVersion: 1, disposition: 'route_to_engineering' });
    expect(fake.inserted).toEqual([{
      id: 'triage-1', submission_id: SUBMISSION, organization_id: ORG, signal_kind: 'rule_semantics_review', triage_version: 1,
      disposition: 'route_to_engineering', capability_scope: 'reusable_platform_capability', semantics_defect_class: 'wording_defect',
      plan_classification: 'RULE',
      rationale: 'Explanation reads as if the rule fires on approved overages.', reviewer_actor_id: REVIEWER.actorId,
    }]);
  });

  it('uses the existing platform-review allowlist and never a body-supplied reviewer', async () => {
    const fake = fakeClient({ submissions: [SEMANTICS] });
    expect(await recordImprovementSignalTriage(triage(), { ...REVIEWER, email: 'tenant.admin@example.test' }, { admin: fake.client }))
      .toEqual({ status: 'reviewer_not_eligible', reason: 'not_allowlisted' });
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', '');
    expect(await recordImprovementSignalTriage(triage(), REVIEWER, { admin: fake.client }))
      .toEqual({ status: 'reviewer_not_eligible', reason: 'not_configured' });
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    expect(await recordImprovementSignalTriage(triage(), { ...REVIEWER, actorId: 'not-a-uuid' }, { admin: fake.client }))
      .toEqual({ status: 'reviewer_unresolved' });
    expect((await recordImprovementSignalTriage({ ...triage(), reviewerActorId: REVIEWER.actorId } as never, REVIEWER,
      { admin: fake.client })).status).toBe('input_invalid');
    expect(fake.inserted).toEqual([]);
  });

  it('enforces the cross-field rules against the stored signal kind', async () => {
    const run = async (overrides: Record<string, unknown>, submission: Record<string, unknown> = SEMANTICS) =>
      recordImprovementSignalTriage(triage(overrides), REVIEWER, { admin: fakeClient({ submissions: [submission] }).client });
    expect(await run({ semanticsDefectClass: null })).toEqual({ status: 'input_invalid', reason: 'semantics_defect_class_required' });
    expect(await run({ capabilityScope: null })).toEqual({ status: 'input_invalid', reason: 'capability_scope_required' });
    expect(await run({ disposition: 'reject', capabilityScope: null })).toEqual({ status: 'input_invalid', reason: 'semantics_defect_class_not_allowed' });
    expect(await run({ disposition: 'reject', capabilityScope: null, semanticsDefectClass: null }))
      .toEqual({ status: 'input_invalid', reason: 'plan_classification_not_allowed' });
    expect((await run({ disposition: 'reject', capabilityScope: null, semanticsDefectClass: null, planClassification: null })).status)
      .toBe('triage_recorded');
    expect(await run({ planClassification: null })).toEqual({ status: 'input_invalid', reason: 'plan_classification_required' });
    expect(await run({ planClassification: 'BUILD' })).toMatchObject({ status: 'input_invalid', reason: 'planClassification' });
    const failure = { ...SEMANTICS, signal_kind: 'recurring_deterministic_failure' };
    expect(await run({}, failure)).toEqual({ status: 'input_invalid', reason: 'semantics_defect_class_not_allowed' });
    expect((await run({ semanticsDefectClass: null }, failure)).status).toBe('triage_recorded');
    expect(await run({ disposition: 'defer', semanticsDefectClass: null, planClassification: null }, failure))
      .toEqual({ status: 'input_invalid', reason: 'capability_scope_not_allowed' });
  });

  it('versions re-triage and refuses a stale view or a racing writer', async () => {
    const existing = [{ submission_id: SUBMISSION, triage_version: 1 }, { submission_id: SUBMISSION, triage_version: 2 }];
    const fake = fakeClient({ submissions: [SEMANTICS], triages: existing });
    expect(await recordImprovementSignalTriage(triage({ expectedTriageVersion: 1 }), REVIEWER, { admin: fake.client }))
      .toEqual({ status: 'version_conflict', currentTriageVersion: 2 });
    const next = await recordImprovementSignalTriage(triage({ expectedTriageVersion: 2 }), REVIEWER, { admin: fake.client, newId: () => 't3' });
    expect(next).toMatchObject({ status: 'triage_recorded', triageVersion: 3 });
    const racing = fakeClient({ submissions: [SEMANTICS] }, { code: '23505', message: 'duplicate' });
    expect((await recordImprovementSignalTriage(triage(), REVIEWER, { admin: racing.client })).status).toBe('version_conflict');
    expect(await recordImprovementSignalTriage(triage(), REVIEWER, { admin: fakeClient({}).client }))
      .toEqual({ status: 'submission_not_found' });
  });
});

describe('readImprovementSignalTriageQueue (B8.3c)', () => {
  it('returns each submission with its latest triage; untriaged and deferred await triage', async () => {
    const submissions = [
      { id: 's1', organization_id: ORG, signal_kind: 'rule_semantics_review', signal_code: 'FINANCIAL_NTE_EXCEEDED', payload: {}, read_bounds: {}, submitted_at: 't2' },
      { id: 's2', organization_id: ORG, signal_kind: 'recurring_deterministic_failure', signal_code: 'inconsistent_row_pitch', payload: {}, read_bounds: {}, submitted_at: 't1' },
      { id: 's3', organization_id: ORG, signal_kind: 'recurring_deterministic_failure', signal_code: 'unpriced_row', payload: {}, read_bounds: {}, submitted_at: 't0' },
    ];
    const triages = [
      { submission_id: 's1', triage_version: 1, disposition: 'defer', capability_scope: null, semantics_defect_class: null, rationale: 'r1', reviewer_actor_id: 'a', reviewed_at: 'x' },
      { submission_id: 's1', triage_version: 2, disposition: 'route_to_engineering', capability_scope: 'reusable_platform_capability', semantics_defect_class: 'rule_logic_defect', rationale: 'r2', reviewer_actor_id: 'a', reviewed_at: 'y' },
      { submission_id: 's2', triage_version: 1, disposition: 'defer', capability_scope: null, semantics_defect_class: null, rationale: 'later', reviewer_actor_id: 'a', reviewed_at: 'z' },
    ];
    const result = await readImprovementSignalTriageQueue({ admin: fakeClient({ submissions, triages }).client });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.rows.map((row) => [row.submissionId, row.latestTriage?.triageVersion ?? null, row.latestTriage?.disposition ?? null, row.awaitingTriage]))
      .toEqual([['s1', 2, 'route_to_engineering', false], ['s2', 1, 'defer', true], ['s3', null, null, true]]);
  });
});

describe('improvement_signal_triage_reviews migration (B8.3c)', () => {
  const sql = readFileSync('supabase/migrations/20261012050000_improvement_signal_triage_reviews.sql', 'utf8');

  it('matches the shared contract vocabulary', () => {
    for (const value of [...TRIAGE_DISPOSITIONS, ...TRIAGE_CAPABILITY_SCOPES, ...TRIAGE_SEMANTICS_DEFECT_CLASSES]) {
      expect(sql).toContain(`'${value}'::"text"`);
    }
  });

  it('is append-only, server-only, and bound to the submission organization and kind', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/CREATE POLICY/iu);
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE "public"."improvement_signal_triage_reviews" TO "service_role";');
    expect(sql).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE)\b[^;]*improvement_signal_triage_reviews/iu);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON "public"\."improvement_signal_triage_reviews"/u);
    expect(sql).toContain('FOREIGN KEY ("submission_id", "organization_id", "signal_kind")');
    expect(sql).toContain('UNIQUE ("submission_id", "triage_version")');
  });
});

describe('triageShapeError (B8.3c contract)', () => {
  it('requires scope exactly when routed, and a defect class exactly for a routed semantics review', () => {
    expect(triageShapeError({ signalKind: 'rule_semantics_review', disposition: 'customer_config_or_mapping',
      capabilityScope: 'client_specific', semanticsDefectClass: 'wording_defect', planClassification: null })).toBeNull();
    expect(triageShapeError({ signalKind: 'forgewing_rejected', disposition: 'reject', capabilityScope: null,
      semanticsDefectClass: null, planClassification: null })).toBeNull();
    expect(triageShapeError({ signalKind: 'forgewing_rejected', disposition: 'reject', capabilityScope: 'client_specific',
      semanticsDefectClass: null, planClassification: null })).toBe('capability_scope_not_allowed');
  });

  it('requires the human Plan V2 classification exactly for route_to_engineering (B8.3d)', () => {
    const routed = { signalKind: 'recurring_manual_correction', disposition: 'route_to_engineering' as const,
      capabilityScope: 'workflow_specific', semanticsDefectClass: null };
    expect(triageShapeError({ ...routed, planClassification: null })).toBe('plan_classification_required');
    expect(triageShapeError({ ...routed, planClassification: 'VERIFY' })).toBeNull();
    for (const disposition of ['customer_config_or_mapping', 'reject', 'defer'] as const) {
      expect(triageShapeError({ signalKind: 'forgewing_rejected', disposition,
        capabilityScope: disposition === 'customer_config_or_mapping' ? 'client_specific' : null,
        semanticsDefectClass: null, planClassification: 'EXTRACT' })).toBe('plan_classification_not_allowed');
    }
  });
});
