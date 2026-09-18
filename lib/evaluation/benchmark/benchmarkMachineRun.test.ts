import { describe, expect, it } from 'vitest';

import { buildSyntheticPdf, type SyntheticPage } from '@/lib/extraction/geometry/__fixtures__/syntheticPdf';
import {
  bindBenchmarkLabels,
  buildBenchmarkLabelTemplate,
  parseBenchmarkLabels,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import { runBenchmarkMachinePass } from '@/lib/evaluation/benchmark/benchmarkMachineRun';
import { scoreBenchmarkPage } from '@/lib/evaluation/benchmark/benchmarkScoring';
import type { OcrGeometryPage } from '@/lib/extraction/pdf/ocrGeometryLayout';

/**
 * The machine side over real pdf.js-parsed bytes. Synthetic source, no
 * provider, no OCR engine: OCR geometry is supplied directly, exactly as a
 * separate opt-in OCR run would hand it over.
 */

const RUNS: SyntheticPage['runs'] = [
  { text: 'Description', x: 50, y: 700 }, { text: 'Unit', x: 200, y: 700 },
  { text: 'Origin', x: 300, y: 700 }, { text: 'Cost', x: 450, y: 700 },
  { text: 'Vegetative Debris', x: 50, y: 660 }, { text: 'Ton', x: 200, y: 660 },
  { text: 'A to B', x: 300, y: 660 }, { text: '$', x: 450, y: 660 }, { text: '12.00', x: 470, y: 660 },
  { text: 'Inert Debris', x: 50, y: 630 }, { text: 'Ton', x: 200, y: 630 },
  { text: 'A to B', x: 300, y: 630 }, { text: '$', x: 450, y: 630 }, { text: '3.50', x: 470, y: 630 },
];

const bytes = () => buildSyntheticPdf([{ mediaBox: [0, 0, 612, 792], runs: RUNS }]);

const FRAME: BenchmarkPageLabels['frame'] = {
  frame_version: 'canonical_frame_v1', coordinate_space: 'canonical_v1',
  view: [0, 0, 612, 792], rotation: 0, user_unit: 1, width: 612, height: 792,
};
const SOURCE = {
  pageKey: 'dn-p107' as const, documentKey: 'dn',
  sha256: 'a'.repeat(64), byteLength: 1_000, physicalPageNumber: 1, frame: FRAME,
};

describe('benchmark machine pass', () => {
  it('projects native words with canonical geometry and claims native coverage', async () => {
    const run = await runBenchmarkMachinePass({ bytes: bytes(), physicalPageNumber: 1 });
    expect(run.nativeTokenCount).toBe(RUNS.length);
    expect(run.ocrTokenCount).toBe(0);
    expect(run.tokensWithoutCanonicalGeometry).toBe(0);
    expect(run.prediction.words).toHaveLength(RUNS.length);
    expect(run.prediction.words.every((word) => word.box.coordinate_space === 'canonical_v1')).toBe(true);
    expect(run.prediction.coverage).toBe('native_text_complete');
    expect(run.runtimeMs).toBeGreaterThanOrEqual(0);
    // Canonical geometry is top-left: the header sits above the first body row.
    const header = run.prediction.words.find((word) => word.text === 'Description')!;
    const body = run.prediction.words.find((word) => word.text === 'Vegetative Debris')!;
    expect(header.box.y_min).toBeLessThan(body.box.y_min);
  }, 60_000);

  it('reconstructs rows whose cells are located by the tokens they cite', async () => {
    const run = await runBenchmarkMachinePass({ bytes: bytes(), physicalPageNumber: 1 });
    expect(run.prediction.rows.length).toBeGreaterThanOrEqual(2);
    expect(run.prediction.cells.length).toBeGreaterThanOrEqual(run.prediction.rows.length);
    for (const cell of run.prediction.cells) {
      expect(cell.box.x_max).toBeGreaterThan(cell.box.x_min);
      expect(cell.box.y_max).toBeGreaterThan(cell.box.y_min);
    }
  }, 60_000);

  it('is deterministic: the same bytes produce the same prediction digest', async () => {
    const first = await runBenchmarkMachinePass({ bytes: bytes(), physicalPageNumber: 1 });
    const second = await runBenchmarkMachinePass({ bytes: bytes(), physicalPageNumber: 1 });
    expect(second.predictionDigest).toBe(first.predictionDigest);
  }, 60_000);

  it('claims mixed coverage when supplied OCR geometry is admitted beside native text', async () => {
    const ocr: OcrGeometryPage = {
      page_number: 1, width: 1224, height: 1584,
      words: [{ text: 'APPROVED', confidence: 90, bbox: { x0: 900, y0: 40, x1: 1100, y1: 70 } }],
    };
    const run = await runBenchmarkMachinePass({
      bytes: bytes(), physicalPageNumber: 1, ocrPages: [ocr],
    });
    expect(run.ocrTokenCount).toBe(1);
    expect(run.prediction.coverage).toBe('mixed_native_and_ocr');
    expect(run.prediction.words.some((word) => word.text === 'APPROVED')).toBe(true);
  }, 60_000);

  it('scores as labels_unavailable until a human labels the page', async () => {
    const run = await runBenchmarkMachinePass({ bytes: bytes(), physicalPageNumber: 1 });
    const binding = bindBenchmarkLabels(
      parseBenchmarkLabels(JSON.stringify(buildBenchmarkLabelTemplate(SOURCE))), SOURCE);
    const score = scoreBenchmarkPage({
      binding,
      prediction: run.prediction,
      runDigests: [run.predictionDigest, run.predictionDigest],
      runtimeSamplesMs: [run.runtimeMs],
    });
    expect(score.words).toEqual({ status: 'labels_unavailable' });
    expect(score.cells).toEqual({ status: 'labels_unavailable' });
    expect(score.coverage).toEqual({ status: 'labels_unavailable' });
    // Determinism and runtime are measurable without labels; accuracy is not.
    expect(score.determinism).toMatchObject({ deterministic: true });
    expect(score.runtime).toMatchObject({ sampleCount: 1 });
    expect(score.productionEligibilityDecision).toBe('not_in_scope');
  }, 60_000);

  it('scores against labels a human wrote, without either side being invented', async () => {
    const run = await runBenchmarkMachinePass({ bytes: bytes(), physicalPageNumber: 1 });
    // A tiny hand-written label set: two words a human read off this page.
    const word = (text: string) => run.prediction.words.find((entry) => entry.text === text)!;
    const labels: BenchmarkPageLabels = {
      ...buildBenchmarkLabelTemplate(SOURCE),
      words: {
        status: 'labeled',
        items: [
          { labelId: 'w1', text: 'Description', box: word('Description').box },
          { labelId: 'w2', text: 'Cost', box: word('Cost').box },
        ],
      },
      coverage: { status: 'labeled', truth: 'native_text_complete', note: null },
    };
    const binding = bindBenchmarkLabels(parseBenchmarkLabels(JSON.stringify(labels)), SOURCE);
    const score = scoreBenchmarkPage({ binding, prediction: run.prediction });
    expect(score.words).toMatchObject({ status: 'scored', matchedTextExactRate: 1 });
    const words = score.words as Extract<typeof score.words, { status: 'scored' }>;
    expect(words.geometry.recall).toBe(1);
    // The run reads more words than this partial label set names, and that shows
    // as precision rather than being hidden.
    expect(words.geometry.precision).toBeLessThan(1);
    expect(score.coverage).toMatchObject({ status: 'scored', correct: true });
  }, 60_000);
});
