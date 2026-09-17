import { z } from 'zod';

import { hashCanonical } from '@/lib/extraction/domain/hash';

/**
 * E3 extraction benchmark contract.
 *
 * Measurement vocabulary only. Nothing here is extraction authority, nothing
 * here decides production eligibility, and nothing here may be read by
 * production extraction or recovery.
 *
 * The central rule is that **no label is ever generated**. This module builds
 * an empty workspace bound to exact source bytes and validates what a human
 * later writes into it. Every human-truth field starts null or empty, a
 * section stays `unlabeled` until a person marks it otherwise, and scoring
 * refuses to run against unlabeled sections rather than scoring against a
 * machine's own output.
 */

export const BENCHMARK_LABELS_VERSION = 'extraction-benchmark-labels-v1' as const;
export const BENCHMARK_WORKSPACE_VERSION = 'extraction-benchmark-workspace-v1' as const;
export const BENCHMARK_SCORING_VERSION = 'extraction-benchmark-scoring-v1' as const;
/** Labels are human ground truth for evaluation only. */
export const BENCHMARK_LABEL_AUTHORITY = 'human_evaluation_ground_truth_only' as const;
/** Every benchmark result is measurement; it never authorizes a production change. */
export const BENCHMARK_RESULT_AUTHORITY = 'non_authoritative_measurement' as const;

/**
 * The three benchmark pages frozen for Evidence V2.
 *
 * Source identity (sha256 + byte length) is pinned here and re-verified on
 * every read, so labels can never drift onto different bytes. Paths are never
 * committed: each source is located through the env var the repository already
 * uses for it.
 */
export const BENCHMARK_PAGES = [
  {
    pageKey: 'golden-p8',
    documentKey: 'golden',
    /** Mixed native/OCR page: the case E2's corrected canonical overlap can move. */
    characterization: 'mixed_native_and_ocr',
    sha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f',
    physicalPageNumber: 8,
    sourceEnvVar: 'GOLDEN_CORPUS_ROOT',
    sourceRelativePath:
      'Williamson Co TN Fern 0126_Williamson Co TN Aftermath Fern 0126_Contract and Price Sheet_1.pdf',
  },
  {
    pageKey: 'hillsdale-p3',
    documentKey: 'hillsdale',
    characterization: 'ocr_price_sheet',
    sha256: '596adaccf865625723dc832f5206a8f690eb17d96921ef185df35b113c767537',
    physicalPageNumber: 3,
    sourceEnvVar: 'MIXED_MODE_HILLSDALE_PRICE_SHEET_PDF',
    sourceRelativePath: null,
  },
  {
    pageKey: 'dn-p107',
    documentKey: 'dn',
    characterization: 'dense_native_priced_schedule',
    sha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
    physicalPageNumber: 107,
    sourceEnvVar: 'DN_PRICED_SCHEDULE_SOURCE_PDF',
    sourceRelativePath: null,
  },
] as const;

export type BenchmarkPageKey = (typeof BENCHMARK_PAGES)[number]['pageKey'];

export function benchmarkPage(pageKey: string) {
  return BENCHMARK_PAGES.find((page) => page.pageKey === pageKey) ?? null;
}

const identifier = z.string().min(1).max(200).refine((value) => value.trim() === value,
  'identifier whitespace');
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Boxes are canonical_v1 only: one frame, stated explicitly, never inferred. */
export const BenchmarkBoxSchema = z.object({
  coordinate_space: z.literal('canonical_v1'),
  x_min: z.number().finite(),
  y_min: z.number().finite(),
  x_max: z.number().finite(),
  y_max: z.number().finite(),
}).strict().refine((box) => box.x_min < box.x_max && box.y_min < box.y_max,
  'box must have positive area');

export const BenchmarkWordLabelSchema = z.object({
  labelId: identifier,
  text: z.string().min(1).max(500),
  box: BenchmarkBoxSchema,
}).strict();

export const BenchmarkCellLabelSchema = z.object({
  labelId: identifier,
  /** Exactly what a reader sees in the cell. */
  text: z.string().max(2_000),
  box: BenchmarkBoxSchema,
  /** A header cell names a column; a body cell carries a value. */
  isHeader: z.boolean(),
  /** Free-form column name as authored on the page, or null when unnamed. */
  columnName: z.string().max(200).nullable(),
}).strict();

export const BenchmarkRowLabelSchema = z.object({
  rowKey: identifier,
  /** Membership: the cells that belong to this row, in reading order. */
  orderedCellLabelIds: z.array(identifier).min(1).max(200),
}).strict();

/**
 * What the page actually contains, as a human reads it. This is the truth the
 * coverage layer's `final_state` is measured against; it is never copied from
 * that layer.
 */
