import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  askProjectWithClaudeMock,
  buildAskProjectContextMock,
  getActorContextMock,
  getSupabaseAdminMock,
  eligibilityMock,
  reserveMock,
} = vi.hoisted(() => ({
  askProjectWithClaudeMock: vi.fn(),
  buildAskProjectContextMock: vi.fn(),
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  eligibilityMock: vi.fn(),
  reserveMock: vi.fn(),
}));

vi.mock('@/lib/server/forgewingGates', () => ({
  resolveForgewingWorkflowEligibility: eligibilityMock,
  reserveForgewingProviderCall: reserveMock,
}));

vi.mock('@/lib/server/ai/askProject', () => ({
  askProjectWithClaude: askProjectWithClaudeMock,
  ASK_PROJECT_CLAUDE_SYSTEM_PROMPT: 'system prompt',
}));

vi.mock('@/lib/server/ai/askProjectContext', () => ({
  buildAskProjectContext: buildAskProjectContextMock,
}));

vi.mock('@/lib/server/getActorContext', () => ({
  getActorContext: getActorContextMock,
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

import { POST } from '@/app/api/projects/[id]/ask/route';

const ORIGINAL_ENV = { ...process.env };

function mockGates(params: { eligible?: boolean; reservation?: 'reserved' | 'budget_exhausted' | 'failed' } = {}) {
  eligibilityMock.mockResolvedValue(params.eligible === false
    ? { eligible: false, reason: 'data_policy_not_approved' }
    : { eligible: true, entitlementEventId: 'e-1', dataPolicyEventIds: ['d-1'], dailyCap: 5 });
  const status = params.reservation ?? 'reserved';
  reserveMock.mockResolvedValue(status === 'reserved' ? { status, reservationId: 'r-1', usedInWindow: 1 }
    : status === 'budget_exhausted' ? { status, usedInWindow: 5 } : { status });
}

function mockActor() {
  mockGates();
  getActorContextMock.mockResolvedValue({
    ok: true,
    actor: {
      actorId: 'user-1',
      organizationId: 'org-1',
      displayName: 'Operator',
      role: 'admin',
    },
  });
}

function mockAdmin(project = {
  id: 'project-1',
  name: 'Williamson',
  validation_status: 'BLOCKED',
  validation_summary_json: null,
}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: project, error: null });
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle,
  };
  const admin = {
    from: vi.fn(() => query),
  };
  getSupabaseAdminMock.mockReturnValue(admin);
  return { admin, query };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  askProjectWithClaudeMock.mockReset();
  buildAskProjectContextMock.mockReset();
  getActorContextMock.mockReset();
  getSupabaseAdminMock.mockReset();
  eligibilityMock.mockReset();
  reserveMock.mockReset();
});

describe('POST /api/projects/[id]/ask', () => {
  it('returns 400 when question is missing', async () => {
    mockActor();

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ask', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'question is required' });
    expect(getSupabaseAdminMock).not.toHaveBeenCalled();
  });

  it('returns answer and model only on success', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    mockActor();
    mockAdmin();
    buildAskProjectContextMock.mockResolvedValue({
      project: { id: 'project-1' },
      scope: { projectId: 'project-1' },
    });
    askProjectWithClaudeMock.mockResolvedValue({
      answer: 'Read-only explanation.',
      model: 'claude-sonnet-4-6',
    });

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ask', {
        method: 'POST',
        body: JSON.stringify({ question: 'Explain the blockers' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      answer: 'Read-only explanation.',
      model: 'claude-sonnet-4-6',
    });
  });

  it('does not expose ANTHROPIC_API_KEY in API errors', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-test-key';
    mockActor();
    mockAdmin();
    buildAskProjectContextMock.mockResolvedValue({
      project: { id: 'project-1' },
      scope: { projectId: 'project-1' },
    });
    askProjectWithClaudeMock.mockRejectedValue(
      new Error('provider failed with sk-ant-secret-test-key'),
    );

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ask', {
        method: 'POST',
        body: JSON.stringify({ question: 'Explain the blockers' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    assert.equal(response.status, 500);
    const bodyText = JSON.stringify(await response.json());
    assert.equal(bodyText.includes('sk-ant-secret-test-key'), false);
  });

  it('returns a stable not-configured code with operator-safe copy when Claude is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mockActor();
    mockAdmin();
    buildAskProjectContextMock.mockResolvedValue({
      project: { id: 'project-1' },
      scope: { projectId: 'project-1' },
    });
    askProjectWithClaudeMock.mockRejectedValue(
      new Error('Claude is not configured: ANTHROPIC_API_KEY is missing on the server.'),
    );

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/ask', {
        method: 'POST',
        body: JSON.stringify({ question: 'Explain the blockers' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'AI assistance is not configured.',
      code: 'ai_not_configured',
    });
  });

  const ask = () => POST(
    new Request('http://localhost/api/projects/project-1/ask', {
      method: 'POST',
      body: JSON.stringify({ question: 'Explain the blockers' }),
    }),
    { params: Promise.resolve({ id: 'project-1' }) },
  );

  it('asks the shared Forgewing gates for the project_ask workflow, sending text only', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    mockActor();
    mockAdmin();
    buildAskProjectContextMock.mockResolvedValue({ project: { id: 'project-1' }, scope: { projectId: 'project-1' } });
    askProjectWithClaudeMock.mockResolvedValue({ answer: 'ok', model: 'm' });
    assert.equal((await ask()).status, 200);
    expect(eligibilityMock).toHaveBeenCalledWith(expect.anything(),
      { organizationId: 'org-1', workflow: 'project_ask', contentClasses: ['text_excerpts'] });
    expect(reserveMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      organizationId: 'org-1', workflow: 'project_ask', dailyCap: 5, reservedBy: 'user-1',
      requestDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    }));
  });

  it('refuses before reading any project context when a gate is closed', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    mockActor();
    mockGates({ eligible: false });
    mockAdmin();
    const response = await ask();
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'AI assistance is not enabled for this organization.',
      code: 'forgewing_not_permitted', reason: 'data_policy_not_approved' });
    expect(buildAskProjectContextMock).not.toHaveBeenCalled();
    expect(askProjectWithClaudeMock).not.toHaveBeenCalled();
  });

  it('makes no provider call when the durable budget is spent or cannot be reserved', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    for (const [reservation, status] of [['budget_exhausted', 429], ['failed', 503]] as const) {
      mockActor();
      mockGates({ reservation });
      mockAdmin();
      buildAskProjectContextMock.mockResolvedValue({ project: { id: 'project-1' }, scope: { projectId: 'project-1' } });
      assert.equal((await ask()).status, status);
    }
    expect(askProjectWithClaudeMock).not.toHaveBeenCalled();
  });

  it('spends no budget when the provider is not configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mockActor();
    mockAdmin();
    assert.equal((await ask()).status, 500);
    expect(reserveMock).not.toHaveBeenCalled();
  });
});
