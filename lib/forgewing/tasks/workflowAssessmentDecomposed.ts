import { z } from 'zod';

import { canonicalJson, sha256Hex } from '@/lib/extraction/domain/hash';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  createObservedWorkflowAssessmentStageProvider,
  type WorkflowAssessmentStageProvider,
} from '@/lib/forgewing/runtime/observedWorkflowAssessmentClient';
import { WORKFLOW_ASSESSMENT_MAX_OUTPUT_TOKENS, WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS }
  from '@/lib/forgewing/runtime/modelConfig';
import {
  buildStageAGrammar,
  buildStageBGrammar,
  partitionStageBSteps,
  STAGE_A_SCHEMA,
  STAGE_B_DETAIL_SCHEMAS,
  STAGE_B_MAX_STEPS_PER_CALL,
  type StageIntakeVersion,
  type StageStep,
} from '@/lib/forgewing/runtime/workflowAssessmentStageGrammars';
import {
  FORGEWING_WORKFLOW_ASSESSMENT_DECOMPOSED_PROMPT_ID,
  FORGEWING_WORKFLOW_ASSESSMENT_DECOMPOSED_PROMPT_VERSION,
  loadWorkflowAssessmentStageAPrompt,
  loadWorkflowAssessmentStageBPrompt,
} from '@/lib/forgewing/runtime/workflowAssessmentStagePrompts';
import {
  WorkflowAssessmentModelOutputSchema,
  type WorkflowAssessmentModelOutput,
} from '@/lib/forgewing/runtime/workflowAssessmentStructuredOutput';
import {
  callWithin,
  failureReason,
  finalizeWorkflowAssessmentOutput,
  prepareWorkflowAssessmentInput,
  type ForgewingWorkflowAssessmentDependencies,
  type ForgewingWorkflowAssessmentInput,
  type ForgewingWorkflowAssessmentResult,
} from '@/lib/forgewing/tasks/workflowAssessment';

/**
 * Decomposed Workflow Assessment (P2 of DECOMPOSITION-PLAN.md).
 *
 *   stage A  one call, static grammar: structure plus each step's determinism
 *   stage B  one call per batch of at most 30 steps, grammar generated from A's
 *            validated steps: exactly one detail record per step
 *   compose  deterministic, content-preserving: re-key B into the canonical
 *            arrays in step order, inject stepId, derive detail IDs (D-2)
 *   then     the strict canonical schema and finalizeWorkflowAssessmentOutput,
 *            the same validation the single-call path uses
 *
 * Every stage fails closed. Nothing is repaired, inferred, retried or persisted
 * here; an attempt is the whole pipeline (D-1).
 */

/** Per-stage limits, inside the Workflow Assessment ceilings (26,000 tokens, 600 s). */
export const WORKFLOW_ASSESSMENT_STAGE_LIMITS = Object.freeze({
  A: Object.freeze({ maxOutputTokens: 20_000, timeoutMs: 400_000 }),
  B: Object.freeze({ maxOutputTokens: 8_000, timeoutMs: 200_000 }),
});

/** Stage A plus every stage B batch for the 40-step maximum. */
export const WORKFLOW_ASSESSMENT_DECOMPOSED_MAX_CALLS =
  1 + Math.ceil(40 / STAGE_B_MAX_STEPS_PER_CALL);

/** Detail-record identities derived from stepId (D-2): identity, never content. */
export const DERIVED_DETAIL_ID_SUFFIX = Object.freeze({
  rule: '-rule', verification: '-verification', extraction: '-extraction',
  recovery: '-recovery', decision: '-decision', advisory: '-advisory',
});

type StageAOutput = Pick<WorkflowAssessmentModelOutput,
  'summary' | 'documents' | 'workflowSteps' | 'evidenceRelationships' | 'failureConsequences' | 'limitations'>;

/** Per provider call, the same vocabulary as the durable provider-call ledger. */
export type WorkflowAssessmentStageCallOutcome =
  | 'succeeded' | 'provider_failed' | 'provider_timeout' | 'output_truncated' | 'output_invalid';
