import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseBenchmarkLabels } from '@/lib/evaluation/benchmark/benchmarkContract';
import {
  applyValueReadingAdjudications,
  decideValueReadingActivation,
  normalizeReadingText,
  parseLabelRate,
  readValueReadingClearance,
  scoreValueReading,
  VALUE_READING_ACTIVATION_BAR,
  VALUE_READING_BENCHMARK_PAGES,
  valueReadingBenchmarkTargets,
  type ValueReadingBenchmarkRecord,
} from '@/lib/evaluation/benchmark/valueReadingBenchmark';

const labels = (pageKey: string) =>
  parseBenchmarkLabels(readFileSync(`lib/evaluation/benchmark/labels/${pageKey}.labels.json`)).labels;
const page = (pageKey: string) => VALUE_READING_BENCHMARK_PAGES.find((entry) => entry.pageKey === pageKey)!;

describe('B4.6 value-reading targets from tracked truth', () => {
  it('takes every labelled priced row, and only priced rows, from each benchmark page', () => {
    const golden = valueReadingBenchmarkTargets(labels('golden-p8'), page('golden-p8'));
    expect(golden.targets).toHaveLength(24);
    expect(golden.targets[0]).toMatchObject({ evidenceClass: 'ocr_price_sheet', truth: {
      category: 'Vegetative Collect, Remove & Haul from Unincorporated Neighborhoods',
      description: '0–15 Miles from ROW to DMS', unit: 'Cubic Yard', rate: 6.9 } });
    expect(golden.targets[0]!.boxes.every((box) => box.coordinate_space === 'canonical_v1')).toBe(true);

    const hillsdale = valueReadingBenchmarkTargets(labels('hillsdale-p3'), page('hillsdale-p3'));
    expect(hillsdale.targets).toHaveLength(40);
    expect(hillsdale.targets[0]!.truth).toEqual({ description: 'JD 544 Wheel Loader with debris grapple', unit: 'Hour',
      rate: 250, category: null });

    const dn = valueReadingBenchmarkTargets(labels('dn-p107'), page('dn-p107'));
    expect(dn.targets).toHaveLength(21);
    expect(dn.targets[0]!.truth).toEqual({ description: 'Vegetative Debris Removal', unit: 'CY', rate: 38, category: null });
    // Section headings and the column header row are not targets, and say why.
    expect(dn.skipped.map((entry) => entry.reason)).toEqual(expect.arrayContaining(['header row']));
    for (const { targets } of [golden, hillsdale, dn]) {
      expect(targets.every((target) => Number.isFinite(target.truth.rate))).toBe(true);
    }
  });

  it('parses only plain single amounts and compares text without spacing, case or dash noise', () => {
    expect(parseLabelRate('$ 1,250.50')).toBe(1250.5);
    expect(parseLabelRate('$6.90')).toBe(6.9);
    expect(parseLabelRate('$6.90 / $7.00')).toBeNull();
    expect(parseLabelRate('N/A')).toBeNull();
    expect(normalizeReadingText('0–15  Miles from ROW to DMS')).toBe(normalizeReadingText('0-15 miles from row to dms'));
    expect(normalizeReadingText('0 - 15')).toBe('0-15');
    expect(normalizeReadingText('Cubic Yard')).not.toBe(normalizeReadingText('CY'));
  });
});

