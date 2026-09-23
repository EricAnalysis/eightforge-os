import { describe, expect, it, vi } from 'vitest';

import { runBenchmarkMachinePass } from '@/lib/evaluation/benchmark/benchmarkMachineRun';
import {
  BENCHMARK_LOCAL_OCR_IMPLEMENTATION,
  runBenchmarkSuggestionPass,
} from '@/lib/evaluation/benchmark/benchmarkSuggestionRun';
import { buildSyntheticPdf } from '@/lib/extraction/geometry/__fixtures__/syntheticPdf';

const bytes = () => buildSyntheticPdf([{ mediaBox: [0, 0, 612, 792], runs: [] }]);
const FRAME = {
  frame_version: 'canonical_frame_v1' as const,
  coordinate_space: 'canonical_v1' as const,
  view: [0, 0, 612, 792] as [number, number, number, number],
  rotation: 0 as const,
  user_unit: 1,
  width: 612,
  height: 792,
};

const completedOcr = (words: Array<{
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}> = []) => ({
  geometryPages: words.length > 0 ? [{
    page_number: 1,
    width: 1224,
    height: 1584,
    representation_key: 'tesseract:eng:psm11:pdfjs-scale2:render-sha',
    words,
  }] : [],
  pagesAttempted: 1,
  totalPhysicalPages: 1,
  failure: null,
  pageImages: [{ page_number: 1 }],
  decodeInspections: [{ page_number: 1, inspection: { state: 'clean' } }],
});

describe('benchmark local OCR suggestion pass', () => {
  it('keeps default suggestion generation provider-free without invoking OCR', async () => {
    const runLocalOcr = vi.fn(async (
      bytesArg: ArrayBuffer,
      optsArg: { pageNumbers: number[]; recognitionPageNumbers: number[] },
    ) => {
      void bytesArg;
      void optsArg;
      return completedOcr();
    });
    const result = await runBenchmarkSuggestionPass({
      bytes: bytes(), physicalPageNumber: 1, localOcr: false,
    }, { runMachinePass: runBenchmarkMachinePass, runLocalOcr });

    expect(runLocalOcr).not.toHaveBeenCalled();
    expect(result.localOcrGeneration).toBeNull();
    expect(result.run.ocrTokenCount).toBe(0);
  }, 60_000);

  it('explicitly invokes the existing local OCR seam for only the selected page', async () => {
    const runLocalOcr = vi.fn(async (
      bytesArg: ArrayBuffer,
      optsArg: { pageNumbers: number[]; recognitionPageNumbers: number[] },
    ) => {
      void bytesArg;
      void optsArg;
      return completedOcr([{
        text: 'Exhibit', bbox: { x0: 100, y0: 200, x1: 220, y1: 240 },
      }]);
    });
    const result = await runBenchmarkSuggestionPass({
      // An OCR-only page may be absent from the native layout when pdf.js text
      // inspection fails. The exact workspace frame keeps E2 conversion bound.
      bytes: new ArrayBuffer(0), physicalPageNumber: 1, pageFrame: FRAME,
      localOcr: true, requireOcrTokens: true,
    }, { runMachinePass: runBenchmarkMachinePass, runLocalOcr });

    expect(runLocalOcr).toHaveBeenCalledOnce();
    expect(runLocalOcr.mock.calls[0]?.[1]).toEqual({
      pageNumbers: [1], recognitionPageNumbers: [1],
    });
    expect(result.localOcrGeneration).toMatchObject({
      mode: 'existing_local_ocr',
      implementation: BENCHMARK_LOCAL_OCR_IMPLEMENTATION,
      engine: 'tesseract.js',
      outcome: 'tokens_produced',
    });
    expect(result.run.ocrTokenCount).toBe(1);
  }, 60_000);

  it('projects OCR render pixels through E2 into canonical_v1 suggestion geometry', async () => {
    const result = await runBenchmarkSuggestionPass({
      bytes: bytes(), physicalPageNumber: 1, localOcr: true, requireOcrTokens: true,
    }, {
      runMachinePass: runBenchmarkMachinePass,
      runLocalOcr: async () => completedOcr([{
        text: 'Rate', bbox: { x0: 100, y0: 200, x1: 200, y1: 240 },
      }]),
    });

    expect(result.run.prediction.words).toEqual([{
      text: 'Rate',
      box: {
        coordinate_space: 'canonical_v1',
        x_min: 50,
        y_min: 100,
        x_max: 100,
        y_max: 120,
      },
    }]);
  }, 60_000);

  it('distinguishes a local OCR failure from a legitimate zero-token result', async () => {
    const executionFailure = runBenchmarkSuggestionPass({
      bytes: bytes(), physicalPageNumber: 1, localOcr: true,
    }, {
      runMachinePass: runBenchmarkMachinePass,
      runLocalOcr: async () => ({
        ...completedOcr(), pagesAttempted: 0, pageImages: [],
        failure: { kind: 'ocr_execution_failed', detail: 'worker unavailable' },
      }),
    });
    await expect(executionFailure).rejects.toMatchObject({
      code: 'ocr_execution_failed',
    });

    const empty = await runBenchmarkSuggestionPass({
      bytes: bytes(), physicalPageNumber: 1, localOcr: true,
    }, { runMachinePass: runBenchmarkMachinePass, runLocalOcr: async () => completedOcr() });
    expect(empty.localOcrGeneration?.outcome).toBe('completed_zero_tokens');
    expect(empty.run.ocrTokenCount).toBe(0);

    await expect(runBenchmarkSuggestionPass({
      bytes: bytes(), physicalPageNumber: 1, localOcr: true, requireOcrTokens: true,
    }, { runMachinePass: runBenchmarkMachinePass, runLocalOcr: async () => completedOcr() }))
      .rejects.toMatchObject({
        code: 'ocr_zero_tokens_for_required_page',
      });
  }, 60_000);

  it('fails closed when the selected page render is unavailable or unverifiable', async () => {
    await expect(runBenchmarkSuggestionPass({
      bytes: bytes(), physicalPageNumber: 1, localOcr: true,
    }, {
      runMachinePass: runBenchmarkMachinePass,
      runLocalOcr: async () => ({
        ...completedOcr(), pagesAttempted: 0,
        decodeInspections: [{ page_number: 1, inspection: { state: 'unverifiable' } }],
      }),
    })).rejects.toMatchObject({
      code: 'ocr_input_or_render_unavailable',
    });
  }, 60_000);
});
