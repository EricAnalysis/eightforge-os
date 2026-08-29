import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { FORGEWING_TABLE_CONTINUATION_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';
import {
  ForgewingTableContinuationProposalBundleSchema,
  type ForgewingEvidenceRef,
  type ForgewingTableContinuationProposalBundle,
} from '@/lib/forgewing/proposal/schema';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  callClaudeForTableContinuation,
  FORGEWING_TABLE_CONTINUATION_PROMPT_ID,
  FORGEWING_TABLE_CONTINUATION_PROMPT_VERSION,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';
import {
  getForgewingRuntimeConfig,
  isForgewingTableContinuationEnabled,
  type ForgewingRuntimeConfig,
} from '@/lib/forgewing/runtime/modelConfig';
import {
  parseTableContinuationModelOutput,
  type TableContinuationModelOutput,
} from '@/lib/forgewing/runtime/structuredOutput';

const MAX_CELLS_PER_SEGMENT = 30;
const MAX_TEXT_PER_SEGMENT = 4_000;
const MAX_TEXT_TOTAL = 8_000;
const MAX_EVIDENCE_TEXT = 4_000;

const identifier = z.string().min(1).max(200);
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
  mappingState: z.literal('resolved_physical_page'),
  sourceDocumentId: identifier,
  sourceArtifactId: identifier,
  physicalPageNumber: z.number().int().positive(),
  artifactLocalIndex: z.number().int().nonnegative().nullable(),
  sourceLayer: z.enum(['pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact']),
}).strict();

const commonObservation = {
  observationId: identifier,
  organizationId: identifier,
  sourceDocumentId: identifier,
  sourceArtifactId: identifier,
  extractionSnapshotId: identifier,
  pageArtifactId: identifier,
  boundingBox: boxSchema,
  text: z.string().max(1_000_000),
  readingOrder: z.number().int().nonnegative(),
  physicalCoordinate: physicalCoordinateSchema.optional(),
} as const;

const columnSchema = z.object({
  index: z.number().int().nonnegative(),
  x0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1),
  observedHeader: z.string().max(1_000).nullable(),
  normalizedHeader: z.string().max(1_000).nullable(),
  valueKinds: z.array(z.string().min(1).max(100)).max(20),
}).strict().refine((column) => column.x0 < column.x1, 'invalid column band');

const segmentSchema = z.object({
  ...commonObservation,
  kind: z.literal('segment'),
  chainCompleteness: z.enum(['complete', 'partial', 'ambiguous', 'unchained']),
  columns: z.array(columnSchema).max(100),
  repeatedHeaderCount: z.number().int().nonnegative(),
  detectionKinds: z.array(z.string().min(1).max(100)).max(20),
}).strict();

const cellSchema = z.object({
  ...commonObservation,
  kind: z.literal('cell'),
  targetSegmentId: identifier,
  rowStart: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive(),
  columnStart: z.number().int().nonnegative(),
  columnSpan: z.number().int().positive(),
  structure: z.string().min(1).max(100),
}).strict();

const linkSchema = z.object({
  linkId: identifier,
  fromSegmentId: identifier,
  toSegmentId: identifier,
  decision: z.enum(['linked', 'ambiguous', 'rejected']),
}).strict();

const taskInputSchema = z.object({
  organizationId: identifier,
  sourceDocumentId: identifier,
  extractionSnapshotId: identifier,
  segments: z.array(segmentSchema),
  cells: z.array(cellSchema),
  continuationLinks: z.array(linkSchema),
}).strict();

export type ForgewingTableContinuationSegment = z.input<typeof segmentSchema>;
export type ForgewingTableContinuationCell = z.input<typeof cellSchema>;
export type ForgewingTableContinuationInput = z.input<typeof taskInputSchema>;

type Segment = z.output<typeof segmentSchema>;
type Cell = z.output<typeof cellSchema>;
type BoundedInput = Readonly<{
  taskType: 'table_continuation';
  priorSegment: Segment;
  nextSegment: Segment;
  priorBoundaryCells: readonly Cell[];
  nextBoundaryCells: readonly Cell[];
  truncated: boolean;
}>;

export type ForgewingTableContinuationWarning =
  | 'input_truncated' | 'input_contract_violation' | 'budget_exhausted'
  | 'anthropic_not_configured' | 'provider_timeout' | 'provider_error'
  | 'invalid_model_json' | 'model_schema_rejected' | 'unknown_evidence_reference';

