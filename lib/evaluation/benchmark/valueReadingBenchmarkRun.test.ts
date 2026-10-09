import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { parseBenchmarkLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  VALUE_READING_BENCHMARK_PAGES,
  valueReadingBenchmarkTargets,
  type ValueReadingBenchmarkTarget,
} from '@/lib/evaluation/benchmark/valueReadingBenchmark';
import {
  runValueReadingBenchmark,
  valueReadingBenchmarkCropSpec,
  type ValueReadingBenchmarkDocument,
  type ValueReadingBenchmarkRunInput,
} from '@/lib/evaluation/benchmark/valueReadingBenchmarkRun';
import { parseValueReadingOutput } from '@/lib/server/valueReadingEngine';
import { renderValueReadingCrop } from '@/lib/server/valueReadingRegionRenderer';
import type { ValueReadingProvider } from '@/lib/valueReadingContract';

const goldenPage = VALUE_READING_BENCHMARK_PAGES[0];
const goldenTargets = valueReadingBenchmarkTargets(
  parseBenchmarkLabels(readFileSync('lib/evaluation/benchmark/labels/golden-p8.labels.json')).labels, goldenPage).targets;

const document = (overrides: Partial<ValueReadingBenchmarkDocument> = {}): ValueReadingBenchmarkDocument => ({
  page: goldenPage, documentKey: 'golden', sourceSha256: 'a'.repeat(64), physicalPageNumber: 8,
  clearedForPageRegionImages: true, targets: goldenTargets, ...overrides,
});
const IMAGE = { mediaType: 'image/png' as const, bytes: new Uint8Array([137, 80, 78, 71, 1]) };
const answer = (target: ValueReadingBenchmarkTarget) => JSON.stringify({ reading: 'value', description: target.truth.description,
  unit_type: target.truth.unit, rate_amount: target.truth.rate, category: target.truth.category, rationale: 'Read from the crop.' });

function harness(overrides: Partial<ValueReadingBenchmarkRunInput> = {}, reply?: (index: number) => string) {
  let index = -1;
  let usage = { inputTokens: 0, outputTokens: 0 };
  const read = vi.fn(async (...call: Parameters<ValueReadingProvider['read']>) => {
    void call;
    index += 1;
    usage = { inputTokens: 1600, outputTokens: 90 };
    return reply ? reply(index) : answer(goldenTargets[index % goldenTargets.length]!);
  });
  const provider: ValueReadingProvider = { providerModel: 'claude-sonnet-4-6', read };
  const render = vi.fn(async () => IMAGE);
  const input: ValueReadingBenchmarkRunInput = {
    mode: 'provider_enabled', documents: [document()], render, provider,
    parse: parseValueReadingOutput,
    takeUsage: () => { const taken = usage; usage = { inputTokens: 0, outputTokens: 0 }; return taken; },
    pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    ...overrides,
  };
  return { input, read, render };
}

describe('B4.6 benchmark run: gates before any call', () => {
  it('refuses a provider run for any document not recorded as cleared, before rendering or calling', async () => {
    const { input, read, render } = harness({ documents: [document({ clearedForPageRegionImages: false })] });
    await expect(runValueReadingBenchmark(input)).rejects.toThrow('Not cleared for page-region image transmission: golden');
    expect(render).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses without confirmed prices, and never lets a ceiling be raised', async () => {
    await expect(runValueReadingBenchmark(harness({ pricing: null }).input)).rejects.toThrow('confirmed per-token prices');
    await expect(runValueReadingBenchmark(harness({ ceilings: { maxCalls: 101, maxSpendUsd: 1 } }).input))
      .rejects.toThrow('lowered, never raised');
  });

  it('a dry run renders every target twice, calls nothing and decides nothing', async () => {
    const { input, read, render } = harness({ mode: 'dry_run', provider: null, pricing: null,
      documents: [document({ clearedForPageRegionImages: false })] });
    const result = await runValueReadingBenchmark(input);
    expect(read).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(goldenTargets.length * 2);
    expect(result).toMatchObject({ mode: 'dry_run', calls: 0, spendUsd: 0, decision: null, providerModel: null });
    expect(result.records.every((record) => record.reuseEligible && record.inputTokens === 0)).toBe(true);
  });
});

