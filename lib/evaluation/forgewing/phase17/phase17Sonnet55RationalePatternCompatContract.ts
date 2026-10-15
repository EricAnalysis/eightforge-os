import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v9-sonnet-5-5-rationale-pattern-compat' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_EVALUATION_VERSION =
  'phase17-continuation-eval-v9-sonnet-5-5-rationale-pattern-compat' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_FREEZE_VERSION =
  'phase17-continuation-freeze-v9-sonnet-5-5-rationale-pattern-compat' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_REPORT_VERSION =
  'phase17-continuation-summary-v9-sonnet-5-5-rationale-pattern-compat' as const;
export const PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_RUN_ID = /^phase17-sonnet-5-5-rationale-pattern-compat-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55RationalePatternCompatSamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55RationalePatternCompatRequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55RationalePatternCompatSamplingSchema,
    thinking: z.object({ type: z.literal('adaptive'), effort: z.literal('low') }).strict(),
    schemaTransformation: z.literal('confidence-provider-bounds-omitted-rationale-pattern-expanded-v1'),
    bindsEffort: z.boolean(),
  })
  .strict();

export const Phase17Sonnet55RationalePatternCompatPinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55RationalePatternCompatSamplingSchema,
    requestContract: Phase17Sonnet55RationalePatternCompatRequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55RationalePatternCompatPins = z.infer<typeof Phase17Sonnet55RationalePatternCompatPinsSchema>;

const Phase17Sonnet55RationalePatternCompatRequestIdentitySchema = z.object({
  sequence: z.number().int().positive(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestBodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  optionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const Phase17Sonnet55RationalePatternCompatFreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_RUN_ID),
    pins: Phase17Sonnet55RationalePatternCompatPinsSchema,
    requestIdentities: z.array(Phase17Sonnet55RationalePatternCompatRequestIdentitySchema).length(48),
    requestIdentitiesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55RationalePatternCompatFreeze = z.infer<typeof Phase17Sonnet55RationalePatternCompatFreezeSchema>;

export const Phase17Sonnet55RationalePatternCompatEvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_RUN_ID),
    pins: Phase17Sonnet55RationalePatternCompatPinsSchema,
  })
  .strict();
export type Phase17Sonnet55RationalePatternCompatEvaluationRun = z.infer<typeof Phase17Sonnet55RationalePatternCompatEvaluationRunSchema>;

/** Static proof that v9 changes schema/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_RATIONALE_PATTERN_COMPAT_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});
