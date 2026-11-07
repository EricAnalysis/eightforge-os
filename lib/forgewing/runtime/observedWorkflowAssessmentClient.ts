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
  type ForgewingStructuredOutputSchema,
} from '@/lib/forgewing/runtime/client';
import type { ProviderGrammar } from '@/lib/forgewing/runtime/workflowAssessmentStageGrammars';
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
  return callObservedStructured(request, loadObservedWorkflowAssessmentPrompt(), WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA, observer);
}

/**
 * The one observed structured-output call: request built by the shared
 * buildForgewingStructuredOutputRequest, metadata-only observation, explicit
 * abort at request.timeoutMs, and truncation detection that keeps the partial text.
 */
async function callObservedStructured(
  request: ForgewingProviderRequest,
  prompt: string,
  schema: ForgewingStructuredOutputSchema,
  observer: ForgewingProviderObserver,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const startedAt = performance.now();
  const built = buildForgewingStructuredOutputRequest(request, prompt, schema);
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

/** One decomposed-stage call (DECOMPOSITION-PLAN.md, P2). */
export type WorkflowAssessmentStageCall = Readonly<{
  stage: 'A' | 'B';
  /** 0 for stage A; the stage B batch index otherwise. */
  batch: number;
  prompt: string;
  grammar: ProviderGrammar;
}>;
export type WorkflowAssessmentStageProvider = (
  request: ForgewingProviderRequest, call: WorkflowAssessmentStageCall) => Promise<string>;
export type WorkflowAssessmentStageObserver = (
  observation: Parameters<ForgewingProviderObserver>[0],
  call: Pick<WorkflowAssessmentStageCall, 'stage' | 'batch'>) => void;

/**
 * Production stage provider. Same client, request builder, timeout, truncation
 * and observation as the single-call provider; only the prompt and grammar vary.
 * client.ts is frozen whole (Sonnet 5.5 qualification pin), so the stage grammar
 * reaches its builder through a type-only cast (decision D-5): the request body
 * is constructed by the same code with the generated schema in output_config.
 */
export function createObservedWorkflowAssessmentStageProvider(
  observer: WorkflowAssessmentStageObserver,
): WorkflowAssessmentStageProvider {
  return async (request, call) => callObservedStructured(request, call.prompt,
    call.grammar as unknown as ForgewingStructuredOutputSchema,
    (observation) => observer(observation, { stage: call.stage, batch: call.batch }));
}
