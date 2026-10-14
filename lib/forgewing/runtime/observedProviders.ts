import { readFileSync } from 'node:fs';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import {
  buildForgewingStructuredOutputRequest,
  ForgewingProviderOutputError,
  loadPricingInterpretationPrompt,
  loadRecoveryCandidateV2Prompt,
  normalizeClaudeProviderError,
  type ForgewingProvider,
  type ForgewingProviderObserver,
  type ForgewingProviderRequest,
  type ForgewingStructuredOutputSchema,
} from '@/lib/forgewing/runtime/client';
import {
  COLUMN_MAPPING_OUTPUT_JSON_SCHEMA,
  OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA,
  PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
  RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA,
  REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA,
  TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA,
} from '@/lib/forgewing/runtime/structuredOutput';

/**
 * Production observed providers for the extraction shadow and recovery tasks
 * (telemetry extension of S7).
 *
 * client.ts is frozen whole by a qualification contract, so these live here.
 * Each one sends exactly the request its client.ts counterpart sends: the same
 * exported request builder, the same prompt bytes, the same schema and the
 * same truncation rule (tests prove request identity task by task). The
 * observer receives response metadata only, never content.
 */

const prompt = (file: string) => () => readFileSync(new URL(`../prompts/${file}`, import.meta.url), 'utf8');

export const OBSERVED_PROVIDER_TASKS = Object.freeze({
  region_classification: { load: prompt('regionClassification.md'), schema: REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA, detectTruncation: false },
  table_continuation: { load: prompt('tableContinuation.md'), schema: TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA, detectTruncation: false },
  column_mapping: { load: prompt('columnMapping.md'), schema: COLUMN_MAPPING_OUTPUT_JSON_SCHEMA, detectTruncation: false },
  observation_arbitration: { load: prompt('observationArbitration.md'), schema: OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA, detectTruncation: false },
  pricing_interpretation: { load: loadPricingInterpretationPrompt, schema: PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA, detectTruncation: true },
  recovery_candidate_v2: { load: loadRecoveryCandidateV2Prompt, schema: RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA, detectTruncation: true },
} satisfies Record<string, Readonly<{ load: () => string; schema: ForgewingStructuredOutputSchema; detectTruncation: boolean }>>);

export type ObservedProviderTask = keyof typeof OBSERVED_PROVIDER_TASKS;

async function callObserved(
  task: ObservedProviderTask,
  request: ForgewingProviderRequest,
  observer: ForgewingProviderObserver,
): Promise<string> {
  const spec = OBSERVED_PROVIDER_TASKS[task];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const startedAt = performance.now();
  const built = buildForgewingStructuredOutputRequest(request, spec.load(), spec.schema);
  try {
    const message = await getClaudeClient().messages.create(built.body, {
      signal: controller.signal,
      ...built.options,
    });
    observer({
      systemPromptSha256: sha256Hex(built.body.system),
      messageId: typeof message.id === 'string' ? message.id : null,
      requestId: typeof (message as { _request_id?: unknown })._request_id === 'string'
        ? (message as { _request_id: string })._request_id : null,
      returnedModel: typeof message.model === 'string' ? message.model : null,
      stopReason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
      inputTokens: typeof message.usage?.input_tokens === 'number' ? message.usage.input_tokens : null,
      outputTokens: typeof message.usage?.output_tokens === 'number' ? message.usage.output_tokens : null,
      latencyMs: performance.now() - startedAt,
    });
    const rawOutput = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (spec.detectTruncation && message.stop_reason === 'max_tokens') {
      throw new ForgewingProviderOutputError('provider_truncated_output', rawOutput);
    }
    return rawOutput;
  } catch (error) {
    throw normalizeClaudeProviderError(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

export function createObservedForgewingProvider(
  task: ObservedProviderTask,
  observer: ForgewingProviderObserver,
): ForgewingProvider {
  return async (request) => callObserved(task, request, observer);
}
