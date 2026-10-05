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
    // Page evidence: this row's quantity and extended amount and the next row's rate (in the crop),
    // a rate further down the page, and a total printed outside the table (not in the crop).
    pageOtherValues: [
      { amount: 7500, source: 'cell', labelId: 'c-qty', rowKey: 'r', columnName: 'Qty', inCrop: true },
      { amount: 285000, source: 'cell', labelId: 'c-ext', rowKey: 'r', columnName: 'Extended Amount', inCrop: true },
      { amount: 24, source: 'cell', labelId: 'c-next', rowKey: 'r-next', columnName: 'Unit Cost', inCrop: true },
      { amount: 425, source: 'cell', labelId: 'c-far', rowKey: 'r-far', columnName: 'Unit Cost', inCrop: false },
      { amount: 1234567, source: 'word', labelId: 'w-total', rowKey: null, columnName: null, inCrop: false },
    ],
    supportedCategories: ['roadway items'],
  };
  const value = (overrides: Partial<{ description: string; unit_type: string; rate_amount: number; category: string | null }>) => ({
    kind: 'value' as const, rateRow: { description: 'Vegetative Debris Removal', unit_type: 'CY', rate_amount: 38, category: null,
      ...overrides } });

  it('separates correct, abstained, wrong rate, field mismatch and failure', () => {
    expect(scoreValueReading(target, value({}))).toEqual({ outcome: 'correct',
      fields: { rate: true, unit: true, description: true, category: null }, rateError: null, boundTo: null, inventions: [] });
    expect(scoreValueReading(target, value({ rate_amount: 38.0 })).outcome).toBe('correct');
    expect(scoreValueReading(target, { kind: 'unreadable' })).toMatchObject({ outcome: 'abstained', fields: null });
    expect(scoreValueReading(target, value({ description: 'Vegetative Debris' })).outcome).toBe('field_mismatch');
    expect(scoreValueReading(target, { kind: 'failed', code: 'provider_failed', reason: 'provider_timeout' }).outcome).toBe('failed');
  });

  it('the target region alone decides correctness: no value from elsewhere is ever accepted', () => {
    for (const elsewhere of [285000, 7500, 24, 425, 1234567, 17.8]) {
      const scored = scoreValueReading(target, value({ rate_amount: elsewhere }));
      expect(scored.outcome).toBe('wrong_rate');
      expect(scored.fields?.rate).toBe(false);
    }
  });

  it('a wrong rate that exists elsewhere in the page evidence is a wrong source-region binding, traced to where it is', () => {
    // Target $38; returned $425, which is another row's rate on this page.
    expect(scoreValueReading(target, value({ rate_amount: 425 }))).toMatchObject({ outcome: 'wrong_rate',
      rateError: 'wrong_source_region_binding', boundTo: { rowKey: 'r-far', inCrop: false } });
    expect(scoreValueReading(target, value({ rate_amount: 285000 })))
      .toMatchObject({ rateError: 'wrong_source_region_binding', boundTo: { columnName: 'Extended Amount', inCrop: true } });
    expect(scoreValueReading(target, value({ rate_amount: 24 }))).toMatchObject({ boundTo: { rowKey: 'r-next' } });
    // A number printed outside the table is page evidence too.
    expect(scoreValueReading(target, value({ rate_amount: 1234567 }))).toMatchObject({
      rateError: 'wrong_source_region_binding', boundTo: { source: 'word' } });
  });

  it('a wrong rate printed nowhere in the page evidence is an unsupported numeric invention', () => {
    // Target $38; returned $17.80, which exists nowhere in the source evidence.
    expect(scoreValueReading(target, value({ rate_amount: 17.8 }))).toMatchObject({ outcome: 'wrong_rate',
      rateError: 'unsupported_numeric_invention', boundTo: null });
  });

  it('prefers the trace the model most plausibly copied when a value appears more than once', () => {
    const twice: ValueReadingBenchmarkTarget = { ...target, pageOtherValues: [
      { amount: 90, source: 'word', labelId: 'w', rowKey: null, columnName: null, inCrop: false },
      { amount: 90, source: 'cell', labelId: 'far', rowKey: 'r-far', columnName: 'Unit Cost', inCrop: false },
      { amount: 90, source: 'cell', labelId: 'near', rowKey: 'r-next', columnName: 'Unit Cost', inCrop: true },
    ] };
    expect(scoreValueReading(twice, value({ rate_amount: 90 })).boundTo).toMatchObject({ labelId: 'near' });
  });

  it('a unit is supported only by the target row, and a category only by the row or its section heading', () => {
    // TON is printed elsewhere on the page, but not in this row: unsupported.
    expect(scoreValueReading(target, value({ unit_type: 'TON' }))).toMatchObject({ outcome: 'field_mismatch', inventions: ['unit'] });
    expect(scoreValueReading(target, value({ unit_type: 'Cubic Yard' })).inventions).toEqual(['unit']);
    expect(scoreValueReading(target, value({ unit_type: ' cy ' })).inventions).toEqual([]);
    // The preceding section heading is allowed structural context; anything else is invented.
    expect(scoreValueReading(target, value({ category: 'ROADWAY ITEMS' }))).toMatchObject({ outcome: 'correct', inventions: [] });
    expect(scoreValueReading(target, value({ category: 'Debris' }))).toMatchObject({ outcome: 'correct', inventions: ['category'] });
  });

  it('scores the category only where the page labels one', () => {
    const withCategory = { ...target, truth: { ...target.truth, category: 'Vegetative' }, supportedCategories: ['vegetative'] };
    expect(scoreValueReading(withCategory, value({ category: 'vegetative' })).fields?.category).toBe(true);
    expect(scoreValueReading(withCategory, value({ category: null })).outcome).toBe('field_mismatch');
  });

  it('derives the visible region and the supporting context from the real labels', () => {
    const dn = valueReadingBenchmarkTargets(labels('dn-p107'), page('dn-p107'));
    const first = dn.targets[0]!;
    // This row's own quantity and extended amount are page evidence, inside the crop.
    expect(first.pageOtherValues.filter((entry) => entry.rowKey === first.rowKey && entry.inCrop).map((entry) => entry.amount))
      .toEqual(expect.arrayContaining([7500, 285000]));
    // A rate far down the page is page evidence too, outside the crop.
    expect(first.pageOtherValues.find((entry) => entry.amount === 2000)).toMatchObject({ inCrop: false });
    // The target's own rate is never "other" evidence, from its cell or its words.
    expect(first.pageOtherValues.some((entry) => entry.rowKey === first.rowKey && entry.columnName === 'Unit Cost')).toBe(false);
    expect(first.supportedCategories).toEqual(['roadway items']);
    expect(dn.skipped.map((entry) => entry.reason)).toEqual(expect.arrayContaining(['section heading']));
    const golden = valueReadingBenchmarkTargets(labels('golden-p8'), page('golden-p8')).targets[0]!;
    expect(golden.supportedCategories).toEqual(['vegetative collect, remove & haul from unincorporated neighborhoods']);
  });
});

