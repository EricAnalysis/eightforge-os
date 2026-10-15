import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v11-sonnet-5-5-prompt-between-tools' as const;
export const PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_EVALUATION_VERSION =
  'phase17-continuation-eval-v11-sonnet-5-5-prompt-between-tools' as const;
export const PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_FREEZE_VERSION =
  'phase17-continuation-freeze-v11-sonnet-5-5-prompt-between-tools' as const;
export const PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_REPORT_VERSION =
  'phase17-continuation-summary-v11-sonnet-5-5-prompt-between-tools' as const;
export const PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_RUN_ID = /^phase17-sonnet-5-5-prompt-between-tools-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55PromptBetweenToolsSamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55PromptBetweenToolsRequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55PromptBetweenToolsSamplingSchema,
    thinking: z.object({ type: z.literal('between_tools') }).strict(),
    schemaTransformation: z.literal('confidence-provider-bounds-omitted-rationale-length-description-v1'),
    bindsThinkingMode: z.boolean(),
  })
  .strict();

export const Phase17Sonnet55PromptBetweenToolsPinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55PromptBetweenToolsSamplingSchema,
    requestContract: Phase17Sonnet55PromptBetweenToolsRequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55PromptBetweenToolsPins = z.infer<typeof Phase17Sonnet55PromptBetweenToolsPinsSchema>;

const Phase17Sonnet55PromptBetweenToolsRequestIdentitySchema = z.object({
  sequence: z.number().int().positive(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestBodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  optionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const Phase17Sonnet55PromptBetweenToolsFreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_RUN_ID),
    pins: Phase17Sonnet55PromptBetweenToolsPinsSchema,
    requestIdentities: z.array(Phase17Sonnet55PromptBetweenToolsRequestIdentitySchema).length(48),
    requestIdentitiesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55PromptBetweenToolsFreeze = z.infer<typeof Phase17Sonnet55PromptBetweenToolsFreezeSchema>;

export const Phase17Sonnet55PromptBetweenToolsEvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_RUN_ID),
    pins: Phase17Sonnet55PromptBetweenToolsPinsSchema,
  })
  .strict();
export type Phase17Sonnet55PromptBetweenToolsEvaluationRun = z.infer<typeof Phase17Sonnet55PromptBetweenToolsEvaluationRunSchema>;

/** Static proof that v11 changes prompt/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_PROMPT_BETWEEN_TOOLS_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});
