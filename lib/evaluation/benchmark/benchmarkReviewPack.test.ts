import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bindBenchmarkLabels,
  buildBenchmarkLabelTemplate,
  parseBenchmarkLabels,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  BENCHMARK_NATIVE_TEXT_EVIDENCE_AUTHORITY,
  BENCHMARK_NATIVE_TEXT_EVIDENCE_VERSION,
  BENCHMARK_REVIEW_PACK_FILES,
  BENCHMARK_REVIEW_PACK_VERSION,
  BENCHMARK_SOURCE_BOUND_REVIEW_PACK_AUTHORITY,
  BENCHMARK_SOURCE_BOUND_REVIEW_PACK_VERSION,
  buildBenchmarkSourceBoundReviewPack,
  parseBenchmarkNativeTextEvidence,
  parseBenchmarkSourceBoundReviewPack,
  prepareBenchmarkReviewPack,
} from '@/lib/evaluation/benchmark/benchmarkReviewPack';
import {
  buildBenchmarkWorkspaceManifest,
  type BenchmarkWorkspacePage,
} from '@/lib/evaluation/benchmark/benchmarkWorkspace';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const FRAME: BenchmarkPageLabels['frame'] = {
  frame_version: 'canonical_frame_v1',
  coordinate_space: 'canonical_v1',
  view: [0, 0, 612.48, 792],
  rotation: 0,
  user_unit: 1,
  width: 612.48,
  height: 792,
};

const PAGE: BenchmarkWorkspacePage = {
  pageKey: 'golden-p8',
  documentKey: 'golden',
  characterization: 'ocr_price_sheet',
  sha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f',
  byteLength: 2_481_310,
  physicalPageNumber: 8,
  frame: FRAME,
  render: { file: 'page.png', scale: 2, pixelWidth: 1224, pixelHeight: 1584 },
  labelsFile: 'labels.json',
  labelState: 'unlabeled',
};

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x65, 0x33,
]);

function template(): BenchmarkPageLabels {
  return buildBenchmarkLabelTemplate({
    pageKey: 'golden-p8',
    documentKey: 'golden',
    sha256: PAGE.sha256,
    byteLength: PAGE.byteLength,
    physicalPageNumber: PAGE.physicalPageNumber,
    frame: FRAME,
  });
}

