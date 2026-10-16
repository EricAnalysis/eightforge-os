import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v12-sonnet-5-5-behavioral-prompt' as const;
export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_EVALUATION_VERSION =
  'phase17-continuation-eval-v12-sonnet-5-5-behavioral-prompt' as const;
export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_FREEZE_VERSION =
  'phase17-continuation-freeze-v12-sonnet-5-5-behavioral-prompt' as const;
export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_REPORT_VERSION =
  'phase17-continuation-summary-v12-sonnet-5-5-behavioral-prompt' as const;
export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_RUN_ID = /^phase17-sonnet-5-5-behavioral-prompt-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55BehavioralPromptSamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55BehavioralPromptRequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55BehavioralPromptSamplingSchema,
    thinking: z.object({ type: z.literal('between_tools') }).strict(),
    schemaTransformation: z.literal('confidence-provider-bounds-omitted-rationale-length-description-v1'),
    bindsThinkingMode: z.boolean(),
  })
  .strict();

export const Phase17Sonnet55BehavioralPromptPinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55BehavioralPromptSamplingSchema,
    requestContract: Phase17Sonnet55BehavioralPromptRequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55BehavioralPromptPins = z.infer<typeof Phase17Sonnet55BehavioralPromptPinsSchema>;

const Phase17Sonnet55BehavioralPromptRequestIdentitySchema = z.object({
  sequence: z.number().int().positive(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestBodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  optionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const Phase17Sonnet55BehavioralPromptFreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_RUN_ID),
    pins: Phase17Sonnet55BehavioralPromptPinsSchema,
    requestIdentities: z.array(Phase17Sonnet55BehavioralPromptRequestIdentitySchema).length(48),
    requestIdentitiesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55BehavioralPromptFreeze = z.infer<typeof Phase17Sonnet55BehavioralPromptFreezeSchema>;

export const Phase17Sonnet55BehavioralPromptEvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_BEHAVIORAL_PROMPT_RUN_ID),
    pins: Phase17Sonnet55BehavioralPromptPinsSchema,
  })
  .strict();
export type Phase17Sonnet55BehavioralPromptEvaluationRun = z.infer<typeof Phase17Sonnet55BehavioralPromptEvaluationRunSchema>;

/** Static proof that v12 changes prompt/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_BEHAVIORAL_PROMPT_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});
