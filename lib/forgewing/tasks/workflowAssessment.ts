import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  callClaudeForWorkflowAssessment,
  FORGEWING_WORKFLOW_ASSESSMENT_PROMPT_ID,
  FORGEWING_WORKFLOW_ASSESSMENT_PROMPT_VERSION,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';
import {
  getForgewingRuntimeConfig,
  isForgewingWorkflowAssessmentEnabled,
  type ForgewingRuntimeConfig,
} from '@/lib/forgewing/runtime/modelConfig';
import {
  parseWorkflowAssessmentModelOutput,
  WORKFLOW_INTAKE_QUESTIONS,
  WORKFLOW_STEP_CLASSIFICATIONS,
  type WorkflowAssessmentModelOutput,
} from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';

export const FORGEWING_WORKFLOW_ASSESSMENT_SCHEMA_VERSION =
  'workflow_assessment_v1' as const;

/** Classes whose proposal asserts deterministic execution is plausible. */
const DETERMINISTIC_CLASSIFICATIONS: ReadonlySet<string> = new Set(['RULE', 'VERIFY']);

export { WORKFLOW_INTAKE_QUESTIONS, WORKFLOW_STEP_CLASSIFICATIONS };

const identifier = z.string().min(1).max(120)
  .refine((value) => value.trim() === value, 'identifier whitespace');

export type WorkflowDeterminismBasis =
  NonNullable<WorkflowAssessmentModelOutput['workflowSteps'][number]['determinismBasis']>;


/**
 * The persisted assessment. Authority markers are literals, not provider
 * fields: the model cannot describe itself as authoritative because there is no
 * accepted shape in which it could.
 */
export type ForgewingWorkflowAssessment = Readonly<{
  schemaVersion: typeof FORGEWING_WORKFLOW_ASSESSMENT_SCHEMA_VERSION;
  assessmentId: string;
  sourceSubmissionId: string;
  sourceSubmissionSchemaVersion: string;
  sourceSubmissionDigestSha256: string;
  authority: 'non_authoritative';
  requiresHumanReview: true;
  automationAssessment: WorkflowAutomationAssessment;
}> & WorkflowAssessmentModelOutput;

/**
 * Counts first, percentages derived from them, and the denominator named
 * explicitly. A percentage without its basis is false precision.
 */
export type WorkflowAutomationAssessment = Readonly<{
  basis: 'classified_workflow_steps';
  totalSteps: number;
  countsByClassification: Readonly<Record<
    (typeof WORKFLOW_STEP_CLASSIFICATIONS)[number], number
  >>;
  percentagesByClassification: Readonly<Record<
    (typeof WORKFLOW_STEP_CLASSIFICATIONS)[number], number
  >>;
  /** RULE + VERIFY over total steps: candidate deterministic execution only. */
  deterministicCandidateSteps: number;
  deterministicCandidatePercentage: number;
  stepsWithUnresolvedAssumptions: number;
}>;

export type ForgewingWorkflowAssessmentInput = Readonly<{
  submissionId: string;
  submissionSchemaVersion: string;
  answers: Readonly<Record<(typeof WORKFLOW_INTAKE_QUESTIONS)[number], string>>;
}>;

const inputSchema = z.object({
  submissionId: identifier,
  submissionSchemaVersion: z.literal('workflow_intake_v1'),
  answers: z.object(Object.fromEntries(
    WORKFLOW_INTAKE_QUESTIONS.map((key) => [key, z.string().min(1).max(5000)]),
  ) as Record<(typeof WORKFLOW_INTAKE_QUESTIONS)[number], z.ZodString>).strict(),
}).strict();

export type ForgewingWorkflowAssessmentResult =
  | Readonly<{ status: 'assessment_disabled' }>
  | Readonly<{ status: 'input_invalid'; reason: string }>
  | Readonly<{ status: 'provider_failed'; reason: string }>
  | Readonly<{ status: 'structured_output_invalid'; reason: string }>
  | Readonly<{ status: 'deterministic_validation_failed'; reason: string }>
  | Readonly<{
      status: 'requires_human_review';
      assessment: ForgewingWorkflowAssessment;
      metadata: Readonly<{
        model: string;
        promptTemplateId: typeof FORGEWING_WORKFLOW_ASSESSMENT_PROMPT_ID;
        promptTemplateVersion: typeof FORGEWING_WORKFLOW_ASSESSMENT_PROMPT_VERSION;
        calls: number;
      }>;
    }>;

