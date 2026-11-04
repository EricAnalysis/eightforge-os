import { hashCanonical } from '@/lib/extraction/domain/hash';
import { CAPABILITY_CATALOGUE, CAPABILITY_CATALOGUE_VERSION, capabilityCatalogueIdentity } from '@/lib/projectIntelligence/capabilityCatalogue';
import { FDE_LADDER_RUNGS, allFdeFollowUps, buildFdeReadinessPlan, matchingFileCandidates, type FdeLadderRung, type FdeSuppliedFile } from '@/lib/projectIntelligence/fdeReadiness';
import { REVIEWED_SPECIFICATION_FIELDS, type ReviewedClassification } from '@/lib/workflowReviewedSpecification';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter(record) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const pick = (value: unknown, keys: readonly string[]): RecordValue => Object.fromEntries(
  keys.map((key) => [key, record(value) && value[key] !== undefined ? value[key] : null]),
);
const pickedRecords = (value: unknown, keys: readonly string[]) => records(value).map((entry) => pick(entry, keys));

/** Only persisted assessment fields that can describe or qualify this workflow. */
function assessmentSnapshot(assessment: RecordValue): RecordValue {
  const ruleFields = ['ruleId', 'stepId', 'plainLanguageRule', 'requiredFacts', 'conditionType', 'expectedEvidence', 'expectedOutcome', 'userDescribedExceptions', 'unresolvedAssumptions'];
  return {
    ...pick(assessment, ['schemaVersion', 'sourceSubmissionDigestSha256', 'summary', 'limitations']),
    documents: pickedRecords(assessment.documents, ['documentId', 'name', 'role']),
    workflowSteps: records(assessment.workflowSteps).map((step) => ({
      ...pick(step, ['stepId', 'sourceQuestions', 'description', 'classification', 'rationale', 'requiredInputs', 'evidenceRequirements', 'proposedOutput', 'dependencies', 'failureConsequence', 'unresolvedAssumptions']),
      determinismBasis: step.determinismBasis == null ? null : pick(step.determinismBasis, ['objectiveInputs', 'explicitComparisonOrCalculation', 'stableEvidenceSource', 'deterministicOutput', 'definedExceptionBehavior', 'noUnresolvedSubjectiveJudgment']),
      determinismGaps: pickedRecords(step.determinismGaps, ['condition', 'explanation']),
      determinismSupport: pickedRecords(step.determinismSupport, ['condition', 'sourceQuestion', 'sourceExcerpt', 'rationale']),
    })),
    extractionRequirements: pickedRecords(assessment.extractionRequirements, ['requirementId', 'stepId', 'describedFact', 'sourceDocument', 'deterministicExtractionPlausible']),
    deterministicRuleProposals: pickedRecords(assessment.deterministicRuleProposals, ruleFields),
    verificationRuleProposals: pickedRecords(assessment.verificationRuleProposals, ruleFields),
    evidenceRelationships: pickedRecords(assessment.evidenceRelationships, ['relationshipId', 'description', 'relatedDocuments']),
    forgewingRecoveryTasks: pickedRecords(assessment.forgewingRecoveryTasks, ['taskId', 'stepId', 'description', 'deterministicShortfall']),
    humanDecisionPoints: pickedRecords(assessment.humanDecisionPoints, ['decisionId', 'stepId', 'description', 'whyHumanControlled']),
    advisorySteps: pickedRecords(assessment.advisorySteps, ['advisoryId', 'stepId', 'description']),
    failureConsequences: pickedRecords(assessment.failureConsequences, ['consequenceId', 'stepId', 'description', 'severity']),
    determinismQualifications: pickedRecords(assessment.determinismQualifications, ['stepId', 'state', 'reasons']),
  };
}