export type ForgewingTableContinuationMetadata = Readonly<{
  model: string;
  promptTemplateId: typeof FORGEWING_TABLE_CONTINUATION_PROMPT_ID;
  promptTemplateVersion: typeof FORGEWING_TABLE_CONTINUATION_PROMPT_VERSION;
  timeoutMs: number;
  maxOutputTokens: number;
  calls: number;
  inputTruncated: boolean;
}>;

export type ForgewingTableContinuationResult =
  | Readonly<{ status: 'skipped'; reason: 'forgewing_disabled' | 'table_continuation_disabled' | 'no_candidate_pairs' }>
  | Readonly<{ status: 'failed'; reason: 'input_contract_violation'; warnings: readonly ['input_contract_violation']; metadata: ForgewingTableContinuationMetadata }>
  | Readonly<{ status: 'applied' | 'abstained'; bundle: ForgewingTableContinuationProposalBundle; warnings: readonly ForgewingTableContinuationWarning[]; metadata: ForgewingTableContinuationMetadata }>;

export type ForgewingTableContinuationDependencies = Readonly<{
  config?: ForgewingRuntimeConfig;
  taskEnabled?: boolean;
  provider?: ForgewingProvider;
  budget?: ForgewingCallBudget;
}>;

function compareSegment(left: Segment, right: Segment): number {
  return (left.physicalCoordinate?.physicalPageNumber ?? Number.MAX_SAFE_INTEGER)
    - (right.physicalCoordinate?.physicalPageNumber ?? Number.MAX_SAFE_INTEGER)
    || left.readingOrder - right.readingOrder
    || left.boundingBox.y0 - right.boundingBox.y0
    || left.boundingBox.x0 - right.boundingBox.x0
    || left.boundingBox.y1 - right.boundingBox.y1
    || left.boundingBox.x1 - right.boundingBox.x1
    || left.observationId.localeCompare(right.observationId);
}

function compareCell(left: Cell, right: Cell): number {
  return left.rowStart - right.rowStart
    || left.columnStart - right.columnStart
    || left.boundingBox.y0 - right.boundingBox.y0
    || left.boundingBox.x0 - right.boundingBox.x0
    || left.readingOrder - right.readingOrder
    || left.observationId.localeCompare(right.observationId);
}

function sameIdentity(input: z.output<typeof taskInputSchema>, segment: Segment): boolean {
  const coordinate = segment.physicalCoordinate;
  return segment.organizationId === input.organizationId
    && segment.sourceDocumentId === input.sourceDocumentId
    && segment.extractionSnapshotId === input.extractionSnapshotId
    && coordinate?.sourceDocumentId === segment.sourceDocumentId
    && coordinate.sourceArtifactId === segment.sourceArtifactId;
}

function ownsInput(input: z.output<typeof taskInputSchema>, observation: Segment | Cell): boolean {
  return observation.organizationId === input.organizationId
    && observation.sourceDocumentId === input.sourceDocumentId
    && observation.extractionSnapshotId === input.extractionSnapshotId
    && (observation.physicalCoordinate == null || (
      observation.physicalCoordinate.sourceDocumentId === observation.sourceDocumentId
      && observation.physicalCoordinate.sourceArtifactId === observation.sourceArtifactId
    ));
}

