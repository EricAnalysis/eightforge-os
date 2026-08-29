import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { FORGEWING_COLUMN_MAPPING_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';
import {
  ForgewingColumnMappingProposalBundleSchema,
  type ForgewingColumnMappingProposalBundle,
  type ForgewingEvidenceRef,
} from '@/lib/forgewing/proposal/schema';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  callClaudeForColumnMapping,
  FORGEWING_COLUMN_MAPPING_PROMPT_ID,
  FORGEWING_COLUMN_MAPPING_PROMPT_VERSION,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';
import {
  getForgewingRuntimeConfig,
  isForgewingColumnMappingEnabled,
  type ForgewingRuntimeConfig,
} from '@/lib/forgewing/runtime/modelConfig';
import {
  parseColumnMappingModelOutput,
  type ColumnMappingModelOutput,
} from '@/lib/forgewing/runtime/structuredOutput';

const MAX_COLUMNS = 12;
const MAX_ROWS = 8;
const MAX_CELLS = 96;
const MAX_COLUMN_TEXT = 2_000;
const MAX_TOTAL_TEXT = 8_000;
const MAX_EVIDENCE_TEXT = 4_000;

const identifier = z.string().min(1).max(200);
const positiveRoleSchema = z.enum([
  'description', 'row_label', 'quantity', 'unit', 'rate', 'extension',
  'origin', 'destination', 'origin_destination', 'category', 'code', 'identifier',
]);
const ambiguityReasonSchema = z.enum([
  'conflicting_cell_values', 'multiple_exact_header_roles', 'no_candidate',
  'below_minimum_score', 'below_minimum_margin',
]);
const boxSchema = z.object({
  coordinateSpace: z.literal('page_normalized'), origin: z.literal('top_left'),
  x0: z.number().min(0).max(1), y0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1), y1: z.number().min(0).max(1),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
}).strict().refine((box) => box.x0 < box.x1 && box.y0 < box.y1, 'invalid bounding box');
const physicalCoordinateSchema = z.object({
  mappingState: z.literal('resolved_physical_page'), sourceDocumentId: identifier,
  sourceArtifactId: identifier, physicalPageNumber: z.number().int().positive(),
  artifactLocalIndex: z.number().int().nonnegative().nullable(),
  sourceLayer: z.enum(['pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact']),
}).strict();
const commonObservation = {
  observationId: identifier, organizationId: identifier, sourceDocumentId: identifier,
  sourceArtifactId: identifier, extractionSnapshotId: identifier, pageArtifactId: identifier,
  boundingBox: boxSchema, readingOrder: z.number().int().nonnegative(),
  physicalCoordinate: physicalCoordinateSchema.optional(),
} as const;
const columnSchema = z.object({
  index: z.number().int().nonnegative(), x0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1), observedHeader: z.string().max(4_000).nullable(),
  normalizedHeader: z.string().max(4_000).nullable(),
  valueKinds: z.array(z.string().min(1).max(100)).max(20),
}).strict().refine((column) => column.x0 < column.x1, 'invalid column band');
const tableSchema = z.object({
  ...commonObservation, kind: z.literal('table'), page: z.number().int().positive(),
  chainCompleteness: z.enum(['complete', 'partial', 'ambiguous', 'unchained']),
  detectionKinds: z.array(z.string().min(1).max(100)).max(20),
  columns: z.array(columnSchema).min(1).max(100),
}).strict();
const cellSchema = z.object({
  ...commonObservation, kind: z.literal('cell'), tableSegmentId: identifier,
  text: z.string().max(1_000_000), rowStart: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive(), columnStart: z.number().int().nonnegative(),
  columnSpan: z.number().int().positive(), structure: z.string().min(1).max(100),
}).strict();
const mappingSignalSchema = z.object({
  mappingId: identifier, tableSegmentId: identifier, columnIndex: z.number().int().nonnegative(),
  status: z.literal('ambiguous'), ambiguityReason: ambiguityReasonSchema,
  candidateRoles: z.array(z.object({ role: positiveRoleSchema, score: z.number().min(0).max(1) }).strict()).max(20),
  observedTopScore: z.number().min(0).max(1), observedMargin: z.number().min(-1).max(1),
  minimumScore: z.number().min(0).max(1), minimumMargin: z.number().min(0).max(1),
}).strict();
const inputSchema = z.object({
  organizationId: identifier, sourceDocumentId: identifier, extractionSnapshotId: identifier,
  tables: z.array(tableSchema), cells: z.array(cellSchema), mappingSignals: z.array(mappingSignalSchema),
}).strict();

