import { z } from 'zod';

import {
  BenchmarkBoxSchema,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import type { BenchmarkMachineRun } from '@/lib/evaluation/benchmark/benchmarkMachineRun';
import type { BenchmarkLocalOcrGeneration } from '@/lib/evaluation/benchmark/benchmarkSuggestionRun';
import { hashCanonical } from '@/lib/extraction/domain/hash';

/** Suggestions are a provisional aid. They are never benchmark truth. */
export const BENCHMARK_SUGGESTIONS_VERSION = 'extraction-benchmark-suggestions-v1' as const;
export const BENCHMARK_SUGGESTION_AUTHORITY = 'provisional_non_authoritative' as const;

const identifier = z.string().min(1).max(200).refine((value) => value.trim() === value,
  'identifier whitespace');
const digest = z.string().regex(/^[a-f0-9]{64}$/);

const SuggestionSourceSchema = z.object({
  documentKey: identifier,
  sha256: digest,
  byteLength: z.number().int().positive(),
  physicalPageNumber: z.number().int().positive(),
}).strict();

const SuggestionFrameSchema = z.object({
  frame_version: z.literal('canonical_frame_v1'),
  coordinate_space: z.literal('canonical_v1'),
  view: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  user_unit: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
}).strict();

export const BenchmarkWordSuggestionSchema = z.object({
  suggestionId: identifier,
  text: z.string().min(1).max(500),
  box: BenchmarkBoxSchema,
}).strict();

export const BenchmarkCellSuggestionSchema = z.object({
  suggestionId: identifier,
  text: z.string().max(2_000),
  box: BenchmarkBoxSchema,
  isHeader: z.boolean(),
  columnName: z.string().max(200).nullable(),
}).strict();

export const BenchmarkRowSuggestionSchema = z.object({
  suggestionId: identifier,
  orderedCellSuggestionIds: z.array(identifier).min(1).max(200),
}).strict();

export const BenchmarkPageSuggestionsSchema = z.object({
  suggestionSetVersion: z.literal(BENCHMARK_SUGGESTIONS_VERSION),
  authority: z.literal(BENCHMARK_SUGGESTION_AUTHORITY),
  pageKey: identifier,
  source: SuggestionSourceSchema,
  frame: SuggestionFrameSchema,
  sourceRun: z.object({
    kind: z.literal('benchmark_machine_pass'),
    predictionDigest: digest,
    nativeTokenCount: z.number().int().nonnegative(),
    ocrTokenCount: z.number().int().nonnegative(),
    tokensWithoutCanonicalGeometry: z.number().int().nonnegative(),
    localOcr: z.object({
      mode: z.literal('existing_local_ocr'),
      implementation: z.literal('documentExtraction.extractPdfPageTextViaOcr'),
      engine: z.literal('tesseract.js'),
      language: z.literal('eng'),
      pageSegmentationMode: z.literal('11'),
      renderScale: z.literal(2),
      outcome: z.union([z.literal('tokens_produced'), z.literal('completed_zero_tokens')]),
      representationKeys: z.array(z.string().min(1).max(500)).max(20),
    }).strict().optional(),
  }).strict(),
  words: z.array(BenchmarkWordSuggestionSchema).max(5_000),
  cells: z.array(BenchmarkCellSuggestionSchema).max(5_000),
  rows: z.array(BenchmarkRowSuggestionSchema).max(5_000),
}).strict().superRefine((suggestions, ctx) => {
  for (const [name, ids] of [
    ['word suggestion', suggestions.words.map((item) => item.suggestionId)],
    ['cell suggestion', suggestions.cells.map((item) => item.suggestionId)],
    ['row suggestion', suggestions.rows.map((item) => item.suggestionId)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: `duplicate ${name} id` });
    }
  }

  const cellIds = new Set(suggestions.cells.map((item) => item.suggestionId));
  const claimed = new Set<string>();
  for (const row of suggestions.rows) {
    for (const cellId of row.orderedCellSuggestionIds) {
      if (!cellIds.has(cellId)) {
        ctx.addIssue({
          code: 'custom',
          message: `row suggestion ${row.suggestionId} cites unknown cell suggestion ${cellId}`,
        });
      }
      if (claimed.has(cellId)) {
        ctx.addIssue({
          code: 'custom',
          message: `cell suggestion ${cellId} belongs to more than one row suggestion`,
        });
      }
      claimed.add(cellId);
    }
  }
});

export type BenchmarkPageSuggestions = z.infer<typeof BenchmarkPageSuggestionsSchema>;

export type BenchmarkSuggestionBindingSource = Readonly<{
  pageKey: string;
  documentKey: string;
  sha256: string;
  byteLength: number;
  physicalPageNumber: number;
  frame: BenchmarkPageLabels['frame'];
}>;

export class BenchmarkSuggestionError extends Error {
  constructor(
    readonly code: 'suggestion_schema_invalid' | 'suggestion_binding_failed'
      | 'suggestion_projection_failed',
    detail: string,
  ) {
    super(`BENCHMARK_${code.toUpperCase()}: ${detail}`);
    this.name = 'BenchmarkSuggestionError';
  }
}

