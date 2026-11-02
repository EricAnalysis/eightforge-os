import { inferGoverningDocumentFamily } from '@/lib/documentPrecedence';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  CAPABILITY_CATALOGUE_VERSION,
  capabilityCatalogueIdentity,
  matchCapability,
  type Capability,
  type CapabilityStatus,
} from '@/lib/projectIntelligence/capabilityCatalogue';
import { FDE_LADDER_RUNGS, type FdeLadderRung } from '@/lib/projectIntelligence/fdeLadder';

export { FDE_LADDER_RUNGS, type FdeLadderRung };

/**
 * The forward-deployment readiness plan of one Workflow Assessment. The seven
 * question intake stays the opening scaffold, unchanged; this reads what it
 * already produced and says what is understood, what a person still has to answer,
 * and which rung of the deployment ladder each step starts on.
 *
 * Derived, deterministic and non-authoritative: it adds no provider call, stores
 * nothing and approves nothing. A rung is a starting point for human review, with
 * every lower rung listed to rule out first, because whether a lower rung really
 * covers a step cannot be proved from a description. Follow-ups come only from gaps
 * the assessment itself recorded after reading the intake and any supplied files,
 * so a person is never asked what the evidence already answered.
 *
 * The capability catalogue narrows that reading: a named capability can lower a
 * step's rung, and nothing it does not name is claimed as already supported.
 */

/** Where a step or a whole plan stands, best first. A later state outranks an earlier one in a plan. */
export const FDE_DEPLOYMENT_STATES = [
  'ready_existing_capability',
  'ready_with_configuration',
  'needs_mapping',
  'needs_adapter',
  'needs_deterministic_rule',
  'needs_extraction_or_validator_improvement',
  'needs_product_change',
  'blocked_on_customer_information',
  'blocked_on_owner_decision',
] as const;
export type FdeDeploymentState = typeof FDE_DEPLOYMENT_STATES[number];

const STATE_BY_RUNG: Readonly<Record<FdeLadderRung, FdeDeploymentState>> = {
  existing_capability: 'ready_existing_capability',
  customer_configuration: 'ready_with_configuration',
  mapping: 'needs_mapping',
  adapter: 'needs_adapter',
  reusable_deterministic_rule: 'needs_deterministic_rule',
  extraction_or_validator_improvement: 'needs_extraction_or_validator_improvement',
  broad_product_change: 'needs_product_change',
};

export type FdeSuppliedFile = Readonly<{ filename: string; sectionLabels: readonly string[]; truncated: boolean }>;

/** The parts of a persisted assessment this reads. Tolerant: older assessments may lack some. */
type StepInput = Readonly<{
  stepId?: unknown; classification?: unknown; description?: unknown;
  unresolvedAssumptions?: unknown; determinismGaps?: unknown;
}>;

export type FdeStepPlan = Readonly<{
  stepId: string;
  classification: string;
  /** Null when a person decides this step: it is not something to automate. */
  startingRung: FdeLadderRung | null;
  /** Lower rungs a reviewer rules out before accepting the starting rung. */
  ruleOutFirst: readonly FdeLadderRung[];
  basis: string;
  openQuestionCount: number;
  /** Null when a person decides this step. */
  deployment: FdeStepDeployment | null;
}>;

export type FdeStepDeployment = Readonly<{
  state: FdeDeploymentState;
  /** The rung after the catalogue's reading. A step with no catalogue match is never on the lowest. */
  rung: FdeLadderRung;
  capability: Readonly<{
    capabilityId: string;
    status: CapabilityStatus;
    configurationRequirements: readonly string[];
    knownLimitations: readonly string[];
  }> | null;
  unansweredQuestionCount: number;
}>;

/** Input only: the id of an answer on file and the follow-up it answers. Its text is not read here. */
export type FdeFollowUpAnswerRef = Readonly<{ answerId: string; followUpId: string }>;

