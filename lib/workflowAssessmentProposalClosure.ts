// lib/workflowAssessmentProposalClosure.ts
// The single answer to "is this assessment structurally composable?"
//
// A future resolver builds the effective reviewed specification by taking the
// original proposal wherever a step was accepted as proposed. That is only
// sound when each step has exactly one detail record of the right kind, no
// identifier is reused, and RECOVER carries its extraction requirement and
// recovery task. Otherwise "accept as proposed" would point at nothing, or at
// two things with no rule for choosing.
//
// New assessments are validated against these rules before persistence. But
// assessments persisted BEFORE those rules existed were never checked, and they
// are immutable -- so the same question has to be askable of a stored payload,
// months later, without re-running Forgewing.
//
// There is therefore exactly one implementation, used for both. A second copy
// would eventually disagree with the first, and the disagreement would surface
// as an operator approving a specification that cannot be composed.
//
// Pure: the only dependency is the canonical Zod-only schema. It reads a plain object, so it works equally on a
// freshly parsed model output and on a row read back out of the database.

import { WorkflowAssessmentModelOutputSchema } from '@/lib/workflowAssessmentSchema';

/** The subset of an assessment this validator needs. Deliberately loose: a
 *  historical payload may predate fields the current schema requires. */
type LooseStep = { stepId: string; classification: string };
type LooseDetail = { stepId: string } & Record<string, unknown>;

export type WorkflowAssessmentProposalClosure =
  | Readonly<{ compatible: true }>
  | Readonly<{ compatible: false; violations: readonly string[] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes identifiers at the boundary.
 *
 * A missing or non-string stepId becomes the empty string, which matches no
 * step and is therefore reported as an orphan detail. That is the fail-closed
 * reading: a payload whose links cannot be resolved is incompatible, not
 * crashing and not quietly skipped.
 */
function detailList(source: Record<string, unknown>, key: string): LooseDetail[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry) => ({
    ...entry,
    stepId: typeof entry.stepId === 'string' ? entry.stepId : '',
  }));
}

/** Structurally shaped view of an assessment, however it was obtained. */
type ClosureInput = {
  workflowSteps: Array<LooseStep & Record<string, unknown>>;
  extractionRequirements: LooseDetail[];
  deterministicRuleProposals: LooseDetail[];
  verificationRuleProposals: LooseDetail[];
  forgewingRecoveryTasks: LooseDetail[];
  humanDecisionPoints: LooseDetail[];
  advisorySteps: LooseDetail[];
  failureConsequences: LooseDetail[];
};

/** String identifiers only; anything else cannot link and is dropped. */
function ids(details: readonly LooseDetail[], key: string): string[] {
  return details
    .map((detail) => detail[key])
    .filter((value): value is string => typeof value === 'string');
}

