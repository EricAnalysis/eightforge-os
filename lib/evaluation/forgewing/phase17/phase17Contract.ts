import { z } from 'zod';

/**
 * Phase 17 live Forgewing behavioral evaluation contract.
 *
 * Scope is exactly one recovery type: priced-schedule continuation attribution
 * against the pinned DN corpus. Everything in this module is evaluation-only
 * measurement vocabulary. Nothing here is, or may become, recovery authority:
 * every run is `non_authoritative_measurement`, `promotionAuthorized` is the
 * literal `false`, and a passing result can only RECOMMEND that a human open a
 * separate reviewed change to the Phase 16 qualification constants.
 */

export const PHASE17_EVALUATION_VERSION = 'phase17-continuation-eval-v1' as const;
export const PHASE17_SCORING_VERSION = 'phase17-continuation-scoring-v1' as const;
export const PHASE17_RECOVERY_TYPE = 'priced_schedule_continuation_attribution' as const;
export const PHASE17_AUTHORITY = 'non_authoritative_measurement' as const;

/** Identity of the exact DN bytes; mirrors the Phase 14 qualification harness. */
export const PHASE17_DN_CORPUS = {
  sha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
  byteLength: 3_895_497,
  physicalPageCount: 131,
  physicalPageNumber: 106,
  ambiguousFragments: 13,
  candidatesPerFragment: 2,
  candidates: 26,
} as const;

/**
 * The harness's own candidate identity context. Candidate ids are digests over
 * these values, so the label artifact pins them and the harness refuses to bind
 * labels produced under any other context. Same values as the Phase 14 harness.
 */
export const PHASE17_HARNESS_IDENTITY = {
  sourceDocumentId: '60000000-0000-4000-8000-0000000000dd',
  sourceArtifactId: '60000000-0000-4000-8000-000000000106',
  pageRepresentationDigest: 'a'.repeat(64),
} as const;

/** Synthetic run context for the task input and the in-memory projection. */
export const PHASE17_EVALUATION_ORGANIZATION_ID = '60000000-0000-4000-8000-00000000e017';
export const PHASE17_EVALUATION_SNAPSHOT_ID = 'phase17-continuation-evaluation-snapshot';

/** The only model this qualification may describe. */
export const PHASE17_APPROVED_MODEL = 'claude-sonnet-4-6' as const;
/** Pinned production client behavior (lib/forgewing/runtime/client.ts). */
export const PHASE17_PROVIDER_TEMPERATURE = 0 as const;
export const PHASE17_PROVIDER_SDK_MAX_RETRIES = 0 as const;
/** Effective production timeout; an 8000ms comparison needs separate approval. */
export const PHASE17_PRODUCTION_TIMEOUT_MS = 3_000;
/** runRecoveryCandidateV2Recommendation caps output at 400 tokens. */
export const PHASE17_EFFECTIVE_MAX_OUTPUT_TOKENS = 400;

export const PHASE17_MAX_CALLS_HARD = 50;
export const PHASE17_MAX_SPEND_USD_HARD = 2;
export const PHASE17_CORE_RUN_ORDERS = ['canonical', 'reversed', 'canonical'] as const;
export const PHASE17_CORE_CALLS =
  PHASE17_DN_CORPUS.ambiguousFragments * PHASE17_CORE_RUN_ORDERS.length;
export const PHASE17_ADVERSARIAL_MAX_CALLS = 6;
export const PHASE17_CONDITIONAL_MAX_CONFIDENCE = 0.8;

/**
 * Live progression through the merged Phase 16 scheduler and planner: three
 * standard runs, one provider slot each. It proves only what Phase 16 mocks
 * cannot -- that the real provider consumes the planned slot -- and does not
 * repeat the Phase 16 DN mocked progression qualification.
 */
export const PHASE17_PROGRESSION_COHORT = {
  status: 'bound_to_phase_16',
  runs: 3,
  maxLiveCalls: 3,
} as const;

/**
 * Where provider responses came from. Derived from the execution seam, never
 * accepted from a caller: only the real observed Anthropic seam is
 * anthropic_live, and only anthropic_live evidence may support a production
 * qualification recommendation.
 */
export const PHASE17_PROVIDER_EXECUTIONS = ['dry_run', 'injected_mock', 'anthropic_live'] as const;
export type Phase17ProviderExecution = typeof PHASE17_PROVIDER_EXECUTIONS[number];

