import {
  BENCHMARK_PAGES,
  BENCHMARK_WORKSPACE_VERSION,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';

/**
 * E3 labeling workspace description.
 *
 * Pure: this module decides what a workspace contains and what it is bound to.
 * File IO belongs to the preparation script. The workspace holds a rendered
 * page, the page's canonical frame, and an empty label file. It never holds a
 * machine's reading of the page, because a labeler who is shown the extractor's
 * answer is no longer independent ground truth.
 */

export const BENCHMARK_WORKSPACE_FILES = {
  render: 'page.png',
  labels: 'labels.json',
  frame: 'frame.json',
  readme: 'README.md',
  tool: 'label-tool.html',
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

export function buildBenchmarkWorkspaceManifest(input: Readonly<{
  pages: readonly BenchmarkWorkspacePage[];
  generatedAt: string;
}>): BenchmarkWorkspaceManifest {
  return Object.freeze({
    workspaceVersion: BENCHMARK_WORKSPACE_VERSION,
    generatedAt: input.generatedAt,
    pages: Object.freeze([...input.pages].sort((left, right) =>
      left.pageKey.localeCompare(right.pageKey, 'en-US'))),
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
      'No extractor output appears in this workspace. Label what you read on the page.',
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
    'This workspace is **empty on purpose**. Nothing here was produced by an extractor,',
    'and no label was generated. A person reads each rendered page and records what is',
    'actually there; the harness then measures extraction against those labels.',
    '',
    '## What to label',
    '',
    ...manifest.requiredLabels.map((item) => `1. ${item}`),
    '',
    '## How',
    '',
    `1. Open \`${BENCHMARK_WORKSPACE_FILES.tool}\` in a browser (no server, no network needed).`,
    `2. Load the page's \`${BENCHMARK_WORKSPACE_FILES.render}\` and \`${BENCHMARK_WORKSPACE_FILES.labels}\`.`,
    '3. Draw boxes and type the text exactly as printed, including punctuation and case.',
    '4. Mark each section labeled only when it is complete for that page.',
    `5. Export and overwrite that page's \`${BENCHMARK_WORKSPACE_FILES.labels}\`.`,
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
