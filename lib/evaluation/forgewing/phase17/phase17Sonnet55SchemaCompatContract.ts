import { z } from 'zod';

import {
  PHASE17_EVALUATION_VERSION,
  PHASE17_SCORING_VERSION,
  Phase17EvaluationRunSchema,
  Phase17FreezeSchema,
  Phase17PinsSchema,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

export const PHASE17_SONNET_55_SCHEMA_COMPAT_MODEL = 'claude-sonnet-5-5' as const;
export const PHASE17_SONNET_55_SCHEMA_COMPAT_FRAMEWORK_VERSION =
  'phase17-continuation-qualification-contract-v3-sonnet-5-5-schema-compat' as const;
export const PHASE17_SONNET_55_SCHEMA_COMPAT_EVALUATION_VERSION =
  'phase17-continuation-eval-v3-sonnet-5-5-schema-compat' as const;
export const PHASE17_SONNET_55_SCHEMA_COMPAT_FREEZE_VERSION =
  'phase17-continuation-freeze-v3-sonnet-5-5-schema-compat' as const;
export const PHASE17_SONNET_55_SCHEMA_COMPAT_REPORT_VERSION =
  'phase17-continuation-summary-v3-sonnet-5-5-schema-compat' as const;
export const PHASE17_SONNET_55_SCHEMA_COMPAT_RUN_ID = /^phase17-sonnet-5-5-schema-compat-[a-f0-9]{24}$/;

/** Exact sampling provenance: the request body has no temperature key. */
export const Phase17Sonnet55SchemaCompatSamplingSchema = z.object({
  temperature: z.object({ state: z.literal('omitted') }).strict(),
}).strict();

const Phase17Sonnet55SchemaCompatRequestContractSchema = Phase17PinsSchema.shape.requestContract
  .omit({ temperature: true })
  .extend({ sampling: Phase17Sonnet55SchemaCompatSamplingSchema,
    schemaTransformation: z.literal('confidence-provider-bounds-omitted-local-bounds-preserved-v1'),
  })
  .strict();

export const Phase17Sonnet55SchemaCompatPinsSchema = Phase17PinsSchema
  .omit({ temperature: true, requestContract: true })
  .extend({
    model: z.literal(PHASE17_SONNET_55_SCHEMA_COMPAT_MODEL),
    qualificationFrameworkVersion: z.literal(PHASE17_SONNET_55_SCHEMA_COMPAT_FRAMEWORK_VERSION),
    sampling: Phase17Sonnet55SchemaCompatSamplingSchema,
    requestContract: Phase17Sonnet55SchemaCompatRequestContractSchema,
    clientSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Digest of the unchanged v1 evaluation/scoring/threshold implementation. */
    qualificationSemanticsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Phase17Sonnet55SchemaCompatPins = z.infer<typeof Phase17Sonnet55SchemaCompatPinsSchema>;

export const Phase17Sonnet55SchemaCompatFreezeSchema = Phase17FreezeSchema
  .omit({ freezeVersion: true, evaluationVersion: true, runId: true, pins: true })
  .extend({
    freezeVersion: z.literal(PHASE17_SONNET_55_SCHEMA_COMPAT_FREEZE_VERSION),
    evaluationVersion: z.literal(PHASE17_SONNET_55_SCHEMA_COMPAT_EVALUATION_VERSION),
    scoringVersion: z.literal(PHASE17_SCORING_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_SCHEMA_COMPAT_RUN_ID),
    pins: Phase17Sonnet55SchemaCompatPinsSchema,
  })
  .strict();
export type Phase17Sonnet55SchemaCompatFreeze = z.infer<typeof Phase17Sonnet55SchemaCompatFreezeSchema>;

export const Phase17Sonnet55SchemaCompatEvaluationRunSchema = Phase17EvaluationRunSchema
  .omit({ reportVersion: true, runId: true, pins: true })
  .extend({
    reportVersion: z.literal(PHASE17_SONNET_55_SCHEMA_COMPAT_REPORT_VERSION),
    runId: z.string().regex(PHASE17_SONNET_55_SCHEMA_COMPAT_RUN_ID),
    pins: Phase17Sonnet55SchemaCompatPinsSchema,
  })
  .strict();
export type Phase17Sonnet55SchemaCompatEvaluationRun = z.infer<typeof Phase17Sonnet55SchemaCompatEvaluationRunSchema>;

/** Static proof that v2 changes model/request identity, not evaluation semantics. */
export const PHASE17_SONNET_55_SCHEMA_COMPAT_REUSED_SEMANTICS = Object.freeze({
  evaluationDefinition: PHASE17_EVALUATION_VERSION,
  scoring: PHASE17_SCORING_VERSION,
});