function partialLabels(): BenchmarkPageLabels {
  return {
    ...template(),
    words: {
      status: 'labeled',
      items: [{
        labelId: 'w1',
        text: 'Exhibit',
        box: { coordinate_space: 'canonical_v1', x_min: 10, y_min: 20, x_max: 50, y_max: 30 },
      }],
    },
    coverage: { status: 'labeled', truth: 'mixed_native_and_ocr', note: 'human reviewed' },
    labeledBy: 'human-reviewer',
    labeledAt: '2026-09-21T12:00:00.000Z',
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function fixture(labelsBytes: Buffer): Promise<Readonly<{
  root: string;
  workspace: string;
  out: string;
  pageDirectory: string;
}>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eightforge-e3-review-pack-'));
  temporaryDirectories.push(root);
  const workspace = path.join(root, 'workspace');
  const out = path.join(root, 'review');
  const pageDirectory = path.join(workspace, PAGE.pageKey);
  await mkdir(pageDirectory, { recursive: true });
  const manifest = buildBenchmarkWorkspaceManifest({
    pages: [PAGE],
    generatedAt: '2026-09-21T00:00:00.000Z',
  });
  await Promise.all([
    writeFile(path.join(workspace, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(path.join(pageDirectory, 'page.png'), PNG_BYTES),
    writeFile(path.join(pageDirectory, 'frame.json'), JSON.stringify(FRAME)),
    writeFile(path.join(pageDirectory, 'labels.json'), labelsBytes),
  ]);
  return { root, workspace, out, pageDirectory };
}

describe('E3 independent review pack', () => {
  it('validates deterministic native-text evidence and a digest-bound shared reviewer input', () => {
    const text = 'DN12189513';
    const transcription = `${text}\n`;
    const transcriptionSha256 = createHash('sha256').update(transcription).digest('hex');
    const source = {
      documentKey: 'dn',
      sha256: '6'.repeat(64),
      byteLength: 3_895_497,
      physicalPageNumber: 106,
    };
    const frame = { ...FRAME, view: [0, 0, 612, 792] as [number, number, number, number], width: 612 };
    const evidence = parseBenchmarkNativeTextEvidence({
      nativeTextEvidenceVersion: BENCHMARK_NATIVE_TEXT_EVIDENCE_VERSION,
      authority: BENCHMARK_NATIVE_TEXT_EVIDENCE_AUTHORITY,
      pageKey: 'dn-p106',
      source,
      frame,
      extractor: {
        name: 'pdfjs-dist getTextContent/getOperatorList',
        version: '5.5.207',
        disableWorker: true,
        disableNormalization: true,
      },
      measurement: {
        passes: 2,
        repeatedMeasurementsExactMatch: true,
        contentItemCount: 1,
        nonEmptyTextItemCount: 1,
        pageImageXObjectCount: 0,
        imageMaskPaintCount: 0,
        nativeTextLayerPresent: true,
      },
      transcription: {
        encoding: 'pdfjs_text_content_items_with_eol_v1',
        sha256: transcriptionSha256,
        utf8ByteLength: Buffer.byteLength(transcription, 'utf8'),
        nonEmptyItemSequenceJoinDelimiter: 'U+001F',
        nonEmptyItemSequenceSha256: createHash('sha256').update(text).digest('hex'),
        items: [{
          sourceContentItemIndex: 0,
          text,
          hasEOL: true,
          nonEmpty: true,
          nonEmptyReadingOrder: 0,
        }],
      },
      sourceDerivedTextBoxesIncluded: false,
      sourceDerivedTextBoxesReason: 'Geometry remains separately reviewed.',
    });
    const jsonBinding = {
      path: 'evidence.json', fileSha256: 'a'.repeat(64), canonicalSha256: 'b'.repeat(64),
    };
    const pack = buildBenchmarkSourceBoundReviewPack({
      sourceBoundReviewPackVersion: BENCHMARK_SOURCE_BOUND_REVIEW_PACK_VERSION,
      reviewPackVersion: BENCHMARK_REVIEW_PACK_VERSION,
      authority: BENCHMARK_SOURCE_BOUND_REVIEW_PACK_AUTHORITY,
      pageKey: 'dn-p106',
      source,
      frame,
      characterization: 'dense_native_priced_schedule',
      reviewerSchema: {
        name: 'BenchmarkReviewerLabelSetSchema',
        version: 'extraction-benchmark-reviewer-labels-v1',
        authority: 'non_authoritative_reviewer_proposal',
        requiredIndependence: {
          inputMode: 'clean_source_page_only',
          sawMachineSuggestions: false,
          sawOtherReviewerLabels: false,
        },
      },
      files: {
        cleanRender: {
          path: 'page.png', sha256: 'c'.repeat(64), pixelWidth: 1224, pixelHeight: 1584,
        },
        reviewSummary: jsonBinding,
        sourceLayerMeasurement: { ...jsonBinding, path: 'measurement.json' },
        nativeTextEvidence: { ...jsonBinding, path: 'native-text.json' },
        reviewerContext: { ...jsonBinding, path: 'context.json' },
      },
      sharedReviewerInstruction: 'Review p106 independently from its supplied source evidence.',
      semanticScope: { words: true, cells: true, rows: true, coverage: true, geometry: false },
      sameFrozenInputForBothReviewers: true,
      expectedOutputs: { reviewerA: 'reviewer-a.labels.json', reviewerB: 'reviewer-b.labels.json' },
      contaminationBoundary: {
        p107SemanticPayloadIncluded: false,
        productionExtractionIncluded: false,
        historicalP106ExtractionIncluded: false,
        ambiguousRowDiagnosticsIncluded: false,
        baselineMachinePredictionsIncluded: false,
        benchmarkTruthIncluded: false,
        machineSuggestionsIncluded: false,
        ocrOutputIncluded: false,
        geometryAuthorityIncluded: false,
      },
    });

    expect(evidence.transcription.items).toHaveLength(1);
    expect(parseBenchmarkSourceBoundReviewPack(pack)).toEqual(pack);
    expect(() => parseBenchmarkSourceBoundReviewPack({
      ...pack,
      characterization: 'changed_after_digest',
    })).toThrow(/source-bound review pack digest differs/);
  });

  it('rejects native-text evidence with changed sequence or non-contiguous reading order', () => {
    const base = {
      nativeTextEvidenceVersion: BENCHMARK_NATIVE_TEXT_EVIDENCE_VERSION,
      authority: BENCHMARK_NATIVE_TEXT_EVIDENCE_AUTHORITY,
      pageKey: 'dn-p106',
      source: {
        documentKey: 'dn', sha256: '6'.repeat(64), byteLength: 1, physicalPageNumber: 106,
      },
      frame: { ...FRAME, view: [0, 0, 612, 792], width: 612 },
      extractor: {
        name: 'pdfjs-dist getTextContent/getOperatorList',
        version: '5.5.207',
        disableWorker: true,
        disableNormalization: true,
      },
      measurement: {
        passes: 2,
        repeatedMeasurementsExactMatch: true,
        contentItemCount: 1,
        nonEmptyTextItemCount: 1,
        pageImageXObjectCount: 0,
        imageMaskPaintCount: 0,
        nativeTextLayerPresent: true,
      },
      transcription: {
        encoding: 'pdfjs_text_content_items_with_eol_v1',
        sha256: createHash('sha256').update('A').digest('hex'),
        utf8ByteLength: 1,
        nonEmptyItemSequenceJoinDelimiter: 'U+001F',
        nonEmptyItemSequenceSha256: createHash('sha256').update('A').digest('hex'),
        items: [{
          sourceContentItemIndex: 1,
          text: 'B',
          hasEOL: true,
          nonEmpty: true,
          nonEmptyReadingOrder: 1,
        }],
      },
      sourceDerivedTextBoxesIncluded: false,
      sourceDerivedTextBoxesReason: 'Geometry remains separately reviewed.',
    };

    expect(() => parseBenchmarkNativeTextEvidence(base)).toThrow(
      /source item indexes are not contiguous|non-empty reading order differs|transcription digest differs/,
    );
  });

  it('copies the exact workspace render and omits an unlabeled label template', async () => {
    const sourceLabels = Buffer.from(`${JSON.stringify(template(), null, 2)}\n`);
    const { workspace, out } = await fixture(sourceLabels);

    const [result] = await prepareBenchmarkReviewPack({
      workspaceDirectory: workspace,
      outDirectory: out,
      pageKeys: ['golden-p8'],
    });

    expect(await readFile(result!.pageFile)).toEqual(PNG_BYTES);
    expect(result!.labelsFile).toBeNull();
    expect(await exists(path.join(out, 'golden-p8', 'labels.json'))).toBe(false);
    expect(result!.summary).toMatchObject({
      pageKey: 'golden-p8',
      labels_status: 'unlabeled',
      source: { sha256: PAGE.sha256, byteLength: PAGE.byteLength, physicalPageNumber: 8 },
      confirmed: { wordCount: 0, cellCount: 0, rowCount: 0, coverageTruth: null },
      attribution: null,
      labelingTimestamp: null,
      files: { page: 'page.png', labels: null },
    });
  });

  it('copies confirmed partial labels byte-for-byte and summarizes confirmed values only', async () => {
    const labels = partialLabels();
    const raw = Buffer.from(`${JSON.stringify(labels, null, 4)}\r\n`);
    const { workspace, out } = await fixture(raw);

    const [result] = await prepareBenchmarkReviewPack({
      workspaceDirectory: workspace,
      outDirectory: out,
      pageKeys: ['golden-p8'],
    });

    expect(result!.labelsFile).not.toBeNull();
    expect(await readFile(result!.labelsFile!)).toEqual(raw);
    expect(result!.summary).toMatchObject({
      labels_status: 'partial',
      confirmed: {
        wordCount: 1, cellCount: 0, rowCount: 0, coverageTruth: 'mixed_native_and_ocr',
      },
      attribution: 'human-reviewer',
      labelingTimestamp: '2026-09-21T12:00:00.000Z',
      files: { labels: 'labels.json' },
    });
    expect(JSON.stringify(result!.summary)).not.toMatch(/suggestion|machine.output|extractor/i);
  });

  it('removes a stale derived labels file when the current workspace is unlabeled', async () => {
    const { workspace, out, pageDirectory } = await fixture(
      Buffer.from(JSON.stringify(partialLabels())),
    );
    await prepareBenchmarkReviewPack({
      workspaceDirectory: workspace, outDirectory: out, pageKeys: ['golden-p8'],
    });
    const reviewLabels = path.join(out, 'golden-p8', 'labels.json');
    expect(await exists(reviewLabels)).toBe(true);

    await writeFile(path.join(pageDirectory, 'labels.json'), JSON.stringify(template()));
    await prepareBenchmarkReviewPack({
      workspaceDirectory: workspace, outDirectory: out, pageKeys: ['golden-p8'],
    });
    expect(await exists(reviewLabels)).toBe(false);
  });

  it('uses an explicit output allowlist and refuses unexpected machine artifacts', async () => {
    const { workspace, out } = await fixture(Buffer.from(JSON.stringify(template())));
    const reviewPage = path.join(out, 'golden-p8');
    await mkdir(path.join(reviewPage, 'machine-output'), { recursive: true });

    await expect(prepareBenchmarkReviewPack({
      workspaceDirectory: workspace, outDirectory: out, pageKeys: ['golden-p8'],
    })).rejects.toThrow(/unexpected entries: machine-output/);
    expect(await readdir(reviewPage)).toEqual(['machine-output']);
  });

  it('fails closed when the requested frozen pages are missing', async () => {
    const { workspace, out } = await fixture(Buffer.from(JSON.stringify(template())));

    await expect(prepareBenchmarkReviewPack({
      workspaceDirectory: workspace,
      outDirectory: out,
    })).rejects.toThrow(/hillsdale-p3: expected exactly one workspace manifest entry/);
    expect(await exists(out)).toBe(false);
  });

  it('rejects changed source identity and label binding before writing output', async () => {
    const { workspace, out } = await fixture(Buffer.from(JSON.stringify(template())));
    const manifestFile = path.join(workspace, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      pages: Array<{ sha256: string }>;
    };
    manifest.pages[0]!.sha256 = 'a'.repeat(64);
    await writeFile(manifestFile, JSON.stringify(manifest));

    await expect(prepareBenchmarkReviewPack({
      workspaceDirectory: workspace, outDirectory: out, pageKeys: ['golden-p8'],
    })).rejects.toThrow(/source sha256 differs from the frozen corpus/);
    expect(await exists(out)).toBe(false);
  });

  it('keeps review artifacts local and validates labels through the benchmark binding', async () => {
    const gitignore = await readFile(path.resolve('.gitignore'), 'utf8');
    expect(gitignore).toContain('.benchmark-review/');
    const bound = bindBenchmarkLabels(parseBenchmarkLabels(JSON.stringify(partialLabels())), {
      pageKey: PAGE.pageKey,
      sha256: PAGE.sha256,
      byteLength: PAGE.byteLength,
      physicalPageNumber: PAGE.physicalPageNumber,
      frame: FRAME,
    });
    expect(bound.state).toBe('partial');
    expect(Object.values(BENCHMARK_REVIEW_PACK_FILES).sort()).toEqual([
      'labels.json', 'page.png', 'review-summary.json',
    ]);
  });
});
