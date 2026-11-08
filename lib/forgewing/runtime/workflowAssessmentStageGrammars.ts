import { z } from 'zod';

import {
  declaredWritingTarget,
  WORKFLOW_INTAKE_V1_QUESTIONS,
  WORKFLOW_INTAKE_V2_QUESTIONS,
  WorkflowAssessmentModelOutputSchema,
} from '@/lib/workflowAssessmentSchema';

/**
 * Decomposed Workflow Assessment grammars (P1 of DECOMPOSITION-PLAN.md).
 *
 * The single-call grammar was rejected by the provider ("compiled grammar is too
 * large", Run 1), and D1's string envelope removed all structural enforcement.
 * Decomposition returns enforcement to the provider in two grammars, chosen by
 * live compile probes on 2026-11-06 (p1-probes, $0.025 in total):
 *
 *   A  workflow structure, including determinism   static per intake version
 *      (accepted: 3,731 bytes, 16 s compile; cacheable because it never changes)
 *   B  exactly one detail record per step           generated from A's validated
 *      steps, at most STAGE_B_MAX_STEPS_PER_CALL per call (21 and 30 steps were
 *      accepted with 50-59 s compile; 40 steps was rejected as too large)
 *
 * A separate determinism stage was rejected in every form tried (per-condition
 * support-or-gap anyOf, and flat per-step condition objects): "Schema is too
 * complex for compilation". Determinism therefore stays in stage A, where its
 * fields are provider-required, and linkage and gap/support exclusivity stay
 * with the unchanged validator.
 *
 * Every grammar is DERIVED from WorkflowAssessmentModelOutputSchema (pick/omit/
 * extend), never hand-written, and emits only what the provider enforces: types,
 * required keys, enum, const, $ref and additionalProperties:false. Stage B adds `maxLength` length HINTS (see LENGTH_HINT_RATIO); otherwise string lengths
 * and item counts are deliberately not emitted (the provider does not enforce
 * them); the unchanged strict schema still validates every composed assessment.
 *
 * Intentional narrowings, each matching a rule the validator already enforces:
 *   - A: sourceQuestions and determinism sourceQuestion limited to the submission
 *        version's own question keys.
 *   - B: exactly one record per step, shaped by that step's classification;
 *        RECOVER extraction has deterministicExtractionPlausible const false;
 *        detail IDs and stepId are omitted (derived from stepId, decision D-2).
 * Nothing here composes, repairs or validates model output; that is P2.
 */

export type ProviderGrammar = Readonly<Record<string, unknown>>;
export type StageStep = Readonly<{ stepId: string; classification: string }>;

type AnyZod = z.ZodTypeAny;

function unwrap(schema: AnyZod): AnyZod {
  let current = schema;
  while (current instanceof z.ZodEffects) current = current._def.schema;
  return current;
}

/**
 * Stage B string length hints (L1, owner-approved 2026-11-07). The provider accepts `maxLength` but does not enforce it
 * (p6-maxlength-probe: a 40-character hint produced 45 characters), so it is a target, never a bound.
 * P5 run 1 failed only on stage-B detail lengths (5 overruns, up to 1063/800), so stage B emits
 * `maxLength = floor(LENGTH_HINT_RATIO * max)` for every bounded string. The ~15% margin absorbs the
 * observed overshoot, matching the v5 85% writing target. The strict schema still enforces the real max.
 */
export const LENGTH_HINT_RATIO = 0.85;
export type ProviderGrammarOptions = Readonly<{ lengthHints?: boolean }>;

/** Zod (v3) to the provider-supported JSON Schema subset. Throws on anything else. */
export function toProviderGrammar(schema: AnyZod, path = 'root', options: ProviderGrammarOptions = {}): ProviderGrammar {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodNullable) {
    const base = toProviderGrammar(inner._def.innerType, path, options) as { type?: unknown };
    if (typeof base.type !== 'string') throw new Error(`stage_grammar_unsupported_nullable:${path}`);
    return { ...base, type: [base.type, 'null'] };
  }
  if (inner instanceof z.ZodString) {
    const max = inner._def.checks.find((check) => check.kind === 'max') as { value: number } | undefined;
    if (!options.lengthHints || !max) return { type: 'string' };
    // D-7: an explicitly declared writing target (kept at the pre-D-7 value) wins over the ratio.
    return { type: 'string', maxLength: declaredWritingTarget(schema) ?? Math.floor(LENGTH_HINT_RATIO * max.value) };
  }
  if (inner instanceof z.ZodBoolean) return { type: 'boolean' };
  if (inner instanceof z.ZodEnum) return { type: 'string', enum: [...inner._def.values as string[]] };
  if (inner instanceof z.ZodLiteral) {
    const value = inner._def.value as unknown;
    if (typeof value !== 'boolean' && typeof value !== 'string') throw new Error(`stage_grammar_unsupported_literal:${path}`);
    return { type: typeof value, const: value };
  }
  if (inner instanceof z.ZodArray) {
    const min = inner._def.minLength?.value ?? 0;
    return { type: 'array', items: toProviderGrammar(inner._def.type, `${path}[]`, options), ...(min >= 1 ? { minItems: 1 } : {}) };
  }
  if (inner instanceof z.ZodObject) {
    if (inner._def.unknownKeys !== 'strict') throw new Error(`stage_grammar_non_strict_object:${path}`);
    const shape = inner.shape as Record<string, AnyZod>;
    return {
      type: 'object', additionalProperties: false, required: Object.keys(shape),
      properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, toProviderGrammar(value, `${path}.${key}`, options)])),
    };
  }
  throw new Error(`stage_grammar_unsupported_type:${path}:${inner.constructor.name}`);
}

