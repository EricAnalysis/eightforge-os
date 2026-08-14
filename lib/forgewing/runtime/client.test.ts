import { beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/ai/claudeClient', () => ({
  getClaudeClient: () => ({ messages: { create: messagesCreate } }),
}));

import {
  callClaudeForRegionClassification,
  normalizeClaudeProviderError,
} from '@/lib/forgewing/runtime/client';

describe('Forgewing Claude adapter', () => {
  beforeEach(() => messagesCreate.mockReset());

  it('loads the versioned prompt and requests strict JSON with retries disabled', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"state":"unresolved"}' }],
    });
    await expect(callClaudeForRegionClassification({
      model: 'claude-test',
      timeoutMs: 500,
      maxOutputTokens: 800,
      inputJson: '{"target":{}}',
    })).resolves.toBe('{"state":"unresolved"}');
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-test',
        max_tokens: 800,
        system: expect.stringContaining('non-authoritative region-classification observer'),
        output_config: { format: expect.objectContaining({ type: 'json_schema' }) },
      }),
      expect.objectContaining({ timeout: 500, maxRetries: 0, signal: expect.any(AbortSignal) }),
    );
  });

  it('normalizes the Anthropic SDK timeout class', () => {
    class APIConnectionTimeoutError extends Error {}
    expect(normalizeClaudeProviderError(
      new APIConnectionTimeoutError('Request timed out'),
      false,
    ).message).toBe('provider_timeout');
  });
});
