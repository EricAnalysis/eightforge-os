import { describe, expect, it } from 'vitest';

import { buildSyntheticPdf, type SyntheticPage } from '@/lib/extraction/geometry/__fixtures__/syntheticPdf';
import {
  bindBenchmarkLabels,
  buildBenchmarkLabelTemplate,
  parseBenchmarkLabels,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import { runBenchmarkMachinePass } from '@/lib/evaluation/benchmark/benchmarkMachineRun';
import { buildContractRateScheduleRows } from '@/lib/contracts/contractRateScheduleRows';
import { loadPdfLayout } from '@/lib/extraction/pdf/extractText';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
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

  it('projects OCR-only table cells and rows through the OCR tokens they cite', async () => {
    // A page with no native text: every token is OCR, supplied in render pixels (2x).
    const blank = buildSyntheticPdf([{ mediaBox: [0, 0, 612, 792], runs: [] }]);
    const word = (text: string, x0: number, y0: number) => ({
      text, confidence: 90, bbox: { x0, y0, x1: x0 + text.length * 12, y1: y0 + 20 },
    });
    const ocr: OcrGeometryPage = {
      page_number: 1, width: 1224, height: 1584,
      words: [
        word('Description', 100, 180), word('Unit', 400, 180), word('Cost', 900, 180),
        word('Alpha', 100, 240), word('service', 172, 240), word('Ton', 400, 240), word('$12.00', 900, 240),
        word('Beta', 100, 300), word('service', 160, 300), word('Ton', 400, 300), word('$3.50', 900, 300),
      ],
    };
    const run = await runBenchmarkMachinePass({
      bytes: blank, physicalPageNumber: 1, ocrPages: [ocr], pageFrame: FRAME,
    });
    expect(run.ocrTokenCount).toBe(ocr.words.length);
    expect(run.prediction.coverage).toBe('requires_ocr');
    // The authored header row plus two body rows.
    expect(run.prediction.rows).toHaveLength(3);
    expect(run.prediction.cells.filter((cell) => !cell.isHeader)).toHaveLength(6);
    expect(run.prediction.cells.filter((cell) => cell.isHeader).map((cell) => cell.text))
      .toEqual(['Description', 'Unit', 'Cost']);
    // Every cell box is the union of the canonical boxes of the words it cites.
    const alpha = run.prediction.words.find((entry) => entry.text === 'Alpha')!.box;
    const service = run.prediction.words.filter((entry) => entry.text === 'service')
      .map((entry) => entry.box).sort((left, right) => left.y_min - right.y_min)[0]!;
    const description = run.prediction.cells.find((cell) => cell.text === 'Alpha service')!;
    expect(description.box).toEqual({
      coordinate_space: 'canonical_v1',
      x_min: Math.min(alpha.x_min, service.x_min), y_min: Math.min(alpha.y_min, service.y_min),
      x_max: Math.max(alpha.x_max, service.x_max), y_max: Math.max(alpha.y_max, service.y_max),
    });
  }, 60_000);

  it('projects role-less columns as structure, in column order, with no semantic column name', async () => {
    const withCode = buildSyntheticPdf([{ mediaBox: [0, 0, 612, 792], runs: [
      { text: 'Code', x: 10, y: 700 }, ...RUNS.slice(0, 4),
      { text: 'A1', x: 10, y: 660 }, ...RUNS.slice(4, 9),
      { text: 'B2', x: 10, y: 630 }, ...RUNS.slice(9),
    ] }]);
    const run = await runBenchmarkMachinePass({ bytes: withCode, physicalPageNumber: 1 });
    const code = run.prediction.cells.filter((cell) => cell.text === 'A1' || cell.text === 'B2');
    expect(code.map((cell) => cell.columnName)).toEqual([null, null]);
    // Each row leads with its role-less "Code" cell: structure keeps column order.
    const a1 = code.find((cell) => cell.text === 'A1')!.box;
    expect(run.prediction.rows.some((row) => row.orderedCellBoxes[0]!.x_min === a1.x_min
      && row.orderedCellBoxes[0]!.y_min === a1.y_min)).toBe(true);
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
  // ---------------------------------------------------------------------------
  // R7: the authored header row is projected as structure. Its cells are the
  // header tokens that established each reconstructed column (recognized or
  // role-less), located by their own boxes. Nothing above the header, and
  // nothing from an unresolved header, is claimed.
  // ---------------------------------------------------------------------------

  const ocrWord = (text: string, x0: number, y0: number) => ({
    text, confidence: 90, bbox: { x0, y0, x1: x0 + text.length * 12, y1: y0 + 20 },
  });
  const blankPdf = () => buildSyntheticPdf([{ mediaBox: [0, 0, 612, 792], runs: [] }]);
  const ocrRun = (words: OcrGeometryPage['words']) => runBenchmarkMachinePass({
    bytes: blankPdf(), physicalPageNumber: 1, pageFrame: FRAME,
    ocrPages: [{ page_number: 1, width: 1224, height: 1584, words }],
  });
  const bodyWords = [
    ocrWord('Alpha', 100, 240), ocrWord('service', 172, 240), ocrWord('Ton', 400, 240), ocrWord('$12.00', 900, 240),
    ocrWord('Beta', 100, 300), ocrWord('service', 160, 300), ocrWord('Ton', 400, 300), ocrWord('$3.50', 900, 300),
  ];

  it('R7-1: projects a recognized header as structural header cells with their semantic column', async () => {
    const run = await ocrRun([ocrWord('Description', 100, 180), ocrWord('Unit', 400, 180), ocrWord('Cost', 900, 180), ...bodyWords]);
    const header = run.prediction.cells.filter((cell) => cell.isHeader);
    expect(header.map((cell) => [cell.text, cell.columnName])).toEqual([
      ['Description', 'description'], ['Unit', 'unit'], ['Cost', 'rate'],
    ]);
    // The header row leads, in column order, and is a row of its own.
    expect(run.prediction.rows[0]!.orderedCellBoxes).toEqual(header.map((cell) => cell.box));
  }, 60_000);

  it('R7-2: a role-less header column survives as a header cell with no semantic name', async () => {
    const withCode = buildSyntheticPdf([{ mediaBox: [0, 0, 612, 792], runs: [
      { text: 'Code', x: 10, y: 700 }, ...RUNS.slice(0, 4),
      { text: 'A1', x: 10, y: 660 }, ...RUNS.slice(4, 9),
      { text: 'B2', x: 10, y: 630 }, ...RUNS.slice(9),
    ] }]);
    const run = await runBenchmarkMachinePass({ bytes: withCode, physicalPageNumber: 1 });
    expect(run.prediction.cells.filter((cell) => cell.isHeader).map((cell) => [cell.text, cell.columnName])).toEqual([
      ['Code', null], ['Description', 'description'], ['Unit', 'unit'], ['Origin', 'origin_destination'], ['Cost', 'rate'],
    ]);
  }, 60_000);

  it('R7-3: a multi-word header cell is the union box of exactly its own source words', async () => {
    const words = [
      ocrWord('Description', 100, 180), ocrWord('Unit', 400, 180), ocrWord('of', 460, 180), ocrWord('Measure', 496, 180),
      ocrWord('Cost', 900, 180), ...bodyWords,
    ];
    const run = await ocrRun(words);
    const unit = run.prediction.cells.find((cell) => cell.isHeader && cell.columnName === 'unit')!;
    expect(unit.text).toBe('Unit of Measure');
    const member = (text: string) => run.prediction.words.find((word) => word.text === text && word.box.y_min < 100)!.box;
    const parts = ['Unit', 'of', 'Measure'].map(member);
    expect(unit.box).toEqual({
      coordinate_space: 'canonical_v1',
      x_min: Math.min(...parts.map((box) => box.x_min)), y_min: Math.min(...parts.map((box) => box.y_min)),
      x_max: Math.max(...parts.map((box) => box.x_max)), y_max: Math.max(...parts.map((box) => box.y_max)),
    });
  }, 60_000);

  it('R7-4: header cells never become pricing facts', async () => {
    const run = await runBenchmarkMachinePass({ bytes: bytes(), physicalPageNumber: 1 });
    expect(run.prediction.cells.filter((cell) => cell.isHeader)).toHaveLength(4);
    const layout = await loadPdfLayout(bytes());
    const priced = buildContractRateScheduleRows({
      rateTable: null, pricedScheduleReconstruction: buildPagePricedScheduleReconstruction({ layout }),
    });
    expect(priced.map((row) => row.description)).toEqual(['Vegetative Debris', 'Inert Debris']);
    expect(JSON.stringify(priced)).not.toMatch(/"(?:Description|Origin|Cost)"/);
  }, 60_000);

  it('R7-5: an unresolved (ambiguous) header claims no header cells and stays unresolved', async () => {
    const run = await ocrRun([ocrWord('Description', 100, 180), ocrWord('Unit', 400, 180), ocrWord('Unit', 600, 180), ocrWord('Cost', 900, 180), ...bodyWords]);
    expect(run.prediction.cells).toEqual([]);
    expect(run.prediction.rows).toEqual([]);
  }, 60_000);

  it('R7-6: a title line above the header is never claimed as table structure', async () => {
    const run = await ocrRun([ocrWord('SCHEDULE', 400, 120), ocrWord('OF', 508, 120), ocrWord('RATES', 544, 120),
      ocrWord('Description', 100, 180), ocrWord('Unit', 400, 180), ocrWord('Cost', 900, 180), ...bodyWords]);
    expect(run.prediction.cells.some((cell) => /SCHEDULE|RATES/.test(cell.text))).toBe(false);
    expect(run.prediction.cells.filter((cell) => cell.isHeader).map((cell) => cell.text)).toEqual(['Description', 'Unit', 'Cost']);
  }, 60_000);

  it('R7-7: native and OCR headers of the same table project the same header structure', async () => {
    const native = await runBenchmarkMachinePass({ bytes: bytes(), physicalPageNumber: 1 });
    // The same table as OCR words over a 2x render (canonical y is top-down).
    const ocr = await ocrRun(RUNS.map((entry) => ocrWord(entry.text, entry.x * 2, (792 - entry.y) * 2 - 16)));
    const project = (cells: typeof native.prediction.cells) => cells.filter((cell) => cell.isHeader)
      .map((cell) => [cell.text, cell.columnName]);
    expect(project(native.prediction.cells)).toHaveLength(4);
    expect(project(ocr.prediction.cells)).toEqual(project(native.prediction.cells));
  }, 60_000);

  it('R8: projects table-edge lines around body rows without assigning semantic columns', async () => {
    const row = (code: string, description: string, y: number) => [
      ocrWord(code, 20, y), ocrWord(description, 100, y), ocrWord('EA', 400, y),
      ocrWord('Yard', 600, y), ocrWord('$12.00', 900, y),
    ];
    const page = (section: OcrGeometryPage['words']) => ocrRun([
      ocrWord('Code', 20, 180), ocrWord('Description', 100, 180), ocrWord('Unit', 400, 180),
      ocrWord('Route', 600, 180), ocrWord('Cost', 900, 180),
      ...section,
      ...row('A1', 'Alpha', 240), ...row('B2', 'Beta', 270), ...row('C3', 'Gamma', 300),
      ocrWord('Project', 430, 330), ocrWord('subtotal:', 520, 330), ocrWord('$99.00', 900, 330),
    ]);
    // A section label spanning the description/unit boundary is edge structure.
    const run = await page([
      ocrWord('ROADWAY', 150, 210), ocrWord('AND', 246, 210), ocrWord('BRIDGE', 294, 210), ocrWord('ITEMS', 378, 210),
    ]);
    const section = ['ROADWAY AND BRIDGE ITEMS'].map((text) => run.prediction.cells.find((cell) => cell.text === text)!);
    const totalLabel = run.prediction.cells.find((cell) => cell.text === 'Project subtotal:')!;
    const totalAmount = run.prediction.cells.find((cell) => cell.text === '$99.00')!;
    expect([...section, totalLabel, totalAmount].map((cell) => [cell.isHeader, cell.columnName])).toEqual([
      [false, null], [false, null], [false, null],
    ]);
    expect(run.prediction.rows[1]!.orderedCellBoxes).toEqual(section.map((cell) => cell.box));
    expect(run.prediction.rows.at(-1)!.orderedCellBoxes).toEqual([totalLabel.box, totalAmount.box]);
    expect(run.prediction.cells.find((cell) => cell.text === 'Alpha')?.columnName).toBe('description');
    // The same words wholly inside the description column are indistinguishable
    // from a first row wrapping above its anchor, so they never become edge structure.
    const contained = await page([ocrWord('ROADWAY', 260, 210), ocrWord('ITEMS', 360, 210)]);
    expect(contained.prediction.cells.filter((cell) => ['ROADWAY', 'ITEMS'].includes(cell.text)
      && !cell.isHeader && cell.columnName === null)).toEqual([]);
  }, 60_000);
});
