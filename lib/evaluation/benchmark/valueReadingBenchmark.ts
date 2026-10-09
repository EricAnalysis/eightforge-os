import type { BenchmarkPageLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import type { CanonicalBox } from '@/lib/extraction/geometry/canonicalPageFrame';
import { VALUE_READING_EXECUTION } from '@/lib/valueReadingContract';

/**
 * B4.6 value-reading qualification. Pure: targets from tracked label truth,
 * scoring, summary and the pre-registered activation decision. It never reads
 * a source file, renders, or calls a provider; the runner in
 * scripts/evaluation/b46 does that, through the production renderer, adapter
 * and parser.
 *
 * The question it answers: can visual reading read unresolved pricing cells
 * accurately enough, fast enough and cheaply enough to justify controlled
 * activation? A confident wrong value is far worse than an honest
 * "unreadable": abstention is allowed and preferred over guessing, and a single
 * misbound or invented value fails the run.
 */

export const VALUE_READING_BENCHMARK_VERSION = 'value-reading-benchmark-v1' as const;

/**
 * The controlled-activation bar, pre-registered before any provider call.
 * Changing a threshold after seeing results is a new benchmark version, not a
 * re-scoring.
 *
 * Hard bars disqualify. The three zero-tolerance safety bars (wrong
 * source-region bindings, unsupported numeric inventions, unsupported value inventions) apply
 * to the whole qualification corpus: one occurrence anywhere fails the run.
 * Everything else applies per evidence class. Coverage is the only soft bar:
 * a class that meets every hard bar but resolves fewer than 80% of its
 * readable targets qualifies with low coverage (at most a LIMITED PASS); its
 * coverage is never improved by lowering the trust bar.
 */
export const VALUE_READING_ACTIVATION_BAR = Object.freeze({
  /**
   * The benchmark version this bar was pinned for, before execution. B4.6
   * (2026-10-05) is recorded as FAIL in docs/runbooks/b46-value-reading-result.md;
   * B4.6.1 keeps every value below unchanged, and runs scored under another
   * version are refused.
   */
  benchmarkVersion: 'b4.6.1',
  /** Correct rates among non-abstained (value) readings. */
  minRatePrecision: 0.99,
  /**
   * Correctness is decided by the target region alone: a rate is correct only
   * if it is the target cell's value. A wrong confident rate is then
   * classified by the wider page evidence, for diagnosis only; both kinds fail.
   */
  /** A wrong confident rate that does exist elsewhere in the page evidence. Corpus-wide. */
  maxWrongSourceRegionBindings: 0,
  /** A wrong confident rate with no support anywhere in the page evidence. Corpus-wide. */
  maxUnsupportedNumericInventions: 0,
  /** A unit, category or other semantic value the target row, column or allowed context does not support. Corpus-wide. */
  maxUnsupportedValueInventions: 0,
  /** Soft: correct readings over genuinely readable targets. */
  minResolvedShareOfReadable: 0.8,
  /** Render plus provider: the operator's wait. Within the engine's 8 s timeout. */
  maxP50TotalLatencyMs: 3000,
  maxP95TotalLatencyMs: 8000,
  /** Spend over provider calls, and over correct readings. */
  maxUsdPerAttempt: 0.05,
  maxUsdPerCorrect: 0.1,
  /** Every crop must render to the same bytes, so a repeat ask is reused at $0. */
  minReuseRate: 1,
  /** Fewer rows than this cannot qualify a class. */
  minRowsPerClass: 20,
});

/**
 * Authority and safety are properties of the system, not of a reading. They are
 * proven by these suites on the qualification commit (full-vitest and the
 * Phase 1B Postgres regression), never by this measurement.
 */
export const VALUE_READING_AUTHORITY_INVARIANTS = Object.freeze([
  { invariant: 'Every reading remains AI_PROPOSED and non-authoritative until a human assertion cites it',
    provenBy: ['scripts/sql/verify-forgewing-value-reading.sql', 'lib/architecture/forgewingValueReadingBoundaries.test.ts'] },
  { invariant: 'Stale evidence is rejected: a reading whose page or binding moved is discarded, and a stale citation is refused',
    provenBy: ['lib/server/valueReadingEngine.test.ts', 'scripts/sql/verify-forgewing-value-reading.sql'] },
  { invariant: 'Rejected and deferred proposals can never be promoted, including under concurrency',
    provenBy: ['scripts/sql/verify-forgewing-value-reading.sql', 'scripts/verify-value-reading-disposition-concurrency.ts'] },
  { invariant: 'No Core, canonical or Validator path consumes an AI proposal directly',
    provenBy: ['lib/architecture/forgewingValueReadingBoundaries.test.ts', 'lib/architecture/importBoundaries.test.ts'] },
] as const);

/** Which labelled columns carry each field on each benchmark page. */
export const VALUE_READING_BENCHMARK_PAGES = [
  { pageKey: 'golden-p8', evidenceClass: 'ocr_price_sheet',
    columns: { description: 'Description', unit: 'Unit', rate: 'Rate', category: 'Category' } },
  { pageKey: 'hillsdale-p3', evidenceClass: 'ocr_price_sheet',
    columns: { description: 'Equipment Description', unit: 'Unit', rate: 'Unit Price', category: null } },
  { pageKey: 'dn-p107', evidenceClass: 'dense_scanned_ocr_priced_schedule',
    columns: { description: 'Description', unit: 'Units', rate: 'Unit Cost', category: null } },
] as const;

export type ValueReadingBenchmarkPage = (typeof VALUE_READING_BENCHMARK_PAGES)[number];
export type ValueReadingEvidenceClass = ValueReadingBenchmarkPage['evidenceClass'];

export type ValueReadingTruth = Readonly<{
  description: string;
  unit: string;
  rate: number;
  /** Null where the page has no category column. */
  category: string | null;
}>;

export type ValueReadingBenchmarkTarget = Readonly<{
  pageKey: ValueReadingBenchmarkPage['pageKey'];
  evidenceClass: ValueReadingEvidenceClass;
  rowKey: string;
  truth: ValueReadingTruth;
  /** The row's labelled cells: what the crop is drawn from. */
  boxes: readonly CanonicalBox[];
  /**
   * Every other amount in the page's source evidence (each labelled cell and
   * word except the target rate cell). Diagnostic only: a wrong rate equal to
   * one of these is a wrong source-region binding, any other wrong rate an
   * unsupported numeric invention. Neither is ever accepted: only the target
   * cell's value is correct.
   */
  pageOtherValues: readonly PageValue[];
  /**
   * Categories the target evidence supports, in comparison form: the row's own
   * category cell, and the explicitly allowed structural context of the
   * nearest preceding section heading. A unit is supported only by the row's own
   * unit cell.
   */
  supportedCategories: readonly string[];
}>;

/** An amount printed in the page evidence, where it is, and whether the target crop shows it. */
export type PageValue = Readonly<{
  amount: number;
  source: 'cell' | 'word';
  labelId: string;
  rowKey: string | null;
  columnName: string | null;
  /** Inside the padded crop the model was shown. Diagnostic only. */
  inCrop: boolean;
}>;

/** "$ 1,250.50" -> 1250.5. Anything that is not plainly one amount is null. */
export function parseLabelRate(text: string): number | null {
  const compact = text.normalize('NFKC').replace(/[\s$,]/g, '');
  return /^\d+(?:\.\d+)?$/.test(compact) ? Number(compact) : null;
}

/** Comparison form only: case, spacing, dash and quote variants are not reading errors. */
export function normalizeReadingText(text: string): string {
  return text.normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Every labelled priced row on the page, with the reason any row is not a target.
 *
 * By default each target's crop is its labelled row (B4.6). `cropBoxes` may
 * name, per row, the region production would crop instead (B4.6.1: the case's
 * own reading region); truth is still the labelled row, and which page values
 * the crop shows is computed from the region actually drawn.
 */
export function valueReadingBenchmarkTargets(labels: BenchmarkPageLabels, page: ValueReadingBenchmarkPage, options: Readonly<{
  cropBoxes?: (rowKey: string) => readonly CanonicalBox[] | undefined;
}> = {}): Readonly<{
  targets: readonly ValueReadingBenchmarkTarget[];
  skipped: readonly Readonly<{ rowKey: string; reason: string }>[];
}> {
  if (labels.pageKey !== page.pageKey) throw new Error(`labels are for ${labels.pageKey}, not ${page.pageKey}`);
  if (labels.cells.status !== 'labeled' || labels.rows.status !== 'labeled') {
    throw new Error(`${page.pageKey}: cells and rows must be labelled`);
  }
  const cells = new Map((labels.cells.items ?? []).map((cell) => [cell.labelId, cell]));
  const rowOfCell = new Map((labels.rows.items ?? []).flatMap((row) => row.orderedCellLabelIds.map((id) => [id, row.rowKey] as const)));
  const cellAmounts = (labels.cells.items ?? []).flatMap((cell) => {
    const amount = parseLabelRate(cell.text);
    return amount === null ? [] : [{ cell, amount }];
  });
  // Numbers outside the table (totals, notes, page furniture) are page evidence too.
  const wordAmounts = (labels.words.status === 'labeled' ? labels.words.items ?? [] : []).flatMap((word) => {
    const amount = parseLabelRate(word.text);
    return amount === null ? [] : [{ word, amount }];
  });
  // A section heading: a body row whose every cell is unnamed (DN "ROADWAY ITEMS").
  let sectionHeading: string | null = null;
  let sectionHeadingBoxes: readonly Readonly<{ x_min: number; x_max: number; y_min: number; y_max: number }>[] = [];
  const targets: ValueReadingBenchmarkTarget[] = [];
  const skipped: { rowKey: string; reason: string }[] = [];
  for (const row of labels.rows.items ?? []) {
    const rowCells = row.orderedCellLabelIds.map((id) => cells.get(id));
    if (rowCells.some((cell) => !cell)) {
      skipped.push({ rowKey: row.rowKey, reason: 'row references an unknown cell' });
      continue;
    }
    const present = rowCells as NonNullable<(typeof rowCells)[number]>[];
    if (!present.some((cell) => cell.isHeader) && present.every((cell) => cell.columnName === null)) {
      sectionHeading = present.map((cell) => cell.text).join(' ');
      sectionHeadingBoxes = present.map((cell) => cell.box);
      skipped.push({ rowKey: row.rowKey, reason: 'section heading' });
      continue;
    }
    if (present.some((cell) => cell.isHeader)) {
      skipped.push({ rowKey: row.rowKey, reason: 'header row' });
      continue;
    }
    const column = (name: string | null) => {
      if (name === null) return { ok: true as const, text: null };
      const matches = present.filter((cell) => cell.columnName === name);
      return matches.length === 1 ? { ok: true as const, text: matches[0]!.text } : { ok: false as const, text: null };
    };
    const description = column(page.columns.description);
    const unit = column(page.columns.unit);
    const rate = column(page.columns.rate);
    const category = column(page.columns.category);
    if (!description.ok || !unit.ok || !rate.ok || !category.ok || !description.text || !unit.text || !rate.text) {
      skipped.push({ rowKey: row.rowKey, reason: 'not a priced row (description, unit and rate each exactly once)' });
      continue;
    }
    const rateCell = present.find((cell) => cell.columnName === page.columns.rate)!;
    const amount = parseLabelRate(rate.text);
    if (amount === null) {
      skipped.push({ rowKey: row.rowKey, reason: `rate cell is not one amount: ${rate.text}` });
      continue;
    }
    const boxes = options.cropBoxes?.(row.rowKey)?.map((box) => ({ ...box }))
      ?? present.map((cell) => ({ coordinate_space: 'canonical_v1' as const, x_min: cell.box.x_min,
        x_max: cell.box.x_max, y_min: cell.box.y_min, y_max: cell.box.y_max }));
    // The region the crop shows: the row's boxes, padded exactly as the renderer pads them.
    const pad = VALUE_READING_EXECUTION.cropPaddingPoints;
    const region = { x_min: Math.min(...boxes.map((box) => box.x_min)) - pad, x_max: Math.max(...boxes.map((box) => box.x_max)) + pad,
      y_min: Math.min(...boxes.map((box) => box.y_min)) - pad, y_max: Math.max(...boxes.map((box) => box.y_max)) + pad };
    const visible = (box: Readonly<{ x_min: number; x_max: number; y_min: number; y_max: number }>) =>
      box.x_min < region.x_max && box.x_max > region.x_min && box.y_min < region.y_max && box.y_max > region.y_min;
    const inside = (box: Readonly<{ x_min: number; x_max: number; y_min: number; y_max: number }>,
      outer: Readonly<{ x_min: number; x_max: number; y_min: number; y_max: number }>) => {
      const x = (box.x_min + box.x_max) / 2;
      const y = (box.y_min + box.y_max) / 2;
      return x >= outer.x_min && x <= outer.x_max && y >= outer.y_min && y <= outer.y_max;
    };
    // A production crop (B4.6.1) is scored only on what it shows: the row's category is truth only
    // when its cell is visible in the crop, and a category is supported only by evidence the crop
    // shows, so a category read from outside the crop is an invention. The labelled-row crop (B4.6)
    // always shows the row's cells and keeps its rule.
    const production = Boolean(options.cropBoxes?.(row.rowKey));
    const categoryCell = page.columns.category === null ? null
      : present.find((cell) => cell.columnName === page.columns.category) ?? null;
    const categoryShown = !production || (categoryCell !== null && visible(categoryCell.box));
    const headingShown = !production || (sectionHeadingBoxes.length > 0 && sectionHeadingBoxes.some((box) => visible(box)));
    targets.push({
      pageKey: page.pageKey,
      evidenceClass: page.evidenceClass,
      rowKey: row.rowKey,
      truth: { description: description.text, unit: unit.text, rate: amount, category: categoryShown ? category.text : null },
      boxes,
      pageOtherValues: [
        ...cellAmounts.filter((entry) => entry.cell.labelId !== rateCell.labelId).map((entry): PageValue => ({
          amount: entry.amount, source: 'cell', labelId: entry.cell.labelId, rowKey: rowOfCell.get(entry.cell.labelId) ?? null,
          columnName: entry.cell.columnName, inCrop: visible(entry.cell.box) })),
        // A word inside the target rate cell is the target's own value, not other evidence.
        ...wordAmounts.filter((entry) => !inside(entry.word.box, rateCell.box)).map((entry): PageValue => ({
          amount: entry.amount, source: 'word', labelId: entry.word.labelId, rowKey: null, columnName: null,
          inCrop: visible(entry.word.box) })),
      ],
      supportedCategories: [...new Set([categoryShown ? category.text : null, headingShown ? sectionHeading : null]
        .flatMap((text) => (text ? [normalizeReadingText(text)] : [])))],
    });
  }
  return { targets, skipped };
}

/** What the production parser made of one provider answer, or why there was none. */
export type ValueReadingAttempt =
  | Readonly<{ kind: 'value'; rateRow: Readonly<{ description: string; unit_type: string; rate_amount: number; category: string | null }> }>
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'failed'; code: string; reason: string }>;

/**
 * - correct: rate, unit, description and (where labelled) category all match.
 * - abstained: an honest "unreadable". Allowed, and preferred over a guess.
 * - wrong_rate: a confident value whose rate is not the page's. The unsafe outcome.
 * - field_mismatch: the right rate with a different unit, description or category.
 * - failed: no usable answer (provider, output or validation failure).
 */
export type ValueReadingOutcome = 'correct' | 'abstained' | 'wrong_rate' | 'field_mismatch' | 'failed';

/**
 * Why a confident rate is wrong. The target region decides correctness; the
 * wider page evidence only classifies the error, and both kinds fail:
 * - wrong_source_region_binding: the value exists elsewhere in the page evidence,
 *   but is not the target row's rate (a real number from the wrong place);
 * - unsupported_numeric_invention: the value exists nowhere in the page evidence.
 */
export type ValueReadingRateError = 'wrong_source_region_binding' | 'unsupported_numeric_invention';

/**
 * Why the text of a reading with the right rate and unit is wrong. Diagnostic
 * only: each is still an incorrect reading. "Supported" means printed in the
 * target row or in the allowed structural context (the section heading).
 * - semantic_field_misbinding: every target meaning is present and every
 *   returned text is supported, but assigned to the wrong field (swapped, or
 *   category and description merged). Not an invention.
 * - semantic_omission: every returned text is supported, but some target
 *   meaning is missing (for example the row's distinguishing description).
 * - semantic_unverified: some returned text does not match the supported text
 *   (a paraphrase, a misread, or invented wording). A person rules on it.
 */
export type ValueReadingSemanticError = 'semantic_field_misbinding' | 'semantic_omission' | 'semantic_unverified';

/** Text support check: normalized, with repeated dashes collapsed (`0--15` reads as `0-15`). */
const supportText = (text: string) => normalizeReadingText(text).replace(/-+/g, '-');

/** Whether `text` is one supported text, part of one, or supported texts joined by separators. */
function isSupportedText(text: string, supported: readonly string[]): boolean {
  let rest = supportText(text);
  if (!rest) return true;
  if (supported.some((entry) => entry.includes(rest))) return true;
  for (const entry of [...supported].sort((left, right) => right.length - left.length)) {
    if (entry) rest = rest.split(entry).join(' ');
  }
  return /^[\s\-:,;|/–]*$/.test(rest);
}

function classifySemanticError(target: ValueReadingBenchmarkTarget,
  read: Readonly<{ description: string; category: string | null }>): ValueReadingSemanticError {
  const description = supportText(target.truth.description);
  const category = target.truth.category === null ? null : supportText(target.truth.category);
  const supported = [description, ...(category ? [category] : []), ...target.supportedCategories.map(supportText)];
  const returned = [supportText(read.description), supportText(read.category ?? '')];
  if (!returned.every((text) => isSupportedText(text, supported))) return 'semantic_unverified';
  const present = (meaning: string) => returned.some((text) => text.includes(meaning));
  return present(description) && (category === null || present(category)) ? 'semantic_field_misbinding' : 'semantic_omission';
}

export type ValueReadingScore = Readonly<{
  outcome: ValueReadingOutcome;
  fields: Readonly<{ rate: boolean; unit: boolean; description: boolean; category: boolean | null }> | null;
  rateError: ValueReadingRateError | null;
  /** For a wrong source-region binding: the page value the rate matches. */
  boundTo: PageValue | null;
  /** Values the target evidence does not support: a unit other than the row's own, or an unsupported category. */
  inventions: readonly ('category' | 'unit')[];
  /** For a right rate and unit with wrong text: how the text is wrong. */
  semantic: ValueReadingSemanticError | null;
}>;

const sameAmount = (left: number, right: number) => Math.round(left * 1e6) === Math.round(right * 1e6);

export function scoreValueReading(target: ValueReadingBenchmarkTarget, attempt: ValueReadingAttempt): ValueReadingScore {
  if (attempt.kind === 'unreadable') return { outcome: 'abstained', fields: null, rateError: null, boundTo: null, inventions: [], semantic: null };
  if (attempt.kind === 'failed') return { outcome: 'failed', fields: null, rateError: null, boundTo: null, inventions: [], semantic: null };
  const { truth } = target;
  const read = attempt.rateRow;
  const fields = {
    rate: sameAmount(read.rate_amount, truth.rate),
    unit: normalizeReadingText(read.unit_type) === normalizeReadingText(truth.unit),
    description: normalizeReadingText(read.description) === normalizeReadingText(truth.description),
    category: truth.category === null ? null
      : normalizeReadingText(read.category ?? '') === normalizeReadingText(truth.category),
  };
  const inventions: ('category' | 'unit')[] = [];
  // A unit is supported only by the target row's own unit cell, wherever else the same unit is printed.
  if (!fields.unit) inventions.push('unit');
  const category = (read.category ?? '').trim();
  // A category is invented only when nothing in the target row or its section heading supports it:
  // the row's own description in the category field is a field misbinding, not an invention.
  const rowSupported = [target.truth.description, ...target.supportedCategories].map(supportText);
  if (category && !target.supportedCategories.includes(normalizeReadingText(category))
    && !isSupportedText(category, rowSupported)) inventions.push('category');
  if (!fields.rate) {
    // Prefer the trace the model most plausibly copied: a value in its crop, then a table cell, then any word.
    const matches = target.pageOtherValues.filter((value) => sameAmount(value.amount, read.rate_amount));
    const boundTo = matches.find((value) => value.inCrop && value.source === 'cell') ?? matches.find((value) => value.inCrop)
      ?? matches.find((value) => value.source === 'cell') ?? matches[0] ?? null;
    return { outcome: 'wrong_rate', fields,
      rateError: boundTo ? 'wrong_source_region_binding' : 'unsupported_numeric_invention', boundTo, inventions, semantic: null };
  }
  const correct = fields.unit && fields.description && fields.category !== false;
  return { outcome: correct ? 'correct' : 'field_mismatch', fields, rateError: null, boundTo: null, inventions,
    semantic: correct || !fields.unit ? null : classifySemanticError(target, read) };
}

/** One measured reading. Times in milliseconds; spend in US dollars. */
export type ValueReadingBenchmarkRecord = Readonly<{
  pageKey: string;
  evidenceClass: ValueReadingEvidenceClass;
  rowKey: string;
  outcome: ValueReadingOutcome;
  fields: ValueReadingScore['fields'];
  rateError: ValueReadingRateError | null;
  boundTo: PageValue | null;
  inventions: ValueReadingScore['inventions'];
  semantic: ValueReadingSemanticError | null;
  /** The request sent (null if none), and the SHA-256 of the provider's raw output (null if none). */
  requestDigestSha256: string | null;
  outputDigestSha256: string | null;
  /** Whether a provider call was made for this row (an attempt). */
  providerCalled: boolean;
  /** For failed readings: why (for example provider_timeout). */
  failureReason: string | null;
  renderMs: number;
  providerMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  renderDigestSha256: string;
  /** A second render produced the same bytes, so a repeat ask is answered from the stored proposal at no cost. */
  reuseEligible: boolean;
  /**
   * A human ruling. On a disagreement with the labels, `reading_correct` means
   * the label was wrong: the record is scored correct and stays listed. On an
   * abstention, `target_unreadable` confirms the crop is genuinely unreadable:
   * the row leaves the readable-target denominator and still counts as an
   * honest abstention.
   */
  adjudication?: ValueReadingVerdict;
}>;

export type ValueReadingVerdict = 'label_correct' | 'reading_correct' | 'target_unreadable';
export type ValueReadingAdjudication = Readonly<{ pageKey: string; rowKey: string; verdict: ValueReadingVerdict }>;

/** A record that disagrees with the labels or the page: what a human must rule on. */
export function isValueReadingDisagreement(record: ValueReadingBenchmarkRecord): boolean {
  return record.outcome === 'wrong_rate' || record.outcome === 'field_mismatch' || record.inventions.length > 0;
}

/** Applies human rulings on disagreements. The labels are dual-AI truth, so a disagreement may be a label error. */
export function applyValueReadingAdjudications(
  records: readonly ValueReadingBenchmarkRecord[],
  adjudications: readonly ValueReadingAdjudication[],
): readonly ValueReadingBenchmarkRecord[] {
  const rulings = new Map(adjudications.map((entry) => [`${entry.pageKey}/${entry.rowKey}`, entry.verdict]));
  return records.map((record) => {
    const verdict = rulings.get(`${record.pageKey}/${record.rowKey}`);
    if (!verdict) return record;
    if (verdict === 'target_unreadable') {
      // Only an abstention can be confirmed unreadable: a value reading of an unreadable crop is still a value reading.
      return record.outcome === 'abstained' ? { ...record, adjudication: verdict } : record;
    }
    if (!isValueReadingDisagreement(record)) return record;
    if (verdict === 'label_correct') return { ...record, adjudication: verdict };
    // The label was wrong and the reading right: every field the reading reported is correct.
    const fields = record.fields
      ? { rate: true, unit: true, description: true, category: record.fields.category === null ? null : true } : null;
    return { ...record, outcome: 'correct' as const, fields, rateError: null, boundTo: null, inventions: [], semantic: null,
      adjudication: verdict };
  });
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

export type ValueReadingClassStatus = 'qualified' | 'qualified_low_coverage' | 'failed';

export type ValueReadingClassSummary = Readonly<{
  /** The evidence class, 'all', or a B4.6.1 qualification class key (task:evidence class). */
  evidenceClass: ValueReadingEvidenceClass | 'all' | `${string}:${ValueReadingEvidenceClass}`;
  rows: number;
  outcomes: Readonly<Record<ValueReadingOutcome, number>>;
  accuracy: Readonly<{
    valueReadings: number;
    /** Correct rates among value readings; null when nothing was read. */
    ratePrecision: number | null;
    wrongSourceRegionBindings: number;
    unsupportedNumericInventions: number;
    unsupportedValueInventions: number;
    /** Diagnostic only: right rate and unit, wrong text. Each is also counted as a field mismatch. */
    semanticFieldMisbindings: number;
    semanticOmissions: number;
    semanticUnverified: number;
    fieldAccuracy: Readonly<{ rate: number; unit: number; description: number; category: number | null }>;
  }>;
  usefulness: Readonly<{ readableTargets: number; confirmedUnreadable: number; resolvedShareOfReadable: number; abstainShare: number }>;
  latencyMs: Readonly<{ renderP50: number | null; providerP50: number | null; totalP50: number | null; totalP95: number | null;
    timeouts: number }>;
  cost: Readonly<{ usdTotal: number; attempts: number; usdPerAttempt: number | null; usdPerCorrect: number | null;
    inputTokens: number; outputTokens: number; reuseRate: number }>;
  /** Disagreements with the labels or the page not yet ruled on by a human. */
  unadjudicatedDisagreements: number;
  status: ValueReadingClassStatus;
  /** Hard-bar failures. */
  failures: readonly string[];
  /** Soft-bar shortfalls. */
  shortfalls: readonly string[];
}>;

export function summarizeValueReadingClass(
  evidenceClass: ValueReadingClassSummary['evidenceClass'],
  records: readonly ValueReadingBenchmarkRecord[],
  bar = VALUE_READING_ACTIVATION_BAR,
): ValueReadingClassSummary {
  const outcomes: Record<ValueReadingOutcome, number> = { correct: 0, abstained: 0, wrong_rate: 0, field_mismatch: 0, failed: 0 };
  for (const record of records) outcomes[record.outcome] += 1;
  const rows = records.length;
  const share = (count: number, of: number) => (of === 0 ? 0 : count / of);
  const valueRecords = records.filter((record) => record.fields !== null);
  const withCategory = valueRecords.filter((record) => record.fields!.category !== null);
  const ratePrecision = valueRecords.length === 0 ? null
    : valueRecords.filter((record) => record.fields!.rate).length / valueRecords.length;
  const wrongSourceRegionBindings = records.filter((record) => record.rateError === 'wrong_source_region_binding').length;
  const unsupportedNumericInventions = records.filter((record) => record.rateError === 'unsupported_numeric_invention').length;
  const unsupportedValueInventions = records.filter((record) => record.inventions.length > 0).length;
  const semanticCount = (kind: ValueReadingSemanticError) => records.filter((record) => record.semantic === kind).length;
  const confirmedUnreadable = records.filter((record) => record.adjudication === 'target_unreadable').length;
  const readableTargets = rows - confirmedUnreadable;
  const resolvedShareOfReadable = share(outcomes.correct, readableTargets);
  const totalP50 = percentile(records.map((record) => record.totalMs), 0.5);
  const totalP95 = percentile(records.map((record) => record.totalMs), 0.95);
  const usdTotal = records.reduce((sum, record) => sum + record.usd, 0);
  const attempts = records.filter((record) => record.providerCalled).length;
  const usdPerAttempt = attempts === 0 ? null : usdTotal / attempts;
  const usdPerCorrect = outcomes.correct === 0 ? null : usdTotal / outcomes.correct;
  const reuseRate = share(records.filter((record) => record.reuseEligible).length, rows);
  const money = (value: number | null) => (value === null ? 'undefined' : `$${value.toFixed(4)}`);

  const failures: string[] = [];
  if (rows < bar.minRowsPerClass) failures.push(`only ${rows} rows; at least ${bar.minRowsPerClass} are needed to qualify`);
  if (ratePrecision === null || ratePrecision < bar.minRatePrecision) {
    failures.push(`rate precision ${ratePrecision === null ? 'undefined (no value readings)' : ratePrecision.toFixed(4)} is below ${bar.minRatePrecision}`);
  }
  if (wrongSourceRegionBindings > bar.maxWrongSourceRegionBindings) failures.push(`${wrongSourceRegionBindings} wrong source-region binding(s)`);
  if (unsupportedNumericInventions > bar.maxUnsupportedNumericInventions) failures.push(`${unsupportedNumericInventions} unsupported numeric invention(s)`);
  if (unsupportedValueInventions > bar.maxUnsupportedValueInventions) failures.push(`${unsupportedValueInventions} unsupported value invention(s)`);
  if (totalP50 === null || totalP50 > bar.maxP50TotalLatencyMs) failures.push(`median wait ${totalP50 ?? 'unmeasured'} ms exceeds ${bar.maxP50TotalLatencyMs} ms`);
  if (totalP95 === null || totalP95 > bar.maxP95TotalLatencyMs) failures.push(`p95 wait ${totalP95 ?? 'unmeasured'} ms exceeds ${bar.maxP95TotalLatencyMs} ms`);
  if (usdPerAttempt === null || usdPerAttempt > bar.maxUsdPerAttempt) failures.push(`cost per attempt ${money(usdPerAttempt)} exceeds $${bar.maxUsdPerAttempt}`);
  if (usdPerCorrect === null || usdPerCorrect > bar.maxUsdPerCorrect) failures.push(`cost per correct reading ${money(usdPerCorrect)} exceeds $${bar.maxUsdPerCorrect}`);
  if (reuseRate < bar.minReuseRate) failures.push(`reuse rate ${reuseRate.toFixed(3)}: some crops do not render to the same bytes`);
  const shortfalls: string[] = [];
  if (resolvedShareOfReadable < bar.minResolvedShareOfReadable) {
    shortfalls.push(`resolves ${resolvedShareOfReadable.toFixed(3)} of readable targets; the target is ${bar.minResolvedShareOfReadable}`);
  }
  return {
    evidenceClass,
    rows,
    outcomes,
    accuracy: {
      valueReadings: valueRecords.length,
      ratePrecision,
      wrongSourceRegionBindings,
      unsupportedNumericInventions,
      unsupportedValueInventions,
      semanticFieldMisbindings: semanticCount('semantic_field_misbinding'),
      semanticOmissions: semanticCount('semantic_omission'),
      semanticUnverified: semanticCount('semantic_unverified'),
      fieldAccuracy: {
        rate: share(valueRecords.filter((record) => record.fields!.rate).length, valueRecords.length),
        unit: share(valueRecords.filter((record) => record.fields!.unit).length, valueRecords.length),
        description: share(valueRecords.filter((record) => record.fields!.description).length, valueRecords.length),
        category: withCategory.length === 0 ? null
          : share(withCategory.filter((record) => record.fields!.category).length, withCategory.length),
      },
    },
    usefulness: { readableTargets, confirmedUnreadable, resolvedShareOfReadable, abstainShare: share(outcomes.abstained, rows) },
    latencyMs: {
      renderP50: percentile(records.map((record) => record.renderMs), 0.5),
      providerP50: percentile(records.filter((record) => record.providerCalled).map((record) => record.providerMs), 0.5),
      totalP50,
      totalP95,
      timeouts: records.filter((record) => record.failureReason === 'provider_timeout').length,
    },
    cost: {
      usdTotal, attempts, usdPerAttempt, usdPerCorrect,
      inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
      outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
      reuseRate,
    },
    unadjudicatedDisagreements: records.filter((record) => !record.adjudication && isValueReadingDisagreement(record)).length,
    status: failures.length > 0 ? 'failed' : shortfalls.length > 0 ? 'qualified_low_coverage' : 'qualified',
    failures,
    shortfalls,
  };
}

export type ValueReadingDecision = Readonly<{
  decision: 'PASS' | 'LIMITED_PASS' | 'FAIL';
  /** Classes that met every hard bar, with their status: the only classes a LIMITED PASS may enable. */
  qualifiedClasses: readonly Readonly<{ evidenceClass: ValueReadingEvidenceClass; status: Exclude<ValueReadingClassStatus, 'failed'> }>[];
  /** Corpus-wide zero-tolerance safety failures: any one fails the whole run. */
  corpusSafetyFailures: readonly string[];
  /** True while any disagreement awaits a human ruling: the decision is not final. */
  provisional: boolean;
  classes: readonly ValueReadingClassSummary[];
  overall: ValueReadingClassSummary;
  /** Proven by CI on the qualification commit, not by this measurement. */
  authorityInvariants: typeof VALUE_READING_AUTHORITY_INVARIANTS;
}>;

/**
 * PASS: no corpus-wide safety failure, and every evidence class qualified at
 * full coverage. LIMITED PASS: no corpus-wide safety failure, and some classes
 * qualified (possibly at low coverage); only those may be enabled. FAIL:
 * anything else; visual reading stays disabled.
 */
export function decideValueReadingActivation(
  records: readonly ValueReadingBenchmarkRecord[],
  bar = VALUE_READING_ACTIVATION_BAR,
): ValueReadingDecision {
  const overall = summarizeValueReadingClass('all', records, bar);
  const corpusSafetyFailures = [
    overall.accuracy.wrongSourceRegionBindings > bar.maxWrongSourceRegionBindings
      ? `${overall.accuracy.wrongSourceRegionBindings} wrong source-region binding(s) on the qualification corpus` : null,
    overall.accuracy.unsupportedNumericInventions > bar.maxUnsupportedNumericInventions
      ? `${overall.accuracy.unsupportedNumericInventions} unsupported numeric invention(s) on the qualification corpus` : null,
    overall.accuracy.unsupportedValueInventions > bar.maxUnsupportedValueInventions
      ? `${overall.accuracy.unsupportedValueInventions} unsupported value invention(s) on the qualification corpus` : null,
  ].filter((failure): failure is string => failure !== null);
  const classes = [...new Set(VALUE_READING_BENCHMARK_PAGES.map((page) => page.evidenceClass))]
    .map((evidenceClass) => summarizeValueReadingClass(evidenceClass,
      records.filter((record) => record.evidenceClass === evidenceClass), bar))
    .filter((summary) => summary.rows > 0);
  const qualifiedClasses = corpusSafetyFailures.length > 0 ? [] : classes
    .filter((summary) => summary.status !== 'failed')
    .map((summary) => ({ evidenceClass: summary.evidenceClass as ValueReadingEvidenceClass,
      status: summary.status as Exclude<ValueReadingClassStatus, 'failed'> }));
  const decision = corpusSafetyFailures.length === 0 && classes.length > 0
    && classes.every((summary) => summary.status === 'qualified') ? 'PASS'
    : qualifiedClasses.length > 0 ? 'LIMITED_PASS' : 'FAIL';
  return {
    decision,
    qualifiedClasses,
    corpusSafetyFailures,
    provisional: overall.unadjudicatedDisagreements > 0,
    classes,
    overall,
    authorityInvariants: VALUE_READING_AUTHORITY_INVARIANTS,
  };
}

export const VALUE_READING_CLEARANCE_VERSION = 'value-reading-transmission-clearance-v1' as const;
export const VALUE_READING_CLEARANCE_SCOPE = 'b46_value_reading_benchmark' as const;

export type ValueReadingClearance = Readonly<{
  documentKey: string;
  cleared: boolean;
  /** Why a document is not cleared, or the recorded approval when it is. */
  detail: string;
}>;

/**
 * Reads the committed transmission-clearance record. A document is cleared
 * only by an explicit page-region-image approval that names who, when and on
 * what basis, for exactly the pinned source bytes. Anything else, including a
 * missing or malformed record, is not cleared.
 */
export function readValueReadingClearance(
  record: unknown,
  pinned: ReadonlyMap<string, string>,
): readonly ValueReadingClearance[] {
  const root = record && typeof record === 'object' ? record as Record<string, unknown> : null;
  const documents = root?.documents && typeof root.documents === 'object' ? root.documents as Record<string, unknown> : null;
  // The record authorizes benchmark runs only; production transmission stays governed by the B4.1 data-policy ledger.
  const valid = root?.version === VALUE_READING_CLEARANCE_VERSION && root?.scope === VALUE_READING_CLEARANCE_SCOPE
    && root?.contentClass === 'page_region_images' && documents;
  return [...pinned].map(([documentKey, sha256]) => {
    if (!valid) return { documentKey, cleared: false, detail: 'clearance record missing or malformed' };
    const entry = documents![documentKey] as Record<string, unknown> | undefined;
    if (!entry) return { documentKey, cleared: false, detail: 'no clearance entry' };
    if (entry.sha256 !== sha256) return { documentKey, cleared: false, detail: 'clearance names other source bytes' };
    if (entry.pageRegionImages !== true) return { documentKey, cleared: false, detail: 'page-region images not approved' };
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    const approvedBy = text(entry.approvedBy);
    const approvedAt = text(entry.approvedAt);
    const basis = text(entry.basis);
    if (!approvedBy || !approvedAt || !basis || Number.isNaN(Date.parse(approvedAt))) {
      return { documentKey, cleared: false, detail: 'approval must name who, when and on what basis' };
    }
    return { documentKey, cleared: true, detail: `approved by ${approvedBy} at ${approvedAt}: ${basis}` };
  });
}
