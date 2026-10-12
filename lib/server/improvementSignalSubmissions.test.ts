import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { buildFrictionReport, type FrictionReport } from '@/lib/resolution/frictionReport';
import {
  AllowlistedFrictionSignalSchema,
  FRICTION_SIGNAL_KINDS,
} from '@/lib/resolution/frictionSignalAllowlist';
import type { FrictionReportReadBounds } from '@/lib/server/frictionReportRead';
import {
  buildImprovementSignalSubmissionRow,
  IMPROVEMENT_SIGNAL_SUBMISSION_SCHEMA_VERSION,
  submitImprovementSignal,
  type ImprovementSignalWriteClient,
} from '@/lib/server/improvementSignalSubmissions';

/** B8.3b: durable org-scoped improvement signal submissions. Synthetic records only. */

const ORG = 'org-1';
const SECRET = 'ZZSECRET';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOUNDS: FrictionReportReadBounds = {
  maxProjects: 50, projectsRead: 3, projectsTruncated: false, maxOverrides: 1000, overridesRead: 2, overridesTruncated: false,
};

function report(): FrictionReport {
  return buildFrictionReport({
    organizationId: ORG, documentTypeById: new Map([['d1', `${SECRET}_packet`], ['d2', 'invoice']]), projects: [],
    assertions: [], telemetry: [],
    outcomes: [{ outcomeCode: 'activation_not_allowed', documentId: 'd1' }],
    overrides: [
      { organizationId: ORG, projectId: 'p1', executionItemId: uuid(1), findingId: 'f1', ruleId: 'FINANCIAL_NTE_EXCEEDED', documentIds: ['d1'] },
      { organizationId: ORG, projectId: 'p1', executionItemId: `${SECRET}-e2`, findingId: 'f2', ruleId: 'FINANCIAL_NTE_EXCEEDED', documentIds: ['d2'] },
    ],
  });
}

function fakeAdmin(insertError: { code?: string; message?: string } | null = null, existing: unknown[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const filters: Array<[string, unknown]> = [];
  return {
    inserted, filters,
    admin: ({
      from: (table: string) => ({
        insert: (row: Record<string, unknown>) => { expect(table).toBe('improvement_signal_submissions'); inserted.push(row);
          return Promise.resolve({ error: insertError }); },
        select: () => {
          const query = {
            eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
            limit: () => query,
            then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: existing, error: null }).then(resolve),
          };
          return query;
        },
      }),
    }) as unknown as ImprovementSignalWriteClient,
  };
}

const readReport = (value: FrictionReport = report()) =>
  vi.fn(async () => ({ status: 'ok' as const, report: value, readBounds: BOUNDS }));

