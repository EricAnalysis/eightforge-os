import { readFileSync } from 'node:fs';


import { sha256Hex } from '@/lib/extraction/domain/hash';
import { ForgewingProviderOutputError, normalizeClaudeProviderError } from '@/lib/forgewing/runtime/client';
import { getClaudeClient, getClaudeModel } from '@/lib/server/ai/claudeClient';
import {
  VALUE_READING_EXECUTION,
  VALUE_READING_OUTPUT_JSON_SCHEMA,
  type ValueReadingProvider,
  type ValueReadingProviderRequest,
} from '@/lib/valueReadingContract';

/**
 * Forgewing B4.5 value-reading provider: one Claude request carrying exactly
 * one rendered region image (and text excerpts only when the engine approved
 * and requested them), answered in the engine's structured output schema.
 *
 * This is deliberately its own request builder, not the pinned Phase 17
 * structured-output contract in client.ts: that contract is text-only and
 * byte-pinned. This qualification-only client keeps the same prompt, schema,
 * retry and input contract. Its additive request uses the owner-approved 500-token
 * cap, explicit between_tools thinking, and omitted temperature.
 *
 * Injected only by the manual v3 qualification runner. The production engine still
 * decides whether it may be called: activation, entitlement, data policy and
 * the durable budget all gate before any byte reaches this module.
 */

export function loadValueReadingPrompt(): string {
  return readFileSync(new URL('../prompts/valueReading.md', import.meta.url), 'utf8');
}

/** The model the value reading runs on: the Forgewing model, else the server default. */
export function valueReadingProviderModelV3(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.FORGEWING_MODEL?.trim() || getClaudeModel();
}

/** No key, no provider: the engine then records `recovery_disabled / provider_not_configured`. */
export function isValueReadingProviderConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/**
 * The single definition of a value-reading request. Refuses to build one whose
 * image is not exactly the bytes the request digest names, or whose prompt or
 * schema version is not the one the digest bound.
 */
export function buildValueReadingMessagesRequestV3(request: ValueReadingProviderRequest, prompt: string) {
  if (sha256Hex(request.image.bytes) !== request.renderDigestSha256) throw new Error('render_digest_mismatch');
  if (request.image.mediaType !== 'image/png' || request.image.bytes.byteLength === 0) throw new Error('invalid_region_image');
  if (request.model !== 'claude-sonnet-5-5') throw new Error('qualification_v3_model_mismatch');
  if (request.maxOutputTokens !== 500) throw new Error('qualification_v3_output_cap_mismatch');
  if (request.promptTemplateId !== VALUE_READING_EXECUTION.promptTemplateId
    || request.promptTemplateVersion !== VALUE_READING_EXECUTION.promptTemplateVersion
    || request.outputSchemaVersion !== VALUE_READING_EXECUTION.outputSchemaVersion) {
    throw new Error('value_reading_contract_mismatch');
  }
  const input = {
    task: 'read_priced_line',
    output_schema_version: request.outputSchemaVersion,
    ...(request.textExcerpts ? { text_excerpts: {
      target_line: request.textExcerpts.targetLineText,
      neighbouring_lines: [...request.textExcerpts.neighbouringLineTexts],
    } } : {}),
  };
  return {
    body: {
      model: request.model,
      thinking: { type: 'between_tools' as const },
      max_tokens: request.maxOutputTokens,
      system: prompt,
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: {
            type: 'base64' as const, media_type: 'image/png' as const, data: Buffer.from(request.image.bytes).toString('base64'),
          } },
          { type: 'text' as const, text: JSON.stringify(input) },
        ],
      }],
      output_config: { format: { type: 'json_schema' as const, schema: VALUE_READING_OUTPUT_JSON_SCHEMA } },
    },
    options: { timeout: request.timeoutMs, maxRetries: 0 },
  };
}

type MessagesClient = Readonly<{
  messages: Readonly<{
    create(body: ReturnType<typeof buildValueReadingMessagesRequestV3>['body'],
      options: ReturnType<typeof buildValueReadingMessagesRequestV3>['options'] & { signal: AbortSignal }): Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
      stop_reason?: string | null;
      model?: string;
    }>;
  }>;
}>;

export function createClaudeValueReadingProviderV3(config: Readonly<{
  model: string;
  prompt?: string;
  /** Tests inject a fake; production uses the shared server client. */
  client?: () => MessagesClient;
  observe?: (event: Readonly<{ requestDigestSha256: string; renderDigestSha256: string; requestBodySha256: string; buildMs: number; sdkMs: number; message: unknown }>) => void;
}>): ValueReadingProvider {
  const prompt = config.prompt ?? loadValueReadingPrompt();
  const client = config.client ?? (() => getClaudeClient() as unknown as MessagesClient);
  return {
    providerModel: config.model,
    async read(request, signal) {
      const buildStart = performance.now();
      const built = buildValueReadingMessagesRequestV3(request, prompt);
      const buildMs = performance.now() - buildStart;
      try {
        const sdkStart = performance.now();
        const message = await client().messages.create(built.body, { ...built.options, signal });
        try { config.observe?.({ requestDigestSha256: request.requestDigestSha256, renderDigestSha256: request.renderDigestSha256, requestBodySha256: sha256Hex(JSON.stringify(built.body)), buildMs,
          sdkMs: performance.now() - sdkStart, message }); } catch { /* observation cannot change scoring */ }
        if (message.model !== request.model) throw new Error('provider_model_mismatch');
        const raw = message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
        if (message.stop_reason === 'max_tokens') throw new ForgewingProviderOutputError('provider_truncated_output', raw);
        // A declined request is a provider failure, never an unreadable reading.
        if (message.stop_reason === 'refusal') throw new Error('provider_refusal');
        return raw;
      } catch (error) {
        throw normalizeClaudeProviderError(error, signal.aborted);
      }
    },
  };
}