function candidate(input: z.output<typeof taskInputSchema>): readonly [Segment, Segment] | null {
  const segments = new Map(input.segments.map((segment) => [segment.observationId, segment]));
  const linkedPairs = new Set(input.continuationLinks
    .filter((link) => link.decision === 'linked')
    .map((link) => `${link.fromSegmentId}\u0000${link.toSegmentId}`));
  const eligible = (prior: Segment, next: Segment): boolean => {
    const priorCoordinate = prior.physicalCoordinate;
    const nextCoordinate = next.physicalCoordinate;
    return sameIdentity(input, prior) && sameIdentity(input, next)
      && prior.sourceArtifactId === next.sourceArtifactId
      && priorCoordinate != null && nextCoordinate != null
      && nextCoordinate.physicalPageNumber === priorCoordinate.physicalPageNumber + 1
      && !linkedPairs.has(`${prior.observationId}\u0000${next.observationId}`);
  };
  const candidates: Array<readonly [number, Segment, Segment]> = [];
  for (const link of input.continuationLinks) {
    if (link.decision !== 'ambiguous') continue;
    const prior = segments.get(link.fromSegmentId);
    const next = segments.get(link.toSegmentId);
    if (prior && next && eligible(prior, next)) candidates.push([0, prior, next]);
  }
  const ordered = [...input.segments].sort(compareSegment);
  for (const prior of ordered) for (const next of ordered) {
    if (!eligible(prior, next)) continue;
    const hasAnyLink = input.continuationLinks.some((link) => (
      link.fromSegmentId === prior.observationId && link.toSegmentId === next.observationId
    ));
    if (hasAnyLink) continue;
    const uncertain = prior.chainCompleteness === 'ambiguous'
      || prior.chainCompleteness === 'partial'
      || next.chainCompleteness === 'ambiguous'
      || next.chainCompleteness === 'partial';
    if (uncertain) candidates.push([1, prior, next]);
    else if (prior.columns.length === next.columns.length) candidates.push([2, prior, next]);
  }
  candidates.sort((left, right) => left[0] - right[0]
    || compareSegment(left[1], right[1]) || compareSegment(left[2], right[2]));
  return candidates[0] ? [candidates[0][1], candidates[0][2]] : null;
}

function clip<T extends { text: string }>(value: T, maximum: number): T {
  return value.text.length > maximum ? { ...value, text: value.text.slice(0, maximum) } : value;
}

function bound(input: z.output<typeof taskInputSchema>): BoundedInput | null {
  const ids = [...input.segments, ...input.cells].map((item) => item.observationId);
  if (new Set(ids).size !== ids.length) throw new Error('input_contract_violation');
  if (input.segments.some((segment) => !ownsInput(input, segment))) {
    throw new Error('input_contract_violation');
  }
  if (input.cells.some((cell) => !ownsInput(input, cell))) {
    throw new Error('input_contract_violation');
  }
  const selected = candidate(input);
  if (!selected) return null;
  const [prior, next] = selected;
  let truncated = prior.text.length > MAX_TEXT_PER_SEGMENT || next.text.length > MAX_TEXT_PER_SEGMENT;
  const boundedPrior = clip(prior, MAX_TEXT_PER_SEGMENT);
  const boundedNext = clip(next, MAX_TEXT_PER_SEGMENT);
  const selectCells = (segment: Segment, tail: boolean): Cell[] => {
    const all = input.cells.filter((cell) => cell.targetSegmentId === segment.observationId);
    if (all.some((cell) => cell.sourceArtifactId !== segment.sourceArtifactId
      || cell.pageArtifactId !== segment.pageArtifactId
      || (cell.physicalCoordinate != null
        && cell.physicalCoordinate.physicalPageNumber !== segment.physicalCoordinate?.physicalPageNumber))) {
      throw new Error('input_contract_violation');
    }
    const proven = all.filter((cell) => cell.physicalCoordinate != null);
    if (proven.length !== all.length) truncated = true;
    const sorted = proven.sort(compareCell);
    const selectedCells = (tail ? sorted.slice(-MAX_CELLS_PER_SEGMENT) : sorted.slice(0, MAX_CELLS_PER_SEGMENT));
    if (selectedCells.length !== all.length) truncated = true;
    return selectedCells;
  };
  let priorCells = selectCells(prior, true);
  let nextCells = selectCells(next, false);
  let characters = boundedPrior.text.length + boundedNext.text.length;
  const fit = (cells: Cell[], segmentCharacters: number): Cell[] => {
    const kept: Cell[] = [];
    let sideCharacters = segmentCharacters;
    for (const cell of cells) {
      const remaining = Math.min(
        MAX_EVIDENCE_TEXT,
        MAX_TEXT_PER_SEGMENT - sideCharacters,
        MAX_TEXT_TOTAL - characters,
      );
      if (remaining <= 0) { truncated = true; break; }
      const boundedCell = clip(cell, remaining);
      if (boundedCell.text !== cell.text) truncated = true;
      kept.push(boundedCell);
      characters += boundedCell.text.length;
      sideCharacters += boundedCell.text.length;
    }
    return kept;
  };
  priorCells = fit(priorCells, boundedPrior.text.length);
  nextCells = fit(nextCells, boundedNext.text.length);
  return { taskType: 'table_continuation', priorSegment: boundedPrior, nextSegment: boundedNext, priorBoundaryCells: priorCells, nextBoundaryCells: nextCells, truncated };
}

