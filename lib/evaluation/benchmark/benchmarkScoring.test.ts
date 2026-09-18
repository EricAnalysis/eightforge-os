import { describe, expect, it } from 'vitest';

import {
  bindBenchmarkLabels,
  buildBenchmarkLabelTemplate,
  parseBenchmarkLabels,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  boxIntersectionOverUnion,
  characterErrorRate,
  determinismReport,
  editDistance,
  matchBoxes,
  runtimeReport,
  scoreBenchmarkPage,
  wordErrorRate,
  type BenchmarkPrediction,
} from '@/lib/evaluation/benchmark/benchmarkScoring';

const FRAME: BenchmarkPageLabels['frame'] = {
  frame_version: 'canonical_frame_v1', coordinate_space: 'canonical_v1',
  view: [0, 0, 612, 792], rotation: 0, user_unit: 1, width: 612, height: 792,
};
const SOURCE = {
  pageKey: 'dn-p107' as const, documentKey: 'dn',
  sha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
  byteLength: 3_895_497, physicalPageNumber: 107, frame: FRAME,
};

const box = (x: number, y: number, width = 20, height = 10) => ({
  coordinate_space: 'canonical_v1' as const,
  x_min: x, y_min: y, x_max: x + width, y_max: y + height,
});

function bind(labels: BenchmarkPageLabels) {
  return bindBenchmarkLabels(parseBenchmarkLabels(JSON.stringify(labels)), SOURCE);
}

const template = () => buildBenchmarkLabelTemplate(SOURCE);

const labeled: BenchmarkPageLabels = {
  ...template(),
  words: {
    status: 'labeled',
    items: [
      { labelId: 'w1', text: 'Unit', box: box(10, 10) },
      { labelId: 'w2', text: 'Cost', box: box(40, 10) },
      { labelId: 'w3', text: '8.75', box: box(10, 40) },
    ],
  },
  cells: {
    status: 'labeled',
    items: [
      { labelId: 'c1', text: 'Unit Cost', box: box(10, 10, 50), isHeader: true, columnName: 'Unit Cost' },
      { labelId: 'c2', text: '8.75', box: box(10, 40), isHeader: false, columnName: 'Unit Cost' },
      { labelId: 'c3', text: '9.25', box: box(10, 70), isHeader: false, columnName: 'Unit Cost' },
    ],
  },
  rows: {
    status: 'labeled',
    items: [
      { rowKey: 'r1', orderedCellLabelIds: ['c2'] },
      { rowKey: 'r2', orderedCellLabelIds: ['c3'] },
    ],
  },
  coverage: { status: 'labeled', truth: 'native_text_complete', note: null },
};

const perfectPrediction: BenchmarkPrediction = {
  words: labeled.words.items.map((item) => ({ text: item.text, box: item.box })),
  cells: labeled.cells.items.map((item) => ({
    text: item.text, box: item.box, isHeader: item.isHeader, columnName: item.columnName,
  })),
  rows: [{ orderedCellBoxes: [labeled.cells.items[1]!.box] },
    { orderedCellBoxes: [labeled.cells.items[2]!.box] }],
  coverage: 'native_text_complete',
};

describe('error rates', () => {
  it('measures edit distance over characters and words', () => {
    expect(editDistance([...'kitten'], [...'sitting'])).toBe(3);
    expect(characterErrorRate('kitten', 'sitting')).toBeCloseTo(3 / 6, 9);
    expect(wordErrorRate('Unit Cost 8.75', 'Unit Cost 8.76')).toBeCloseTo(1 / 3, 9);
    expect(characterErrorRate('Unit', 'Unit')).toBe(0);
  });

  it('treats an empty reference honestly instead of dividing by zero', () => {
    expect(characterErrorRate('', '')).toBe(0);
    expect(characterErrorRate('', 'spurious')).toBe(1);
    expect(wordErrorRate('Unit Cost', '')).toBe(1);
  });
});