export const BENCHMARK_COVERAGE_TRUTHS = [
  'native_text_complete',
  'requires_ocr',
  'mixed_native_and_ocr',
  'empty_page',
] as const;

/**
 * A labeled section must carry items; an unlabeled one must be empty. That
 * makes "nobody has labeled this yet" impossible to confuse with "a human
 * examined it and found nothing".
 */
function section<T extends z.ZodTypeAny>(item: T, itemsName: string) {
  return z.object({
    status: z.enum(['unlabeled', 'labeled']),
    items: z.array(item).max(5_000),
  }).strict().superRefine((value, ctx) => {
    if (value.status === 'unlabeled' && value.items.length > 0) {
      ctx.addIssue({ code: 'custom', message: `unlabeled ${itemsName} section must be empty` });
    }
    if (value.status === 'labeled' && value.items.length === 0) {
      ctx.addIssue({ code: 'custom', message: `labeled ${itemsName} section must not be empty` });
    }
  });
}

export const BenchmarkPageLabelsSchema = z.object({
  labelSetVersion: z.literal(BENCHMARK_LABELS_VERSION),
  authority: z.literal(BENCHMARK_LABEL_AUTHORITY),
  pageKey: identifier,
  source: z.object({
    documentKey: identifier,
    sha256: digest,
    byteLength: z.number().int().positive(),
    physicalPageNumber: z.number().int().positive(),
  }).strict(),
  /**
   * The canonical frame the boxes are expressed in. Machine-measured page
   * geometry, not human truth: it is the coordinate system of the labels, and
   * binding fails if the source's frame ever differs from it.
   */
  frame: z.object({
    frame_version: z.literal('canonical_frame_v1'),
    coordinate_space: z.literal('canonical_v1'),
    view: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    user_unit: z.number().positive(),
    width: z.number().positive(),
    height: z.number().positive(),
  }).strict(),
  words: section(BenchmarkWordLabelSchema, 'word'),
  cells: section(BenchmarkCellLabelSchema, 'cell'),
  rows: section(BenchmarkRowLabelSchema, 'row'),
  coverage: z.object({
    status: z.enum(['unlabeled', 'labeled']),
    truth: z.enum(BENCHMARK_COVERAGE_TRUTHS).nullable(),
    note: z.string().max(2_000).nullable(),
  }).strict().superRefine((value, ctx) => {
    if (value.status === 'unlabeled' && value.truth !== null) {
      ctx.addIssue({ code: 'custom', message: 'unlabeled coverage must have no truth' });
    }
    if (value.status === 'labeled' && value.truth === null) {
      ctx.addIssue({ code: 'custom', message: 'labeled coverage must state a truth' });
    }
  }),
  /** Who labeled it and when; free-form, filled in by the human. */
  labeledBy: z.string().max(200).nullable(),
  labeledAt: z.string().max(40).nullable(),
}).strict().superRefine((labels, ctx) => {
  const wordIds = labels.words.items.map((item) => item.labelId);
  if (new Set(wordIds).size !== wordIds.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate word label id' });
  }
  const cellIds = labels.cells.items.map((item) => item.labelId);
  if (new Set(cellIds).size !== cellIds.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate cell label id' });
  }
  const rowKeys = labels.rows.items.map((item) => item.rowKey);
  if (new Set(rowKeys).size !== rowKeys.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate row key' });
  }
  // Row membership is only meaningful against cells that exist, and a cell may
  // belong to at most one row.
  const cellIdSet = new Set(cellIds);
  const claimed = new Set<string>();
  for (const row of labels.rows.items) {
    for (const cellId of row.orderedCellLabelIds) {
      if (!cellIdSet.has(cellId)) {
        ctx.addIssue({ code: 'custom', message: `row ${row.rowKey} cites unknown cell ${cellId}` });
      }
      if (claimed.has(cellId)) {
        ctx.addIssue({ code: 'custom', message: `cell ${cellId} belongs to more than one row` });
      }
      claimed.add(cellId);
    }
  }
  if (labels.rows.status === 'labeled' && labels.cells.status !== 'labeled') {
    ctx.addIssue({ code: 'custom', message: 'row membership requires labeled cells' });
  }
});

export type BenchmarkPageLabels = z.infer<typeof BenchmarkPageLabelsSchema>;
export type BenchmarkBox = z.infer<typeof BenchmarkBoxSchema>;
export type BenchmarkWordLabel = z.infer<typeof BenchmarkWordLabelSchema>;
export type BenchmarkCellLabel = z.infer<typeof BenchmarkCellLabelSchema>;
export type BenchmarkRowLabel = z.infer<typeof BenchmarkRowLabelSchema>;