function metadata(config: ForgewingRuntimeConfig, calls: number, truncated: boolean): ForgewingTableContinuationMetadata {
  return { model: config.model, promptTemplateId: FORGEWING_TABLE_CONTINUATION_PROMPT_ID, promptTemplateVersion: FORGEWING_TABLE_CONTINUATION_PROMPT_VERSION, timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens, calls, inputTruncated: truncated };
}

function evidenceRef(observation: Segment | Cell): ForgewingEvidenceRef {
  const coordinate = observation.physicalCoordinate;
  if (!coordinate) throw new Error('input_contract_violation');
  return {
    artifactId: observation.observationId,
    sourceDocumentId: observation.sourceDocumentId,
    sourceArtifactId: observation.sourceArtifactId,
    pageArtifactId: observation.pageArtifactId,
    physicalPageNumber: coordinate.physicalPageNumber,
    ...(coordinate.artifactLocalIndex == null ? {} : { artifactLocalIndex: coordinate.artifactLocalIndex }),
    sourceLayer: coordinate.sourceLayer,
    boundingBox: observation.boundingBox,
    ...(observation.text.trim() ? { rawSpan: observation.text } : {}),
  };
}

function makeBundle(input: z.output<typeof taskInputSchema>, bounded: BoundedInput, hash: string, output?: TableContinuationModelOutput, abstention?: { reason: 'budget_unavailable' | 'runtime_unavailable'; detail: string }): ForgewingTableContinuationProposalBundle {
  const observations = [bounded.priorSegment, ...bounded.priorBoundaryCells, bounded.nextSegment, ...bounded.nextBoundaryCells];
  const taskId = `forgewing-task-table-continuation-${hash.slice(0, 32)}`;
  const run = { runId: `forgewing-run-table-continuation-${hash.slice(0, 32)}`, organizationId: input.organizationId, extractionSnapshotId: input.extractionSnapshotId, inputSnapshotHash: hash };
  if (abstention) return ForgewingTableContinuationProposalBundleSchema.parse({ schemaVersion: FORGEWING_TABLE_CONTINUATION_PROPOSAL_SCHEMA_VERSION, authority: 'non_authoritative', run, taskId, taskType: 'table_continuation', proposals: [], abstentions: [{ taskId, taskType: 'table_continuation', sourceDocumentId: input.sourceDocumentId, sourceArtifactId: bounded.priorSegment.sourceArtifactId, extractionSnapshotId: input.extractionSnapshotId, inputObservationIds: observations.map((item) => item.observationId), reason: abstention.reason, detail: abstention.detail }] });
  if (!output) throw new Error('model output is required');
  const map = new Map(observations.map((item) => [item.observationId, item]));
  const selected = output.evidenceIds.map((id) => { const item = map.get(id); if (!item) throw new Error('unknown_evidence_reference'); return item; });
  if (output.state !== 'insufficient_evidence') {
    const covers = (segmentId: string) => selected.some((item) => item.observationId === segmentId || ('targetSegmentId' in item && item.targetSegmentId === segmentId));
    if (!covers(bounded.priorSegment.observationId) || !covers(bounded.nextSegment.observationId)) throw new Error('model_schema_rejected');
  }
  const priorCoordinate = bounded.priorSegment.physicalCoordinate;
  const nextCoordinate = bounded.nextSegment.physicalCoordinate;
  if (!priorCoordinate || !nextCoordinate) throw new Error('input_contract_violation');
  const base = { proposalId: `forgewing-proposal-table-continuation-${hash.slice(0, 32)}`, taskId, taskType: 'table_continuation' as const, sourceDocumentId: input.sourceDocumentId, sourceArtifactId: bounded.priorSegment.sourceArtifactId, extractionSnapshotId: input.extractionSnapshotId, priorSegmentId: bounded.priorSegment.observationId, nextSegmentId: bounded.nextSegment.observationId, priorPageArtifactId: bounded.priorSegment.pageArtifactId, nextPageArtifactId: bounded.nextSegment.pageArtifactId, priorPhysicalPageNumber: priorCoordinate.physicalPageNumber, nextPhysicalPageNumber: nextCoordinate.physicalPageNumber, priorArtifactLocalIndex: priorCoordinate.artifactLocalIndex, nextArtifactLocalIndex: nextCoordinate.artifactLocalIndex, priorSourceLayer: priorCoordinate.sourceLayer, nextSourceLayer: nextCoordinate.sourceLayer, confidence: output.confidence, rationaleCode: output.rationaleCode, inputObservationIds: observations.map((item) => item.observationId), evidence: selected.map(evidenceRef) };
  const proposal = output.state === 'insufficient_evidence'
    ? { ...base, state: output.state, missingEvidence: output.missingEvidence.map((code) => ({ code })) }
    : { ...base, state: output.state, relation: output.relation };
  return ForgewingTableContinuationProposalBundleSchema.parse({ schemaVersion: FORGEWING_TABLE_CONTINUATION_PROPOSAL_SCHEMA_VERSION, authority: 'non_authoritative', run, taskId, taskType: 'table_continuation', proposals: [proposal], abstentions: [] });
}

