import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BENCHMARK_ADJUDICATION_AUTHORITY,
  BENCHMARK_ADJUDICATION_VERSION,
  parseBenchmarkAdjudication,
} from '@/lib/evaluation/benchmark/benchmarkDualReview';
import {
  buildBenchmarkLabelTemplate,
  type BenchmarkPageLabels,
} from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  assertFinalLabelsOutputPath,
  assertSafeExistingOutput,
  resolveBenchmarkFinalizationMode,
} from '@/scripts/evaluation/e3/finalize-benchmark-adjudication';
import { assertCandidatePreviewOutputPath } from '@/scripts/evaluation/e3/compute-benchmark-candidate';

const FRAME: BenchmarkPageLabels['frame'] = {
  frame_version: 'canonical_frame_v1',
  coordinate_space: 'canonical_v1',
  view: [0, 0, 612, 792],
  rotation: 0,
  user_unit: 1,
  width: 612,
  height: 792,
};

const SOURCE = {
  pageKey: 'golden-p8' as const,
  documentKey: 'golden',
  sha256: 'a'.repeat(64),
  byteLength: 1234,
  physicalPageNumber: 8,
  frame: FRAME,
};

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function adjudication(approval: 'human' | 'none') {
  return parseBenchmarkAdjudication(JSON.stringify({
    adjudicationVersion: BENCHMARK_ADJUDICATION_VERSION,
    authority: BENCHMARK_ADJUDICATION_AUTHORITY,
    pageKey: SOURCE.pageKey,
    source: {
      documentKey: SOURCE.documentKey,
      sha256: SOURCE.sha256,
      byteLength: SOURCE.byteLength,
      physicalPageNumber: SOURCE.physicalPageNumber,
    },
    frame: FRAME,
    comparisonSha256: 'b'.repeat(64),
    reviewerALabelSetSha256: 'c'.repeat(64),
    reviewerBLabelSetSha256: 'd'.repeat(64),
    suggestionsSha256: null,
    resolutions: [],
    userChallenges: [],
    approval: approval === 'human' ? {
      decision: 'approve_as_benchmark_truth',
      approvedBy: 'human-owner',
      approvedAt: '2026-09-26T12:00:00.000Z',
      approvedCandidateSha256: 'e'.repeat(64),
    } : null,
  }));
}

describe('E3 finalizer authority-mode selection', () => {
  it('selects exactly one valid authority mode and rejects mixed, partial, or absent approval', () => {
    expect(resolveBenchmarkFinalizationMode(adjudication('human'), null, null)).toBe('human');
    expect(resolveBenchmarkFinalizationMode(adjudication('none'), 'a.json', 'b.json'))
      .toBe('delegated');
    expect(() => resolveBenchmarkFinalizationMode(adjudication('human'), 'a.json', 'b.json'))
      .toThrow(/cannot execute together/);
    expect(() => resolveBenchmarkFinalizationMode(adjudication('human'), 'a.json', null))
      .toThrow(/cannot execute together/);
    expect(() => resolveBenchmarkFinalizationMode(adjudication('none'), null, null))
      .toThrow(/neither human nor delegated approval/);
    expect(() => resolveBenchmarkFinalizationMode(adjudication('none'), 'a.json', null))
      .toThrow(/exactly two approval artifacts/);
    expect(() => resolveBenchmarkFinalizationMode(adjudication('none'), null, 'b.json'))
      .toThrow(/exactly two approval artifacts/);
  });

  it('keeps preview output separate and reserves labels.json for the finalizer', () => {
    expect(() => assertFinalLabelsOutputPath('C:/tmp/labels.json')).not.toThrow();
    expect(() => assertFinalLabelsOutputPath('C:/tmp/candidate.json')).toThrow(/must be named labels.json/);
    expect(() => assertCandidatePreviewOutputPath('C:/tmp/labels.json')).toThrow(/never writes labels.json/);
    expect(() => assertCandidatePreviewOutputPath('C:/tmp/LABELS.JSON')).toThrow(/never writes labels.json/);
    expect(() => assertCandidatePreviewOutputPath(
      'C:/tmp/adjudication.json', ['C:/tmp/adjudication.json'].map((file) => path.resolve(file)),
    )).toThrow(/differ from every frozen input/);
  });
});

describe('E3 final labels overwrite protection', () => {
  it('permits a missing output or matching empty template and rejects existing truth', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'e3-delegated-finalizer-'));
    tempDirectories.push(directory);
    const output = path.join(directory, 'labels.json');
    const target = buildBenchmarkLabelTemplate(SOURCE);

    await expect(assertSafeExistingOutput(output, target)).resolves.toBeUndefined();
    await writeFile(output, `${JSON.stringify(target)}\n`, 'utf8');
    await expect(assertSafeExistingOutput(output, target)).resolves.toBeUndefined();

    const partial: BenchmarkPageLabels = {
      ...target,
      coverage: { status: 'labeled', truth: 'requires_ocr', note: null },
    };
    await writeFile(output, `${JSON.stringify(partial)}\n`, 'utf8');
    const before = await readFile(output, 'utf8');
    await expect(assertSafeExistingOutput(output, target)).rejects.toThrow(/refusing to overwrite/);
    expect(await readFile(output, 'utf8')).toBe(before);
  });

  it('rejects malformed, differently bound, or different-document existing output', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'e3-delegated-finalizer-'));
    tempDirectories.push(directory);
    const output = path.join(directory, 'labels.json');
    const target = buildBenchmarkLabelTemplate(SOURCE);

    await writeFile(output, '{not-json', 'utf8');
    await expect(assertSafeExistingOutput(output, target)).rejects.toThrow(/not JSON/);

    const differentDocument = buildBenchmarkLabelTemplate({ ...SOURCE, documentKey: 'other-document' });
    await writeFile(output, JSON.stringify(differentDocument), 'utf8');
    await expect(assertSafeExistingOutput(output, target)).rejects.toThrow(/document key differs/);

    const differentFrame = buildBenchmarkLabelTemplate({
      ...SOURCE,
      frame: { ...FRAME, rotation: 90 },
    });
    await writeFile(output, JSON.stringify(differentFrame), 'utf8');
    await expect(assertSafeExistingOutput(output, target)).rejects.toThrow(/canonical page frame differs/);
  });
});

describe('E3 labels.json single-writer guard', () => {
  it('keeps both finalization functions exclusive to the existing finalizer CLI', async () => {
    const scriptsDirectory = path.resolve('scripts/evaluation/e3');
    const scriptNames = (await readdir(scriptsDirectory)).filter((name) => name.endsWith('.ts'));
    const users: string[] = [];
    for (const name of scriptNames) {
      const source = await readFile(path.join(scriptsDirectory, name), 'utf8');
      if (/finalize(?:Delegated)?BenchmarkAdjudication\s*\(/.test(source)) users.push(name);
    }
    expect(users).toEqual(['finalize-benchmark-adjudication.ts']);
  });
});
