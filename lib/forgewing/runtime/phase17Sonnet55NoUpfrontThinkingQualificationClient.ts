import { sha256Hex } from '@/lib/extraction/domain/hash';
import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import {
  ForgewingProviderOutputError,
  loadRecoveryCandidateV2Prompt,
  normalizeClaudeProviderError,
  type ForgewingProvider,
  type ForgewingProviderObservation,
  type ForgewingProviderObserver,
  type ForgewingProviderRequest,
} from '@/lib/forgewing/runtime/client';
import { RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA }
  from '@/lib/forgewing/runtime/structuredOutput';

/**
 * Evaluation-only Sonnet 5.5 request seam for the additive Phase 17 contract.
 * Production Forgewing continues to use client.ts and its frozen temperature: 0
 * request. The marked region is source-pinned by the v2 qualification harness.
 */

// phase17-sonnet-55-request-contract:begin
export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_OUTPUT_SCHEMA = Object.freeze({
  ...RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA,
  properties: Object.freeze({
    ...RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA.properties,
    confidence: Object.freeze({ type: 'number' as const }),
  }),
});
export function buildPhase17Sonnet55NoUpfrontThinkingStructuredOutputRequest(
  request: ForgewingProviderRequest,
  prompt: string,
) {
  return {
    body: {
      model: request.model,
      thinking: { type: 'between_tools' as const },
      max_tokens: request.maxOutputTokens,
      system: prompt,
      messages: [{ role: 'user' as const, content: request.inputJson }],
      output_config: {
        format: {
          type: 'json_schema' as const,
          schema: PHASE17_SONNET_55_NO_UPFRONT_THINKING_OUTPUT_SCHEMA,
        },
      },
    },
    options: {
      timeout: request.timeoutMs,
      maxRetries: 0,
    },
  };
}

async function callPhase17Sonnet55NoUpfrontThinking(
  request: ForgewingProviderRequest,
  observer: ForgewingProviderObserver,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const startedAt = performance.now();
  const built = buildPhase17Sonnet55NoUpfrontThinkingStructuredOutputRequest(
    request,
    loadRecoveryCandidateV2Prompt(),
  );
  try {
    // SDK 0.78 typings predate provider-supported between_tools, as in B4.6.1 v3.
    const message = await getClaudeClient().messages.create(built.body as never, {
      signal: controller.signal,
      ...built.options,
    });
    const observation: ForgewingProviderObservation = {
      systemPromptSha256: sha256Hex(built.body.system),
      messageId: typeof message.id === 'string' ? message.id : null,
      requestId: typeof (message as { _request_id?: unknown })._request_id === 'string'
        ? (message as { _request_id: string })._request_id : null,
      returnedModel: typeof message.model === 'string' ? message.model : null,
      stopReason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
      inputTokens: typeof message.usage?.input_tokens === 'number' ? message.usage.input_tokens : null,
      outputTokens: typeof message.usage?.output_tokens === 'number'
        ? message.usage.output_tokens : null,
      latencyMs: performance.now() - startedAt,
    };
    observer(observation);
    const rawOutput = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (message.stop_reason === 'max_tokens') {
      throw new ForgewingProviderOutputError('provider_truncated_output', rawOutput);
    }
    return rawOutput;
  } catch (error) {
    throw normalizeClaudeProviderError(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}
// phase17-sonnet-55-request-contract:end

export function createObservedPhase17Sonnet55NoUpfrontThinkingEvaluationProvider(
  observer: ForgewingProviderObserver,
): ForgewingProvider {
  return async (request) => callPhase17Sonnet55NoUpfrontThinking(request, observer);
}


