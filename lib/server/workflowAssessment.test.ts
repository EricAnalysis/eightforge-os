import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
  admin: null as unknown,
  run: vi.fn(),
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: () => dependencyMocks.admin,
}));

vi.mock('@/lib/forgewing/tasks/workflowAssessment', () => ({
  runForgewingWorkflowAssessment: (...args: unknown[]) => dependencyMocks.run(...args),
}));

import {
  loadWorkflowIntakeSubmission,
  runAndRecordWorkflowAssessment,
  WORKFLOW_ASSESSMENT_TABLE,
  WORKFLOW_INTAKE_READ_FUNCTION,
} from '@/lib/server/workflowAssessment';

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';

function intakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBMISSION_ID,
    schema_version: 'workflow_intake_v1',
    workflow_description: 'Reviewing contractor invoices against rate schedules.',
    documents_involved: 'Invoices, rate schedules, approved work orders.',
    manual_checks: 'A reviewer compares billed rates to the contract rate.',
    frequency_and_volume: '40 packages each week.',
    exceptions: 'Mismatches escalate to the project manager.',
    human_decisions: 'Final approval of any payment adjustment.',
    submitted_at: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

const assessment = {
  schemaVersion: 'workflow_assessment_v1',
  assessmentId: 'forgewing-workflow-assessment-abc',
  sourceSubmissionId: SUBMISSION_ID,
  sourceSubmissionSchemaVersion: 'workflow_intake_v1',
  sourceSubmissionDigestSha256: 'a'.repeat(64),
  authority: 'non_authoritative',
  requiresHumanReview: true,
  summary: 'x',
  workflowSteps: [],
  automationAssessment: { basis: 'classified_workflow_steps', totalSteps: 0 },
} as never;

const metadata = {
  model: 'fake-model',
  promptTemplateId: 'forgewing-workflow-assessment',
  promptTemplateVersion: 'v1',
  calls: 1,
} as never;

beforeEach(() => {
  dependencyMocks.admin = null;
  dependencyMocks.run.mockReset();
});

/** Records every table touched so intake immutability can be asserted. */
function fakeAdmin(options: { latestVersion?: number | null; insertError?: string } = {}) {
  const touched: Array<{ table: string; op: string }> = [];
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    touched.push({ table: WORKFLOW_ASSESSMENT_TABLE, op: 'insert' });
    void row;
    return options.insertError ? { error: { message: options.insertError } } : { error: null };
  });
  const select = vi.fn(() => {
    touched.push({ table: WORKFLOW_ASSESSMENT_TABLE, op: 'select' });
    const chain = {
      eq: () => chain,
      order: () => chain,
      limit: async () => ({
        data: options.latestVersion == null
          ? []
          : [{ assessment_version: options.latestVersion }],
        error: null,
      }),
    };
    return chain;
  });
  const from = vi.fn((table: string) => {
    if (table !== WORKFLOW_ASSESSMENT_TABLE) touched.push({ table, op: 'from' });
    return { insert, select };
  });
  const rpc = vi.fn(async () => ({ data: [intakeRow()], error: null }));
  return { admin: { from, rpc } as never, from, rpc, insert, select, touched };
}

describe('workflow intake read seam', () => {
  it('reads one submission through the SECURITY DEFINER function by id', async () => {
    const { admin, rpc } = fakeAdmin();
    const loaded = await loadWorkflowIntakeSubmission(SUBMISSION_ID, admin);

    expect(rpc).toHaveBeenCalledWith(WORKFLOW_INTAKE_READ_FUNCTION, {
      submission_id: SUBMISSION_ID,
    });
    expect(loaded?.submissionId).toBe(SUBMISSION_ID);
    expect(loaded?.answers.workflowDescription).toContain('contractor invoices');
    expect(Object.keys(loaded!.answers)).toHaveLength(6);
  });

  it('returns nothing when the row is absent, mismatched, or incomplete', async () => {
    const cases: unknown[] = [
      [],
      null,
      [intakeRow({ id: '22222222-2222-4222-8222-222222222222' })],
      [intakeRow({ manual_checks: '   ' })],
      [intakeRow({ human_decisions: 42 })],
      [intakeRow({ schema_version: 5 })],
    ];
    for (const data of cases) {
      const admin = { rpc: vi.fn(async () => ({ data, error: null })) } as never;
      await expect(loadWorkflowIntakeSubmission(SUBMISSION_ID, admin)).resolves.toBeNull();
    }
  });
});

