import { z } from 'zod';

import {
  BENCHMARK_PAGES,
  BENCHMARK_WORKSPACE_VERSION,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import { hashCanonical } from '@/lib/extraction/domain/hash';

/**
 * E3 labeling workspace description.
 *
 * Pure: this module decides what a workspace contains and what it is bound to.
 * File IO belongs to the preparation script. The workspace holds a rendered
 * page, the page's canonical frame, and an empty label file. Optional machine
 * suggestions are a separate, provisional artifact and never become labels
 * without an explicit human action.
 */

export const BENCHMARK_WORKSPACE_FILES = {
  render: 'page.png',
  labels: 'labels.json',
  suggestions: 'suggestions.json',
  frame: 'frame.json',
  readme: 'README.md',
  tool: 'label-tool.html',
  toolState: 'labelToolState.mjs',
} as const;

export type BenchmarkWorkspacePage = Readonly<{
  pageKey: string;
  documentKey: string;
  characterization: string;
  sha256: string;
  byteLength: number;
  physicalPageNumber: number;
  frame: BenchmarkPageLabels['frame'];
  render: Readonly<{
    file: string;
    /** Render scale relative to canonical points, so a labeler's pixels convert exactly. */
    scale: number;
    pixelWidth: number;
    pixelHeight: number;
  }>;
  labelsFile: string;
  labelState: 'unlabeled' | 'partial' | 'complete';
}>;

export type BenchmarkWorkspaceManifest = Readonly<{
  workspaceVersion: typeof BENCHMARK_WORKSPACE_VERSION;
  generatedAt: string;
  pages: readonly BenchmarkWorkspacePage[];
  /** What a human is being asked for, in the order the tool asks for it. */
  requiredLabels: readonly string[];
  notes: readonly string[];
}>;

const WorkspaceFrameSchema = z.object({
  frame_version: z.literal('canonical_frame_v1'),
  coordinate_space: z.literal('canonical_v1'),
  view: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  user_unit: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
}).strict();

const BenchmarkWorkspacePageSchema = z.object({
  pageKey: z.string().min(1),
  documentKey: z.string().min(1),
  characterization: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive(),
  physicalPageNumber: z.number().int().positive(),
  frame: WorkspaceFrameSchema,
  render: z.object({
    file: z.string().min(1),
    scale: z.number().positive(),
    pixelWidth: z.number().int().positive(),
    pixelHeight: z.number().int().positive(),
  }).strict(),
  labelsFile: z.string().min(1),
  labelState: z.enum(['unlabeled', 'partial', 'complete']),
}).strict();

const BenchmarkWorkspaceManifestSchema = z.object({
  workspaceVersion: z.literal(BENCHMARK_WORKSPACE_VERSION),
  generatedAt: z.string().datetime({ offset: true }),
  pages: z.array(BenchmarkWorkspacePageSchema),
  requiredLabels: z.array(z.string()),
  notes: z.array(z.string()),
}).strict();

type BenchmarkPageRegistration = Readonly<{
  pageKey: string;
  documentKey: string;
  characterization: string;
  sha256: string;
  physicalPageNumber: number;
}>;

export function assertBenchmarkPageRegistry(
  registry: readonly BenchmarkPageRegistration[] = BENCHMARK_PAGES,
): void {
  const keys = registry.map((page) => page.pageKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error('benchmark page registry contains duplicate page keys');
  }
}

function canonicalizeWorkspacePages(input: Readonly<{
  pages: readonly BenchmarkWorkspacePage[];
  requireComplete: boolean;
  normalizeCharacterization: boolean;
}>): BenchmarkWorkspacePage[] {
  assertBenchmarkPageRegistry();
  const registryByKey = new Map<string, (typeof BENCHMARK_PAGES)[number]>(
    BENCHMARK_PAGES.map((page) => [page.pageKey, page]),
  );
  const parsed = input.pages.map((page, index) => {
    const result = BenchmarkWorkspacePageSchema.safeParse(page);
    if (!result.success) {
      throw new Error(`workspace page ${index + 1} is invalid: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
    return result.data;
  });
  const keys = parsed.map((page) => page.pageKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error('workspace manifest contains duplicate page keys');
  }
  const normalized = parsed.map((page) => {
    const registered = registryByKey.get(page.pageKey);
    if (!registered) throw new Error(`workspace page ${page.pageKey} is not registered`);
    if (page.documentKey !== registered.documentKey
        || page.sha256 !== registered.sha256
        || page.physicalPageNumber !== registered.physicalPageNumber) {
      throw new Error(`workspace page ${page.pageKey} conflicts with registered source/page identity`);
    }
    if (!input.normalizeCharacterization
        && page.characterization !== registered.characterization) {
      throw new Error(`workspace page ${page.pageKey} conflicts with registered characterization`);
    }
    return {
      ...page,
      characterization: registered.characterization,
    };
  });
  if (input.requireComplete && normalized.length !== BENCHMARK_PAGES.length) {
    const present = new Set(normalized.map((page) => page.pageKey));
    const missing = BENCHMARK_PAGES.filter((page) => !present.has(page.pageKey))
      .map((page) => page.pageKey);
    throw new Error(`workspace manifest is missing registered pages: ${missing.join(', ')}`);
  }
  const order = new Map<string, number>(
    BENCHMARK_PAGES.map((page, index) => [page.pageKey, index]),
  );
  return normalized.sort((left, right) => order.get(left.pageKey)! - order.get(right.pageKey)!);
}

function sameWorkspacePageIdentity(
  left: BenchmarkWorkspacePage,
  right: BenchmarkWorkspacePage,
): boolean {
  return left.documentKey === right.documentKey
    && left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && left.physicalPageNumber === right.physicalPageNumber
    && hashCanonical(left.frame) === hashCanonical(right.frame);
}

export function parseBenchmarkWorkspaceManifest(
  bytes: Uint8Array | string,
): BenchmarkWorkspaceManifest {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('workspace manifest is not valid JSON');
  }
  const parsed = BenchmarkWorkspaceManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`workspace manifest is invalid: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return parsed.data;
}

export function mergeBenchmarkWorkspaceManifest(input: Readonly<{
  existingManifest: BenchmarkWorkspaceManifest | null;
  preparedPages: readonly BenchmarkWorkspacePage[];
  generatedAt: string;
}>): BenchmarkWorkspaceManifest {
  const existingPages = canonicalizeWorkspacePages({
    pages: input.existingManifest?.pages ?? [],
    requireComplete: false,
    normalizeCharacterization: true,
  });
  const preparedPages = canonicalizeWorkspacePages({
    pages: input.preparedPages,
    requireComplete: false,
    normalizeCharacterization: false,
  });
  const merged = new Map(existingPages.map((page) => [page.pageKey, page] as const));
  for (const page of preparedPages) {
    const previous = merged.get(page.pageKey);
    if (previous && !sameWorkspacePageIdentity(previous, page)) {
      throw new Error(`workspace page ${page.pageKey} conflicts with existing source/page/frame identity`);
    }
    merged.set(page.pageKey, page);
  }
  const pages = canonicalizeWorkspacePages({
    pages: [...merged.values()],
    requireComplete: true,
    normalizeCharacterization: false,
  });
  const unchanged = input.existingManifest !== null
    && existingPages.length === pages.length
    && hashCanonical(existingPages) === hashCanonical(pages);
  return buildBenchmarkWorkspaceManifest({
    pages,
    generatedAt: unchanged ? input.existingManifest!.generatedAt : input.generatedAt,
  });
}

export function buildBenchmarkWorkspaceManifest(input: Readonly<{
  pages: readonly BenchmarkWorkspacePage[];
  generatedAt: string;
}>): BenchmarkWorkspaceManifest {
  const pages = canonicalizeWorkspacePages({
    pages: input.pages,
    requireComplete: false,
    normalizeCharacterization: false,
  });
  return Object.freeze({
    workspaceVersion: BENCHMARK_WORKSPACE_VERSION,
    generatedAt: input.generatedAt,
    pages: Object.freeze(pages),
    requiredLabels: Object.freeze([
      'word boxes with their exact text',
      'cell boxes with their exact text',
      'which cells are header cells',
      'row membership: which cells belong to the same row, in reading order',
      'coverage truth: what the page actually contains',
    ]),
    notes: Object.freeze([
      'Every box is canonical_v1: top-left origin, PDF points, page rotation applied.',
      'The render is the same viewer-visible page the canonical frame describes;'
        + ' the tool converts your pixels to canonical points using its scale.',
      'Labels are human truth only. Optional machine suggestions stay in a separate,'
        + ' provisional layer until a person explicitly accepts or edits them.',
      'A section stays unlabeled until you mark it labeled; leaving it empty is not a claim.',
    ]),
  });
}

/**
 * Converts a labeler's render-pixel rectangle into a canonical_v1 box.
 *
 * The render is of the viewer-visible, rotated page, so removing the render
 * scale is the whole conversion. The axes are scaled independently on purpose:
 * a render's pixel width and height are each floored from the scaled viewport,
 * so one nominal scale would drift by up to a point on the longer axis.
 */
export function renderPixelsToCanonicalBox(
  rectangle: Readonly<{ x: number; y: number; width: number; height: number }>,
  render: Readonly<{ pixelWidth: number; pixelHeight: number }>,
  frame: Readonly<{ width: number; height: number }>,
): BenchmarkPageLabels['words']['items'][number]['box'] | null {
  const values = [render.pixelWidth, render.pixelHeight, frame.width, frame.height];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const scaleX = render.pixelWidth / frame.width;
  const scaleY = render.pixelHeight / frame.height;
  const round = (value: number, scale: number) => Math.round((value / scale) * 1000) / 1000;
  const box = {
    coordinate_space: 'canonical_v1' as const,
    x_min: round(rectangle.x, scaleX),
    y_min: round(rectangle.y, scaleY),
    x_max: round(rectangle.x + rectangle.width, scaleX),
    y_max: round(rectangle.y + rectangle.height, scaleY),
  };
  return box.x_min < box.x_max && box.y_min < box.y_max ? box : null;
}

export function benchmarkWorkspaceReadme(manifest: BenchmarkWorkspaceManifest): string {
  const pages = manifest.pages.map((page) => [
    `### ${page.pageKey}`,
    '',
    `- document: \`${page.documentKey}\`, physical page ${page.physicalPageNumber}`,
    `- characterization: ${page.characterization}`,
    `- source sha256: \`${page.sha256}\` (${page.byteLength} bytes)`,
    `- canonical frame: ${page.frame.width} x ${page.frame.height} pt,`
      + ` rotation ${page.frame.rotation}, view [${page.frame.view.join(', ')}]`,
    `- render: \`${page.render.file}\` at ${page.render.scale}x`
      + ` (${page.render.pixelWidth} x ${page.render.pixelHeight} px)`,
    `- labels: \`${page.labelsFile}\` (currently **${page.labelState}**)`,
    '',
  ].join('\n'));

  return [
    '# Extraction benchmark labeling workspace (E3)',
    '',
    `Workspace version \`${manifest.workspaceVersion}\`, generated ${manifest.generatedAt}.`,
    '',
    'Human truth starts **empty on purpose**. No label is generated. A person reads each',
    'rendered page and records what is actually there; the harness then measures extraction',
    'against those labels. Optional machine suggestions stay provisional and separate.',
    '',
    '## What to label',
    '',
    ...manifest.requiredLabels.map((item) => `1. ${item}`),
    '',
    '## How',
    '',
    `1. Open \`${BENCHMARK_WORKSPACE_FILES.tool}\` in a browser (no server, no network needed).`,
    `2. Load the page's \`${BENCHMARK_WORKSPACE_FILES.render}\` and \`${BENCHMARK_WORKSPACE_FILES.labels}\`.`,
    `3. Optionally load \`${BENCHMARK_WORKSPACE_FILES.suggestions}\`; it is not ground truth.`,
    '4. Draw labels or explicitly accept, edit, or reject suggestions.',
    '5. Mark each section labeled only when it is complete for that page.',
    `6. Export and overwrite that page's \`${BENCHMARK_WORKSPACE_FILES.labels}\`.`,
    '',
    '## Rules',
    '',
    ...manifest.notes.map((note) => `- ${note}`),
    '- Regenerating the workspace never overwrites a `labels.json` that already exists.',
    '- If a page is genuinely ambiguous, leave that section unlabeled and say why in the',
    '  coverage note rather than guessing.',
    '',
    '## Pages',
    '',
    ...pages,
  ].join('\n');
}