function reviewSnapshot(review: NonNullable<FdeIntakePlanInput['existingReview']>): RecordValue {
  return {
    reviewId: review.reviewId, reviewVersion: review.reviewVersion,
    overallDisposition: review.overallDisposition, reviewerSummary: review.reviewerSummary ?? null,
    stepReviews: [...(review.stepReviews ?? [])].sort((a, b) => compare(a.assessmentStepId, b.assessmentStepId)).map((step) => {
      const fields = REVIEWED_SPECIFICATION_FIELDS[step.reviewedClassification as ReviewedClassification];
      return {
        ...pick(step, ['assessmentStepId', 'proposedClassification', 'reviewedClassification', 'disposition', 'reviewerNotes']),
        acceptedSpecification: step.acceptedSpecification && fields
          ? pick(step.acceptedSpecification, fields.map((field) => field.name)) : null,
      };
    }),
  };
}

export type FdeIntakeFile = FdeSuppliedFile & Readonly<{
  attachmentId: string;
  sourceSha256?: string | null;
  representationDigestSha256?: string | null;
  contextDigest?: string | null;
  limitations?: readonly string[];
}>;
export type FdeIntakeAnswer = Readonly<{
  answerId: string; followUpId: string; answer: string; answerSource: string;
  evidenceAttachmentIds: readonly string[]; revision: number;
  assessmentId: string; assessmentVersion: number;
}>;
export type FdeIntakePlanInput = Readonly<{
  assessmentId: string;
  assessmentVersion: number;
  sourceSubmissionId: string;
  intake: Readonly<Record<string, string>>;
  assessment: unknown;
  suppliedFiles: readonly FdeIntakeFile[];
  /** A failed or inconsistent attachment read is not evidence that a source was omitted. */
  attachmentEvidenceUnavailable?: boolean;
  manifestAttachments?: readonly Readonly<{ attachmentId: string; sourceSha256: string; representationDigestSha256: string }>[];
  /** Null means the answer read failed; fail closed rather than treating it as an empty result. */
  answers: readonly FdeIntakeAnswer[] | null;
  existingReview?: Readonly<{
    reviewId: string; reviewVersion: number; overallDisposition: string;
    reviewerSummary?: string | null;
    stepReviews?: readonly Readonly<{
      assessmentStepId: string; proposedClassification: string; reviewedClassification: string | null;
      disposition: string; reviewerNotes: string | null;
      acceptedSpecification: Record<string, unknown> | null;
    }>[];
  }> | null;
}>;

export type FdeInformationState = 'not_supplied' | 'supplied_uninterpreted' | 'evidence_unavailable' | 'requires_clarification' | 'requires_relationship' | 'conflicting' | 'confirmed' | 'missing_human_decision';
export type FdeIntakePlan = Readonly<{
  schemaVersion: 'fde_intake_plan_v1';
  authority: 'non_authoritative';
  pinnedInputs: Readonly<{
    assessmentId: string; assessmentVersion: number; sourceSubmissionId: string;
    assessmentDigest: string; intakeDigest: string;
    manifestAttachments: readonly Readonly<{ attachmentId: string; sourceSha256: string; representationDigestSha256: string }>[];
    suppliedFiles: readonly Readonly<{
      attachmentId: string; filename: string; sourceSha256: string | null;
      representationDigestSha256: string | null; contextDigest: string;
    }>[];
    answers: readonly Readonly<{ answerId: string; followUpId: string; revision: number; assessmentId: string; assessmentVersion: number; digest: string }>[];
    assessmentReview: Readonly<{ reviewId: string; reviewVersion: number; digest: string }> | null;
    capabilityCatalogue: Readonly<{ version: typeof CAPABILITY_CATALOGUE_VERSION; identity: string }>;
  }>;
  workflowUnderstanding: Readonly<{
    objective: string | null; existingProcess: string | null; expectedOutcome: string | null;
    requiredInputs: readonly string[]; expectedOutputs: readonly string[];
    proposedBusinessRules: readonly string[]; humanDecisions: readonly string[];
    state: 'partially_understood' | 'understood';
  }>;
  supportingEvidence: readonly Readonly<{ kind: 'assessment' | 'intake' | 'attachment' | 'follow_up_answer' | 'capability_catalogue' | 'assessment_review'; id: string; detail: string }> [];
  informationNeeds: readonly Readonly<{ state: FdeInformationState; description: string; stepId: string | null; sourceIds: readonly string[] }> [];
  capabilityMatches: readonly Readonly<{
    stepId: string; requirement: string; capabilityId: string | null; catalogueVersion: typeof CAPABILITY_CATALOGUE_VERSION;
    status: string | null; configurationRequirements: readonly string[]; knownLimitations: readonly string[];
    supportingComponents: readonly string[]; supportingEvidenceIds: readonly string[];
    requiredEvidence: readonly string[]; unresolvedQuestions: readonly string[];
  }> [];
  deploymentApproach: Readonly<{
    rung: FdeLadderRung | null; state: 'candidate_pending_review' | 'undetermined';
    rationale: string; lowerRungsToRuleOut: readonly FdeLadderRung[];
    steps: readonly Readonly<{ stepId: string; rung: FdeLadderRung | null; basis: string; lowerRungsToRuleOut: readonly FdeLadderRung[] }> [];
  }>;
  affectedSystems: readonly string[];
  engineeringRequirements: readonly Readonly<{ stepId: string; kind: FdeLadderRung; description: string }> [];
  validationRequirements: readonly string[];
  humanReview: Readonly<{
    planState: 'pending_review'; approvedDeploymentRecommendation: false;
    assessmentReview: Readonly<{ reviewId: string; reviewVersion: number; disposition: string }> | null;
    requiredDecision: string;
  }>;
  readiness: Readonly<{ state: 'needs_follow_up' | 'pending_review'; blockers: readonly string[] }>;
}>;

