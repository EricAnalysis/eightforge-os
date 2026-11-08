import { z } from 'zod';

/**
 * Structured output contract for the Forgewing workflow assessment.
 *
 * Authority markers are deliberately absent from this schema. The model cannot
 * declare an assessment authoritative, or a rule executable, because there is
 * no accepted field in which to say so: the runtime stamps non-authority after
 * validation, and rule proposals are plain language only.
 */
export const WORKFLOW_STEP_CLASSIFICATIONS = [
  'RULE', 'EXTRACT', 'RECOVER', 'VERIFY', 'HUMAN', 'ADVISORY',
] as const;

export const WORKFLOW_INTAKE_V1_QUESTIONS = [
  'workflowDescription', 'documentsInvolved', 'manualChecks',
  'frequencyAndVolume', 'exceptions', 'humanDecisions',
] as const;

export const WORKFLOW_INTAKE_V2_QUESTIONS = [
  'workflowDescription', 'informationOrSystems', 'manualChecks',
  'frequencyAndVolume', 'exceptions', 'humanDecisions', 'successOutcome',
] as const;

export const WORKFLOW_INTAKE_QUESTIONS = WORKFLOW_INTAKE_V2_QUESTIONS;

/** Both source vocabularies are readable; the task validates the exact version. */
export const WORKFLOW_INTAKE_SOURCE_QUESTIONS = [
  ...WORKFLOW_INTAKE_V1_QUESTIONS, 'informationOrSystems', 'successOutcome',
] as const;

export const WORKFLOW_RULE_CONDITION_TYPES = [
  'comparison', 'calculation', 'presence_check', 'date_range',
  'identity_match', 'duplicate_detection', 'precedence',
] as const;

export const WORKFLOW_DETERMINISM_CONDITIONS = [
  'objectiveInputs',
  'explicitComparisonOrCalculation',
  'stableEvidenceSource',
  'deterministicOutput',
  'definedExceptionBehavior',
  'noUnresolvedSubjectiveJudgment',
] as const;

const identifier = z.string().min(1).max(120)
  .refine((value) => value.trim() === value, 'identifier whitespace');
const prose = (max: number) => z.string().min(1).max(max)
  .refine((value) => value.trim() === value, 'prose whitespace');

/**
 * D-7 (2026-11-07, owner-approved): five detail-record limits raised together with
 * the reviewed specification, on measured evidence from P5 runs 1-2 (decomposed
 * Workflow Assessment), which failed ONLY on these lengths with zero structural
 * defects. Each new hard limit is >=1.1x the largest observed output, rounded:
 *   plainLanguageRule 600 -> 1,000 (observed 762 / 641 / 797)
 *   expectedEvidence item 200 -> 300 (211, 211)
 *   extraction describedFact 300 -> 450 (331)
 *   humanDecisionPoints description 400 -> 600 (427)
 *   advisorySteps description 800 -> 1,200 (1,063 / 806)
 * The WRITING TARGET (prompt "aim <=T" and the stage-B maxLength hint) is kept at
 * its previous value, 85% of the old limit, so the guidance the model writes to
 * does not loosen; only the validation headroom grows. The target is declared
 * here, on the schema, so the prompt contract and the provider grammar read one
 * source. The reviewed specification restates the new limits (this module and it
 * may import only zod); workflowAssessmentSchemaCapacity.test.ts keeps them equal.
 */
export const WORKFLOW_ASSESSMENT_WRITING_TARGET_PREFIX = 'writing-target:' as const;
const targetedProse = (max: number, writingTarget: number) =>
  prose(max).describe(`${WORKFLOW_ASSESSMENT_WRITING_TARGET_PREFIX}${writingTarget}`);

