import { hashCanonical } from '@/lib/extraction/domain/hash';
import { loadPdfLayout, type PdfLayoutPage } from '@/lib/extraction/pdf/extractText';
import {
  mergeOcrFallbackLayout,
  type OcrGeometryPage,
} from '@/lib/extraction/pdf/ocrGeometryLayout';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import type { BenchmarkBox } from '@/lib/evaluation/benchmark/benchmarkContract';
import type { BenchmarkPrediction } from '@/lib/evaluation/benchmark/benchmarkScoring';

/**
 * The machine side of the E3 benchmark.
 *
 * Runs the production extraction builders over one page and projects what they
 * produced into the benchmark's vocabulary. Provider-free: native parsing plus
 * whatever OCR geometry the caller supplies, no network and no database.
 *
 * An empty section here is a real answer -- the builders found nothing -- and
 * is scored as such. The one claim the run withholds is coverage, which is
 * null when the evidence cannot support any claim at all.
 *
 * Nothing here decides production eligibility.
 */

export type BenchmarkMachineRun = Readonly<{
  prediction: BenchmarkPrediction;
  /** Digest of the prediction alone: the determinism question. */
  predictionDigest: string;
  runtimeMs: number;
  pageSource: PdfLayoutPage['source'];
  nativeTokenCount: number;
  ocrTokenCount: number;
  /** Tokens dropped from the prediction because they carry no canonical geometry. */
  tokensWithoutCanonicalGeometry: number;
}>;

function toBenchmarkBox(box: Readonly<{
  coordinate_space: 'canonical_v1'; x_min: number; y_min: number; x_max: number; y_max: number;
}>): BenchmarkBox | null {
  return box.x_min < box.x_max && box.y_min < box.y_max ? box : null;
}

/** Union of several canonical boxes, which is how a cell's extent is derived from its tokens. */
function unionBox(boxes: readonly BenchmarkBox[]): BenchmarkBox | null {
  if (boxes.length === 0) return null;
  return {
    coordinate_space: 'canonical_v1',
    x_min: Math.min(...boxes.map((box) => box.x_min)),
    y_min: Math.min(...boxes.map((box) => box.y_min)),
    x_max: Math.max(...boxes.map((box) => box.x_max)),
    y_max: Math.max(...boxes.map((box) => box.y_max)),
  };
}

/**
 * The run's coverage claim, derived from which extractor actually reached the
 * page. It is a claim about this run, measured against the human's reading of
 * the page; it is never copied from a coverage layer's own verdict.
 */
function coverageClaim(page: PdfLayoutPage | undefined, ocrSupplied: boolean): string | null {
  if (!page) return null;
  const tokens = page.lines.flatMap((line) => line.tokens);
  const native = tokens.filter((token) => token.source !== 'ocr_fallback').length;
  const ocr = tokens.filter((token) => token.source === 'ocr_fallback').length;
  if (native > 0 && ocr > 0) return 'mixed_native_and_ocr';
  if (native > 0) return 'native_text_complete';
  if (ocr > 0) return 'requires_ocr';
  // No text at all: only a page with no OCR attempt left is honestly "empty".
  return ocrSupplied ? 'empty_page' : null;
}

export async function runBenchmarkMachinePass(input: Readonly<{
  bytes: ArrayBuffer;
  physicalPageNumber: number;
  /** OCR word geometry for this page, when a separate OCR run produced it. */
  ocrPages?: readonly OcrGeometryPage[];
}>): Promise<BenchmarkMachineRun> {
  const startedAt = Date.now();
  const native = await loadPdfLayout(input.bytes, {
    priorityPageNumbers: [input.physicalPageNumber],
    maxPages: input.physicalPageNumber,
  });
  const ocrPages = [...(input.ocrPages ?? [])];
  const layout = ocrPages.length > 0
    ? mergeOcrFallbackLayout({
        nativeLayout: native,
        ocrPages,
        ocrTextPageNumbers: ocrPages.map((page) => page.page_number),
        representation: 'reconciled_pdf_points',
      }).layout
    : native;
  const page = layout.pages.find((entry) => entry.page_number === input.physicalPageNumber);
  const tokens = page?.lines.flatMap((line) => line.tokens) ?? [];

  const words = tokens.flatMap((token) => {
    const box = token.canonical_bbox ? toBenchmarkBox(token.canonical_bbox) : null;
    return box ? [{ text: token.text, box }] : [];
  });

  // Cells and rows come from the priced-schedule reconstruction, which is the
  // only builder that claims table structure. Its cells are located through the
  // tokens they cite, so a cell's box is the union of its tokens' canonical
  // boxes rather than a second geometry path.
  const reconstruction = buildPagePricedScheduleReconstruction({ layout });
  const canonicalByText = new Map<string, BenchmarkBox[]>();
  for (const token of tokens) {
    const box = token.canonical_bbox ? toBenchmarkBox(token.canonical_bbox) : null;
    if (!box) continue;
    const key = `${token.observation_id ?? ''}|${token.text}|${token.x}|${token.y}`;
    canonicalByText.set(key, [...(canonicalByText.get(key) ?? []), box]);
  }
  const boxForRef = (ref: Readonly<{
    observation_id?: string; text: string; x_min: number; y_min: number;
  }>): BenchmarkBox | null => {
    const key = `${ref.observation_id ?? ''}|${ref.text}|${ref.x_min}|${ref.y_min}`;
    const exact = canonicalByText.get(key)?.[0];
    if (exact) return exact;
    // Fall back to the token carrying the same id, which is the durable link.
    const token = tokens.find((entry) => ref.observation_id && entry.observation_id === ref.observation_id);
    return token?.canonical_bbox ? toBenchmarkBox(token.canonical_bbox) : null;
  };

  const reconstructedPage = reconstruction.pages
    .find((entry) => entry.physical_page_number === input.physicalPageNumber);
  const cells: Array<{ text: string; box: BenchmarkBox; isHeader: boolean; columnName: string | null }> = [];
  const rows: Array<{ orderedCellBoxes: BenchmarkBox[] }> = [];
  for (const row of reconstructedPage?.rows ?? []) {
    const rowBoxes: BenchmarkBox[] = [];
    for (const cell of row.cells) {
      const boxes = cell.source_refs.flatMap((ref) => {
        const box = boxForRef(ref);
        return box ? [box] : [];
      });
      const box = unionBox(boxes);
      if (!box) continue;
      cells.push({
        text: cell.raw_text,
        box,
        // The reconstruction emits body cells; its header row is consumed as
        // column geometry rather than published as cells, so this run makes no
        // header claim and header accuracy will show that.
        isHeader: false,
        columnName: cell.role ?? null,
      });
      rowBoxes.push(box);
    }
    if (rowBoxes.length > 0) rows.push({ orderedCellBoxes: rowBoxes });
  }

  const prediction: BenchmarkPrediction = Object.freeze({
    words: Object.freeze(words),
    cells: Object.freeze(cells),
    rows: Object.freeze(rows),
    coverage: coverageClaim(page, ocrPages.length > 0),
  });

  return Object.freeze({
    prediction,
    predictionDigest: hashCanonical(prediction),
    runtimeMs: Date.now() - startedAt,
    pageSource: page?.source,
    nativeTokenCount: tokens.filter((token) => token.source !== 'ocr_fallback').length,
    ocrTokenCount: tokens.filter((token) => token.source === 'ocr_fallback').length,
    tokensWithoutCanonicalGeometry: tokens.filter((token) => !token.canonical_bbox).length,
  });
}