export type ForgewingColumnMappingInput = z.input<typeof inputSchema>;
type ParsedInput = z.output<typeof inputSchema>;
type Table = z.output<typeof tableSchema>;
type Cell = z.output<typeof cellSchema>;
type Signal = z.output<typeof mappingSignalSchema>;
type BoundedColumn = z.output<typeof columnSchema> & Readonly<{
  columnId: string;
  ambiguousSignal: Omit<Signal, 'mappingId' | 'tableSegmentId' | 'columnIndex' | 'status'> | null;
}>;
type BoundedInput = Readonly<{
  taskType: 'column_mapping';
  table: Omit<Table, 'columns'> & { columns: readonly BoundedColumn[] };
  candidateColumnIndices: readonly number[];
  sampledRowIndices: readonly number[];
  sampledCells: readonly Cell[];
  truncated: boolean;
}>;

export type ForgewingColumnMappingWarning =
  | 'input_truncated' | 'input_contract_violation' | 'budget_exhausted'
  | 'anthropic_not_configured' | 'provider_timeout' | 'provider_error'
  | 'invalid_model_json' | 'model_schema_rejected' | 'unknown_evidence_reference';
export type ForgewingColumnMappingMetadata = Readonly<{
  model: string; promptTemplateId: typeof FORGEWING_COLUMN_MAPPING_PROMPT_ID;
  promptTemplateVersion: typeof FORGEWING_COLUMN_MAPPING_PROMPT_VERSION;
  timeoutMs: number; maxOutputTokens: number; calls: number; inputTruncated: boolean;
}>;
export type ForgewingColumnMappingResult =
  | Readonly<{ status: 'skipped'; reason: 'forgewing_disabled' | 'column_mapping_disabled' | 'no_candidate_tables' }>
  | Readonly<{ status: 'failed'; reason: 'input_contract_violation'; warnings: readonly ['input_contract_violation']; metadata: ForgewingColumnMappingMetadata }>
  | Readonly<{ status: 'applied' | 'abstained'; bundle: ForgewingColumnMappingProposalBundle; warnings: readonly ForgewingColumnMappingWarning[]; metadata: ForgewingColumnMappingMetadata }>;
export type ForgewingColumnMappingDependencies = Readonly<{
  config?: ForgewingRuntimeConfig; taskEnabled?: boolean; provider?: ForgewingProvider;
  budget?: ForgewingCallBudget;
}>;

function ownsInput(input: ParsedInput, observation: Table | Cell): boolean {
  const coordinate = observation.physicalCoordinate;
  return observation.organizationId === input.organizationId
    && observation.sourceDocumentId === input.sourceDocumentId
    && observation.extractionSnapshotId === input.extractionSnapshotId
    && (coordinate == null || (
      coordinate.sourceDocumentId === observation.sourceDocumentId
      && coordinate.sourceArtifactId === observation.sourceArtifactId
    ));
}

function reasonTier(reason: Signal['ambiguityReason']): number {
  if (reason === 'conflicting_cell_values' || reason === 'multiple_exact_header_roles') return 0;
  if (reason === 'below_minimum_margin') return 1;
  if (reason === 'below_minimum_score') return 2;
  return 3;
}

function compareTables(left: Table, right: Table, signals: readonly Signal[]): number {
  const forTable = (table: Table) => signals.filter((signal) => signal.tableSegmentId === table.observationId);
  const leftSignals = forTable(left);
  const rightSignals = forTable(right);
  const leftBestTier = Math.min(...leftSignals.map((signal) => reasonTier(signal.ambiguityReason)));
  const rightBestTier = Math.min(...rightSignals.map((signal) => reasonTier(signal.ambiguityReason)));
  const leftBestCount = leftSignals.filter((signal) => reasonTier(signal.ambiguityReason) === leftBestTier).length;
  const rightBestCount = rightSignals.filter((signal) => reasonTier(signal.ambiguityReason) === rightBestTier).length;
  const leftPhysical = left.physicalCoordinate?.physicalPageNumber;
  const rightPhysical = right.physicalCoordinate?.physicalPageNumber;
  const provenanceOrder = leftPhysical == null === (rightPhysical == null)
    ? 0 : leftPhysical == null ? 1 : -1;
  const pageOrder = leftPhysical != null && rightPhysical != null
    ? leftPhysical - rightPhysical : left.page - right.page;
  return leftBestTier - rightBestTier
    || rightBestCount - leftBestCount
    || rightSignals.length - leftSignals.length
    || provenanceOrder
    || pageOrder
    || left.boundingBox.y0 - right.boundingBox.y0
    || left.boundingBox.x0 - right.boundingBox.x0
    || left.readingOrder - right.readingOrder
    || left.observationId.localeCompare(right.observationId);
}

