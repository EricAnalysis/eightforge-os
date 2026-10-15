import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_BOUNDED_RATIONALE_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_BOUNDED_RATIONALE_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v8-sonnet-5-5-bounded-rationale' as const;
export const PHASE17_SONNET_55_BOUNDED_RATIONALE_EVALUATION_VERSION =
  'phase17-continuation-eval-v8-sonnet-5-5-bounded-rationale' as const;
export const PHASE17_SONNET_55_BOUNDED_RATIONALE_FREEZE_VERSION =
  'phase17-continuation-freeze-v8-sonnet-5-5-bounded-rationale' as const;
export const PHASE17_SONNET_55_BOUNDED_RATIONALE_REPORT_VERSION =
  'phase17-continuation-summary-v8-sonnet-5-5-bounded-rationale' as const;
export const PHASE17_SONNET_55_BOUNDED_RATIONALE_RUN_ID = /^phase17-sonnet-5-5-bounded-rationale-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55BoundedRationaleSamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55BoundedRationaleRequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55BoundedRationaleSamplingSchema,
    thinking: z.object({ type: z.literal('adaptive'), effort: z.literal('low') }).strict(),
    schemaTransformation: z.literal('confidence-provider-bounds-omitted-rationale-pattern-bounded-v1'),
    bindsEffort: z.boolean(),
  })
  .strict();

export const Phase17Sonnet55BoundedRationalePinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_BOUNDED_RATIONALE_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_BOUNDED_RATIONALE_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55BoundedRationaleSamplingSchema,
    requestContract: Phase17Sonnet55BoundedRationaleRequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55BoundedRationalePins = z.infer<typeof Phase17Sonnet55BoundedRationalePinsSchema>;

const Phase17Sonnet55BoundedRationaleRequestIdentitySchema = z.object({
  sequence: z.number().int().positive(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestBodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  optionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const Phase17Sonnet55BoundedRationaleFreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_BOUNDED_RATIONALE_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_BOUNDED_RATIONALE_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_BOUNDED_RATIONALE_RUN_ID),
    pins: Phase17Sonnet55BoundedRationalePinsSchema,
    requestIdentities: z.array(Phase17Sonnet55BoundedRationaleRequestIdentitySchema).length(48),
    requestIdentitiesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55BoundedRationaleFreeze = z.infer<typeof Phase17Sonnet55BoundedRationaleFreezeSchema>;

export const Phase17Sonnet55BoundedRationaleEvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_BOUNDED_RATIONALE_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_BOUNDED_RATIONALE_RUN_ID),
    pins: Phase17Sonnet55BoundedRationalePinsSchema,
  })
  .strict();
export type Phase17Sonnet55BoundedRationaleEvaluationRun = z.infer<typeof Phase17Sonnet55BoundedRationaleEvaluationRunSchema>;

/** Static proof that v8 changes schema/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_BOUNDED_RATIONALE_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});
