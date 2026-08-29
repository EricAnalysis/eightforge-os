import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import {
  ForgewingPricingInterpretationProposalBundleSchema,
  type ForgewingEvidenceRef,
  type ForgewingPricingInterpretationProposalBundle,
} from '@/lib/forgewing/proposal/schema';
import { FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  callClaudeForPricingInterpretation,
  FORGEWING_PRICING_INTERPRETATION_PROMPT_ID,
  FORGEWING_PRICING_INTERPRETATION_PROMPT_VERSION,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';
import {
  getForgewingRuntimeConfig,
  isForgewingPricingInterpretationEnabled,
  type ForgewingRuntimeConfig,
} from '@/lib/forgewing/runtime/modelConfig';
import {
  parsePricingInterpretationModelOutput,
  type PricingInterpretationModelOutput,
} from '@/lib/forgewing/runtime/structuredOutput';

const MAX_CELLS = 16;
const MAX_CHARS_PER_CELL = 2_000;
const MAX_AGGREGATE_CHARS = 8_000;
const MAX_ROW_TEXT = 4_000;

const identifier = z.string().min(1).max(200)
  .refine((value) => value.trim() === value, 'identifier whitespace');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sourceLayer = z.enum(['pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact']);
const sourceCellRole = z.enum([
  'category', 'description', 'unit', 'origin_destination', 'rate', 'quantity',
  'item_number', 'extended_amount', 'unknown',
]);
const semanticRole = z.enum([
  'category_like_text', 'description_like_text', 'unit_like_text', 'rate_like_amount',
  'quantity_like_amount', 'item_number_like_text', 'extended_amount_like_text', 'unknown',
]);
const box = z.object({
  coordinateSpace: z.literal('page_normalized'), origin: z.literal('top_left'),
  x0: z.number().min(0).max(1), y0: z.number().min(0).max(1),
  x1: z.number().min(0).max(1), y1: z.number().min(0).max(1),
  rotation: z.number().int().refine((value) => [0, 90, 180, 270].includes(value)),
}).strict().refine((value) => value.x0 < value.x1 && value.y0 < value.y1, 'invalid box');

const cellSchema = z.object({
  observationId: identifier,
  rawText: z.string().max(1_000_000),
  columnIndex: z.number().int().nonnegative(),
  readingOrder: z.number().int().nonnegative(),
  semanticHints: z.array(semanticRole).max(8).optional(),
  sourceDocumentId: identifier.optional(),
  sourceArtifactId: identifier.optional(),
  pageArtifactId: identifier.optional(),
  physicalPageNumber: z.number().int().positive().optional(),
  artifactLocalIndex: z.number().int().nonnegative().nullable().optional(),
  sourceLayer: sourceLayer.optional(),
  boundingBox: box.optional(),
}).strict();

const sourceCellGroupSchema = z.object({
  sourceCellRole,
  sourceObservationIds: z.array(identifier).min(1).max(16),
  authoredRawText: z.string().max(1_000_000),
}).strict();

const rowSchema = z.object({
  observationId: identifier,
  rawText: z.string().max(1_000_000),
  deterministicState: z.enum(['ambiguous', 'conflict', 'unresolved', 'resolved']),
  physicalPageNumber: z.number().int().positive(),
  pageArtifactId: identifier.optional(),
  artifactLocalIndex: z.number().int().nonnegative().nullable().optional(),
  sourceLayer: sourceLayer.optional(),
  boundingBox: box.optional(),
  cells: z.array(cellSchema).max(10_000),
  sourceCellGroups: z.array(sourceCellGroupSchema).max(16).optional(),
}).strict();

const inputSchema = z.object({
  organizationId: identifier,
  sourceDocumentId: identifier,
  sourceArtifactId: identifier,
  extractionSnapshotId: identifier,
  pricingScope: z.union([
    z.object({ scopeKind: z.literal('authoritative'), eligibility: z.literal('canonical_eligible'),
      eligibilityReason: z.literal('authoritative_scope_match'), scopeIdentity: sha256 }).strict(),
    z.object({ scopeKind: z.enum(['authoritative', 'provisional', 'no_scope', 'blocked']),
      eligibility: z.literal('diagnostic_only'), eligibilityReason: identifier,
      scopeIdentity: sha256 }).strict(),
  ]),
  rowObservation: rowSchema,
}).strict();

export type ForgewingPricingInterpretationInput = z.input<typeof inputSchema>;
type ParsedInput = z.output<typeof inputSchema>;
type Cell = z.output<typeof cellSchema>;
type BoundedCell = Cell & Readonly<{ rawText: string }>;
type BoundedInput = Readonly<{
  taskType: 'pricing_interpretation';
  run: Readonly<{ organizationId: string; extractionSnapshotId: string }>;
  source: Readonly<{ sourceDocumentId: string; sourceArtifactId: string }>;
  pricingScope: ParsedInput['pricingScope'];
  rowObservation: Omit<ParsedInput['rowObservation'], 'rawText' | 'cells' | 'sourceCellGroups'> & Readonly<{
    rawText: string;
    cells: readonly BoundedCell[];
    sourceCellGroups?: ParsedInput['rowObservation']['sourceCellGroups'];
  }>;
  truncated: boolean;
}>;

export type ForgewingPricingInterpretationWarning =
  | 'input_truncated' | 'input_contract_violation' | 'budget_exhausted'
  | 'anthropic_not_configured' | 'provider_timeout' | 'provider_error'
  | 'truncated_output' | 'invalid_model_json' | 'model_schema_rejected' | 'unknown_evidence_reference'
  | 'unsupported_source_text';

export type ForgewingPricingInterpretationMetadata = Readonly<{
  model: string;
  promptTemplateId: typeof FORGEWING_PRICING_INTERPRETATION_PROMPT_ID;
  promptTemplateVersion: typeof FORGEWING_PRICING_INTERPRETATION_PROMPT_VERSION;
  timeoutMs: number;
  maxOutputTokens: number;
  calls: number;
  inputTruncated: boolean;
}>;

export type ForgewingPricingInterpretationResult =
  | Readonly<{ status: 'skipped'; reason: 'forgewing_disabled' | 'pricing_interpretation_disabled'
      | 'ineligible_source_scope' | 'no_candidate_rows' }>
  | Readonly<{ status: 'failed'; reason: 'input_contract_violation';
      warnings: readonly ['input_contract_violation']; metadata: ForgewingPricingInterpretationMetadata }>
  | Readonly<{ status: 'applied' | 'abstained'; bundle: ForgewingPricingInterpretationProposalBundle;
      warnings: readonly ForgewingPricingInterpretationWarning[];
      metadata: ForgewingPricingInterpretationMetadata }>;

export type ForgewingPricingInterpretationDependencies = Readonly<{
  config?: ForgewingRuntimeConfig;
  taskEnabled?: boolean;
  provider?: ForgewingProvider;
  budget?: ForgewingCallBudget;
}>;

function metadata(config: ForgewingRuntimeConfig, calls: number, truncated: boolean): ForgewingPricingInterpretationMetadata {
  return { model: config.model, promptTemplateId: FORGEWING_PRICING_INTERPRETATION_PROMPT_ID,
    promptTemplateVersion: FORGEWING_PRICING_INTERPRETATION_PROMPT_VERSION,
    timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens, calls, inputTruncated: truncated };
}

function bound(input: ParsedInput): BoundedInput | null {
  const row = input.rowObservation;
  if (row.deterministicState === 'resolved') return null;
  const seen = new Set<string>();
  for (const cell of row.cells) {
    if (seen.has(cell.observationId)) throw new Error('input_contract_violation');
    seen.add(cell.observationId);
    if ((cell.sourceDocumentId != null && cell.sourceDocumentId !== input.sourceDocumentId)
      || (cell.sourceArtifactId != null && cell.sourceArtifactId !== input.sourceArtifactId)
      || (cell.physicalPageNumber != null && cell.physicalPageNumber !== row.physicalPageNumber)
      || (row.pageArtifactId != null && cell.pageArtifactId != null && cell.pageArtifactId !== row.pageArtifactId)) {
      throw new Error('input_contract_violation');
    }
  }
  if (row.sourceCellGroups) {
    const grouped = new Set<string>();
    for (const group of row.sourceCellGroups) {
      for (const id of group.sourceObservationIds) {
        if (!seen.has(id) || grouped.has(id)) throw new Error('input_contract_violation');
        grouped.add(id);
      }
    }
    if (grouped.size !== seen.size) throw new Error('input_contract_violation');
  }
  const ordered = row.cells
    .filter((cell) => cell.rawText.trim().length > 0)
    .sort((left, right) => left.columnIndex - right.columnIndex
      || left.readingOrder - right.readingOrder || left.observationId.localeCompare(right.observationId));
  if (ordered.length === 0) return null;
  let remaining = MAX_AGGREGATE_CHARS;
  let truncated = ordered.length > MAX_CELLS || row.rawText.length > MAX_ROW_TEXT;
  const cells: BoundedCell[] = [];
  for (const cell of ordered.slice(0, MAX_CELLS)) {
    if (remaining === 0) { truncated = true; break; }
    const maximum = Math.min(MAX_CHARS_PER_CELL, remaining);
    const rawText = cell.rawText.slice(0, maximum);
    if (rawText.length !== cell.rawText.length) truncated = true;
    remaining -= rawText.length;
    cells.push({ ...cell, rawText });
  }
  if (cells.length === 0) return null;
  const boundedIds = new Set(cells.map((cell) => cell.observationId));
  const boundedGroups = row.sourceCellGroups?.filter((group) =>
    group.sourceObservationIds.every((id) => boundedIds.has(id)));
  const boundedGroupedIds = new Set(boundedGroups?.flatMap((group) => group.sourceObservationIds) ?? []);
  const rowWithoutGroups = { ...row };
  delete rowWithoutGroups.sourceCellGroups;
  return {
    taskType: 'pricing_interpretation',
    run: { organizationId: input.organizationId, extractionSnapshotId: input.extractionSnapshotId },
    source: { sourceDocumentId: input.sourceDocumentId, sourceArtifactId: input.sourceArtifactId },
    pricingScope: input.pricingScope,
    rowObservation: {
      ...rowWithoutGroups,
      rawText: row.rawText.slice(0, MAX_ROW_TEXT),
      cells,
      ...(boundedGroups && boundedGroups.length > 0 && boundedGroupedIds.size === cells.length
        ? { sourceCellGroups: boundedGroups }
        : {}),
    },
    truncated,
  };
}

function evidenceRef(input: ParsedInput, row: BoundedInput['rowObservation'], cell: BoundedCell): ForgewingEvidenceRef {
  return {
    artifactId: cell.observationId,
    sourceDocumentId: input.sourceDocumentId,
    sourceArtifactId: input.sourceArtifactId,
    ...(cell.pageArtifactId ?? row.pageArtifactId ? { pageArtifactId: cell.pageArtifactId ?? row.pageArtifactId } : {}),
    ...(cell.artifactLocalIndex != null ? { artifactLocalIndex: cell.artifactLocalIndex } : {}),
    ...(cell.sourceLayer ?? row.sourceLayer ? { sourceLayer: cell.sourceLayer ?? row.sourceLayer } : {}),
    ...((cell.pageArtifactId ?? row.pageArtifactId) && (cell.sourceLayer ?? row.sourceLayer)
      ? { physicalPageNumber: row.physicalPageNumber }
      : {}),
    ...(cell.boundingBox ? { boundingBox: {
      ...cell.boundingBox,
      rotation: cell.boundingBox.rotation as 0 | 90 | 180 | 270,
    } } : {}),
    rawSpan: cell.rawText,
  };
}

function supportsRole(
  cell: BoundedCell,
  role: string,
  sourceText: string,
  evidenceIds: readonly string[],
  row: BoundedInput['rowObservation'],
): boolean {
  const group = row.sourceCellGroups?.find((entry) =>
    entry.sourceObservationIds.includes(cell.observationId));
  if (role === 'rate_like_amount') {
    if (group && group.sourceCellRole !== 'rate') return false;
    if (/[$£€¥]|\b(?:USD|GBP|EUR|JPY|CAD|AUD)\b/i.test(sourceText)) return true;
    if (!group) return cell.semanticHints?.includes('rate_like_amount') === true;
    const byId = new Map(row.cells.map((entry) => [entry.observationId, entry]));
    const citedCurrencySibling = group.sourceObservationIds.some((id) => id !== cell.observationId
      && evidenceIds.includes(id)
      && /[$£€¥]|\b(?:USD|GBP|EUR|JPY|CAD|AUD)\b/i.test(byId.get(id)?.rawText ?? ''));
    return /^[+-]?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?$/.test(sourceText.trim())
      && citedCurrencySibling;
  }
  if (role === 'quantity_like_amount') {
    if (group) return group.sourceCellRole === 'quantity';
    return cell.semanticHints?.includes('quantity_like_amount') === true;
  }
  if (role === 'unit_like_text') {
    return cell.semanticHints?.includes('unit_like_text') === true;
  }
  if (role === 'extended_amount_like_text') {
    return cell.semanticHints?.includes('extended_amount_like_text') === true;
  }
  return true;
}

function makeBundle(input: ParsedInput, bounded: BoundedInput, hash: string,
  output?: PricingInterpretationModelOutput,
  abstention?: Readonly<{ reason: 'budget_unavailable' | 'runtime_unavailable'; detail: string }>,
): ForgewingPricingInterpretationProposalBundle {
  const taskId = `forgewing-task-pricing-interpretation-${hash.slice(0, 32)}`;
  const run = { runId: `forgewing-run-pricing-interpretation-${hash.slice(0, 32)}`,
    organizationId: input.organizationId, extractionSnapshotId: input.extractionSnapshotId,
    inputSnapshotHash: hash };
  const row = bounded.rowObservation;
  const common = { taskId, taskType: 'pricing_interpretation' as const,
    sourceDocumentId: input.sourceDocumentId, sourceArtifactId: input.sourceArtifactId,
    extractionSnapshotId: input.extractionSnapshotId,
    inputObservationIds: [row.observationId, ...row.cells.map((cell) => cell.observationId)] };
  if (abstention) return ForgewingPricingInterpretationProposalBundleSchema.parse({
    schemaVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION,
    authority: 'non_authoritative', run, taskId, taskType: 'pricing_interpretation', proposals: [],
    abstentions: [{ ...common, reason: abstention.reason, detail: abstention.detail }],
  });
  if (!output) throw new Error('model output is required');
  const byId = new Map(row.cells.map((cell) => [cell.observationId, cell]));
  const interpretations = output.interpretations.map((item) => {
    const source = byId.get(item.sourceCellId);
    if (!source) throw new Error('unknown_evidence_reference');
    for (const id of item.evidenceIds) if (!byId.has(id)) throw new Error('unknown_evidence_reference');
    if (!source.rawText.includes(item.sourceText)
      || !supportsRole(source, item.semanticRole, item.sourceText, item.evidenceIds, row)) {
      throw new Error('unsupported_source_text');
    }
    if (!item.evidenceIds.includes(item.sourceCellId)) throw new Error('model_schema_rejected');
    return { sourceCellId: item.sourceCellId, semanticRole: item.semanticRole,
      sourceText: item.sourceText, interpretationState: item.interpretationState,
      confidence: item.confidence, evidenceArtifactIds: item.evidenceIds,
      rationaleCodes: item.rationaleCodes };
  });
  const evidenceIds = [...new Set(interpretations.flatMap((item) => item.evidenceArtifactIds))];
  const base = { proposalId: `forgewing-proposal-pricing-interpretation-${hash.slice(0, 32)}`,
    ...common, rowObservationId: row.observationId,
    ...(row.pageArtifactId ? { pageArtifactId: row.pageArtifactId } : {}),
    physicalPageNumber: row.physicalPageNumber, artifactLocalIndex: row.artifactLocalIndex ?? null,
    ...(row.sourceLayer ? { sourceLayer: row.sourceLayer } : {}),
    pricingScopeKind: 'authoritative' as const,
    pricingEligibility: 'canonical_eligible' as const,
    pricingEligibilityReason: bounded.pricingScope.eligibilityReason,
    pricingScopeIdentity: bounded.pricingScope.scopeIdentity };
  const proposal = output.rowInterpretationState === 'insufficient_evidence'
    ? { ...base, state: output.rowInterpretationState, rowInterpretationState: output.rowInterpretationState, confidence: null,
        interpretations: [], evidence: [],
        missingEvidence: output.missingEvidence.map((code) => ({ code })) }
    : { ...base, state: output.rowInterpretationState, rowInterpretationState: output.rowInterpretationState,
        confidence: output.confidence, interpretations,
        evidence: evidenceIds.map((id) => evidenceRef(input, row, byId.get(id)!)) };
  return ForgewingPricingInterpretationProposalBundleSchema.parse({
    schemaVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION,
    authority: 'non_authoritative', run, taskId, taskType: 'pricing_interpretation',
    proposals: [proposal], abstentions: [],
  });
}

function failureWarning(error: unknown): ForgewingPricingInterpretationWarning {
  const message = error instanceof Error ? error.message : '';
  const name = error && typeof error === 'object' ? error.constructor?.name ?? '' : '';
  if (message === 'provider_timeout' || message === 'Request timed out' || name === 'APIConnectionTimeoutError') return 'provider_timeout';
  if (message === 'provider_truncated_output') return 'truncated_output';
  if (message === 'invalid_model_json') return 'invalid_model_json';
  if (message === 'model_schema_rejected') return 'model_schema_rejected';
  if (message === 'unknown_evidence_reference') return 'unknown_evidence_reference';
  if (message === 'unsupported_source_text') return 'unsupported_source_text';
  if (message.includes('ANTHROPIC_API_KEY')) return 'anthropic_not_configured';
  return 'provider_error';
}

async function callWithin(provider: ForgewingProvider, request: Parameters<ForgewingProvider>[0]): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([provider(request), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('provider_timeout')), request.timeoutMs);
  })]); } finally { if (timer) clearTimeout(timer); }
}

