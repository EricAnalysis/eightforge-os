import {
  BENCHMARK_RESULT_AUTHORITY,
  BENCHMARK_SCORING_VERSION,
  type BenchmarkBox,
  type BenchmarkCellLabel,
  type BenchmarkLabelBinding,
  type BenchmarkRowLabel,
  type BenchmarkWordLabel,
} from '@/lib/evaluation/benchmark/benchmarkContract';

/**
 * E3 benchmark scoring.
 *
 * Pure measurement: no IO, no provider, no persistence, no eligibility
 * decision. A score is only ever produced for a section a human has actually
 * labeled; an unlabeled section returns `labels_unavailable` rather than a
 * number, because scoring machine output against machine output would measure
 * nothing while looking like a result.
 */

export type BenchmarkPrediction = Readonly<{
  words: readonly Readonly<{ text: string; box: BenchmarkBox }>[];
  cells: readonly Readonly<{
    text: string; box: BenchmarkBox; isHeader: boolean; columnName: string | null;
  }>[];
  rows: readonly Readonly<{ orderedCellBoxes: readonly BenchmarkBox[] }>[];
  coverage: string | null;
}>;

export type SectionScore<T> =
  | Readonly<{ status: 'labels_unavailable' }>
  | (Readonly<{ status: 'scored' }> & T);

const unavailable = Object.freeze({ status: 'labels_unavailable' as const });

/** Levenshtein distance over any token sequence, O(n*m) time, O(min) space. */
export function editDistance(reference: readonly string[], hypothesis: readonly string[]): number {
  if (reference.length === 0) return hypothesis.length;
  if (hypothesis.length === 0) return reference.length;
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = [i, ...new Array<number>(hypothesis.length).fill(0)];
    for (let j = 1; j <= hypothesis.length; j += 1) {
      const substitution = previous[j - 1]! + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1);
    }
    previous = current;
  }
  return previous[hypothesis.length]!;
}

/**
 * Error rates against a reference. An empty reference with a non-empty
 * hypothesis is rate 1 (everything is an insertion), not a division by zero,
 * and an empty pair is rate 0.
 */
function errorRate(reference: readonly string[], hypothesis: readonly string[]): number {
  if (reference.length === 0) return hypothesis.length === 0 ? 0 : 1;
  return editDistance(reference, hypothesis) / reference.length;
}

export function characterErrorRate(reference: string, hypothesis: string): number {
  return errorRate([...reference], [...hypothesis]);
}

function words(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 0);
}

export function wordErrorRate(reference: string, hypothesis: string): number {
  return errorRate(words(reference), words(hypothesis));
}

export function boxIntersectionOverUnion(left: BenchmarkBox, right: BenchmarkBox): number {
  const width = Math.max(0, Math.min(left.x_max, right.x_max) - Math.max(left.x_min, right.x_min));
  const height = Math.max(0, Math.min(left.y_max, right.y_max) - Math.max(left.y_min, right.y_min));
  const intersection = width * height;
  const union = (left.x_max - left.x_min) * (left.y_max - left.y_min)
    + (right.x_max - right.x_min) * (right.y_max - right.y_min) - intersection;
  return union > 0 ? intersection / union : 0;
}

export type BoxMatching = Readonly<{
  matched: readonly Readonly<{ referenceIndex: number; predictionIndex: number; iou: number }>[];
  missedReferenceIndexes: readonly number[];
  spuriousPredictionIndexes: readonly number[];
  precision: number;
  recall: number;
  f1: number;
  meanMatchedIou: number;
}>;

/**
 * One-to-one geometric matching at an IoU threshold.
 *
 * Pairs are taken in descending IoU, which is deterministic and independent of
 * input order; ties break on the lower reference index, then the lower
 * prediction index, so the same inputs always produce the same matching.
 */
