import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { loadRecoveryCandidateV2Prompt } from '@/lib/forgewing/runtime/client';
import {
  getForgewingRuntimeConfig,
  type ForgewingRuntimeConfig,
} from '@/lib/forgewing/runtime/modelConfig';
import { RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA } from '@/lib/forgewing/runtime/structuredOutput';
import {
  buildPhase17DnCohort,
  type Phase17Cohort,
} from '@/lib/evaluation/forgewing/phase17/dnContinuationCohort';
import { bindPhase17Labels, parsePhase17LabelSet }
  from '@/lib/evaluation/forgewing/phase17/dnContinuationLabels';
import {
  writePhase17Freeze,
  writePhase17LocalRaw,
  writePhase17Summary,
} from '@/lib/evaluation/forgewing/phase17/phase17Artifacts';
import {
  PHASE17_APPROVED_MODEL,
  PHASE17_AUTHORITY,
  PHASE17_EFFECTIVE_MAX_OUTPUT_TOKENS,
  PHASE17_EVALUATION_VERSION,
  PHASE17_HARNESS_IDENTITY,
  PHASE17_KNOWN_LIMITATIONS,
  PHASE17_MAX_CALLS_HARD,
  PHASE17_MAX_SPEND_USD_HARD,
  PHASE17_PRODUCTION_TIMEOUT_MS,
  PHASE17_PROGRESSION_COHORT,
  PHASE17_RECOVERY_TYPE,
  PHASE17_SCORING_VERSION,
  type Phase17EvaluationRun,
  type Phase17EvaluationUnit,
  type Phase17Freeze,
  type Phase17HarnessIntegrity,
  type Phase17Pins,
  type Phase17ProgressionRunCheck,
  type Phase17ProviderExecution,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';
import {
  executePhase17Calls,
  phase17ProviderExecution,
  phase17ResponseIdentityVerified,
  type Phase17DurableProjection,
  type Phase17LocalRawRecord,
  Phase17GuardError,
  type Phase17ExecutionResult,
  type Phase17ProviderFactory,
} from '@/lib/evaluation/forgewing/phase17/phase17Execution';
import {
  computePhase17ContractPins,
  exactPromptSha256,
  phase17ContractPinMismatches,
  phase17PromptHasCarriageReturn,
  PHASE17_ACCEPTED_CONTRACT_PINS,
  type Phase17ContractPins,
} from '@/lib/evaluation/forgewing/phase17/phase17Pins';
import {
  buildPhase17CallPlan,
  estimatePhase17InputTokens,
  estimatePhase17MaxSpend,
} from '@/lib/evaluation/forgewing/phase17/phase17Plan';
import {
  buildPhase17ProgressionCalls,
  executePhase17Progression,
  type Phase17RecoveryScheduler,
} from '@/lib/evaluation/forgewing/phase17/phase17Progression';
import { evaluatePhase17Qualification }
  from '@/lib/evaluation/forgewing/phase17/phase17Qualification';

/**
 * Phase 17 run orchestrator.
 *
 * Every integrity gate runs before the freeze is written, and the freeze is
 * written before any provider call is possible. The default mode is a dry run
 * that builds and freezes the plan with zero provider calls. Live execution is
 * reachable only with mode `provider_enabled` AND every live precondition.
 *
 * Harness integrity. Everything that can change the behavioral input or the
 * qualification -- corpus cohort, labels, contract pins, prompt, projection,
 * Phase 16 scheduler, provider seam, repository, git state, runtime config and
 * environment -- is resolved by this module itself. Tests may override any of
 * it, but then the run is `injected_test_hooks`. A run against the real
 * Anthropic seam that is not `default_trusted` refuses to start, before any
 * artifact or provider call.
 */

/** Environment that would give this process a production database. */
export const PHASE17_FORBIDDEN_DATABASE_ENV = [
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'DATABASE_URL',
] as const;

/** Files whose content decides Forgewing activation/qualification. */
export const PHASE17_QUALIFICATION_SOURCE_FILES = [
  'lib/forgewing/runtime/modelConfig.ts',
  'lib/extraction/recovery/recoveryOperationalPolicy.ts',
] as const;

/** The committed human label artifact, read by path (never imported). */
export const PHASE17_LABEL_ARTIFACT_PATH = 'lib/evaluation/fixtures/dnContinuationLabels.v1.json';

/** Operator controls. None of these can change what is measured or how it is judged. */
export type Phase17RunParams = Readonly<{
  mode: 'dry_run' | 'provider_enabled';
  corpusBytes: Uint8Array | null;
  artifactRoot: string;
  maxCalls: number | null;
  maxSpendUsd: number | null;
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
}>;

/** Explicit operator-control surface. New run inputs require a reviewed classification. */
export const PHASE17_OPERATOR_CONTROL_KEYS = [
  'mode',
  'corpusBytes',
  'artifactRoot',
  'maxCalls',
  'maxSpendUsd',
  'inputUsdPerMillionTokens',
  'outputUsdPerMillionTokens',
] as const;

/**
 * Test overrides. Every key is classified below; the type-level assertion makes
 * an unclassified addition a compile error, so a new hook cannot silently skip
 * the integrity decision.
 */
export type Phase17RunDependencies = Partial<Readonly<{
  buildCohort: (bytes: Uint8Array) => Promise<Phase17Cohort>;
  computeContractPins: (repoRoot: string) => Phase17ContractPins;
  acceptedContractPins: Phase17ContractPins;
  loadPrompt: () => string;
  qualificationSourceDigest: (repoRoot: string) => string;
  projectDurableProposal: Phase17DurableProjection;
  scheduleRecovery: Phase17RecoveryScheduler;
  createProvider: Phase17ProviderFactory;
  labelBytes: Uint8Array | string;
  repoRoot: string;
  codeState: Readonly<{ commitSha: string | null; treeClean: boolean }>;
  runtimeConfig: ForgewingRuntimeConfig;
  env: Readonly<Record<string, string | undefined>>;
  clock: () => number;
  now: () => Date;
  runNonce: string;
}>>;

/** Overrides that can alter behavioral input, pins, execution or qualification. */
export const PHASE17_INTEGRITY_CRITICAL_OVERRIDES = [
  'buildCohort',
  'computeContractPins',
  'acceptedContractPins',
  'loadPrompt',
  'qualificationSourceDigest',
  'projectDurableProposal',
  'scheduleRecovery',
  'createProvider',
  'labelBytes',
  'repoRoot',
  'codeState',
  'runtimeConfig',
  'env',
  'clock',
] as const;

/** Overrides that only affect artifact timestamps or run-id uniqueness. */
export const PHASE17_INTEGRITY_NEUTRAL_OVERRIDES = ['now', 'runNonce'] as const;

type ClassifiedOverride = typeof PHASE17_INTEGRITY_CRITICAL_OVERRIDES[number]
  | typeof PHASE17_INTEGRITY_NEUTRAL_OVERRIDES[number];
type AssertNever<T extends never> = T;
export type Phase17UnclassifiedOverrides =
  AssertNever<Exclude<keyof Phase17RunDependencies, ClassifiedOverride>>;
export type Phase17StaleOverrideClassifications =
  AssertNever<Exclude<ClassifiedOverride, keyof Phase17RunDependencies>>;
type Phase17OperatorControl = typeof PHASE17_OPERATOR_CONTROL_KEYS[number];
export type Phase17UnclassifiedRunParams =
  AssertNever<Exclude<keyof Phase17RunParams, Phase17OperatorControl>>;
export type Phase17StaleOperatorControls =
  AssertNever<Exclude<Phase17OperatorControl, keyof Phase17RunParams>>;

type Phase17RunDependencySnapshot = {
  readonly [Key in keyof Required<Phase17RunDependencies>]: Phase17RunDependencies[Key];
};

/**
 * Read every caller-owned dependency exactly once. Classification and execution
 * use this frozen snapshot, so an accessor or later mutation cannot swap a seam
 * after provenance was derived.
 */
function snapshotPhase17RunDependencies(
  dependencies: Phase17RunDependencies,
): Phase17RunDependencySnapshot {
  return Object.freeze({
    buildCohort: dependencies.buildCohort,
    computeContractPins: dependencies.computeContractPins,
    acceptedContractPins: dependencies.acceptedContractPins,
    loadPrompt: dependencies.loadPrompt,
    qualificationSourceDigest: dependencies.qualificationSourceDigest,
    projectDurableProposal: dependencies.projectDurableProposal,
    scheduleRecovery: dependencies.scheduleRecovery,
    createProvider: dependencies.createProvider,
    labelBytes: dependencies.labelBytes,
    repoRoot: dependencies.repoRoot,
    codeState: dependencies.codeState,
    runtimeConfig: dependencies.runtimeConfig,
    env: dependencies.env,
    clock: dependencies.clock,
    now: dependencies.now,
    runNonce: dependencies.runNonce,
  });
}

export type Phase17RunOutcome = Readonly<{
  runId: string;
  providerExecution: Phase17ProviderExecution;
  harnessIntegrity: Phase17HarnessIntegrity;
  freeze: Phase17Freeze;
  freezePath: string;
  freezeSha256: string;
  summary: Phase17EvaluationRun;
  summaryPath: string;
  localRawPath: string | null;
}>;

function fail(code: string, detail: string): never {
  throw new Phase17GuardError(code, detail);
}

/** The repository this module belongs to, derived from its own location. */
export function phase17TrustedRepoRoot(): string {
  return path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
}

export function phase17QualificationSourceDigest(repoRoot: string): string {
  return hashCanonical(PHASE17_QUALIFICATION_SOURCE_FILES.map((relative) => {
    const absolute = path.join(repoRoot, relative);
    return {
      relative,
      sha256: existsSync(absolute)
        ? createHash('sha256').update(readFileSync(absolute)).digest('hex') : null,
    };
  }));
}

function gitCodeState(repoRoot: string): Readonly<{ commitSha: string | null; treeClean: boolean }> {
  const git = (args: readonly string[]) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  try {
    return {
      commitSha: git(['rev-parse', 'HEAD']),
      treeClean: git(['status', '--porcelain', '--untracked-files=no']) === '',
    };
  } catch {
    return { commitSha: null, treeClean: false };
  }
}

type TrustedSeams = Readonly<{
  projectDurableProposal: Phase17DurableProjection;
  scheduleRecovery: Phase17RecoveryScheduler;
}>;

async function loadTrustedSeams(): Promise<TrustedSeams> {
  const seams = await import('@/lib/evaluation/phase17LiveSeams');
  return {
    projectDurableProposal: seams.PHASE17_TRUSTED_PROJECT_DURABLE_PROPOSAL,
    // Structural narrowing only: the evaluation type makes every IO dependency required.
    scheduleRecovery: seams.PHASE17_TRUSTED_SCHEDULE_RECOVERY as unknown as Phase17RecoveryScheduler,
  };
}

const DEFAULT_FUNCTION_SEAMS = {
  buildCohort: buildPhase17DnCohort,
  computeContractPins: computePhase17ContractPins,
  acceptedContractPins: PHASE17_ACCEPTED_CONTRACT_PINS,
  loadPrompt: loadRecoveryCandidateV2Prompt,
  qualificationSourceDigest: phase17QualificationSourceDigest,
} as const;

/**
 * Structural harness integrity. `default_trusted` only when every critical
 * override is absent or is the exact default reference. Data overrides (labels,
 * repository, git state, runtime config, environment) have no trusted
 * reference to compare against, so supplying one at all is an injected hook.
 */
function derivePhase17HarnessIntegrityFromSnapshot(
  snapshot: Phase17RunDependencySnapshot,
  trustedSeams: TrustedSeams | undefined,
): Readonly<{ harnessIntegrity: Phase17HarnessIntegrity; overridden: readonly string[] }> {
  const overridden = PHASE17_INTEGRITY_CRITICAL_OVERRIDES.filter((key) => {
    const value = snapshot[key];
    if (value === undefined) return false;
    switch (key) {
      case 'buildCohort':
      case 'computeContractPins':
      case 'acceptedContractPins':
      case 'loadPrompt':
      case 'qualificationSourceDigest':
        return value !== DEFAULT_FUNCTION_SEAMS[key];
      case 'projectDurableProposal':
      case 'scheduleRecovery':
        return value !== trustedSeams?.[key];
      case 'createProvider':
        return phase17ProviderExecution('provider_enabled', value as Phase17ProviderFactory)
          !== 'anthropic_live';
      default:
        return true;
    }
  });
  return {
    harnessIntegrity: overridden.length === 0 ? 'default_trusted' : 'injected_test_hooks',
    overridden,
  };
}

export async function derivePhase17HarnessIntegrity(
  dependencies: Phase17RunDependencies,
): Promise<Readonly<{ harnessIntegrity: Phase17HarnessIntegrity; overridden: readonly string[] }>> {
  const snapshot = snapshotPhase17RunDependencies(dependencies);
  const needsSeams = snapshot.projectDurableProposal !== undefined
    || snapshot.scheduleRecovery !== undefined;
  const trustedSeams = needsSeams ? await loadTrustedSeams() : undefined;
  return derivePhase17HarnessIntegrityFromSnapshot(snapshot, trustedSeams);
}

function statistics(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1,
    Math.ceil(quantile * sorted.length) - 1)]!;
  return {
    samples: sorted.length,
    median: sorted.length === 0 ? null : at(0.5),
    // A p95 from fewer than twenty samples is its maximum under another name.
    p95: sorted.length >= 20 ? at(0.95) : null,
    max: sorted.length === 0 ? null : sorted[sorted.length - 1]!,
  };
}