export type ForgewingWorkflowAssessmentDependencies = Readonly<{
  config?: ForgewingRuntimeConfig;
  taskEnabled?: boolean;
  provider?: ForgewingProvider;
  budget?: ForgewingCallBudget;
}>;

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error && typeof error === 'object' ? error.constructor?.name ?? '' : '';
  if (message === 'provider_timeout' || message === 'Request timed out'
    || name === 'APIConnectionTimeoutError') return 'provider_timeout';
  if (message.includes('ANTHROPIC_API_KEY')) return 'anthropic_not_configured';
  return message || 'provider_error';
}

async function callWithin(
  provider: ForgewingProvider,
  request: Parameters<ForgewingProvider>[0],
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider_timeout')), request.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The determinism trust gate.
 *
 * A step is not deterministic because it sounds rules-based. RULE and VERIFY
 * must carry a complete determinism basis, and if any condition fails the step
 * must record what is unresolved rather than assert clean automation. Steps
 * outside those classes must not carry a basis at all, so the field cannot be
 * used to smuggle implied determinism into a HUMAN or ADVISORY step.
 */
function determinismViolations(
  steps: WorkflowAssessmentModelOutput['workflowSteps'],
): string[] {
  const violations: string[] = [];
  for (const step of steps) {
    const deterministic = DETERMINISTIC_CLASSIFICATIONS.has(step.classification);
    if (!deterministic) {
      if (step.determinismBasis !== null) {
        violations.push(`${step.stepId}:determinism_basis_on_non_deterministic_step`);
      }
      continue;
    }
    if (step.determinismBasis === null) {
      violations.push(`${step.stepId}:missing_determinism_basis`);
      continue;
    }
    const unmet = Object.entries(step.determinismBasis)
      .filter(([, met]) => !met)
      .map(([condition]) => condition);
    if (unmet.length > 0 && step.unresolvedAssumptions.length === 0) {
      violations.push(`${step.stepId}:unmet_determinism_without_recorded_assumption`);
    }
  }
  return violations;
}

/** Every referenced stepId must exist: no proposal may float free of a step. */
function referenceViolations(output: WorkflowAssessmentModelOutput): string[] {
  const stepIds = new Set(output.workflowSteps.map((step) => step.stepId));
  if (stepIds.size !== output.workflowSteps.length) return ['duplicate_step_id'];
  const violations: string[] = [];
  const check = (label: string, ids: readonly string[]): void => {
    for (const id of ids) if (!stepIds.has(id)) violations.push(`${label}:${id}`);
  };
  check('extractionRequirement', output.extractionRequirements.map((e) => e.stepId));
  check('ruleProposal', output.deterministicRuleProposals.map((e) => e.stepId));
  check('verificationProposal', output.verificationRuleProposals.map((e) => e.stepId));
  check('recoveryTask', output.forgewingRecoveryTasks.map((e) => e.stepId));
  check('humanDecision', output.humanDecisionPoints.map((e) => e.stepId));
  check('advisoryStep', output.advisorySteps.map((e) => e.stepId));
  check('failureConsequence', output.failureConsequences.map((e) => e.stepId));
  for (const step of output.workflowSteps) check('dependency', step.dependencies);

  // A rule proposal asserts deterministic execution, so it may only attach to a
  // step actually classified that way.
  const byId = new Map(output.workflowSteps.map((step) => [step.stepId, step]));
  for (const proposal of output.deterministicRuleProposals) {
    if (byId.get(proposal.stepId)?.classification !== 'RULE') {
      violations.push(`ruleProposalClassification:${proposal.ruleId}`);
    }
  }
  for (const proposal of output.verificationRuleProposals) {
    if (byId.get(proposal.stepId)?.classification !== 'VERIFY') {
      violations.push(`verificationProposalClassification:${proposal.ruleId}`);
    }
  }
  // RECOVER is only justified where deterministic extraction is insufficient.
  for (const requirement of output.extractionRequirements) {
    const step = byId.get(requirement.stepId);
    if (step?.classification === 'RECOVER' && requirement.deterministicExtractionPlausible) {
      violations.push(`recoverWithPlausibleExtraction:${requirement.requirementId}`);
    }
  }
  return violations;
}

/** Counts drive the percentages; nothing here is estimated. */
function automationAssessment(
  steps: WorkflowAssessmentModelOutput['workflowSteps'],
): WorkflowAutomationAssessment {
  const counts = Object.fromEntries(
    WORKFLOW_STEP_CLASSIFICATIONS.map((classification) => [
      classification,
      steps.filter((step) => step.classification === classification).length,
    ]),
  ) as Record<(typeof WORKFLOW_STEP_CLASSIFICATIONS)[number], number>;
  const total = steps.length;
  const percent = (count: number): number =>
    total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
  const deterministicCandidateSteps = counts.RULE + counts.VERIFY;
  return Object.freeze({
    basis: 'classified_workflow_steps' as const,
    totalSteps: total,
    countsByClassification: Object.freeze(counts),
    percentagesByClassification: Object.freeze(Object.fromEntries(
      WORKFLOW_STEP_CLASSIFICATIONS.map((c) => [c, percent(counts[c])]),
    ) as Record<(typeof WORKFLOW_STEP_CLASSIFICATIONS)[number], number>),
    deterministicCandidateSteps,
    deterministicCandidatePercentage: percent(deterministicCandidateSteps),
    stepsWithUnresolvedAssumptions:
      steps.filter((step) => step.unresolvedAssumptions.length > 0).length,
  });
}

/**
 * Produces a non-authoritative candidate system specification from ONE
 * immutable intake submission.
 *
 * The caller supplies the persisted submission; this module never accepts
 * browser-supplied prose, never reads or writes a database, and never emits
 * executable rule logic. Its output is a proposal that a person must review.
 */
export async function runForgewingWorkflowAssessment(
  rawInput: ForgewingWorkflowAssessmentInput,
  dependencies: ForgewingWorkflowAssessmentDependencies = {},
): Promise<ForgewingWorkflowAssessmentResult> {
  const config = dependencies.config ?? getForgewingRuntimeConfig();
  if (!config.enabled
    || !(dependencies.taskEnabled ?? isForgewingWorkflowAssessmentEnabled())) {
    return { status: 'assessment_disabled' };
  }
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { status: 'input_invalid', reason: 'submission_identity_closure_failed' };
  }

  const bounded = Object.freeze({
    task: 'workflow_assessment' as const,
    submissionId: parsed.data.submissionId,
    submissionSchemaVersion: parsed.data.submissionSchemaVersion,
    answers: parsed.data.answers,
  });
  const sourceSubmissionDigestSha256 = hashCanonical(bounded);

  const budget = dependencies.budget ?? new ForgewingCallBudget(1);
  if (!budget.tryConsume()) {
    return { status: 'provider_failed', reason: 'budget_exhausted' };
  }

  let raw: string;
  try {
    raw = await callWithin(dependencies.provider ?? callClaudeForWorkflowAssessment, {
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      inputJson: canonicalJson(bounded),
    });
  } catch (error) {
    const reason = failureReason(error);
    return reason === 'provider_truncated_output'
      ? { status: 'structured_output_invalid', reason }
      : { status: 'provider_failed', reason };
  }

  let output: WorkflowAssessmentModelOutput;
  try {
    output = parseWorkflowAssessmentModelOutput(raw);
  } catch (error) {
    return { status: 'structured_output_invalid', reason: failureReason(error) };
  }

  const violations = [...determinismViolations(output.workflowSteps), ...referenceViolations(output)];
  if (violations.length > 0) {
    return { status: 'deterministic_validation_failed', reason: violations.slice(0, 8).join(',') };
  }

  const assessment: ForgewingWorkflowAssessment = Object.freeze({
    ...output,
    schemaVersion: FORGEWING_WORKFLOW_ASSESSMENT_SCHEMA_VERSION,
    assessmentId: `forgewing-workflow-assessment-${sourceSubmissionDigestSha256.slice(0, 32)}`,
    sourceSubmissionId: parsed.data.submissionId,
    sourceSubmissionSchemaVersion: parsed.data.submissionSchemaVersion,
    sourceSubmissionDigestSha256,
    authority: 'non_authoritative' as const,
    requiresHumanReview: true as const,
    automationAssessment: automationAssessment(output.workflowSteps),
  });

  return {
    status: 'requires_human_review',
    assessment,
    metadata: {
      model: config.model,
      promptTemplateId: FORGEWING_WORKFLOW_ASSESSMENT_PROMPT_ID,
      promptTemplateVersion: FORGEWING_WORKFLOW_ASSESSMENT_PROMPT_VERSION,
      calls: budget.used,
    },
  };
}