describe('workflow assessment recording', () => {
  it('records a non-authoritative assessment at version 1 without touching intake', async () => {
    const fake = fakeAdmin({ latestVersion: null });
    dependencyMocks.admin = fake.admin;
    dependencyMocks.run.mockResolvedValue({ status: 'requires_human_review', assessment, metadata });
    const result = await runAndRecordWorkflowAssessment(SUBMISSION_ID);

    expect(result).toMatchObject({
      status: 'assessment_recorded',
      sourceSubmissionId: SUBMISSION_ID,
      assessmentVersion: 1,
      authority: 'non_authoritative',
      requiresHumanReview: true,
    });

    const row = fake.insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.authority).toBe('non_authoritative');
    expect(row.requires_human_review).toBe(true);
    expect(row.review_status).toBe('pending_human_review');
    expect(row.source_submission_id).toBe(SUBMISSION_ID);
    expect(String(row.assessment_digest_sha256)).toMatch(/^[a-f0-9]{64}$/);

    // The intake table is never written to, under any name.
    expect(fake.touched.every((entry) => entry.table === WORKFLOW_ASSESSMENT_TABLE)).toBe(true);
    expect(fake.from).not.toHaveBeenCalledWith('workflow_intake_submissions');
  });

  it('appends a new version rather than overwriting a prior assessment', async () => {
    const fake = fakeAdmin({ latestVersion: 3 });
    dependencyMocks.admin = fake.admin;
    dependencyMocks.run.mockResolvedValue({ status: 'requires_human_review', assessment, metadata });
    const result = await runAndRecordWorkflowAssessment(SUBMISSION_ID);
    expect(result).toMatchObject({ status: 'assessment_recorded', assessmentVersion: 4 });
    const row = fake.insert.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.assessment_version).toBe(4);
  });

  it('reports a missing submission without calling the assessment task', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: [], error: null })), from: vi.fn() } as never;
    dependencyMocks.admin = admin;
    await expect(runAndRecordWorkflowAssessment(SUBMISSION_ID))
      .resolves.toEqual({ status: 'submission_not_found' });
    expect(dependencyMocks.run).not.toHaveBeenCalled();
  });

  it('persists nothing when the assessment is not produced', async () => {
    for (const status of [
      'assessment_disabled', 'input_invalid', 'provider_failed',
      'structured_output_invalid', 'deterministic_validation_failed',
    ] as const) {
      const fake = fakeAdmin();
      dependencyMocks.admin = fake.admin;
      dependencyMocks.run.mockResolvedValueOnce({ status, reason: 'x' });
      const result = await runAndRecordWorkflowAssessment(SUBMISSION_ID);
      expect(result).toEqual({ status: 'assessment_not_produced', reason: status });
      expect(fake.insert).not.toHaveBeenCalled();
    }
  });

  it('contains a persistence failure without altering intake', async () => {
    const fake = fakeAdmin({ insertError: 'permission denied' });
    dependencyMocks.admin = fake.admin;
    dependencyMocks.run.mockResolvedValue({ status: 'requires_human_review', assessment, metadata });
    const result = await runAndRecordWorkflowAssessment(SUBMISSION_ID);
    expect(result).toMatchObject({ status: 'persist_failed' });
    expect(fake.from).not.toHaveBeenCalledWith('workflow_intake_submissions');
  });

  it('reports unconfigured storage instead of throwing', async () => {
    await expect(runAndRecordWorkflowAssessment(SUBMISSION_ID))
      .resolves.toEqual({ status: 'not_configured' });
  });

  it('does not expose or honor production dependency overrides', async () => {
    expectTypeOf(runAndRecordWorkflowAssessment)
      .parameters.toEqualTypeOf<[submissionId: string]>();

    const fake = fakeAdmin();
    dependencyMocks.admin = fake.admin;
    dependencyMocks.run.mockResolvedValue({ status: 'requires_human_review', assessment, metadata });
    const injectedAdmin = { from: vi.fn(), rpc: vi.fn() };
    const injectedLoad = vi.fn();
    const injectedRun = vi.fn();
    const widened = runAndRecordWorkflowAssessment as unknown as (
      submissionId: string,
      overrides: unknown,
    ) => ReturnType<typeof runAndRecordWorkflowAssessment>;

    await widened(SUBMISSION_ID, {
      admin: injectedAdmin,
      load: injectedLoad,
      run: injectedRun,
    });

    expect(injectedAdmin.from).not.toHaveBeenCalled();
    expect(injectedAdmin.rpc).not.toHaveBeenCalled();
    expect(injectedLoad).not.toHaveBeenCalled();
    expect(injectedRun).not.toHaveBeenCalled();
    expect(fake.rpc).toHaveBeenCalled();
    expect(dependencyMocks.run).toHaveBeenCalledOnce();
  });
});