function compareCells(left: Cell, right: Cell): number {
  return left.rowStart - right.rowStart || left.columnStart - right.columnStart
    || left.boundingBox.y0 - right.boundingBox.y0 || left.boundingBox.x0 - right.boundingBox.x0
    || left.readingOrder - right.readingOrder || left.observationId.localeCompare(right.observationId);
}

function bound(input: ParsedInput): BoundedInput | null {
  const observations = [...input.tables, ...input.cells];
  if (new Set(observations.map((item) => item.observationId)).size !== observations.length
    || observations.some((item) => !ownsInput(input, item))) throw new Error('input_contract_violation');
  const tables = new Map(input.tables.map((table) => [table.observationId, table]));
  for (const signal of input.mappingSignals) {
    const table = tables.get(signal.tableSegmentId);
    if (!table || !table.columns.some((column) => column.index === signal.columnIndex)) {
      throw new Error('input_contract_violation');
    }
  }
  const candidateTables = input.tables.filter((table) => input.mappingSignals.some(
    (signal) => signal.tableSegmentId === table.observationId,
  )).sort((left, right) => compareTables(left, right, input.mappingSignals));
  const target = candidateTables[0];
  if (!target) return null;
  if (input.tables.some((table) => table.sourceArtifactId !== target.sourceArtifactId)
    || input.cells.some((cell) => cell.sourceArtifactId !== target.sourceArtifactId)) {
    throw new Error('input_contract_violation');
  }
  const targetSignals = input.mappingSignals
    .filter((signal) => signal.tableSegmentId === target.observationId)
    .sort((left, right) => reasonTier(left.ambiguityReason) - reasonTier(right.ambiguityReason)
      || left.observedTopScore - right.observedTopScore
      || left.observedMargin - right.observedMargin
      || left.columnIndex - right.columnIndex || left.mappingId.localeCompare(right.mappingId));
  if (new Set(targetSignals.map((signal) => signal.columnIndex)).size !== targetSignals.length) {
    throw new Error('input_contract_violation');
  }
  const prioritizedIndices = [
    ...targetSignals.map((signal) => signal.columnIndex),
    ...target.columns.map((column) => column.index),
  ].filter((index, position, values) => values.indexOf(index) === position);
  const selectedIndices = new Set(prioritizedIndices.slice(0, MAX_COLUMNS));
  let truncated = prioritizedIndices.length > MAX_COLUMNS;
  const selectedColumns = target.columns
    .filter((column) => selectedIndices.has(column.index))
    .sort((left, right) => left.index - right.index);
  const quota = Math.min(MAX_COLUMN_TEXT, Math.floor(MAX_TOTAL_TEXT / selectedColumns.length));
  const columnCharacters = new Map<number, number>();
  const boundedColumns: BoundedColumn[] = selectedColumns.map((column) => {
    let remaining = quota;
    const clipHeader = (value: string | null): string | null => {
      if (value == null) return null;
      const clipped = value.slice(0, remaining);
      if (clipped !== value) truncated = true;
      remaining -= clipped.length;
      return clipped;
    };
    const observedHeader = clipHeader(column.observedHeader);
    const normalizedHeader = clipHeader(column.normalizedHeader);
    columnCharacters.set(column.index, quota - remaining);
    const signal = targetSignals.find((candidate) => candidate.columnIndex === column.index);
    return {
      ...column,
      columnId: signal?.mappingId ?? `forgewing-context-column-${hashCanonical({
        tableSegmentId: target.observationId, columnIndex: column.index, x0: column.x0, x1: column.x1,
      }).slice(0, 32)}`,
      observedHeader, normalizedHeader,
      ambiguousSignal: signal ? {
        ambiguityReason: signal.ambiguityReason, candidateRoles: signal.candidateRoles,
        observedTopScore: signal.observedTopScore, observedMargin: signal.observedMargin,
        minimumScore: signal.minimumScore, minimumMargin: signal.minimumMargin,
      } : null,
    };
  });
  const candidateColumnIndices = targetSignals.map((signal) => signal.columnIndex)
    .filter((index) => selectedIndices.has(index)).sort((left, right) => left - right);
  const targetCells = input.cells.filter((cell) => cell.tableSegmentId === target.observationId
    && selectedColumns.some((column) => cell.columnStart <= column.index
      && column.index < cell.columnStart + cell.columnSpan));
  if (targetCells.some((cell) => cell.pageArtifactId !== target.pageArtifactId
    || (cell.physicalCoordinate != null && target.physicalCoordinate != null
      && cell.physicalCoordinate.physicalPageNumber !== target.physicalCoordinate.physicalPageNumber))) {
    throw new Error('input_contract_violation');
  }
  const nonEmptyRows = [...new Set(targetCells.filter((cell) => cell.text.trim()).map((cell) => cell.rowStart))]
    .sort((left, right) => left - right);
  const sampledRowIndices = [...new Set([...nonEmptyRows.slice(0, 4), ...nonEmptyRows.slice(-4)])]
    .sort((left, right) => left - right).slice(0, MAX_ROWS);
  if (sampledRowIndices.length < nonEmptyRows.length) truncated = true;
  const sampledCells: Cell[] = [];
  let totalCharacters = [...columnCharacters.values()].reduce((sum, value) => sum + value, 0);
  for (const cell of targetCells.filter((item) => sampledRowIndices.includes(item.rowStart)).sort(compareCells)) {
    if (sampledCells.length >= MAX_CELLS) { truncated = true; break; }
    const covered = selectedColumns.filter((column) => cell.columnStart <= column.index
      && column.index < cell.columnStart + cell.columnSpan).map((column) => column.index);
    const available = Math.min(MAX_EVIDENCE_TEXT, MAX_TOTAL_TEXT - totalCharacters,
      ...covered.map((index) => quota - (columnCharacters.get(index) ?? 0)));
    if (available <= 0) { truncated = true; continue; }
    const text = cell.text.slice(0, available);
    if (text !== cell.text) truncated = true;
    sampledCells.push({ ...cell, text });
    totalCharacters += text.length;
    for (const index of covered) columnCharacters.set(index, (columnCharacters.get(index) ?? 0) + text.length);
  }
  return {
    taskType: 'column_mapping', table: { ...target, columns: boundedColumns },
    candidateColumnIndices, sampledRowIndices, sampledCells, truncated,
  };
}

