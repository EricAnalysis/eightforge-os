import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BENCHMARK_PAGES,
  BENCHMARK_WORKSPACE_VERSION,
  bindBenchmarkLabels,
  parseBenchmarkLabels,
  type BenchmarkPageKey,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import { BENCHMARK_WORKSPACE_FILES } from '@/lib/evaluation/benchmark/benchmarkWorkspace';
import { hashCanonical } from '@/lib/extraction/domain/hash';

export const BENCHMARK_REVIEW_PACK_VERSION = 'extraction-benchmark-review-pack-v1' as const;

export const BENCHMARK_REVIEW_PACK_FILES = Object.freeze({
  render: 'page.png',
  labels: 'labels.json',
  summary: 'review-summary.json',
});

const REVIEW_PAGE_FILE_ALLOWLIST = new Set<string>(Object.values(BENCHMARK_REVIEW_PACK_FILES));

type WorkspaceManifestPage = Readonly<{
  pageKey: BenchmarkPageKey;
  documentKey: string;
  sha256: string;
  byteLength: number;
  physicalPageNumber: number;
  frame: BenchmarkPageLabels['frame'];
  render: Readonly<{ file: string }>;
  labelsFile: string;
}>;

type ReviewPageSnapshot = Readonly<{
  page: WorkspaceManifestPage;
  renderBytes: Buffer;
  renderSha256: string;
  labelsBytes: Buffer;
  binding: ReturnType<typeof bindBenchmarkLabels>;
}>;

export type BenchmarkReviewSummary = Readonly<{
  reviewPackVersion: typeof BENCHMARK_REVIEW_PACK_VERSION;
  pageKey: BenchmarkPageKey;
  labels_status: 'unlabeled' | 'partial' | 'complete';
  source: Readonly<{
    sha256: string;
    byteLength: number;
    physicalPageNumber: number;
  }>;
  canonicalPage: Readonly<{
    coordinateSpace: 'canonical_v1';
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
  }>;
  confirmed: Readonly<{
    wordCount: number;
    cellCount: number;
    rowCount: number;
    coverageTruth: BenchmarkPageLabels['coverage']['truth'];
  }>;
  attribution: string | null;
  labelingTimestamp: string | null;
  files: Readonly<{
    page: typeof BENCHMARK_REVIEW_PACK_FILES.render;
    pageSha256: string;
    labels: typeof BENCHMARK_REVIEW_PACK_FILES.labels | null;
  }>;
}>;

export type BenchmarkReviewPackPage = Readonly<{
  pageKey: BenchmarkPageKey;
  directory: string;
  pageFile: string;
  labelsFile: string | null;
  summaryFile: string;
  summary: BenchmarkReviewSummary;
}>;

export class BenchmarkReviewPackError extends Error {
  constructor(detail: string) {
    super(`BENCHMARK_REVIEW_PACK_INVALID: ${detail}`);
    this.name = 'BenchmarkReviewPackError';
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BenchmarkReviewPackError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function manifestPages(raw: string): readonly Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BenchmarkReviewPackError('workspace manifest is not JSON');
  }
  const manifest = record(parsed, 'workspace manifest');
  if (manifest.workspaceVersion !== BENCHMARK_WORKSPACE_VERSION) {
    throw new BenchmarkReviewPackError('workspace manifest version differs');
  }
  if (!Array.isArray(manifest.pages)) {
    throw new BenchmarkReviewPackError('workspace manifest pages must be an array');
  }
  return manifest.pages.map((page, index) => record(page, `workspace manifest page ${index}`));
}

