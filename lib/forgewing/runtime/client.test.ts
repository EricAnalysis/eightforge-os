import { beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/ai/claudeClient', () => ({
  getClaudeClient: () => ({ messages: { create: messagesCreate } }),
}));

import {
  callClaudeForColumnMapping,
  callClaudeForObservationArbitration,
  callClaudeForPricingInterpretation,
  callClaudeForRegionClassification,
  callClaudeForTableContinuation,
  ForgewingProviderOutputError,
  loadPricingInterpretationPrompt,
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

  it('sends the schema-adjacent pricing field rule in the actual provider prompt', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"rowInterpretationState":"insufficient_evidence"}' }],
      stop_reason: 'end_turn',
    });
    await callClaudeForPricingInterpretation({ model: 'claude-test', timeoutMs: 500,
      maxOutputTokens: 2_000, inputJson: '{"rowObservation":{}}' });
    const prompt = loadPricingInterpretationPrompt();
    expect(prompt).toContain('missingEvidence MUST NOT appear');
    expect(prompt).toContain('The property must be omitted');
    expect(prompt).toContain('rowInterpretationState":"ambiguous"');
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: 2_000, system: prompt,
    }), expect.objectContaining({ maxRetries: 0 }));
  });

  it('classifies pricing max-token termination as truncation and preserves raw output', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"rowInterpretationState":"ambiguous"' }],
      stop_reason: 'max_tokens',
    });
    const error = await callClaudeForPricingInterpretation({ model: 'claude-test', timeoutMs: 500,
      maxOutputTokens: 2_000, inputJson: '{"rowObservation":{}}' }).catch((value) => value);
    expect(error).toBeInstanceOf(ForgewingProviderOutputError);
    expect(error).toMatchObject({ message: 'provider_truncated_output',
      rawOutput: '{"rowInterpretationState":"ambiguous"' });
  });

  it('reuses the Claude adapter with the dedicated continuation prompt and schema', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"state":"ambiguous"}' }],
    });
    await expect(callClaudeForTableContinuation({
      model: 'claude-test',
      timeoutMs: 500,
      maxOutputTokens: 800,
      inputJson: '{"priorSegment":{},"nextSegment":{}}',
    })).resolves.toBe('{"state":"ambiguous"}');
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-test',
        max_tokens: 800,
        system: expect.stringContaining('physically adjacent table segments'),
        output_config: {
          format: expect.objectContaining({
            type: 'json_schema',
            schema: expect.objectContaining({
              properties: expect.objectContaining({
                relation: expect.objectContaining({
                  enum: ['same_table', 'separate_tables', 'ambiguous'],
                }),
              }),
            }),
          }),
        },
      }),
      expect.objectContaining({ timeout: 500, maxRetries: 0, signal: expect.any(AbortSignal) }),
    );
  });

  it('reuses the Claude adapter with the dedicated column-mapping prompt and schema', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"columnMappings":[]}' }],
    });
    await expect(callClaudeForColumnMapping({
      model: 'claude-test',
      timeoutMs: 500,
      maxOutputTokens: 800,
      inputJson: '{"table":{},"columns":[]}',
    })).resolves.toBe('{"columnMappings":[]}');
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-test',
        max_tokens: 800,
        system: expect.stringContaining('non-authoritative semantic column-mapping observer'),
        output_config: {
          format: expect.objectContaining({
            type: 'json_schema',
            schema: expect.objectContaining({
              properties: expect.objectContaining({
                columnMappings: expect.objectContaining({ maxItems: 12 }),
              }),
            }),
          }),
        },
      }),
      expect.objectContaining({ timeout: 500, maxRetries: 0, signal: expect.any(AbortSignal) }),
    );
  });

  it('reuses the Claude adapter with the dedicated observation-arbitration prompt and schema', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"state":"insufficient_evidence"}' }],
    });
    await expect(callClaudeForObservationArbitration({
      model: 'claude-test', timeoutMs: 500, maxOutputTokens: 800, inputJson: '{"target":{}}',
    })).resolves.toBe('{"state":"insufficient_evidence"}');
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-test',
        max_tokens: 800,
        system: expect.stringContaining('competing extraction observations'),
        output_config: { format: expect.objectContaining({
          type: 'json_schema',
          schema: expect.objectContaining({ properties: expect.objectContaining({
            relation: expect.objectContaining({ enum: [
              'prefer_candidate_a', 'prefer_candidate_b', 'preserve_both',
              'genuinely_conflicting',
            ] }),
          }) }),
        }) },
      }),
      expect.objectContaining({ timeout: 500, maxRetries: 0, signal: expect.any(AbortSignal) }),
    );
  });
});