describe('workflow assessment boundaries', () => {
  it('never writes canonical, Validator, or Project Truth state', () => {
    // The intake read now lives in a neutral module so the review read seam can
    // share it without importing this guarded one. Both files are checked, so
    // relocating the code did not relocate the property out of the test.
    const sources = [
      'lib/server/workflowAssessment.ts',
      'lib/server/workflowIntakeRead.ts',
    ].map((file) => readFileSync(file, 'utf8'));

    for (const source of sources) {
      for (const forbidden of [
        'lib/canonical', 'lib/validator', 'lib/projectFacts', 'lib/truthQuery',
        'lib/effectiveFacts', 'CanonicalFact', 'VerifiedField',
      ]) {
        expect(source).not.toContain(forbidden);
      }
      // The intake table is only ever reached through the read-only RPC seam.
      expect(source).not.toContain("from('workflow_intake_submissions')");
    }

    expect(sources.join(' ')).toContain(WORKFLOW_INTAKE_READ_FUNCTION);
  });

  it('exposes no anonymous read path for assessments', () => {
    const route = readFileSync('app/api/internal/workflow-assessment/route.ts', 'utf8');
    // No GET handler exists, and the POST trigger is secret-gated.
    expect(route).not.toMatch(/export\s+async\s+function\s+GET/);
    expect(route).toContain('timingSafeEqual');
    expect(route).toContain('CRON_SECRET');
    expect(route).toContain('unauthorized');
    // Only a submission id is accepted; prose is never taken from the caller.
    expect(route).toContain('submissionId');
    expect(route).not.toContain('workflowDescription');
  });

  it('keeps assessment storage denied to anon and authenticated', () => {
    const migration = readFileSync(
      'supabase/migrations/20260830160000_workflow_assessments.sql', 'utf8');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE "public"\."workflow_assessments" FROM "anon", "authenticated"/);
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE "public"."workflow_assessments" TO "service_role"');
    // Append-only: no UPDATE or DELETE grant, plus a trigger that refuses both.
    expect(migration).not.toMatch(/GRANT[^;]*UPDATE[^;]*workflow_assessments/);
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "public"."workflow_assessments"');
    // The read seam must not relax the intake table's own grants.
    expect(migration).not.toMatch(/GRANT[^;]*ON TABLE "public"\."workflow_intake_submissions"/);
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION "public"."read_workflow_intake_submission"("uuid")');
  });
});
