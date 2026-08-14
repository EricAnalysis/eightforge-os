import { readFileSync } from 'node:fs';

import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import { REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA } from '@/lib/forgewing/runtime/structuredOutput';

export const FORGEWING_REGION_CLASSIFICATION_PROMPT_ID = 'forgewing-region-classification';
export const FORGEWING_REGION_CLASSIFICATION_PROMPT_VERSION = 'v1';

export type ForgewingProviderRequest = Readonly<{
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  inputJson: string;
}>;

export type ForgewingProvider = (request: ForgewingProviderRequest) => Promise<string>;

export function normalizeClaudeProviderError(error: unknown, aborted: boolean): Error {
  const errorName = error && typeof error === 'object' && 'name' in error
    ? String(error.name)
    : '';
  const constructorName = error && typeof error === 'object'
    ? error.constructor?.name ?? ''
    : '';
  const errorMessage = error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : '';
  if (
    aborted
    || errorName === 'AbortError'
    || constructorName === 'APIConnectionTimeoutError'
    || errorMessage === 'Request timed out'
  ) {
    return new Error('provider_timeout');
  }
  return error instanceof Error ? error : new Error(String(error));
}

function loadRegionClassificationPrompt(): string {
  return readFileSync(
    new URL('../prompts/regionClassification.md', import.meta.url),
    'utf8',
  );
}

export const callClaudeForRegionClassification: ForgewingProvider = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const message = await getClaudeClient().messages.create({
      model: request.model,
      temperature: 0,
      max_tokens: request.maxOutputTokens,
      system: loadRegionClassificationPrompt(),
      messages: [{ role: 'user', content: request.inputJson }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA,
        },
      },
    }, {
      signal: controller.signal,
      timeout: request.timeoutMs,
      maxRetries: 0,
    });
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  } catch (error) {
    throw normalizeClaudeProviderError(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
};
