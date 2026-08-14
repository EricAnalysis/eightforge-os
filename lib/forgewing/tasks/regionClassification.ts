import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { FORGEWING_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';
import {
  ForgewingProposalBundleSchema,
  type ForgewingEvidenceRef,
  type ForgewingProposalBundle,
} from '@/lib/forgewing/proposal/schema';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  callClaudeForRegionClassification,
  FORGEWING_REGION_CLASSIFICATION_PROMPT_ID,
  FORGEWING_REGION_CLASSIFICATION_PROMPT_VERSION,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';
import {
  getForgewingRuntimeConfig,
  type ForgewingRuntimeConfig,
} from '@/lib/forgewing/runtime/modelConfig';
import {
  parseRegionClassificationModelOutput,
  type RegionClassificationModelOutput,
} from '@/lib/forgewing/runtime/structuredOutput';

const MAX_CELLS = 200;
const MAX_TEXT_CHARACTERS = 8_000;
const MAX_EVIDENCE_TEXT_CHARACTERS = 4_000;

const boxSchema = z.object({
  coordinateSpace: z.literal('page_normalized'),
  origin: z.literal('top_left'),
  x0: z.number().min(0).max(1),
  y0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
}).strict().refine((box) => box.x0 < box.x1 && box.y0 < box.y1, 'invalid bounding box');

const physicalCoordinateSchema = z.object({
  physicalPageNumber: z.number().int().positive(),
  artifactLocalIndex: z.number().int().nonnegative().nullable(),
  sourceLayer: z.enum(['pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact']),
}).strict();

const observationSchema = z.object({
  observationId: z.string().min(1).max(200),
  kind: z.enum(['segment', 'cell']),
  organizationId: z.string().min(1).max(200),
  sourceDocumentId: z.string().min(1).max(200),
  sourceArtifactId: z.string().min(1).max(200),
  extractionSnapshotId: z.string().min(1).max(200),
  pageArtifactId: z.string().min(1).max(200),
  page: z.number().int().positive(),
  boundingBox: boxSchema,
  text: z.string().max(1_000_000),
  readingOrder: z.number().int().nonnegative(),
  physicalCoordinate: physicalCoordinateSchema.optional(),
  rowStart: z.number().int().nonnegative().optional(),
  rowSpan: z.number().int().positive().optional(),
  columnStart: z.number().int().nonnegative().optional(),
  columnSpan: z.number().int().positive().optional(),
  structure: z.string().min(1).max(100).optional(),
  targetSegmentId: z.string().min(1).max(200).optional(),
}).strict();

const segmentSchema = observationSchema.extend({
  kind: z.literal('segment'),
  organizationId: z.string().min(1).max(200),
  chainCompleteness: z.enum(['complete', 'partial', 'ambiguous', 'unchained']),
  detectionKinds: z.array(z.string().min(1).max(100)).max(20),
}).strict();

const taskInputSchema = z.object({
  organizationId: z.string().min(1).max(200),
  sourceDocumentId: z.string().min(1).max(200),
  extractionSnapshotId: z.string().min(1).max(200),
  segments: z.array(segmentSchema),
  cells: z.array(observationSchema.extend({ kind: z.literal('cell') }).strict()),
}).strict();

export type ForgewingRegionSegment = z.input<typeof segmentSchema>;
export type ForgewingRegionCell = z.input<typeof taskInputSchema.shape.cells.element>;
export type ForgewingRegionClassificationInput = z.input<typeof taskInputSchema>;

type BoundedTaskInput = Readonly<{
  taskType: 'region_classification';
  target: z.output<typeof segmentSchema>;
  observations: readonly z.output<typeof observationSchema>[];
  truncated: boolean;
}>;

export type ForgewingRuntimeWarning =
  | 'input_truncated'
  | 'input_contract_violation'
  | 'budget_exhausted'
  | 'anthropic_not_configured'
  | 'provider_timeout'
  | 'provider_error'
  | 'invalid_model_json'
  | 'model_schema_rejected'
  | 'unknown_evidence_reference';

export type ForgewingRuntimeMetadata = Readonly<{
  model: string;
  promptTemplateId: typeof FORGEWING_REGION_CLASSIFICATION_PROMPT_ID;
  promptTemplateVersion: typeof FORGEWING_REGION_CLASSIFICATION_PROMPT_VERSION;
  timeoutMs: number;
  maxOutputTokens: number;
  calls: number;
  inputTruncated: boolean;
}>;

export type ForgewingRegionClassificationResult =
  | Readonly<{ status: 'skipped'; reason: 'forgewing_disabled' | 'no_candidate_regions' }>
  | Readonly<{
      status: 'failed';
      reason: 'input_contract_violation';
      warnings: readonly ['input_contract_violation'];
      metadata: ForgewingRuntimeMetadata;
    }>
  | Readonly<{
      status: 'applied' | 'abstained';
      bundle: ForgewingProposalBundle;
      warnings: readonly ForgewingRuntimeWarning[];
      metadata: ForgewingRuntimeMetadata;
    }>;

export type ForgewingRegionClassificationDependencies = Readonly<{
  config?: ForgewingRuntimeConfig;
  provider?: ForgewingProvider;
  budget?: ForgewingCallBudget;
}>;

function compareSegments(
  left: z.output<typeof segmentSchema>,
  right: z.output<typeof segmentSchema>,
): number {
  const priority = { ambiguous: 0, partial: 1, complete: 2, unchained: 2 } as const;
  return priority[left.chainCompleteness] - priority[right.chainCompleteness]
    || left.page - right.page
    || left.boundingBox.y0 - right.boundingBox.y0
    || left.boundingBox.x0 - right.boundingBox.x0
    || left.readingOrder - right.readingOrder
    || left.observationId.localeCompare(right.observationId);
}

function compareCells(
  left: z.output<typeof observationSchema>,
  right: z.output<typeof observationSchema>,
): number {
  return (left.rowStart ?? 0) - (right.rowStart ?? 0)
    || (left.columnStart ?? 0) - (right.columnStart ?? 0)
    || left.boundingBox.y0 - right.boundingBox.y0
    || left.boundingBox.x0 - right.boundingBox.x0
    || left.readingOrder - right.readingOrder
    || left.observationId.localeCompare(right.observationId);
}

function boundedSlice(input: z.output<typeof taskInputSchema>): BoundedTaskInput | null {
  const allObservationIds = [
    ...input.segments.map((segment) => segment.observationId),
    ...input.cells.map((cell) => cell.observationId),
  ];
  if (new Set(allObservationIds).size !== allObservationIds.length) {
    throw new Error('input_contract_violation');
  }
  if (input.segments.some((segment) => (
    segment.organizationId !== input.organizationId
    || segment.sourceDocumentId !== input.sourceDocumentId
    || segment.extractionSnapshotId !== input.extractionSnapshotId
  ))) {
    throw new Error('input_contract_violation');
  }
  const target = [...input.segments].sort(compareSegments)[0];
  if (!target) return null;
  if (
    target.organizationId !== input.organizationId
    || target.sourceDocumentId !== input.sourceDocumentId
  ) {
    throw new Error('input_contract_violation');
  }
  if (input.segments.some((segment) => segment.sourceArtifactId !== target.sourceArtifactId)) {
    throw new Error('input_contract_violation');
  }
  if (input.cells.some((cell) => (
    cell.organizationId !== input.organizationId
    || cell.sourceDocumentId !== input.sourceDocumentId
    || cell.sourceArtifactId !== target.sourceArtifactId
    || cell.extractionSnapshotId !== input.extractionSnapshotId
  ))) {
    throw new Error('input_contract_violation');
  }

  const targetCells = input.cells.filter(
    (cell) => cell.targetSegmentId === target.observationId,
  );
  if (targetCells.some((cell) => (
    cell.organizationId !== target.organizationId
    || cell.sourceDocumentId !== target.sourceDocumentId
    || cell.sourceArtifactId !== target.sourceArtifactId
    || cell.extractionSnapshotId !== input.extractionSnapshotId
    || cell.pageArtifactId !== target.pageArtifactId
    || cell.page !== target.page
  ))) {
    throw new Error('input_contract_violation');
  }
  const eligibleCells = targetCells
    .sort(compareCells);
  const boundedTarget = target.text.length > MAX_EVIDENCE_TEXT_CHARACTERS
    ? { ...target, text: target.text.slice(0, MAX_EVIDENCE_TEXT_CHARACTERS) }
    : target;
  let characters = boundedTarget.text.length;
  const observations: z.output<typeof observationSchema>[] = [];
  let truncated = eligibleCells.length > MAX_CELLS || boundedTarget.text !== target.text;
  for (const cell of eligibleCells) {
    const boundedCell = cell.text.length > MAX_EVIDENCE_TEXT_CHARACTERS
      ? { ...cell, text: cell.text.slice(0, MAX_EVIDENCE_TEXT_CHARACTERS) }
      : cell;
    if (observations.length >= MAX_CELLS || characters + boundedCell.text.length > MAX_TEXT_CHARACTERS) {
      truncated = true;
      break;
    }
    if (boundedCell.text !== cell.text) truncated = true;
    observations.push(boundedCell);
    characters += boundedCell.text.length;
  }
  return { taskType: 'region_classification', target: boundedTarget, observations, truncated };
}

function metadata(
  config: ForgewingRuntimeConfig,
  calls: number,
  inputTruncated: boolean,
): ForgewingRuntimeMetadata {
  return {
    model: config.model,
    promptTemplateId: FORGEWING_REGION_CLASSIFICATION_PROMPT_ID,
    promptTemplateVersion: FORGEWING_REGION_CLASSIFICATION_PROMPT_VERSION,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    calls,
    inputTruncated,
  };
}

function evidenceRef(
  observation: z.output<typeof observationSchema>,
  proposalPhysical: Readonly<{
    physicalPageNumber: number;
    artifactLocalIndex: number | null;
  }> | undefined,
): ForgewingEvidenceRef {
  return {
    artifactId: observation.observationId,
    sourceDocumentId: observation.sourceDocumentId,
    sourceArtifactId: observation.sourceArtifactId,
    pageArtifactId: observation.pageArtifactId,
    boundingBox: observation.boundingBox,
    ...(observation.text.trim().length > 0 ? { rawSpan: observation.text } : {}),
    ...(proposalPhysical && observation.physicalCoordinate ? {
      physicalPageNumber: observation.physicalCoordinate.physicalPageNumber,
      ...(proposalPhysical.artifactLocalIndex == null
        ? {}
        : { artifactLocalIndex: proposalPhysical.artifactLocalIndex }),
      sourceLayer: observation.physicalCoordinate.sourceLayer,
    } : {}),
  };
}

function makeBundle(
  input: z.output<typeof taskInputSchema>,
  bounded: BoundedTaskInput,
  inputHash: string,
  modelOutput?: RegionClassificationModelOutput,
  abstention?: Readonly<{ reason: 'budget_unavailable' | 'runtime_unavailable'; detail: string }>,
): ForgewingProposalBundle {
  const boundedEvidence = [bounded.target, ...bounded.observations];
  const taskId = `forgewing-task-${inputHash.slice(0, 32)}`;
  const run = {
    runId: `forgewing-run-${inputHash.slice(0, 32)}`,
    organizationId: input.organizationId,
    extractionSnapshotId: input.extractionSnapshotId,
    inputSnapshotHash: inputHash,
  };
  if (abstention) {
    return ForgewingProposalBundleSchema.parse({
      schemaVersion: FORGEWING_PROPOSAL_SCHEMA_VERSION,
      authority: 'non_authoritative',
      run,
      taskId,
      taskType: 'region_classification',
      proposals: [],
      abstentions: [{
        taskId,
        taskType: 'region_classification',
        sourceDocumentId: input.sourceDocumentId,
        sourceArtifactId: bounded.target.sourceArtifactId,
        extractionSnapshotId: input.extractionSnapshotId,
        inputObservationIds: boundedEvidence.map((item) => item.observationId),
        reason: abstention.reason,
        detail: abstention.detail,
      }],
    });
  }

  if (!modelOutput) throw new Error('model output is required');
  const observations = new Map(boundedEvidence.map((item) => [item.observationId, item]));
  const selected = modelOutput.evidenceIds.map((id) => {
    const observation = observations.get(id);
    if (!observation) throw new Error('unknown_evidence_reference');
    return observation;
  });
  const selectedPhysical = selected.map((observation) => observation.physicalCoordinate);
  const proposalPhysical = selectedPhysical.length > 0
    && selectedPhysical.every(
      (coordinate) => coordinate != null
        && coordinate.physicalPageNumber === selectedPhysical[0]?.physicalPageNumber
        && coordinate.artifactLocalIndex === selectedPhysical[0]?.artifactLocalIndex,
    )
      ? selectedPhysical[0]
      : undefined;
  const proposalBase = {
    proposalId: `forgewing-proposal-${inputHash.slice(0, 32)}`,
    taskId,
    taskType: 'region_classification' as const,
    sourceDocumentId: bounded.target.sourceDocumentId,
    sourceArtifactId: bounded.target.sourceArtifactId,
    extractionSnapshotId: input.extractionSnapshotId,
    pageArtifactId: bounded.target.pageArtifactId,
    ...(proposalPhysical == null ? {} : {
      physicalPageNumber: proposalPhysical.physicalPageNumber,
      ...(proposalPhysical.artifactLocalIndex == null
        ? {}
        : { artifactLocalIndex: proposalPhysical.artifactLocalIndex }),
    }),
    confidence: modelOutput.confidence,
    ...(modelOutput.rationale ? { rationale: modelOutput.rationale } : {}),
    inputObservationIds: modelOutput.evidenceIds,
    evidence: selected.map((observation) => evidenceRef(
      observation,
      proposalPhysical,
    )),
  };
  const proposal = modelOutput.state === 'observed' || modelOutput.state === 'inferred'
    ? { ...proposalBase, state: modelOutput.state, value: { label: modelOutput.classification } }
    : modelOutput.state === 'insufficient_evidence'
      ? {
          ...proposalBase,
          state: modelOutput.state,
          missingEvidence: modelOutput.missingEvidence.map((code) => ({ code })),
        }
      : { ...proposalBase, state: modelOutput.state };

  return ForgewingProposalBundleSchema.parse({
    schemaVersion: FORGEWING_PROPOSAL_SCHEMA_VERSION,
    authority: 'non_authoritative',
    run,
    taskId,
    taskType: 'region_classification',
    proposals: [proposal],
    abstentions: [],
  });
}

function failureWarning(error: unknown): ForgewingRuntimeWarning {
  const message = error instanceof Error ? error.message : '';
  const constructorName = error && typeof error === 'object'
    ? error.constructor?.name ?? ''
    : '';
  if (
    message === 'provider_timeout'
    || message === 'Request timed out'
    || constructorName === 'APIConnectionTimeoutError'
  ) return 'provider_timeout';
  if (message === 'invalid_model_json') return 'invalid_model_json';
  if (message === 'model_schema_rejected') return 'model_schema_rejected';
  if (message === 'unknown_evidence_reference') return 'unknown_evidence_reference';
  if (message.includes('ANTHROPIC_API_KEY')) return 'anthropic_not_configured';
  return 'provider_error';
}

async function callProviderWithin(
  provider: ForgewingProvider,
  request: Parameters<ForgewingProvider>[0],
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider(request),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('provider_timeout')), request.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runForgewingRegionClassification(
  rawInput: ForgewingRegionClassificationInput,
  dependencies: ForgewingRegionClassificationDependencies = {},
): Promise<ForgewingRegionClassificationResult> {
  const config = dependencies.config ?? getForgewingRuntimeConfig();
  if (!config.enabled) return { status: 'skipped', reason: 'forgewing_disabled' };

  const parsed = taskInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      status: 'failed',
      reason: 'input_contract_violation',
      warnings: ['input_contract_violation'],
      metadata: metadata(config, 0, false),
    };
  }
  let bounded: BoundedTaskInput | null;
  try {
    bounded = boundedSlice(parsed.data);
  } catch {
    return {
      status: 'failed',
      reason: 'input_contract_violation',
      warnings: ['input_contract_violation'],
      metadata: metadata(config, 0, false),
    };
  }
  if (!bounded) return { status: 'skipped', reason: 'no_candidate_regions' };

  const inputHash = hashCanonical(bounded);
  const budget = dependencies.budget ?? new ForgewingCallBudget(config.maxCalls);
  const warnings: ForgewingRuntimeWarning[] = bounded.truncated ? ['input_truncated'] : [];
  if (!budget.tryConsume()) {
    warnings.push('budget_exhausted');
    return {
      status: 'abstained',
      bundle: makeBundle(parsed.data, bounded, inputHash, undefined, {
        reason: 'budget_unavailable',
        detail: 'Forgewing call budget was exhausted before provider invocation.',
      }),
      warnings,
      metadata: metadata(config, budget.used, bounded.truncated),
    };
  }

  try {
    const rawOutput = await callProviderWithin(
      dependencies.provider ?? callClaudeForRegionClassification,
      {
        model: config.model,
        timeoutMs: config.timeoutMs,
        maxOutputTokens: config.maxOutputTokens,
        inputJson: canonicalJson(bounded),
      },
    );
    const output = parseRegionClassificationModelOutput(rawOutput);
    return {
      status: 'applied',
      bundle: makeBundle(parsed.data, bounded, inputHash, output),
      warnings,
      metadata: metadata(config, budget.used, bounded.truncated),
    };
  } catch (error) {
    const warning = failureWarning(error);
    warnings.push(warning);
    return {
      status: 'abstained',
      bundle: makeBundle(parsed.data, bounded, inputHash, undefined, {
        reason: 'runtime_unavailable',
        detail: `Forgewing region classification did not complete: ${warning}.`,
      }),
      warnings,
      metadata: metadata(config, budget.used, bounded.truncated),
    };
  }
}