export function matchBoxes(
  reference: readonly BenchmarkBox[],
  prediction: readonly BenchmarkBox[],
  iouThreshold: number,
): BoxMatching {
  const pairs: Array<{ referenceIndex: number; predictionIndex: number; iou: number }> = [];
  reference.forEach((referenceBox, referenceIndex) => {
    prediction.forEach((predictionBox, predictionIndex) => {
      const iou = boxIntersectionOverUnion(referenceBox, predictionBox);
      if (iou >= iouThreshold && iou > 0) pairs.push({ referenceIndex, predictionIndex, iou });
    });
  });
  pairs.sort((left, right) => (right.iou - left.iou)
    || (left.referenceIndex - right.referenceIndex)
    || (left.predictionIndex - right.predictionIndex));
  const usedReference = new Set<number>();
  const usedPrediction = new Set<number>();
  const matched = pairs.filter((pair) => {
    if (usedReference.has(pair.referenceIndex) || usedPrediction.has(pair.predictionIndex)) return false;
    usedReference.add(pair.referenceIndex);
    usedPrediction.add(pair.predictionIndex);
    return true;
  });
  const precision = prediction.length === 0
    ? (reference.length === 0 ? 1 : 0) : matched.length / prediction.length;
  const recall = reference.length === 0
    ? (prediction.length === 0 ? 1 : 0) : matched.length / reference.length;
  return Object.freeze({
    matched: Object.freeze(matched),
    missedReferenceIndexes: Object.freeze(reference
      .map((_, index) => index).filter((index) => !usedReference.has(index))),
    spuriousPredictionIndexes: Object.freeze(prediction
      .map((_, index) => index).filter((index) => !usedPrediction.has(index))),
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    meanMatchedIou: matched.length > 0
      ? matched.reduce((total, pair) => total + pair.iou, 0) / matched.length : 0,
  });
}

export type WordScore = Readonly<{
  referenceCount: number;
  predictionCount: number;
  geometry: BoxMatching;
  /** Text accuracy over geometrically matched words only. */
  matchedTextExactRate: number;
  characterErrorRate: number;
  wordErrorRate: number;
}>;

/** Reading order for text comparison: top-to-bottom, then left-to-right. */
function readingOrder<T extends Readonly<{ box: BenchmarkBox }>>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => (left.box.y_min - right.box.y_min)
    || (left.box.x_min - right.box.x_min));
}

export function scoreWords(
  binding: BenchmarkLabelBinding,
  prediction: BenchmarkPrediction,
  iouThreshold = 0.5,
): SectionScore<WordScore> {
  if (binding.labels.words.status !== 'labeled') return unavailable;
  const reference: readonly BenchmarkWordLabel[] = readingOrder(binding.labels.words.items);
  const hypothesis = readingOrder(prediction.words);
  const geometry = matchBoxes(
    reference.map((item) => item.box), hypothesis.map((item) => item.box), iouThreshold);
  const exact = geometry.matched.filter((pair) =>
    reference[pair.referenceIndex]!.text === hypothesis[pair.predictionIndex]!.text).length;
  const referenceText = reference.map((item) => item.text).join(' ');
  const hypothesisText = hypothesis.map((item) => item.text).join(' ');
  return Object.freeze({
    status: 'scored' as const,
    referenceCount: reference.length,
    predictionCount: hypothesis.length,
    geometry,
    matchedTextExactRate: geometry.matched.length > 0 ? exact / geometry.matched.length : 0,
    characterErrorRate: characterErrorRate(referenceText, hypothesisText),
    wordErrorRate: wordErrorRate(referenceText, hypothesisText),
  });
}

export type CellScore = Readonly<{
  referenceCount: number;
  predictionCount: number;
  geometry: BoxMatching;
  /** Matched cells whose text is exactly right. */
  textAccuracy: number;
  /** Matched cells whose header/body role is right. */
  headerRoleAccuracy: number;
  referenceHeaderCount: number;
  predictionHeaderCount: number;
}>;

