import { describe, expect, it } from 'vitest';

import {
  bindBenchmarkLabels,
  buildBenchmarkLabelTemplate,
  parseBenchmarkLabels,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import type { BenchmarkMachineRun } from '@/lib/evaluation/benchmark/benchmarkMachineRun';
import { scoreBenchmarkPage, type BenchmarkPrediction } from '@/lib/evaluation/benchmark/benchmarkScoring';
import {
  BENCHMARK_SUGGESTION_AUTHORITY,
  bindBenchmarkSuggestions,
  buildBenchmarkSuggestions,
  parseBenchmarkSuggestions,
} from '@/lib/evaluation/benchmark/benchmarkSuggestions';
import { hashCanonical } from '@/lib/extraction/domain/hash';

const FRAME: BenchmarkPageLabels['frame'] = {
  frame_version: 'canonical_frame_v1', coordinate_space: 'canonical_v1',
  view: [0, 0, 612, 792], rotation: 0, user_unit: 1, width: 612, height: 792,
};
const SOURCE = {
  pageKey: 'golden-p8' as const, documentKey: 'golden', sha256: 'a'.repeat(64),
  byteLength: 10_000, physicalPageNumber: 8, frame: FRAME,
};
const box = (x: number, y: number) => ({
  coordinate_space: 'canonical_v1' as const,
  x_min: x, y_min: y, x_max: x + 20, y_max: y + 10,
});
const PREDICTION: BenchmarkPrediction = {
  words: [{ text: 'Unit', box: box(10, 10) }, { text: 'Cost', box: box(35, 10) }],
  cells: [
    { text: 'Unit Cost', box: box(10, 10), isHeader: true, columnName: 'Unit Cost' },
    { text: '8.75', box: box(10, 40), isHeader: false, columnName: 'Unit Cost' },
  ],
  rows: [{ orderedCellBoxes: [box(10, 40)] }],
  coverage: 'native_text_complete',
};
const RUN: BenchmarkMachineRun = {
  prediction: PREDICTION,
  predictionDigest: hashCanonical(PREDICTION),
  runtimeMs: 12,
  pageSource: 'pdfjs',
  nativeTokenCount: 2,
  ocrTokenCount: 0,
  tokensWithoutCanonicalGeometry: 0,
};

describe('benchmark suggestion contract', () => {
  it('projects the machine pass into a separate provisional artifact with exact row references', () => {
    const suggestions = buildBenchmarkSuggestions({ source: SOURCE, run: RUN });
    expect(suggestions.authority).toBe(BENCHMARK_SUGGESTION_AUTHORITY);
    expect(suggestions).not.toHaveProperty('coverage');
    expect(suggestions.words.map((item) => item.suggestionId)).toEqual(['sw1', 'sw2']);
    expect(suggestions.cells.map((item) => item.suggestionId)).toEqual(['sc1', 'sc2']);
    expect(suggestions.rows).toEqual([
      { suggestionId: 'sr1', orderedCellSuggestionIds: ['sc2'] },
    ]);
    expect(suggestions.sourceRun).toMatchObject({
      kind: 'benchmark_machine_pass', predictionDigest: RUN.predictionDigest,
      nativeTokenCount: 2, ocrTokenCount: 0,
    });
  });

  it('binds only to the exact source identity and canonical frame', () => {
    const artifact = buildBenchmarkSuggestions({ source: SOURCE, run: RUN });
    const parsed = parseBenchmarkSuggestions(JSON.stringify(artifact));
    expect(bindBenchmarkSuggestions(parsed, SOURCE).suggestions).toEqual(artifact);
    expect(() => bindBenchmarkSuggestions(parsed, { ...SOURCE, sha256: 'b'.repeat(64) }))
      .toThrow(/source sha256 differs/);
    expect(() => bindBenchmarkSuggestions(parsed, { ...SOURCE, physicalPageNumber: 9 }))
      .toThrow(/physical page number differs/);
    expect(() => bindBenchmarkSuggestions(parsed, {
      ...SOURCE, frame: { ...FRAME, width: 611 },
    })).toThrow(/canonical page frame differs/);
  });

  it('rejects unknown row members, extra fields, and a mismatched prediction digest', () => {
    const artifact = buildBenchmarkSuggestions({ source: SOURCE, run: RUN });
    expect(() => parseBenchmarkSuggestions(JSON.stringify({
      ...artifact,
      rows: [{ suggestionId: 'sr1', orderedCellSuggestionIds: ['missing'] }],
    }))).toThrow(/cites unknown cell suggestion/);
    expect(() => parseBenchmarkSuggestions(JSON.stringify({ ...artifact, truth: true })))
      .toThrow(/Unrecognized key/);
    expect(() => buildBenchmarkSuggestions({
      source: SOURCE, run: { ...RUN, predictionDigest: 'b'.repeat(64) },
    })).toThrow(/prediction digest does not match/);
  });
});

describe('confirmed-label provenance compatibility', () => {
  it('keeps legacy v1 labels valid and accepts strict optional provenance', () => {
    const legacy = buildBenchmarkLabelTemplate(SOURCE);
    expect(parseBenchmarkLabels(JSON.stringify(legacy)).labels).toEqual(legacy);

    const confirmed: BenchmarkPageLabels = {
      ...legacy,
      words: {
        status: 'labeled',
        items: [
          { labelId: 'w1', text: 'Unit', box: box(10, 10),
            provenance: { method: 'entered_manually' } },
          { labelId: 'w2', text: 'Cost', box: box(35, 10),
            provenance: { method: 'accepted_suggestion', sourceSuggestionId: 'sw2' } },
        ],
      },
    };
    expect(parseBenchmarkLabels(JSON.stringify(confirmed)).labels.words.items)
      .toEqual(confirmed.words.items);
    expect(() => parseBenchmarkLabels(JSON.stringify({
      ...confirmed,
      words: { status: 'labeled', items: [{
        labelId: 'w1', text: 'Unit', box: box(10, 10),
        provenance: { method: 'accepted_suggestion' },
      }] },
    }))).toThrow(/sourceSuggestionId/);
  });

  it('does not change scoring meaning', () => {
    const base: BenchmarkPageLabels = {
      ...buildBenchmarkLabelTemplate(SOURCE),
      words: {
        status: 'labeled',
        items: [{ labelId: 'w1', text: 'Unit', box: box(10, 10) }],
      },
    };
    const withProvenance: BenchmarkPageLabels = {
      ...base,
      words: {
        status: 'labeled',
        items: [{ ...base.words.items[0]!, provenance: {
          method: 'edited_suggestion', sourceSuggestionId: 'sw1',
        } }],
      },
    };
    const score = (labels: BenchmarkPageLabels) => scoreBenchmarkPage({
      binding: bindBenchmarkLabels(parseBenchmarkLabels(JSON.stringify(labels)), SOURCE),
      prediction: PREDICTION,
    });
    const without = score(base);
    const withAudit = score(withProvenance);
    expect(withAudit.words).toEqual(without.words);
    expect(withAudit.cells).toEqual(without.cells);
    expect(withAudit.rows).toEqual(without.rows);
    expect(withAudit.coverage).toEqual(without.coverage);
    expect(withAudit.authority).toBe('non_authoritative_measurement');
    expect(withAudit.productionEligibilityDecision).toBe('not_in_scope');
  });
});