export type FdeFollowUp = Readonly<{
  /** Stable across assessment versions, so an answer still meets the same question. */
  followUpId: string;
  stepId: string | null;
  kind: 'determinism_gap' | 'unresolved_assumption';
  question: string;
  /** A supplied file looks related: check it before asking anyone. */
  checkSuppliedFileFirst: string | null;
}>;

export type FdeReadinessPlan = Readonly<{
  schemaVersion: 'fde_readiness_plan_v2';
  authority: 'non_authoritative';
  requiresHumanReview: true;
  workflowUnderstood: Readonly<{ state: 'understood' | 'partially_understood'; stepCount: number; openQuestionCount: number; limitations: readonly string[] }>;
  evidenceCompleteness: Readonly<{
    state: 'supplied' | 'partially_supplied' | 'not_supplied' | 'none_described';
    describedSources: readonly Readonly<{ name: string; suppliedAs: string | null }>[];
    suppliedFileCount: number;
    truncatedFiles: readonly string[];
  }>;
  steps: readonly FdeStepPlan[];
  reusableCapabilities: readonly string[];
  customerConfiguration: readonly string[];
  mappingNeeds: readonly string[];
  adapterNeeds: readonly string[];
  deterministicRuleOpportunities: readonly string[];
  improvementOpportunities: readonly string[];
  unresolvedHumanDecisions: readonly string[];
  /** Asked only for material gaps, most material first, and capped. */
  followUps: readonly FdeFollowUp[];
  followUpsNotShown: number;
  /** Answered follow-ups. An answer is input for a reviewer, not established truth. */
  answeredFollowUps: readonly (FdeFollowUp & Readonly<{ answerId: string }>)[];
  /** Answers to a question this version of the assessment no longer asks. */
  answersWithoutQuestion: readonly string[];
  capabilityCatalogue: Readonly<{ version: typeof CAPABILITY_CATALOGUE_VERSION; identity: string }>;
  /** Null when nothing here is to be automated. */
  deploymentState: FdeDeploymentState | null;
  executionReadiness: Readonly<{
    state: 'ready_for_implementation_review' | 'needs_follow_up' | 'not_ready';
    blockers: readonly ('open_questions' | 'evidence_not_supplied' | 'no_step_beyond_human_decision')[];
  }>;
}>;

export const MAX_FDE_FOLLOW_UPS = 6;

/** Words that say the information lives in a system, so reaching it is an adapter, not a document upload. */
const SYSTEM_SOURCE = /\b(?:api|apis|erp|crm|database|sql|sftp|webhook|saas|system of record|portal|salesforce|netsuite|quickbooks|sap)\b/iu;
const FILE_SOURCE = /\b(?:pdf|csv|xlsx?|spreadsheet|workbook|sheet|export|report|document|file|form|scan)\b/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

const NORMALIZE = /[^a-z0-9]+/gu;
const STOP = new Set(['the', 'and', 'for', 'from', 'with', 'data', 'file', 'document', 'report']);
function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(NORMALIZE).filter((token) => token.length > 2 && !STOP.has(token)));
}

/**
 * A supplied file whose name or sections share half of these words, or three of
 * them when this is a whole sentence. This only ever points a person at a file to
 * look in; it never counts as having read the answer from it.
 */
function matchingFile(name: string, files: readonly FdeSuppliedFile[]): string | null {
  const wanted = tokens(name);
  if (wanted.size === 0) return null;
  for (const file of files) {
    const have = tokens([file.filename, ...file.sectionLabels].join(' '));
    const overlap = [...wanted].filter((token) => have.has(token)).length;
    if (overlap >= 3 || (overlap > 0 && overlap * 2 >= wanted.size)) return file.filename;
  }
  return null;
}

function ruleOutBelow(rung: FdeLadderRung): FdeLadderRung[] {
  return FDE_LADDER_RUNGS.slice(0, FDE_LADDER_RUNGS.indexOf(rung));
}