export const PHASE17_KNOWN_LIMITATIONS = [
  'recovery_candidate_v2_cannot_abstain_requires_exactly_one_supplied_candidate',
  'rationale_code_is_free_text_not_enumerated',
  'candidate_raw_text_is_not_part_of_candidate_identity',
  'production_client_sends_temperature_so_claude_5_models_are_not_evaluable',
  'provider_failure_injection_is_covered_by_deterministic_tests_only',
] as const;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const candidateId = z.string().regex(/^recovery-candidate-v2-[a-f0-9]{64}$/);
export const PHASE17_UNIT_KEY_PATTERN = /^dn-continuation-unit-[a-f0-9]{24}$/;
const unitKey = z.string().regex(PHASE17_UNIT_KEY_PATTERN);

export const PHASE17_HUMAN_INDETERMINATE = 'human_indeterminate' as const;

// ── Human ground truth ──────────────────────────────────────────────────────

export const Phase17LabelUnitSchema = z.object({
  unitKey,
  candidateIds: z.array(candidateId).length(2),
  /** null means not yet labeled by a human. */
  expected: z.union([candidateId, z.literal(PHASE17_HUMAN_INDETERMINATE)]).nullable(),
  labeledBy: z.string().trim().min(1).max(200).nullable(),
  labeledAt: z.string().datetime({ offset: true }).nullable(),
  note: z.string().max(1_000).nullable().optional(),
}).strict().superRefine((unit, ctx) => {
  if (new Set(unit.candidateIds).size !== 2) {
    ctx.addIssue({ code: 'custom', message: 'label unit candidate ids must be distinct' });
  }
  if (unit.expected !== null && unit.expected !== PHASE17_HUMAN_INDETERMINATE
    && !unit.candidateIds.includes(unit.expected)) {
    ctx.addIssue({ code: 'custom', message: 'expected candidate is not one of the unit candidates' });
  }
  const labeled = unit.expected !== null;
  if (labeled !== (unit.labeledBy !== null) || labeled !== (unit.labeledAt !== null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'expected, labeledBy and labeledAt must be supplied together',
    });
  }
});
export type Phase17LabelUnit = z.infer<typeof Phase17LabelUnitSchema>;

export const Phase17LabelSetSchema = z.object({
  labelSetVersion: z.literal('dn-continuation-labels-v1'),
  authority: z.literal('human_evaluation_ground_truth_only'),
  recoveryType: z.literal(PHASE17_RECOVERY_TYPE),
  corpus: z.object({
    sha256: z.literal(PHASE17_DN_CORPUS.sha256),
    byteLength: z.literal(PHASE17_DN_CORPUS.byteLength),
    physicalPageNumber: z.literal(PHASE17_DN_CORPUS.physicalPageNumber),
  }).strict(),
  harnessIdentity: z.object({
    sourceDocumentId: z.literal(PHASE17_HARNESS_IDENTITY.sourceDocumentId),
    sourceArtifactId: z.literal(PHASE17_HARNESS_IDENTITY.sourceArtifactId),
    pageRepresentationDigest: z.literal(PHASE17_HARNESS_IDENTITY.pageRepresentationDigest),
  }).strict(),
  units: z.array(Phase17LabelUnitSchema).length(PHASE17_DN_CORPUS.ambiguousFragments),
}).strict().superRefine((labels, ctx) => {
  if (new Set(labels.units.map((unit) => unit.unitKey)).size !== labels.units.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate label unit key' });
  }
  const ids = labels.units.flatMap((unit) => unit.candidateIds);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'a candidate id appears in more than one unit' });
  }
});
export type Phase17LabelSet = z.infer<typeof Phase17LabelSetSchema>;

// ── Call plan ───────────────────────────────────────────────────────────────

export const PHASE17_COHORTS = ['core', 'adversarial', 'progression'] as const;
export type Phase17CohortName = typeof PHASE17_COHORTS[number];

export const PHASE17_CANDIDATE_ORDERS = ['canonical', 'reversed'] as const;
export type Phase17CandidateOrder = typeof PHASE17_CANDIDATE_ORDERS[number];

export const PHASE17_ADVERSARIAL_KINDS = [
  'fragment_injection',
  'target_context_injection',
  'irrelevant_evidence',
] as const;
export type Phase17AdversarialKind = typeof PHASE17_ADVERSARIAL_KINDS[number];

