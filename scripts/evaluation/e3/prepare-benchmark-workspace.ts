import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BENCHMARK_PAGES,
  buildBenchmarkLabelTemplate,
  parseBenchmarkLabels,
  bindBenchmarkLabels,
  type BenchmarkPageKey,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  BENCHMARK_WORKSPACE_FILES,
  benchmarkWorkspaceReadme,
  mergeBenchmarkWorkspaceManifest,
  parseBenchmarkWorkspaceManifest,
  type BenchmarkWorkspaceManifest,
  type BenchmarkWorkspacePage,
} from '@/lib/evaluation/benchmark/benchmarkWorkspace';
import { buildBenchmarkSuggestions } from '@/lib/evaluation/benchmark/benchmarkSuggestions';
import { runBenchmarkSuggestionPass } from '@/lib/evaluation/benchmark/benchmarkSuggestionRun';
import { buildCanonicalPageFrame } from '@/lib/extraction/geometry/canonicalPageFrame';

/**
 * Prepares the E3 human labeling workspace.
 *
 * Provider-free and read-only with respect to the corpus: it renders each
 * benchmark page, records the page's canonical frame, and writes an EMPTY
 * label file. It never writes a label value and never overwrites a labels.json
 * that already exists. With --suggestions it separately writes provisional,
 * non-authoritative output from the provider-free benchmark machine pass.
 *
 *   npx vite-node --config vitest.config.ts scripts/evaluation/e3/prepare-benchmark-workspace.ts -- \
 *     --out .benchmark-workspace [--page golden-p8] [--scale 2] [--suggestions [--local-ocr]]
 */

const RENDER_SCALE_DEFAULT = 2;

function fail(message: string): never {
  console.error(`[e3-workspace] ${message}`);
  process.exit(1);
}

function argument(name: string): string | null {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]!;
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

function resolveSourcePath(page: (typeof BENCHMARK_PAGES)[number]): string {
  const configured = process.env[page.sourceEnvVar]?.trim();
  if (!configured) {
    fail(`${page.pageKey}: ${page.sourceEnvVar} is not set. This harness never invents a path.`);
  }
  return page.sourceRelativePath
    ? path.join(path.resolve(configured), page.sourceRelativePath)
    : path.resolve(configured);
}

async function renderPage(bytes: Buffer, physicalPageNumber: number, scale: number) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  if (physicalPageNumber > document.numPages) {
    fail(`page ${physicalPageNumber} does not exist in a ${document.numPages}-page source`);
  }
  const page = await document.getPage(physicalPageNumber);
  const frame = buildCanonicalPageFrame({
    view: (page as unknown as { view: number[] }).view,
    rotation: (page as unknown as { rotate: number }).rotate,
    userUnit: (page as unknown as { userUnit?: number }).userUnit,
  });
  if (!frame) fail(`page ${physicalPageNumber}: the canonical page frame could not be established`);
  const viewport = page.getViewport({ scale });
  const pixelWidth = Math.floor(viewport.width);
  const pixelHeight = Math.floor(viewport.height);
  const canvas = createCanvas(pixelWidth, pixelHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pixelWidth, pixelHeight);
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  return { frame, png: canvas.toBuffer('image/png'), pixelWidth, pixelHeight };
}

async function existingLabels(file: string, source: Readonly<{
  pageKey: string; sha256: string; byteLength: number; physicalPageNumber: number;
  frame: BenchmarkPageLabels['frame'];
}>) {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  // Human work is never silently discarded, and never silently accepted either:
  // it must still bind to the same bytes, page and frame.
  const parsed = parseBenchmarkLabels(raw);
  return bindBenchmarkLabels(parsed, source);
}

