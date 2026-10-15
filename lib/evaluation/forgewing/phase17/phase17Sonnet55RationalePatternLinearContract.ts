import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v10-sonnet-5-5-rationale-pattern-linear' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_EVALUATION_VERSION =
  'phase17-continuation-eval-v10-sonnet-5-5-rationale-pattern-linear' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_FREEZE_VERSION =
  'phase17-continuation-freeze-v10-sonnet-5-5-rationale-pattern-linear' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_REPORT_VERSION =
  'phase17-continuation-summary-v10-sonnet-5-5-rationale-pattern-linear' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_RUN_ID = /^phase17-sonnet-5-5-rationale-pattern-linear-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55RationalePatternLinearSamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55RationalePatternLinearRequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55RationalePatternLinearSamplingSchema,
    thinking: z.object({ type: z.literal('adaptive'), effort: z.literal('low') }).strict(),
    schemaTransformation: z.literal('confidence-provider-bounds-omitted-rationale-pattern-blocks-v1'),
    bindsEffort: z.boolean(),
  })
  .strict();

export const Phase17Sonnet55RationalePatternLinearPinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55RationalePatternLinearSamplingSchema,
    requestContract: Phase17Sonnet55RationalePatternLinearRequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55RationalePatternLinearPins = z.infer<typeof Phase17Sonnet55RationalePatternLinearPinsSchema>;

const Phase17Sonnet55RationalePatternLinearRequestIdentitySchema = z.object({
  sequence: z.number().int().positive(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestBodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  optionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const Phase17Sonnet55RationalePatternLinearFreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_RUN_ID),
    pins: Phase17Sonnet55RationalePatternLinearPinsSchema,
    requestIdentities: z.array(Phase17Sonnet55RationalePatternLinearRequestIdentitySchema).length(48),
    requestIdentitiesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55RationalePatternLinearFreeze = z.infer<typeof Phase17Sonnet55RationalePatternLinearFreezeSchema>;

export const Phase17Sonnet55RationalePatternLinearEvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_RUN_ID),
    pins: Phase17Sonnet55RationalePatternLinearPinsSchema,
  })
  .strict();
export type Phase17Sonnet55RationalePatternLinearEvaluationRun = z.infer<typeof Phase17Sonnet55RationalePatternLinearEvaluationRunSchema>;

/** Static proof that v10 changes schema/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_RATIONALE_PATTERN_LINEAR_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});
