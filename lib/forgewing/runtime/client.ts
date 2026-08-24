import { readFileSync } from 'node:fs';

import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import {
  COLUMN_MAPPING_OUTPUT_JSON_SCHEMA,
  OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA,
  PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
  PRICING_INTERPRETATION_CONDITIONAL_FIELD_RULES,
  REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA,
  TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA,
} from '@/lib/forgewing/runtime/structuredOutput';

export const FORGEWING_REGION_CLASSIFICATION_PROMPT_ID = 'forgewing-region-classification';
export const FORGEWING_REGION_CLASSIFICATION_PROMPT_VERSION = 'v1';
export const FORGEWING_TABLE_CONTINUATION_PROMPT_ID = 'forgewing-table-continuation';
export const FORGEWING_TABLE_CONTINUATION_PROMPT_VERSION = 'v1';
export const FORGEWING_COLUMN_MAPPING_PROMPT_ID = 'forgewing-column-mapping';
export const FORGEWING_COLUMN_MAPPING_PROMPT_VERSION = 'v1';
export const FORGEWING_OBSERVATION_ARBITRATION_PROMPT_ID = 'forgewing-observation-arbitration';
export const FORGEWING_OBSERVATION_ARBITRATION_PROMPT_VERSION = 'v1';
export const FORGEWING_PRICING_INTERPRETATION_PROMPT_ID = 'forgewing-pricing-interpretation';
export const FORGEWING_PRICING_INTERPRETATION_PROMPT_VERSION = 'v3';

export type ForgewingProviderRequest = Readonly<{
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  inputJson: string;
}>;

export type ForgewingProvider = (request: ForgewingProviderRequest) => Promise<string>;

export class ForgewingProviderOutputError extends Error {
  constructor(message: 'provider_truncated_output', readonly rawOutput: string) {
    super(message);
    this.name = 'ForgewingProviderOutputError';
  }
}

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

function loadTableContinuationPrompt(): string {
  return readFileSync(
    new URL('../prompts/tableContinuation.md', import.meta.url),
    'utf8',
  );
}

function loadColumnMappingPrompt(): string {
  return readFileSync(
    new URL('../prompts/columnMapping.md', import.meta.url),
    'utf8',
  );
}

function loadObservationArbitrationPrompt(): string {
  return readFileSync(
    new URL('../prompts/observationArbitration.md', import.meta.url),
    'utf8',
  );
}

export function loadPricingInterpretationPrompt(): string {
  const base = readFileSync(
    new URL('../prompts/pricingInterpretation.md', import.meta.url),
    'utf8',
  );
  return `${base.trim()}\n\n${PRICING_INTERPRETATION_CONDITIONAL_FIELD_RULES}\n`;
}

async function callClaudeWithStructuredOutput(
  request: ForgewingProviderRequest,
  prompt: string,
  schema: typeof REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA
    | typeof TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA
    | typeof COLUMN_MAPPING_OUTPUT_JSON_SCHEMA
    | typeof OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA
    | typeof PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
  detectTruncation = false,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const message = await getClaudeClient().messages.create({
      model: request.model,
      temperature: 0,
      max_tokens: request.maxOutputTokens,
      system: prompt,
      messages: [{ role: 'user', content: request.inputJson }],
      output_config: {
        format: {
          type: 'json_schema',
          schema,
        },
      },
    }, {
      signal: controller.signal,
      timeout: request.timeoutMs,
      maxRetries: 0,
    });
    const rawOutput = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (detectTruncation && message.stop_reason === 'max_tokens') {
      throw new ForgewingProviderOutputError('provider_truncated_output', rawOutput);
    }
    return rawOutput;
  } catch (error) {
    throw normalizeClaudeProviderError(error, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

export const callClaudeForRegionClassification: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadRegionClassificationPrompt(),
    REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA,
  );

export const callClaudeForTableContinuation: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadTableContinuationPrompt(),
    TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA,
  );

export const callClaudeForColumnMapping: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadColumnMappingPrompt(),
    COLUMN_MAPPING_OUTPUT_JSON_SCHEMA,
  );

export const callClaudeForObservationArbitration: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadObservationArbitrationPrompt(),
    OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA,
  );

export const callClaudeForPricingInterpretation: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadPricingInterpretationPrompt(),
    PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
    true,
  );
