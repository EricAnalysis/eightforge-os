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

export const WORKFLOW_INTAKE_QUESTIONS = [
  'workflowDescription', 'documentsInvolved', 'manualChecks',
  'frequencyAndVolume', 'exceptions', 'humanDecisions',
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
  sourceQuestion: z.enum(WORKFLOW_INTAKE_QUESTIONS),
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
  plainLanguageRule: prose(600),
  requiredFacts: z.array(prose(200)).min(1).max(12),
  conditionType: z.enum(WORKFLOW_RULE_CONDITION_TYPES),
  expectedEvidence: z.array(prose(200)).min(1).max(12),
  expectedOutcome: prose(400),
  userDescribedExceptions: z.array(prose(300)).max(12),
  unresolvedAssumptions: z.array(prose(300)).max(12),
}).strict();

export const WorkflowAssessmentModelOutputSchema = z.object({
  summary: prose(1200),
  documents: z.array(z.object({
    documentId: identifier, name: prose(200), role: prose(300),
  }).strict()).max(24),
  workflowSteps: z.array(z.object({
    stepId: identifier,
    sourceQuestions: z.array(z.enum(WORKFLOW_INTAKE_QUESTIONS)).min(1).max(6),
    description: prose(600),
    classification: z.enum(WORKFLOW_STEP_CLASSIFICATIONS),
    rationale: prose(600),
    requiredInputs: z.array(prose(200)).max(12),
    evidenceRequirements: z.array(prose(200)).max(12),
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
    describedFact: prose(300), sourceDocument: prose(200),
    deterministicExtractionPlausible: z.boolean(),
  }).strict()).max(40),
  deterministicRuleProposals: z.array(ruleProposalSchema).max(40),
  evidenceRelationships: z.array(z.object({
    relationshipId: identifier, description: prose(300),
    relatedDocuments: z.array(prose(200)).min(1).max(12),
  }).strict()).max(24),
  verificationRuleProposals: z.array(ruleProposalSchema).max(40),
  forgewingRecoveryTasks: z.array(z.object({
    taskId: identifier, stepId: identifier,
    description: prose(400), deterministicShortfall: prose(400),
  }).strict()).max(24),
  humanDecisionPoints: z.array(z.object({
    decisionId: identifier, stepId: identifier,
    description: prose(400), whyHumanControlled: prose(400),
  }).strict()).max(24),
  advisorySteps: z.array(z.object({
    advisoryId: identifier, stepId: identifier, description: prose(400),
  }).strict()).max(24),
  failureConsequences: z.array(z.object({
    consequenceId: identifier, stepId: identifier,
    description: prose(400), severity: z.enum(['low', 'moderate', 'high']),
  }).strict()).max(40),
  limitations: z.array(prose(300)).max(12),
}).strict();

export type WorkflowAssessmentModelOutput = z.infer<
  typeof WorkflowAssessmentModelOutputSchema
>;

export type WorkflowDeterminismBasis = z.infer<typeof determinismBasisSchema>;