/** Pure, read-only projection. Submitted answers and an accepted assessment review do not approve this plan. */
export function buildFdeIntakePlan(input: FdeIntakePlanInput): FdeIntakePlan | null {
  if (!record(input.assessment)) return null;
  const files = [...input.suppliedFiles].sort((a, b) => compare(a.attachmentId, b.attachmentId) || compare(a.filename, b.filename));
  const manifest = [...(input.manifestAttachments ?? [])].sort((a, b) => compare(a.attachmentId, b.attachmentId));
  const catalogueIdentity = capabilityCatalogueIdentity();
  const readiness = buildFdeReadinessPlan(input.assessment, files);
  if (!readiness) return null;
  const assessment = input.assessment;
  const steps = records(assessment.workflowSteps);
  const requested = allFdeFollowUps(assessment);
  const requestedIds = new Set(requested.map((question) => question.followUpId));
  const latest = new Map<string, FdeIntakeAnswer>();
  for (const answer of input.answers ?? []) {
    // Follow-up IDs are stable across versions of one submission. The read seam has
    // already scoped answers to that submission; retain a prior-version answer if
    // the current assessment still asks exactly the same question.
    if (!requestedIds.has(answer.followUpId) || answer.assessmentVersion > input.assessmentVersion) continue;
    const prior = latest.get(answer.followUpId);
    if (!prior || answer.revision > prior.revision || (answer.revision === prior.revision && compare(answer.answerId, prior.answerId) > 0)) latest.set(answer.followUpId, answer);
  }
  const latestAnswers = [...latest.values()].sort((a, b) => compare(a.followUpId, b.followUpId));
  const informationNeeds: FdeIntakePlan['informationNeeds'][number][] = requested.map((question) => {
    const answer = latest.get(question.followUpId);
    return {
      state: answer ? 'supplied_uninterpreted' : 'requires_clarification',
      description: question.question, stepId: question.stepId,
      sourceIds: answer ? [answer.answerId, ...new Set(answer.evidenceAttachmentIds)].sort(compare) : [input.assessmentId],
    };
  });
  const matchedFileIds = new Set<string>();
  for (const source of readiness.evidenceCompleteness.describedSources) {
    // Filename similarity only suggests an inspection target. It does not prove
    // that the needed content is present, read, or authoritative.
    const candidates = matchingFileCandidates(source.name, files);
    candidates.forEach((file) => matchedFileIds.add(file.attachmentId));
    const state: FdeInformationState = input.attachmentEvidenceUnavailable ? 'evidence_unavailable'
      : candidates.length > 0 ? 'supplied_uninterpreted'
      : files.length > 0 ? 'requires_clarification' : 'not_supplied';
    informationNeeds.push({ state, description: source.name, stepId: null,
      sourceIds: candidates.length > 0 ? candidates.map((file) => file.attachmentId)
        : input.attachmentEvidenceUnavailable ? manifest.map((file) => file.attachmentId)
          : files.length > 0 ? files.map((file) => file.attachmentId) : [input.assessmentId] });
  }
  for (const file of files.filter((entry) => !matchedFileIds.has(entry.attachmentId))) {
    informationNeeds.push({ state: 'supplied_uninterpreted', description: `Inspect supplied file ${file.filename} for relevant workflow information`, stepId: null, sourceIds: [file.attachmentId] });
  }
  for (const file of files.filter((entry) => entry.truncated || (entry.limitations?.length ?? 0) > 0)) {
    const limitations = file.limitations?.join('; ');
    const description = file.truncated
      ? `Review partially processed document ${file.filename}: only part of the document was processed${limitations ? `; ${limitations}` : ''}`
      : `Review parser limitations for ${file.filename}: ${limitations}`;
    informationNeeds.push({ state: 'supplied_uninterpreted', description, stepId: null, sourceIds: [file.attachmentId] });
  }
  if (input.attachmentEvidenceUnavailable) informationNeeds.push({
    state: 'evidence_unavailable', description: 'Stored attachment evidence could not be read or reconciled; inspect the existing submission before requesting another source',
    stepId: null, sourceIds: manifest.map((file) => file.attachmentId),
  });
  for (const relationship of records(assessment.evidenceRelationships)) {
    if (str(relationship.description)) informationNeeds.push({ state: 'requires_relationship', description: str(relationship.description), stepId: null, sourceIds: [input.assessmentId] });
  }
  for (const limitation of readiness.workflowUnderstood.limitations) {
    informationNeeds.push({ state: /\b(conflict|contradic|inconsisten)/iu.test(limitation) ? 'conflicting' : 'requires_clarification', description: limitation, stepId: null, sourceIds: [input.assessmentId] });
  }
  // A described human-held decision is a workflow boundary, not evidence it is missing.
  for (const step of steps.filter((entry) => entry.classification === 'HUMAN')) {
    if (!records(assessment.humanDecisionPoints).some((entry) => entry.stepId === step.stepId)) {
      informationNeeds.push({ state: 'missing_human_decision', description: str(step.description), stepId: str(step.stepId), sourceIds: [input.assessmentId] });
    }
  }
  if (!input.intake.workflowDescription) informationNeeds.push({ state: 'not_supplied', description: 'Customer workflow objective', stepId: null, sourceIds: [input.sourceSubmissionId] });
  if (!input.intake.successOutcome && !steps.some((step) => str(step.proposedOutput))) informationNeeds.push({ state: 'not_supplied', description: 'Expected workflow output', stepId: null, sourceIds: [input.sourceSubmissionId] });
  if (input.answers === null) informationNeeds.push({ state: 'requires_clarification', description: 'Stored follow-up answers could not be read', stepId: null, sourceIds: [input.assessmentId] });
  const stepReviews = new Map((input.existingReview?.stepReviews ?? []).map((step) => [step.assessmentStepId, step]));
  const conflictingStepIds = new Set<string>();
  for (const step of steps) {
    const stepId = str(step.stepId);
    const reviewed = stepReviews.get(stepId);
    if (!reviewed || (reviewed.disposition === 'accepted' && reviewed.reviewedClassification === step.classification)) continue;
    conflictingStepIds.add(stepId);
    informationNeeds.push({ state: 'conflicting', description: `Assessment review ${reviewed.disposition} step ${stepId}; reconcile the reviewed specification before planning deployment`,
      stepId, sourceIds: [input.existingReview!.reviewId, input.assessmentId] });
  }
  if (input.existingReview && input.existingReview.overallDisposition !== 'accepted' && conflictingStepIds.size === 0) {
    informationNeeds.push({ state: 'conflicting', description: 'Assessment review requires changes before this proposed workflow can be used for deployment planning',
      stepId: null, sourceIds: [input.existingReview.reviewId, input.assessmentId] });
  }
  for (const step of readiness.steps) {
    if (step.deployment?.capability?.status !== 'requires_owner_activation') continue;
    informationNeeds.push({ state: 'missing_human_decision', description: `Owner activation is required for ${step.deployment.capability.capabilityId}`,
      stepId: step.stepId, sourceIds: [input.assessmentId, catalogueIdentity] });
  }
  const capabilityMatches = readiness.steps.map((step) => {
    const sourceStep = steps.find((candidate) => candidate.stepId === step.stepId);
    const candidate = CAPABILITY_CATALOGUE.find((entry) => entry.capabilityId === step.deployment?.capability?.capabilityId);
    return {
      stepId: step.stepId, requirement: str(sourceStep?.description), capabilityId: candidate?.capabilityId ?? null,
      catalogueVersion: CAPABILITY_CATALOGUE_VERSION,
      status: candidate?.status ?? null,
      configurationRequirements: candidate?.configurationRequirements ?? [], knownLimitations: candidate?.knownLimitations ?? [],
      supportingComponents: candidate?.deterministicComponents ?? [],
      supportingEvidenceIds: candidate ? [input.assessmentId, capabilityCatalogueIdentity()] : [input.assessmentId],
      requiredEvidence: candidate?.requiredEvidence ?? [],
      unresolvedQuestions: informationNeeds.filter((need) => need.stepId === step.stepId && need.state !== 'confirmed').map((need) => need.description),
    };
  });
  const proposed = readiness.steps.filter((step) => step.deployment !== null && !conflictingStepIds.has(step.stepId));
  const actionable = proposed.filter((step) => step.classification !== 'ADVISORY');
  const blocked = informationNeeds.some((need) => need.state !== 'confirmed') || readiness.evidenceCompleteness.truncatedFiles.length > 0;
  const ladder: readonly FdeLadderRung[] = FDE_LADDER_RUNGS;
  const rung = blocked || actionable.length === 0 ? null : actionable.reduce<FdeLadderRung | null>((highest, step) => {
    const current = step.deployment!.rung;
    return highest === null || ladder.indexOf(current) > ladder.indexOf(highest) ? current : highest;
  }, null);
  const engineeringRequirements = proposed.filter((step) => step.deployment!.rung !== 'existing_capability').map((step) => ({
    stepId: step.stepId, kind: step.deployment!.rung,
    description: step.basis,
  }));
  const blockers = [
    ...informationNeeds.map((need) => `${need.state}: ${need.description}`),
    ...readiness.evidenceCompleteness.truncatedFiles.map((name) => `truncated_evidence: ${name}`),
  ];
  return {
    schemaVersion: 'fde_intake_plan_v1', authority: 'non_authoritative',
    pinnedInputs: {
      assessmentId: input.assessmentId, assessmentVersion: input.assessmentVersion, sourceSubmissionId: input.sourceSubmissionId,
      assessmentDigest: hashCanonical(assessmentSnapshot(assessment)),
      intakeDigest: hashCanonical(pick(input.intake, ['workflowDescription', 'documentsInvolved', 'informationOrSystems', 'manualChecks', 'frequencyAndVolume', 'exceptions', 'humanDecisions', 'successOutcome'])),
      manifestAttachments: manifest,
      suppliedFiles: files.map((file) => ({
        attachmentId: file.attachmentId, filename: file.filename,
        sourceSha256: file.sourceSha256 ?? null,
        representationDigestSha256: file.representationDigestSha256 ?? null,
        contextDigest: file.contextDigest ?? hashCanonical({ sectionLabels: file.sectionLabels, truncated: file.truncated, limitations: file.limitations ?? [] }),
      })),
      answers: latestAnswers.map((answer) => ({
        answerId: answer.answerId, followUpId: answer.followUpId, revision: answer.revision,
        assessmentId: answer.assessmentId, assessmentVersion: answer.assessmentVersion,
        digest: hashCanonical({ answerId: answer.answerId, followUpId: answer.followUpId,
          answer: answer.answer, answerSource: answer.answerSource,
          evidenceAttachmentIds: [...new Set(answer.evidenceAttachmentIds)].sort(compare),
          revision: answer.revision, assessmentId: answer.assessmentId, assessmentVersion: answer.assessmentVersion }),
      })),
      assessmentReview: input.existingReview ? {
        reviewId: input.existingReview.reviewId, reviewVersion: input.existingReview.reviewVersion,
        digest: hashCanonical(reviewSnapshot(input.existingReview)),
      } : null,
      capabilityCatalogue: { version: CAPABILITY_CATALOGUE_VERSION, identity: catalogueIdentity },
    },
    workflowUnderstanding: {
      objective: input.intake.workflowDescription || null, existingProcess: input.intake.manualChecks || null,
      expectedOutcome: input.intake.successOutcome || null,
      requiredInputs: [...new Set(steps.flatMap((step) => strings(step.requiredInputs)))],
      expectedOutputs: [...new Set(steps.map((step) => str(step.proposedOutput)).filter(Boolean))],
      proposedBusinessRules: [...records(assessment.deterministicRuleProposals), ...records(assessment.verificationRuleProposals)].map((proposal) => str(proposal.plainLanguageRule)).filter(Boolean),
      humanDecisions: readiness.unresolvedHumanDecisions,
      state: blocked ? 'partially_understood' : 'understood',
    },
    supportingEvidence: [
      { kind: 'assessment', id: input.assessmentId, detail: `Version ${input.assessmentVersion}` },
      { kind: 'intake', id: input.sourceSubmissionId, detail: 'Stored workflow intake' },
      ...files.map((file) => ({ kind: 'attachment' as const, id: file.attachmentId, detail: file.filename })),
      ...latestAnswers.map((answer) => ({ kind: 'follow_up_answer' as const, id: answer.answerId, detail: `Assessment version ${answer.assessmentVersion}, revision ${answer.revision}; awaiting interpretation` })),
      { kind: 'capability_catalogue', id: catalogueIdentity, detail: CAPABILITY_CATALOGUE_VERSION },
      ...(input.existingReview ? [{ kind: 'assessment_review' as const, id: input.existingReview.reviewId, detail: `Assessment review ${input.existingReview.overallDisposition}` }] : []),
    ],
    informationNeeds, capabilityMatches,
    affectedSystems: [...new Set(capabilityMatches.filter((match) => !conflictingStepIds.has(match.stepId)).flatMap((match) => match.supportingComponents))],
    deploymentApproach: {
      rung, state: rung ? 'candidate_pending_review' : 'undetermined',
      rationale: rung ? 'Highest required step rung, subject to human confirmation of each lower rung.' : 'Missing or unreviewed information prevents a supported deployment rung.',
      lowerRungsToRuleOut: rung ? ladder.slice(0, ladder.indexOf(rung)) : [],
      steps: readiness.steps.map((step) => ({ stepId: step.stepId,
        rung: conflictingStepIds.has(step.stepId) ? null : step.deployment?.rung ?? null,
        basis: conflictingStepIds.has(step.stepId) ? 'Reviewed step differs from the assessment proposal; reconcile it first.' : step.basis,
        lowerRungsToRuleOut: step.deployment && !conflictingStepIds.has(step.stepId) ? ladder.slice(0, ladder.indexOf(step.deployment.rung)) : [] })),
    },
    engineeringRequirements,
    validationRequirements: [
      'Verify each requirement against the cited assessment, answer, and source evidence.',
      'Confirm every capability match and its required evidence with a reviewer.',
      'Test the selected deployment approach against the customer workflow and exceptions.',
      ...(engineeringRequirements.length > 0 ? ['Run focused regression tests for each affected EightForge boundary.'] : []),
    ],
    humanReview: {
      planState: 'pending_review', approvedDeploymentRecommendation: false,
      assessmentReview: input.existingReview ? { reviewId: input.existingReview.reviewId, reviewVersion: input.existingReview.reviewVersion, disposition: input.existingReview.overallDisposition } : null,
      requiredDecision: 'A separate human review of this derived FDE plan is required before deployment recommendation or implementation.',
    },
    readiness: { state: blockers.length > 0 ? 'needs_follow_up' : 'pending_review', blockers },
  };
}