function metadata(config: ForgewingRuntimeConfig, calls: number, truncated: boolean): ForgewingColumnMappingMetadata {
  return { model: config.model, promptTemplateId: FORGEWING_COLUMN_MAPPING_PROMPT_ID,
    promptTemplateVersion: FORGEWING_COLUMN_MAPPING_PROMPT_VERSION, timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens, calls, inputTruncated: truncated };
}

function evidenceRef(observation: BoundedInput['table'] | Cell): ForgewingEvidenceRef {
  const coordinate = observation.physicalCoordinate;
  return {
    artifactId: observation.observationId, sourceDocumentId: observation.sourceDocumentId,
    sourceArtifactId: observation.sourceArtifactId, pageArtifactId: observation.pageArtifactId,
    boundingBox: observation.boundingBox,
    ...('text' in observation && observation.text.trim() ? { rawSpan: observation.text.slice(0, MAX_EVIDENCE_TEXT) } : {}),
    ...(coordinate ? { physicalPageNumber: coordinate.physicalPageNumber,
      ...(coordinate.artifactLocalIndex == null ? {} : { artifactLocalIndex: coordinate.artifactLocalIndex }),
      sourceLayer: coordinate.sourceLayer } : {}),
  };
}

function makeBundle(input: ParsedInput, bounded: BoundedInput, hash: string,
  output?: ColumnMappingModelOutput,
  abstention?: { reason: 'budget_unavailable' | 'runtime_unavailable'; detail: string },
): ForgewingColumnMappingProposalBundle {
  const observations = [bounded.table, ...bounded.sampledCells];
  const byId = new Map(observations.map((item) => [item.observationId, item]));
  const taskId = `forgewing-task-column-mapping-${hash.slice(0, 32)}`;
  const run = { runId: `forgewing-run-column-mapping-${hash.slice(0, 32)}`,
    organizationId: input.organizationId, extractionSnapshotId: input.extractionSnapshotId,
    inputSnapshotHash: hash };
  if (abstention) return ForgewingColumnMappingProposalBundleSchema.parse({
    schemaVersion: FORGEWING_COLUMN_MAPPING_PROPOSAL_SCHEMA_VERSION,
    authority: 'non_authoritative', run, taskId, taskType: 'column_mapping', proposals: [],
    abstentions: [{ taskId, taskType: 'column_mapping', sourceDocumentId: input.sourceDocumentId,
      sourceArtifactId: bounded.table.sourceArtifactId, extractionSnapshotId: input.extractionSnapshotId,
      inputObservationIds: observations.map((item) => item.observationId),
      reason: abstention.reason, detail: abstention.detail }],
  });
  if (!output) throw new Error('model output is required');
  const seen = new Set<number>();
  const nested = output.columnMappings.map((mapping) => {
    const column = bounded.table.columns.find((candidate) => candidate.index === mapping.columnIndex);
    if (seen.has(mapping.columnIndex) || !bounded.candidateColumnIndices.includes(mapping.columnIndex)
      || column?.columnId !== mapping.columnId) {
      throw new Error('model_schema_rejected');
    }
    seen.add(mapping.columnIndex);
    const selected = mapping.evidenceIds.map((id) => {
      const observation = byId.get(id);
      if (!observation) throw new Error('unknown_evidence_reference');
      if ('columnStart' in observation && !(observation.columnStart <= mapping.columnIndex
        && mapping.columnIndex < observation.columnStart + observation.columnSpan)) {
        throw new Error('model_schema_rejected');
      }
      return observation;
    });
    if (mapping.state !== 'insufficient_evidence' && !selected.some((observation) =>
      'columnStart' in observation && observation.columnStart <= mapping.columnIndex
        && mapping.columnIndex < observation.columnStart + observation.columnSpan)) {
      throw new Error('model_schema_rejected');
    }
    return mapping.state === 'observed' || mapping.state === 'inferred'
      ? { columnId: mapping.columnId, columnIndex: mapping.columnIndex, state: mapping.state,
          proposedRole: mapping.proposedRole, confidence: mapping.confidence,
          rationaleCodes: mapping.rationaleCodes, evidenceArtifactIds: mapping.evidenceIds }
      : mapping.state === 'ambiguous'
        ? { columnId: mapping.columnId, columnIndex: mapping.columnIndex, state: mapping.state,
            candidateRoles: mapping.candidateRoles, confidence: mapping.confidence,
            rationaleCodes: mapping.rationaleCodes, evidenceArtifactIds: mapping.evidenceIds }
        : { columnId: mapping.columnId, columnIndex: mapping.columnIndex, state: mapping.state,
            confidence: mapping.confidence, rationaleCodes: mapping.rationaleCodes,
            evidenceArtifactIds: [],
            missingEvidence: mapping.missingEvidence.map((code) => ({ code })) };
  });
  const allEvidence = output.columnMappings.flatMap((mapping) => mapping.evidenceIds)
    .map((id) => evidenceRef(byId.get(id)!));
  const evidence = [...new Map(allEvidence.map((item) => [JSON.stringify(item), item])).values()];
  const state = nested.every((mapping) => mapping.state === 'insufficient_evidence')
    ? 'insufficient_evidence' : nested.some((mapping) => mapping.state === 'ambiguous')
      ? 'ambiguous' : nested.some((mapping) => mapping.state === 'inferred') ? 'inferred' : 'observed';
  const coordinate = bounded.table.physicalCoordinate;
  return ForgewingColumnMappingProposalBundleSchema.parse({
    schemaVersion: FORGEWING_COLUMN_MAPPING_PROPOSAL_SCHEMA_VERSION,
    authority: 'non_authoritative', run, taskId, taskType: 'column_mapping', proposals: [{
      proposalId: `forgewing-proposal-column-mapping-${hash.slice(0, 32)}`, taskId,
      taskType: 'column_mapping', sourceDocumentId: input.sourceDocumentId,
      sourceArtifactId: bounded.table.sourceArtifactId, extractionSnapshotId: input.extractionSnapshotId,
      tableSegmentId: bounded.table.observationId, pageArtifactId: bounded.table.pageArtifactId,
      ...(coordinate ? { physicalPageNumber: coordinate.physicalPageNumber,
        ...(coordinate.artifactLocalIndex == null ? {} : { artifactLocalIndex: coordinate.artifactLocalIndex }),
        sourceLayer: coordinate.sourceLayer } : {}),
      candidateColumns: bounded.candidateColumnIndices.map((columnIndex) => {
        const column = bounded.table.columns.find((candidate) => candidate.index === columnIndex)!;
        return { columnId: column.columnId, columnIndex };
      }),
      mappingCompleteness: seen.size === bounded.candidateColumnIndices.length
        && nested.every((mapping) => mapping.state === 'observed' || mapping.state === 'inferred')
        ? 'complete' : 'partial',
      state, confidence: null, inputObservationIds: observations.map((item) => item.observationId),
      columnMappings: nested, evidence,
      ...(state === 'insufficient_evidence' ? {
        missingEvidence: [...new Set(output.columnMappings.flatMap((mapping) =>
          mapping.state === 'insufficient_evidence' ? mapping.missingEvidence : []))]
          .map((code) => ({ code })),
      } : {}),
    }], abstentions: [],
  });
}

