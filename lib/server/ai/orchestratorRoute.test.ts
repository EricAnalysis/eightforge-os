import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getInternalOrchestratorAccessMock,
  runOrchestratorMock,
  writeOrchestratorPromptFileMock,
} = vi.hoisted(() => ({
  getInternalOrchestratorAccessMock: vi.fn(),
  runOrchestratorMock: vi.fn(),
  writeOrchestratorPromptFileMock: vi.fn(),
}));

vi.mock('@/lib/server/internalOrchestratorAccess', () => ({
  getInternalOrchestratorAccess: getInternalOrchestratorAccessMock,
}));

vi.mock('@/lib/server/ai/runOrchestrator', () => ({
  runOrchestrator: runOrchestratorMock,
}));

vi.mock('@/lib/server/ai/orchestratorPromptFiles', () => ({
  writeOrchestratorPromptFile: writeOrchestratorPromptFileMock,
}));

import { POST } from '@/app/api/internal/orchestrator/route';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string) {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function mockAccess() {
  getInternalOrchestratorAccessMock.mockResolvedValue({
    ok: true,
    userId: 'user-1',
    email: 'admin@example.com',
    role: 'admin',
  });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
  getInternalOrchestratorAccessMock.mockReset();
  runOrchestratorMock.mockReset();
  writeOrchestratorPromptFileMock.mockReset();
});

describe('POST /api/internal/orchestrator', () => {
  it('returns 404 in production before auth', async () => {
    setNodeEnv('production');

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({ diagnostic: 'anything' }),
    }));

    assert.equal(response.status, 404);
    expect(getInternalOrchestratorAccessMock).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests outside production', async () => {
    setNodeEnv('development');
    getInternalOrchestratorAccessMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: 'Unauthorized',
    });

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({ diagnostic: 'anything' }),
    }));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  });

  it('returns 400 when question input is missing', async () => {
    setNodeEnv('development');
    mockAccess();

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({ diagnostic: '   ' }),
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'question is required' });
    expect(runOrchestratorMock).not.toHaveBeenCalled();
  });

  it('rejects overly long diagnostics', async () => {
    setNodeEnv('development');
    mockAccess();

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({ diagnostic: 'a'.repeat(20_001) }),
    }));

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /20000 characters or fewer/);
  });

  it('accepts a general question without a root cause category', async () => {
    setNodeEnv('development');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-test-key';
    mockAccess();
    runOrchestratorMock.mockResolvedValue({
      generatedPrompt: 'Decisions capture approved intent; execution items track operational work.',
      model: 'claude-sonnet-4-6',
    });
    writeOrchestratorPromptFileMock.mockResolvedValue({
      relativePath: 'docs/prompts/2026-06-25-whats-the-difference-between-a-decision.md',
    });

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({
        question: "What's the difference between a decision and an execution item in EightForge?",
      }),
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      generatedPrompt: 'Decisions capture approved intent; execution items track operational work.',
      model: 'claude-sonnet-4-6',
      filePath: 'docs/prompts/2026-06-25-whats-the-difference-between-a-decision.md',
    });
    expect(runOrchestratorMock).toHaveBeenCalledWith(expect.objectContaining({
      question: "What's the difference between a decision and an execution item in EightForge?",
      structuredFields: expect.objectContaining({ rootCauseCategory: undefined }),
    }));
    expect(writeOrchestratorPromptFileMock).toHaveBeenCalledWith(expect.objectContaining({
      diagnostic: "What's the difference between a decision and an execution item in EightForge?",
      rootCauseCategory: undefined,
    }));
  });

  it('rejects invalid root cause category keys', async () => {
    setNodeEnv('development');
    mockAccess();

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({
        diagnostic: 'UI totals drift',
        rootCauseCategory: 'invented_category',
      }),
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'rootCauseCategory must be one of the fixed orchestrator taxonomy keys',
    });
    expect(runOrchestratorMock).not.toHaveBeenCalled();
  });

  it('returns prompt text, model, and repo-relative file path only', async () => {
    setNodeEnv('development');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-test-key';
    process.env.UNRELATED_SECRET = 'do-not-return';
    mockAccess();
    runOrchestratorMock.mockResolvedValue({
      generatedPrompt: 'Phase A - Audit',
      model: 'claude-sonnet-4-6',
    });
    writeOrchestratorPromptFileMock.mockResolvedValue({
      relativePath: 'docs/prompts/2026-06-25-ui-totals-drift.md',
    });

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({
        diagnostic: 'UI totals drift',
        rootCauseCategory: 'ui_consumption_issue',
      }),
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      generatedPrompt: 'Phase A - Audit',
      model: 'claude-sonnet-4-6',
      filePath: 'docs/prompts/2026-06-25-ui-totals-drift.md',
    });
    const bodyText = JSON.stringify(body);
    assert.equal(bodyText.includes('sk-ant-secret-test-key'), false);
    assert.equal(bodyText.includes('do-not-return'), false);
    expect(runOrchestratorMock).toHaveBeenCalledWith(expect.objectContaining({
      question: 'UI totals drift',
      structuredFields: expect.objectContaining({ rootCauseCategory: 'ui_consumption_issue' }),
    }));
    expect(writeOrchestratorPromptFileMock).toHaveBeenCalledWith(expect.objectContaining({
      rootCauseCategory: 'ui_consumption_issue',
    }));
  });

  it('returns a stable not-configured code with operator-safe copy when Claude is missing', async () => {
    setNodeEnv('development');
    delete process.env.ANTHROPIC_API_KEY;
    mockAccess();
    runOrchestratorMock.mockRejectedValue(
      new Error('Claude is not configured: ANTHROPIC_API_KEY is missing on the server.'),
    );

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({ diagnostic: 'AI client unavailable' }),
    }));

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'AI assistance is not configured.',
      code: 'ai_not_configured',
    });
    expect(writeOrchestratorPromptFileMock).not.toHaveBeenCalled();
  });
});
