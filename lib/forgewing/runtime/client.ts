import { readFileSync } from 'node:fs';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import { getClaudeClient } from '@/lib/server/ai/claudeClient';
import {
  COLUMN_MAPPING_OUTPUT_JSON_SCHEMA,
  OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA,
  PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
  PRICING_INTERPRETATION_CONDITIONAL_FIELD_RULES,
  PRICING_INTERPRETATION_V2_OUTPUT_JSON_SCHEMA,
  PRICING_RATE_CLUSTER_RECOVERY_OUTPUT_JSON_SCHEMA,
  RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA,
  REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA,
  TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA,
} from '@/lib/forgewing/runtime/structuredOutput';
import {
  WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA,
} from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';
import { REPOSITORY_PLAN_GUIDANCE_OUTPUT_JSON_SCHEMA } from '@/lib/forgewing/runtime/repositoryPlanGuidanceStructuredOutput';

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
export const FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_PROMPT_ID =
  'forgewing-pricing-rate-cluster-recovery';
export const FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_PROMPT_VERSION = 'v1';
export const FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_ID = 'forgewing-recovery-candidate-v2';
export const FORGEWING_RECOVERY_CANDIDATE_V2_PROMPT_VERSION = 'v2';
export const FORGEWING_WORKFLOW_ASSESSMENT_PROMPT_ID = 'forgewing-workflow-assessment';
export const FORGEWING_WORKFLOW_ASSESSMENT_PROMPT_VERSION = 'v1';
export const FORGEWING_REPOSITORY_PLAN_GUIDANCE_PROMPT_ID = 'forgewing-repository-plan-guidance';
export const FORGEWING_REPOSITORY_PLAN_GUIDANCE_PROMPT_VERSION = 'v1';

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

function loadPricingRateClusterRecoveryPrompt(): string {
  return readFileSync(
    new URL('../prompts/pricingRateClusterRecovery.md', import.meta.url),
    'utf8',
  );
}

export function loadRecoveryCandidateV2Prompt(): string {
  return readFileSync(new URL('../prompts/recoveryCandidateV2.md', import.meta.url), 'utf8');
}

function loadWorkflowAssessmentPrompt(): string {
  return readFileSync(
    new URL('../prompts/workflowAssessment.md', import.meta.url),
    'utf8',
  );
}

export function loadRepositoryPlanGuidancePrompt(): string {
  return readFileSync(
    new URL('../prompts/repositoryPlanGuidance.md', import.meta.url),
    'utf8',
  );
}

/**
 * Evaluation-only response metadata. Deliberately excludes content, thinking,
 * and any reasoning: only what a behavioral measurement needs to account for a
 * call.
 */
export type ForgewingProviderObservation = Readonly<{
  messageId: string | null;
  requestId: string | null;
  returnedModel: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  /** sha256 of the exact system prompt string sent in this request. */
  systemPromptSha256: string;
}>;

export type ForgewingProviderObserver = (observation: ForgewingProviderObservation) => void;

export type ForgewingStructuredOutputSchema = typeof REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA
  | typeof TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA
  | typeof COLUMN_MAPPING_OUTPUT_JSON_SCHEMA
  | typeof OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA
  | typeof PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA
  | typeof PRICING_INTERPRETATION_V2_OUTPUT_JSON_SCHEMA
  | typeof PRICING_RATE_CLUSTER_RECOVERY_OUTPUT_JSON_SCHEMA
  | typeof RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA
  | typeof WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA
  | typeof REPOSITORY_PLAN_GUIDANCE_OUTPUT_JSON_SCHEMA;

// forgewing-request-contract:begin
/**
 * The single definition of a Forgewing structured-output Claude request: body
 * and per-request options except the abort signal. Every provider in this module
 * sends exactly this; Phase 17 pins this region and derives its recorded request
 * parameters from it rather than from handwritten constants.
 */
export function buildForgewingStructuredOutputRequest(
  request: ForgewingProviderRequest,
  prompt: string,
  schema: ForgewingStructuredOutputSchema,
) {
  return {
    body: {
      model: request.model,
      temperature: 0,
      max_tokens: request.maxOutputTokens,
      system: prompt,
      messages: [{ role: 'user' as const, content: request.inputJson }],
      output_config: {
        format: {
          type: 'json_schema' as const,
          schema,
        },
      },
    },
    options: {
      timeout: request.timeoutMs,
      maxRetries: 0,
    },
  };
}

async function callClaudeWithStructuredOutput(
  request: ForgewingProviderRequest,
  prompt: string,
  schema: ForgewingStructuredOutputSchema,
  detectTruncation = false,
  observer?: ForgewingProviderObserver,
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
    // Observed before content handling so a truncated response is still
    // accounted for. Absent for every production caller.
    observer?.({
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
// forgewing-request-contract:end

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

export const callClaudeForPricingRateClusterRecovery: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadPricingRateClusterRecoveryPrompt(),
    PRICING_RATE_CLUSTER_RECOVERY_OUTPUT_JSON_SCHEMA,
    true,
  );

export const callClaudeForRecoveryCandidateV2: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadRecoveryCandidateV2Prompt(),
    RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA,
    true,
  );

/**
 * Evaluation-only observed variant of callClaudeForRecoveryCandidateV2 (Phase 17).
 *
 * Same client, prompt bytes, JSON schema, temperature, zero retries, and
 * truncation detection as the production provider; the only addition is that
 * response metadata is reported to the evaluation observer. Production callers
 * continue to use callClaudeForRecoveryCandidateV2 above.
 */
export function createObservedRecoveryCandidateV2EvaluationProvider(
  observer: ForgewingProviderObserver,
): ForgewingProvider {
  return async (request) => callClaudeWithStructuredOutput(
    request,
    loadRecoveryCandidateV2Prompt(),
    RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA,
    true,
    observer,
  );
}

export const callClaudeForWorkflowAssessment: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadWorkflowAssessmentPrompt(),
    WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA,
    true,
  );

export const callClaudeForRepositoryPlanGuidance: ForgewingProvider = async (request) =>
  callClaudeWithStructuredOutput(
    request,
    loadRepositoryPlanGuidancePrompt(),
    REPOSITORY_PLAN_GUIDANCE_OUTPUT_JSON_SCHEMA,
    true,
  );

/**
 * Evaluation-only seam for a frozen pricing prompt experiment. Production and
 * shadow callers continue to use callClaudeForPricingInterpretation above.
 */
export async function callClaudeForPricingInterpretationWithEvaluationPrompt(
  request: ForgewingProviderRequest,
  evaluationPrompt: string,
): Promise<string> {
  return callClaudeWithStructuredOutput(
    request,
    evaluationPrompt,
    PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
    true,
  );
}

/**
 * Evaluation-only seam for the V2 field-grain measurement. Takes the prompt from
 * the caller and uses the V2 structured-output contract. Production and shadow
 * callers continue to use callClaudeForPricingInterpretation above, which is
 * unchanged and still bound to the V1 schema.
 */
export async function callClaudeForPricingInterpretationV2WithEvaluationPrompt(
  request: ForgewingProviderRequest,
  evaluationPrompt: string,
): Promise<string> {
  return callClaudeWithStructuredOutput(
    request,
    evaluationPrompt,
    PRICING_INTERPRETATION_V2_OUTPUT_JSON_SCHEMA,
    true,
  );
}