function selectManifestPage(
  pages: readonly Record<string, unknown>[],
  pageKey: BenchmarkPageKey,
): WorkspaceManifestPage {
  const frozen = BENCHMARK_PAGES.find((page) => page.pageKey === pageKey)!;
  const matches = pages.filter((page) => page.pageKey === pageKey);
  if (matches.length !== 1) {
    throw new BenchmarkReviewPackError(
      `${pageKey}: expected exactly one workspace manifest entry, found ${matches.length}`,
    );
  }
  const page = matches[0]!;
  if (page.documentKey !== frozen.documentKey) {
    throw new BenchmarkReviewPackError(`${pageKey}: document key differs from the frozen corpus`);
  }
  if (page.sha256 !== frozen.sha256) {
    throw new BenchmarkReviewPackError(`${pageKey}: source sha256 differs from the frozen corpus`);
  }
  if (page.physicalPageNumber !== frozen.physicalPageNumber) {
    throw new BenchmarkReviewPackError(`${pageKey}: physical page number differs from the frozen corpus`);
  }
  if (!Number.isInteger(page.byteLength) || (page.byteLength as number) <= 0) {
    throw new BenchmarkReviewPackError(`${pageKey}: source byte length is invalid`);
  }
  const render = record(page.render, `${pageKey}: render`);
  if (render.file !== BENCHMARK_WORKSPACE_FILES.render) {
    throw new BenchmarkReviewPackError(`${pageKey}: workspace render filename differs`);
  }
  if (page.labelsFile !== BENCHMARK_WORKSPACE_FILES.labels) {
    throw new BenchmarkReviewPackError(`${pageKey}: workspace labels filename differs`);
  }
  const frame = record(page.frame, `${pageKey}: frame`) as BenchmarkPageLabels['frame'];
  return {
    pageKey,
    documentKey: frozen.documentKey,
    sha256: frozen.sha256,
    byteLength: page.byteLength as number,
    physicalPageNumber: frozen.physicalPageNumber,
    frame,
    render: { file: BENCHMARK_WORKSPACE_FILES.render },
    labelsFile: BENCHMARK_WORKSPACE_FILES.labels,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

async function loadReviewPage(
  workspaceDirectory: string,
  manifestPage: WorkspaceManifestPage,
): Promise<ReviewPageSnapshot> {
  const pageDirectory = path.join(workspaceDirectory, manifestPage.pageKey);
  let renderBytes: Buffer;
  let labelsBytes: Buffer;
  let frameBytes: Buffer;
  try {
    [renderBytes, labelsBytes, frameBytes] = await Promise.all([
      readFile(path.join(pageDirectory, BENCHMARK_WORKSPACE_FILES.render)),
      readFile(path.join(pageDirectory, BENCHMARK_WORKSPACE_FILES.labels)),
      readFile(path.join(pageDirectory, BENCHMARK_WORKSPACE_FILES.frame)),
    ]);
  } catch (error) {
    throw new BenchmarkReviewPackError(
      `${manifestPage.pageKey}: required workspace artifact is missing (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isPng(renderBytes)) {
    throw new BenchmarkReviewPackError(`${manifestPage.pageKey}: workspace render is not a PNG`);
  }
  const binding = bindBenchmarkLabels(parseBenchmarkLabels(labelsBytes), {
    pageKey: manifestPage.pageKey,
    sha256: manifestPage.sha256,
    byteLength: manifestPage.byteLength,
    physicalPageNumber: manifestPage.physicalPageNumber,
    frame: manifestPage.frame,
  });
  let frame: unknown;
  try {
    frame = JSON.parse(frameBytes.toString('utf8'));
  } catch {
    throw new BenchmarkReviewPackError(`${manifestPage.pageKey}: frame artifact is not JSON`);
  }
  if (hashCanonical(frame) !== hashCanonical(binding.labels.frame)) {
    throw new BenchmarkReviewPackError(`${manifestPage.pageKey}: frame artifact differs from bound labels`);
  }
  return {
    page: manifestPage,
    renderBytes,
    renderSha256: sha256(renderBytes),
    labelsBytes,
    binding,
  };
}

export function buildBenchmarkReviewSummary(snapshot: ReviewPageSnapshot): BenchmarkReviewSummary {
  const labels = snapshot.binding.labels;
  const hasConfirmedLabels = snapshot.binding.state !== 'unlabeled';
  return Object.freeze({
    reviewPackVersion: BENCHMARK_REVIEW_PACK_VERSION,
    pageKey: snapshot.page.pageKey,
    labels_status: snapshot.binding.state,
    source: Object.freeze({
      sha256: snapshot.page.sha256,
      byteLength: snapshot.page.byteLength,
      physicalPageNumber: snapshot.page.physicalPageNumber,
    }),
    canonicalPage: Object.freeze({
      coordinateSpace: labels.frame.coordinate_space,
      width: labels.frame.width,
      height: labels.frame.height,
      rotation: labels.frame.rotation,
    }),
    confirmed: Object.freeze({
      wordCount: labels.words.items.length,
      cellCount: labels.cells.items.length,
      rowCount: labels.rows.items.length,
      coverageTruth: labels.coverage.status === 'labeled' ? labels.coverage.truth : null,
    }),
    attribution: labels.labeledBy,
    labelingTimestamp: labels.labeledAt,
    files: Object.freeze({
      page: BENCHMARK_REVIEW_PACK_FILES.render,
      pageSha256: snapshot.renderSha256,
      labels: hasConfirmedLabels ? BENCHMARK_REVIEW_PACK_FILES.labels : null,
    }),
  });
}

async function assertReviewPageAllowlist(pageDirectory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(pageDirectory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  }
  const unexpected = entries.filter((entry) => !REVIEW_PAGE_FILE_ALLOWLIST.has(entry));
  if (unexpected.length > 0) {
    throw new BenchmarkReviewPackError(
      `${path.basename(pageDirectory)}: review output contains unexpected entries: ${unexpected.join(', ')}`,
    );
  }
}

async function writeReviewPage(
  outDirectory: string,
  snapshot: ReviewPageSnapshot,
): Promise<BenchmarkReviewPackPage> {
  const pageDirectory = path.join(outDirectory, snapshot.page.pageKey);
  await assertReviewPageAllowlist(pageDirectory);
  await mkdir(pageDirectory, { recursive: true });
  const pageFile = path.join(pageDirectory, BENCHMARK_REVIEW_PACK_FILES.render);
  const labelsFile = path.join(pageDirectory, BENCHMARK_REVIEW_PACK_FILES.labels);
  const summaryFile = path.join(pageDirectory, BENCHMARK_REVIEW_PACK_FILES.summary);
  const summary = buildBenchmarkReviewSummary(snapshot);

  // Both artifacts are written from the bytes that were validated above. No
  // workspace directory copy is used, so suggestions can never leak in.
  await writeFile(pageFile, snapshot.renderBytes);
  if (snapshot.binding.state === 'unlabeled') {
    await rm(labelsFile, { force: true });
  } else {
    await writeFile(labelsFile, snapshot.labelsBytes);
  }
  await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return Object.freeze({
    pageKey: snapshot.page.pageKey,
    directory: pageDirectory,
    pageFile,
    labelsFile: snapshot.binding.state === 'unlabeled' ? null : labelsFile,
    summaryFile,
    summary,
  });
}

export async function prepareBenchmarkReviewPack(input: Readonly<{
  workspaceDirectory: string;
  outDirectory: string;
  pageKeys?: readonly BenchmarkPageKey[];
}>): Promise<readonly BenchmarkReviewPackPage[]> {
  const workspaceDirectory = path.resolve(input.workspaceDirectory);
  const outDirectory = path.resolve(input.outDirectory);
  if (workspaceDirectory === outDirectory) {
    throw new BenchmarkReviewPackError('review output must differ from the labeling workspace');
  }
  const pageKeys = input.pageKeys ?? BENCHMARK_PAGES.map((page) => page.pageKey);
  if (pageKeys.length === 0 || new Set(pageKeys).size !== pageKeys.length) {
    throw new BenchmarkReviewPackError('requested pages must be non-empty and unique');
  }
  for (const pageKey of pageKeys) {
    if (!BENCHMARK_PAGES.some((page) => page.pageKey === pageKey)) {
      throw new BenchmarkReviewPackError(`unknown benchmark page ${pageKey}`);
    }
  }

  let manifestRaw: string;
  try {
    manifestRaw = await readFile(path.join(workspaceDirectory, 'manifest.json'), 'utf8');
  } catch (error) {
    throw new BenchmarkReviewPackError(
      `workspace manifest is missing (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const pages = manifestPages(manifestRaw);
  // Load and validate every requested frozen page before writing any output.
  const snapshots = await Promise.all(pageKeys.map((pageKey) =>
    loadReviewPage(workspaceDirectory, selectManifestPage(pages, pageKey))));
  const written: BenchmarkReviewPackPage[] = [];
  for (const snapshot of snapshots) written.push(await writeReviewPage(outDirectory, snapshot));
  return Object.freeze(written);
}