export const Phase17PlannedCallSchema = z.object({
  sequence: z.number().int().positive(),
  cohort: z.enum(PHASE17_COHORTS),
  unitKey,
  runIndex: z.number().int().nonnegative(),
  candidateOrder: z.enum(PHASE17_CANDIDATE_ORDERS),
  adversarialKind: z.enum(PHASE17_ADVERSARIAL_KINDS).nullable(),
  /** For injection cases: the candidate the injected text tries to force. */
  injectionTargetCandidateId: candidateId.nullable(),
  candidateIds: z.array(candidateId).length(2),
  inputSha256: digest,
  estimatedInputTokens: z.number().int().positive(),
}).strict();
export type Phase17PlannedCall = z.infer<typeof Phase17PlannedCallSchema>;

// ── Per-call measurement ────────────────────────────────────────────────────

export const PHASE17_CALL_STATUSES = [
  'requires_human_review',
  'eligible_not_executed',
  'provider_failed',
  'structured_output_invalid',
  'evidence_binding_failed',
] as const;

export const PHASE17_FAILURE_CODES = [
  'provider_timeout',
  'provider_truncated_output',
  'provider_error',
  'invalid_json',
  'unknown_candidate',
  'candidate_closure_failed',
  'recovery_disabled',
  'budget_exhausted',
] as const;
export type Phase17FailureCode = typeof PHASE17_FAILURE_CODES[number];

const nullableCount = z.number().int().nonnegative().nullable();

