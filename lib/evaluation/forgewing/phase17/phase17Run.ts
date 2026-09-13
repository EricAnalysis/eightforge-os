import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
  PHASE17_PROVIDER_SDK_MAX_RETRIES,
  PHASE17_PROVIDER_TEMPERATURE,
  PHASE17_RECOVERY_TYPE,
  PHASE17_SCORING_VERSION,
  type Phase17EvaluationRun,
  type Phase17EvaluationUnit,
  type Phase17Freeze,
  type Phase17Pins,
  type Phase17ProgressionRunCheck,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';
import {
  executePhase17Calls,
  Phase17GuardError,
  type Phase17ExecutionDependencies,
  type Phase17ExecutionResult,
} from '@/lib/evaluation/forgewing/phase17/phase17Execution';
import {
  computePhase17ContractPins,
  phase17ContractPinMismatches,
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

export type Phase17RunParams = Readonly<{
  mode: 'dry_run' | 'provider_enabled';
  corpusBytes: Uint8Array | null;
  labelBytes: Uint8Array | string | null;
  repoRoot: string;
  artifactRoot: string;
  codeState: Readonly<{ commitSha: string | null; treeClean: boolean }>;
  env: Readonly<Record<string, string | undefined>>;
  maxCalls: number | null;
  maxSpendUsd: number | null;
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  runtimeConfig?: ForgewingRuntimeConfig;
  now?: () => Date;
  runNonce?: string;
}>;

export type Phase17RunDependencies = Partial<Phase17ExecutionDependencies> & Readonly<{
  /** The real scheduleRecoveryCandidateV2Shadow, wired by the script layer. */
  scheduleRecovery?: Phase17RecoveryScheduler;
  buildCohort?: (bytes: Uint8Array) => Promise<Phase17Cohort>;
  computeContractPins?: (repoRoot: string) => Phase17ContractPins;
  acceptedContractPins?: Phase17ContractPins;
  qualificationSourceDigest?: (repoRoot: string) => string;
}>;

export type Phase17RunOutcome = Readonly<{
  runId: string;
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
  const live = params.mode === 'provider_enabled';
  if (params.mode !== 'dry_run' && !live) fail('invalid_mode', String(params.mode));

  // ── Corpus, cohort, labels ────────────────────────────────────────────────
  if (!params.corpusBytes) {
    fail('corpus_missing', 'DN_PRICED_SCHEDULE_SOURCE_PDF is required; Phase 17 never skips');
  }
  const cohort = await (dependencies.buildCohort ?? buildPhase17DnCohort)(params.corpusBytes);
  if (!params.labelBytes) fail('labels_missing', 'the human label artifact is required');
  const labels = bindPhase17Labels(parsePhase17LabelSet(params.labelBytes), cohort);

  // ── Behavioral contract pins ─────────────────────────────────────────────
  const contractPins = (dependencies.computeContractPins ?? computePhase17ContractPins)(
    params.repoRoot);
  const mismatched = phase17ContractPinMismatches(contractPins,
    dependencies.acceptedContractPins ?? PHASE17_ACCEPTED_CONTRACT_PINS);
  if (mismatched.length > 0) fail('contract_mismatch', mismatched.join(', '));

  // ── Effective production runtime ─────────────────────────────────────────
  const runtimeConfig = params.runtimeConfig ?? getForgewingRuntimeConfig();
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
  const databaseEnv = PHASE17_FORBIDDEN_DATABASE_ENV.filter((name) => params.env[name]?.trim());
  if (databaseEnv.length > 0) {
    fail('production_database_configured', `unset ${databaseEnv.join(', ')} before running Phase 17`);
  }

  // ── Plan, ceilings, spend ────────────────────────────────────────────────
  const systemPrompt = loadRecoveryCandidateV2Prompt();
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
  if (live) {
    if (!params.env.ANTHROPIC_API_KEY?.trim()) fail('provider_credentials_missing', 'ANTHROPIC_API_KEY');
    if (labels.state !== 'complete') {
      fail('labels_incomplete', `${labels.unlabeledUnitKeys.length} unit(s) have no human label`);
    }
    if (!params.codeState.treeClean || !params.codeState.commitSha) {
      fail('tree_not_clean', 'live qualification must describe an exact commit');
    }
    if (!dependencies.projectDurableProposal) {
      fail('projection_missing', 'the real durable proposal projection must be supplied');
    }
    if (!dependencies.scheduleRecovery) {
      fail('scheduler_missing', 'the real Phase 16 recovery scheduler must be supplied');
    }
  }

  // ── Freeze (before any provider call) ────────────────────────────────────
  const qualificationDigest = dependencies.qualificationSourceDigest
    ?? phase17QualificationSourceDigest;
  const qualificationBefore = qualificationDigest(params.repoRoot);
  const createdAt = (params.now ?? (() => new Date()))().toISOString();
  const pins: Phase17Pins = {
    codeCommitSha: params.codeState.commitSha,
    treeClean: params.codeState.treeClean,
    corpusSha256: cohort.corpusSha256,
    corpusByteLength: cohort.corpusByteLength,
    labelSetSha256: labels.labelSetSha256,
    model: runtimeConfig.model,
    temperature: PHASE17_PROVIDER_TEMPERATURE,
    sdkMaxRetries: PHASE17_PROVIDER_SDK_MAX_RETRIES,
    timeoutMs: runtimeConfig.timeoutMs,
    maxOutputTokens: effectiveMaxOutputTokens,
    ...contractPins,
  };
  const runId = `phase17-${hashCanonical({
    evaluationVersion: PHASE17_EVALUATION_VERSION, pins, createdAt, mode: params.mode,
    plan: plannedCalls, runNonce: params.runNonce ?? randomUUID(),
  }).slice(0, 24)}`;
  const freeze: Phase17Freeze = {
    freezeVersion: 'phase17-continuation-freeze-v1',
    evaluationVersion: PHASE17_EVALUATION_VERSION,
    scoringVersion: PHASE17_SCORING_VERSION,
    runId,
    createdAt,
    executionMode: params.mode,
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
  if (live) {
    const measurement = {
      expectedByUnitKey: labels.expectedByUnitKey,
      runtimeConfig,
      effectiveMaxOutputTokens,
      inputUsdPerMillionTokens: params.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: params.outputUsdPerMillionTokens,
    };
    const direct = await executePhase17Calls({ ...measurement, calls: directCalls, maxCalls }, {
      projectDurableProposal: dependencies.projectDurableProposal!,
      createProvider: dependencies.createProvider,
      clock: dependencies.clock,
    });
    const progressed = await executePhase17Progression({
      ...measurement,
      cohort,
      calls: progression.calls,
      prediction: progression.prediction,
      callsAlreadyExecuted: direct.executedCalls,
      maxCalls,
    }, {
      scheduler: dependencies.scheduleRecovery!,
      createProvider: dependencies.createProvider,
      clock: dependencies.clock,
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
    qualificationMutationDetected: qualificationDigest(params.repoRoot) !== qualificationBefore,
    progressionRuns,
  });

  const costs = units.map((unit) => unit.estimatedCostUsd);
  const summary: Phase17EvaluationRun = {
    reportVersion: 'phase17-continuation-summary-v1',
    runId,
    freezeSha256: frozen.sha256,
    startedAt,
    finishedAt: new Date().toISOString(),
    executionMode: params.mode,
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
  const written = writePhase17Summary(params.artifactRoot, summary);
  const localRaw = live ? writePhase17LocalRaw(params.artifactRoot, runId, execution.raw) : null;
  return {
    runId, freeze, freezePath: frozen.path, freezeSha256: frozen.sha256,
    summary, summaryPath: written.path, localRawPath: localRaw?.path ?? null,
  };
}
