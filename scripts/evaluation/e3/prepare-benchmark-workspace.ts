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
  buildBenchmarkWorkspaceManifest,
  type BenchmarkWorkspacePage,
} from '@/lib/evaluation/benchmark/benchmarkWorkspace';
import { runBenchmarkMachinePass } from '@/lib/evaluation/benchmark/benchmarkMachineRun';
import { buildBenchmarkSuggestions } from '@/lib/evaluation/benchmark/benchmarkSuggestions';
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
 *     --out .benchmark-workspace [--page golden-p8] [--scale 2] [--suggestions]
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

async function main() {
  const outDirectory = path.resolve(argument('out') ?? '.benchmark-workspace');
  const scale = Number(argument('scale') ?? RENDER_SCALE_DEFAULT);
  if (!Number.isFinite(scale) || scale <= 0) fail('--scale must be a positive number');
  const only = argument('page') as BenchmarkPageKey | null;
  const withSuggestions = process.argv.includes('--suggestions');
  const selected = only ? BENCHMARK_PAGES.filter((page) => page.pageKey === only) : BENCHMARK_PAGES;
  if (selected.length === 0) fail(`unknown --page ${only}`);

  const toolSource = path.resolve('lib/evaluation/benchmark/workspace/labelTool.html');
  const toolStateSource = path.resolve('lib/evaluation/benchmark/workspace/labelToolState.mjs');
  const tool = await readFile(toolSource, 'utf8');
  const toolState = await readFile(toolStateSource, 'utf8');
  const pages: BenchmarkWorkspacePage[] = [];

  for (const page of selected) {
    const sourcePath = resolveSourcePath(page);
    const bytes = await readFile(sourcePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== page.sha256) {
      fail(`${page.pageKey}: source bytes are not the pinned corpus (${sha256})`);
    }
    const rendered = await renderPage(bytes, page.physicalPageNumber, scale);
    const pageDirectory = path.join(outDirectory, page.pageKey);
    await mkdir(pageDirectory, { recursive: true });

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
    if (!existing) {
      await writeFile(labelsFile, `${JSON.stringify(buildBenchmarkLabelTemplate({
        pageKey: page.pageKey,
        documentKey: page.documentKey,
        sha256,
        byteLength: bytes.byteLength,
        physicalPageNumber: page.physicalPageNumber,
        frame: source.frame,
      }), null, 2)}\n`, 'utf8');
    }

    await writeFile(path.join(pageDirectory, BENCHMARK_WORKSPACE_FILES.render), rendered.png);
    await writeFile(path.join(pageDirectory, BENCHMARK_WORKSPACE_FILES.frame),
      `${JSON.stringify(source.frame, null, 2)}\n`, 'utf8');
    await writeFile(path.join(pageDirectory, BENCHMARK_WORKSPACE_FILES.tool), tool, 'utf8');
    await writeFile(path.join(pageDirectory, BENCHMARK_WORKSPACE_FILES.toolState), toolState, 'utf8');

    if (withSuggestions) {
      const sourceBytes = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const run = await runBenchmarkMachinePass({
        bytes: sourceBytes,
        physicalPageNumber: page.physicalPageNumber,
      });
      const suggestions = buildBenchmarkSuggestions({ source, run });
      await writeFile(path.join(pageDirectory, BENCHMARK_WORKSPACE_FILES.suggestions),
        `${JSON.stringify(suggestions, null, 2)}\n`, 'utf8');
      console.log(`[e3-workspace] ${page.pageKey}: wrote provisional suggestions from benchmark machine pass`
        + ` (${suggestions.words.length} words, ${suggestions.cells.length} cells,`
        + ` ${suggestions.rows.length} rows; native=${run.nativeTokenCount}, ocr=${run.ocrTokenCount})`);
    }

    pages.push({
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
    });
    console.log(`[e3-workspace] ${page.pageKey}: ${existing ? `kept existing labels (${existing.state})` : 'wrote empty label template'}`
      + `, render ${rendered.pixelWidth}x${rendered.pixelHeight}px, frame ${source.frame.width}x${source.frame.height}pt`
      + ` rotation ${source.frame.rotation}`);
  }

  const manifest = buildBenchmarkWorkspaceManifest({ pages, generatedAt: new Date().toISOString() });
  await mkdir(outDirectory, { recursive: true });
  await writeFile(path.join(outDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDirectory, BENCHMARK_WORKSPACE_FILES.readme),
    `${benchmarkWorkspaceReadme(manifest)}\n`, 'utf8');
  console.log(`[e3-workspace] workspace ready at ${outDirectory}`);
  console.log('[e3-workspace] no human label was generated; suggestions, when requested, are separate and provisional');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