function failureWarning(error: unknown): ForgewingColumnMappingWarning {
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
  try { return await Promise.race([provider(request), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('provider_timeout')), request.timeoutMs);
  })]); } finally { if (timer) clearTimeout(timer); }
}

export async function runForgewingColumnMapping(rawInput: unknown,
  dependencies: ForgewingColumnMappingDependencies = {},
): Promise<ForgewingColumnMappingResult> {
  const config = dependencies.config ?? getForgewingRuntimeConfig();
  if (!config.enabled) return { status: 'skipped', reason: 'forgewing_disabled' };
  if (!(dependencies.taskEnabled ?? isForgewingColumnMappingEnabled())) {
    return { status: 'skipped', reason: 'column_mapping_disabled' };
  }
  const taskConfig = { ...config, maxOutputTokens: Math.min(config.maxOutputTokens, 800) };
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return { status: 'failed', reason: 'input_contract_violation',
    warnings: ['input_contract_violation'], metadata: metadata(taskConfig, 0, false) };
  let bounded: BoundedInput | null;
  try { bounded = bound(parsed.data); } catch {
    return { status: 'failed', reason: 'input_contract_violation',
      warnings: ['input_contract_violation'], metadata: metadata(taskConfig, 0, false) };
  }
  if (!bounded) return { status: 'skipped', reason: 'no_candidate_tables' };
  const hash = hashCanonical(bounded);
  const budget = dependencies.budget ?? new ForgewingCallBudget(Math.min(taskConfig.maxCalls, 1));
  const warnings: ForgewingColumnMappingWarning[] = bounded.truncated ? ['input_truncated'] : [];
  if (!budget.tryConsume()) {
    warnings.push('budget_exhausted');
    return { status: 'abstained', bundle: makeBundle(parsed.data, bounded, hash, undefined,
      { reason: 'budget_unavailable', detail: 'Forgewing column mapping call budget was exhausted before provider invocation.' }),
      warnings, metadata: metadata(taskConfig, budget.used, bounded.truncated) };
  }
  try {
    const raw = await callWithin(dependencies.provider ?? callClaudeForColumnMapping, {
      model: taskConfig.model, timeoutMs: taskConfig.timeoutMs,
      maxOutputTokens: taskConfig.maxOutputTokens, inputJson: canonicalJson(bounded),
    });
    const output = parseColumnMappingModelOutput(raw);
    return { status: 'applied', bundle: makeBundle(parsed.data, bounded, hash, output),
      warnings, metadata: metadata(taskConfig, budget.used, bounded.truncated) };
  } catch (error) {
    const warning = failureWarning(error); warnings.push(warning);
    return { status: 'abstained', bundle: makeBundle(parsed.data, bounded, hash, undefined,
      { reason: 'runtime_unavailable', detail: `Forgewing column mapping did not complete: ${warning}.` }),
      warnings, metadata: metadata(taskConfig, budget.used, bounded.truncated) };
  }
}
