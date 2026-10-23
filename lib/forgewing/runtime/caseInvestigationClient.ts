import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import {
  ForgewingProviderOutputError,
  normalizeClaudeProviderError,
} from '@/lib/forgewing/runtime/client';

/**
 * Claude adapter for Forgewing case investigation (P3b).
 *
 * Constructed only by the authenticated investigation route, and only for a
 * model in FORGEWING_QUALIFIED_MODELS. The runner applies every gate (case
 * kind, data policy, entitlement, qualification ceiling, durable budget)
 * before this adapter can be called, and validates what it returns (offered
 * actions only, cited records only, no invented numbers). The answer is a
 * non-authoritative explanation; it writes nothing and decides nothing.
 *
 * Self-contained: client.ts is frozen whole by a qualification contract.
 * Same request discipline: temperature 0, zero retries, a hard timeout,
 * truncation is an error, a refusal is a provider failure.
 */

export const CASE_INVESTIGATION_EXECUTION = Object.freeze({
  timeoutMs: 30_000,
  maxOutputTokens: 1_500,
});

/**
 * Mirrors the runner's strict output schema (caseInvestigationRunner.ts). Structured outputs
 * reject length constraints, so the runner's bounds travel in the system prompt instead.
 */
export const CASE_INVESTIGATION_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['diagnosis', 'rankedActionKinds', 'rationale', 'citations'],
  properties: {
    diagnosis: { type: 'string' },
    rankedActionKinds: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
    /** Letter refs from each context slice's `cite` map; the runner resolves them to records. */
    citations: { type: 'array', items: { type: 'string' } },
  },
} as const);

export type CaseInvestigationRequest = Readonly<{
  system: string;
  context: unknown;
  offeredActionKinds: readonly string[];
}>;

export function buildCaseInvestigationMessagesRequest(model: string, request: CaseInvestigationRequest) {
  if (!model.trim()) throw new Error('provider_model_missing');
  return {
    body: {
      model,
      temperature: 0,
      max_tokens: CASE_INVESTIGATION_EXECUTION.maxOutputTokens,
      system: request.system,
      messages: [{
        role: 'user' as const,
        content: JSON.stringify({ offered_action_kinds: request.offeredActionKinds, context: request.context }),
      }],
      output_config: { format: { type: 'json_schema' as const, schema: CASE_INVESTIGATION_OUTPUT_JSON_SCHEMA } },
    },
    options: { timeout: CASE_INVESTIGATION_EXECUTION.timeoutMs, maxRetries: 0 },
  };
}

type MessagesClient = Readonly<{
  messages: Readonly<{
    create(body: ReturnType<typeof buildCaseInvestigationMessagesRequest>['body'],
      options: ReturnType<typeof buildCaseInvestigationMessagesRequest>['options'] & { signal: AbortSignal }): Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
      stop_reason?: string | null;
    }>;
  }>;
}>;

export function createClaudeCaseInvestigationProvider(config: Readonly<{
  model: string;
  /** Tests inject a fake; production uses the shared server client. */
  client?: () => MessagesClient;
}>) {
  const client = config.client ?? (() => getClaudeClient() as unknown as MessagesClient);
  return {
    providerModel: config.model,
    async investigate(request: CaseInvestigationRequest): Promise<string> {
      const built = buildCaseInvestigationMessagesRequest(config.model, request);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), built.options.timeout);
      try {
        const message = await client().messages.create(built.body, { ...built.options, signal: controller.signal });
        const raw = message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
        if (message.stop_reason === 'max_tokens') throw new ForgewingProviderOutputError('provider_truncated_output', raw);
        if (message.stop_reason === 'refusal') throw new Error('provider_refusal');
        return raw;
      } catch (error) {
        throw normalizeClaudeProviderError(error, controller.signal.aborted);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