export async function runForgewingPricingInterpretation(
  rawInput: ForgewingPricingInterpretationInput,
  dependencies: ForgewingPricingInterpretationDependencies = {},
): Promise<ForgewingPricingInterpretationResult> {
  const config = dependencies.config ?? getForgewingRuntimeConfig();
  if (!config.enabled) return { status: 'skipped', reason: 'forgewing_disabled' };
  if (!(dependencies.taskEnabled ?? isForgewingPricingInterpretationEnabled())) {
    return { status: 'skipped', reason: 'pricing_interpretation_disabled' };
  }
  const taskConfig = { ...config, maxOutputTokens: Math.min(config.maxOutputTokens, 2_000) };
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return { status: 'failed', reason: 'input_contract_violation',
    warnings: ['input_contract_violation'], metadata: metadata(taskConfig, 0, false) };
  if (parsed.data.pricingScope.scopeKind !== 'authoritative'
    || parsed.data.pricingScope.eligibility !== 'canonical_eligible') {
    return { status: 'skipped', reason: 'ineligible_source_scope' };
  }
  let bounded: BoundedInput | null;
  try { bounded = bound(parsed.data); } catch {
    return { status: 'failed', reason: 'input_contract_violation',
      warnings: ['input_contract_violation'], metadata: metadata(taskConfig, 0, false) };
  }
  if (!bounded) return { status: 'skipped', reason: 'no_candidate_rows' };
  const hash = hashCanonical(bounded);
  const budget = dependencies.budget ?? new ForgewingCallBudget(Math.min(taskConfig.maxCalls, 1));
  const warnings: ForgewingPricingInterpretationWarning[] = bounded.truncated ? ['input_truncated'] : [];
  if (!budget.tryConsume()) {
    warnings.push('budget_exhausted');
    return { status: 'abstained', bundle: makeBundle(parsed.data, bounded, hash, undefined,
      { reason: 'budget_unavailable', detail: 'Forgewing pricing interpretation call budget was exhausted before provider invocation.' }),
      warnings, metadata: metadata(taskConfig, budget.used, bounded.truncated) };
  }
  try {
    const raw = await callWithin(dependencies.provider ?? callClaudeForPricingInterpretation, {
      model: taskConfig.model, timeoutMs: taskConfig.timeoutMs,
      maxOutputTokens: taskConfig.maxOutputTokens, inputJson: canonicalJson(bounded),
    });
    const output = parsePricingInterpretationModelOutput(raw);
    return { status: 'applied', bundle: makeBundle(parsed.data, bounded, hash, output),
      warnings, metadata: metadata(taskConfig, budget.used, bounded.truncated) };
  } catch (error) {
    const warning = failureWarning(error); warnings.push(warning);
    return { status: 'abstained', bundle: makeBundle(parsed.data, bounded, hash, undefined,
      { reason: 'runtime_unavailable', detail: `Forgewing pricing interpretation did not complete: ${warning}.` }),
      warnings, metadata: metadata(taskConfig, budget.used, bounded.truncated) };
  }
}