function rungForExtraction(requirement: Record<string, unknown> | undefined): { rung: FdeLadderRung; basis: string } {
  const source = text(requirement?.sourceDocument);
  if (requirement?.deterministicExtractionPlausible === false) {
    return { rung: 'extraction_or_validator_improvement', basis: 'The assessment expects standard extraction to be unreliable for this source.' };
  }
  if (SYSTEM_SOURCE.test(source)) return { rung: 'adapter', basis: 'This information lives in a system rather than a document.' };
  if (inferGoverningDocumentFamily({ title: source, name: source, document_type: source.toLowerCase() }) || FILE_SOURCE.test(source)) {
    return { rung: 'existing_capability', basis: 'This is a document kind EightForge already reads.' };
  }
  return { rung: 'mapping', basis: 'The source is not one EightForge recognizes by name, so its terms need mapping.' };
}

function followUpId(stepId: string | null, kind: FdeFollowUp['kind'], question: string): string {
  return hashCanonical({ stepId, kind, question: question.trim().toLowerCase().replace(/\s+/gu, ' ') });
}

const rungIndex = (rung: FdeLadderRung) => FDE_LADDER_RUNGS.indexOf(rung);

/** What the catalogue is matched against: the step's own words and, if any, the source it reads. */
function stepMatchText(step: StepInput, assessment: Record<string, unknown>): string {
  const requirement = records(assessment.extractionRequirements).find((entry) => entry.stepId === step.stepId);
  return [text(step.description), text(requirement?.sourceDocument)].join(' ');
}

/**
 * The catalogue can lower a rung, never raise past a reading it does not contradict.
 * Two limits: an assessment that says standard extraction falls short is not
 * overruled by a file type, and a guess of "already supported" with no catalogue
 * entry behind it is not repeated as a claim.
 */
function stepDeployment(startingRung: FdeLadderRung, capability: Capability | null, unansweredQuestionCount: number): FdeStepDeployment {
  const usable = startingRung === 'extraction_or_validator_improvement' ? null : capability;
  let rung: FdeLadderRung;
  if (usable) {
    rung = startingRung === 'existing_capability' || rungIndex(usable.rung) < rungIndex(startingRung) ? usable.rung : startingRung;
  } else {
    rung = startingRung === 'existing_capability' ? 'mapping' : startingRung;
  }
  const state: FdeDeploymentState = unansweredQuestionCount > 0 ? 'blocked_on_customer_information'
    : usable?.status === 'requires_owner_activation' ? 'blocked_on_owner_decision'
    : STATE_BY_RUNG[rung];
  return {
    state, rung, unansweredQuestionCount,
    capability: usable ? {
      capabilityId: usable.capabilityId, status: usable.status,
      configurationRequirements: usable.configurationRequirements, knownLimitations: usable.knownLimitations,
    } : null,
  };
}

function stepPlan(
  step: StepInput,
  assessment: Record<string, unknown>,
  qualificationByStep: ReadonlyMap<string, string>,
  unanswered: readonly FdeFollowUp[],
): FdeStepPlan {
  const stepId = text(step.stepId);
  const classification = text(step.classification);
  const openQuestionCount = strings(step.unresolvedAssumptions).length + records(step.determinismGaps).length;
  const plan = (startingRung: FdeLadderRung | null, basis: string): FdeStepPlan => ({
    stepId, classification, startingRung, ruleOutFirst: startingRung ? ruleOutBelow(startingRung) : [], basis, openQuestionCount,
    deployment: startingRung ? stepDeployment(
      startingRung,
      matchCapability({ classification, text: stepMatchText(step, assessment) }),
      unanswered.filter((entry) => entry.stepId === stepId).length,
    ) : null,
  });
  switch (classification) {
    case 'HUMAN':
      return plan(null, 'A person keeps this decision.');
    case 'ADVISORY':
      return plan('existing_capability', 'Explanation only, which Ask already provides.');
    case 'RECOVER':
      return plan('extraction_or_validator_improvement', 'The assessment says standard extraction falls short here.');
    case 'EXTRACT': {
      const requirement = records(assessment.extractionRequirements).find((entry) => entry.stepId === stepId);
      const { rung, basis } = rungForExtraction(requirement);
      return plan(rung, basis);
    }
    case 'RULE':
    case 'VERIFY':
      if (qualificationByStep.get(stepId) === 'proposed_with_gaps') {
        return plan('reusable_deterministic_rule', 'A candidate rule, but the description leaves conditions open: answer those first.');
      }
      return plan('reusable_deterministic_rule', qualificationByStep.get(stepId) === 'grounded_unverified'
        ? 'A candidate rule grounded in the intake; a person confirms it.'
        : 'A candidate rule the intake does not fully ground yet.');
    default:
      return plan(null, 'This step has no recognized classification.');
  }
}

