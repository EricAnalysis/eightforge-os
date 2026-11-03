import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getActorContextMock, getSupabaseAdminMock, intakeMock, accessMock } = vi.hoisted(() => ({
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  intakeMock: vi.fn(),
  accessMock: vi.fn(),
}));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: getActorContextMock }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getSupabaseAdminMock }));
vi.mock('@/lib/server/workflowIntakeRead', () => ({ loadWorkflowIntakeSubmission: intakeMock }));
vi.mock('@/lib/server/workflowPlatformReviewAccess', () => ({ resolveWorkflowPlatformReviewAccess: accessMock }));

import { POST } from '@/app/api/internal/workflow-assessments/[assessmentId]/follow-up-answers/route';
import { FdeFollowUpAnswers } from '@/components/workflows/FdeFollowUpAnswers';
import { allFdeFollowUps, buildFdeReadinessPlan } from '@/lib/projectIntelligence/fdeReadiness';
import { readWorkflowReviewPacket } from '@/lib/server/workflowAssessmentReviewRead';
import { readWorkflowFollowUpAnswers, recordWorkflowFollowUpAnswer } from '@/lib/server/workflowFollowUpAnswers';

const ASSESSMENT_ID = '11111111-1111-4111-8111-111111111111';
const SUBMISSION_ID = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '33333333-3333-4333-8333-333333333333';
const ASSESSMENT = {
  documents: [],
  workflowSteps: [{ stepId: 's1', classification: 'VERIFY', description: 'Check the billed rate', unresolvedAssumptions: ['What tolerance applies?'], determinismGaps: [] }],
};
const [FOLLOW_UP] = allFdeFollowUps(ASSESSMENT);
const INTAKE = { organizationId: 'org-1', attachmentManifest: [], answers: { workflow_description: 'original answer' } };
const MIGRATION = readFileSync('supabase/migrations/20261102130000_workflow_assessment_follow_up_answers.sql', 'utf8');

type Rows = Record<string, unknown[]>;

function fakeAdmin(rows: Rows, options: { insertError?: { code: string } | null; readErrorOn?: string } = {}) {
  const inserts: { table: string; value: Record<string, unknown> }[] = [];
  const touched: string[] = [];
  const filters: [string, string, unknown][] = [];
  const admin = {
    from(table: string) {
      touched.push(table);
      const error = options.readErrorOn === table ? { message: 'boom' } : null;
      const result = () => ({ data: error ? null : rows[table] ?? [], error });
      const chain: Record<string, unknown> = {
        select: () => chain, order: () => chain, limit: () => chain, is: () => chain, in: () => chain,
        eq: (column: string, value: unknown) => { filters.push([table, column, value]); return chain; },
        maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
        insert: async (value: Record<string, unknown>) => { inserts.push({ table, value }); return { error: options.insertError ?? null }; },
      };
      for (const write of ['update', 'upsert', 'delete']) chain[write] = () => { throw new Error(`unexpected ${write} on ${table}`); };
      return chain;
    },
    rpc() { throw new Error('unexpected rpc'); },
  };
  return { admin: admin as never, inserts, touched, filters };
}

const ROWS: Rows = {
  workflow_assessments: [{ id: ASSESSMENT_ID, source_submission_id: SUBMISSION_ID, assessment_version: 2, assessment: ASSESSMENT, authority: 'non_authoritative', requires_human_review: true, created_at: '2026-11-01T00:00:00Z' }],
};

function record(admin: never, overrides: Partial<Parameters<typeof recordWorkflowFollowUpAnswer>[1]> = {}) {
  return recordWorkflowFollowUpAnswer(admin, {
    organizationId: 'org-1', actorId: 'user-1', assessmentId: ASSESSMENT_ID, followUpId: FOLLOW_UP!.followUpId,
    answer: '  Two cents either way.  ', answerSource: 'customer_stated', evidenceAttachmentIds: [], newId: () => 'answer-2', ...overrides,
  });
}

beforeEach(() => {
  intakeMock.mockResolvedValue(INTAKE);
  accessMock.mockReturnValue({ allowed: true });
  getActorContextMock.mockResolvedValue({ ok: true, actor: { actorId: 'user-1', organizationId: 'org-1' } });
});
afterEach(() => vi.clearAllMocks());

