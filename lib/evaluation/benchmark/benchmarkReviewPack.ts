import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

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
export const BENCHMARK_SOURCE_BOUND_REVIEW_PACK_VERSION =
  'extraction-benchmark-source-bound-review-pack-v1' as const;
export const BENCHMARK_NATIVE_TEXT_EVIDENCE_VERSION =
  'e3-native-text-review-evidence-v1' as const;
export const BENCHMARK_SOURCE_BOUND_REVIEW_PACK_AUTHORITY =
  'non_authoritative_source_bound_reviewer_input' as const;
export const BENCHMARK_NATIVE_TEXT_EVIDENCE_AUTHORITY =
  'non_authoritative_source_evidence' as const;

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

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z.string().min(1).max(200).refine((value) => value.trim() === value,
  'identifier whitespace');
const sourceSchema = z.object({
  documentKey: identifierSchema,
  sha256: digestSchema,
  byteLength: z.number().int().positive(),
  physicalPageNumber: z.number().int().positive(),
}).strict();
const frameSchema = z.object({
  frame_version: z.literal('canonical_frame_v1'),
  coordinate_space: z.literal('canonical_v1'),
  view: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  user_unit: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
}).strict();

export const BenchmarkNativeTextEvidenceSchema = z.object({
  nativeTextEvidenceVersion: z.literal(BENCHMARK_NATIVE_TEXT_EVIDENCE_VERSION),
  authority: z.literal(BENCHMARK_NATIVE_TEXT_EVIDENCE_AUTHORITY),
  pageKey: identifierSchema,
  source: sourceSchema,
  frame: frameSchema,
  extractor: z.object({
    name: z.literal('pdfjs-dist getTextContent/getOperatorList'),
    version: z.string().min(1).max(100),
    disableWorker: z.literal(true),
    disableNormalization: z.literal(true),
  }).strict(),
  measurement: z.object({
    passes: z.number().int().min(2),
    repeatedMeasurementsExactMatch: z.literal(true),
    contentItemCount: z.number().int().nonnegative(),
    nonEmptyTextItemCount: z.number().int().positive(),
    pageImageXObjectCount: z.number().int().nonnegative(),
    imageMaskPaintCount: z.number().int().nonnegative(),
    nativeTextLayerPresent: z.literal(true),
  }).strict(),
  transcription: z.object({
    encoding: z.literal('pdfjs_text_content_items_with_eol_v1'),
    sha256: digestSchema,
    utf8ByteLength: z.number().int().nonnegative(),
    nonEmptyItemSequenceJoinDelimiter: z.literal('U+001F'),
    nonEmptyItemSequenceSha256: digestSchema,
    items: z.array(z.object({
      sourceContentItemIndex: z.number().int().nonnegative(),
      text: z.string(),
      hasEOL: z.boolean(),
      nonEmpty: z.boolean(),
      nonEmptyReadingOrder: z.number().int().nonnegative().nullable(),
    }).strict()).min(1).max(10_000),
  }).strict(),
  sourceDerivedTextBoxesIncluded: z.literal(false),
  sourceDerivedTextBoxesReason: z.string().min(1).max(1_000),
}).strict().superRefine((evidence, ctx) => {
  if (evidence.transcription.items.length !== evidence.measurement.contentItemCount) {
    ctx.addIssue({ code: 'custom', message: 'native transcription content item count differs' });
  }
  let nonEmptyReadingOrder = 0;
  for (const [sourceContentItemIndex, item] of evidence.transcription.items.entries()) {
    if (item.sourceContentItemIndex !== sourceContentItemIndex) {
      ctx.addIssue({ code: 'custom', message: 'native source item indexes are not contiguous' });
      break;
    }
    const nonEmpty = item.text.trim().length > 0;
    if (item.nonEmpty !== nonEmpty
        || item.nonEmptyReadingOrder !== (nonEmpty ? nonEmptyReadingOrder : null)) {
      ctx.addIssue({ code: 'custom', message: 'native non-empty reading order differs' });
      break;
    }
    if (nonEmpty) nonEmptyReadingOrder += 1;
  }
  if (nonEmptyReadingOrder !== evidence.measurement.nonEmptyTextItemCount) {
    ctx.addIssue({ code: 'custom', message: 'native non-empty transcription count differs' });
  }
  const transcription = evidence.transcription.items
    .map((item) => `${item.text}${item.hasEOL ? '\n' : ''}`).join('');
  if (Buffer.byteLength(transcription, 'utf8') !== evidence.transcription.utf8ByteLength
      || createHash('sha256').update(transcription).digest('hex')
        !== evidence.transcription.sha256) {
    ctx.addIssue({ code: 'custom', message: 'native transcription digest differs' });
  }
  const nonEmptySequence = evidence.transcription.items
    .filter((item) => item.nonEmpty).map((item) => item.text).join('\u001f');
  if (createHash('sha256').update(nonEmptySequence).digest('hex')
      !== evidence.transcription.nonEmptyItemSequenceSha256) {
    ctx.addIssue({ code: 'custom', message: 'native non-empty sequence digest differs' });
  }
});