export function parseBenchmarkSuggestions(bytes: Uint8Array | string): Readonly<{
  suggestions: BenchmarkPageSuggestions;
  suggestionsSha256: string;
}> {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BenchmarkSuggestionError('suggestion_schema_invalid',
      'suggestion artifact is not JSON');
  }
  const parsed = BenchmarkPageSuggestionsSchema.safeParse(json);
  if (!parsed.success) {
    throw new BenchmarkSuggestionError('suggestion_schema_invalid',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  return { suggestions: parsed.data, suggestionsSha256: hashCanonical(parsed.data) };
}

/** Refuses to show suggestions over any page other than the exact bound source and frame. */
export function bindBenchmarkSuggestions(
  parsed: Readonly<{ suggestions: BenchmarkPageSuggestions; suggestionsSha256: string }>,
  source: BenchmarkSuggestionBindingSource,
): Readonly<{ suggestions: BenchmarkPageSuggestions; suggestionsSha256: string }> {
  const { suggestions } = parsed;
  const problems: string[] = [];
  if (suggestions.pageKey !== source.pageKey) problems.push('page key differs');
  if (suggestions.source.documentKey !== source.documentKey) problems.push('document key differs');
  if (suggestions.source.sha256 !== source.sha256) problems.push('source sha256 differs');
  if (suggestions.source.byteLength !== source.byteLength) problems.push('source byte length differs');
  if (suggestions.source.physicalPageNumber !== source.physicalPageNumber) {
    problems.push('physical page number differs');
  }
  if (hashCanonical(suggestions.frame) !== hashCanonical(source.frame)) {
    problems.push('canonical page frame differs');
  }
  if (problems.length > 0) {
    throw new BenchmarkSuggestionError('suggestion_binding_failed', problems.join('; '));
  }
  return Object.freeze(parsed);
}

/**
 * Projects the current evaluation-only machine pass into a separately bound
 * suggestion artifact. Exact box identity links row members to cell
 * suggestions; ambiguous or missing links fail instead of being inferred.
 */
export function buildBenchmarkSuggestions(input: Readonly<{
  source: BenchmarkSuggestionBindingSource;
  run: BenchmarkMachineRun;
  localOcrGeneration?: BenchmarkLocalOcrGeneration | null;
}>): BenchmarkPageSuggestions {
  if (hashCanonical(input.run.prediction) !== input.run.predictionDigest) {
    throw new BenchmarkSuggestionError('suggestion_projection_failed',
      'machine prediction digest does not match its payload');
  }

  const words = input.run.prediction.words.map((word, index) => ({
    suggestionId: `sw${index + 1}`,
    text: word.text,
    box: word.box,
  }));
  const cells = input.run.prediction.cells.map((cell, index) => ({
    suggestionId: `sc${index + 1}`,
    text: cell.text,
    box: cell.box,
    isHeader: cell.isHeader,
    columnName: cell.columnName,
  }));

  const cellIdsByBox = new Map<string, string[]>();
  for (const cell of cells) {
    const key = hashCanonical(cell.box);
    cellIdsByBox.set(key, [...(cellIdsByBox.get(key) ?? []), cell.suggestionId]);
  }
  const claimed = new Set<string>();
  const rows = input.run.prediction.rows.map((row, rowIndex) => ({
    suggestionId: `sr${rowIndex + 1}`,
    orderedCellSuggestionIds: row.orderedCellBoxes.map((box) => {
      const matches = (cellIdsByBox.get(hashCanonical(box)) ?? [])
        .filter((cellId) => !claimed.has(cellId));
      if (matches.length !== 1) {
        throw new BenchmarkSuggestionError('suggestion_projection_failed',
          `row ${rowIndex + 1} cell has ${matches.length} exact cell suggestion matches`);
      }
      const cellId = matches[0]!;
      claimed.add(cellId);
      return cellId;
    }),
  }));

  return BenchmarkPageSuggestionsSchema.parse({
    suggestionSetVersion: BENCHMARK_SUGGESTIONS_VERSION,
    authority: BENCHMARK_SUGGESTION_AUTHORITY,
    pageKey: input.source.pageKey,
    source: {
      documentKey: input.source.documentKey,
      sha256: input.source.sha256,
      byteLength: input.source.byteLength,
      physicalPageNumber: input.source.physicalPageNumber,
    },
    frame: input.source.frame,
    sourceRun: {
      kind: 'benchmark_machine_pass',
      predictionDigest: input.run.predictionDigest,
      nativeTokenCount: input.run.nativeTokenCount,
      ocrTokenCount: input.run.ocrTokenCount,
      tokensWithoutCanonicalGeometry: input.run.tokensWithoutCanonicalGeometry,
      ...(input.localOcrGeneration ? { localOcr: input.localOcrGeneration } : {}),
    },
    words,
    cells,
    rows,
  });
}