const record = (overrides: Partial<ValueReadingBenchmarkRecord>): ValueReadingBenchmarkRecord => ({
  pageKey: 'golden-p8', evidenceClass: 'ocr_price_sheet', rowKey: 'r', outcome: 'correct',
  fields: { rate: true, unit: true, description: true, category: null }, rateError: null, boundTo: null, inventions: [],
  requestDigestSha256: 'b'.repeat(64), outputDigestSha256: 'c'.repeat(64), providerCalled: true, failureReason: null,
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
      minRatePrecision: 0.99, maxWrongSourceRegionBindings: 0, maxUnsupportedNumericInventions: 0, maxUnsupportedValueInventions: 0,
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

  it('fails the whole corpus on one wrong binding, numeric invention or value invention, wherever it occurs', () => {
    for (const unsafe of [
      { outcome: 'wrong_rate' as const, rateError: 'unsupported_numeric_invention' as const, fields: { rate: false, unit: true, description: true, category: null } },
      { outcome: 'wrong_rate' as const, rateError: 'wrong_source_region_binding' as const, fields: { rate: false, unit: true, description: true, category: null } },
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
      rateError: 'wrong_source_region_binding', fields: { rate: false, unit: true, description: true, category: null } }), ...dnRows(20)]);
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
    const disputed = record({ rowKey: 'd', outcome: 'wrong_rate', rateError: 'unsupported_numeric_invention',
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

  it('the committed record clears the three corpus documents for the benchmark scope only, with who, when and why', () => {
    const entries = readValueReadingClearance(committed, pinned);
    expect(entries.map((entry) => [entry.documentKey, entry.cleared])).toEqual([['golden', true], ['hillsdale', true], ['dn', true]]);
    expect(entries[0]!.detail).toContain('Eric');
    expect((committed as unknown as { scope: string }).scope).toBe('b46_value_reading_benchmark');
    // The same approvals under any other scope clear nothing.
    expect(readValueReadingClearance({ ...committed, scope: 'production' }, pinned).every((entry) => !entry.cleared)).toBe(true);
    expect(readValueReadingClearance({ ...committed, scope: undefined }, pinned).every((entry) => !entry.cleared)).toBe(true);
  });

  it('clears a document only with who, when and basis, for exactly the pinned bytes', () => {
    const approve = (overrides: Record<string, unknown>) => ({ ...committed, documents: { ...committed.documents,
      golden: { ...committed.documents.golden, pageRegionImages: true, approvedBy: 'Eric', approvedAt: '2026-10-05T12:00:00Z',
        basis: 'Public procurement record', ...overrides } } });
    expect(readValueReadingClearance(approve({ pageRegionImages: false }), pinned)[0]).toMatchObject({ cleared: false });
    expect(readValueReadingClearance(approve({}), pinned)[0]).toMatchObject({ cleared: true });
    expect(readValueReadingClearance(approve({ basis: ' ' }), pinned)[0]).toMatchObject({ cleared: false });
    expect(readValueReadingClearance(approve({ approvedAt: 'soon' }), pinned)[0]).toMatchObject({ cleared: false });
    expect(readValueReadingClearance(approve({ sha256: 'b'.repeat(64) }), pinned)[0])
      .toMatchObject({ cleared: false, detail: 'clearance names other source bytes' });
    expect(readValueReadingClearance(null, pinned).every((entry) => !entry.cleared)).toBe(true);
    expect(readValueReadingClearance({ ...approve({}), version: 'v0' }, pinned).every((entry) => !entry.cleared)).toBe(true);
  });
});
