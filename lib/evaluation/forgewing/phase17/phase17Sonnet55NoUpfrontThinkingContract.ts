import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v4-sonnet-5-5-no-upfront-thinking' as const;
export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_EVALUATION_VERSION =
  'phase17-continuation-eval-v4-sonnet-5-5-no-upfront-thinking' as const;
export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_FREEZE_VERSION =
  'phase17-continuation-freeze-v4-sonnet-5-5-no-upfront-thinking' as const;
export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_REPORT_VERSION =
  'phase17-continuation-summary-v4-sonnet-5-5-no-upfront-thinking' as const;
export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_RUN_ID = /^phase17-sonnet-5-5-no-upfront-thinking-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55NoUpfrontThinkingSamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55NoUpfrontThinkingRequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55NoUpfrontThinkingSamplingSchema,
    thinking: z.object({ type: z.literal('between_tools') }).strict(),
    schemaTransformation: z.literal('confidence-provider-bounds-omitted-local-bounds-preserved-v1'),
  })
  .strict();

export const Phase17Sonnet55NoUpfrontThinkingPinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_NO_UPFRONT_THINKING_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_NO_UPFRONT_THINKING_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55NoUpfrontThinkingSamplingSchema,
    requestContract: Phase17Sonnet55NoUpfrontThinkingRequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55NoUpfrontThinkingPins = z.infer<typeof Phase17Sonnet55NoUpfrontThinkingPinsSchema>;

export const Phase17Sonnet55NoUpfrontThinkingFreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_NO_UPFRONT_THINKING_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_NO_UPFRONT_THINKING_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_NO_UPFRONT_THINKING_RUN_ID),
    pins: Phase17Sonnet55NoUpfrontThinkingPinsSchema,
  })
  .strict();
export type Phase17Sonnet55NoUpfrontThinkingFreeze = z.infer<typeof Phase17Sonnet55NoUpfrontThinkingFreezeSchema>;

export const Phase17Sonnet55NoUpfrontThinkingEvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_NO_UPFRONT_THINKING_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_NO_UPFRONT_THINKING_RUN_ID),
    pins: Phase17Sonnet55NoUpfrontThinkingPinsSchema,
  })
  .strict();
export type Phase17Sonnet55NoUpfrontThinkingEvaluationRun = z.infer<typeof Phase17Sonnet55NoUpfrontThinkingEvaluationRunSchema>;

/** Static proof that v2 changes model/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_NO_UPFRONT_THINKING_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});


