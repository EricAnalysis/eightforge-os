import { z } from 'zod';

import {
  BENCHMARK_COVERAGE_TRUTHS,
  BENCHMARK_WORKSPACE_VERSION,
  BenchmarkBoxSchema,
  BenchmarkCellLabelSchema,
  BenchmarkPageLabelsSchema,
  BenchmarkRowLabelSchema,
  BenchmarkWordLabelSchema,
  benchmarkLabelsDigest,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  bindBenchmarkSuggestions,
  type BenchmarkPageSuggestions,
} from '@/lib/evaluation/benchmark/benchmarkSuggestions';
import { hashCanonical } from '@/lib/extraction/domain/hash';

export const BENCHMARK_REVIEWER_LABELS_VERSION =
  'extraction-benchmark-reviewer-labels-v1' as const;
export const BENCHMARK_REVIEWER_LABEL_AUTHORITY =
  'non_authoritative_reviewer_proposal' as const;
export const BENCHMARK_COMPARISON_VERSION =
  'extraction-benchmark-dual-review-comparison-v1' as const;
export const BENCHMARK_COMPARISON_AUTHORITY = 'non_authoritative_comparison' as const;
export const BENCHMARK_ADJUDICATION_VERSION =
  'extraction-benchmark-adjudication-v1' as const;
export const BENCHMARK_ADJUDICATION_AUTHORITY = 'explicit_user_adjudication_only' as const;

const identifier = z.string().min(1).max(200).refine((value) => value.trim() === value,
  'identifier whitespace');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const readingOrder = z.number().int().nonnegative();
const sourceSchema = z.object({
  documentKey: identifier,
  sha256: digest,
  byteLength: z.number().int().positive(),
  physicalPageNumber: z.number().int().positive(),
}).strict();
const frameSchema = z.object({
  frame_version: z.literal('canonical_frame_v1'),
  coordinate_space: z.literal('canonical_v1'),
  view: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  user_unit: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
}).strict();

const ReviewerWordSchema = z.object({
  reviewerItemId: identifier,
  readingOrder,
  text: z.string().min(1).max(500),
  box: BenchmarkBoxSchema.nullable(),
}).strict();

const ReviewerCellSchema = z.object({
  reviewerItemId: identifier,
  readingOrder,
  text: z.string().max(2_000),
  box: BenchmarkBoxSchema.nullable(),
  isHeader: z.boolean(),
  columnName: z.string().max(200).nullable(),
}).strict();

const ReviewerRowSchema = z.object({
  reviewerRowId: identifier,
  readingOrder,
  orderedCellReviewerItemIds: z.array(identifier).min(1).max(200),
}).strict();

export const BenchmarkReviewerLabelSetSchema = z.object({
  reviewerLabelSetVersion: z.literal(BENCHMARK_REVIEWER_LABELS_VERSION),
  authority: z.literal(BENCHMARK_REVIEWER_LABEL_AUTHORITY),
  reviewerSlot: z.enum(['reviewer_a', 'reviewer_b']),
  reviewerIdentity: identifier,
  independence: z.object({
    inputMode: z.literal('clean_source_page_only'),
    sawMachineSuggestions: z.literal(false),
    sawOtherReviewerLabels: z.literal(false),
  }).strict(),
  pageKey: identifier,
  source: sourceSchema,
  frame: frameSchema,
  words: z.array(ReviewerWordSchema).min(1).max(5_000),
  cells: z.array(ReviewerCellSchema).min(1).max(5_000),
  rows: z.array(ReviewerRowSchema).min(1).max(5_000),
  coverageProposal: z.enum(BENCHMARK_COVERAGE_TRUTHS),
  coverageNote: z.string().max(2_000).nullable(),
}).strict().superRefine((labels, ctx) => {
  for (const [name, ids] of [
    ['word reviewer item', labels.words.map((item) => item.reviewerItemId)],
    ['cell reviewer item', labels.cells.map((item) => item.reviewerItemId)],
    ['row reviewer item', labels.rows.map((item) => item.reviewerRowId)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: `duplicate ${name} id` });
    }
  }
  for (const [name, orders] of [
    ['word', labels.words.map((item) => item.readingOrder)],
    ['cell', labels.cells.map((item) => item.readingOrder)],
    ['row', labels.rows.map((item) => item.readingOrder)],
  ] as const) {
    if (new Set(orders).size !== orders.length) {
      ctx.addIssue({ code: 'custom', message: `duplicate ${name} reading order` });
    }
  }
  const cellIds = new Set(labels.cells.map((item) => item.reviewerItemId));
  const claimed = new Set<string>();
  for (const row of labels.rows) {
    for (const cellId of row.orderedCellReviewerItemIds) {
      if (!cellIds.has(cellId)) {
        ctx.addIssue({ code: 'custom', message: `row ${row.reviewerRowId} cites unknown cell ${cellId}` });
      }
      if (claimed.has(cellId)) {
        ctx.addIssue({ code: 'custom', message: `cell ${cellId} belongs to more than one row` });
      }
      claimed.add(cellId);
    }
  }
});

export type BenchmarkReviewerLabelSet = z.infer<typeof BenchmarkReviewerLabelSetSchema>;

const GeometryProvenanceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('reviewer_exact') }).strict(),
  z.object({
    source: z.literal('provisional_ocr'),
    suggestionId: identifier,
    suggestionsSha256: digest,
  }).strict(),
]);

const ComparisonEntrySchema = z.object({
  issueId: identifier,
  kind: z.enum(['word', 'cell', 'row', 'coverage']),
  matchKey: identifier,
  reviewerA: z.record(z.unknown()).nullable(),
  reviewerB: z.record(z.unknown()).nullable(),
  candidateResolution: z.record(z.unknown()).nullable(),
  geometryProvenance: GeometryProvenanceSchema.nullable(),
}).strict();

const CandidateFinalLabelsSchema = z.object({
  words: z.array(BenchmarkWordLabelSchema).max(5_000),
  cells: z.array(BenchmarkCellLabelSchema).max(5_000),
  rows: z.array(BenchmarkRowLabelSchema).max(5_000),
  coverage: z.enum(BENCHMARK_COVERAGE_TRUTHS).nullable(),
}).strict();

