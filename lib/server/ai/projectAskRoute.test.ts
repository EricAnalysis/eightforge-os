import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  askProjectWithClaudeMock,
  buildAskProjectContextMock,
  getActorContextMock,
  getSupabaseAdminMock,
} = vi.hoisted(() => ({
  askProjectWithClaudeMock: vi.fn(),
  buildAskProjectContextMock: vi.fn(),
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
}));

vi.mock('@/lib/server/ai/askProject', () => ({
  askProjectWithClaude: askProjectWithClaudeMock,
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

function mockActor() {
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
});