export function scoreCells(
  binding: BenchmarkLabelBinding,
  prediction: BenchmarkPrediction,
  iouThreshold = 0.5,
): SectionScore<CellScore> {
  if (binding.labels.cells.status !== 'labeled') return unavailable;
  const reference: readonly BenchmarkCellLabel[] = readingOrder(binding.labels.cells.items);
  const hypothesis = readingOrder(prediction.cells);
  const geometry = matchBoxes(
    reference.map((item) => item.box), hypothesis.map((item) => item.box), iouThreshold);
  const textMatches = geometry.matched.filter((pair) =>
    reference[pair.referenceIndex]!.text === hypothesis[pair.predictionIndex]!.text).length;
  const roleMatches = geometry.matched.filter((pair) =>
    reference[pair.referenceIndex]!.isHeader === hypothesis[pair.predictionIndex]!.isHeader).length;
  return Object.freeze({
    status: 'scored' as const,
    referenceCount: reference.length,
    predictionCount: hypothesis.length,
    geometry,
    textAccuracy: geometry.matched.length > 0 ? textMatches / geometry.matched.length : 0,
    headerRoleAccuracy: geometry.matched.length > 0 ? roleMatches / geometry.matched.length : 0,
    referenceHeaderCount: reference.filter((item) => item.isHeader).length,
    predictionHeaderCount: hypothesis.filter((item) => item.isHeader).length,
  });
}

export type RowScore = Readonly<{
  referenceCount: number;
  predictionCount: number;
  /** Rows whose full membership matches, as a set of matched cells. */
  exactMembershipCount: number;
  exactMembershipRate: number;
  /** Rows that match exactly and in the same order. */
  orderedMembershipRate: number;
}>;

/**
 * Row membership is compared through cell geometry, because a human's label ids
 * and an extractor's cell identities are different vocabularies. Each row
 * becomes the set of reference cells its members matched.
 */
export function scoreRows(
  binding: BenchmarkLabelBinding,
  prediction: BenchmarkPrediction,
  iouThreshold = 0.5,
): SectionScore<RowScore> {
  if (binding.labels.rows.status !== 'labeled' || binding.labels.cells.status !== 'labeled') {
    return unavailable;
  }
  const referenceCells: readonly BenchmarkCellLabel[] = readingOrder(binding.labels.cells.items);
  const cellIndexById = new Map(referenceCells.map((cell, index) => [cell.labelId, index] as const));
  const referenceRows: readonly BenchmarkRowLabel[] = binding.labels.rows.items;

  const predictionRows = prediction.rows.map((row) => row.orderedCellBoxes.map((box) => {
    let best = -1;
    let bestIou = iouThreshold;
    referenceCells.forEach((cell, index) => {
      const iou = boxIntersectionOverUnion(cell.box, box);
      if (iou >= bestIou && iou > 0) { best = index; bestIou = iou; }
    });
    return best;
  }).filter((index) => index >= 0));

  const referenceMembership = referenceRows.map((row) =>
    row.orderedCellLabelIds.map((id) => cellIndexById.get(id)).filter((index): index is number =>
      index !== undefined));
  const used = new Set<number>();
  let exact = 0;
  let ordered = 0;
  for (const expected of referenceMembership) {
    const expectedSet = [...expected].sort((left, right) => left - right).join(',');
    const candidateIndex = predictionRows.findIndex((row, index) => !used.has(index)
      && [...row].sort((left, right) => left - right).join(',') === expectedSet);
    if (candidateIndex < 0) continue;
    used.add(candidateIndex);
    exact += 1;
    if (predictionRows[candidateIndex]!.join(',') === expected.join(',')) ordered += 1;
  }
  return Object.freeze({
    status: 'scored' as const,
    referenceCount: referenceRows.length,
    predictionCount: prediction.rows.length,
    exactMembershipCount: exact,
    exactMembershipRate: referenceRows.length > 0 ? exact / referenceRows.length : 0,
    orderedMembershipRate: referenceRows.length > 0 ? ordered / referenceRows.length : 0,
  });
}

