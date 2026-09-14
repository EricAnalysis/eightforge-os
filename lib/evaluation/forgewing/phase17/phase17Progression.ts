import { createHash } from 'node:crypto';

import type { RecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  groupRecoveryEvaluationUnits,
  planRecoveryEvaluation,
  recoveryEvaluationUnitIdentity,
  type RecoveryEvaluationPriorState,
  type RecoveryEvaluationUnit,
} from '@/lib/extraction/recovery/recoveryEvaluationPlanner';
import {
  RECOVERY_OPERATIONAL_POLICY,
  readRecoveryOperationalConfig,
} from '@/lib/extraction/recovery/recoveryOperationalPolicy';
import type { DurableRecoveryProposalV2 } from '@/lib/forgewingRecoveryProposal';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  runRecoveryCandidateV2Recommendation,
  type RecoveryCandidateV2RecommendationInput,
  type RecoveryCandidateV2RecommendationResult,
} from '@/lib/forgewing/tasks/recoveryCandidateV2';
import type { ForgewingRuntimeConfig } from '@/lib/forgewing/runtime/modelConfig';
import type { ForgewingProvider } from '@/lib/forgewing/runtime/client';
import type { Phase17Cohort } from '@/lib/evaluation/forgewing/phase17/dnContinuationCohort';
import { phase17UnitKey } from '@/lib/evaluation/forgewing/phase17/dnContinuationCohort';
import {
  PHASE17_EVALUATION_ORGANIZATION_ID,
  PHASE17_EVALUATION_SNAPSHOT_ID,
  PHASE17_HARNESS_IDENTITY,
  PHASE17_PROGRESSION_COHORT,
  type Phase17EvaluationUnit,
  type Phase17ProgressionRunCheck,
  type Phase17ProgressionViolation,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';
import {
  buildPhase17UnitRecord,
  createPhase17MeasuredProvider,
  Phase17GuardError,
  PHASE17_EVALUATION_ACTIVATION_ENV,
  phase17RuntimeConfigForTask,
  type Phase17LocalRawRecord,
  type Phase17MeasuredRecord,
  type Phase17MeasurementParams,
  type Phase17ProviderFactory,
} from '@/lib/evaluation/forgewing/phase17/phase17Execution';
import { phase17ProviderInputJson, type Phase17ExecutableCall }
  from '@/lib/evaluation/forgewing/phase17/phase17Plan';

/**
 * Live budget progression through the merged Phase 16 scheduler.
 *
 * Three standard document runs over the full DN candidate set, each with the
 * production one-slot budget. The real scheduler groups units, reads prior
 * state, asks the real planner which unit to serve, projects the durable
 * proposal, and hands records to its persistence seams. Every one of those
 * seams is replaced here by an in-memory evaluation sink; the scheduler is
 * injected by the caller because the evaluation subtree may not import it.
 *
 * Between runs the sink becomes the next run's prior state. Before run three a
 * simulated human confirmation marks the next unit reviewed, so the run must
 * skip it. A unit the scheduler selects that the frozen plan did not predict is
 * never sent to the provider.
 */

export type Phase17SinkOutcome = Readonly<{
  recoveryType: string;
  pageRepresentationDigest: string;
  candidateIds: readonly string[];
  outcomeCode: string;
  providerInvoked: boolean;
}>;

export type Phase17SchedulerInput = Readonly<{
  organizationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  extractionSnapshotId: string;
  pricingRows: readonly unknown[];
  sourceObservations: readonly unknown[];
  pricingSourceEligibility: unknown;
  recoveryCandidatesV2: readonly unknown[];
  env: Readonly<Record<string, string | undefined>>;
}>;

export type Phase17SchedulerDependencies = Readonly<{
  register: (task: () => Promise<void>) => void;
  run: (
    input: RecoveryCandidateV2RecommendationInput,
    dependencies?: Readonly<{
      config?: ForgewingRuntimeConfig;
      enabled?: boolean;
      env?: Readonly<Record<string, string | undefined>>;
      provider?: ForgewingProvider;
      budget?: ForgewingCallBudget;
    }>,
  ) => Promise<RecoveryCandidateV2RecommendationResult>;
  persistProposal: (proposal: DurableRecoveryProposalV2) => Promise<Readonly<{
    status: 'persisted'; proposalRowId: string; proposalDigestSha256: string; inserted: boolean;
  }>>;
  persistOutcome: (outcome: Phase17SinkOutcome) => Promise<Readonly<{
    status: 'persisted'; outcomeRowId: string; diagnosticId: string; inserted: boolean;
  }>>;
  loadPriorState: (query: Readonly<{
    organizationId: string; sourceDocumentId: string; sourceArtifactId: string;
  }>) => Promise<Readonly<{ status: 'ok'; state: RecoveryEvaluationPriorState }>>;
  budget: ForgewingCallBudget;
}>;

/** Structural shape of scheduleRecoveryCandidateV2Shadow, supplied by the script layer. */
export type Phase17RecoveryScheduler = (
  input: Phase17SchedulerInput,
  dependencies: Phase17SchedulerDependencies,
) => void;

export type Phase17ProgressionPrediction = Readonly<{
  selected: readonly RecoveryEvaluationUnit[];
  reviewedSkip: RecoveryEvaluationUnit;
}>;

function allCandidates(cohort: Phase17Cohort): RecoveryCandidateV2[] {
  return cohort.units.flatMap((unit) => [...unit.canonicalCandidates]);
}

function evaluationPolicy() {
  const operational = readRecoveryOperationalConfig(PHASE17_EVALUATION_ACTIVATION_ENV);
  return {
    // One standard run: the production one-slot document budget.
    overallCap: operational.maxCalls,
    perTypeCap: {
      priced_schedule_continuation_attribution:
        RECOVERY_OPERATIONAL_POLICY.priced_schedule_continuation_attribution.perTypeCallCap
          ?? operational.maxCalls,
      pricing_rate_multi_observation_cluster:
        RECOVERY_OPERATIONAL_POLICY.pricing_rate_multi_observation_cluster.perTypeCallCap ?? 0,
    },
    activation: {
      priced_schedule_continuation_attribution:
        operational.activationByType.priced_schedule_continuation_attribution,
      pricing_rate_multi_observation_cluster:
        operational.activationByType.pricing_rate_multi_observation_cluster,
    },
  };
}

/**
 * Predicts, from the real Phase 16 planner alone, which unit each standard run
 * serves. Deterministic regardless of provider outcome: a unit that produced a
 * proposal is skipped as proposed, and one that failed is deprioritized as
 * previously invoked, so the next run advances either way.
 */
export function predictPhase17Progression(cohort: Phase17Cohort): Phase17ProgressionPrediction {
  const units = groupRecoveryEvaluationUnits(allCandidates(cohort));
  const policy = evaluationPolicy();
  const handled: RecoveryEvaluationUnit[] = [];
  const selected: RecoveryEvaluationUnit[] = [];
  let reviewedSkip: RecoveryEvaluationUnit | null = null;
  for (let run = 0; run < PHASE17_PROGRESSION_COHORT.runs; run += 1) {
    const confirmed: string[] = [];
    if (run === PHASE17_PROGRESSION_COHORT.runs - 1) {
      const next = planRecoveryEvaluation(units, {
        proposedUnitIdentities: handled.map(recoveryEvaluationUnitIdentity),
        confirmedCandidateIds: [],
        providerInvokedUnitIdentities: [],
      }, policy).selected[0];
      if (!next) throw new Phase17GuardError('progression_prediction_failed', 'no unit to review');
      reviewedSkip = next;
      confirmed.push(next.candidateIds[0]!);
    }
    const plan = planRecoveryEvaluation(units, {
      proposedUnitIdentities: handled.map(recoveryEvaluationUnitIdentity),
      confirmedCandidateIds: confirmed,
      providerInvokedUnitIdentities: [],
    }, policy);
    if (plan.selected.length !== 1) {
      throw new Phase17GuardError('progression_prediction_failed',
        `run ${run} selects ${plan.selected.length} units`);
    }
    selected.push(plan.selected[0]!);
    handled.push(plan.selected[0]!);
  }
  return { selected, reviewedSkip: reviewedSkip! };
}

export function buildPhase17ProgressionCalls(cohort: Phase17Cohort,
  firstSequence: number, estimateTokens: (inputJson: string) => number):
  Readonly<{ calls: readonly Phase17ExecutableCall[]; prediction: Phase17ProgressionPrediction }> {
  const prediction = predictPhase17Progression(cohort);
  const calls = prediction.selected.map((unit, runIndex): Phase17ExecutableCall => {
    const candidates = [...unit.candidates];
    const inputJson = phase17ProviderInputJson(candidates);
    return {
      candidates,
      labelledCandidateIdBySentId: new Map(candidates.map((candidate) =>
        [candidate.candidateId, candidate.candidateId])),
      inputJson,
      planned: {
        sequence: firstSequence + runIndex,
        cohort: 'progression',
        unitKey: phase17UnitKey(candidates[0]!),
        runIndex,
        candidateOrder: 'canonical',
        adversarialKind: null,
        injectionTargetCandidateId: null,
        candidateIds: candidates.map((candidate) => candidate.candidateId),
        inputSha256: createHash('sha256').update(inputJson, 'utf8').digest('hex'),
        estimatedInputTokens: estimateTokens(inputJson),
      },
    };
  });
  return { calls, prediction };
}

export type Phase17ProgressionResult = Readonly<{
  records: readonly Phase17MeasuredRecord[];
  raw: readonly Phase17LocalRawRecord[];
  units: readonly Phase17EvaluationUnit[];
  executedCalls: number;
  providerInvocations: number;
  runs: readonly Phase17ProgressionRunCheck[];
}>;

export async function executePhase17Progression(params: Phase17MeasurementParams & Readonly<{
  cohort: Phase17Cohort;
  calls: readonly Phase17ExecutableCall[];
  prediction: Phase17ProgressionPrediction;
  callsAlreadyExecuted: number;
  maxCalls: number;
}>, dependencies: Readonly<{
  scheduler: Phase17RecoveryScheduler;
  createProvider?: Phase17ProviderFactory;
  clock?: () => number;
}>): Promise<Phase17ProgressionResult> {
  const clock = dependencies.clock ?? (() => performance.now());
  const candidates = allCandidates(params.cohort);
  const units = groupRecoveryEvaluationUnits(candidates);
  const unitKeyOf = (unit: RecoveryEvaluationUnit) => phase17UnitKey(unit.candidates[0]!);
  const proposals: DurableRecoveryProposalV2[] = [];
  const outcomes: Phase17SinkOutcome[] = [];
  const records: Phase17MeasuredRecord[] = [];
  const runs: Phase17ProgressionRunCheck[] = [];
  let executed = params.callsAlreadyExecuted;
  let previousInvokedKey: string | null = null;

  for (const [runIndex, call] of params.calls.entries()) {
    if (executed >= params.maxCalls) {
      throw new Phase17GuardError('calls_above_ceiling',
        `progression call ${call.planned.sequence} would exceed ${params.maxCalls}`);
    }
    executed += 1;
    const violations = new Set<Phase17ProgressionViolation>();
    const isReviewRun = runIndex === params.calls.length - 1;
    const priorState: RecoveryEvaluationPriorState = {
      proposedUnitIdentities: proposals.map((proposal) => recoveryEvaluationUnitIdentity({
        recoveryType: proposal.recoveryType,
        pageRepresentationDigest: proposal.candidates[0]!.pageRepresentationDigest,
        candidateIds: proposal.candidates.map((candidate) => candidate.candidateId),
      })),
      confirmedCandidateIds: isReviewRun ? [params.prediction.reviewedSkip.candidateIds[0]!] : [],
      providerInvokedUnitIdentities: outcomes.filter((outcome) => outcome.providerInvoked)
        .map((outcome) => recoveryEvaluationUnitIdentity({
          recoveryType: outcome.recoveryType as RecoveryEvaluationUnit['recoveryType'],
          pageRepresentationDigest: outcome.pageRepresentationDigest,
          candidateIds: outcome.candidateIds,
        })),
    };
    const handledKeys = units.filter((unit) =>
      priorState.proposedUnitIdentities.includes(recoveryEvaluationUnitIdentity(unit))
      || unit.candidateIds.some((id) => priorState.confirmedCandidateIds.includes(id)))
      .map(unitKeyOf).sort();

    const measured = createPhase17MeasuredProvider(call, params, dependencies.createProvider);
    const invokedUnitKeys: string[] = [];
    let taskResult: RecoveryCandidateV2RecommendationResult | null = null;
    let startedAt = 0;
    let providerReturnedAt = 0;
    const outcomesBefore = outcomes.length;
    const proposalsBefore = proposals.length;
    const budget = new ForgewingCallBudget(1);
    const tasks: (() => Promise<void>)[] = [];

    dependencies.scheduler({
      organizationId: PHASE17_EVALUATION_ORGANIZATION_ID,
      sourceDocumentId: PHASE17_HARNESS_IDENTITY.sourceDocumentId,
      sourceArtifactId: PHASE17_HARNESS_IDENTITY.sourceArtifactId,
      extractionSnapshotId: `${PHASE17_EVALUATION_SNAPSHOT_ID}-progression-${runIndex}`,
      pricingRows: [],
      sourceObservations: [],
      pricingSourceEligibility: null,
      recoveryCandidatesV2: candidates,
      env: PHASE17_EVALUATION_ACTIVATION_ENV,
    }, {
      register: (task) => { tasks.push(task); },
      run: async (input, taskDependencies = {}) => {
        const key = phase17UnitKey(input.candidates[0]!);
        invokedUnitKeys.push(key);
        if (key !== call.planned.unitKey) {
          // Never send an input the freeze did not pin.
          violations.add('unplanned_unit_selected');
          return { status: 'eligible_not_executed', reason: 'budget_exhausted', providerCalls: 0 };
        }
        startedAt = clock();
        taskResult = await runRecoveryCandidateV2Recommendation(input, {
          ...taskDependencies,
          config: phase17RuntimeConfigForTask(params.runtimeConfig),
          provider: measured.provider,
        });
        providerReturnedAt = clock();
        return taskResult;
      },
      persistProposal: async (proposal) => {
        proposals.push(proposal);
        return { status: 'persisted', proposalRowId: `phase17-evaluation-sink-proposal-${proposals.length}`,
          proposalDigestSha256: proposal.proposalDigestSha256, inserted: true };
      },
      persistOutcome: async (outcome) => {
        outcomes.push({
          recoveryType: outcome.recoveryType,
          pageRepresentationDigest: outcome.pageRepresentationDigest,
          candidateIds: [...outcome.candidateIds],
          outcomeCode: outcome.outcomeCode,
          providerInvoked: outcome.providerInvoked,
        });
        return { status: 'persisted', outcomeRowId: `phase17-evaluation-sink-outcome-${outcomes.length}`,
          diagnosticId: `phase17-evaluation-sink-diagnostic-${outcomes.length}`, inserted: true };
      },
      loadPriorState: async () => ({ status: 'ok', state: priorState }),
      budget,
    });
    if (tasks.length !== 1) violations.add('scheduler_did_not_register_planning_task');
    for (const task of tasks) await task();
    const finishedAt = clock();

    const runOutcomes = outcomes.slice(outcomesBefore);
    const runProposals = proposals.slice(proposalsBefore);
    if (!invokedUnitKeys.includes(call.planned.unitKey)) violations.add('planned_unit_not_invoked');
    if (measured.state.invocations !== 1) violations.add('provider_invocations_not_exactly_one');
    if (budget.used !== 1) violations.add('budget_slot_not_exactly_one');
    if (previousInvokedKey !== null && invokedUnitKeys.includes(previousInvokedKey)) {
      violations.add('run_did_not_advance');
    }
    const touchedIds = new Set([
      ...runOutcomes.flatMap((outcome) => outcome.candidateIds),
      ...invokedUnitKeys.flatMap((key) => units.filter((unit) => unitKeyOf(unit) === key)
        .flatMap((unit) => unit.candidateIds)),
    ]);
    const handled = units.filter((unit) => handledKeys.includes(unitKeyOf(unit)));
    if (handled.some((unit) => unit !== params.prediction.reviewedSkip
      && unit.candidateIds.some((id) => touchedIds.has(id)))) {
      violations.add('previously_handled_unit_rescheduled');
    }
    if (isReviewRun && params.prediction.reviewedSkip.candidateIds.some((id) => touchedIds.has(id))) {
      violations.add('reviewed_unit_not_skipped');
    }
    const expectedBudgetExhausted = units.length - handled.length - 1;
    const budgetExhaustedOutcomes = runOutcomes
      .filter((outcome) => outcome.outcomeCode === 'budget_exhausted').length;
    if (budgetExhaustedOutcomes !== expectedBudgetExhausted) {
      violations.add('budget_exhausted_outcomes_mismatch');
    }

    // Assigned inside the scheduler callback; widen past control-flow narrowing.
    const result: RecoveryCandidateV2RecommendationResult =
      (taskResult as RecoveryCandidateV2RecommendationResult | null)
      ?? { status: 'eligible_not_executed', reason: 'budget_exhausted', providerCalls: 0 };
    const accepted = result.status === 'requires_human_review' ? result : null;
    const durableProjection: Phase17EvaluationUnit['durableProjection'] = !accepted
      ? 'not_reached'
      : runProposals.some((proposal) => proposal.selectedCandidateId === accepted.selectedCandidateId
        && proposal.authority === 'non_authoritative' && proposal.requiresHumanReview === true)
        ? 'valid' : 'failed';
    const record = buildPhase17UnitRecord({
      call, result, measured, durableProjection,
      timings: { startedAt: startedAt || finishedAt,
        providerReturnedAt: providerReturnedAt || finishedAt, finishedAt },
      measurement: params,
    });
    records.push(record);
    params.onRecord?.(record.raw);
    runs.push({
      runIndex,
      sequence: call.planned.sequence,
      predictedUnitKey: call.planned.unitKey,
      invokedUnitKeys: [...invokedUnitKeys],
      providerInvocations: measured.state.invocations,
      budgetSlotsConsumed: budget.used,
      budgetExhaustedOutcomes,
      expectedBudgetExhaustedOutcomes: expectedBudgetExhausted,
      previouslyHandledUnitKeys: handledKeys,
      violations: [...violations].sort(),
    });
    previousInvokedKey = call.planned.unitKey;
  }

  return {
    records,
    raw: records.map((record) => record.raw),
    units: records.map((record) => record.unit),
    executedCalls: executed - params.callsAlreadyExecuted,
    providerInvocations: records.reduce((sum, record) => sum + record.unit.providerInvocations, 0),
    runs,
  };
}
