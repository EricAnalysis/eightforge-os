import type { BenchmarkMachineRun } from '@/lib/evaluation/benchmark/benchmarkMachineRun';
import { runBenchmarkMachinePass } from '@/lib/evaluation/benchmark/benchmarkMachineRun';
import type { BenchmarkPageLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import type { OcrGeometryPage } from '@/lib/extraction/pdf/ocrGeometryLayout';

export const BENCHMARK_LOCAL_OCR_IMPLEMENTATION =
  'documentExtraction.extractPdfPageTextViaOcr' as const;

export type BenchmarkLocalOcrGeneration = Readonly<{
  mode: 'existing_local_ocr';
  implementation: typeof BENCHMARK_LOCAL_OCR_IMPLEMENTATION;
  engine: 'tesseract.js';
  language: 'eng';
  pageSegmentationMode: '11';
  renderScale: 2;
  outcome: 'tokens_produced' | 'completed_zero_tokens';
  representationKeys: readonly string[];
}>;

type LocalOcrResult = Readonly<{
  geometryPages: readonly OcrGeometryPage[];
  pagesAttempted: number;
  totalPhysicalPages: number | null;
  failure: Readonly<{
    kind: 'ocr_execution_failed' | 'ocr_input_or_render_unavailable';
    detail: string;
  }> | null;
  pageImages?: readonly Readonly<{ page_number: number }>[];
  decodeInspections?: readonly Readonly<{
    page_number: number;
    inspection: Readonly<{ state: string }>;
  }>[];
}>;

type Dependencies = Readonly<{
  runMachinePass: typeof runBenchmarkMachinePass;
  runLocalOcr: (bytes: ArrayBuffer, opts: Readonly<{
    pageNumbers: number[];
    recognitionPageNumbers: number[];
  }>) => Promise<LocalOcrResult>;
}>;

const defaultDependencies: Dependencies = {
  runMachinePass: runBenchmarkMachinePass,
  runLocalOcr: async (bytes, opts) => {
    const { extractPdfPageTextViaOcr } = await import('@/lib/server/documentExtraction');
    return extractPdfPageTextViaOcr(bytes, opts);
  },
};

export class BenchmarkLocalOcrError extends Error {
  constructor(
    readonly code:
      | 'ocr_execution_failed'
      | 'ocr_input_or_render_unavailable'
      | 'ocr_zero_tokens_for_required_page',
    detail: string,
  ) {
    super(`BENCHMARK_LOCAL_OCR_${code.toUpperCase()}: ${detail}`);
    this.name = 'BenchmarkLocalOcrError';
  }
}

/**
 * Runs the normal provider-free benchmark pass, optionally preceded by the
 * existing local Tesseract geometry path. OCR remains an explicit CLI choice
 * and its output is handed to the same E2 canonical merge used everywhere
 * else; this adapter never constructs labels.
 */
export async function runBenchmarkSuggestionPass(input: Readonly<{
  bytes: ArrayBuffer;
  physicalPageNumber: number;
  pageFrame?: BenchmarkPageLabels['frame'];
  localOcr: boolean;
  requireOcrTokens?: boolean;
}>, dependencies: Dependencies = defaultDependencies): Promise<Readonly<{
  run: BenchmarkMachineRun;
  localOcrGeneration: BenchmarkLocalOcrGeneration | null;
  localOcrRuntimeMs: number | null;
}>> {
  if (!input.localOcr) {
    return {
      run: await dependencies.runMachinePass({
        bytes: input.bytes,
        physicalPageNumber: input.physicalPageNumber,
        pageFrame: input.pageFrame,
      }),
      localOcrGeneration: null,
      localOcrRuntimeMs: null,
    };
  }

  const startedAt = Date.now();
  const result = await dependencies.runLocalOcr(input.bytes, {
    pageNumbers: [input.physicalPageNumber],
    recognitionPageNumbers: [input.physicalPageNumber],
  });
  const localOcrRuntimeMs = Date.now() - startedAt;
  if (result.failure) {
    throw new BenchmarkLocalOcrError(result.failure.kind, result.failure.detail);
  }

  const inspection = result.decodeInspections?.find(
    (entry) => entry.page_number === input.physicalPageNumber,
  )?.inspection;
  if (inspection && inspection.state !== 'clean') {
    throw new BenchmarkLocalOcrError('ocr_input_or_render_unavailable',
      `physical page ${input.physicalPageNumber} render decode state was ${inspection.state}`);
  }
  if (!result.pageImages?.some((page) => page.page_number === input.physicalPageNumber)) {
    throw new BenchmarkLocalOcrError('ocr_input_or_render_unavailable',
      `physical page ${input.physicalPageNumber} produced no OCR render`);
  }
  if (result.pagesAttempted < 1) {
    throw new BenchmarkLocalOcrError('ocr_execution_failed',
      `physical page ${input.physicalPageNumber} was rendered but not recognized`);
  }

  const ocrPages = result.geometryPages.filter(
    (page) => page.page_number === input.physicalPageNumber,
  );
  const run = await dependencies.runMachinePass({
    bytes: input.bytes,
    physicalPageNumber: input.physicalPageNumber,
    ocrPages,
    pageFrame: input.pageFrame,
  });
  if (input.requireOcrTokens && run.ocrTokenCount === 0) {
    throw new BenchmarkLocalOcrError('ocr_zero_tokens_for_required_page',
      `local OCR completed for physical page ${input.physicalPageNumber} but produced zero canonical tokens`);
  }

  return {
    run,
    localOcrRuntimeMs,
    localOcrGeneration: {
      mode: 'existing_local_ocr',
      implementation: BENCHMARK_LOCAL_OCR_IMPLEMENTATION,
      engine: 'tesseract.js',
      language: 'eng',
      pageSegmentationMode: '11',
      renderScale: 2,
      outcome: run.ocrTokenCount > 0 ? 'tokens_produced' : 'completed_zero_tokens',
      representationKeys: ocrPages.flatMap((page) => page.representation_key ?? []),
    },
  };
}