export type CoverageScore = Readonly<{
  truth: string;
  predicted: string | null;
  correct: boolean;
}>;

export function scoreCoverage(
  binding: BenchmarkLabelBinding,
  prediction: BenchmarkPrediction,
): SectionScore<CoverageScore> {
  const coverage = binding.labels.coverage;
  if (coverage.status !== 'labeled' || coverage.truth === null) return unavailable;
  return Object.freeze({
    status: 'scored' as const,
    truth: coverage.truth,
    predicted: prediction.coverage,
    correct: prediction.coverage === coverage.truth,
  });
}

export type DeterminismReport = Readonly<{
  runCount: number;
  distinctDigests: readonly string[];
  deterministic: boolean;
}>;

/** Determinism is an identity question: the same input must produce one digest. */
export function determinismReport(runDigests: readonly string[]): DeterminismReport {
  const distinct = [...new Set(runDigests)].sort();
  return Object.freeze({
    runCount: runDigests.length,
    distinctDigests: Object.freeze(distinct),
    // One run cannot demonstrate determinism, so it is never reported as such.
    deterministic: runDigests.length > 1 && distinct.length === 1,
  });
}

export type RuntimeReport = Readonly<{
  sampleCount: number;
  minMs: number;
  medianMs: number;
  maxMs: number;
}>;

export function runtimeReport(samplesMs: readonly number[]): RuntimeReport | null {
  const samples = samplesMs.filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (samples.length === 0) return null;
  const middle = Math.floor(samples.length / 2);
  return Object.freeze({
    sampleCount: samples.length,
    minMs: samples[0]!,
    medianMs: samples.length % 2 === 0
      ? ((samples[middle - 1]! + samples[middle]!) / 2) : samples[middle]!,
    maxMs: samples.at(-1)!,
  });
}

export type BenchmarkPageScore = Readonly<{
  scoringVersion: typeof BENCHMARK_SCORING_VERSION;
  authority: typeof BENCHMARK_RESULT_AUTHORITY;
  pageKey: string;
  labelsSha256: string;
  labelState: BenchmarkLabelBinding['state'];
  unlabeledSections: readonly string[];
  iouThreshold: number;
  words: SectionScore<WordScore>;
  cells: SectionScore<CellScore>;
  rows: SectionScore<RowScore>;
  coverage: SectionScore<CoverageScore>;
  determinism: DeterminismReport | null;
  runtime: RuntimeReport | null;
  /** No benchmark result may imply a production decision. */
  productionEligibilityDecision: 'not_in_scope';
}>;

export function scoreBenchmarkPage(input: Readonly<{
  binding: BenchmarkLabelBinding;
  prediction: BenchmarkPrediction;
  iouThreshold?: number;
  runDigests?: readonly string[];
  runtimeSamplesMs?: readonly number[];
}>): BenchmarkPageScore {
  const iouThreshold = input.iouThreshold ?? 0.5;
  return Object.freeze({
    scoringVersion: BENCHMARK_SCORING_VERSION,
    authority: BENCHMARK_RESULT_AUTHORITY,
    pageKey: input.binding.labels.pageKey,
    labelsSha256: input.binding.labelsSha256,
    labelState: input.binding.state,
    unlabeledSections: input.binding.unlabeledSections,
    iouThreshold,
    words: scoreWords(input.binding, input.prediction, iouThreshold),
    cells: scoreCells(input.binding, input.prediction, iouThreshold),
    rows: scoreRows(input.binding, input.prediction, iouThreshold),
    coverage: scoreCoverage(input.binding, input.prediction),
    determinism: input.runDigests ? determinismReport(input.runDigests) : null,
    runtime: input.runtimeSamplesMs ? runtimeReport(input.runtimeSamplesMs) : null,
    productionEligibilityDecision: 'not_in_scope',
  });
}
