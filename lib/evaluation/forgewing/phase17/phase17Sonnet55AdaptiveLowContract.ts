import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_ADAPTIVE_LOW_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_ADAPTIVE_LOW_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v5-sonnet-5-5-adaptive-low' as const;
export const PHASE17_SONNET_55_ADAPTIVE_LOW_EVALUATION_VERSION =
  'phase17-continuation-eval-v5-sonnet-5-5-adaptive-low' as const;
export const PHASE17_SONNET_55_ADAPTIVE_LOW_FREEZE_VERSION =
  'phase17-continuation-freeze-v5-sonnet-5-5-adaptive-low' as const;
export const PHASE17_SONNET_55_ADAPTIVE_LOW_REPORT_VERSION =
  'phase17-continuation-summary-v5-sonnet-5-5-adaptive-low' as const;
export const PHASE17_SONNET_55_ADAPTIVE_LOW_RUN_ID = /^phase17-sonnet-5-5-adaptive-low-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55AdaptiveLowSamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55AdaptiveLowRequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55AdaptiveLowSamplingSchema,
    thinking: z.object({ type: z.literal('adaptive'), effort: z.literal('low') }).strict(),
    schemaTransformation: z.literal('confidence-provider-bounds-omitted-rationale-max-length-200-v1'),
    bindsEffort: z.boolean(),
  })
  .strict();

export const Phase17Sonnet55AdaptiveLowPinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_ADAPTIVE_LOW_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_ADAPTIVE_LOW_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55AdaptiveLowSamplingSchema,
    requestContract: Phase17Sonnet55AdaptiveLowRequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55AdaptiveLowPins = z.infer<typeof Phase17Sonnet55AdaptiveLowPinsSchema>;

export const Phase17Sonnet55AdaptiveLowFreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_ADAPTIVE_LOW_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_ADAPTIVE_LOW_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_ADAPTIVE_LOW_RUN_ID),
    pins: Phase17Sonnet55AdaptiveLowPinsSchema,
  })
  .strict();
export type Phase17Sonnet55AdaptiveLowFreeze = z.infer<typeof Phase17Sonnet55AdaptiveLowFreezeSchema>;

export const Phase17Sonnet55AdaptiveLowEvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_ADAPTIVE_LOW_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_ADAPTIVE_LOW_RUN_ID),
    pins: Phase17Sonnet55AdaptiveLowPinsSchema,
  })
  .strict();
export type Phase17Sonnet55AdaptiveLowEvaluationRun = z.infer<typeof Phase17Sonnet55AdaptiveLowEvaluationRunSchema>;

/** Static proof that v2 changes model/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_ADAPTIVE_LOW_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});

