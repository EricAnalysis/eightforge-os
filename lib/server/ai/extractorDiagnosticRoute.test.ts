import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { generateExtractorDiagnosticMock } = vi.hoisted(() => ({
  generateExtractorDiagnosticMock: vi.fn(),
}));

vi.mock('@/lib/server/ai/extractorDiagnosticAgent', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/ai/extractorDiagnosticAgent')>(
    '@/lib/server/ai/extractorDiagnosticAgent',
  );
  return {
    ...actual,
    generateExtractorDiagnostic: generateExtractorDiagnosticMock,
  };
});

import { POST } from '@/app/api/extractor-diagnostics/route';

const ORIGINAL_ENV = { ...process.env };

function request(body: unknown) {
  return new Request('http://localhost/api/extractor-diagnostics', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  generateExtractorDiagnosticMock.mockReset();
});

describe('POST /api/extractor-diagnostics', () => {
  it('returns 400 when expectedOutput is missing', async () => {
    const response = await POST(request({
      actualOutput: 'actual',
      targetAgent: 'codex',
      requestedMode: 'full-plan',
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'expectedOutput is required' });
    expect(generateExtractorDiagnosticMock).not.toHaveBeenCalled();
  });

  it('returns 400 when actualOutput is missing', async () => {
    const response = await POST(request({
      expectedOutput: 'expected',
      targetAgent: 'codex',
      requestedMode: 'full-plan',
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'actualOutput is required' });
    expect(generateExtractorDiagnosticMock).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid targetAgent', async () => {
    const response = await POST(request({
      expectedOutput: 'expected',
      actualOutput: 'actual',
      targetAgent: 'invalid',
      requestedMode: 'full-plan',
    }));

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /targetAgent must be one of/);
  });

  it('returns 400 for invalid requestedMode', async () => {
    const response = await POST(request({
      expectedOutput: 'expected',
      actualOutput: 'actual',
      targetAgent: 'codex',
      requestedMode: 'invalid',
    }));

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /requestedMode must be one of/);
  });

  it('returns 400 for oversized payloads', async () => {
    const response = await POST(request({
      expectedOutput: 'a'.repeat(60_001),
      actualOutput: 'actual',
      targetAgent: 'codex',
      requestedMode: 'full-plan',
    }));

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Payload must be 60000 characters or fewer/);
    expect(generateExtractorDiagnosticMock).not.toHaveBeenCalled();
  });

  it('returns structured JSON only and never includes ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-route-secret';
    generateExtractorDiagnosticMock.mockResolvedValue({
      failureClassification: ['classification failure'],
      confidence: 'medium',
      discrepancyMatrix: [],
      likelyFailingLayer: 'classification',
      evidenceNeeded: [],
      recommendedMode: 'full-plan',
      implementationPrompt: 'Phase A - Audit',
      stopConditions: [],
      regressionGates: [],
      prBoundary: 'diagnostic only',
      limitations: [],
    });

    const response = await POST(request({
      expectedOutput: 'expected',
      actualOutput: 'actual',
      targetAgent: 'codex',
      requestedMode: 'full-plan',
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.failureClassification, ['classification failure']);
    assert.equal(JSON.stringify(body).includes('sk-ant-route-secret'), false);
    expect(generateExtractorDiagnosticMock).toHaveBeenCalledWith(expect.objectContaining({
      expectedOutput: 'expected',
      actualOutput: 'actual',
      targetAgent: 'codex',
      requestedMode: 'full-plan',
    }));
  });

  it('fails server-side without exposing ANTHROPIC_API_KEY when Claude is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    generateExtractorDiagnosticMock.mockRejectedValue(
      new Error('Claude is not configured: ANTHROPIC_API_KEY is missing on the server.'),
    );

    const response = await POST(request({
      expectedOutput: 'expected',
      actualOutput: 'actual',
      targetAgent: 'codex',
      requestedMode: 'full-plan',
    }));

    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, {
      error: 'AI assistance is not configured.',
      code: 'ai_not_configured',
    });
    assert.equal(JSON.stringify(body).includes('ANTHROPIC_API_KEY'), false);
  });
});