/** An explicit writing target declared on a schema (any wrapper depth), or null when none is declared. */
export function declaredWritingTarget(schema: z.ZodTypeAny): number | null {
  let current: z.ZodTypeAny | undefined = schema;
  while (current) {
    const description = current._def.description as string | undefined;
    if (description?.startsWith(WORKFLOW_ASSESSMENT_WRITING_TARGET_PREFIX)) {
      const value = Number(description.slice(WORKFLOW_ASSESSMENT_WRITING_TARGET_PREFIX.length));
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid_writing_target:${description}`);
      return value;
    }
    current = current instanceof z.ZodEffects ? current._def.schema : undefined;
  }
  return null;
}

/**
 * Every condition that must hold for a described operation to be a credible
 * deterministic candidate. The provider reports each one; the runtime, not the
 * provider, decides what a missing condition means.
 */
const determinismBasisSchema = z.object({
  objectiveInputs: z.boolean(),
  explicitComparisonOrCalculation: z.boolean(),
  stableEvidenceSource: z.boolean(),
  deterministicOutput: z.boolean(),
  definedExceptionBehavior: z.boolean(),
  noUnresolvedSubjectiveJudgment: z.boolean(),
}).strict();

const determinismGapSchema = z.object({
  condition: z.enum(WORKFLOW_DETERMINISM_CONDITIONS),
  explanation: prose(400),
}).strict();

const determinismSupportSchema = z.object({
  condition: z.enum(WORKFLOW_DETERMINISM_CONDITIONS),
  sourceQuestion: z.enum(WORKFLOW_INTAKE_SOURCE_QUESTIONS),
  sourceExcerpt: prose(500),
  rationale: prose(400),
}).strict();

/**
 * A candidate rule specification in plain language. There is no field for code,
 * an expression, or a query: V1 produces system specification, not deployment.
 */
const ruleProposalSchema = z.object({
  ruleId: identifier,
  stepId: identifier,
  plainLanguageRule: targetedProse(1_000, 510),
  requiredFacts: z.array(prose(200)).min(1).max(12),
  conditionType: z.enum(WORKFLOW_RULE_CONDITION_TYPES),
  expectedEvidence: z.array(targetedProse(300, 170)).min(1).max(12),
  expectedOutcome: prose(400),
  userDescribedExceptions: z.array(prose(300)).max(12),
  unresolvedAssumptions: z.array(prose(300)).max(12),
}).strict();

/**
 * Descriptive capacity (2026-11-06 schema capacity review). Four limits were raised
 * on measured evidence from three complete live qualifications, and only on fields
 * that never enter the reviewed specification (REVIEWED_SPECIFICATION_SCHEMAS), so
 * the approval chain's bounds are unchanged:
 *   summary 1,200 -> 2,000 (observed 1,034 / 1,085 / 1,438, non-repetitive);
 *   evidenceRequirements item 200 -> 350 (largest single requirement 257 once
 *     items stopped being bundled);
 *   evidenceRelationships description 300 -> 600 (observed up to 420; this text
 *     becomes an FDE information need, whose waiver text is capped at 2,000);
 *   limitations 12 -> 16 items (every run reached the cap with distinct gaps).
 * Detail-record fields keep the bounds the reviewed specification mirrors;
 * changing one is an approval-chain contract change made on both sides at once.
 * D-6 (2026-11-06, owner-approved) is the one such change: the advisory
 * description 400 -> 800, on this schema and on reviewedAdvisorySpecification
 * together. Observed 667 / 533 / 523 / 454 / 410 (every run overran 400;
 * after decomposition it was the only residual failure in D3-D5). Both modules
 * are sealed to import only zod, so the bound is restated and kept equal by
 * the parity test in workflowAssessmentSchemaCapacity.test.ts.
 */
export const WorkflowAssessmentModelOutputSchema = z.object({
  summary: prose(2000),
  documents: z.array(z.object({
    documentId: identifier, name: prose(200), role: prose(300),
  }).strict()).max(24),
  workflowSteps: z.array(z.object({
    stepId: identifier,
    sourceQuestions: z.array(z.enum(WORKFLOW_INTAKE_SOURCE_QUESTIONS)).min(1).max(7),
    description: prose(600),
    classification: z.enum(WORKFLOW_STEP_CLASSIFICATIONS),
    rationale: prose(600),
    requiredInputs: z.array(prose(200)).max(12),
    evidenceRequirements: z.array(prose(350)).max(12),
    proposedOutput: prose(300),
    dependencies: z.array(identifier).max(12),
    failureConsequence: prose(400),
    unresolvedAssumptions: z.array(prose(300)).max(12),
    /** Required for RULE and VERIFY; rejected on every other class. */
    determinismBasis: determinismBasisSchema.nullable(),
    /** One exact keyed gap for each false determinism condition. */
    determinismGaps: z.array(determinismGapSchema).max(6),
    /** Intake-grounded support used by EightForge qualification, never authority. */
    determinismSupport: z.array(determinismSupportSchema).max(6),
  }).strict()).min(1).max(40),
  extractionRequirements: z.array(z.object({
    requirementId: identifier, stepId: identifier,
    describedFact: targetedProse(450, 255), sourceDocument: prose(200),
    deterministicExtractionPlausible: z.boolean(),
  }).strict()).max(40),
  deterministicRuleProposals: z.array(ruleProposalSchema).max(40),
  evidenceRelationships: z.array(z.object({
    relationshipId: identifier, description: prose(600),
    relatedDocuments: z.array(prose(200)).min(1).max(12),
  }).strict()).max(24),
  verificationRuleProposals: z.array(ruleProposalSchema).max(40),
  forgewingRecoveryTasks: z.array(z.object({
    taskId: identifier, stepId: identifier,
    description: prose(400), deterministicShortfall: prose(400),
  }).strict()).max(24),
  humanDecisionPoints: z.array(z.object({
    decisionId: identifier, stepId: identifier,
    description: targetedProse(600, 340), whyHumanControlled: prose(400),
  }).strict()).max(24),
  advisorySteps: z.array(z.object({
    advisoryId: identifier, stepId: identifier, description: targetedProse(1_200, 680),
  }).strict()).max(24),
  failureConsequences: z.array(z.object({
    consequenceId: identifier, stepId: identifier,
    description: prose(400), severity: z.enum(['low', 'moderate', 'high']),
  }).strict()).max(40),
  limitations: z.array(prose(300)).max(16),
}).strict();

export type WorkflowAssessmentModelOutput = z.infer<
  typeof WorkflowAssessmentModelOutputSchema
>;

export type WorkflowDeterminismBasis = z.infer<typeof determinismBasisSchema>;
