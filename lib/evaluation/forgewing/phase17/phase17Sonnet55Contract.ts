import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v2-sonnet-5-5' as const;
export const PHASE17_SONNET_55_EVALUATION_VERSION =
  'phase17-continuation-eval-v2-sonnet-5-5' as const;
export const PHASE17_SONNET_55_FREEZE_VERSION =
  'phase17-continuation-freeze-v2-sonnet-5-5' as const;
export const PHASE17_SONNET_55_REPORT_VERSION =
  'phase17-continuation-summary-v2-sonnet-5-5' as const;
export const PHASE17_SONNET_55_RUN_ID = /^phase17-sonnet-5-5-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55SamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55RequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55SamplingSchema })
  .strict();

export const Phase17Sonnet55PinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55SamplingSchema,
    requestContract: Phase17Sonnet55RequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55Pins = z.infer<typeof Phase17Sonnet55PinsSchema>;

export const Phase17Sonnet55FreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_RUN_ID),
    pins: Phase17Sonnet55PinsSchema,
  })
  .strict();
export type Phase17Sonnet55Freeze = z.infer<typeof Phase17Sonnet55FreezeSchema>;

export const Phase17Sonnet55EvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_RUN_ID),
    pins: Phase17Sonnet55PinsSchema,
  })
  .strict();
export type Phase17Sonnet55EvaluationRun = z.infer<typeof Phase17Sonnet55EvaluationRunSchema>;

/** Static proof that v2 changes model/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});