export const BenchmarkDualReviewComparisonSchema = z.object({
  comparisonVersion: z.literal(BENCHMARK_COMPARISON_VERSION),
  authority: z.literal(BENCHMARK_COMPARISON_AUTHORITY),
  matchingRules: z.object({
    version: z.literal('exact_reading_order_and_unique_exact_ocr_v1'),
    fuzzyMatching: z.literal(false),
    reviewerAgreementIsAuthority: z.literal(false),
  }).strict(),
  pageKey: identifier,
  source: sourceSchema,
  frame: frameSchema,
  reviewerA: z.object({ identity: identifier, sha256: digest }).strict(),
  reviewerB: z.object({ identity: identifier, sha256: digest }).strict(),
  suggestionsSha256: digest.nullable(),
  exactAgreements: z.array(ComparisonEntrySchema).max(20_000),
  textDisagreements: z.array(ComparisonEntrySchema).max(10_000),
  bboxDisagreements: z.array(ComparisonEntrySchema).max(10_000),
  cellStructureDisagreements: z.array(ComparisonEntrySchema).max(10_000),
  rowMembershipDisagreements: z.array(ComparisonEntrySchema).max(10_000),
  coverageDisagreements: z.array(ComparisonEntrySchema).max(10),
  ambiguousItems: z.array(ComparisonEntrySchema).max(10_000),
  unmatchedReviewerA: z.array(ComparisonEntrySchema).max(10_000),
  unmatchedReviewerB: z.array(ComparisonEntrySchema).max(10_000),
  candidateFinalLabels: CandidateFinalLabelsSchema,
  requiredAdjudicationIssueIds: z.array(identifier).max(50_000),
  userAdjudicationRequired: z.literal(true),
  userApprovalRequired: z.literal(true),
}).strict().superRefine((comparison, ctx) => {
  const agreementIds = comparison.exactAgreements.map((agreement) => agreement.issueId);
  if (new Set(agreementIds).size !== agreementIds.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate exact agreement id' });
  }
  const issueArrays = [
    comparison.textDisagreements,
    comparison.bboxDisagreements,
    comparison.cellStructureDisagreements,
    comparison.rowMembershipDisagreements,
    comparison.coverageDisagreements,
    comparison.ambiguousItems,
    comparison.unmatchedReviewerA,
    comparison.unmatchedReviewerB,
  ];
  const actual = issueArrays.flat().map((item) => item.issueId);
  if (new Set(actual).size !== actual.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate comparison issue id' });
  }
  if (new Set(comparison.requiredAdjudicationIssueIds).size
      !== comparison.requiredAdjudicationIssueIds.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate required adjudication issue id' });
  }
  if (hashCanonical([...actual].sort())
      !== hashCanonical([...comparison.requiredAdjudicationIssueIds].sort())) {
    ctx.addIssue({ code: 'custom', message: 'required adjudication issue ids differ from comparison issues' });
  }
});

export type BenchmarkDualReviewComparison = z.infer<typeof BenchmarkDualReviewComparisonSchema>;

const ManualWordValueSchema = z.object({
  kind: z.literal('word'),
  text: z.string().min(1).max(500),
  box: BenchmarkBoxSchema,
}).strict();
const ManualCellValueSchema = z.object({
  kind: z.literal('cell'),
  text: z.string().max(2_000),
  box: BenchmarkBoxSchema,
  isHeader: z.boolean(),
  columnName: z.string().max(200).nullable(),
}).strict();

const ReviewerRowMembershipCellSchema = z.object({
  reviewerItemId: identifier,
  readingOrder,
  text: z.string().max(2_000),
  isHeader: z.boolean(),
  columnName: z.string().max(200).nullable(),
}).strict();
const ManualRowValueSchema = z.object({
  kind: z.literal('row'),
  orderedCellLabelIds: z.array(identifier).min(1).max(200),
}).strict();
const ManualItemValueSchema = z.discriminatedUnion('kind', [
  ManualWordValueSchema,
  ManualCellValueSchema,
  ManualRowValueSchema,
]);
const ManualResolutionValueSchema = z.discriminatedUnion('kind', [
  ManualWordValueSchema,
  ManualCellValueSchema,
  ManualRowValueSchema,
  z.object({
    kind: z.literal('coverage'),
    truth: z.enum(BENCHMARK_COVERAGE_TRUTHS),
    note: z.string().max(2_000).nullable(),
  }).strict(),
]);

export const BenchmarkAdjudicationResolutionSchema = z.object({
  issueId: identifier,
  decision: z.enum([
    'choose_reviewer_a',
    'choose_reviewer_b',
    'manual_resolution',
    'exclude_item',
  ]),
  note: z.string().min(1).max(2_000),
  manualValue: ManualResolutionValueSchema.nullable(),
}).strict().superRefine((resolution, ctx) => {
  if (resolution.decision === 'manual_resolution' && resolution.manualValue === null) {
    ctx.addIssue({ code: 'custom', message: 'manual resolution requires manualValue' });
  }
  if (resolution.decision !== 'manual_resolution' && resolution.manualValue !== null) {
    ctx.addIssue({ code: 'custom', message: 'non-manual decision must not carry a manualValue' });
  }
});

export const BenchmarkAgreementChallengeSchema = z.object({
  targetKind: z.enum(['word', 'cell', 'row']),
  targetAgreementId: identifier,
  targetAgreementSha256: digest,
  action: z.enum(['replace', 'exclude']),
  replacement: ManualItemValueSchema.nullable(),
  note: z.string().min(1).max(2_000),
}).strict().superRefine((challenge, ctx) => {
  if (challenge.action === 'replace' && challenge.replacement === null) {
    ctx.addIssue({ code: 'custom', message: 'replace challenge requires replacement' });
  }
  if (challenge.action === 'replace' && challenge.replacement?.kind !== challenge.targetKind) {
    ctx.addIssue({ code: 'custom', message: 'challenge replacement kind differs from target kind' });
  }
  if (challenge.action === 'exclude' && challenge.replacement !== null) {
    ctx.addIssue({ code: 'custom', message: 'exclude challenge must not carry replacement' });
  }
});

const AdjudicationApprovalSchema = z.object({
  decision: z.literal('approve_as_benchmark_truth'),
  approvedBy: z.string().min(1).max(200).refine((value) => value.trim().length > 0,
    'approving identity must not be blank'),
  approvedAt: z.string().datetime({ offset: true }),
  approvedCandidateSha256: digest,
}).strict();

export const BenchmarkAdjudicationSchema = z.object({
  adjudicationVersion: z.literal(BENCHMARK_ADJUDICATION_VERSION),
  authority: z.literal(BENCHMARK_ADJUDICATION_AUTHORITY),
  pageKey: identifier,
  source: sourceSchema,
  frame: frameSchema,
  comparisonSha256: digest,
  reviewerALabelSetSha256: digest,
  reviewerBLabelSetSha256: digest,
  suggestionsSha256: digest.nullable(),
  resolutions: z.array(BenchmarkAdjudicationResolutionSchema).max(50_000),
  userChallenges: z.array(BenchmarkAgreementChallengeSchema).max(20_000),
  approval: AdjudicationApprovalSchema.nullable(),
}).strict().superRefine((adjudication, ctx) => {
  const ids = adjudication.resolutions.map((resolution) => resolution.issueId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate adjudication issue resolution' });
  }
  const challenged = adjudication.userChallenges.map((challenge) => challenge.targetAgreementId);
  if (new Set(challenged).size !== challenged.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate agreement challenge' });
  }
});

