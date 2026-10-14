import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/ai/claudeClient', () => ({ getClaudeClient: () => ({ messages: { create } }) }));

import {
  callClaudeForColumnMapping,
  callClaudeForObservationArbitration,
  callClaudeForPricingInterpretation,
  callClaudeForRecoveryCandidateV2,
  callClaudeForRegionClassification,
  callClaudeForTableContinuation,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';
import {
  createObservedForgewingProvider,
  OBSERVED_PROVIDER_TASKS,
  type ObservedProviderTask,
} from '@/lib/forgewing/runtime/observedProviders';

const REQUEST = { model: 'claude-sonnet-4-6', timeoutMs: 3_000, maxOutputTokens: 800, inputJson: '{"probe":true}' };
const message = (stop = 'end_turn') => ({
  id: 'msg_1', _request_id: 'req_1', model: 'claude-sonnet-4-6', stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: '{"ok":true}' }],
});
const PRODUCTION: Record<ObservedProviderTask, ForgewingProvider> = {
  region_classification: callClaudeForRegionClassification,
  table_continuation: callClaudeForTableContinuation,
  column_mapping: callClaudeForColumnMapping,
  observation_arbitration: callClaudeForObservationArbitration,
  pricing_interpretation: callClaudeForPricingInterpretation,
  recovery_candidate_v2: callClaudeForRecoveryCandidateV2,
};
const strip = (options: Record<string, unknown>) => ({ ...options, signal: undefined });

afterEach(() => create.mockReset());

describe('observed Forgewing providers (telemetry)', () => {
  it.each(Object.keys(OBSERVED_PROVIDER_TASKS) as ObservedProviderTask[])(
    '%s sends exactly the production request and returns the same output', async (task) => {
      create.mockResolvedValue(message());
      const production = await PRODUCTION[task](REQUEST);
      const observer = vi.fn();
      const observed = await createObservedForgewingProvider(task, observer)(REQUEST);
      expect(observed).toBe(production);
      const [productionBody, productionOptions] = create.mock.calls[0]!;
      const [observedBody, observedOptions] = create.mock.calls[1]!;
      expect(observedBody).toEqual(productionBody);
      expect(strip(observedOptions)).toEqual(strip(productionOptions));
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req_1', inputTokens: 10, outputTokens: 5 }));
      expect(JSON.stringify(observer.mock.calls[0]![0])).not.toContain('"ok":true');
    });

  it.each(Object.keys(OBSERVED_PROVIDER_TASKS) as ObservedProviderTask[])(
    '%s applies the same truncation rule as production', async (task) => {
      create.mockResolvedValue(message('max_tokens'));
      const production = await PRODUCTION[task](REQUEST).then(() => 'ok', (error: Error) => error.message);
      const observed = await createObservedForgewingProvider(task, vi.fn())(REQUEST).then(() => 'ok', (error: Error) => error.message);
      expect(observed).toBe(production);
    });

  it('leaves the qualification-frozen client.ts untouched', () => {
    const digest = createHash('sha256')
      .update(readFileSync('lib/forgewing/runtime/client.ts', 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    expect(digest).toBe('a2d673c29a4cfa3917557602953e00231f6f2f2056093271f68ebec5088387de');
  });
});