function closureViolations(output: ClosureInput, acceptedStepIds?: ReadonlySet<string>): string[] {
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
  for (const step of output.workflowSteps) {
    if (acceptedStepIds && !acceptedStepIds.has(step.stepId)) continue;
    const dependencies = Array.isArray(step.dependencies)
      ? step.dependencies.filter((value): value is string => typeof value === 'string')
      : [];
    check('dependency', dependencies);
  }

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
  for (const requirement of output.extractionRequirements) {
    const classification = byId.get(requirement.stepId)?.classification;
    if (classification !== 'EXTRACT' && classification !== 'RECOVER') {
      violations.push(`extractionRequirementClassification:${requirement.requirementId}`);
    }
  }
  for (const task of output.forgewingRecoveryTasks) {
    if (byId.get(task.stepId)?.classification !== 'RECOVER') {
      violations.push(`recoveryTaskClassification:${task.taskId}`);
    }
  }
  for (const point of output.humanDecisionPoints) {
    if (byId.get(point.stepId)?.classification !== 'HUMAN') {
      violations.push(`humanDecisionClassification:${point.decisionId}`);
    }
  }
  for (const advisory of output.advisorySteps) {
    if (byId.get(advisory.stepId)?.classification !== 'ADVISORY') {
      violations.push(`advisoryStepClassification:${advisory.advisoryId}`);
    }
  }

  const countFor = (ids: readonly string[], stepId: string): number =>
    ids.filter((id) => id === stepId).length;
  for (const step of output.workflowSteps) {
    if (acceptedStepIds && !acceptedStepIds.has(step.stepId)) continue;
    const ruleCount = countFor(output.deterministicRuleProposals.map((p) => p.stepId), step.stepId);
    const verificationCount = countFor(output.verificationRuleProposals.map((p) => p.stepId), step.stepId);
    const extractionCount = countFor(output.extractionRequirements.map((r) => r.stepId), step.stepId);
    const recoveryCount = countFor(output.forgewingRecoveryTasks.map((r) => r.stepId), step.stepId);
    const humanCount = countFor(output.humanDecisionPoints.map((p) => p.stepId), step.stepId);
    const advisoryCount = countFor(output.advisorySteps.map((a) => a.stepId), step.stepId);
    // Exactly one, not "at least one". Two rule proposals for a single step
    // leave the specification ambiguous -- a later resolver composing the
    // effective reviewed specification would have to pick, and any choice would
    // be arbitrary. Missing and duplicate are both closure failures.
    const expectExactlyOne = (
      count: number, classifications: readonly string[], label: string,
    ): void => {
      if (!classifications.includes(step.classification)) return;
      if (count === 0) violations.push(`${step.stepId}:missing_${label}`);
      else if (count > 1) violations.push(`${step.stepId}:duplicate_${label}:${count}`);
    };

    expectExactlyOne(ruleCount, ['RULE'], 'rule_proposal');
    expectExactlyOne(verificationCount, ['VERIFY'], 'verification_proposal');
    expectExactlyOne(extractionCount, ['EXTRACT', 'RECOVER'], 'extraction_requirement');
    expectExactlyOne(recoveryCount, ['RECOVER'], 'recovery_task');
    expectExactlyOne(humanCount, ['HUMAN'], 'human_decision');
    expectExactlyOne(advisoryCount, ['ADVISORY'], 'advisory_detail');
  }

  // Detail identifiers must be globally unique within their own collection.
  // Two records sharing an id make provenance ambiguous even when each step's
  // count is correct.
  // Identifiers are unique across the WHOLE assessment, not merely within each
  // collection. A rule proposal and an extraction requirement sharing an id
  // makes provenance ambiguous the moment anything references the id alone,
  // and a resolver composing an effective specification would have no rule for
  // choosing between them.
  const seenIds = new Map<string, string>();
  for (const [label, values] of [
    ['rule_proposal', ids(output.deterministicRuleProposals, 'ruleId')],
    ['verification_proposal', ids(output.verificationRuleProposals, 'ruleId')],
    ['extraction_requirement', ids(output.extractionRequirements, 'requirementId')],
    ['recovery_task', ids(output.forgewingRecoveryTasks, 'taskId')],
    ['human_decision', ids(output.humanDecisionPoints, 'decisionId')],
    ['advisory_detail', ids(output.advisorySteps, 'advisoryId')],
  ] as const) {
    for (const id of values) {
      const previous = seenIds.get(id);
      if (previous !== undefined) {
        violations.push(`duplicate_detail_id:${id}:${previous}+${label}`);
      } else {
        seenIds.set(id, label);
      }
    }
  }
  // Step ids are already checked elsewhere; not repeated here.

  // RECOVER is only justified where deterministic extraction is insufficient.
  for (const requirement of output.extractionRequirements) {
    const step = byId.get(requirement.stepId);
    if (step?.classification === 'RECOVER' && requirement.deterministicExtractionPlausible) {
      violations.push(`recoverWithPlausibleExtraction:${requirement.requirementId}`);
    }
  }
  return violations;
}

/**
 * Reads any assessment payload into the shape the closure rules need.
 *
 * Missing collections become empty arrays rather than throwing: a historical
 * payload lacking a collection entirely is a closure failure to report, not a
 * crash.
 */
function toClosureInput(assessment: Record<string, unknown>): ClosureInput {
  const steps = (Array.isArray(assessment.workflowSteps)
    ? assessment.workflowSteps.filter(isRecord)
    : []).map((step) => ({
      ...step,
      stepId: typeof step.stepId === 'string' ? step.stepId : '',
      classification: typeof step.classification === 'string' ? step.classification : '',
    }));
  return {
    workflowSteps: steps,
    extractionRequirements: detailList(assessment, 'extractionRequirements'),
    deterministicRuleProposals: detailList(assessment, 'deterministicRuleProposals'),
    verificationRuleProposals: detailList(assessment, 'verificationRuleProposals'),
    forgewingRecoveryTasks: detailList(assessment, 'forgewingRecoveryTasks'),
    humanDecisionPoints: detailList(assessment, 'humanDecisionPoints'),
    advisorySteps: detailList(assessment, 'advisorySteps'),
    failureConsequences: detailList(assessment, 'failureConsequences'),
  };
}

/**
 * Whether an assessment's proposals can be composed into an effective reviewed
 * specification.
 *
 * Fail-closed: an assessment that predates the current closure rules is
 * reported incompatible rather than silently repaired. It stays immutable and
 * readable; what it loses is the right to be approved as proposed.
 */