export type BenchmarkAdjudication = z.infer<typeof BenchmarkAdjudicationSchema>;
export type BenchmarkAdjudicationResolution = z.infer<typeof BenchmarkAdjudicationResolutionSchema>;
export type BenchmarkAgreementChallenge = z.infer<typeof BenchmarkAgreementChallengeSchema>;

export function benchmarkAgreementDigest(
  agreement: BenchmarkDualReviewComparison['exactAgreements'][number],
): string {
  return hashCanonical(agreement);
}

export type BenchmarkDualReviewBindingSource = Readonly<{
  pageKey: string;
  documentKey: string;
  sha256: string;
  byteLength: number;
  physicalPageNumber: number;
  frame: BenchmarkPageLabels['frame'];
}>;

export function benchmarkDualReviewSourceFromWorkspaceManifest(
  manifestValue: unknown,
  pageKey: string,
): BenchmarkDualReviewBindingSource {
  if (!manifestValue || typeof manifestValue !== 'object' || Array.isArray(manifestValue)) {
    throw new BenchmarkDualReviewError('reviewer_binding_failed', 'workspace manifest must be an object');
  }
  const manifest = manifestValue as Record<string, unknown>;
  if (manifest.workspaceVersion !== BENCHMARK_WORKSPACE_VERSION) {
    throw new BenchmarkDualReviewError('reviewer_binding_failed', 'workspace manifest version differs');
  }
  if (!Array.isArray(manifest.pages)) {
    throw new BenchmarkDualReviewError('reviewer_binding_failed', 'workspace manifest pages must be an array');
  }
  const matches = manifest.pages.filter((page) => page && typeof page === 'object'
    && !Array.isArray(page) && (page as Record<string, unknown>).pageKey === pageKey);
  if (matches.length !== 1) {
    throw new BenchmarkDualReviewError('reviewer_binding_failed',
      `${pageKey}: expected exactly one workspace manifest page`);
  }
  const page = matches[0] as Record<string, unknown>;
  const parsed = z.object({
    pageKey: identifier,
    documentKey: identifier,
    sha256: digest,
    byteLength: z.number().int().positive(),
    physicalPageNumber: z.number().int().positive(),
    frame: frameSchema,
  }).passthrough().safeParse(page);
  if (!parsed.success) {
    throw new BenchmarkDualReviewError('reviewer_binding_failed',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  return {
    pageKey: parsed.data.pageKey,
    documentKey: parsed.data.documentKey,
    sha256: parsed.data.sha256,
    byteLength: parsed.data.byteLength,
    physicalPageNumber: parsed.data.physicalPageNumber,
    frame: parsed.data.frame,
  };
}

export class BenchmarkDualReviewError extends Error {
  constructor(
    readonly code: 'reviewer_schema_invalid' | 'reviewer_binding_failed'
      | 'comparison_schema_invalid' | 'comparison_failed'
      | 'adjudication_schema_invalid' | 'finalization_failed',
    detail: string,
  ) {
    super(`BENCHMARK_DUAL_REVIEW_${code.toUpperCase()}: ${detail}`);
    this.name = 'BenchmarkDualReviewError';
  }
}

export type ParsedBenchmarkReviewerLabels = Readonly<{
  labels: BenchmarkReviewerLabelSet;
  sha256: string;
}>;

export type ParsedBenchmarkComparison = Readonly<{
  comparison: BenchmarkDualReviewComparison;
  sha256: string;
}>;

export function parseBenchmarkReviewerLabels(
  bytes: Uint8Array | string,
): ParsedBenchmarkReviewerLabels {
  const parsed = parseJson(bytes, BenchmarkReviewerLabelSetSchema, 'reviewer_schema_invalid');
  return Object.freeze({ labels: parsed, sha256: hashCanonical(parsed) });
}

export function parseBenchmarkDualReviewComparison(
  bytes: Uint8Array | string,
): ParsedBenchmarkComparison {
  const parsed = parseJson(bytes, BenchmarkDualReviewComparisonSchema, 'comparison_schema_invalid');
  return Object.freeze({ comparison: parsed, sha256: hashCanonical(parsed) });
}

export function parseBenchmarkAdjudication(bytes: Uint8Array | string): BenchmarkAdjudication {
  return parseJson(bytes, BenchmarkAdjudicationSchema, 'adjudication_schema_invalid');
}

function parseJson<T extends z.ZodTypeAny>(
  bytes: Uint8Array | string,
  schema: T,
  code: BenchmarkDualReviewError['code'],
): z.infer<T> {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BenchmarkDualReviewError(code, 'artifact is not JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new BenchmarkDualReviewError(code,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  return parsed.data;
}

export function bindBenchmarkReviewerLabels(
  parsed: ParsedBenchmarkReviewerLabels,
  source: BenchmarkDualReviewBindingSource,
): ParsedBenchmarkReviewerLabels {
  const labels = parsed.labels;
  const problems: string[] = [];
  if (labels.pageKey !== source.pageKey) problems.push('page key differs');
  if (labels.source.documentKey !== source.documentKey) problems.push('document key differs');
  if (labels.source.sha256 !== source.sha256) problems.push('source sha256 differs');
  if (labels.source.byteLength !== source.byteLength) problems.push('source byte length differs');
  if (labels.source.physicalPageNumber !== source.physicalPageNumber) {
    problems.push('physical page number differs');
  }
  if (hashCanonical(labels.frame) !== hashCanonical(source.frame)) {
    problems.push('canonical page frame differs');
  }
  if (problems.length > 0) {
    throw new BenchmarkDualReviewError('reviewer_binding_failed', problems.join('; '));
  }
  return parsed;
}

type ParsedSuggestions = Readonly<{
  suggestions: BenchmarkPageSuggestions;
  suggestionsSha256: string;
}>;

function record(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function same(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

function byReadingOrder<T extends { readingOrder: number }>(items: readonly T[]): Map<number, T> {
  return new Map(items.map((item) => [item.readingOrder, item]));
}

function comparisonEntry(input: Readonly<{
  issueId: string;
  kind: 'word' | 'cell' | 'row' | 'coverage';
  matchKey: string;
  reviewerA: unknown | null;
  reviewerB: unknown | null;
  candidateResolution?: unknown | null;
  geometryProvenance?: z.infer<typeof GeometryProvenanceSchema> | null;
}>): z.infer<typeof ComparisonEntrySchema> {
  return {
    issueId: input.issueId,
    kind: input.kind,
    matchKey: input.matchKey,
    reviewerA: input.reviewerA === null ? null : record(input.reviewerA),
    reviewerB: input.reviewerB === null ? null : record(input.reviewerB),
    candidateResolution: input.candidateResolution == null ? null : record(input.candidateResolution),
    geometryProvenance: input.geometryProvenance ?? null,
  };
}

function geometryForExactAgreement(input: Readonly<{
  kind: 'word' | 'cell';
  text: string;
  reviewerBox: z.infer<typeof BenchmarkBoxSchema> | null;
  exactTextAgreementCount: number;
  suggestions: ParsedSuggestions | null;
}>): Readonly<{
  box: z.infer<typeof BenchmarkBoxSchema> | null;
  provenance: z.infer<typeof GeometryProvenanceSchema> | null;
  ambiguity: string | null;
}> {
  if (input.reviewerBox) {
    return { box: input.reviewerBox, provenance: { source: 'reviewer_exact' }, ambiguity: null };
  }
  if (!input.suggestions) {
    return { box: null, provenance: null, ambiguity: 'no bound provisional OCR geometry was supplied' };
  }
  const candidates = input.kind === 'word'
    ? input.suggestions.suggestions.words.filter((item) => item.text === input.text)
    : input.suggestions.suggestions.cells.filter((item) => item.text === input.text);
  if (input.exactTextAgreementCount !== 1 || candidates.length !== 1) {
    return {
      box: null,
      provenance: null,
      ambiguity: `exact text resolves to ${candidates.length} provisional ${input.kind} geometries`,
    };
  }
  const candidate = candidates[0]!;
  return {
    box: candidate.box,
    provenance: {
      source: 'provisional_ocr',
      suggestionId: candidate.suggestionId,
      suggestionsSha256: input.suggestions.suggestionsSha256,
    },
    ambiguity: null,
  };
}

function rowMembership(
  row: BenchmarkReviewerLabelSet['rows'][number],
  cells: ReadonlyMap<string, BenchmarkReviewerLabelSet['cells'][number]>,
): readonly Record<string, unknown>[] {
  return row.orderedCellReviewerItemIds.map((cellId) => {
    const cell = cells.get(cellId)!;
    return {
      reviewerItemId: cell.reviewerItemId,
      readingOrder: cell.readingOrder,
      text: cell.text,
      isHeader: cell.isHeader,
      columnName: cell.columnName,
    };
  });
}

export function compareBenchmarkReviewerLabels(input: Readonly<{
  reviewerA: ParsedBenchmarkReviewerLabels;
  reviewerB: ParsedBenchmarkReviewerLabels;
  source: BenchmarkDualReviewBindingSource;
  suggestions?: ParsedSuggestions | null;
}>): BenchmarkDualReviewComparison {
  const reviewerA = bindBenchmarkReviewerLabels(input.reviewerA, input.source);
  const reviewerB = bindBenchmarkReviewerLabels(input.reviewerB, input.source);
  if (reviewerA.labels.reviewerSlot !== 'reviewer_a'
      || reviewerB.labels.reviewerSlot !== 'reviewer_b') {
    throw new BenchmarkDualReviewError('comparison_failed',
      'inputs must be reviewer_a followed by reviewer_b');
  }
  if (reviewerA.labels.reviewerIdentity === reviewerB.labels.reviewerIdentity) {
    throw new BenchmarkDualReviewError('comparison_failed',
      'reviewer identities must be independent');
  }
  const suggestions = input.suggestions
    ? bindBenchmarkSuggestions(input.suggestions, input.source)
    : null;

  const exactAgreements: z.infer<typeof ComparisonEntrySchema>[] = [];
  const textDisagreements: z.infer<typeof ComparisonEntrySchema>[] = [];
  const bboxDisagreements: z.infer<typeof ComparisonEntrySchema>[] = [];
  const cellStructureDisagreements: z.infer<typeof ComparisonEntrySchema>[] = [];
  const rowMembershipDisagreements: z.infer<typeof ComparisonEntrySchema>[] = [];
  const coverageDisagreements: z.infer<typeof ComparisonEntrySchema>[] = [];
  const ambiguousItems: z.infer<typeof ComparisonEntrySchema>[] = [];
  const unmatchedReviewerA: z.infer<typeof ComparisonEntrySchema>[] = [];
  const unmatchedReviewerB: z.infer<typeof ComparisonEntrySchema>[] = [];
  const candidateWords: z.infer<typeof BenchmarkWordLabelSchema>[] = [];
  const candidateCells: z.infer<typeof BenchmarkCellLabelSchema>[] = [];
  const candidateRows: z.infer<typeof BenchmarkRowLabelSchema>[] = [];
  const candidateCellIdsA = new Map<string, string>();
  const candidateCellIdsB = new Map<string, string>();

  const wordTextPositions = new Map<string, Set<number>>();
  const cellTextPositions = new Map<string, Set<number>>();
  for (const kind of ['words', 'cells'] as const) {
    const positions = kind === 'words' ? wordTextPositions : cellTextPositions;
    for (const item of [...reviewerA.labels[kind], ...reviewerB.labels[kind]]) {
      const orders = positions.get(item.text) ?? new Set<number>();
      orders.add(item.readingOrder);
      positions.set(item.text, orders);
    }
  }
  const semanticOccurrenceCount = (kind: 'words' | 'cells', text: string) => {
    const positions = kind === 'words' ? wordTextPositions : cellTextPositions;
    return positions.get(text)?.size ?? 0;
  };

  for (const kind of ['words', 'cells'] as const) {
    const left = byReadingOrder(reviewerA.labels[kind]);
    const right = byReadingOrder(reviewerB.labels[kind]);
    const orders = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b);
    for (const order of orders) {
      const a = left.get(order);
      const b = right.get(order);
      const singular = kind === 'words' ? 'word' as const : 'cell' as const;
      const matchKey = `${singular}:${order}`;
      if (!a) {
        unmatchedReviewerB.push(comparisonEntry({
          issueId: `unmatched-reviewer-b-${matchKey}`, kind: singular, matchKey,
          reviewerA: null, reviewerB: b!,
        }));
        continue;
      }
      if (!b) {
        unmatchedReviewerA.push(comparisonEntry({
          issueId: `unmatched-reviewer-a-${matchKey}`, kind: singular, matchKey,
          reviewerA: a, reviewerB: null,
        }));
        continue;
      }
      if (a.text !== b.text) {
        textDisagreements.push(comparisonEntry({
          issueId: `text-disagreement-${matchKey}`, kind: singular, matchKey,
          reviewerA: a, reviewerB: b,
        }));
        continue;
      }
      if (kind === 'cells') {
        const cellA = a as BenchmarkReviewerLabelSet['cells'][number];
        const cellB = b as BenchmarkReviewerLabelSet['cells'][number];
        if (cellA.isHeader !== cellB.isHeader || cellA.columnName !== cellB.columnName) {
          cellStructureDisagreements.push(comparisonEntry({
            issueId: `cell-structure-disagreement-${matchKey}`, kind: 'cell', matchKey,
            reviewerA: cellA, reviewerB: cellB,
          }));
          continue;
        }
      }
      if (!same(a.box, b.box)) {
        bboxDisagreements.push(comparisonEntry({
          issueId: `bbox-disagreement-${matchKey}`, kind: singular, matchKey,
          reviewerA: a, reviewerB: b,
        }));
        continue;
      }
      const geometry = geometryForExactAgreement({
        kind: singular,
        text: a.text,
        reviewerBox: a.box,
        exactTextAgreementCount: semanticOccurrenceCount(kind, a.text),
        suggestions,
      });
      exactAgreements.push(comparisonEntry({
        issueId: `agreement-${matchKey}`, kind: singular, matchKey,
        reviewerA: a, reviewerB: b,
        candidateResolution: geometry.box ? { ...a, box: geometry.box } : null,
        geometryProvenance: geometry.provenance,
      }));
      if (!geometry.box) {
        ambiguousItems.push(comparisonEntry({
          issueId: `ambiguous-geometry-${matchKey}`, kind: singular, matchKey,
          reviewerA: a, reviewerB: b,
          candidateResolution: { reason: geometry.ambiguity },
        }));
        continue;
      }
      if (kind === 'words') {
        candidateWords.push({
          labelId: `w-${String(order + 1).padStart(4, '0')}`,
          text: a.text,
          box: geometry.box,
        });
      } else {
        const cellA = a as BenchmarkReviewerLabelSet['cells'][number];
        const cellB = b as BenchmarkReviewerLabelSet['cells'][number];
        const labelId = `c-${String(order + 1).padStart(4, '0')}`;
        candidateCells.push({
          labelId,
          text: cellA.text,
          box: geometry.box,
          isHeader: cellA.isHeader,
          columnName: cellA.columnName,
        });
        candidateCellIdsA.set(cellA.reviewerItemId, labelId);
        candidateCellIdsB.set(cellB.reviewerItemId, labelId);
      }
    }
  }

  const cellsA = new Map(reviewerA.labels.cells.map((cell) => [cell.reviewerItemId, cell]));
  const cellsB = new Map(reviewerB.labels.cells.map((cell) => [cell.reviewerItemId, cell]));
  const rowsA = byReadingOrder(reviewerA.labels.rows);
  const rowsB = byReadingOrder(reviewerB.labels.rows);
  const rowOrders = [...new Set([...rowsA.keys(), ...rowsB.keys()])].sort((a, b) => a - b);
  for (const order of rowOrders) {
    const a = rowsA.get(order);
    const b = rowsB.get(order);
    const matchKey = `row:${order}`;
    if (!a) {
      unmatchedReviewerB.push(comparisonEntry({
        issueId: `unmatched-reviewer-b-${matchKey}`, kind: 'row', matchKey,
        reviewerA: null, reviewerB: b!,
      }));
      continue;
    }
    if (!b) {
      unmatchedReviewerA.push(comparisonEntry({
        issueId: `unmatched-reviewer-a-${matchKey}`, kind: 'row', matchKey,
        reviewerA: a, reviewerB: null,
      }));
      continue;
    }
    const membershipA = rowMembership(a, cellsA);
    const membershipB = rowMembership(b, cellsB);
    const semanticMembership = (items: readonly Record<string, unknown>[]) => items.map((cell) => ({
      readingOrder: cell.readingOrder,
      text: cell.text,
      isHeader: cell.isHeader,
      columnName: cell.columnName,
    }));
    if (!same(semanticMembership(membershipA), semanticMembership(membershipB))) {
      rowMembershipDisagreements.push(comparisonEntry({
        issueId: `row-membership-disagreement-${matchKey}`, kind: 'row', matchKey,
        reviewerA: { row: a, cells: membershipA },
        reviewerB: { row: b, cells: membershipB },
      }));
      continue;
    }
    const finalCellsA = a.orderedCellReviewerItemIds.map((id) => candidateCellIdsA.get(id));
    const finalCellsB = b.orderedCellReviewerItemIds.map((id) => candidateCellIdsB.get(id));
    exactAgreements.push(comparisonEntry({
      issueId: `agreement-${matchKey}`, kind: 'row', matchKey,
      reviewerA: { row: a, cells: membershipA },
      reviewerB: { row: b, cells: membershipB },
      candidateResolution: finalCellsA.every(Boolean) && same(finalCellsA, finalCellsB)
        ? { orderedCellLabelIds: finalCellsA }
        : null,
    }));
    if (!finalCellsA.every(Boolean) || !same(finalCellsA, finalCellsB)) {
      ambiguousItems.push(comparisonEntry({
        issueId: `ambiguous-candidate-cells-${matchKey}`, kind: 'row', matchKey,
        reviewerA: { row: a, cells: membershipA },
        reviewerB: { row: b, cells: membershipB },
        candidateResolution: { reason: 'one or more agreed row cells lack resolved candidate geometry' },
      }));
      continue;
    }
    candidateRows.push({
      rowKey: `r-${String(order + 1).padStart(4, '0')}`,
      orderedCellLabelIds: finalCellsA as string[],
    });
  }

  let candidateCoverage: BenchmarkPageLabels['coverage']['truth'] = null;
  if (reviewerA.labels.coverageProposal === reviewerB.labels.coverageProposal) {
    candidateCoverage = reviewerA.labels.coverageProposal;
    exactAgreements.push(comparisonEntry({
      issueId: 'agreement-coverage', kind: 'coverage', matchKey: 'coverage',
      reviewerA: { value: reviewerA.labels.coverageProposal, note: reviewerA.labels.coverageNote },
      reviewerB: { value: reviewerB.labels.coverageProposal, note: reviewerB.labels.coverageNote },
      candidateResolution: { value: candidateCoverage },
    }));
  } else {
    coverageDisagreements.push(comparisonEntry({
      issueId: 'coverage-disagreement', kind: 'coverage', matchKey: 'coverage',
      reviewerA: { value: reviewerA.labels.coverageProposal, note: reviewerA.labels.coverageNote },
      reviewerB: { value: reviewerB.labels.coverageProposal, note: reviewerB.labels.coverageNote },
    }));
  }

  const issues = [
    ...textDisagreements,
    ...bboxDisagreements,
    ...cellStructureDisagreements,
    ...rowMembershipDisagreements,
    ...coverageDisagreements,
    ...ambiguousItems,
    ...unmatchedReviewerA,
    ...unmatchedReviewerB,
  ];
  return BenchmarkDualReviewComparisonSchema.parse({
    comparisonVersion: BENCHMARK_COMPARISON_VERSION,
    authority: BENCHMARK_COMPARISON_AUTHORITY,
    matchingRules: {
      version: 'exact_reading_order_and_unique_exact_ocr_v1',
      fuzzyMatching: false,
      reviewerAgreementIsAuthority: false,
    },
    pageKey: input.source.pageKey,
    source: {
      documentKey: input.source.documentKey,
      sha256: input.source.sha256,
      byteLength: input.source.byteLength,
      physicalPageNumber: input.source.physicalPageNumber,
    },
    frame: input.source.frame,
    reviewerA: { identity: reviewerA.labels.reviewerIdentity, sha256: reviewerA.sha256 },
    reviewerB: { identity: reviewerB.labels.reviewerIdentity, sha256: reviewerB.sha256 },
    suggestionsSha256: suggestions?.suggestionsSha256 ?? null,
    exactAgreements,
    textDisagreements,
    bboxDisagreements,
    cellStructureDisagreements,
    rowMembershipDisagreements,
    coverageDisagreements,
    ambiguousItems,
    unmatchedReviewerA,
    unmatchedReviewerB,
    candidateFinalLabels: {
      words: candidateWords,
      cells: candidateCells,
      rows: candidateRows,
      coverage: candidateCoverage,
    },
    requiredAdjudicationIssueIds: issues.map((issue) => issue.issueId),
    userAdjudicationRequired: true,
    userApprovalRequired: true,
  });
}

function comparisonIssues(
  comparison: BenchmarkDualReviewComparison,
): readonly z.infer<typeof ComparisonEntrySchema>[] {
  return [
    ...comparison.textDisagreements,
    ...comparison.bboxDisagreements,
    ...comparison.cellStructureDisagreements,
    ...comparison.rowMembershipDisagreements,
    ...comparison.coverageDisagreements,
    ...comparison.ambiguousItems,
    ...comparison.unmatchedReviewerA,
    ...comparison.unmatchedReviewerB,
  ];
}

export function canChallengeAgreement(
  agreement: BenchmarkDualReviewComparison['exactAgreements'][number],
  comparison: BenchmarkDualReviewComparison,
): boolean {
  const requiredIssueIds = new Set(comparison.requiredAdjudicationIssueIds);
  return !comparisonIssues(comparison).some((issue) => (
    requiredIssueIds.has(issue.issueId) && issue.matchKey === agreement.matchKey
  ));
}

function finalId(kind: 'word' | 'cell' | 'row', matchKey: string): string {
  const match = new RegExp(`^${kind}:(\\d+)$`).exec(matchKey);
  if (!match) {
    throw new BenchmarkDualReviewError('finalization_failed',
      `${matchKey}: invalid ${kind} match key`);
  }
  const prefix = kind === 'word' ? 'w' : kind === 'cell' ? 'c' : 'r';
  return `${prefix}-${String(Number(match[1]) + 1).padStart(4, '0')}`;
}

function chosenReviewerValue(
  issue: z.infer<typeof ComparisonEntrySchema>,
  decision: BenchmarkAdjudicationResolution['decision'],
): Record<string, unknown> {
  const selected = decision === 'choose_reviewer_a'
    ? issue.reviewerA
    : decision === 'choose_reviewer_b'
      ? issue.reviewerB
      : null;
  if (!selected) {
    throw new BenchmarkDualReviewError('finalization_failed',
      `${issue.issueId}: ${decision} selected a reviewer with no value`);
  }
  return selected;
}

function chosenRowCellIds(
  issue: z.infer<typeof ComparisonEntrySchema>,
  selected: Record<string, unknown>,
  availableCells: ReadonlyMap<string, BenchmarkPageLabels['cells']['items'][number]>,
): string[] {
  const row = ReviewerRowSchema.safeParse(selected.row ?? selected);
  const cells = z.array(ReviewerRowMembershipCellSchema).safeParse(selected.cells);
  if (!row.success || !cells.success) {
    throw new BenchmarkDualReviewError('finalization_failed',
      `${issue.issueId}: chosen reviewer row is not structurally valid`);
  }
  const byId = new Map(cells.data.map((cell) => [cell.reviewerItemId, cell]));
  return row.data.orderedCellReviewerItemIds.map((reviewerItemId) => {
    const cell = byId.get(reviewerItemId);
    if (!cell) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${issue.issueId}: chosen row cites unavailable reviewer cell ${reviewerItemId}`);
    }
    const labelId = `c-${String(cell.readingOrder + 1).padStart(4, '0')}`;
    const finalCell = availableCells.get(labelId);
    if (!finalCell) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${issue.issueId}: chosen row cites unresolved final cell ${labelId}`);
    }
    if (finalCell.text !== cell.text || finalCell.isHeader !== cell.isHeader
        || finalCell.columnName !== cell.columnName) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${issue.issueId}: chosen row cell ${reviewerItemId} does not exactly match final cell ${labelId}`);
    }
    return labelId;
  });
}

export function assembleResolvedBenchmarkLabels(input: Readonly<{
  comparison: BenchmarkDualReviewComparison;
  resolutions: readonly BenchmarkAdjudicationResolution[];
  userChallenges: readonly BenchmarkAgreementChallenge[];
  approvedBy: string;
  approvedAt: string;
}>): BenchmarkPageLabels {
  const issues = comparisonIssues(input.comparison);
  const issueById = new Map(issues.map((issue) => [issue.issueId, issue]));
  const resolutionById = new Map(input.resolutions.map((resolution) => [resolution.issueId, resolution]));
  const required = [...input.comparison.requiredAdjudicationIssueIds].sort();
  const resolved = [...resolutionById.keys()].sort();
  if (!same(required, resolved) || resolutionById.size !== input.resolutions.length) {
    throw new BenchmarkDualReviewError('finalization_failed',
      'not every comparison issue has exactly one resolution');
  }

  const agreementById = new Map(input.comparison.exactAgreements
    .map((agreement) => [agreement.issueId, agreement]));
  const challengedAgreementIds = new Set<string>();
  const validatedChallenges = input.userChallenges.map((challenge) => {
    if (challengedAgreementIds.has(challenge.targetAgreementId)) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${challenge.targetAgreementId}: duplicate agreement challenge`);
    }
    challengedAgreementIds.add(challenge.targetAgreementId);
    const agreement = agreementById.get(challenge.targetAgreementId);
    if (!agreement) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${challenge.targetAgreementId}: agreement challenge target does not exist`);
    }
    if (agreement.kind === 'coverage' || agreement.kind !== challenge.targetKind) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${challenge.targetAgreementId}: agreement challenge target kind differs`);
    }
    if (benchmarkAgreementDigest(agreement) !== challenge.targetAgreementSha256) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${challenge.targetAgreementId}: agreement challenge digest is stale`);
    }
    if (!canChallengeAgreement(agreement, input.comparison)) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${challenge.targetAgreementId}: item already has a required adjudication issue`);
    }
    return { challenge, agreement };
  }).sort((left, right) => left.challenge.targetAgreementId.localeCompare(
    right.challenge.targetAgreementId,
    'en-US',
  ));

  const words = new Map(input.comparison.candidateFinalLabels.words
    .map((item) => [item.labelId, item]));
  const cells = new Map(input.comparison.candidateFinalLabels.cells
    .map((item) => [item.labelId, item]));
  const rows = new Map(input.comparison.candidateFinalLabels.rows
    .map((item) => [item.rowKey, item]));
  let coverage = input.comparison.candidateFinalLabels.coverage;
  let coverageNote: string | null = null;

  const orderedResolutions = [...input.resolutions].sort((left, right) => {
    const leftKind = issueById.get(left.issueId)?.kind;
    const rightKind = issueById.get(right.issueId)?.kind;
    const order = { word: 0, cell: 1, row: 2, coverage: 3 } as const;
    return (leftKind ? order[leftKind] : 99) - (rightKind ? order[rightKind] : 99)
      || left.issueId.localeCompare(right.issueId, 'en-US');
  });

  const applyResolution = (resolution: BenchmarkAdjudicationResolution): void => {
    const issue = issueById.get(resolution.issueId);
    if (!issue) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${resolution.issueId}: resolution does not match a comparison issue`);
    }
    if (resolution.decision === 'exclude_item') {
      if (issue.kind === 'coverage') {
        throw new BenchmarkDualReviewError('finalization_failed',
          `${issue.issueId}: exclude_item is valid only for word, cell, or row issues`);
      }
      if (issue.kind === 'word') words.delete(finalId('word', issue.matchKey));
      if (issue.kind === 'cell') cells.delete(finalId('cell', issue.matchKey));
      if (issue.kind === 'row') rows.delete(finalId('row', issue.matchKey));
      return;
    }
    if (resolution.decision === 'manual_resolution') {
      if (!resolution.manualValue || resolution.manualValue.kind !== issue.kind) {
        throw new BenchmarkDualReviewError('finalization_failed',
          `${issue.issueId}: manual resolution kind differs from issue kind`);
      }
      if (resolution.manualValue.kind === 'word') {
        const labelId = finalId('word', issue.matchKey);
        words.set(labelId, {
          labelId,
          text: resolution.manualValue.text,
          box: resolution.manualValue.box,
        });
      } else if (resolution.manualValue.kind === 'cell') {
        const labelId = finalId('cell', issue.matchKey);
        cells.set(labelId, {
          labelId,
          text: resolution.manualValue.text,
          box: resolution.manualValue.box,
          isHeader: resolution.manualValue.isHeader,
          columnName: resolution.manualValue.columnName,
        });
      } else if (resolution.manualValue.kind === 'row') {
        const rowKey = finalId('row', issue.matchKey);
        rows.set(rowKey, {
          rowKey,
          orderedCellLabelIds: [...resolution.manualValue.orderedCellLabelIds],
        });
      } else {
        coverage = resolution.manualValue.truth;
        coverageNote = resolution.manualValue.note;
      }
      return;
    }

    const selected = chosenReviewerValue(issue, resolution.decision);
    if (issue.kind === 'word') {
      const parsed = ReviewerWordSchema.safeParse(selected);
      if (!parsed.success || !parsed.data.box) {
        throw new BenchmarkDualReviewError('finalization_failed',
          `${issue.issueId}: chosen reviewer word has no valid final geometry; manual resolution required`);
      }
      const labelId = finalId('word', issue.matchKey);
      words.set(labelId, { labelId, text: parsed.data.text, box: parsed.data.box });
    } else if (issue.kind === 'cell') {
      const parsed = ReviewerCellSchema.safeParse(selected);
      if (!parsed.success || !parsed.data.box) {
        throw new BenchmarkDualReviewError('finalization_failed',
          `${issue.issueId}: chosen reviewer cell has no valid final geometry; manual resolution required`);
      }
      const labelId = finalId('cell', issue.matchKey);
      cells.set(labelId, {
        labelId,
        text: parsed.data.text,
        box: parsed.data.box,
        isHeader: parsed.data.isHeader,
        columnName: parsed.data.columnName,
      });
    } else if (issue.kind === 'coverage') {
      const parsed = z.object({
        value: z.enum(BENCHMARK_COVERAGE_TRUTHS),
        note: z.string().max(2_000).nullable(),
      }).strict().safeParse(selected);
      if (!parsed.success) {
        throw new BenchmarkDualReviewError('finalization_failed',
          `${issue.issueId}: chosen reviewer coverage is invalid`);
      }
      coverage = parsed.data.value;
      coverageNote = parsed.data.note;
    } else {
      const rowKey = finalId('row', issue.matchKey);
      rows.set(rowKey, {
        rowKey,
        orderedCellLabelIds: chosenRowCellIds(issue, selected, cells),
      });
    }
  };

  const applyChallenge = (
    challenge: BenchmarkAgreementChallenge,
    agreement: BenchmarkDualReviewComparison['exactAgreements'][number],
  ): void => {
    const itemId = finalId(challenge.targetKind, agreement.matchKey);
    if (challenge.action === 'exclude') {
      if (challenge.replacement !== null) {
        throw new BenchmarkDualReviewError('finalization_failed',
          `${challenge.targetAgreementId}: exclude challenge must not carry replacement`);
      }
      if (challenge.targetKind === 'word') words.delete(itemId);
      if (challenge.targetKind === 'cell') cells.delete(itemId);
      if (challenge.targetKind === 'row') rows.delete(itemId);
      return;
    }
    if (!challenge.replacement || challenge.replacement.kind !== challenge.targetKind) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${challenge.targetAgreementId}: challenge replacement kind differs from target kind`);
    }
    if (challenge.replacement.kind === 'word') {
      words.set(itemId, {
        labelId: itemId,
        text: challenge.replacement.text,
        box: challenge.replacement.box,
      });
    } else if (challenge.replacement.kind === 'cell') {
      cells.set(itemId, {
        labelId: itemId,
        text: challenge.replacement.text,
        box: challenge.replacement.box,
        isHeader: challenge.replacement.isHeader,
        columnName: challenge.replacement.columnName,
      });
    } else {
      rows.set(itemId, {
        rowKey: itemId,
        orderedCellLabelIds: [...challenge.replacement.orderedCellLabelIds],
      });
    }
  };

  const resolutionKind = (resolution: BenchmarkAdjudicationResolution) => (
    issueById.get(resolution.issueId)!.kind
  );
  for (const resolution of orderedResolutions.filter((item) => (
    resolutionKind(item) === 'word' || resolutionKind(item) === 'cell'
  ))) {
    applyResolution(resolution);
  }
  for (const { challenge, agreement } of validatedChallenges.filter(({ challenge }) => (
    challenge.targetKind === 'word' || challenge.targetKind === 'cell'
  ))) {
    applyChallenge(challenge, agreement);
  }
  for (const resolution of orderedResolutions.filter((item) => resolutionKind(item) === 'row')) {
    applyResolution(resolution);
  }
  for (const { challenge, agreement } of validatedChallenges.filter(({ challenge }) => (
    challenge.targetKind === 'row'
  ))) {
    applyChallenge(challenge, agreement);
  }
  for (const resolution of orderedResolutions.filter((item) => (
    resolutionKind(item) === 'coverage'
  ))) {
    applyResolution(resolution);
  }

  if (!coverage) {
    throw new BenchmarkDualReviewError('finalization_failed', 'coverage remains unresolved');
  }
  const challengedRowAgreements = new Set(validatedChallenges
    .filter(({ challenge }) => challenge.targetKind === 'row')
    .map(({ challenge }) => challenge.targetAgreementId));
  for (const agreement of input.comparison.exactAgreements) {
    if (agreement.kind !== 'row' || agreement.candidateResolution === null
        || challengedRowAgreements.has(agreement.issueId)) {
      continue;
    }
    const rowKey = finalId('row', agreement.matchKey);
    const row = rows.get(rowKey);
    if (!row || !agreement.reviewerA) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${agreement.issueId}: agreed candidate row is missing from final assembly`);
    }
    const expectedCellIds = chosenRowCellIds(agreement, agreement.reviewerA, cells);
    if (!same(row.orderedCellLabelIds, expectedCellIds)) {
      throw new BenchmarkDualReviewError('finalization_failed',
        `${agreement.issueId}: agreed row membership differs from final cell semantics`);
    }
  }
  for (const row of rows.values()) {
    for (const cellId of row.orderedCellLabelIds) {
      if (!cells.has(cellId)) {
        throw new BenchmarkDualReviewError('finalization_failed',
          `${row.rowKey}: retained row cites excluded or unresolved cell ${cellId}`);
      }
    }
  }
  const labels = BenchmarkPageLabelsSchema.parse({
    labelSetVersion: 'extraction-benchmark-labels-v1',
    authority: 'human_evaluation_ground_truth_only',
    pageKey: input.comparison.pageKey,
    source: input.comparison.source,
    frame: input.comparison.frame,
    words: { status: 'labeled', items: [...words.values()].sort((a, b) => a.labelId.localeCompare(b.labelId)) },
    cells: { status: 'labeled', items: [...cells.values()].sort((a, b) => a.labelId.localeCompare(b.labelId)) },
    rows: { status: 'labeled', items: [...rows.values()].sort((a, b) => a.rowKey.localeCompare(b.rowKey)) },
    coverage: { status: 'labeled', truth: coverage, note: coverageNote },
    labeledBy: input.approvedBy.trim(),
    labeledAt: input.approvedAt,
  });
  return labels;
}

function normalizedIdentity(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function finalizeBenchmarkAdjudication(input: Readonly<{
  reviewerA: ParsedBenchmarkReviewerLabels;
  reviewerB: ParsedBenchmarkReviewerLabels;
  comparison: ParsedBenchmarkComparison;
  adjudication: BenchmarkAdjudication;
  source: BenchmarkDualReviewBindingSource;
  suggestions?: ParsedSuggestions | null;
}>): BenchmarkPageLabels {
  const recomputed = compareBenchmarkReviewerLabels({
    reviewerA: input.reviewerA,
    reviewerB: input.reviewerB,
    source: input.source,
    suggestions: input.suggestions,
  });
  const recomputedDigest = hashCanonical(recomputed);
  const problems: string[] = [];
  if (input.comparison.sha256 !== recomputedDigest
      || !same(input.comparison.comparison, recomputed)) {
    problems.push('supplied comparison differs from deterministic recomputation');
  }
  if (input.adjudication.comparisonSha256 !== recomputedDigest) {
    problems.push('adjudication comparison digest differs from deterministic recomputation');
  }
  if (input.adjudication.reviewerALabelSetSha256 !== input.reviewerA.sha256) {
    problems.push('adjudication reviewer A digest differs');
  }
  if (input.adjudication.reviewerBLabelSetSha256 !== input.reviewerB.sha256) {
    problems.push('adjudication reviewer B digest differs');
  }
  if (input.adjudication.pageKey !== recomputed.pageKey
      || !same(input.adjudication.source, recomputed.source)
      || !same(input.adjudication.frame, recomputed.frame)) {
    problems.push('adjudication source or frame differs');
  }
  if (recomputed.suggestionsSha256 === null) {
    if (input.suggestions || input.adjudication.suggestionsSha256 !== null) {
      problems.push('unexpected suggestions binding');
    }
  } else {
    if (!input.suggestions) {
      problems.push('bound suggestions artifact is required');
    } else {
      if (input.suggestions.suggestionsSha256 !== recomputed.suggestionsSha256
          || input.adjudication.suggestionsSha256 !== recomputed.suggestionsSha256) {
        problems.push('suggestions digest differs');
      }
    }
  }
  if (!input.adjudication.approval) {
    problems.push('explicit user approval is absent');
  } else {
    const approver = normalizedIdentity(input.adjudication.approval.approvedBy);
    if (approver === normalizedIdentity(input.reviewerA.labels.reviewerIdentity)
        || approver === normalizedIdentity(input.reviewerB.labels.reviewerIdentity)) {
      problems.push('approving user must not be either reviewer');
    }
  }
  if (problems.length > 0) {
    throw new BenchmarkDualReviewError('finalization_failed', problems.join('; '));
  }
  const approval = input.adjudication.approval!;
  const labels = assembleResolvedBenchmarkLabels({
    comparison: recomputed,
    resolutions: input.adjudication.resolutions,
    userChallenges: input.adjudication.userChallenges,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
  });
  const candidateDigest = benchmarkLabelsDigest(labels);
  if (approval.approvedCandidateSha256 !== candidateDigest) {
    throw new BenchmarkDualReviewError('finalization_failed',
      'approved candidate digest differs from deterministic final assembly');
  }
  return labels;
}
