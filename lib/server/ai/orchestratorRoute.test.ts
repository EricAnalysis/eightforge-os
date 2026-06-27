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
      body: JSON.stringify({ question: 'anything' }),
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
      body: JSON.stringify({ question: 'anything' }),
    }));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  });

  it('returns 400 when question input is missing', async () => {
    setNodeEnv('development');
    mockAccess();

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({ question: '   ' }),
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'question is required' });
    expect(runOrchestratorMock).not.toHaveBeenCalled();
  });

  it('rejects overly long questions', async () => {
    setNodeEnv('development');
    mockAccess();

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({ question: 'a'.repeat(20_001) }),
    }));

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /20000 characters or fewer/);
    assert.match(body.error, /question/);
  });

  it('rejects invalid root cause category keys', async () => {
    setNodeEnv('development');
    mockAccess();

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({
        question: 'UI totals drift',
        rootCauseCategory: 'invented_category',
      }),
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'rootCauseCategory must be one of the fixed orchestrator taxonomy keys',
    });
    expect(runOrchestratorMock).not.toHaveBeenCalled();
  });

  it('returns answer text, legacy prompt alias, model, and repo-relative file path only', async () => {
    setNodeEnv('development');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-test-key';
    process.env.UNRELATED_SECRET = 'do-not-return';
    mockAccess();
    runOrchestratorMock.mockResolvedValue({
      answer: 'Doctrine answer',
      generatedPrompt: 'Doctrine answer',
      model: 'claude-sonnet-4-6',
    });
    writeOrchestratorPromptFileMock.mockResolvedValue({
      relativePath: 'docs/prompts/2026-06-25-ui-totals-drift.md',
    });

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({
        question: 'UI totals drift',
        rootCauseCategory: 'ui_consumption_issue',
      }),
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      answer: 'Doctrine answer',
      generatedPrompt: 'Doctrine answer',
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
      question: 'UI totals drift',
      answer: 'Doctrine answer',
      rootCauseCategory: 'ui_consumption_issue',
    }));
  });

  it('accepts legacy diagnostic input while returning the dual response shape', async () => {
    setNodeEnv('development');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-test-key';
    mockAccess();
    runOrchestratorMock.mockResolvedValue({
      answer: 'Legacy-compatible answer',
      generatedPrompt: 'Legacy-compatible answer',
      model: 'claude-sonnet-4-6',
    });
    writeOrchestratorPromptFileMock.mockResolvedValue({
      relativePath: 'docs/prompts/2026-06-25-legacy-diagnostic.md',
    });

    const response = await POST(new Request('http://localhost/api/internal/orchestrator', {
      method: 'POST',
      body: JSON.stringify({ diagnostic: 'Legacy diagnostic' }),
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      answer: 'Legacy-compatible answer',
      generatedPrompt: 'Legacy-compatible answer',
      model: 'claude-sonnet-4-6',
      filePath: 'docs/prompts/2026-06-25-legacy-diagnostic.md',
    });
    expect(runOrchestratorMock).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Legacy diagnostic',
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
      body: JSON.stringify({ question: 'AI client unavailable' }),
    }));

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'AI assistance is not configured.',
      code: 'ai_not_configured',
    });
    expect(writeOrchestratorPromptFileMock).not.toHaveBeenCalled();
  });
});