describe('B4.6 benchmark run: measurement', () => {
  it('scores every row, prices every call, and decides only a complete provider run', async () => {
    const { input, read } = harness();
    const result = await runValueReadingBenchmark(input);
    expect(read).toHaveBeenCalledTimes(24);
    expect(result.calls).toBe(24);
    expect(result.records.every((record) => record.outcome === 'correct')).toBe(true);
    expect(result.spendUsd).toBeCloseTo(24 * (1600 * 3 + 90 * 15) / 1e6);
    expect(result.decision?.classes[0]).toMatchObject({ evidenceClass: 'ocr_price_sheet', rows: 24, status: 'qualified' });
    // Only the image is sent: no text excerpts, the production request shape.
    expect(read.mock.calls[0]![0]).toMatchObject({ textExcerpts: null, model: 'claude-sonnet-4-6', timeoutMs: 8000,
      outputSchemaVersion: 'value_reading_output_v2' });
  });

  it('counts honest abstention, a wrong rate and malformed output separately', async () => {
    const { input } = harness({}, (index) => index === 0
      ? JSON.stringify({ reading: 'unreadable', description: null, unit_type: null, rate_amount: null, category: null, rationale: 'Smudged.' })
      : index === 1 ? answer({ ...goldenTargets[1]!, truth: { ...goldenTargets[1]!.truth, rate: 79 } })
        : index === 2 ? 'not json' : answer(goldenTargets[index]!));
    const result = await runValueReadingBenchmark(input);
    expect(result.records.slice(0, 3).map((record) => record.outcome)).toEqual(['abstained', 'wrong_rate', 'failed']);
    // $79 is printed nowhere on the page: an unsupported numeric invention, which fails the whole corpus.
    expect(result.records[1]).toMatchObject({ rateError: 'unsupported_numeric_invention', providerCalled: true });
    expect(result.records[2]).toMatchObject({ failureReason: 'invalid_json' });
    expect(result.decision).toMatchObject({ decision: 'FAIL', provisional: true,
      corpusSafetyFailures: ['1 unsupported numeric invention(s) on the qualification corpus'] });
  });

  it('stops at the call ceiling and leaves an incomplete run undecided', async () => {
    const { input, read } = harness({ ceilings: { maxCalls: 5, maxSpendUsd: 3 } });
    const result = await runValueReadingBenchmark(input);
    expect(read).toHaveBeenCalledTimes(5);
    expect(result.notRun).toHaveLength(19);
    expect(result.decision).toBeNull();
  });

  it('never sends an unrenderable crop, and counts it against the run', async () => {
    const { input, read } = harness({ render: vi.fn(async () => null) });
    const result = await runValueReadingBenchmark(input);
    expect(read).not.toHaveBeenCalled();
    expect(result.unrendered).toHaveLength(24);
    expect(result.decision).toMatchObject({ decision: 'FAIL' });
  });

  it('records a provider timeout as a failed reading, priced at what it consumed', async () => {
    vi.useFakeTimers();
    const { input } = harness({ documents: [document({ targets: goldenTargets.slice(0, 1) })],
      provider: { providerModel: 'claude-sonnet-4-6', read: () => new Promise<string>(() => undefined) } });
    const pending = runValueReadingBenchmark(input);
    await vi.advanceTimersByTimeAsync(8_001);
    const result = await pending;
    vi.useRealTimers();
    expect(result.records[0]).toMatchObject({ outcome: 'failed', inputTokens: 0 });
  });
});

describe('B4.6 benchmark crops are the production crops', () => {
  it('draws a labelled row through the production renderer, deterministically', async () => {
    // A repository PDF stands in for client corpus bytes, which never enter the repository.
    const pdf = new Uint8Array(readFileSync('lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf'));
    const target: ValueReadingBenchmarkTarget = { ...goldenTargets[0]!, boxes: [
      { coordinate_space: 'canonical_v1', x_min: 36, x_max: 300, y_min: 300, y_max: 314 },
      { coordinate_space: 'canonical_v1', x_min: 400, x_max: 576, y_min: 300, y_max: 314 }] };
    const spec = valueReadingBenchmarkCropSpec(document({ physicalPageNumber: 1 }), target);
    expect(spec).toMatchObject({ scale: 3, paddingPoints: 6, renderer: 'value_reading_region_crop_v2' });
    const result = await runValueReadingBenchmark({ ...harness().input, mode: 'dry_run', provider: null, pricing: null,
      documents: [document({ physicalPageNumber: 1, targets: [target] })],
      render: (cropSpec) => renderValueReadingCrop(pdf, cropSpec) });
    expect(result.unrendered).toEqual([]);
    expect(result.records[0]).toMatchObject({ reuseEligible: true });
    expect(result.records[0]!.renderDigestSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
});