export type WorkflowAssessmentStageOutcome = Readonly<{
  stage: 'A' | 'B'; batch: number; outcome: WorkflowAssessmentStageCallOutcome;
}>;

export type DecomposedWorkflowAssessmentDependencies = ForgewingWorkflowAssessmentDependencies & Readonly<{
  stageProvider?: WorkflowAssessmentStageProvider;
  /**
   * Durable accounting (P4). Called, and awaited, as soon as each provider call's
   * own stage-level verdict is known: stage A before any stage B spend, each
   * stage B batch as soon as that batch settles. So a call already paid for is
   * recorded even if a later stage, the route budget or the process ends the
   * attempt. 'succeeded' means that stage's output passed its own strict stage
   * schema. A later composition or finalization failure is an attempt-level
   * outcome; it does not retroactively relabel calls that were already recorded.
   */
  onStageCallSettled?: (outcome: WorkflowAssessmentStageOutcome) => Promise<void> | void;
  /** Called once per attempt, after the verdict, with the same stage-level outcomes in call order. */
  onStageOutcomes?: (outcomes: readonly WorkflowAssessmentStageOutcome[]) => void;
}>;

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

/**
 * Pure composition of validated stage outputs into the canonical model output.
 * Values are copied unchanged; only stepId and derived IDs are added.
 */
export function composeDecomposedWorkflowAssessment(
  stageA: StageAOutput,
  records: Readonly<Record<string, unknown>>,
): WorkflowAssessmentModelOutput {
  const out: WorkflowAssessmentModelOutput = {
    summary: stageA.summary, documents: stageA.documents, workflowSteps: stageA.workflowSteps,
    extractionRequirements: [], deterministicRuleProposals: [], evidenceRelationships: stageA.evidenceRelationships,
    verificationRuleProposals: [], forgewingRecoveryTasks: [], humanDecisionPoints: [], advisorySteps: [],
    failureConsequences: stageA.failureConsequences, limitations: stageA.limitations,
  };
  const s = DERIVED_DETAIL_ID_SUFFIX;
  type Out = WorkflowAssessmentModelOutput;
  const fields = (record: unknown) => record as Record<string, unknown>;
  for (const step of stageA.workflowSteps) {
    const id = step.stepId;
    const record = records[id];
    if (record === undefined) throw new Error(`compose_missing_record:${id}`);
    switch (step.classification) {
      case 'RULE': out.deterministicRuleProposals.push({ ruleId: `${id}${s.rule}`, stepId: id, ...fields(record) } as Out['deterministicRuleProposals'][number]); break;
      case 'VERIFY': out.verificationRuleProposals.push({ ruleId: `${id}${s.verification}`, stepId: id, ...fields(record) } as Out['verificationRuleProposals'][number]); break;
      case 'EXTRACT': out.extractionRequirements.push({ requirementId: `${id}${s.extraction}`, stepId: id, ...fields(record) } as Out['extractionRequirements'][number]); break;
      case 'RECOVER': {
        const recover = record as { extractionRequirement: unknown; recoveryTask: unknown };
        out.extractionRequirements.push({ requirementId: `${id}${s.extraction}`, stepId: id, ...fields(recover.extractionRequirement) } as Out['extractionRequirements'][number]);
        out.forgewingRecoveryTasks.push({ taskId: `${id}${s.recovery}`, stepId: id, ...fields(recover.recoveryTask) } as Out['forgewingRecoveryTasks'][number]);
        break;
      }
      case 'HUMAN': out.humanDecisionPoints.push({ decisionId: `${id}${s.decision}`, stepId: id, ...fields(record) } as Out['humanDecisionPoints'][number]); break;
      case 'ADVISORY': out.advisorySteps.push({ advisoryId: `${id}${s.advisory}`, stepId: id, ...fields(record) } as Out['advisorySteps'][number]); break;
      default: throw new Error(`compose_unknown_classification:${id}`);
    }
  }
  return out;
}