describe('B4.6 scoring: a confident wrong rate is the unsafe outcome', () => {
  const truth = { description: 'Debris removal', unit: 'CY', rate: 14.5, category: null };
  const value = (overrides: Partial<{ description: string; unit_type: string; rate_amount: number; category: string | null }>) => ({
    kind: 'value' as const, rateRow: { description: 'Debris removal', unit_type: 'CY', rate_amount: 14.5, category: null, ...overrides } });

  it('separates correct, abstained, wrong rate, field mismatch and failure', () => {
    expect(scoreValueReading(truth, value({})).outcome).toBe('correct');
    expect(scoreValueReading(truth, value({ rate_amount: 14.50000 })).outcome).toBe('correct');
    expect(scoreValueReading(truth, { kind: 'unreadable' })).toEqual({ outcome: 'abstained', fields: null });
    expect(scoreValueReading(truth, value({ rate_amount: 145 })).outcome).toBe('wrong_rate');
    expect(scoreValueReading(truth, value({ unit_type: 'TON' })).outcome).toBe('field_mismatch');
    expect(scoreValueReading(truth, { kind: 'failed', code: 'provider_failed', reason: 'provider_timeout' }).outcome).toBe('failed');
    // A wrong rate is wrong whatever else matches.
    expect(scoreValueReading(truth, value({ rate_amount: 14.05, unit_type: 'CY' })).outcome).toBe('wrong_rate');
  });

  it('scores the category only where the page labels one', () => {
    const withCategory = { ...truth, category: 'Vegetative' };
    expect(scoreValueReading(withCategory, value({ category: 'vegetative' })).fields?.category).toBe(true);
    expect(scoreValueReading(withCategory, value({ category: null })).outcome).toBe('field_mismatch');
    expect(scoreValueReading(truth, value({ category: 'anything' })).fields?.category).toBeNull();
  });
});

const record = (overrides: Partial<ValueReadingBenchmarkRecord>): ValueReadingBenchmarkRecord => ({
  pageKey: 'golden-p8', evidenceClass: 'ocr_price_sheet', rowKey: 'r', outcome: 'correct',
  fields: { rate: true, unit: true, description: true, category: null },
  renderMs: 100, providerMs: 2000, totalMs: 2100, inputTokens: 1500, outputTokens: 80, usd: 0.006,
  renderDigestSha256: 'a'.repeat(64), reuseEligible: true, ...overrides,
});
const rows = (count: number, overrides: Partial<ValueReadingBenchmarkRecord> = {}) =>
  Array.from({ length: count }, (_, index) => record({ rowKey: `r-${index}`, ...overrides }));

describe('B4.6 pre-registered activation decision', () => {
  it('is conservative by construction', () => {
    expect(VALUE_READING_ACTIVATION_BAR).toEqual({ maxWrongRateReadings: 0, minCorrectShare: 0.8,
      maxP95TotalLatencyMs: 8000, maxUsdPerCorrectReading: 0.05, minRowsPerClass: 20 });
  });

  it('PASS only when every evidence class meets every bar', () => {
    const result = decideValueReadingActivation([
      ...rows(30),
      ...rows(20, { pageKey: 'dn-p107', evidenceClass: 'dense_scanned_ocr_priced_schedule' }),
    ]);
    expect(result).toMatchObject({ decision: 'PASS', provisional: false,
      qualifiedClasses: ['ocr_price_sheet', 'dense_scanned_ocr_priced_schedule'] });
  });

  it('rewards honest abstention and disqualifies a class for one confident wrong rate', () => {
    // 20% abstention still meets the bar.
    const honest = [...rows(24), ...rows(6, { outcome: 'abstained', fields: null, usd: 0.006 })];
    const dn = rows(20, { pageKey: 'dn-p107', evidenceClass: 'dense_scanned_ocr_priced_schedule' });
    expect(decideValueReadingActivation([...honest, ...dn]).decision).toBe('PASS');
    // One wrong rate in the dense class leaves only the price-sheet class qualified.
    const wrong = [...dn.slice(1), record({ pageKey: 'dn-p107', evidenceClass: 'dense_scanned_ocr_priced_schedule',
      rowKey: 'bad', outcome: 'wrong_rate', fields: { rate: false, unit: true, description: true, category: null } })];
    const limited = decideValueReadingActivation([...honest, ...wrong]);
    expect(limited).toMatchObject({ decision: 'LIMITED_PASS', qualifiedClasses: ['ocr_price_sheet'], provisional: true });
    expect(limited.classes[1]!.failures).toContain('1 confident wrong rate(s); at most 0 allowed');
  });

  it('fails on latency, cost, too few correct rows, or too few rows', () => {
    const dn = rows(20, { pageKey: 'dn-p107', evidenceClass: 'dense_scanned_ocr_priced_schedule' });
    for (const bad of [
      rows(30, { totalMs: 9000 }),
      rows(30, { usd: 0.2 }),
      [...rows(20), ...rows(10, { outcome: 'failed', fields: null })],
      rows(10),
    ]) {
      expect(decideValueReadingActivation([...bad, ...dn]).qualifiedClasses).toEqual(['dense_scanned_ocr_priced_schedule']);
    }
    expect(decideValueReadingActivation(rows(30, { outcome: 'abstained', fields: null })).decision).toBe('FAIL');
  });

  it('turns a disagreement into a correct reading only on a human ruling, and stays provisional until ruled', () => {
    const disputed = record({ rowKey: 'd', outcome: 'wrong_rate', fields: { rate: false, unit: true, description: true, category: null } });
    const base = [...rows(29), disputed];
    expect(decideValueReadingActivation(base)).toMatchObject({ decision: 'FAIL', provisional: true });
    const ruledForReading = applyValueReadingAdjudications(base, [{ pageKey: 'golden-p8', rowKey: 'd', verdict: 'reading_correct' }]);
    expect(decideValueReadingActivation(ruledForReading)).toMatchObject({ decision: 'PASS', provisional: false });
    expect(ruledForReading.at(-1)).toMatchObject({ outcome: 'correct', adjudication: 'reading_correct' });
    const ruledForLabel = applyValueReadingAdjudications(base, [{ pageKey: 'golden-p8', rowKey: 'd', verdict: 'label_correct' }]);
    expect(decideValueReadingActivation(ruledForLabel)).toMatchObject({ decision: 'FAIL', provisional: false });
  });

  it('reports latency, cost per attempt and per correct reading, and the reuse rate', () => {
    const summary = decideValueReadingActivation([...rows(29), record({ rowKey: 'x', reuseEligible: false })]).overall;
    expect(summary.latencyMs).toEqual({ renderP50: 100, providerP50: 2000, totalP50: 2100, totalP95: 2100 });
    expect(summary.cost.usdPerCorrect).toBeCloseTo(0.006);
    expect(summary.cost.usdPerAttempt).toBeCloseTo(0.006);
    expect(summary.reuseRate).toBeCloseTo(29 / 30);
  });
});