function failureWarning(error: unknown): ForgewingTableContinuationWarning {
  const message = error instanceof Error ? error.message : '';
  const name = error && typeof error === 'object' ? error.constructor?.name ?? '' : '';
  if (message === 'provider_timeout' || message === 'Request timed out' || name === 'APIConnectionTimeoutError') return 'provider_timeout';
  if (message === 'invalid_model_json') return 'invalid_model_json';
  if (message === 'model_schema_rejected') return 'model_schema_rejected';
  if (message === 'unknown_evidence_reference') return 'unknown_evidence_reference';
  if (message.includes('ANTHROPIC_API_KEY')) return 'anthropic_not_configured';
  return 'provider_error';
}

async function callWithin(provider: ForgewingProvider, request: Parameters<ForgewingProvider>[0]): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([provider(request), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('provider_timeout')), request.timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

export async function runForgewingTableContinuation(rawInput: ForgewingTableContinuationInput, dependencies: ForgewingTableContinuationDependencies = {}): Promise<ForgewingTableContinuationResult> {
  const config = dependencies.config ?? getForgewingRuntimeConfig();
  if (!config.enabled) return { status: 'skipped', reason: 'forgewing_disabled' };
  if (!(dependencies.taskEnabled ?? isForgewingTableContinuationEnabled())) return { status: 'skipped', reason: 'table_continuation_disabled' };
  const taskConfig = { ...config, maxOutputTokens: Math.min(config.maxOutputTokens, 800) };
  const parsed = taskInputSchema.safeParse(rawInput);
  if (!parsed.success) return { status: 'failed', reason: 'input_contract_violation', warnings: ['input_contract_violation'], metadata: metadata(taskConfig, 0, false) };
  let bounded: BoundedInput | null;
  try { bounded = bound(parsed.data); }
  catch { return { status: 'failed', reason: 'input_contract_violation', warnings: ['input_contract_violation'], metadata: metadata(taskConfig, 0, false) }; }
  if (!bounded) return { status: 'skipped', reason: 'no_candidate_pairs' };
  const hash = hashCanonical(bounded);
  const budget = dependencies.budget ?? new ForgewingCallBudget(Math.min(taskConfig.maxCalls, 1));
  const warnings: ForgewingTableContinuationWarning[] = bounded.truncated ? ['input_truncated'] : [];
  if (!budget.tryConsume()) { warnings.push('budget_exhausted'); return { status: 'abstained', bundle: makeBundle(parsed.data, bounded, hash, undefined, { reason: 'budget_unavailable', detail: 'Forgewing table continuation call budget was exhausted before provider invocation.' }), warnings, metadata: metadata(taskConfig, budget.used, bounded.truncated) }; }
  try {
    const raw = await callWithin(dependencies.provider ?? callClaudeForTableContinuation, { model: taskConfig.model, timeoutMs: taskConfig.timeoutMs, maxOutputTokens: taskConfig.maxOutputTokens, inputJson: canonicalJson(bounded) });
    const output = parseTableContinuationModelOutput(raw);
    return { status: 'applied', bundle: makeBundle(parsed.data, bounded, hash, output), warnings, metadata: metadata(taskConfig, budget.used, bounded.truncated) };
  } catch (error) {
    const warning = failureWarning(error); warnings.push(warning);
    return { status: 'abstained', bundle: makeBundle(parsed.data, bounded, hash, undefined, { reason: 'runtime_unavailable', detail: `Forgewing table continuation did not complete: ${warning}.` }), warnings, metadata: metadata(taskConfig, budget.used, bounded.truncated) };
  }
}