export async function runPhase17ContinuationEvaluation(
  params: Phase17RunParams,
  dependencies: Phase17RunDependencies = {},
): Promise<Phase17RunOutcome> {
  const injected = snapshotPhase17RunDependencies(dependencies);
  const live = params.mode === 'provider_enabled';
  if (params.mode !== 'dry_run' && !live) fail('invalid_mode', String(params.mode));

  // ── Harness integrity (first: before corpus, pins, freeze or provider) ────
  const providerExecution = phase17ProviderExecution(params.mode, injected.createProvider);
  const trustedSeams = live || injected.projectDurableProposal !== undefined
    || injected.scheduleRecovery !== undefined ? await loadTrustedSeams() : undefined;
  const { harnessIntegrity, overridden } =
    derivePhase17HarnessIntegrityFromSnapshot(injected, trustedSeams);
  if (providerExecution === 'anthropic_live' && harnessIntegrity !== 'default_trusted') {
    fail('harness_integrity_not_trusted', `a live Anthropic run may not use injected hooks `
      + `(${overridden.join(', ')}); only the default harness can produce live evidence`);
  }
  const repoRoot = injected.repoRoot ?? phase17TrustedRepoRoot();
  const env = injected.env ?? process.env;

  // ── Corpus, cohort, labels ────────────────────────────────────────────────
  if (!params.corpusBytes) {
    fail('corpus_missing', 'DN_PRICED_SCHEDULE_SOURCE_PDF is required; Phase 17 never skips');
  }
  const cohort = await (injected.buildCohort ?? buildPhase17DnCohort)(params.corpusBytes);
  const labelPath = path.join(repoRoot, PHASE17_LABEL_ARTIFACT_PATH);
  const labelBytes = injected.labelBytes
    ?? (existsSync(labelPath) ? readFileSync(labelPath) : null);
  if (!labelBytes) fail('labels_missing', `the human label artifact is required at ${PHASE17_LABEL_ARTIFACT_PATH}`);
  const labels = bindPhase17Labels(parsePhase17LabelSet(labelBytes), cohort);

  // ── Exact prompt bytes ───────────────────────────────────────────────────
  // The provider receives the prompt file's runtime bytes verbatim. A CR means
  // this checkout would send different bytes than production (LF blobs).
  const systemPrompt = (injected.loadPrompt ?? loadRecoveryCandidateV2Prompt)();
  if (phase17PromptHasCarriageReturn(systemPrompt)) {
    fail('prompt_bytes_not_lf', 'the runtime prompt contains CR; check out with LF '
      + '(lib/forgewing/prompts/** text eol=lf) so evaluation sends production bytes');
  }

  // ── Behavioral contract pins ─────────────────────────────────────────────
  const contractPins = (injected.computeContractPins ?? computePhase17ContractPins)(repoRoot);
  const mismatched = phase17ContractPinMismatches(contractPins,
    injected.acceptedContractPins ?? PHASE17_ACCEPTED_CONTRACT_PINS);
  if (mismatched.length > 0) fail('contract_mismatch', mismatched.join(', '));
  if (contractPins.promptSha256 !== exactPromptSha256(systemPrompt)) {
    fail('contract_mismatch', 'promptSha256 does not describe the prompt bytes that will be sent');
  }

  // ── Effective production runtime ─────────────────────────────────────────
  const runtimeConfig = injected.runtimeConfig ?? getForgewingRuntimeConfig();
  if (runtimeConfig.model !== PHASE17_APPROVED_MODEL) {
    fail('model_mismatch', `${runtimeConfig.model} is not ${PHASE17_APPROVED_MODEL}`);
  }
  if (runtimeConfig.timeoutMs !== PHASE17_PRODUCTION_TIMEOUT_MS) {
    fail('timeout_not_production', `${runtimeConfig.timeoutMs}ms; a non-3000ms comparison `
      + 'requires separate explicit approval');
  }
  const effectiveMaxOutputTokens = Math.min(runtimeConfig.maxOutputTokens, 400);
  if (effectiveMaxOutputTokens !== PHASE17_EFFECTIVE_MAX_OUTPUT_TOKENS) {
    fail('max_output_tokens_not_production', String(effectiveMaxOutputTokens));
  }
  const databaseEnv = PHASE17_FORBIDDEN_DATABASE_ENV.filter((name) => env[name]?.trim());
  if (databaseEnv.length > 0) {
    fail('production_database_configured', `unset ${databaseEnv.join(', ')} before running Phase 17`);
  }

  // ── Plan, ceilings, spend ────────────────────────────────────────────────
  const outputSchemaJson = JSON.stringify(RECOVERY_CANDIDATE_V2_OUTPUT_JSON_SCHEMA);
  const directCalls = buildPhase17CallPlan(cohort, { systemPrompt, outputSchemaJson });
  const progression = buildPhase17ProgressionCalls(cohort, directCalls.length + 1,
    (inputJson) => estimatePhase17InputTokens(inputJson, systemPrompt, outputSchemaJson));
  const calls = [...directCalls, ...progression.calls];
  const plannedCalls = calls.map((call) => call.planned);
  if (plannedCalls.length > PHASE17_MAX_CALLS_HARD) {
    fail('plan_exceeds_hard_ceiling', String(plannedCalls.length));
  }
  if (params.maxCalls !== null && (!Number.isSafeInteger(params.maxCalls) || params.maxCalls < 1
    || params.maxCalls > PHASE17_MAX_CALLS_HARD)) {
    fail('max_calls_invalid', `--max-calls must be an integer in 1..${PHASE17_MAX_CALLS_HARD}`);
  }
  if (live && params.maxCalls === null) fail('max_calls_required', 'live mode needs --max-calls');
  if (params.maxCalls !== null && params.maxCalls < plannedCalls.length) {
    fail('call_ceiling_mismatch', `${plannedCalls.length} planned calls exceed --max-calls `
      + `${params.maxCalls}; Phase 17 never runs a partial cohort`);
  }
  const maxCalls = params.maxCalls ?? plannedCalls.length;
  if (params.maxSpendUsd !== null && (!(params.maxSpendUsd > 0)
    || params.maxSpendUsd > PHASE17_MAX_SPEND_USD_HARD)) {
    fail('max_spend_invalid', `--max-spend-usd must be in (0, ${PHASE17_MAX_SPEND_USD_HARD}]`);
  }
  const maxSpendUsd = params.maxSpendUsd ?? PHASE17_MAX_SPEND_USD_HARD;
  for (const price of [params.inputUsdPerMillionTokens, params.outputUsdPerMillionTokens]) {
    if (price !== null && !(price > 0 && Number.isFinite(price))) fail('price_invalid', String(price));
  }
  const cost = estimatePhase17MaxSpend(plannedCalls, {
    maxOutputTokensPerCall: effectiveMaxOutputTokens,
    inputUsdPerMillionTokens: params.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: params.outputUsdPerMillionTokens,
  });
  if (live && cost.estimatedMaxSpendUsd === null) {
    fail('pricing_required', 'live mode needs confirmed --input-usd-per-mtok and --output-usd-per-mtok');
  }
  if (cost.estimatedMaxSpendUsd !== null && cost.estimatedMaxSpendUsd > maxSpendUsd) {
    fail('spend_ceiling_exceeded',
      `estimated maximum $${cost.estimatedMaxSpendUsd.toFixed(4)} exceeds $${maxSpendUsd}`);
  }

  // ── Live-only preconditions ──────────────────────────────────────────────
  const codeState = injected.codeState ?? gitCodeState(repoRoot);
  if (live) {
    if (!env.ANTHROPIC_API_KEY?.trim()) fail('provider_credentials_missing', 'ANTHROPIC_API_KEY');
    if (labels.state !== 'complete') {
      fail('labels_incomplete', `${labels.unlabeledUnitKeys.length} unit(s) have no human label`);
    }
    if (!codeState.treeClean || !codeState.commitSha) {
      fail('tree_not_clean', 'live qualification must describe an exact commit');
    }
  }

  // ── Freeze (before any provider call) ────────────────────────────────────
  const qualificationDigest = injected.qualificationSourceDigest
    ?? phase17QualificationSourceDigest;
  const qualificationBefore = qualificationDigest(repoRoot);
  const createdAt = (injected.now ?? (() => new Date()))().toISOString();
  const pins: Phase17Pins = {
    codeCommitSha: codeState.commitSha,
    treeClean: codeState.treeClean,
    corpusSha256: cohort.corpusSha256,
    corpusByteLength: cohort.corpusByteLength,
    labelSetSha256: labels.labelSetSha256,
    model: runtimeConfig.model,
    // Read back from the production request builder, not written by hand.
    temperature: contractPins.requestContract.temperature as 0,
    sdkMaxRetries: contractPins.requestContract.maxRetries as 0,
    timeoutMs: runtimeConfig.timeoutMs,
    maxOutputTokens: effectiveMaxOutputTokens,
    ...contractPins,
    // Equal to the accepted literal pins: the mismatch gate above already ran.
    requestContract: contractPins.requestContract as Phase17Pins['requestContract'],
  };
  const runId = `phase17-${hashCanonical({
    evaluationVersion: PHASE17_EVALUATION_VERSION, pins, createdAt, mode: params.mode,
    plan: plannedCalls, runNonce: injected.runNonce ?? randomUUID(),
  }).slice(0, 24)}`;
  const freeze: Phase17Freeze = {
    freezeVersion: 'phase17-continuation-freeze-v1',
    evaluationVersion: PHASE17_EVALUATION_VERSION,
    scoringVersion: PHASE17_SCORING_VERSION,
    runId,
    createdAt,
    executionMode: params.mode,
    providerExecution,
    harnessIntegrity,
    harnessOverrides: [...overridden],
    authority: PHASE17_AUTHORITY,
    promotionAuthorized: false,
    recoveryType: PHASE17_RECOVERY_TYPE,
    pins,
    labelState: labels.state,
    harnessIdentity: { ...PHASE17_HARNESS_IDENTITY },
    cohort: {
      unitKeys: cohort.units.map((unit) => unit.unitKey),
      nearIdenticalUnitKeys: cohort.units.filter((unit) => unit.nearIdentical)
        .map((unit) => unit.unitKey),
    },
    callPlan: {
      plannedCalls: plannedCalls.length, maxCalls, hardMaxCalls: PHASE17_MAX_CALLS_HARD,
      sdkRetries: 0, taskRetriesPerCall: 0, calls: plannedCalls,
    },
    cost: {
      inputUsdPerMillionTokens: params.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: params.outputUsdPerMillionTokens,
      estimatedInputTokens: cost.estimatedInputTokens,
      maxOutputTokens: cost.maxOutputTokens,
      estimatedMaxSpendUsd: cost.estimatedMaxSpendUsd,
      maxSpendUsd,
      hardMaxSpendUsd: PHASE17_MAX_SPEND_USD_HARD,
    },
    progressionCohort: {
      ...PHASE17_PROGRESSION_COHORT,
      predictedSelectedUnitKeys: progression.calls.map((call) => call.planned.unitKey),
      predictedReviewedSkipUnitKey: cohort.units.find((unit) =>
        unit.canonicalCandidates.some((candidate) =>
          candidate.candidateId === progression.prediction.reviewedSkip.candidateIds[0]))!.unitKey,
    },
    limitations: [...PHASE17_KNOWN_LIMITATIONS],
  };
  const frozen = writePhase17Freeze(params.artifactRoot, freeze);
  const startedAt = new Date().toISOString();

  // ==== provider boundary: nothing above this line can reach a provider ====
  let execution: Phase17ExecutionResult = {
    units: [], raw: [], executedCalls: 0, providerInvocations: 0,
    contractDeviationSequences: [], modelDeviationSequences: [],
  };
  let progressionRuns: Phase17ProgressionRunCheck[] | null = null;
  let localRaw: Readonly<{ path: string; sha256: string }> | null = null;
  if (live) {
    const seams = trustedSeams!;
    // Paid-call evidence is collected as each call completes and written before
    // anything else can fail -- including when execution itself throws.
    const rawRecords: Phase17LocalRawRecord[] = [];
    let executionCompleted = false;
    try {
    const measurement = {
      expectedByUnitKey: labels.expectedByUnitKey,
      expectedPromptSha256: pins.promptSha256,
      onRecord: (record: Phase17LocalRawRecord) => { rawRecords.push(record); },
      runtimeConfig,
      effectiveMaxOutputTokens,
      inputUsdPerMillionTokens: params.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: params.outputUsdPerMillionTokens,
    };
    const direct = await executePhase17Calls({ ...measurement, calls: directCalls, maxCalls }, {
      projectDurableProposal: injected.projectDurableProposal ?? seams.projectDurableProposal,
      createProvider: injected.createProvider,
      clock: injected.clock,
    });
    const progressed = await executePhase17Progression({
      ...measurement,
      cohort,
      calls: progression.calls,
      prediction: progression.prediction,
      callsAlreadyExecuted: direct.executedCalls,
      maxCalls,
    }, {
      scheduler: injected.scheduleRecovery ?? seams.scheduleRecovery,
      createProvider: injected.createProvider,
      clock: injected.clock,
    });
    progressionRuns = [...progressed.runs];
    execution = {
      units: [...direct.units, ...progressed.units],
      raw: [...direct.raw, ...progressed.raw],
      executedCalls: direct.executedCalls + progressed.executedCalls,
      providerInvocations: direct.providerInvocations + progressed.providerInvocations,
      contractDeviationSequences: [
        ...direct.contractDeviationSequences,
        ...progressed.records.filter((record) => record.requestDeviated)
          .map((record) => record.unit.sequence),
      ],
      modelDeviationSequences: [
        ...direct.modelDeviationSequences,
        ...progressed.records.filter((record) => record.modelDeviated)
          .map((record) => record.unit.sequence),
      ],
    };
    executionCompleted = true;
    } finally {
      localRaw = writePhase17LocalRaw(params.artifactRoot, runId, rawRecords,
        executionCompleted ? 'completed' : 'aborted');
    }
  }

  const { result: qualification, units } = evaluatePhase17Qualification({
    executionMode: params.mode,
    plannedSequences: plannedCalls.map((call) => call.sequence),
    units: execution.units,
    expectedByUnitKey: labels.expectedByUnitKey,
    labelledCandidateIdBySequence: new Map(calls.map((call) =>
      [call.planned.sequence, call.labelledCandidateIdBySentId])),
    injectionTargetBySequence: new Map(plannedCalls.map((call) =>
      [call.sequence, call.injectionTargetCandidateId])),
    executedCalls: execution.executedCalls,
    providerInvocations: execution.providerInvocations,
    maxCalls,
    // The harness holds no write path; the architecture guard proves it statically.
    authorityWrites: 0,
    effectiveTimeoutMs: runtimeConfig.timeoutMs,
    modelDeviationSequences: execution.modelDeviationSequences,
    contractDeviationSequences: execution.contractDeviationSequences,
    qualificationMutationDetected: qualificationDigest(repoRoot) !== qualificationBefore,
    progressionRuns,
    providerExecution,
    harnessIntegrity,
    responseIdentityVerified: execution.units.every(phase17ResponseIdentityVerified),
  });

  const costs = units.map((unit) => unit.estimatedCostUsd);
  const summary: Phase17EvaluationRun = {
    reportVersion: 'phase17-continuation-summary-v1',
    runId,
    freezeSha256: frozen.sha256,
    startedAt,
    finishedAt: new Date().toISOString(),
    executionMode: params.mode,
    providerExecution,
    harnessIntegrity,
    authority: PHASE17_AUTHORITY,
    promotionAuthorized: false,
    pins,
    accounting: {
      plannedCalls: plannedCalls.length,
      executedCalls: execution.executedCalls,
      providerInvocations: execution.providerInvocations,
      maxCalls,
      authorityWrites: 0,
      estimatedSpendUsd: live && costs.every((value) => value !== null)
        ? costs.reduce<number>((sum, value) => sum + value!, 0) : null,
    },
    latency: {
      providerMs: statistics(units.flatMap((unit: Phase17EvaluationUnit) =>
        unit.latency.providerMs === null ? [] : [unit.latency.providerMs])),
      totalMs: statistics(units.map((unit) => unit.latency.totalMs)),
    },
    units: [...units],
    qualification,
    limitations: [...PHASE17_KNOWN_LIMITATIONS],
  };
  // Raw evidence (if any calls ran) is already on disk; only then the summary.
  const written = writePhase17Summary(params.artifactRoot, summary);
  return {
    runId, providerExecution, harnessIntegrity, freeze, freezePath: frozen.path,
    freezeSha256: frozen.sha256, summary, summaryPath: written.path,
    localRawPath: localRaw?.path ?? null,
  };
}