describe('B4.6 transmission clearance', () => {
  const pinned = new Map([['golden', '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f'],
    ['hillsdale', '596adaccf865625723dc832f5206a8f690eb17d96921ef185df35b113c767537'],
    ['dn', '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272']]);
  const committed = JSON.parse(readFileSync('scripts/evaluation/b46/transmission-clearance.json', 'utf8')) as {
    documents: Record<string, Record<string, unknown>> };

  it('the committed record clears nothing until someone records an approval', () => {
    expect(readValueReadingClearance(committed, pinned).map((entry) => [entry.documentKey, entry.cleared]))
      .toEqual([['golden', false], ['hillsdale', false], ['dn', false]]);
  });

  it('clears a document only with who, when and basis, for exactly the pinned bytes', () => {
    const approve = (overrides: Record<string, unknown>) => ({ ...committed, documents: { ...committed.documents,
      golden: { ...committed.documents.golden, pageRegionImages: true, approvedBy: 'Eric', approvedAt: '2026-10-05T12:00:00Z',
        basis: 'Public procurement record', ...overrides } } });
    expect(readValueReadingClearance(approve({}), pinned)[0]).toMatchObject({ cleared: true });
    expect(readValueReadingClearance(approve({ basis: ' ' }), pinned)[0]).toMatchObject({ cleared: false });
    expect(readValueReadingClearance(approve({ approvedAt: 'soon' }), pinned)[0]).toMatchObject({ cleared: false });
    expect(readValueReadingClearance(approve({ sha256: 'b'.repeat(64) }), pinned)[0])
      .toMatchObject({ cleared: false, detail: 'clearance names other source bytes' });
    expect(readValueReadingClearance(null, pinned).every((entry) => !entry.cleared)).toBe(true);
    expect(readValueReadingClearance({ ...approve({}), version: 'v0' }, pinned).every((entry) => !entry.cleared)).toBe(true);
  });
});