describe('geometric matching', () => {
  it('computes IoU and matches one-to-one at a threshold', () => {
    expect(boxIntersectionOverUnion(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBe(1);
    expect(boxIntersectionOverUnion(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(0);
    const matching = matchBoxes([box(0, 0, 10, 10), box(100, 0, 10, 10)], [box(1, 0, 10, 10)], 0.5);
    expect(matching.matched).toHaveLength(1);
    expect(matching.matched[0]).toMatchObject({ referenceIndex: 0, predictionIndex: 0 });
    expect(matching.missedReferenceIndexes).toEqual([1]);
    expect(matching.spuriousPredictionIndexes).toEqual([]);
    expect(matching.recall).toBe(0.5);
    expect(matching.precision).toBe(1);
  });

  it('never lets one prediction satisfy two references', () => {
    const matching = matchBoxes([box(0, 0, 10, 10), box(2, 0, 10, 10)], [box(1, 0, 10, 10)], 0.1);
    expect(matching.matched).toHaveLength(1);
    expect(matching.missedReferenceIndexes).toHaveLength(1);
  });

  it('is independent of input order', () => {
    const reference = [box(0, 0, 10, 10), box(50, 0, 10, 10), box(100, 0, 10, 10)];
    const prediction = [box(51, 0, 10, 10), box(1, 0, 10, 10), box(99, 0, 10, 10)];
    const forward = matchBoxes(reference, prediction, 0.4);
    const reversed = matchBoxes([...reference].reverse(), [...prediction].reverse(), 0.4);
    expect(forward.f1).toBe(reversed.f1);
    expect(forward.matched.length).toBe(reversed.matched.length);
    expect(forward.meanMatchedIou).toBeCloseTo(reversed.meanMatchedIou, 12);
  });
});

describe('scoring a benchmark page', () => {
  it('refuses to score sections no human has labeled', () => {
    const score = scoreBenchmarkPage({ binding: bind(template()), prediction: perfectPrediction });
    expect(score.labelState).toBe('unlabeled');
    expect(score.words).toEqual({ status: 'labels_unavailable' });
    expect(score.cells).toEqual({ status: 'labels_unavailable' });
    expect(score.rows).toEqual({ status: 'labels_unavailable' });
    expect(score.coverage).toEqual({ status: 'labels_unavailable' });
    expect(score.unlabeledSections).toEqual(['words', 'cells', 'rows', 'coverage']);
  });

  it('refuses row scoring when only rows are labeled', () => {
    const rowsOnly = bind({ ...template(), cells: { status: 'unlabeled', items: [] } });
    expect(scoreBenchmarkPage({ binding: rowsOnly, prediction: perfectPrediction }).rows)
      .toEqual({ status: 'labels_unavailable' });
  });

  it('scores a perfect prediction as perfect', () => {
    const score = scoreBenchmarkPage({ binding: bind(labeled), prediction: perfectPrediction });
    expect(score.labelState).toBe('complete');
    expect(score.words).toMatchObject({
      status: 'scored', referenceCount: 3, predictionCount: 3,
      matchedTextExactRate: 1, characterErrorRate: 0, wordErrorRate: 0,
    });
    expect(score.cells).toMatchObject({
      status: 'scored', textAccuracy: 1, headerRoleAccuracy: 1,
      referenceHeaderCount: 1, predictionHeaderCount: 1,
    });
    expect(score.rows).toMatchObject({
      status: 'scored', exactMembershipRate: 1, orderedMembershipRate: 1,
    });
    expect(score.coverage).toMatchObject({ status: 'scored', correct: true });
  });

  it('separates a geometry miss from a text miss', () => {
    const misread: BenchmarkPrediction = {
      ...perfectPrediction,
      words: [
        { text: 'Unit', box: box(10, 10) },
        { text: 'C0st', box: box(40, 10) },
        { text: '8.75', box: box(300, 400) },
      ],
    };
    const score = scoreBenchmarkPage({ binding: bind(labeled), prediction: misread });
    expect(score.words).toMatchObject({ status: 'scored' });
    const words = score.words as Extract<typeof score.words, { status: 'scored' }>;
    // Two words found in the right place; one read wrongly; one box elsewhere.
    expect(words.geometry.matched).toHaveLength(2);
    expect(words.matchedTextExactRate).toBeCloseTo(0.5, 9);
    expect(words.geometry.missedReferenceIndexes).toHaveLength(1);
    expect(words.geometry.spuriousPredictionIndexes).toHaveLength(1);
    expect(words.characterErrorRate).toBeGreaterThan(0);
  });

  it('reports a wrong coverage claim as incorrect rather than unavailable', () => {
    const score = scoreBenchmarkPage({
      binding: bind(labeled), prediction: { ...perfectPrediction, coverage: 'requires_ocr' },
    });
    expect(score.coverage).toMatchObject({
      status: 'scored', truth: 'native_text_complete', predicted: 'requires_ocr', correct: false,
    });
  });

  it('marks row membership wrong when a row absorbs another row\'s cell', () => {
    const merged: BenchmarkPrediction = {
      ...perfectPrediction,
      rows: [{ orderedCellBoxes: [labeled.cells.items[1]!.box, labeled.cells.items[2]!.box] }],
    };
    const score = scoreBenchmarkPage({ binding: bind(labeled), prediction: merged });
    expect(score.rows).toMatchObject({ status: 'scored', exactMembershipCount: 0, exactMembershipRate: 0 });
  });

  it('never reports a production eligibility decision', () => {
    const score = scoreBenchmarkPage({ binding: bind(labeled), prediction: perfectPrediction });
    expect(score.productionEligibilityDecision).toBe('not_in_scope');
    expect(score.authority).toBe('non_authoritative_measurement');
  });
});

describe('determinism and runtime', () => {
  it('needs more than one run before claiming determinism', () => {
    expect(determinismReport(['a'.repeat(64)])).toMatchObject({ runCount: 1, deterministic: false });
    expect(determinismReport(['a'.repeat(64), 'a'.repeat(64)])).toMatchObject({ deterministic: true });
    expect(determinismReport(['a'.repeat(64), 'b'.repeat(64)])).toMatchObject({
      deterministic: false, distinctDigests: ['a'.repeat(64), 'b'.repeat(64)],
    });
  });

  it('summarizes runtime samples and returns null without any', () => {
    expect(runtimeReport([])).toBeNull();
    expect(runtimeReport([30, 10, 20])).toEqual({ sampleCount: 3, minMs: 10, medianMs: 20, maxMs: 30 });
    expect(runtimeReport([10, 20, 30, 40])).toMatchObject({ medianMs: 25 });
  });
});