describe('recording an answer', () => {
  it('takes the question from the assessment and appends one row, as the first revision', async () => {
    const { admin, inserts, touched } = fakeAdmin(ROWS);
    await expect(record(admin)).resolves.toEqual({ status: 'recorded', answerId: 'answer-2', revision: 1 });
    expect(inserts).toEqual([{ table: 'workflow_assessment_follow_up_answers', value: {
      id: 'answer-2', organization_id: 'org-1', source_submission_id: SUBMISSION_ID, assessment_id: ASSESSMENT_ID, assessment_version: 2,
      follow_up_id: FOLLOW_UP!.followUpId, follow_up_kind: 'unresolved_assumption', step_id: 's1', question_snapshot: 'What tolerance applies?',
      answer_text: 'Two cents either way.', answer_source: 'customer_stated', evidence_attachment_ids: [], revision: 1, supersedes_answer_id: null, answered_by: 'user-1',
    } }]);
    expect(touched).not.toContain('workflow_intake_submissions');
  });

  it('appends a revision pointing at the one it replaces, leaving the earlier answer alone', async () => {
    const { admin, inserts } = fakeAdmin({ ...ROWS, workflow_assessment_follow_up_answers: [{ id: 'answer-1', revision: 1 }] });
    await expect(record(admin)).resolves.toMatchObject({ status: 'recorded', revision: 2 });
    expect(inserts[0]!.value).toMatchObject({ revision: 2, supersedes_answer_id: 'answer-1' });
  });

  it('refuses a question this assessment did not ask', async () => {
    const { admin, inserts } = fakeAdmin(ROWS);
    await expect(record(admin, { followUpId: 'a'.repeat(64) })).resolves.toEqual({ status: 'follow_up_not_in_assessment' });
    expect(inserts).toEqual([]);
  });

  it('refuses another organization, and a submission with none', async () => {
    const { admin, inserts } = fakeAdmin(ROWS);
    await expect(record(admin, { organizationId: 'org-other' })).resolves.toEqual({ status: 'assessment_not_found' });
    intakeMock.mockResolvedValueOnce({ ...INTAKE, organizationId: null });
    await expect(record(admin)).resolves.toEqual({ status: 'assessment_not_found' });
    expect(inserts).toEqual([]);
  });

  it('accepts evidence only from this submission', async () => {
    const { admin, inserts, filters } = fakeAdmin({ ...ROWS, workflow_assessment_attachments: [{ id: FILE_ID }] });
    await expect(record(admin, { evidenceAttachmentIds: [FILE_ID, FILE_ID] })).resolves.toMatchObject({ status: 'recorded' });
    expect(inserts[0]!.value.evidence_attachment_ids).toEqual([FILE_ID]);
    expect(filters).toEqual(expect.arrayContaining([['workflow_assessment_attachments', 'draft_id', SUBMISSION_ID], ['workflow_assessment_attachments', 'organization_id', 'org-1']]));
    const none = fakeAdmin(ROWS);
    await expect(record(none.admin, { evidenceAttachmentIds: [FILE_ID] })).resolves.toEqual({ status: 'evidence_not_in_submission' });
    expect(none.inserts).toEqual([]);
  });

  it('reports a lost race as a conflict', async () => {
    const { admin } = fakeAdmin(ROWS, { insertError: { code: '23505' } });
    await expect(record(admin)).resolves.toEqual({ status: 'revision_conflict' });
  });
});

describe('reading answers', () => {
  it('binds to the organization and the submission', async () => {
    const { admin, filters } = fakeAdmin({});
    await readWorkflowFollowUpAnswers(admin, { organizationId: 'org-1', sourceSubmissionId: SUBMISSION_ID });
    expect(filters).toEqual([['workflow_assessment_follow_up_answers', 'organization_id', 'org-1'], ['workflow_assessment_follow_up_answers', 'source_submission_id', SUBMISSION_ID]]);
  });
});

