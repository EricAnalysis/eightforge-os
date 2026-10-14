import { readFileSync } from 'node:fs';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import {
  buildForgewingStructuredOutputRequest,
  ForgewingProviderOutputError,
  normalizeClaudeProviderError,
  type ForgewingProvider,
  type ForgewingProviderObserver,
  type ForgewingProviderRequest,
} from '@/lib/forgewing/runtime/client';
import { WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA }
  from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';

/**
 * Production observed Workflow Assessment provider (Forgewing S7).
 *
 * client.ts is frozen whole by the Sonnet 5.5 qualification contract, so the
 * observed variant lives here. The request is built by the same exported
 * `buildForgewingStructuredOutputRequest` from the same prompt bytes and
 * schema as `callClaudeForWorkflowAssessment`, so the request is identical;
 * the observer receives response metadata only (ids, model, stop reason, token
 * counts, latency), never content, for the durable telemetry ledger.
 */

export function loadObservedWorkflowAssessmentPrompt(): string {
  return readFileSync(new URL('../prompts/workflowAssessment.md', import.meta.url), 'utf8');
}

async function callObserved(
  request: ForgewingProviderRequest,
  observer: ForgewingProviderObserver,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const startedAt = performance.now();
  const built = buildForgewingStructuredOutputRequest(
    request, loadObservedWorkflowAssessmentPrompt(), WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA);
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

export function createObservedWorkflowAssessmentProvider(
  observer: ForgewingProviderObserver,
): ForgewingProvider {
  return async (request) => callObserved(request, observer);
}