const shape = WorkflowAssessmentModelOutputSchema.shape;
const element = <T extends AnyZod>(array: AnyZod): T => (unwrap(array) as z.ZodArray<T>)._def.type;
const stepSchema = element<z.AnyZodObject>(shape.workflowSteps);
const supportSchema = element<z.AnyZodObject>(stepSchema.shape.determinismSupport);

/** Stage A output fields, as the strict schema defines them. Stage B supplies the rest. */
export const STAGE_A_FIELDS = [
  'summary', 'documents', 'workflowSteps', 'evidenceRelationships', 'failureConsequences', 'limitations',
] as const;

/** Strict validator for stage A output: the canonical schema's own fields, bounds intact. */
export const STAGE_A_SCHEMA = WorkflowAssessmentModelOutputSchema
  .pick(Object.fromEntries(STAGE_A_FIELDS.map((k) => [k, true])) as never) as z.AnyZodObject;

export const STAGE_SOURCE_QUESTIONS = {
  workflow_intake_v1: WORKFLOW_INTAKE_V1_QUESTIONS,
  workflow_intake_v2: WORKFLOW_INTAKE_V2_QUESTIONS,
} as const;
export type StageIntakeVersion = keyof typeof STAGE_SOURCE_QUESTIONS;

export function buildStageAGrammar(version: StageIntakeVersion): ProviderGrammar {
  const questions = z.enum(STAGE_SOURCE_QUESTIONS[version] as unknown as [string, ...string[]]);
  const steps = stepSchema.extend({
    sourceQuestions: z.array(questions).min(1),
    determinismSupport: z.array(supportSchema.extend({ sourceQuestion: questions })),
  });
  const stageA = WorkflowAssessmentModelOutputSchema.pick(Object.fromEntries(STAGE_A_FIELDS.map((k) => [k, true])) as never)
    .extend({ workflowSteps: z.array(steps).min(1) });
  return toProviderGrammar(stageA, 'stageA');
}

/** Stage B detail shapes: the strict detail-record schemas without stepId or their own ID (derived, D-2). */
const detail = (key: keyof typeof shape, idField: string) =>
  element<z.AnyZodObject>(shape[key]).omit({ stepId: true, [idField]: true } as never);
export const STAGE_B_DETAIL_SCHEMAS = {
  RULE: detail('deterministicRuleProposals', 'ruleId'),
  VERIFY: detail('verificationRuleProposals', 'ruleId'),
  EXTRACT: detail('extractionRequirements', 'requirementId'),
  RECOVER: z.object({
    extractionRequirement: detail('extractionRequirements', 'requirementId')
      .extend({ deterministicExtractionPlausible: z.literal(false) }),
    recoveryTask: detail('forgewingRecoveryTasks', 'taskId'),
  }).strict(),
  HUMAN: detail('humanDecisionPoints', 'decisionId'),
  ADVISORY: detail('advisorySteps', 'advisoryId'),
} as const;
type DetailClassification = keyof typeof STAGE_B_DETAIL_SCHEMAS;

/** Largest stage B batch the provider compiled (30 accepted, 40 rejected; probes 2026-11-06). */
export const STAGE_B_MAX_STEPS_PER_CALL = 30;

function assertSteps(steps: readonly StageStep[]): void {
  if (steps.length === 0) throw new Error('stage_grammar_no_steps');
  if (new Set(steps.map((step) => step.stepId)).size !== steps.length) throw new Error('stage_grammar_duplicate_step_id');
  for (const step of steps) {
    if (!(step.classification in STAGE_B_DETAIL_SCHEMAS)) throw new Error(`stage_grammar_unknown_classification:${step.classification}`);
  }
}

/** Split steps, in order, into the fewest equal-sized batches within the per-call limit. */
export function partitionStageBSteps(steps: readonly StageStep[]): readonly (readonly StageStep[])[] {
  assertSteps(steps);
  const batches = Math.ceil(steps.length / STAGE_B_MAX_STEPS_PER_CALL);
  const size = Math.ceil(steps.length / batches);
  return Array.from({ length: batches }, (_, i) => steps.slice(i * size, (i + 1) * size));
}

export function buildStageBGrammar(steps: readonly StageStep[]): ProviderGrammar {
  assertSteps(steps);
  if (steps.length > STAGE_B_MAX_STEPS_PER_CALL) throw new Error('stage_grammar_batch_too_large');
  const used = [...new Set(steps.map((step) => step.classification))] as DetailClassification[];
  return {
    type: 'object', additionalProperties: false,
    $defs: Object.fromEntries(used.map((c) => [c, toProviderGrammar(STAGE_B_DETAIL_SCHEMAS[c], `stageB.${c}`, { lengthHints: true })])),
    required: steps.map((step) => step.stepId),
    properties: Object.fromEntries(steps.map((step) => [step.stepId, { $ref: `#/$defs/${step.classification}` }])),
  };
}