export function resolveWorkflowAssessmentProposalClosure(
  assessment: unknown,
  options: Readonly<{ acceptedStepIds?: readonly string[] }> = {},
): WorkflowAssessmentProposalClosure {
  if (!isRecord(assessment)) {
    return { compatible: false, violations: ['assessment_not_an_object'] };
  }
  // Identity remains load-bearing even when every proposal is replaced: the
  // review still pins which step/classification in which immutable version was
  // replaced. Never coerce historical numeric identifiers into string links.
  const stepIdentitySchema = WorkflowAssessmentModelOutputSchema.shape.workflowSteps.element
    .pick({ stepId: true, classification: true });
  if (!Array.isArray(assessment.workflowSteps) || assessment.workflowSteps.length === 0) {
    return { compatible: false, violations: ['invalid_workflow_steps'] };
  }
  const violations: string[] = [];
  for (const [index, step] of assessment.workflowSteps.entries()) {
    const identity = isRecord(step) ? { stepId: step.stepId, classification: step.classification } : step;
    if (!stepIdentitySchema.safeParse(identity).success) violations.push(`invalid_step_identity:${index}`);
  }
  if (violations.length > 0) return { compatible: false, violations };

  const acceptedStepIds = options.acceptedStepIds === undefined
    ? undefined : new Set(options.acceptedStepIds);
  const output = toClosureInput(assessment);
  const knownIds = new Set(output.workflowSteps.map((step) => step.stepId));
  for (const id of acceptedStepIds ?? []) {
    if (!knownIds.has(id)) violations.push(`unknown_accepted_step:${id}`);
  }

  // Validate the exact canonical proposal schemas, including IDs, required
  // arrays, their items, and strict object fields. A complete typed replacement
  // does not depend on unused historical detail; accepted steps still do.
  for (const key of [
    'extractionRequirements', 'deterministicRuleProposals', 'verificationRuleProposals',
    'forgewingRecoveryTasks', 'humanDecisionPoints', 'advisorySteps', 'failureConsequences',
  ] as const) {
    const raw = assessment[key];
    const selected = acceptedStepIds === undefined
      ? raw ?? []
      : Array.isArray(raw)
        ? raw.filter((detail) => isRecord(detail)
          && typeof detail.stepId === 'string' && acceptedStepIds.has(detail.stepId))
        : [];
    const parsed = WorkflowAssessmentModelOutputSchema.shape[key].safeParse(selected);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        violations.push(`invalid_proposal_specification:${key}:${issue.path.join('.')}`);
      }
    }
    if (acceptedStepIds !== undefined) {
      output[key] = output[key].filter((detail) => acceptedStepIds.has(detail.stepId));
    }
  }
  violations.push(...closureViolations(output, acceptedStepIds));
  return violations.length === 0
    ? { compatible: true }
    : { compatible: false, violations };
}

export type AcceptedWorkflowProposalSource = Readonly<{
  collection: string;
  identityField: string;
  detailId: string;
}>;

export type AcceptedWorkflowProposal = Readonly<{
  stepId: string;
  specification: Record<string, unknown>;
  sources: readonly AcceptedWorkflowProposalSource[];
}>;

/**
 * Compose only closure-validated originals, using the projection contract of
 * workflow_accepted_proposal_specification. No values are parsed back, repaired,
 * or inferred. RECOVER consumes both details; all other classes strip only the
 * detail identity and step link. Keep this beside closure so callers cannot
 * accidentally select an arbitrary first match from ambiguous evidence.
 */
export function composeAcceptedWorkflowProposals(
  assessment: unknown,
  acceptedStepIds: readonly string[],
): Readonly<{ ok: true; proposals: readonly AcceptedWorkflowProposal[] }>
  | Readonly<{ ok: false; violations: readonly string[] }> {
  const closure = resolveWorkflowAssessmentProposalClosure(assessment, { acceptedStepIds });
  if (!closure.compatible) return { ok: false, violations: closure.violations };
  const output = toClosureInput(assessment as Record<string, unknown>);
  const selected = new Set(acceptedStepIds);
  const collections = {
    RULE: ['deterministicRuleProposals', 'ruleId'],
    VERIFY: ['verificationRuleProposals', 'ruleId'],
    EXTRACT: ['extractionRequirements', 'requirementId'],
    RECOVER: ['extractionRequirements', 'requirementId'],
    HUMAN: ['humanDecisionPoints', 'decisionId'],
    ADVISORY: ['advisorySteps', 'advisoryId'],
  } as const;
  const proposals = output.workflowSteps.filter((step) => selected.has(step.stepId))
    .map((step): AcceptedWorkflowProposal => {
      const [collection, identityField] = collections[step.classification as keyof typeof collections];
      // Closure proved exactly one matching, schema-valid detail.
      const detail = output[collection].find((item) => item.stepId === step.stepId)!;
      const sources: AcceptedWorkflowProposalSource[] = [{
        collection, identityField, detailId: detail[identityField] as string,
      }];
      let specification: Record<string, unknown>;
      if (step.classification === 'RECOVER') {
        const task = output.forgewingRecoveryTasks.find((item) => item.stepId === step.stepId)!;
        sources.push({ collection: 'forgewingRecoveryTasks', identityField: 'taskId', detailId: task.taskId as string });
        specification = {
          describedFact: detail.describedFact,
          sourceDocument: detail.sourceDocument,
          description: task.description,
          deterministicShortfall: task.deterministicShortfall,
        };
      } else {
        specification = Object.fromEntries(Object.entries(detail)
          .filter(([key]) => key !== 'stepId' && key !== identityField));
      }
      return { stepId: step.stepId, specification, sources };
    });
  return { ok: true, proposals };
}
