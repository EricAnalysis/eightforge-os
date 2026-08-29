import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import {
  ForgewingObservationArbitrationProposalBundleSchema,
  type ForgewingEvidenceRef,
  type ForgewingObservationArbitrationProposalBundle,
} from '@/lib/forgewing/proposal/schema';
import { FORGEWING_OBSERVATION_ARBITRATION_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  callClaudeForObservationArbitration,
  FORGEWING_OBSERVATION_ARBITRATION_PROMPT_ID,
  FORGEWING_OBSERVATION_ARBITRATION_PROMPT_VERSION,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';
import {
  getForgewingRuntimeConfig,
  isForgewingObservationArbitrationEnabled,
  type ForgewingRuntimeConfig,
} from '@/lib/forgewing/runtime/modelConfig';
import {
  parseObservationArbitrationModelOutput,
  type ObservationArbitrationModelOutput,
} from '@/lib/forgewing/runtime/structuredOutput';

const MAX_CANDIDATES = 2;
const MAX_OBSERVATION_IDS_PER_CANDIDATE = 200;
const MAX_TEXT_PER_CANDIDATE = 4_000;
const MAX_TOTAL_TEXT = 8_000;

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

const parserSchema = z.object({
  stage: identifier,
  name: identifier,
  version: identifier,
  configurationHash: identifier,
}).strict();

const sourceLayerSchema = z.enum([
  'pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact', 'legacy',
]);

const resolvedPhysicalCoordinateSchema = z.object({
  mappingState: z.literal('resolved_physical_page'),
  sourceDocumentId: identifier,
  sourceArtifactId: identifier,
  physicalPageNumber: z.number().int().positive(),
  artifactLocalIndex: z.number().int().nonnegative().nullable(),
  sourceLayer: z.enum(['pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact']),
}).strict();

const unprovenPhysicalCoordinateSchema = z.object({
  mappingState: z.enum([
    'unresolved_physical_page', 'conflicting_physical_page_mapping', 'legacy_unproven',
  ]),
  sourceDocumentId: identifier.nullable(),
  sourceArtifactId: identifier.nullable(),
  physicalPageNumber: z.null(),
  artifactLocalIndex: z.number().int().nonnegative().nullable(),
  sourceLayer: sourceLayerSchema,
}).strict();

const physicalCoordinateSchema = z.discriminatedUnion('mappingState', [
  resolvedPhysicalCoordinateSchema,
  unprovenPhysicalCoordinateSchema,
]);

const measuredSignalSchema = z.object({
  value: z.number().min(0).max(1),
  basisArtifactIds: z.array(identifier).min(1).max(1_000),
}).strict();

const candidateSchema = z.object({
  candidateId: identifier,
  organizationId: identifier,
  sourceDocumentId: identifier,
  sourceArtifactId: identifier,
  extractionSnapshotId: identifier,
  pageArtifactId: identifier,
  page: z.number().int().positive(),
  boundingBox: boxSchema,
  rawText: z.string().max(1_000_000),
  parser: parserSchema,
  recognitionConfidence: z.number().min(0).max(1).nullable(),
  readingOrder: z.number().int().nonnegative(),
  regionRole: z.enum(['unknown', 'text_block', 'table', 'image_text']),
  orderedTokenIds: z.array(identifier).min(1).max(10_000),
  engineReportedConfidence: z.number().min(0).max(1).nullable(),
  qualitySignals: z.object({
    glyphValidity: measuredSignalSchema,
    geometryCoverage: measuredSignalSchema,
    readingOrderConsistency: measuredSignalSchema,
    imageTextCoverage: measuredSignalSchema.nullable(),
  }).strict(),
  physicalCoordinate: physicalCoordinateSchema.optional(),
}).strict();

const decisionSchema = z.object({
  targetId: identifier,
  organizationId: identifier,
  sourceDocumentId: identifier,
  sourceArtifactId: identifier,
  extractionSnapshotId: identifier,
  pageArtifactId: identifier,
  candidateIds: z.array(identifier).min(1).max(100),
  deterministicState: z.enum(['consensus', 'single_source', 'conflict', 'unresolved']),
  agreement: z.number().min(0).max(1).nullable(),
  diagnostics: z.array(z.string().min(1).max(400)).max(20),
}).strict();

const inputSchema = z.object({
  organizationId: identifier,
  sourceDocumentId: identifier,
  extractionSnapshotId: identifier,
  regionCandidates: z.array(candidateSchema),
  arbitrationDecisions: z.array(decisionSchema),
}).strict();

export type ForgewingObservationArbitrationInput = z.input<typeof inputSchema>;
type ParsedInput = z.output<typeof inputSchema>;
type Candidate = z.output<typeof candidateSchema>;
type Decision = z.output<typeof decisionSchema>;
type BoundedCandidate = Omit<Candidate, 'rawText'> & Readonly<{
  slot: 'candidate_a' | 'candidate_b';
  observationEngine: string;
  rawText: string;
}>;
type BoundedInput = Readonly<{
  taskType: 'observation_arbitration';
  run: Readonly<{ organizationId: string; extractionSnapshotId: string }>;
  source: Readonly<{ sourceDocumentId: string; sourceArtifactId: string }>;
  target: Decision;
  candidates: readonly [BoundedCandidate, BoundedCandidate];
  truncated: boolean;
}>;

export type ForgewingObservationArbitrationWarning =
  | 'input_truncated' | 'input_contract_violation' | 'budget_exhausted'
  | 'anthropic_not_configured' | 'provider_timeout' | 'provider_error'
  | 'invalid_model_json' | 'model_schema_rejected' | 'unknown_candidate_reference'
  | 'unknown_evidence_reference';

export type ForgewingObservationArbitrationMetadata = Readonly<{
  model: string;
  promptTemplateId: typeof FORGEWING_OBSERVATION_ARBITRATION_PROMPT_ID;
  promptTemplateVersion: typeof FORGEWING_OBSERVATION_ARBITRATION_PROMPT_VERSION;
  timeoutMs: number;
  maxOutputTokens: number;
  calls: number;
  inputTruncated: boolean;
}>;

export type ForgewingObservationArbitrationResult =
  | Readonly<{ status: 'skipped'; reason: 'forgewing_disabled' | 'observation_arbitration_disabled' | 'no_candidate_targets' }>
  | Readonly<{ status: 'failed'; reason: 'input_contract_violation'; warnings: readonly ['input_contract_violation']; metadata: ForgewingObservationArbitrationMetadata }>
  | Readonly<{ status: 'applied' | 'abstained'; bundle: ForgewingObservationArbitrationProposalBundle; warnings: readonly ForgewingObservationArbitrationWarning[]; metadata: ForgewingObservationArbitrationMetadata }>;

export type ForgewingObservationArbitrationDependencies = Readonly<{
  config?: ForgewingRuntimeConfig;
  taskEnabled?: boolean;
  provider?: ForgewingProvider;
  budget?: ForgewingCallBudget;
}>;

function sameInputIdentity(input: ParsedInput, value: Candidate | Decision): boolean {
  return value.organizationId === input.organizationId
    && value.sourceDocumentId === input.sourceDocumentId
    && value.extractionSnapshotId === input.extractionSnapshotId;
}

function compareCandidate(left: Candidate, right: Candidate): number {
  const leftPhysical = left.physicalCoordinate?.mappingState === 'resolved_physical_page'
    ? left.physicalCoordinate.physicalPageNumber : Number.MAX_SAFE_INTEGER;
  const rightPhysical = right.physicalCoordinate?.mappingState === 'resolved_physical_page'
    ? right.physicalCoordinate.physicalPageNumber : Number.MAX_SAFE_INTEGER;
  return leftPhysical - rightPhysical
    || left.page - right.page
    || left.boundingBox.y0 - right.boundingBox.y0
    || left.boundingBox.x0 - right.boundingBox.x0
    || left.boundingBox.y1 - right.boundingBox.y1
    || left.boundingBox.x1 - right.boundingBox.x1
    || left.readingOrder - right.readingOrder
    || left.candidateId.localeCompare(right.candidateId)
    || left.parser.stage.localeCompare(right.parser.stage)
    || left.parser.name.localeCompare(right.parser.name)
    || left.parser.version.localeCompare(right.parser.version);
}

function compareTarget(
  left: Readonly<{ decision: Decision; candidates: readonly [Candidate, Candidate] }>,
  right: Readonly<{ decision: Decision; candidates: readonly [Candidate, Candidate] }>,
): number {
  const tier = (decision: Decision): number => decision.deterministicState === 'conflict' ? 0 : 1;
  return tier(left.decision) - tier(right.decision)
    || compareCandidate(left.candidates[0], right.candidates[0])
    || compareCandidate(left.candidates[1], right.candidates[1])
    || left.decision.targetId.localeCompare(right.decision.targetId);
}

function candidateCoordinateIsCoherent(candidate: Candidate): boolean {
  const coordinate = candidate.physicalCoordinate;
  if (!coordinate) return true;
  return (coordinate.sourceDocumentId == null
      || coordinate.sourceDocumentId === candidate.sourceDocumentId)
    && (coordinate.sourceArtifactId == null
      || coordinate.sourceArtifactId === candidate.sourceArtifactId);
}

function bound(input: ParsedInput): BoundedInput | null {
  const candidatesById = new Map<string, Candidate>();
  for (const candidate of input.regionCandidates) {
    if (candidatesById.has(candidate.candidateId)
      || !sameInputIdentity(input, candidate)
      || !candidateCoordinateIsCoherent(candidate)) throw new Error('input_contract_violation');
    candidatesById.set(candidate.candidateId, candidate);
  }
  if (new Set(input.regionCandidates.map(({ sourceArtifactId }) => sourceArtifactId)).size > 1) {
    throw new Error('input_contract_violation');
  }
  if (new Set(input.arbitrationDecisions.map(({ targetId }) => targetId)).size
    !== input.arbitrationDecisions.length) throw new Error('input_contract_violation');

  const eligible: Array<Readonly<{
    decision: Decision;
    candidates: readonly [Candidate, Candidate];
  }>> = [];
  for (const decision of input.arbitrationDecisions) {
    if (!sameInputIdentity(input, decision)) throw new Error('input_contract_violation');
    const resolvedAll = decision.candidateIds.map((id) => candidatesById.get(id));
    if (resolvedAll.some((candidate) => !candidate
      || candidate.sourceArtifactId !== decision.sourceArtifactId
      || candidate.pageArtifactId !== decision.pageArtifactId)) {
      throw new Error('input_contract_violation');
    }
    if (decision.deterministicState !== 'conflict' && decision.deterministicState !== 'unresolved') continue;
    if (decision.candidateIds.length !== MAX_CANDIDATES
      || new Set(decision.candidateIds).size !== MAX_CANDIDATES) continue;
    const resolved = decision.candidateIds.map((id) => candidatesById.get(id));
    if (!resolved[0] || !resolved[1]) throw new Error('input_contract_violation');
    if (resolved[0].page !== resolved[1].page) throw new Error('input_contract_violation');
    const firstCoordinate = resolved[0].physicalCoordinate;
    const secondCoordinate = resolved[1].physicalCoordinate;
    if (firstCoordinate?.mappingState === 'resolved_physical_page'
      && secondCoordinate?.mappingState === 'resolved_physical_page'
      && firstCoordinate.physicalPageNumber !== secondCoordinate.physicalPageNumber) {
      throw new Error('input_contract_violation');
    }
    eligible.push({
      decision,
      candidates: [resolved[0], resolved[1]].sort(compareCandidate) as [Candidate, Candidate],
    });
  }
  const selected = eligible.sort(compareTarget)[0];
  if (!selected) return null;
  let remaining = MAX_TOTAL_TEXT;
  let truncated = false;
  const candidates = selected.candidates.map((candidate, index): BoundedCandidate => {
    const maximum = Math.min(MAX_TEXT_PER_CANDIDATE, remaining);
    const rawText = candidate.rawText.slice(0, maximum);
    remaining -= rawText.length;
    if (rawText !== candidate.rawText) truncated = true;
    const clipSignal = (signal: Candidate['qualitySignals']['glyphValidity']) => {
      const basisArtifactIds = signal.basisArtifactIds.slice(0, MAX_OBSERVATION_IDS_PER_CANDIDATE);
      if (basisArtifactIds.length !== signal.basisArtifactIds.length) truncated = true;
      return { ...signal, basisArtifactIds };
    };
    const orderedTokenIds = candidate.orderedTokenIds.slice(0, MAX_OBSERVATION_IDS_PER_CANDIDATE);
    if (orderedTokenIds.length !== candidate.orderedTokenIds.length) truncated = true;
    return {
      ...candidate,
      slot: index === 0 ? 'candidate_a' : 'candidate_b',
      observationEngine: candidate.parser.stage,
      rawText,
      orderedTokenIds,
      qualitySignals: {
        glyphValidity: clipSignal(candidate.qualitySignals.glyphValidity),
        geometryCoverage: clipSignal(candidate.qualitySignals.geometryCoverage),
        readingOrderConsistency: clipSignal(candidate.qualitySignals.readingOrderConsistency),
        imageTextCoverage: candidate.qualitySignals.imageTextCoverage == null
          ? null : clipSignal(candidate.qualitySignals.imageTextCoverage),
      },
    };
  }) as [BoundedCandidate, BoundedCandidate];
  return {
    taskType: 'observation_arbitration',
    run: { organizationId: input.organizationId, extractionSnapshotId: input.extractionSnapshotId },
    source: {
      sourceDocumentId: input.sourceDocumentId,
      sourceArtifactId: selected.decision.sourceArtifactId,
    },
    target: selected.decision,
    candidates,
    truncated,
  };
}

function metadata(
  config: ForgewingRuntimeConfig,
  calls: number,
  inputTruncated: boolean,
): ForgewingObservationArbitrationMetadata {
  return {
    model: config.model,
    promptTemplateId: FORGEWING_OBSERVATION_ARBITRATION_PROMPT_ID,
    promptTemplateVersion: FORGEWING_OBSERVATION_ARBITRATION_PROMPT_VERSION,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    calls,
    inputTruncated,
  };
}

function evidenceRef(candidate: BoundedCandidate): ForgewingEvidenceRef {
  const coordinate = candidate.physicalCoordinate;
  return {
    artifactId: candidate.candidateId,
    sourceDocumentId: candidate.sourceDocumentId,
    sourceArtifactId: candidate.sourceArtifactId,
    pageArtifactId: candidate.pageArtifactId,
    boundingBox: candidate.boundingBox,
    ...(candidate.rawText.trim() ? { rawSpan: candidate.rawText } : {}),
    ...(coordinate == null ? {} : {
      sourceLayer: coordinate.sourceLayer,
      ...(coordinate.artifactLocalIndex == null ? {} : {
        artifactLocalIndex: coordinate.artifactLocalIndex,
      }),
      ...(coordinate.mappingState === 'resolved_physical_page'
        ? { physicalPageNumber: coordinate.physicalPageNumber }
        : {}),
    }),
  };
}

function makeBundle(
  input: ParsedInput,
  bounded: BoundedInput,
  inputSnapshotHash: string,
  output?: ObservationArbitrationModelOutput,
  abstention?: Readonly<{ reason: 'budget_unavailable' | 'runtime_unavailable'; detail: string }>,
): ForgewingObservationArbitrationProposalBundle {
  const taskId = `forgewing-task-observation-arbitration-${inputSnapshotHash.slice(0, 32)}`;
  const run = {
    runId: `forgewing-run-observation-arbitration-${inputSnapshotHash.slice(0, 32)}`,
    organizationId: input.organizationId,
    extractionSnapshotId: input.extractionSnapshotId,
    inputSnapshotHash,
  };
  const [candidateA, candidateB] = bounded.candidates;
  const common = {
    taskId,
    taskType: 'observation_arbitration' as const,
    sourceDocumentId: input.sourceDocumentId,
    sourceArtifactId: bounded.source.sourceArtifactId,
    extractionSnapshotId: input.extractionSnapshotId,
    inputObservationIds: [candidateA.candidateId, candidateB.candidateId],
  };
  if (abstention) {
    return ForgewingObservationArbitrationProposalBundleSchema.parse({
      schemaVersion: FORGEWING_OBSERVATION_ARBITRATION_PROPOSAL_SCHEMA_VERSION,
      authority: 'non_authoritative',
      run,
      taskId,
      taskType: 'observation_arbitration',
      proposals: [],
      abstentions: [{ ...common, reason: abstention.reason, detail: abstention.detail }],
    });
  }
  if (!output) throw new Error('model output is required');
  const candidateById = new Map(bounded.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const selected = output.evidenceIds.map((id) => {
    const candidate = candidateById.get(id);
    if (!candidate) throw new Error('unknown_evidence_reference');
    return candidate;
  });
  if (output.state === 'inferred') {
    if (new Set(selected.map(({ candidateId }) => candidateId)).size !== MAX_CANDIDATES) {
      throw new Error('model_schema_rejected');
    }
    const expectedPreferred = output.relation === 'prefer_candidate_a'
      ? candidateA.candidateId
      : output.relation === 'prefer_candidate_b'
        ? candidateB.candidateId
        : null;
    if (expectedPreferred == null
      ? output.preferredCandidateId != null
      : output.preferredCandidateId !== expectedPreferred) {
      throw new Error('unknown_candidate_reference');
    }
  }
  const base = {
    proposalId: `forgewing-proposal-observation-arbitration-${inputSnapshotHash.slice(0, 32)}`,
    ...common,
    targetId: bounded.target.targetId,
    deterministicState: bounded.target.deterministicState,
    candidateAId: candidateA.candidateId,
    candidateBId: candidateB.candidateId,
    pageArtifactId: bounded.target.pageArtifactId,
    ...(candidateA.physicalCoordinate?.mappingState === 'resolved_physical_page'
      && candidateB.physicalCoordinate?.mappingState === 'resolved_physical_page'
      && candidateA.physicalCoordinate.physicalPageNumber
        === candidateB.physicalCoordinate.physicalPageNumber
      ? {
          physicalPageNumber: candidateA.physicalCoordinate.physicalPageNumber,
          ...(candidateA.physicalCoordinate.artifactLocalIndex != null
            && candidateA.physicalCoordinate.artifactLocalIndex
              === candidateB.physicalCoordinate.artifactLocalIndex
            ? { artifactLocalIndex: candidateA.physicalCoordinate.artifactLocalIndex }
            : {}),
        }
      : {}),
    confidence: output.confidence,
    rationaleCodes: output.rationaleCodes,
    evidence: selected.map(evidenceRef),
  };
  const proposal = output.state === 'insufficient_evidence'
    ? { ...base, state: output.state, missingEvidence: output.missingEvidence.map((code) => ({ code })) }
    : {
        ...base,
        state: output.state,
        relation: output.relation,
        ...(output.preferredCandidateId == null ? {} : {
          preferredCandidateId: output.preferredCandidateId,
        }),
      };
  return ForgewingObservationArbitrationProposalBundleSchema.parse({
    schemaVersion: FORGEWING_OBSERVATION_ARBITRATION_PROPOSAL_SCHEMA_VERSION,
    authority: 'non_authoritative',
    run,
    taskId,
    taskType: 'observation_arbitration',
    proposals: [proposal],
    abstentions: [],
  });
}

function failureWarning(error: unknown): ForgewingObservationArbitrationWarning {
  const message = error instanceof Error ? error.message : '';
  const name = error && typeof error === 'object' ? error.constructor?.name ?? '' : '';
  if (message === 'provider_timeout' || message === 'Request timed out'
    || name === 'APIConnectionTimeoutError') return 'provider_timeout';
  if (message === 'invalid_model_json') return 'invalid_model_json';
  if (message === 'model_schema_rejected') return 'model_schema_rejected';
  if (message === 'unknown_candidate_reference') return 'unknown_candidate_reference';
  if (message === 'unknown_evidence_reference') return 'unknown_evidence_reference';
  if (message.includes('ANTHROPIC_API_KEY')) return 'anthropic_not_configured';
  return 'provider_error';
}

async function callWithin(
  provider: ForgewingProvider,
  request: Parameters<ForgewingProvider>[0],
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider_timeout')), request.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runForgewingObservationArbitration(
  rawInput: ForgewingObservationArbitrationInput,
  dependencies: ForgewingObservationArbitrationDependencies = {},
): Promise<ForgewingObservationArbitrationResult> {
  const config = dependencies.config ?? getForgewingRuntimeConfig();
  if (!config.enabled) return { status: 'skipped', reason: 'forgewing_disabled' };
  if (!(dependencies.taskEnabled ?? isForgewingObservationArbitrationEnabled())) {
    return { status: 'skipped', reason: 'observation_arbitration_disabled' };
  }
  const taskConfig = { ...config, maxOutputTokens: Math.min(config.maxOutputTokens, 800) };
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      status: 'failed',
      reason: 'input_contract_violation',
      warnings: ['input_contract_violation'],
      metadata: metadata(taskConfig, 0, false),
    };
  }
  let bounded: BoundedInput | null;
  try {
    bounded = bound(parsed.data);
  } catch {
    return {
      status: 'failed',
      reason: 'input_contract_violation',
      warnings: ['input_contract_violation'],
      metadata: metadata(taskConfig, 0, false),
    };
  }
  if (!bounded) return { status: 'skipped', reason: 'no_candidate_targets' };
  const inputSnapshotHash = hashCanonical(bounded);
  const budget = dependencies.budget ?? new ForgewingCallBudget(Math.min(taskConfig.maxCalls, 1));
  const warnings: ForgewingObservationArbitrationWarning[] = bounded.truncated
    ? ['input_truncated'] : [];
  if (!budget.tryConsume()) {
    warnings.push('budget_exhausted');
    return {
      status: 'abstained',
      bundle: makeBundle(parsed.data, bounded, inputSnapshotHash, undefined, {
        reason: 'budget_unavailable',
        detail: 'Forgewing observation arbitration call budget was exhausted before provider invocation.',
      }),
      warnings,
      metadata: metadata(taskConfig, budget.used, bounded.truncated),
    };
  }
  try {
    const raw = await callWithin(dependencies.provider ?? callClaudeForObservationArbitration, {
      model: taskConfig.model,
      timeoutMs: taskConfig.timeoutMs,
      maxOutputTokens: taskConfig.maxOutputTokens,
      inputJson: canonicalJson(bounded),
    });
    const output = parseObservationArbitrationModelOutput(raw);
    return {
      status: 'applied',
      bundle: makeBundle(parsed.data, bounded, inputSnapshotHash, output),
      warnings,
      metadata: metadata(taskConfig, budget.used, bounded.truncated),
    };
  } catch (error) {
    const warning = failureWarning(error);
    warnings.push(warning);
    return {
      status: 'abstained',
      bundle: makeBundle(parsed.data, bounded, inputSnapshotHash, undefined, {
        reason: 'runtime_unavailable',
        detail: `Forgewing observation arbitration did not complete: ${warning}.`,
      }),
      warnings,
      metadata: metadata(taskConfig, budget.used, bounded.truncated),
    };
  }
}
