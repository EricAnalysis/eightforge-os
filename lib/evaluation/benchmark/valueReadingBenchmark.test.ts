import { existsSync, readFileSync } from 'node:fs';

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
  VALUE_READING_AUTHORITY_INVARIANTS,
  VALUE_READING_BENCHMARK_PAGES,
  valueReadingBenchmarkTargets,
  type ValueReadingBenchmarkRecord,
  type ValueReadingBenchmarkTarget,
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

describe('B4.6 scoring: a confident wrong value is the unsafe outcome', () => {
  const target: ValueReadingBenchmarkTarget = {
    pageKey: 'dn-p107', evidenceClass: 'dense_scanned_ocr_priced_schedule', rowKey: 'r', boxes: [],
    truth: { description: 'Vegetative Debris Removal', unit: 'CY', rate: 38, category: null },
    // This row's quantity and extended amount, and another row's rate.
    otherPageAmounts: [7500, 285000, 24], pageUnits: ['cy', 'ton', 'ea'], pageHasCategory: false,
  };
  const value = (overrides: Partial<{ description: string; unit_type: string; rate_amount: number; category: string | null }>) => ({
    kind: 'value' as const, rateRow: { description: 'Vegetative Debris Removal', unit_type: 'CY', rate_amount: 38, category: null,
      ...overrides } });

  it('separates correct, abstained, wrong rate, field mismatch and failure', () => {
    expect(scoreValueReading(target, value({}))).toEqual({ outcome: 'correct',
      fields: { rate: true, unit: true, description: true, category: null }, rateError: null, inventions: [] });
    expect(scoreValueReading(target, value({ rate_amount: 38.0 })).outcome).toBe('correct');
    expect(scoreValueReading(target, { kind: 'unreadable' })).toMatchObject({ outcome: 'abstained', fields: null });
    expect(scoreValueReading(target, value({ unit_type: 'TON' })).outcome).toBe('field_mismatch');
    expect(scoreValueReading(target, { kind: 'failed', code: 'provider_failed', reason: 'provider_timeout' }).outcome).toBe('failed');
  });

  it('tells a wrong source-region binding from a critical hallucination', () => {
    // The extended amount, the quantity, or a neighbouring row: read from the wrong place on the page.
    for (const misread of [285000, 7500, 24]) {
      expect(scoreValueReading(target, value({ rate_amount: misread }))).toMatchObject({ outcome: 'wrong_rate', rateError: 'wrong_binding' });
    }
    // A number the page never prints.
    expect(scoreValueReading(target, value({ rate_amount: 83 }))).toMatchObject({ outcome: 'wrong_rate', rateError: 'critical_hallucination' });
  });

  it('flags a category or unit the page does not show as an unsupported invention, even beside a correct rate', () => {
    expect(scoreValueReading(target, value({ category: 'Roadway items' }))).toMatchObject({ outcome: 'correct', inventions: ['category'] });
    expect(scoreValueReading(target, value({ unit_type: 'Cubic Yard' }))).toMatchObject({ outcome: 'field_mismatch', inventions: ['unit'] });
    // A unit printed elsewhere on the page is a mismatch, not an invention.
    expect(scoreValueReading(target, value({ unit_type: 'TON' })).inventions).toEqual([]);
  });

  it('scores the category only where the page labels one', () => {
    const withCategory = { ...target, truth: { ...target.truth, category: 'Vegetative' }, pageHasCategory: true };
    expect(scoreValueReading(withCategory, value({ category: 'vegetative' })).fields?.category).toBe(true);
    expect(scoreValueReading(withCategory, value({ category: null })).outcome).toBe('field_mismatch');
  });

  it('derives binding and invention context from the real labels', () => {
    const dn = valueReadingBenchmarkTargets(labels('dn-p107'), page('dn-p107')).targets[0]!;
    expect(dn.otherPageAmounts).toEqual(expect.arrayContaining([7500, 285000, 24]));
    expect(dn.otherPageAmounts).not.toContain(undefined);
    expect(dn.pageUnits).toEqual(expect.arrayContaining(['cy', 'ton', 'ea']));
    expect(dn.pageHasCategory).toBe(false);
    expect(valueReadingBenchmarkTargets(labels('golden-p8'), page('golden-p8')).targets[0]!.pageHasCategory).toBe(true);
  });
});