export async function runDecomposedWorkflowAssessment(
  rawInput: ForgewingWorkflowAssessmentInput,
  dependencies: DecomposedWorkflowAssessmentDependencies = {},
): Promise<ForgewingWorkflowAssessmentResult> {
  const prepared = prepareWorkflowAssessmentInput(rawInput, dependencies);
  if ('status' in prepared) return prepared;
  const { config, bounded, input } = prepared;
  const version = input.submissionSchemaVersion as StageIntakeVersion;
  const provider = dependencies.stageProvider ?? createObservedWorkflowAssessmentStageProvider(() => undefined);
  const budget = dependencies.budget ?? new ForgewingCallBudget(WORKFLOW_ASSESSMENT_DECOMPOSED_MAX_CALLS);
  const stageCalls: { stage: 'A' | 'B'; batch: number; steps: number; promptSha256: string; grammarSha256: string }[] = [];
  const limit = (stage: keyof typeof WORKFLOW_ASSESSMENT_STAGE_LIMITS) => ({
    model: config.model,
    maxOutputTokens: Math.min(WORKFLOW_ASSESSMENT_STAGE_LIMITS[stage].maxOutputTokens, config.maxOutputTokens, WORKFLOW_ASSESSMENT_MAX_OUTPUT_TOKENS),
    timeoutMs: Math.min(WORKFLOW_ASSESSMENT_STAGE_LIMITS[stage].timeoutMs, config.timeoutMs, WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS),
  });
  const call = async (stage: 'A' | 'B', batch: number, steps: number, prompt: string, grammar: Record<string, unknown>,
    payload: Record<string, unknown>) => {
    stageCalls.push({ stage, batch, steps, promptSha256: sha256Hex(prompt), grammarSha256: sha256Hex(JSON.stringify(grammar)) });
    return callWithin((request) => provider(request, { stage, batch, prompt, grammar }),
      { ...limit(stage), inputJson: canonicalJson(payload) });
  };
  const outcomes: { stage: 'A' | 'B'; batch: number; outcome: WorkflowAssessmentStageCallOutcome }[] = [];
  const settle = async (entry: { stage: 'A' | 'B'; batch: number; outcome: WorkflowAssessmentStageCallOutcome }) => {
    outcomes.push(entry);
    await dependencies.onStageCallSettled?.(Object.freeze({ ...entry }));
  };
  const finish = (result: ForgewingWorkflowAssessmentResult): ForgewingWorkflowAssessmentResult => {
    const ordered = [...outcomes].sort((a, b) => (a.stage === b.stage ? a.batch - b.batch : a.stage === 'A' ? -1 : 1));
    dependencies.onStageOutcomes?.(ordered.map((entry) => Object.freeze({ ...entry })));
    return result;
  };
  const providerFailure = (stage: string, error: unknown): ForgewingWorkflowAssessmentResult & { status: string; reason: string } => {
    const reason = failureReason(error);
    return reason === 'provider_truncated_output'
      ? { status: 'structured_output_invalid', reason: `${stage}_${reason}` }
      : { status: 'provider_failed', reason: `${stage}_${reason}` };
  };
  const callOutcome = (error: unknown): WorkflowAssessmentStageCallOutcome => {
    const reason = failureReason(error);
    return reason === 'provider_timeout' ? 'provider_timeout'
      : reason === 'provider_truncated_output' ? 'output_truncated' : 'provider_failed';
  };

  // ---- Stage A ----
  if (!budget.tryConsume()) return finish({ status: 'provider_failed', reason: 'budget_exhausted' });
  let rawA: string;
  try {
    rawA = await call('A', 0, 0, loadWorkflowAssessmentStageAPrompt(), buildStageAGrammar(version), { ...bounded, stage: 'A' });
  } catch (error) {
    await settle({ stage: 'A', batch: 0, outcome: callOutcome(error) });
    return finish(providerFailure('stage_a', error));
  }
  const rejectA = async (reason: string, status: 'structured_output_invalid' | 'deterministic_validation_failed' = 'structured_output_invalid') => {
    await settle({ stage: 'A', batch: 0, outcome: 'output_invalid' });
    return finish({ status, reason });
  };
  let jsonA: unknown;
  try { jsonA = parseJson(rawA); } catch { return rejectA('stage_a_invalid_json'); }
  const parsedA = STAGE_A_SCHEMA.safeParse(jsonA);
  if (!parsedA.success) return rejectA('stage_a_schema_rejected');
  const stageA = parsedA.data as StageAOutput;
  if (new Set(stageA.workflowSteps.map((s) => s.stepId)).size !== stageA.workflowSteps.length) {
    return rejectA('stage_a_duplicate_step_id', 'deterministic_validation_failed');
  }
  await settle({ stage: 'A', batch: 0, outcome: 'succeeded' });

  // ---- Stage B: batches in parallel; every batch is judged, every batch must succeed ----
  const batches = partitionStageBSteps(stageA.workflowSteps.map((s) => ({ stepId: s.stepId, classification: s.classification })));
  for (let i = 0; i < batches.length; i += 1) {
    if (!budget.tryConsume()) return finish({ status: 'provider_failed', reason: 'budget_exhausted' });
  }
  const promptB = loadWorkflowAssessmentStageBPrompt();
  type BatchFailure = ForgewingWorkflowAssessmentResult & { reason: string };
  type BatchResult = Readonly<{ records: Record<string, unknown> }> | Readonly<{ failure: BatchFailure }>;
  // Each batch calls, validates and is recorded on its own, so a settled batch is accounted for
  // even while a sibling batch is still running. Results are then combined in batch order.
  const runBatch = async (index: number, batch: readonly StageStep[]): Promise<BatchResult> => {
    const fail = async (failure: BatchFailure, outcome: WorkflowAssessmentStageCallOutcome): Promise<BatchResult> => {
      await settle({ stage: 'B', batch: index, outcome });
      return { failure };
    };
    let raw: string;
    try {
      raw = await call('B', index, batch.length, promptB, buildStageBGrammar(batch),
        { ...bounded, stage: 'B', stageA, stageBStepIds: batch.map((s) => s.stepId) });
    } catch (error) { return fail(providerFailure(`stage_b${index}`, error), callOutcome(error)); }
    let json: unknown;
    try { json = parseJson(raw); } catch {
      return fail({ status: 'structured_output_invalid', reason: `stage_b${index}_invalid_json` }, 'output_invalid');
    }
    const batchSchema = z.object(Object.fromEntries(batch.map((s) =>
      [s.stepId, STAGE_B_DETAIL_SCHEMAS[s.classification as keyof typeof STAGE_B_DETAIL_SCHEMAS]]))).strict();
    const parsedB = batchSchema.safeParse(json);
    if (!parsedB.success) return fail({ status: 'structured_output_invalid', reason: `stage_b${index}_schema_rejected` }, 'output_invalid');
    await settle({ stage: 'B', batch: index, outcome: 'succeeded' });
    return { records: parsedB.data };
  };
  const batchResults = await Promise.all(batches.map((batch, index) => runBatch(index, batch)));
  const records: Record<string, unknown> = {};
  let firstFailure: BatchFailure | null = null;
  for (const result of batchResults) {
    if ('failure' in result) firstFailure ??= result.failure;
    else Object.assign(records, result.records);
  }
  if (firstFailure) return finish(firstFailure);

  // ---- Compose, then the canonical strict schema and the shared finalization ----
  const composed = WorkflowAssessmentModelOutputSchema.safeParse(composeDecomposedWorkflowAssessment(stageA, records));
  if (!composed.success) return finish({ status: 'structured_output_invalid', reason: 'composed_schema_rejected' });
  const finalized = finalizeWorkflowAssessmentOutput(composed.data, prepared);
  if (!finalized.ok) return finish({ status: 'deterministic_validation_failed', reason: finalized.reason });
  return finish({
    status: 'requires_human_review',
    assessment: finalized.assessment,
    metadata: {
      model: config.model,
      promptTemplateId: FORGEWING_WORKFLOW_ASSESSMENT_DECOMPOSED_PROMPT_ID,
      promptTemplateVersion: FORGEWING_WORKFLOW_ASSESSMENT_DECOMPOSED_PROMPT_VERSION,
      calls: budget.used,
      stageCalls,
    },
  });
}
