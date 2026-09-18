import { describe, expect, it } from 'vitest';

import type { BenchmarkPageLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  BENCHMARK_WORKSPACE_FILES,
  benchmarkWorkspaceReadme,
  buildBenchmarkWorkspaceManifest,
  renderPixelsToCanonicalBox,
  type BenchmarkWorkspacePage,
} from '@/lib/evaluation/benchmark/benchmarkWorkspace';

const FRAME: BenchmarkPageLabels['frame'] = {
  frame_version: 'canonical_frame_v1', coordinate_space: 'canonical_v1',
  view: [0, 0, 612.48, 792], rotation: 0, user_unit: 1, width: 612.48, height: 792,
};

const page: BenchmarkWorkspacePage = {
  pageKey: 'golden-p8',
  documentKey: 'golden',
  characterization: 'mixed_native_and_ocr',
  sha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f',
  byteLength: 2_481_310,
  physicalPageNumber: 8,
  frame: FRAME,
  render: { file: 'page.png', scale: 1224 / 612.48, pixelWidth: 1224, pixelHeight: 1584 },
  labelsFile: 'labels.json',
  labelState: 'unlabeled',
};

describe('workspace geometry', () => {
  it('converts a labeler\'s render pixels to canonical points', () => {
    // Same formula the offline label tool applies, verified against it in a browser.
    // Each axis uses its own scale: 1224/612.48 across, an exact 2x down.
    expect(renderPixelsToCanonicalBox({ x: 100, y: 200, width: 50, height: 20 }, page.render, FRAME))
      .toEqual({ coordinate_space: 'canonical_v1', x_min: 50.039, y_min: 100, x_max: 75.059, y_max: 110 });
  });

  it('round-trips a full-page rectangle back onto the canonical page', () => {
    const box = renderPixelsToCanonicalBox(
      { x: 0, y: 0, width: page.render.pixelWidth, height: page.render.pixelHeight }, page.render, FRAME)!;
    expect(box.x_max).toBeCloseTo(FRAME.width, 1);
    expect(box.y_max).toBeCloseTo(FRAME.height, 1);
  });

  it('refuses a degenerate rectangle or an impossible scale', () => {
    expect(renderPixelsToCanonicalBox({ x: 10, y: 10, width: 0, height: 5 }, page.render, FRAME)).toBeNull();
    expect(renderPixelsToCanonicalBox({ x: 10, y: 10, width: 5, height: 5 }, { pixelWidth: 0, pixelHeight: 10 }, FRAME)).toBeNull();
  });
});

describe('workspace manifest', () => {
  const manifest = buildBenchmarkWorkspaceManifest({
    pages: [page], generatedAt: '2026-09-18T00:00:00.000Z',
  });

  it('states what a human is being asked for, and holds no extractor output', () => {
    expect(manifest.requiredLabels).toHaveLength(5);
    expect(manifest.requiredLabels.join(' ')).toMatch(
      /word boxes[\s\S]*cell boxes[\s\S]*header[\s\S]*row membership[\s\S]*coverage/);
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toMatch(/prediction|extracted|ocr_text/i);
  });

  it('describes each page by measured identity and geometry only', () => {
    expect(manifest.pages[0]).toMatchObject({
      pageKey: 'golden-p8', sha256: page.sha256, physicalPageNumber: 8, labelState: 'unlabeled',
    });
    expect(manifest.pages[0]!.render.scale).toBeGreaterThan(0);
  });

  it('writes a readme that tells a labeler the rules, including the no-overwrite rule', () => {
    const readme = benchmarkWorkspaceReadme(manifest);
    expect(readme).toMatch(/empty on purpose/);
    expect(readme).toMatch(/never overwrites a `labels.json`/);
    expect(readme).toMatch(new RegExp(BENCHMARK_WORKSPACE_FILES.tool.replace('.', '\\.')));
    expect(readme).toMatch(/golden-p8/);
    expect(readme).toMatch(/leave that section unlabeled/);
  });
});
