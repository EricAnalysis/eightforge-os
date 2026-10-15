import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_RATIONALE_COMPAT_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_RATIONALE_COMPAT_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v6-sonnet-5-5-rationale-compat' as const;
export const PHASE17_SONNET_55_RATIONALE_COMPAT_EVALUATION_VERSION =
  'phase17-continuation-eval-v6-sonnet-5-5-rationale-compat' as const;
export const PHASE17_SONNET_55_RATIONALE_COMPAT_FREEZE_VERSION =
  'phase17-continuation-freeze-v6-sonnet-5-5-rationale-compat' as const;
export const PHASE17_SONNET_55_RATIONALE_COMPAT_REPORT_VERSION =
  'phase17-continuation-summary-v6-sonnet-5-5-rationale-compat' as const;
export const PHASE17_SONNET_55_RATIONALE_COMPAT_RUN_ID = /^phase17-sonnet-5-5-rationale-compat-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55RationaleCompatSamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55RationaleCompatRequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55RationaleCompatSamplingSchema,
    thinking: z.object({ type: z.literal('adaptive'), effort: z.literal('low') }).strict(),
    schemaTransformation: z.literal('confidence-provider-bounds-omitted-rationale-length-description-v1'),
    bindsEffort: z.boolean(),
  })
  .strict();

export const Phase17Sonnet55RationaleCompatPinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_RATIONALE_COMPAT_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_RATIONALE_COMPAT_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55RationaleCompatSamplingSchema,
    requestContract: Phase17Sonnet55RationaleCompatRequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55RationaleCompatPins = z.infer<typeof Phase17Sonnet55RationaleCompatPinsSchema>;

export const Phase17Sonnet55RationaleCompatFreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_RATIONALE_COMPAT_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_RATIONALE_COMPAT_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_RATIONALE_COMPAT_RUN_ID),
    pins: Phase17Sonnet55RationaleCompatPinsSchema,
  })
  .strict();
export type Phase17Sonnet55RationaleCompatFreeze = z.infer<typeof Phase17Sonnet55RationaleCompatFreezeSchema>;

export const Phase17Sonnet55RationaleCompatEvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_RATIONALE_COMPAT_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_RATIONALE_COMPAT_RUN_ID),
    pins: Phase17Sonnet55RationaleCompatPinsSchema,
  })
  .strict();
export type Phase17Sonnet55RationaleCompatEvaluationRun = z.infer<typeof Phase17Sonnet55RationaleCompatEvaluationRunSchema>;

/** Static proof that v2 changes model/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_RATIONALE_COMPAT_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});