describe('the review packet', () => {
  const answer = { id: 'answer-1', follow_up_id: FOLLOW_UP!.followUpId, step_id: 's1', question_snapshot: 'What tolerance applies?', answer_text: 'Two cents.', answer_source: 'customer_stated', evidence_attachment_ids: [], revision: 1, supersedes_answer_id: null, assessment_id: ASSESSMENT_ID, assessment_version: 2, answered_by: 'user-1', answered_at: '2026-11-02T00:00:00Z' };

  async function packet(rows: Rows, options = {}) {
    getSupabaseAdminMock.mockReturnValue(fakeAdmin({ ...ROWS, ...rows }, options).admin);
    const read = await readWorkflowReviewPacket(ASSESSMENT_ID, 'org-1');
    if (read.status !== 'ok') throw new Error(read.status);
    return read.packet;
  }

  it('rebuilds readiness from the answers, with the assessment and intake unchanged', async () => {
    const before = await packet({});
    expect(before.readinessPlan!.deploymentState).toBe('blocked_on_customer_information');
    expect(before.followUpAnswers).toEqual([]);
    const after = await packet({ workflow_assessment_follow_up_answers: [answer] });
    expect(after.readinessPlan!.followUps).toEqual([]);
    expect(after.readinessPlan!.answeredFollowUps).toMatchObject([{ answerId: 'answer-1' }]);
    expect(after.readinessPlan!.deploymentState).toBe('ready_existing_capability');
    expect(after.assessment).toEqual(ASSESSMENT);
    expect(after.intake).toEqual(INTAKE.answers);
    expect(after.followUpAnswers).toMatchObject([{ answer: 'Two cents.', revision: 1, assessmentVersion: 2 }]);
  });

  it('meets the same question on a later assessment version', async () => {
    const after = await packet({
      workflow_assessment_follow_up_answers: [{ ...answer, assessment_version: 1 }],
      workflow_assessments: [{ ...(ROWS.workflow_assessments![0] as object), assessment_version: 3 }],
    });
    expect(after.readinessPlan!.followUps).toEqual([]);
    expect(after.followUpAnswers![0]!.assessmentVersion).toBe(1);
  });

  it('treats unreadable answers as unanswered, and still opens the review', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const read = await packet({}, { readErrorOn: 'workflow_assessment_follow_up_answers' });
    expect(read.followUpAnswers).toBeNull();
    expect(read.readinessPlan!.deploymentState).toBe('blocked_on_customer_information');
    warn.mockRestore();
  });

  it('offers no answers on a submission with no organization', async () => {
    intakeMock.mockResolvedValue({ ...INTAKE, organizationId: null });
    expect((await packet({ workflow_assessment_follow_up_answers: [answer] })).followUpAnswers).toBeNull();
  });
});

describe('POST follow-up-answers', () => {
  const post = (body: unknown, id = ASSESSMENT_ID) => POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ assessmentId: id }) });
  const valid = { followUpId: FOLLOW_UP!.followUpId, answer: 'Two cents.', answerSource: 'customer_stated' };

  it('refuses anyone outside the platform review allowlist before reading a body', async () => {
    accessMock.mockReturnValue({ allowed: false, reason: 'not_on_allowlist' });
    const response = await post(valid);
    expect(response.status).toBe(403);
    expect(getSupabaseAdminMock).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    getActorContextMock.mockResolvedValue({ ok: false, status: 401, error: 'x' });
    expect((await post(valid)).status).toBe(401);
  });

  it.each([
    [{ ...valid, answer: '   ' }],
    [{ ...valid, answer: 'x'.repeat(4001) }],
    [{ ...valid, answerSource: 'the_model_said_so' }],
    [{ ...valid, followUpId: 'nope' }],
    [{ ...valid, evidenceAttachmentIds: ['not-a-uuid'] }],
    [{ ...valid, question: 'A question the caller made up' }],
    [{ ...valid, authority: 'canonical' }],
  ])('rejects %j', async (body) => {
    getSupabaseAdminMock.mockReturnValue(fakeAdmin(ROWS).admin);
    expect((await post(body)).status).toBe(400);
  });

  it('records under the actor and organization from the session, never the body', async () => {
    const fake = fakeAdmin(ROWS);
    getSupabaseAdminMock.mockReturnValue(fake.admin);
    const response = await post(valid);
    expect(response.status).toBe(200);
    expect(fake.inserts[0]!.value).toMatchObject({ organization_id: 'org-1', answered_by: 'user-1' });
  });

  it('calls no provider', () => {
    const source = ['app/api/internal/workflow-assessments/[assessmentId]/follow-up-answers/route.ts', 'lib/server/workflowFollowUpAnswers.ts'].map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const term of ['anthropic', 'claude', 'openai', '@/lib/server/ai', 'forgewingGates', 'reserveForgewing']) expect(source.toLowerCase()).not.toContain(term.toLowerCase());
  });
});

