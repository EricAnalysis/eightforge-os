import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_PAGES,
  bindBenchmarkLabels,
  buildBenchmarkLabelTemplate,
  parseBenchmarkLabels,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';

const FRAME: BenchmarkPageLabels['frame'] = {
  frame_version: 'canonical_frame_v1',
  coordinate_space: 'canonical_v1',
  view: [0, 0, 612, 792],
  rotation: 0,
  user_unit: 1,
  width: 612,
  height: 792,
};

const SOURCE = {
  pageKey: 'dn-p107' as const,
  documentKey: 'dn',
  sha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
  byteLength: 3_895_497,
  physicalPageNumber: 107,
  frame: FRAME,
};

const template = () => buildBenchmarkLabelTemplate(SOURCE);

const box = (x: number, y: number) => ({
  coordinate_space: 'canonical_v1' as const, x_min: x, y_min: y, x_max: x + 20, y_max: y + 10,
});

describe('benchmark label template', () => {
  it('contains no human truth at all', () => {
    const labels = template();
    expect(labels.words).toEqual({ status: 'unlabeled', items: [] });
    expect(labels.cells).toEqual({ status: 'unlabeled', items: [] });
    expect(labels.rows).toEqual({ status: 'unlabeled', items: [] });
    expect(labels.coverage).toEqual({ status: 'unlabeled', truth: null, note: null });
    expect(labels.labeledBy).toBeNull();
    expect(labels.labeledAt).toBeNull();
    // Nothing in the serialized template may look like page content.
    const serialized = JSON.stringify(labels);
    expect(serialized).not.toMatch(/"text"/);
    expect(serialized).not.toMatch(/"truth":"/);
  });

  it('carries only measured source identity and page geometry', () => {
    expect(template().source).toEqual({
      documentKey: 'dn', sha256: SOURCE.sha256, byteLength: SOURCE.byteLength, physicalPageNumber: 107,
    });
    expect(template().frame).toEqual(FRAME);
  });

  it('round-trips through the parser', () => {
    const parsed = parseBenchmarkLabels(JSON.stringify(template()));
    expect(parsed.labels).toEqual(template());
    expect(parsed.labelsSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('pins the three frozen benchmark pages and locates them by env var', () => {
    expect(BENCHMARK_PAGES.map((page) => page.pageKey)).toEqual(['golden-p8', 'hillsdale-p3', 'dn-p107']);
    expect(BENCHMARK_PAGES.map((page) => page.sourceEnvVar)).toEqual([
      'GOLDEN_CORPUS_ROOT', 'MIXED_MODE_HILLSDALE_PRICE_SHEET_PDF', 'DN_PRICED_SCHEDULE_SOURCE_PDF',
    ]);
    expect(BENCHMARK_PAGES.every((page) => /^[a-f0-9]{64}$/.test(page.sha256))).toBe(true);
  });
});

describe('benchmark label schema', () => {
  const labeled = (overrides: Partial<BenchmarkPageLabels> = {}): BenchmarkPageLabels => ({
    ...template(),
    cells: {
      status: 'labeled',
      items: [
        { labelId: 'c1', text: 'Unit Cost', box: box(10, 10), isHeader: true, columnName: 'Unit Cost' },
        { labelId: 'c2', text: '8.75', box: box(10, 40), isHeader: false, columnName: 'Unit Cost' },
      ],
    },
    ...overrides,
  });

  it('refuses a labeled section with no items, and an unlabeled section with items', () => {
    expect(() => parseBenchmarkLabels(JSON.stringify({
      ...template(), words: { status: 'labeled', items: [] },
    }))).toThrow(/labeled word section must not be empty/);
    expect(() => parseBenchmarkLabels(JSON.stringify({
      ...template(),
      words: { status: 'unlabeled', items: [{ labelId: 'w1', text: 'Rate', box: box(10, 10) }] },
    }))).toThrow(/unlabeled word section must be empty/);
  });

  it('refuses coverage truth without a status, and a status without a truth', () => {
    expect(() => parseBenchmarkLabels(JSON.stringify({
      ...template(), coverage: { status: 'unlabeled', truth: 'requires_ocr', note: null },
    }))).toThrow(/unlabeled coverage must have no truth/);
    expect(() => parseBenchmarkLabels(JSON.stringify({
      ...template(), coverage: { status: 'labeled', truth: null, note: null },
    }))).toThrow(/labeled coverage must state a truth/);
  });

  it('refuses row membership that cites an unknown cell or claims one twice', () => {
    expect(() => parseBenchmarkLabels(JSON.stringify(labeled({
      rows: { status: 'labeled', items: [{ rowKey: 'r1', orderedCellLabelIds: ['c1', 'nope'] }] },
    })))).toThrow(/cites unknown cell/);
    expect(() => parseBenchmarkLabels(JSON.stringify(labeled({
      rows: {
        status: 'labeled',
        items: [
          { rowKey: 'r1', orderedCellLabelIds: ['c1'] },
          { rowKey: 'r2', orderedCellLabelIds: ['c1'] },
        ],
      },
    })))).toThrow(/belongs to more than one row/);
  });

  it('refuses row membership without labeled cells, and duplicate ids', () => {
    expect(() => parseBenchmarkLabels(JSON.stringify({
      ...template(),
      rows: { status: 'labeled', items: [{ rowKey: 'r1', orderedCellLabelIds: ['c1'] }] },
    }))).toThrow(/cites unknown cell|row membership requires labeled cells/);
    expect(() => parseBenchmarkLabels(JSON.stringify({
      ...template(),
      words: {
        status: 'labeled',
        items: [
          { labelId: 'w1', text: 'Rate', box: box(10, 10) },
          { labelId: 'w1', text: 'Cost', box: box(40, 10) },
        ],
      },
    }))).toThrow(/duplicate word label id/);
  });

  it('refuses a box with no area or an untagged coordinate space', () => {
    expect(() => parseBenchmarkLabels(JSON.stringify({
      ...template(),
      words: {
        status: 'labeled',
        items: [{ labelId: 'w1', text: 'Rate', box: { ...box(10, 10), x_max: 10 } }],
      },
    }))).toThrow(/positive area/);
    expect(() => parseBenchmarkLabels(JSON.stringify({
      ...template(),
      words: {
        status: 'labeled',
        items: [{ labelId: 'w1', text: 'Rate', box: { ...box(10, 10), coordinate_space: 'ocr_render_px' } }],
      },
    }))).toThrow(/coordinate_space: Invalid literal value, expected "canonical_v1"/);
  });
});

describe('binding labels to the source they were authored against', () => {
  it('reports which sections a human has completed', () => {
    const binding = bindBenchmarkLabels(
      parseBenchmarkLabels(JSON.stringify(template())), SOURCE);
    expect(binding.state).toBe('unlabeled');
    expect(binding.labeledSections).toEqual([]);
    expect(binding.unlabeledSections).toEqual(['words', 'cells', 'rows', 'coverage']);

    const partial = bindBenchmarkLabels(parseBenchmarkLabels(JSON.stringify({
      ...template(), coverage: { status: 'labeled', truth: 'requires_ocr', note: null },
    })), SOURCE);
    expect(partial.state).toBe('partial');
    expect(partial.labeledSections).toEqual(['coverage']);
  });

  it('fails closed when the labels describe other bytes, another page or another frame', () => {
    const parsed = parseBenchmarkLabels(JSON.stringify(template()));
    expect(() => bindBenchmarkLabels(parsed, { ...SOURCE, sha256: 'b'.repeat(64) }))
      .toThrow(/source sha256 differs/);
    expect(() => bindBenchmarkLabels(parsed, { ...SOURCE, byteLength: 10 }))
      .toThrow(/source byte length differs/);
    expect(() => bindBenchmarkLabels(parsed, { ...SOURCE, physicalPageNumber: 106 }))
      .toThrow(/physical page number differs/);
    expect(() => bindBenchmarkLabels(parsed, { ...SOURCE, frame: { ...FRAME, rotation: 90 } }))
      .toThrow(/canonical page frame differs/);
    expect(() => bindBenchmarkLabels(parsed, { ...SOURCE, pageKey: 'golden-p8' }))
      .toThrow(/page key differs/);
  });
});