async function existingManifest(file: string): Promise<BenchmarkWorkspaceManifest | null> {
  try {
    return parseBenchmarkWorkspaceManifest(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

type PreparedWorkspacePage = Readonly<{
  page: BenchmarkWorkspacePage;
  directory: string;
  png: Buffer;
  frameJson: string;
  labelsTemplate: string | null;
  suggestionsJson: string | null;
  suggestionSummary: string | null;
  existingLabelState: BenchmarkWorkspacePage['labelState'] | null;
}>;

async function main() {
  const outDirectory = path.resolve(argument('out') ?? '.benchmark-workspace');
  const scale = Number(argument('scale') ?? RENDER_SCALE_DEFAULT);
  if (!Number.isFinite(scale) || scale <= 0) fail('--scale must be a positive number');
  const only = argument('page') as BenchmarkPageKey | null;
  const withSuggestions = process.argv.includes('--suggestions');
  const withLocalOcr = process.argv.includes('--local-ocr');
  if (withLocalOcr && !withSuggestions) fail('--local-ocr requires --suggestions');
  const selected = only ? BENCHMARK_PAGES.filter((page) => page.pageKey === only) : BENCHMARK_PAGES;
  if (selected.length === 0) fail(`unknown --page ${only}`);
  const manifestFile = path.join(outDirectory, 'manifest.json');
  const previousManifest = await existingManifest(manifestFile);
  if (only && !previousManifest) {
    fail('page-specific preparation requires an existing complete manifest; run without --page first');
  }

  const toolSource = path.resolve('lib/evaluation/benchmark/workspace/labelTool.html');
  const toolStateSource = path.resolve('lib/evaluation/benchmark/workspace/labelToolState.mjs');
  const tool = await readFile(toolSource, 'utf8');
  const toolState = await readFile(toolStateSource, 'utf8');
  const prepared: PreparedWorkspacePage[] = [];

  for (const page of selected) {
    const sourcePath = resolveSourcePath(page);
    const bytes = await readFile(sourcePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== page.sha256) {
      fail(`${page.pageKey}: source bytes are not the pinned corpus (${sha256})`);
    }
    const rendered = await renderPage(bytes, page.physicalPageNumber, scale);
    const pageDirectory = path.join(outDirectory, page.pageKey);

    const source = {
      pageKey: page.pageKey,
      documentKey: page.documentKey,
      sha256,
      byteLength: bytes.byteLength,
      physicalPageNumber: page.physicalPageNumber,
      frame: rendered.frame as unknown as BenchmarkPageLabels['frame'],
    };
    const labelsFile = path.join(pageDirectory, BENCHMARK_WORKSPACE_FILES.labels);
    const existing = await existingLabels(labelsFile, source);
    const labelsTemplate = existing ? null : `${JSON.stringify(buildBenchmarkLabelTemplate({
        pageKey: page.pageKey,
        documentKey: page.documentKey,
        sha256,
        byteLength: bytes.byteLength,
        physicalPageNumber: page.physicalPageNumber,
        frame: source.frame,
      }), null, 2)}\n`;

    let suggestionsJson: string | null = null;
    let suggestionSummary: string | null = null;
    if (withSuggestions) {
      const sourceBytes = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const pass = await runBenchmarkSuggestionPass({
        bytes: sourceBytes,
        physicalPageNumber: page.physicalPageNumber,
        pageFrame: source.frame,
        localOcr: withLocalOcr,
        requireOcrTokens: withLocalOcr
          && (page.characterization === 'ocr_price_sheet'
            || page.characterization === 'dense_scanned_ocr_priced_schedule'),
      });
      const suggestions = buildBenchmarkSuggestions({
        source,
        run: pass.run,
        localOcrGeneration: pass.localOcrGeneration,
      });
      suggestionsJson = `${JSON.stringify(suggestions, null, 2)}\n`;
      suggestionSummary = `[e3-workspace] ${page.pageKey}: wrote provisional suggestions from benchmark machine pass`
        + ` (${suggestions.words.length} words, ${suggestions.cells.length} cells,`
        + ` ${suggestions.rows.length} rows; native=${pass.run.nativeTokenCount}, ocr=${pass.run.ocrTokenCount}`
        + `${pass.localOcrRuntimeMs == null ? '' : `, local-ocr-ms=${pass.localOcrRuntimeMs}`})`;
    }

    prepared.push({
      page: {
        pageKey: page.pageKey,
        documentKey: page.documentKey,
        characterization: page.characterization,
        sha256,
        byteLength: bytes.byteLength,
        physicalPageNumber: page.physicalPageNumber,
        frame: source.frame,
        render: {
          file: BENCHMARK_WORKSPACE_FILES.render,
          scale,
          pixelWidth: rendered.pixelWidth,
          pixelHeight: rendered.pixelHeight,
        },
        labelsFile: BENCHMARK_WORKSPACE_FILES.labels,
        labelState: existing?.state ?? 'unlabeled',
      },
      directory: pageDirectory,
      png: rendered.png,
      frameJson: `${JSON.stringify(source.frame, null, 2)}\n`,
      labelsTemplate,
      suggestionsJson,
      suggestionSummary,
      existingLabelState: existing?.state ?? null,
    });
  }

  const manifest = mergeBenchmarkWorkspaceManifest({
    existingManifest: previousManifest,
    preparedPages: prepared.map((entry) => entry.page),
    generatedAt: new Date().toISOString(),
  });

  for (const output of prepared) {
    await mkdir(output.directory, { recursive: true });
    if (output.labelsTemplate !== null) {
      await writeFile(path.join(output.directory, BENCHMARK_WORKSPACE_FILES.labels),
        output.labelsTemplate, 'utf8');
    }
    await writeFile(path.join(output.directory, BENCHMARK_WORKSPACE_FILES.render), output.png);
    await writeFile(path.join(output.directory, BENCHMARK_WORKSPACE_FILES.frame),
      output.frameJson, 'utf8');
    await writeFile(path.join(output.directory, BENCHMARK_WORKSPACE_FILES.tool), tool, 'utf8');
    await writeFile(path.join(output.directory, BENCHMARK_WORKSPACE_FILES.toolState), toolState, 'utf8');
    if (output.suggestionsJson !== null) {
      await writeFile(path.join(output.directory, BENCHMARK_WORKSPACE_FILES.suggestions),
        output.suggestionsJson, 'utf8');
    }
    if (output.suggestionSummary) console.log(output.suggestionSummary);
    console.log(`[e3-workspace] ${output.page.pageKey}: ${output.existingLabelState
      ? `kept existing labels (${output.existingLabelState})`
      : 'wrote empty label template'}`
      + `, render ${output.page.render.pixelWidth}x${output.page.render.pixelHeight}px,`
      + ` frame ${output.page.frame.width}x${output.page.frame.height}pt`
      + ` rotation ${output.page.frame.rotation}`);
  }

  await mkdir(outDirectory, { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDirectory, BENCHMARK_WORKSPACE_FILES.readme),
    `${benchmarkWorkspaceReadme(manifest)}\n`, 'utf8');
  console.log(`[e3-workspace] workspace ready at ${outDirectory}`);
  console.log('[e3-workspace] no human label was generated; suggestions, when requested, are separate and provisional');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