describe('submitImprovementSignal (B8.3b)', () => {
  it('appends only the recomputed, allowlisted payload with read bounds, actor and organization', async () => {
    const fake = fakeAdmin();
    const result = await submitImprovementSignal(
      { organizationId: ORG, actorId: uuid(42), signalId: 'rule_semantics_review:FINANCIAL_NTE_EXCEEDED' },
      { admin: fake.admin, readReport: readReport(), newId: () => uuid(100) },
    );
    expect(result).toMatchObject({ status: 'submitted', submissionId: uuid(100) });
    expect(fake.inserted).toHaveLength(1);
    const row = fake.inserted[0]!;
    expect(Object.keys(row).sort()).toEqual(['id', 'organization_id', 'payload', 'payload_digest_sha256', 'read_bounds',
      'schema_version', 'signal_code', 'signal_kind', 'submitted_by']);
    expect(row).toMatchObject({ organization_id: ORG, submitted_by: uuid(42), schema_version: IMPROVEMENT_SIGNAL_SUBMISSION_SCHEMA_VERSION,
      signal_kind: 'rule_semantics_review', signal_code: 'FINANCIAL_NTE_EXCEEDED', read_bounds: BOUNDS });
    expect(AllowlistedFrictionSignalSchema.safeParse(row.payload).success).toBe(true);
    expect(row.payload_digest_sha256).toBe(hashCanonical(row.payload));
    // Customer-controlled inputs (document labels, non-UUID record ids) never reach the row.
    expect(JSON.stringify(row).toLowerCase()).not.toContain(SECRET.toLowerCase());
  });

  it('is idempotent per organization and payload', async () => {
    const fake = fakeAdmin({ code: '23505', message: 'duplicate' }, [{ id: uuid(7) }]);
    const result = await submitImprovementSignal(
      { organizationId: ORG, actorId: uuid(42), signalId: 'rule_semantics_review:FINANCIAL_NTE_EXCEEDED' },
      { admin: fake.admin, readReport: readReport(), newId: () => uuid(100) },
    );
    expect(result).toMatchObject({ status: 'already_submitted', submissionId: uuid(7) });
    expect(fake.filters).toEqual([['organization_id', ORG], ['payload_digest_sha256', expect.stringMatching(/^[a-f0-9]{64}$/u)]]);
  });

  it('refuses unknown and policy-only signals, and surfaces read and write failures', async () => {
    const base = { organizationId: ORG, actorId: uuid(42) };
    expect(await submitImprovementSignal({ ...base, signalId: 'rule_semantics_review:NOPE' },
      { admin: fakeAdmin().admin, readReport: readReport() })).toEqual({ status: 'signal_not_found' });
    expect(await submitImprovementSignal({ ...base, signalId: 'qualification_demand:priced_value_reading' },
      { admin: fakeAdmin().admin, readReport: readReport() })).toEqual({ status: 'not_submittable' });
    expect(await submitImprovementSignal({ ...base, signalId: 'x' },
      { admin: fakeAdmin().admin, readReport: vi.fn(async () => ({ status: 'read_failed' as const, reason: 'projects_read_failed' })) }))
      .toEqual({ status: 'read_failed', reason: 'projects_read_failed' });
    expect(await submitImprovementSignal({ ...base, signalId: 'rule_semantics_review:FINANCIAL_NTE_EXCEEDED' },
      { admin: fakeAdmin({ code: '42501', message: 'denied' }).admin, readReport: readReport() }))
      .toEqual({ status: 'persist_failed', reason: 'denied' });
    expect(await submitImprovementSignal({ ...base, signalId: 'x' }, { admin: null })).toEqual({ status: 'not_configured' });
  });

  it('never builds a row from a payload outside the allowlist', () => {
    const payload = report().signals.find((signal) => signal.kind === 'rule_semantics_review')!.payload;
    expect(() => buildImprovementSignalSubmissionRow({ id: uuid(1), organizationId: ORG, actorId: uuid(2),
      payload: { ...payload, note: SECRET } as never, readBounds: BOUNDS })).toThrow();
  });
});

describe('improvement_signal_submissions migration (B8.3b)', () => {
  const sql = readFileSync('supabase/migrations/20261012040000_improvement_signal_submissions.sql', 'utf8');

  it('is append-only and reachable only by the trusted server', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).not.toMatch(/CREATE POLICY/iu);
    expect(sql).toContain('REVOKE ALL ON TABLE "public"."improvement_signal_submissions" FROM "anon", "authenticated";');
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE "public"."improvement_signal_submissions" TO "service_role";');
    expect(sql).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE)\b[^;]*improvement_signal_submissions/iu);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON "public"\."improvement_signal_submissions"/u);
  });

  it('re-asserts exactly the allowlisted payload shape, kinds and versions', () => {
    const schemaKeys = Object.keys((AllowlistedFrictionSignalSchema as unknown as { _def: { schema: { shape: object } } })
      ._def.schema.shape).sort();
    const keyList = /"payload" \?& ARRAY\[([^\]]+)\]/u.exec(sql)![1]!;
    expect([...keyList.matchAll(/'([A-Za-z]+)'/gu)].map((match) => match[1]).sort()).toEqual(schemaKeys);
    for (const kind of FRICTION_SIGNAL_KINDS) expect(sql).toContain(`'${kind}'::"text"`);
    expect(sql).toContain(`"schema_version" = '${IMPROVEMENT_SIGNAL_SUBMISSION_SCHEMA_VERSION}'`);
    expect(sql).toContain(`"payload"->>'schemaVersion' = 'friction_signal_v1'`);
    expect(sql).toContain('UNIQUE ("organization_id", "payload_digest_sha256")');
  });
});