function followUpsFor(steps: readonly StepInput[], assessment: Record<string, unknown>, files: readonly FdeSuppliedFile[]): FdeFollowUp[] {
  const seen = new Set<string>();
  const add = (list: FdeFollowUp[], entry: FdeFollowUp) => {
    const key = entry.question.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    list.push(entry);
  };
  const severityByStep = new Map(records(assessment.failureConsequences).map((entry) => [text(entry.stepId), text(entry.severity)]));
  const severityRank = (stepId: string) => ({ high: 0, moderate: 1, low: 2 } as Record<string, number>)[severityByStep.get(stepId) ?? ''] ?? 3;
  const ordered = [...steps].sort((left, right) => severityRank(text(left.stepId)) - severityRank(text(right.stepId)));
  const gaps: FdeFollowUp[] = [];
  const assumptions: FdeFollowUp[] = [];
  for (const step of ordered) {
    const stepId = text(step.stepId) || null;
    for (const gap of records(step.determinismGaps)) {
      const question = text(gap.explanation);
      add(gaps, { followUpId: followUpId(stepId, 'determinism_gap', question), stepId, kind: 'determinism_gap', question, checkSuppliedFileFirst: matchingFile(question, files) });
    }
    for (const assumption of strings(step.unresolvedAssumptions)) {
      add(assumptions, { followUpId: followUpId(stepId, 'unresolved_assumption', assumption), stepId, kind: 'unresolved_assumption', question: assumption, checkSuppliedFileFirst: matchingFile(assumption, files) });
    }
  }
  for (const proposal of [...records(assessment.deterministicRuleProposals), ...records(assessment.verificationRuleProposals)]) {
    for (const assumption of strings(proposal.unresolvedAssumptions)) {
      const stepId = text(proposal.stepId) || null;
      add(assumptions, { followUpId: followUpId(stepId, 'unresolved_assumption', assumption), stepId, kind: 'unresolved_assumption', question: assumption, checkSuppliedFileFirst: matchingFile(assumption, files) });
    }
  }
  // A gap decides whether a rule can exist at all, so it outranks an open assumption.
  return [...gaps, ...assumptions];
}