describe('the answer surface', () => {
  const props = { assessmentId: ASSESSMENT_ID, accessToken: 't', onSaved: () => undefined, files: [{ attachmentId: FILE_ID, filename: 'rates.xlsx' }] };

  it('shows open questions with a way to answer them, and says what an answer is', () => {
    const html = renderToStaticMarkup(createElement(FdeFollowUpAnswers, { ...props, answers: [], followUps: buildFdeReadinessPlan(ASSESSMENT)!.followUps }));
    for (const text of ['What tolerance applies?', 'Save answer', 'rates.xlsx', 'become project truth']) expect(html).toContain(text);
  });

  it('shows the newest answer and its provenance, and keeps it revisable', () => {
    const entry = { answerId: 'a', followUpId: FOLLOW_UP!.followUpId, stepId: 's1', question: 'What tolerance applies?', answerSource: 'customer_stated' as const, evidenceAttachmentIds: [], supersedesAnswerId: null, assessmentId: ASSESSMENT_ID, assessmentVersion: 2, answeredBy: 'u', answeredAt: 'now' };
    const html = renderToStaticMarkup(createElement(FdeFollowUpAnswers, { ...props, followUps: [], answers: [{ ...entry, answer: 'Older answer', revision: 1 }, { ...entry, answerId: 'b', answer: 'Newer answer', revision: 2 }] }));
    expect(html).toContain('Newer answer');
    expect(html).not.toContain('Older answer');
    expect(html).toContain('revision 2');
    expect(html).toContain('answered against version 2');
    expect(html).toContain('Save answer');
  });

  it('says so when answers are unavailable, and offers no form', () => {
    const html = renderToStaticMarkup(createElement(FdeFollowUpAnswers, { ...props, answers: null, followUps: buildFdeReadinessPlan(ASSESSMENT)!.followUps }));
    expect(html).toContain('aren&#x27;t available');
    expect(html).not.toContain('<textarea');
  });

  it('renders nothing when nothing is open or answered', () => {
    expect(renderToStaticMarkup(createElement(FdeFollowUpAnswers, { ...props, answers: [], followUps: [] }))).toBe('');
  });
});

describe('boundaries', () => {
  const code = (relative: string) => readFileSync(relative, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name.startsWith('.')) return [];
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full.split(path.sep).join('/')] : [];
    });
  }

  it('only the record seam and the review packet reach answers, so no truth path can', () => {
    const named = /workflow_assessment_follow_up_answers|workflowFollowUpAnswers'/;
    const users = ['app', 'components', 'lib', 'scripts'].flatMap(walk).filter((file) => named.test(code(file)));
    expect(users.sort()).toEqual([
      'app/api/internal/workflow-assessments/[assessmentId]/follow-up-answers/route.ts',
      'app/platform/workflows/reviews/[assessmentId]/page.tsx',
      'components/workflows/FdeFollowUpAnswers.tsx',
      'lib/server/workflowAssessmentReviewRead.ts',
      'lib/server/workflowFollowUpAnswers.ts',
    ]);
  }, 120_000);

  it('the seam appends only, and edits neither the intake nor the assessment', () => {
    const source = code('lib/server/workflowFollowUpAnswers.ts');
    for (const term of ['.update(', '.upsert(', '.delete(', '.rpc(']) expect(source).not.toContain(term);
    const inserted = [...source.matchAll(/\.from\(([^)]+)\)\.insert/g)].map((match) => match[1]);
    expect(inserted).toEqual(['WORKFLOW_FOLLOW_UP_ANSWERS_TABLE']);
  });
});

describe('the migration', () => {
  it('is append-only, server-only and pinned non-authoritative', () => {
    expect(MIGRATION).toContain('ENABLE ROW LEVEL SECURITY');
    expect(MIGRATION).toContain('BEFORE UPDATE OR DELETE ON public.workflow_assessment_follow_up_answers');
    expect(MIGRATION).toContain('BEFORE INSERT ON public.workflow_assessment_follow_up_answers');
    expect(MIGRATION).toContain('GRANT SELECT, INSERT ON TABLE public.workflow_assessment_follow_up_answers TO service_role');
    expect(MIGRATION).not.toMatch(/CREATE POLICY|GRANT [^;]*TO (?:anon|authenticated)/u);
    expect(MIGRATION).toContain("CHECK (authority = 'non_authoritative')");
    expect(MIGRATION).toContain('UNIQUE (source_submission_id, follow_up_id, revision)');
    expect(MIGRATION).toContain('CHECK ((revision = 1) = (supersedes_answer_id IS NULL))');
  });

  it('changes nothing that already exists', () => {
    expect(MIGRATION.replace(/^--.*$/gmu, '')).not.toMatch(/ALTER TABLE (?!public\.workflow_assessment_follow_up_answers)|DROP |UPDATE public\.|DELETE FROM|INSERT INTO/u);
  });
});