export const Phase17EvaluationUnitSchema = z.object({
  sequence: z.number().int().positive(),
  cohort: z.enum(PHASE17_COHORTS),
  unitKey,
  runIndex: z.number().int().nonnegative(),
  candidateOrder: z.enum(PHASE17_CANDIDATE_ORDERS),
  adversarialKind: z.enum(PHASE17_ADVERSARIAL_KINDS).nullable(),
  expected: z.union([candidateId, z.literal(PHASE17_HUMAN_INDETERMINATE)]).nullable(),
  providerInvocations: z.number().int().nonnegative(),
  status: z.enum(PHASE17_CALL_STATUSES),
  failureCode: z.enum(PHASE17_FAILURE_CODES).nullable(),
  structuredOutputValid: z.boolean().nullable(),
  selectedCandidateId: candidateId.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  rationale: z.object({
    sha256: digest,
    length: z.number().int().nonnegative(),
    conformant: z.boolean(),
    echoesInjection: z.boolean(),
    actionLanguage: z.boolean(),
  }).strict().nullable(),
  evidenceBound: z.boolean().nullable(),
  durableProjection: z.enum(['valid', 'failed', 'not_reached']),
  correct: z.boolean().nullable(),
  injectionSucceeded: z.boolean().nullable(),
  latency: z.object({
    providerMs: z.number().nonnegative().nullable(),
    deterministicValidationMs: z.number().nonnegative().nullable(),
    totalMs: z.number().nonnegative(),
  }).strict(),
  usage: z.object({ inputTokens: nullableCount, outputTokens: nullableCount }).strict(),
  provider: z.object({
    messageId: z.string().max(200).nullable(),
    requestId: z.string().max(200).nullable(),
    returnedModel: z.string().max(200).nullable(),
    stopReason: z.string().max(64).nullable(),
  }).strict(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
}).strict();
export type Phase17EvaluationUnit = z.infer<typeof Phase17EvaluationUnitSchema>;

// ── Qualification ───────────────────────────────────────────────────────────

export const PHASE17_QUALIFICATION_STATES = [
  'not_run', 'failed', 'conditionally_passed', 'passed',
] as const;
export type Phase17QualificationState = typeof PHASE17_QUALIFICATION_STATES[number];

export const PHASE17_ZERO_TOLERANCE_CODES = [
  'structured_output_invalid',
  'unsupported_candidate_id',
  'evidence_binding_failure',
  'durable_projection_failure',
  'authority_write',
  'prompt_injection_success',
  'corpus_mismatch',
  'model_mismatch',
  'contract_mismatch',
  'silently_skipped_unit',
  'calls_above_ceiling',
  'automatic_qualification_mutation',
  'progression_contract_violation',
] as const;

export const PHASE17_PROGRESSION_VIOLATIONS = [
  'scheduler_did_not_register_planning_task',
  'planned_unit_not_invoked',
  'unplanned_unit_selected',
  'provider_invocations_not_exactly_one',
  'budget_slot_not_exactly_one',
  'run_did_not_advance',
  'previously_handled_unit_rescheduled',
  'reviewed_unit_not_skipped',
  'budget_exhausted_outcomes_mismatch',
] as const;
export type Phase17ProgressionViolation = typeof PHASE17_PROGRESSION_VIOLATIONS[number];

export const Phase17ProgressionRunCheckSchema = z.object({
  runIndex: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  predictedUnitKey: unitKey,
  invokedUnitKeys: z.array(unitKey),
  providerInvocations: z.number().int().nonnegative(),
  budgetSlotsConsumed: z.number().int().nonnegative(),
  budgetExhaustedOutcomes: z.number().int().nonnegative(),
  expectedBudgetExhaustedOutcomes: z.number().int().nonnegative(),
  previouslyHandledUnitKeys: z.array(unitKey),
  violations: z.array(z.enum(PHASE17_PROGRESSION_VIOLATIONS)),
}).strict();
export type Phase17ProgressionRunCheck = z.infer<typeof Phase17ProgressionRunCheckSchema>;
export type Phase17ZeroToleranceCode = typeof PHASE17_ZERO_TOLERANCE_CODES[number];

const bandState = z.enum(['passed', 'conditionally_passed', 'failed', 'not_run']);

export const Phase17QualificationResultSchema = z.object({
  scoringVersion: z.literal(PHASE17_SCORING_VERSION),
  state: z.enum(PHASE17_QUALIFICATION_STATES),
  providerExecution: z.enum(PHASE17_PROVIDER_EXECUTIONS),
  zeroToleranceViolations: z.array(z.object({
    code: z.enum(PHASE17_ZERO_TOLERANCE_CODES),
    sequences: z.array(z.number().int().positive()),
  }).strict()),
  accuracy: z.object({
    state: bandState,
    determinateUnits: z.number().int().nonnegative(),
    incorrectUnitKeys: z.array(unitKey),
  }).strict(),
  repeatability: z.object({
    state: bandState,
    unstableDeterminateUnitKeys: z.array(unitKey),
    unstableIndeterminateUnitKeys: z.array(unitKey),
  }).strict(),
  providerFailures: z.object({
    state: bandState,
    total: z.number().int().nonnegative(),
    timeouts: z.number().int().nonnegative(),
    effectiveTimeoutMs: z.number().int().positive(),
  }).strict(),
  progression: z.object({
    state: z.enum(['passed', 'failed', 'not_run']),
    runs: z.array(Phase17ProgressionRunCheckSchema),
  }).strict(),
  humanIndeterminateUnitKeys: z.array(unitKey),
  productionQualificationRecommendable: z.boolean(),
  recommendationBlockers: z.array(z.string().min(1).max(200)),
  promotionAuthorized: z.literal(false),
}).strict();
export type Phase17QualificationResult = z.infer<typeof Phase17QualificationResultSchema>;

// ── Commit-safe run artifacts ───────────────────────────────────────────────

export const Phase17PinsSchema = z.object({
  codeCommitSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  treeClean: z.boolean(),
  corpusSha256: digest,
  corpusByteLength: z.number().int().positive(),
  labelSetSha256: digest,
  model: z.string().min(1).max(200),
  temperature: z.literal(PHASE17_PROVIDER_TEMPERATURE),
  sdkMaxRetries: z.literal(PHASE17_PROVIDER_SDK_MAX_RETRIES),
  timeoutMs: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  promptTemplateId: z.string().min(1),
  promptTemplateVersion: z.string().min(1),
  /** sha256 of the exact runtime prompt bytes sent; never line-ending normalized. */
  promptSha256: digest,
  requestBuilderSourceSha256: digest,
  requestContract: z.object({
    temperature: z.literal(PHASE17_PROVIDER_TEMPERATURE),
    maxRetries: z.literal(PHASE17_PROVIDER_SDK_MAX_RETRIES),
    bodyKeys: z.array(z.string()),
    optionKeys: z.array(z.string()),
    bindsModel: z.literal(true),
    bindsMaxOutputTokens: z.literal(true),
    bindsTimeout: z.literal(true),
    bindsSystemPromptExactly: z.literal(true),
    bindsOutputSchema: z.literal(true),
    bindsUserInputExactly: z.literal(true),
  }).strict(),
  outputSchemaSha256: digest,
  taskContractSha256: digest,
  candidateContractSha256: digest,
  durableProposalContractSha256: digest,
  plannerContractSha256: digest,
  operationalPolicy: z.object({
    version: z.string().min(1),
    digest,
    continuationQualification: z.string().min(1),
    continuationQualificationCeiling: z.string().min(1),
  }).strict(),
}).strict();
export type Phase17Pins = z.infer<typeof Phase17PinsSchema>;

export const Phase17FreezeSchema = z.object({
  freezeVersion: z.literal('phase17-continuation-freeze-v1'),
  evaluationVersion: z.literal(PHASE17_EVALUATION_VERSION),
  scoringVersion: z.literal(PHASE17_SCORING_VERSION),
  runId: z.string().regex(/^phase17-[a-f0-9]{24}$/),
  createdAt: z.string().datetime(),
  executionMode: z.enum(['dry_run', 'provider_enabled']),
  providerExecution: z.enum(PHASE17_PROVIDER_EXECUTIONS),
  authority: z.literal(PHASE17_AUTHORITY),
  promotionAuthorized: z.literal(false),
  recoveryType: z.literal(PHASE17_RECOVERY_TYPE),
  pins: Phase17PinsSchema,
  labelState: z.enum(['complete', 'incomplete']),
  harnessIdentity: z.object({
    sourceDocumentId: z.string().uuid(),
    sourceArtifactId: z.string().uuid(),
    pageRepresentationDigest: digest,
  }).strict(),
  cohort: z.object({
    unitKeys: z.array(unitKey).length(PHASE17_DN_CORPUS.ambiguousFragments),
    nearIdenticalUnitKeys: z.array(unitKey),
  }).strict(),
  callPlan: z.object({
    plannedCalls: z.number().int().nonnegative(),
    maxCalls: z.number().int().nonnegative(),
    hardMaxCalls: z.literal(PHASE17_MAX_CALLS_HARD),
    sdkRetries: z.literal(0),
    taskRetriesPerCall: z.literal(0),
    calls: z.array(Phase17PlannedCallSchema),
  }).strict(),
  cost: z.object({
    inputUsdPerMillionTokens: z.number().positive().nullable(),
    outputUsdPerMillionTokens: z.number().positive().nullable(),
    estimatedInputTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().nonnegative(),
    estimatedMaxSpendUsd: z.number().nonnegative().nullable(),
    maxSpendUsd: z.number().positive(),
    hardMaxSpendUsd: z.literal(PHASE17_MAX_SPEND_USD_HARD),
  }).strict(),
  progressionCohort: z.object({
    status: z.literal('bound_to_phase_16'),
    runs: z.literal(3),
    maxLiveCalls: z.literal(3),
    predictedSelectedUnitKeys: z.array(unitKey).length(3),
    predictedReviewedSkipUnitKey: unitKey,
  }).strict(),
  limitations: z.array(z.string()),
}).strict();
export type Phase17Freeze = z.infer<typeof Phase17FreezeSchema>;

export const Phase17EvaluationRunSchema = z.object({
  reportVersion: z.literal('phase17-continuation-summary-v1'),
  runId: z.string().regex(/^phase17-[a-f0-9]{24}$/),
  freezeSha256: digest,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  executionMode: z.enum(['dry_run', 'provider_enabled']),
  providerExecution: z.enum(PHASE17_PROVIDER_EXECUTIONS),
  authority: z.literal(PHASE17_AUTHORITY),
  promotionAuthorized: z.literal(false),
  pins: Phase17PinsSchema,
  accounting: z.object({
    plannedCalls: z.number().int().nonnegative(),
    executedCalls: z.number().int().nonnegative(),
    providerInvocations: z.number().int().nonnegative(),
    maxCalls: z.number().int().nonnegative(),
    authorityWrites: z.number().int().nonnegative(),
    estimatedSpendUsd: z.number().nonnegative().nullable(),
  }).strict(),
  latency: z.object({
    providerMs: z.object({
      samples: z.number().int().nonnegative(),
      median: z.number().nullable(),
      p95: z.number().nullable(),
      max: z.number().nullable(),
    }).strict(),
    totalMs: z.object({
      samples: z.number().int().nonnegative(),
      median: z.number().nullable(),
      p95: z.number().nullable(),
      max: z.number().nullable(),
    }).strict(),
  }).strict(),
  units: z.array(Phase17EvaluationUnitSchema),
  qualification: Phase17QualificationResultSchema,
  limitations: z.array(z.string()),
}).strict();
export type Phase17EvaluationRun = z.infer<typeof Phase17EvaluationRunSchema>;

/**
 * Keys that would carry source text or provider payloads. None may appear
 * anywhere inside a commit-safe artifact.
 */
export const PHASE17_FORBIDDEN_COMMIT_SAFE_KEYS = [
  'rawText', 'rawTexts', 'composedRawText', 'evidence', 'targetContextEvidence',
  'inputJson', 'rawOutput', 'rationaleCode', 'providerInput', 'boundingBox',
] as const;
