import type { BenchmarkPageLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import type { CanonicalBox } from '@/lib/extraction/geometry/canonicalPageFrame';

/**
 * B4.6 value-reading qualification. Pure: targets from tracked label truth,
 * scoring, summary and the pre-registered activation decision. It never reads
 * a source file, renders, or calls a provider; the runner in
 * scripts/evaluation/b46 does that, through the production renderer, adapter
 * and parser.
 *
 * The question it answers: can visual reading read unresolved pricing cells
 * accurately enough, fast enough and cheaply enough to justify controlled
 * activation? A confident wrong rate is far worse than an honest
 * "unreadable", so abstention is never scored as a failure, and one wrong rate
 * disqualifies its evidence class.
 */

export const VALUE_READING_BENCHMARK_VERSION = 'value-reading-benchmark-v1' as const;

/**
 * Pre-registered before any provider call. Changing a threshold after seeing
 * results is a new benchmark version, not a re-scoring.
 */
export const VALUE_READING_ACTIVATION_BAR = Object.freeze({
  /** Confident wrong rates tolerated per evidence class, after adjudication. */
  maxWrongRateReadings: 0,
  /** Fully correct rows (rate, unit, description, category) over all target rows. */
  minCorrectShare: 0.8,
  /** Render plus provider, the operator's wait. The engine itself times out at 8 s. */
  maxP95TotalLatencyMs: 8000,
  /** Total spend over correct readings. */
  maxUsdPerCorrectReading: 0.05,
  /** Fewer rows than this cannot qualify a class. */
  minRowsPerClass: 20,
});

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

/** Every labelled priced row on the page, with the reason any row is not a target. */
export function valueReadingBenchmarkTargets(labels: BenchmarkPageLabels, page: ValueReadingBenchmarkPage): Readonly<{
  targets: readonly ValueReadingBenchmarkTarget[];
  skipped: readonly Readonly<{ rowKey: string; reason: string }>[];
}> {
  if (labels.pageKey !== page.pageKey) throw new Error(`labels are for ${labels.pageKey}, not ${page.pageKey}`);
  if (labels.cells.status !== 'labeled' || labels.rows.status !== 'labeled') {
    throw new Error(`${page.pageKey}: cells and rows must be labelled`);
  }
  const cells = new Map((labels.cells.items ?? []).map((cell) => [cell.labelId, cell]));
  const targets: ValueReadingBenchmarkTarget[] = [];
  const skipped: { rowKey: string; reason: string }[] = [];
  for (const row of labels.rows.items ?? []) {
    const rowCells = row.orderedCellLabelIds.map((id) => cells.get(id));
    if (rowCells.some((cell) => !cell)) {
      skipped.push({ rowKey: row.rowKey, reason: 'row references an unknown cell' });
      continue;
    }
    const present = rowCells as NonNullable<(typeof rowCells)[number]>[];
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
    const amount = parseLabelRate(rate.text);
    if (amount === null) {
      skipped.push({ rowKey: row.rowKey, reason: `rate cell is not one amount: ${rate.text}` });
      continue;
    }
    targets.push({
      pageKey: page.pageKey,
      evidenceClass: page.evidenceClass,
      rowKey: row.rowKey,
      truth: { description: description.text, unit: unit.text, rate: amount, category: category.text },
      boxes: present.map((cell) => ({ coordinate_space: 'canonical_v1' as const, x_min: cell.box.x_min,
        x_max: cell.box.x_max, y_min: cell.box.y_min, y_max: cell.box.y_max })),
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
 * - abstained: an honest "unreadable". Not wrong, not useful.
 * - wrong_rate: a confident value whose rate is not the page's. The unsafe outcome.
 * - field_mismatch: the right rate with a different unit, description or category.
 * - failed: no usable answer (provider, output or validation failure).
 */
export type ValueReadingOutcome = 'correct' | 'abstained' | 'wrong_rate' | 'field_mismatch' | 'failed';

export type ValueReadingScore = Readonly<{
  outcome: ValueReadingOutcome;
  fields: Readonly<{ rate: boolean; unit: boolean; description: boolean; category: boolean | null }> | null;
}>;

export function scoreValueReading(truth: ValueReadingTruth, attempt: ValueReadingAttempt): ValueReadingScore {
  if (attempt.kind === 'unreadable') return { outcome: 'abstained', fields: null };
  if (attempt.kind === 'failed') return { outcome: 'failed', fields: null };
  const read = attempt.rateRow;
  const fields = {
    rate: Math.round(read.rate_amount * 1e6) === Math.round(truth.rate * 1e6),
    unit: normalizeReadingText(read.unit_type) === normalizeReadingText(truth.unit),
    description: normalizeReadingText(read.description) === normalizeReadingText(truth.description),
    category: truth.category === null ? null
      : normalizeReadingText(read.category ?? '') === normalizeReadingText(truth.category),
  };
  if (!fields.rate) return { outcome: 'wrong_rate', fields };
  return { outcome: fields.unit && fields.description && fields.category !== false ? 'correct' : 'field_mismatch', fields };
}

/** One measured reading. Times in milliseconds; spend in US dollars. */
export type ValueReadingBenchmarkRecord = Readonly<{
  pageKey: string;
  evidenceClass: ValueReadingEvidenceClass;
  rowKey: string;
  outcome: ValueReadingOutcome;
  fields: ValueReadingScore['fields'];
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
   * A human ruling on a disagreement with the labels. `reading_correct` means
   * the label was wrong: the record is scored as correct and stays listed.
   */
  adjudication?: 'label_correct' | 'reading_correct';
}>;

export type ValueReadingAdjudication = Readonly<{ pageKey: string; rowKey: string; verdict: 'label_correct' | 'reading_correct' }>;

/** Applies human rulings on disagreements. The labels are dual-AI truth, so a disagreement may be a label error. */
export function applyValueReadingAdjudications(
  records: readonly ValueReadingBenchmarkRecord[],
  adjudications: readonly ValueReadingAdjudication[],
): readonly ValueReadingBenchmarkRecord[] {
  const rulings = new Map(adjudications.map((entry) => [`${entry.pageKey}/${entry.rowKey}`, entry.verdict]));
  return records.map((record) => {
    const disagreement = record.outcome === 'wrong_rate' || record.outcome === 'field_mismatch';
    const verdict = disagreement ? rulings.get(`${record.pageKey}/${record.rowKey}`) : undefined;
    if (!verdict) return record;
    return verdict === 'reading_correct'
      ? { ...record, outcome: 'correct' as const, adjudication: verdict }
      : { ...record, adjudication: verdict };
  });
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

export type ValueReadingClassSummary = Readonly<{
  evidenceClass: ValueReadingEvidenceClass | 'all';
  rows: number;
  outcomes: Readonly<Record<ValueReadingOutcome, number>>;
  correctShare: number;
  abstainShare: number;
  fieldAccuracy: Readonly<{ rate: number; unit: number; description: number; category: number | null }>;
  latencyMs: Readonly<{ renderP50: number | null; providerP50: number | null; totalP50: number | null; totalP95: number | null }>;
  cost: Readonly<{ usdTotal: number; usdPerAttempt: number | null; usdPerCorrect: number | null;
    inputTokens: number; outputTokens: number }>;
  reuseRate: number;
  /** Disagreements with the labels not yet ruled on by a human. */
  unadjudicatedDisagreements: number;
  meetsBar: boolean;
  failures: readonly string[];
}>;

export function summarizeValueReadingClass(
  evidenceClass: ValueReadingClassSummary['evidenceClass'],
  records: readonly ValueReadingBenchmarkRecord[],
  bar = VALUE_READING_ACTIVATION_BAR,
): ValueReadingClassSummary {
  const outcomes: Record<ValueReadingOutcome, number> = { correct: 0, abstained: 0, wrong_rate: 0, field_mismatch: 0, failed: 0 };
  for (const record of records) outcomes[record.outcome] += 1;
  const rows = records.length;
  const answered = records.filter((record) => record.fields !== null);
  const share = (count: number, of: number) => (of === 0 ? 0 : count / of);
  const withCategory = answered.filter((record) => record.fields!.category !== null);
  const usdTotal = records.reduce((sum, record) => sum + record.usd, 0);
  const totalP95 = percentile(records.map((record) => record.totalMs), 0.95);
  const usdPerCorrect = outcomes.correct === 0 ? null : usdTotal / outcomes.correct;
  const correctShare = share(outcomes.correct, rows);
  const failures: string[] = [];
  if (rows < bar.minRowsPerClass) failures.push(`only ${rows} rows; at least ${bar.minRowsPerClass} are needed to qualify`);
  if (outcomes.wrong_rate > bar.maxWrongRateReadings) {
    failures.push(`${outcomes.wrong_rate} confident wrong rate(s); at most ${bar.maxWrongRateReadings} allowed`);
  }
  if (correctShare < bar.minCorrectShare) {
    failures.push(`correct share ${correctShare.toFixed(3)} is below ${bar.minCorrectShare}`);
  }
  if (totalP95 === null || totalP95 > bar.maxP95TotalLatencyMs) {
    failures.push(`p95 operator wait ${totalP95 ?? 'unmeasured'} ms exceeds ${bar.maxP95TotalLatencyMs} ms`);
  }
  if (usdPerCorrect === null || usdPerCorrect > bar.maxUsdPerCorrectReading) {
    failures.push(`cost per correct reading ${usdPerCorrect === null ? 'undefined' : `$${usdPerCorrect.toFixed(4)}`} exceeds $${bar.maxUsdPerCorrectReading}`);
  }
  return {
    evidenceClass,
    rows,
    outcomes,
    correctShare,
    abstainShare: share(outcomes.abstained, rows),
    fieldAccuracy: {
      rate: share(answered.filter((record) => record.fields!.rate).length, answered.length),
      unit: share(answered.filter((record) => record.fields!.unit).length, answered.length),
      description: share(answered.filter((record) => record.fields!.description).length, answered.length),
      category: withCategory.length === 0 ? null
        : share(withCategory.filter((record) => record.fields!.category).length, withCategory.length),
    },
    latencyMs: {
      renderP50: percentile(records.map((record) => record.renderMs), 0.5),
      providerP50: percentile(records.map((record) => record.providerMs), 0.5),
      totalP50: percentile(records.map((record) => record.totalMs), 0.5),
      totalP95,
    },
    cost: {
      usdTotal,
      usdPerAttempt: rows === 0 ? null : usdTotal / rows,
      usdPerCorrect,
      inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
      outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
    },
    reuseRate: share(records.filter((record) => record.reuseEligible).length, rows),
    unadjudicatedDisagreements: records.filter((record) => !record.adjudication
      && (record.outcome === 'wrong_rate' || record.outcome === 'field_mismatch')).length,
    meetsBar: failures.length === 0,
    failures,
  };
}

export type ValueReadingDecision = Readonly<{
  decision: 'PASS' | 'LIMITED_PASS' | 'FAIL';
  /** Evidence classes that met every bar: the only classes a LIMITED PASS may enable. */
  qualifiedClasses: readonly ValueReadingEvidenceClass[];
  /** True while any disagreement awaits a human ruling: the decision is not final. */
  provisional: boolean;
  classes: readonly ValueReadingClassSummary[];
  overall: ValueReadingClassSummary;
}>;

/**
 * PASS: every evidence class meets every bar. LIMITED PASS: some do; only
 * those may be enabled. FAIL: none do; visual reading stays disabled.
 */
export function decideValueReadingActivation(
  records: readonly ValueReadingBenchmarkRecord[],
  bar = VALUE_READING_ACTIVATION_BAR,
): ValueReadingDecision {
  const classes = [...new Set(VALUE_READING_BENCHMARK_PAGES.map((page) => page.evidenceClass))]
    .map((evidenceClass) => summarizeValueReadingClass(evidenceClass,
      records.filter((record) => record.evidenceClass === evidenceClass), bar))
    .filter((summary) => summary.rows > 0);
  const qualifiedClasses = classes.filter((summary) => summary.meetsBar)
    .map((summary) => summary.evidenceClass as ValueReadingEvidenceClass);
  const decision = classes.length > 0 && qualifiedClasses.length === classes.length ? 'PASS'
    : qualifiedClasses.length > 0 ? 'LIMITED_PASS' : 'FAIL';
  return {
    decision,
    qualifiedClasses,
    provisional: classes.some((summary) => summary.unadjudicatedDisagreements > 0),
    classes,
    overall: summarizeValueReadingClass('all', records, bar),
  };
}

export const VALUE_READING_CLEARANCE_VERSION = 'value-reading-transmission-clearance-v1' as const;

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
  const valid = root?.version === VALUE_READING_CLEARANCE_VERSION && root?.contentClass === 'page_region_images' && documents;
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
