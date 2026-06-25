import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('claudeClient', () => {
  it('throws a server-side configuration error when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { getClaudeClient } = await import('@/lib/server/ai/claudeClient');

    assert.throws(
      () => getClaudeClient(),
      /ANTHROPIC_API_KEY is missing on the server/,
    );
  });

  it('uses ANTHROPIC_MODEL with claude-sonnet-4-6 as the default', async () => {
    delete process.env.ANTHROPIC_MODEL;
    const first = await import('@/lib/server/ai/claudeClient');
    assert.equal(first.getClaudeModel(), 'claude-sonnet-4-6');

    vi.resetModules();
    process.env.ANTHROPIC_MODEL = 'claude-custom';
    const second = await import('@/lib/server/ai/claudeClient');
    assert.equal(second.getClaudeModel(), 'claude-custom');
  });
});
