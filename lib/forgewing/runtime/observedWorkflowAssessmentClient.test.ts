import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/ai/claudeClient', () => ({ getClaudeClient: () => ({ messages: { create } }) }));

import { callClaudeForWorkflowAssessment } from '@/lib/forgewing/runtime/client';
import { createObservedWorkflowAssessmentProvider } from '@/lib/forgewing/runtime/observedWorkflowAssessmentClient';

const REQUEST = { model: 'claude-sonnet-4-6', timeoutMs: 15_000, maxOutputTokens: 4_000, inputJson: '{"task":"workflow_assessment"}' };
const message = (stop = 'end_turn') => ({
  id: 'msg_1', _request_id: 'req_1', model: 'claude-sonnet-4-6', stop_reason: stop,
  usage: { input_tokens: 3000, output_tokens: 900 }, content: [{ type: 'text', text: '{"ok":true}' }],
});

afterEach(() => create.mockReset());

describe('observed Workflow Assessment provider (S7)', () => {
  it('sends exactly the production request and returns the same output', async () => {
    create.mockResolvedValue(message());
    const production = await callClaudeForWorkflowAssessment(REQUEST);
    const observer = vi.fn();
    const observed = await createObservedWorkflowAssessmentProvider(observer)(REQUEST);

    expect(observed).toBe(production);
    const [productionBody, productionOptions] = create.mock.calls[0]!;
    const [observedBody, observedOptions] = create.mock.calls[1]!;
    expect(observedBody).toEqual(productionBody);
    const strip = (options: Record<string, unknown>) => ({ ...options, signal: undefined });
    expect(strip(observedOptions)).toEqual(strip(productionOptions));
    expect(observedBody).toMatchObject({ temperature: 0, max_tokens: 4_000 });
    expect(observedOptions).toMatchObject({ timeout: 15_000, maxRetries: 0 });
  });

  it('reports metadata only, and still detects truncation', async () => {
    create.mockResolvedValue(message('max_tokens'));
    const observer = vi.fn();
    await expect(createObservedWorkflowAssessmentProvider(observer)(REQUEST))
      .rejects.toMatchObject({ message: 'provider_truncated_output' });
    const [observation] = observer.mock.calls[0]!;
    expect(observation).toMatchObject({ requestId: 'req_1', returnedModel: 'claude-sonnet-4-6',
      stopReason: 'max_tokens', inputTokens: 3000, outputTokens: 900 });
    expect(JSON.stringify(observation)).not.toContain('"ok":true');
  });

  it('leaves the qualification-frozen client.ts untouched', () => {
    // Pinned whole by the Sonnet 5.5 qualification contract (phase17Sonnet55Run.test.ts).
    const digest = createHash('sha256')
      .update(readFileSync('lib/forgewing/runtime/client.ts', 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    expect(digest).toBe('a2d673c29a4cfa3917557602953e00231f6f2f2056093271f68ebec5088387de');
  });
});