export type BenchmarkLabelSection = 'words' | 'cells' | 'rows' | 'coverage';

/** Content digest of the human labels; end-of-line translation must not change it. */
export function benchmarkLabelsDigest(labels: BenchmarkPageLabels): string {
  return hashCanonical(labels);
}

/**
 * An empty workspace template for one page.
 *
 * Every human-truth field is empty by construction: no word, no cell, no row,
 * no coverage truth. The only machine-supplied values are source identity and
 * the page's canonical frame, which are measurements of the bytes, not claims
 * about their content.
 */
export function buildBenchmarkLabelTemplate(input: Readonly<{
  pageKey: BenchmarkPageKey;
  documentKey: string;
  sha256: string;
  byteLength: number;
  physicalPageNumber: number;
  frame: BenchmarkPageLabels['frame'];
}>): BenchmarkPageLabels {
  return BenchmarkPageLabelsSchema.parse({
    labelSetVersion: BENCHMARK_LABELS_VERSION,
    authority: BENCHMARK_LABEL_AUTHORITY,
    pageKey: input.pageKey,
    source: {
      documentKey: input.documentKey,
      sha256: input.sha256,
      byteLength: input.byteLength,
      physicalPageNumber: input.physicalPageNumber,
    },
    frame: input.frame,
    words: { status: 'unlabeled', items: [] },
    cells: { status: 'unlabeled', items: [] },
    rows: { status: 'unlabeled', items: [] },
    coverage: { status: 'unlabeled', truth: null, note: null },
    labeledBy: null,
    labeledAt: null,
  });
}

export class BenchmarkLabelError extends Error {
  constructor(
    readonly code: 'label_schema_invalid' | 'label_binding_failed',
    detail: string,
  ) {
    super(`BENCHMARK_${code.toUpperCase()}: ${detail}`);
    this.name = 'BenchmarkLabelError';
  }
}

export function parseBenchmarkLabels(bytes: Uint8Array | string): Readonly<{
  labels: BenchmarkPageLabels;
  labelsSha256: string;
}> {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BenchmarkLabelError('label_schema_invalid', 'label artifact is not JSON');
  }
  const parsed = BenchmarkPageLabelsSchema.safeParse(json);
  if (!parsed.success) {
    throw new BenchmarkLabelError('label_schema_invalid',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  return { labels: parsed.data, labelsSha256: benchmarkLabelsDigest(parsed.data) };
}

export type BenchmarkLabelBinding = Readonly<{
  labels: BenchmarkPageLabels;
  labelsSha256: string;
  /** Sections a human has completed. Scoring may only use these. */
  labeledSections: readonly BenchmarkLabelSection[];
  unlabeledSections: readonly BenchmarkLabelSection[];
  state: 'complete' | 'partial' | 'unlabeled';
}>;

/**
 * Binds labels to the exact source bytes, page and canonical frame they were
 * authored against. Any difference fails closed: labels that describe other
 * bytes, another page, or another coordinate frame are not ground truth for
 * this run.
 */
export function bindBenchmarkLabels(
  parsed: Readonly<{ labels: BenchmarkPageLabels; labelsSha256: string }>,
  source: Readonly<{
    pageKey: string;
    sha256: string;
    byteLength: number;
    physicalPageNumber: number;
    frame: BenchmarkPageLabels['frame'];
  }>,
): BenchmarkLabelBinding {
  const { labels } = parsed;
  const problems: string[] = [];
  if (labels.pageKey !== source.pageKey) problems.push('page key differs');
  if (labels.source.sha256 !== source.sha256) problems.push('source sha256 differs');
  if (labels.source.byteLength !== source.byteLength) problems.push('source byte length differs');
  if (labels.source.physicalPageNumber !== source.physicalPageNumber) {
    problems.push('physical page number differs');
  }
  if (hashCanonical(labels.frame) !== hashCanonical(source.frame)) {
    problems.push('canonical page frame differs');
  }
  if (problems.length > 0) {
    throw new BenchmarkLabelError('label_binding_failed', problems.join('; '));
  }
  const sections: readonly BenchmarkLabelSection[] = ['words', 'cells', 'rows', 'coverage'];
  const labeledSections = sections.filter((name) => labels[name].status === 'labeled');
  const unlabeledSections = sections.filter((name) => labels[name].status !== 'labeled');
  return Object.freeze({
    labels,
    labelsSha256: parsed.labelsSha256,
    labeledSections: Object.freeze(labeledSections),
    unlabeledSections: Object.freeze(unlabeledSections),
    state: labeledSections.length === sections.length ? 'complete'
      : labeledSections.length === 0 ? 'unlabeled' : 'partial',
  });
}