const boundJsonFileSchema = z.object({
  path: z.string().min(1).max(500),
  fileSha256: digestSchema,
  canonicalSha256: digestSchema,
}).strict();
const sourceBoundReviewPackPayloadSchema = z.object({
  sourceBoundReviewPackVersion: z.literal(BENCHMARK_SOURCE_BOUND_REVIEW_PACK_VERSION),
  reviewPackVersion: z.literal(BENCHMARK_REVIEW_PACK_VERSION),
  authority: z.literal(BENCHMARK_SOURCE_BOUND_REVIEW_PACK_AUTHORITY),
  pageKey: identifierSchema,
  source: sourceSchema,
  frame: frameSchema,
  characterization: z.string().min(1).max(200),
  reviewerSchema: z.object({
    name: z.literal('BenchmarkReviewerLabelSetSchema'),
    version: z.string().min(1).max(200),
    authority: z.literal('non_authoritative_reviewer_proposal'),
    requiredIndependence: z.object({
      inputMode: z.literal('clean_source_page_only'),
      sawMachineSuggestions: z.literal(false),
      sawOtherReviewerLabels: z.literal(false),
    }).strict(),
  }).strict(),
  files: z.object({
    cleanRender: z.object({
      path: z.string().min(1).max(500),
      sha256: digestSchema,
      pixelWidth: z.number().int().positive(),
      pixelHeight: z.number().int().positive(),
    }).strict(),
    reviewSummary: boundJsonFileSchema,
    sourceLayerMeasurement: boundJsonFileSchema,
    nativeTextEvidence: boundJsonFileSchema,
    reviewerContext: boundJsonFileSchema,
  }).strict(),
  sharedReviewerInstruction: z.string().min(1).max(10_000),
  semanticScope: z.object({
    words: z.literal(true),
    cells: z.literal(true),
    rows: z.literal(true),
    coverage: z.literal(true),
    geometry: z.literal(false),
  }).strict(),
  sameFrozenInputForBothReviewers: z.literal(true),
  expectedOutputs: z.object({
    reviewerA: z.string().min(1).max(500),
    reviewerB: z.string().min(1).max(500),
  }).strict(),
  contaminationBoundary: z.object({
    p107SemanticPayloadIncluded: z.literal(false),
    productionExtractionIncluded: z.literal(false),
    historicalP106ExtractionIncluded: z.literal(false),
    ambiguousRowDiagnosticsIncluded: z.literal(false),
    baselineMachinePredictionsIncluded: z.literal(false),
    benchmarkTruthIncluded: z.literal(false),
    machineSuggestionsIncluded: z.literal(false),
    ocrOutputIncluded: z.literal(false),
    geometryAuthorityIncluded: z.literal(false),
  }).strict(),
}).strict();

export const BenchmarkSourceBoundReviewPackSchema = sourceBoundReviewPackPayloadSchema.extend({
  packCanonicalSha256: digestSchema,
}).strict().superRefine((pack, ctx) => {
  const { packCanonicalSha256, ...payload } = pack;
  if (hashCanonical(payload) !== packCanonicalSha256) {
    ctx.addIssue({ code: 'custom', message: 'source-bound review pack digest differs' });
  }
});

export type BenchmarkNativeTextEvidence = z.infer<typeof BenchmarkNativeTextEvidenceSchema>;
export type BenchmarkSourceBoundReviewPack = z.infer<typeof BenchmarkSourceBoundReviewPackSchema>;

export function buildBenchmarkSourceBoundReviewPack(
  input: z.input<typeof sourceBoundReviewPackPayloadSchema>,
): BenchmarkSourceBoundReviewPack {
  const payload = sourceBoundReviewPackPayloadSchema.parse(input);
  return BenchmarkSourceBoundReviewPackSchema.parse({
    ...payload,
    packCanonicalSha256: hashCanonical(payload),
  });
}

export function parseBenchmarkNativeTextEvidence(value: unknown): BenchmarkNativeTextEvidence {
  return BenchmarkNativeTextEvidenceSchema.parse(value);
}

export function parseBenchmarkSourceBoundReviewPack(value: unknown): BenchmarkSourceBoundReviewPack {
  return BenchmarkSourceBoundReviewPackSchema.parse(value);
}

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