/** Null when the record has no steps to plan from. */
export function buildFdeReadinessPlan(
  assessment: unknown,
  files: readonly FdeSuppliedFile[] = [],
  answers: readonly FdeFollowUpAnswerRef[] = [],
): FdeReadinessPlan | null {
  if (!isRecord(assessment)) return null;
  const steps = records(assessment.workflowSteps) as StepInput[];
  if (steps.length === 0) return null;
  const qualificationByStep = new Map(records(assessment.determinismQualifications).map((entry) => [text(entry.stepId), text(entry.state)]));
  const asked = followUpsFor(steps, assessment, files);
  // In order, so the newest answer to a question is the one a reviewer sees.
  const answerByFollowUp = new Map(answers.map((answer) => [answer.followUpId, answer.answerId]));
  const allFollowUps = asked.filter((entry) => !answerByFollowUp.has(entry.followUpId));
  const askedIds = new Set(asked.map((entry) => entry.followUpId));
  const plans = steps.map((step) => stepPlan(step, assessment, qualificationByStep, allFollowUps));
  const onRung = (rung: FdeLadderRung) => plans.filter((plan) => plan.startingRung === rung).map((plan) => plan.stepId);
  const limitations = strings(assessment.limitations);
  const described = records(assessment.documents).map((entry) => {
    const name = text(entry.name);
    return { name, suppliedAs: matchingFile(name, files) };
  }).filter((entry) => entry.name.length > 0);
  const suppliedCount = described.filter((entry) => entry.suppliedAs != null).length;
  const evidenceState = described.length === 0 ? 'none_described' as const
    : suppliedCount === described.length ? 'supplied' as const
    : suppliedCount > 0 ? 'partially_supplied' as const : 'not_supplied' as const;
  const automatable = plans.some((plan) => plan.startingRung != null && plan.classification !== 'ADVISORY');
  const stepStates = plans.flatMap((plan) => plan.deployment ? [plan.deployment.state] : []);
  // A question with no step, or a described source nobody has supplied, still holds the plan up.
  const planWideBlock = allFollowUps.some((entry) => entry.stepId == null) || evidenceState === 'not_supplied';
  const deploymentStates: readonly FdeDeploymentState[] = planWideBlock ? [...stepStates, 'blocked_on_customer_information'] : stepStates;
  const deploymentState = automatable || deploymentStates.some((state) => state === 'blocked_on_customer_information' || state === 'blocked_on_owner_decision')
    ? FDE_DEPLOYMENT_STATES[Math.max(...deploymentStates.map((state) => FDE_DEPLOYMENT_STATES.indexOf(state)))] ?? null
    : null;
  const blockers = [
    ...(allFollowUps.length > 0 ? ['open_questions' as const] : []),
    ...(evidenceState === 'not_supplied' ? ['evidence_not_supplied' as const] : []),
    ...(automatable ? [] : ['no_step_beyond_human_decision' as const]),
  ];
  return {
    schemaVersion: 'fde_readiness_plan_v2',
    authority: 'non_authoritative',
    requiresHumanReview: true,
    workflowUnderstood: {
      state: allFollowUps.length === 0 && limitations.length === 0 ? 'understood' : 'partially_understood',
      stepCount: steps.length, openQuestionCount: allFollowUps.length, limitations,
    },
    evidenceCompleteness: {
      state: evidenceState, describedSources: described, suppliedFileCount: files.length,
      truncatedFiles: files.filter((file) => file.truncated).map((file) => file.filename),
    },
    steps: plans,
    reusableCapabilities: onRung('existing_capability'),
    customerConfiguration: onRung('customer_configuration'),
    mappingNeeds: onRung('mapping'),
    adapterNeeds: onRung('adapter'),
    deterministicRuleOpportunities: onRung('reusable_deterministic_rule'),
    improvementOpportunities: onRung('extraction_or_validator_improvement'),
    unresolvedHumanDecisions: records(assessment.humanDecisionPoints).map((entry) => text(entry.description)).filter((entry) => entry.length > 0),
    followUps: allFollowUps.slice(0, MAX_FDE_FOLLOW_UPS),
    followUpsNotShown: Math.max(0, allFollowUps.length - MAX_FDE_FOLLOW_UPS),
    answeredFollowUps: asked.flatMap((entry) => {
      const answerId = answerByFollowUp.get(entry.followUpId);
      return answerId ? [{ ...entry, answerId }] : [];
    }),
    answersWithoutQuestion: [...answerByFollowUp].filter(([id]) => !askedIds.has(id)).map(([, answerId]) => answerId),
    capabilityCatalogue: { version: CAPABILITY_CATALOGUE_VERSION, identity: capabilityCatalogueIdentity() },
    deploymentState,
    executionReadiness: {
      state: blockers.includes('no_step_beyond_human_decision') ? 'not_ready'
        : blockers.length > 0 ? 'needs_follow_up' : 'ready_for_implementation_review',
      blockers,
    },
  };
}