const record = (overrides: Partial<ValueReadingBenchmarkRecord>): ValueReadingBenchmarkRecord => ({
  pageKey: 'golden-p8', evidenceClass: 'ocr_price_sheet', rowKey: 'r', outcome: 'correct',
  fields: { rate: true, unit: true, description: true, category: null }, rateError: null, inventions: [],
  providerCalled: true, failureReason: null,
  renderMs: 100, providerMs: 2000, totalMs: 2100, inputTokens: 1500, outputTokens: 80, usd: 0.006,
  renderDigestSha256: 'a'.repeat(64), reuseEligible: true, ...overrides,
});
const rows = (count: number, overrides: Partial<ValueReadingBenchmarkRecord> = {}) =>
  Array.from({ length: count }, (_, index) => record({ rowKey: `r-${index}`, ...overrides }));
const dnRows = (count: number, overrides: Partial<ValueReadingBenchmarkRecord> = {}) =>
  rows(count, { pageKey: 'dn-p107', evidenceClass: 'dense_scanned_ocr_priced_schedule', ...overrides });
const abstained = { outcome: 'abstained' as const, fields: null };

describe('B4.6 controlled-activation bar', () => {
  it('is the confirmed bar', () => {
    expect(VALUE_READING_ACTIVATION_BAR).toEqual({
      minRatePrecision: 0.99, maxCriticalHallucinations: 0, maxUnsupportedInventions: 0, maxWrongBindings: 0,
      minResolvedShareOfReadable: 0.8, maxP50TotalLatencyMs: 3000, maxP95TotalLatencyMs: 8000,
      maxUsdPerAttempt: 0.05, maxUsdPerCorrect: 0.1, minReuseRate: 1, minRowsPerClass: 20 });
  });

  it('PASS when every class meets every bar at full coverage, with the authority invariants attached', () => {
    const result = decideValueReadingActivation([...rows(30), ...dnRows(20)]);
    expect(result).toMatchObject({ decision: 'PASS', provisional: false, corpusSafetyFailures: [],
      qualifiedClasses: [{ evidenceClass: 'ocr_price_sheet', status: 'qualified' },
        { evidenceClass: 'dense_scanned_ocr_priced_schedule', status: 'qualified' }] });
    expect(result.authorityInvariants.map((entry) => entry.invariant)).toHaveLength(4);
  });

  it('prefers abstention: unreadable never hurts precision, only coverage, and low coverage is at most a LIMITED PASS', () => {
    // 24 correct + 6 honest abstentions: 80% resolved, still a full qualification.
    expect(decideValueReadingActivation([...rows(24), ...rows(6, abstained), ...dnRows(20)]).decision).toBe('PASS');
    // Heavy abstention with perfect precision: qualified at low coverage, never PASS.
    const cautious = decideValueReadingActivation([...rows(15), ...rows(15, abstained), ...dnRows(20)]);
    expect(cautious).toMatchObject({ decision: 'LIMITED_PASS', qualifiedClasses: [
      { evidenceClass: 'ocr_price_sheet', status: 'qualified_low_coverage' },
      { evidenceClass: 'dense_scanned_ocr_priced_schedule', status: 'qualified' }] });
    expect(cautious.classes[0]!.accuracy.ratePrecision).toBe(1);
    // A human confirming the abstentions genuinely unreadable takes them out of the denominator.
    const ruledUnreadable = [...rows(15), ...rows(15, abstained).map((entry, index) => ({ ...entry, rowKey: `a-${index}` })), ...dnRows(20)];
    const allConfirmed = applyValueReadingAdjudications(ruledUnreadable,
      Array.from({ length: 15 }, (_, index) => ({ pageKey: 'golden-p8', rowKey: `a-${index}`, verdict: 'target_unreadable' as const })));
    expect(decideValueReadingActivation(allConfirmed)).toMatchObject({ decision: 'PASS' });
    expect(decideValueReadingActivation(allConfirmed).classes[0]!.usefulness).toMatchObject({ readableTargets: 15, confirmedUnreadable: 15 });
  });

  it('fails the whole corpus on one hallucination, invention or wrong binding, wherever it occurs', () => {
    for (const unsafe of [
      { outcome: 'wrong_rate' as const, rateError: 'critical_hallucination' as const, fields: { rate: false, unit: true, description: true, category: null } },
      { outcome: 'wrong_rate' as const, rateError: 'wrong_binding' as const, fields: { rate: false, unit: true, description: true, category: null } },
      { inventions: ['category' as const] },
    ]) {
      const result = decideValueReadingActivation([...rows(30), ...dnRows(19), ...dnRows(1, { rowKey: 'bad', ...unsafe })]);
      expect(result).toMatchObject({ decision: 'FAIL', qualifiedClasses: [], provisional: true });
      expect(result.corpusSafetyFailures).toHaveLength(1);
    }
  });

  it('enforces rate precision of at least 99% among value readings', () => {
    // 1 wrong in 50 value readings is 98%: fails, and the wrong rate is also a corpus safety failure.
    const result = decideValueReadingActivation([...rows(49), ...rows(1, { rowKey: 'w', outcome: 'wrong_rate',
      rateError: 'wrong_binding', fields: { rate: false, unit: true, description: true, category: null } }), ...dnRows(20)]);
    expect(result.classes[0]!.failures.join(' ')).toContain('rate precision 0.9800');
    // All abstentions: precision undefined, so nothing qualifies.
    expect(decideValueReadingActivation(rows(30, abstained)).decision).toBe('FAIL');
  });

  it('enforces median and p95 wait, cost per attempt and per correct reading, reuse, and class size', () => {
    for (const [bad, expected] of [
      [rows(30, { totalMs: 3500 }), 'median wait'],
      [[...rows(27), ...rows(3, { totalMs: 9000 })], 'p95 wait'],
      [rows(30, { usd: 0.06 }), 'cost per attempt'],
      // $0.045 an attempt is within budget, but 12 correct of 30 makes $0.1125 per correct reading.
      [[...rows(12), ...rows(18, { outcome: 'failed', fields: null }).map((entry, index) => ({ ...entry, rowKey: `f-${index}` }))]
        .map((entry) => ({ ...entry, usd: 0.045 })), 'cost per correct reading'],
      [[...rows(29), record({ rowKey: 'x', reuseEligible: false })], 'reuse rate'],
      [rows(10), 'only 10 rows'],
    ] as const) {
      const result = decideValueReadingActivation([...bad, ...dnRows(20)]);
      expect(result.qualifiedClasses.map((entry) => entry.evidenceClass)).toEqual(['dense_scanned_ocr_priced_schedule']);
      expect(result.classes[0]!.failures.join(' ')).toContain(expected);
    }
  });

  it('turns a disagreement into a correct reading only on a human ruling, and stays provisional until ruled', () => {
    const disputed = record({ rowKey: 'd', outcome: 'wrong_rate', rateError: 'critical_hallucination',
      fields: { rate: false, unit: true, description: true, category: null } });
    const base = [...rows(29), disputed, ...dnRows(20)];
    expect(decideValueReadingActivation(base)).toMatchObject({ decision: 'FAIL', provisional: true });
    const forReading = applyValueReadingAdjudications(base, [{ pageKey: 'golden-p8', rowKey: 'd', verdict: 'reading_correct' }]);
    expect(decideValueReadingActivation(forReading)).toMatchObject({ decision: 'PASS', provisional: false });
    expect(forReading[29]).toMatchObject({ outcome: 'correct', rateError: null, adjudication: 'reading_correct' });
    const forLabel = applyValueReadingAdjudications(base, [{ pageKey: 'golden-p8', rowKey: 'd', verdict: 'label_correct' }]);
    expect(decideValueReadingActivation(forLabel)).toMatchObject({ decision: 'FAIL', provisional: false });
    // "Genuinely unreadable" cannot excuse a value reading.
    expect(applyValueReadingAdjudications([disputed], [{ pageKey: 'golden-p8', rowKey: 'd', verdict: 'target_unreadable' }])[0])
      .not.toHaveProperty('adjudication');
  });

  it('reports latency, timeouts, cost per attempt and per correct reading, and reuse', () => {
    const summary = decideValueReadingActivation([...rows(29),
      record({ rowKey: 'x', outcome: 'failed', fields: null, failureReason: 'provider_timeout' })]).overall;
    expect(summary.latencyMs).toMatchObject({ renderP50: 100, providerP50: 2000, totalP50: 2100, totalP95: 2100, timeouts: 1 });
    expect(summary.cost.attempts).toBe(30);
    expect(summary.cost.usdPerAttempt).toBeCloseTo(0.006);
    expect(summary.cost.usdPerCorrect).toBeCloseTo((30 * 0.006) / 29);
    expect(summary.cost.reuseRate).toBe(1);
  });

  it('names the suites that prove every authority invariant, and they exist', () => {
    for (const entry of VALUE_READING_AUTHORITY_INVARIANTS) {
      for (const file of entry.provenBy) expect(existsSync(file), file).toBe(true);
    }
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
