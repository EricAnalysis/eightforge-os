import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_PAGES,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  BENCHMARK_WORKSPACE_FILES,
  assertBenchmarkPageRegistry,
  benchmarkWorkspaceReadme,
  buildBenchmarkWorkspaceManifest,
  mergeBenchmarkWorkspaceManifest,
  parseBenchmarkWorkspaceManifest,
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
  characterization: 'ocr_price_sheet',
  sha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f',
  byteLength: 2_481_310,
  physicalPageNumber: 8,
  frame: FRAME,
  render: { file: 'page.png', scale: 1224 / 612.48, pixelWidth: 1224, pixelHeight: 1584 },
  labelsFile: 'labels.json',
  labelState: 'unlabeled',
};

const allPages: readonly BenchmarkWorkspacePage[] = [
  page,
  {
    ...page,
    pageKey: 'hillsdale-p3',
    documentKey: 'hillsdale',
    characterization: 'ocr_price_sheet',
    sha256: '596adaccf865625723dc832f5206a8f690eb17d96921ef185df35b113c767537',
    byteLength: 3_227_431,
    physicalPageNumber: 3,
    frame: { ...FRAME, view: [0, 0, 611, 792], width: 611 },
    render: { file: 'page.png', scale: 2, pixelWidth: 1222, pixelHeight: 1584 },
  },
  {
    ...page,
    pageKey: 'dn-p106',
    documentKey: 'dn',
    characterization: 'dense_native_priced_schedule',
    sha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
    byteLength: 3_895_497,
    physicalPageNumber: 106,
    frame: { ...FRAME, view: [0, 0, 612, 792], width: 612 },
    render: { file: 'page.png', scale: 2, pixelWidth: 1224, pixelHeight: 1584 },
  },
  {
    ...page,
    pageKey: 'dn-p107',
    documentKey: 'dn',
    characterization: 'dense_scanned_ocr_priced_schedule',
    sha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
    byteLength: 3_895_497,
    physicalPageNumber: 107,
    frame: { ...FRAME, view: [0, 0, 612, 792], width: 612 },
    render: { file: 'page.png', scale: 2, pixelWidth: 1224, pixelHeight: 1584 },
  },
  { ...page, pageKey: 'golden-p10', physicalPageNumber: 10 },
  { ...page, pageKey: 'golden-p11', physicalPageNumber: 11 },
  {
    ...page,
    pageKey: 'hillsdale-p1',
    documentKey: 'hillsdale',
    characterization: 'native_price_sheet',
    sha256: '596adaccf865625723dc832f5206a8f690eb17d96921ef185df35b113c767537',
    byteLength: 3_227_431,
    physicalPageNumber: 1,
    frame: { ...FRAME, view: [0, 0, 611, 792], width: 611 },
    render: { file: 'page.png', scale: 2, pixelWidth: 1222, pixelHeight: 1584 },
  },
];

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
    pages: allPages, generatedAt: '2026-09-18T00:00:00.000Z',
  });

  it('contains the complete registry in deterministic registry order', () => {
    expect(manifest.pages.map((entry) => entry.pageKey))
      .toEqual(BENCHMARK_PAGES.map((entry) => entry.pageKey));
    expect(parseBenchmarkWorkspaceManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  it.each(BENCHMARK_PAGES.map((entry) => entry.pageKey))(
    'preparing %s preserves every other registered page',
    (pageKey) => {
      const prepared = {
        ...manifest.pages.find((entry) => entry.pageKey === pageKey)!,
        labelState: 'partial' as const,
      };
      const merged = mergeBenchmarkWorkspaceManifest({
        existingManifest: manifest,
        preparedPages: [prepared],
        generatedAt: '2026-09-19T00:00:00.000Z',
      });
      expect(merged.pages.map((entry) => entry.pageKey))
        .toEqual(BENCHMARK_PAGES.map((entry) => entry.pageKey));
      expect(merged.pages.filter((entry) => entry.pageKey !== pageKey))
        .toEqual(manifest.pages.filter((entry) => entry.pageKey !== pageKey));
      expect(merged.pages.find((entry) => entry.pageKey === pageKey)?.labelState).toBe('partial');
    },
  );

  it('is byte-stable when an identical page is prepared again', () => {
    const rerun = mergeBenchmarkWorkspaceManifest({
      existingManifest: manifest,
      preparedPages: [manifest.pages[0]!],
      generatedAt: '2026-09-19T00:00:00.000Z',
    });
    expect(JSON.stringify(rerun)).toBe(JSON.stringify(manifest));
    expect(benchmarkWorkspaceReadme(rerun)).toBe(benchmarkWorkspaceReadme(manifest));
  });

  it('fails closed on duplicate, unknown, incomplete, or conflicting pages', () => {
    expect(() => assertBenchmarkPageRegistry([...BENCHMARK_PAGES, BENCHMARK_PAGES[0]!]))
      .toThrow(/duplicate page keys/);
    expect(() => mergeBenchmarkWorkspaceManifest({
      existingManifest: manifest,
      preparedPages: [manifest.pages[0]!, manifest.pages[0]!],
      generatedAt: '2026-09-19T00:00:00.000Z',
    })).toThrow(/duplicate page keys/);
    expect(() => buildBenchmarkWorkspaceManifest({
      pages: [{ ...page, pageKey: 'unknown-page' }],
      generatedAt: '2026-09-19T00:00:00.000Z',
    })).toThrow(/not registered/);
    expect(() => mergeBenchmarkWorkspaceManifest({
      existingManifest: null,
      preparedPages: [page],
      generatedAt: '2026-09-19T00:00:00.000Z',
    })).toThrow(/missing registered pages/);
    expect(() => mergeBenchmarkWorkspaceManifest({
      existingManifest: manifest,
      preparedPages: [{ ...page, sha256: 'f'.repeat(64) }],
      generatedAt: '2026-09-19T00:00:00.000Z',
    })).toThrow(/registered source\/page identity/);
    expect(() => mergeBenchmarkWorkspaceManifest({
      existingManifest: manifest,
      preparedPages: [{ ...page, frame: { ...page.frame, width: page.frame.width + 1 } }],
      generatedAt: '2026-09-19T00:00:00.000Z',
    })).toThrow(/existing source\/page\/frame identity/);
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
