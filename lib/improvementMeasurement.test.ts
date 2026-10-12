import { describe, expect, it } from 'vitest';

import {
  FRICTION_MEASUREMENT_V1,
  improvementProblemFromSignal,
  improvementProblemKey,
  improvementSourceMeasurability,
  measureFriction,
  type FrictionMeasurementInput,
  type MeasurementUnit,
} from '@/lib/improvementMeasurement';

const ORG = 'b8400000-0000-4000-8000-000000000001';
const OLD = 'a'.repeat(40);
const FIXED = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const problem = { organizationId: ORG, signalKind: 'recurring_deterministic_failure' as const, code: 'ocr_low_confidence' };
const windows = {
  baseline: { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
  post: { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
};
const classification = { [`revision:${OLD}`]: 'lacks_fix', [`revision:${FIXED}`]: 'contains_fix' } as const;

let sequence = 0;
function units(count: number, occurrences: number, options: Readonly<{
  revision?: string; at?: string; configuration?: Record<string, string | null>; unattributed?: boolean;
}> = {}): MeasurementUnit[] {
  return Array.from({ length: count }, (_, index) => ({
    unitRef: `document_extraction:${(sequence += 1)}`,
    observedAt: options.at ?? '2026-09-15T00:00:00Z',
    attribution: options.unattributed
      ? { status: 'unattributed' as const, reason: 'producer_not_recorded' as const }
      : { status: 'attributed' as const, producer: { kind: 'deployment_revision' as const, revision: options.revision ?? OLD } },
    configuration: options.configuration ?? {},
    occurred: index < occurrences,
  }));
}
const baseline = (count: number, occurrences: number, options = {}) => units(count, occurrences, { revision: OLD, at: '2026-09-15T00:00:00Z', ...options });
const post = (count: number, occurrences: number, options = {}) => units(count, occurrences, { revision: FIXED, at: '2026-10-15T00:00:00Z', ...options });

function measure(unitList: MeasurementUnit[], overrides: Partial<FrictionMeasurementInput> = {}) {
  const result = measureFriction({ problem, windows, producerClassification: classification, fixDimensions: [],
    readTruncated: false, units: unitList, ...overrides });
  if (!result.ok) throw new Error(result.code);
  return result.measurement;
}

describe('improvement problem identity (B8.4a)', () => {
  it('is stable across changing counts and fingerprints, and distinct across org, kind and code', () => {
    const key = improvementProblemKey(problem);
    expect(key).toMatch(/^improvement_problem_v1:sha256:[0-9a-f]{64}$/u);
    const fromPayload = improvementProblemFromSignal(ORG, { signalKind: problem.signalKind, code: problem.code });
    expect(improvementProblemKey(fromPayload!)).toBe(key);
    expect(improvementProblemKey({ ...problem, code: 'other' })).not.toBe(key);
    expect(improvementProblemKey({ ...problem, organizationId: 'b8400000-0000-4000-8000-000000000002' })).not.toBe(key);
    expect(improvementProblemKey({ ...problem, signalKind: 'recurring_manual_correction' })).not.toBe(key);
    // Qualification demand is a policy question with no exposure: not a measurable problem.
    expect(improvementProblemFromSignal(ORG, { signalKind: 'qualification_demand', code: 'priced_value_reading' })).toBeNull();
  });

  it('measures only requests that carry originating friction', () => {
    expect(improvementSourceMeasurability({ sourceKind: 'triaged_improvement_signal', submissionId: ORG,
      triageReviewId: ORG, triageVersion: 1 })).toEqual({ measurable: true });
    expect(improvementSourceMeasurability({ assessmentId: ORG, assessmentVersion: 1, reviewId: ORG, reviewVersion: 1 }))
      .toEqual({ measurable: false, reason: 'assessment_sourced_no_originating_friction' });
    expect(improvementSourceMeasurability(null)).toEqual({ measurable: false, reason: 'unknown_source' });
  });
});

describe('friction_measurement_v1 thresholds (B8.4a)', () => {
  it('pins the owner policy', () => {
    expect(FRICTION_MEASUREMENT_V1).toEqual({ version: 'friction_measurement_v1', minimumBaselineExposure: 20,
      minimumPostExposure: 20, minimumBaselineOccurrences: 2, maximumPostToBaselineRate: { numerator: 1, denominator: 2 } });
  });

  it('yields a resolution candidate at exactly a 50% relative reduction, and recurred just above it', () => {
    // Baseline 4/20 = 20%. Post 4/40 = 10% (exactly half) -> candidate; 5/40 = 12.5% -> recurred.
    const candidate = measure([...baseline(20, 4), ...post(40, 4)]);
    expect(candidate.outcome).toBe('resolution_candidate');
    expect(candidate.rateComparison).toEqual({ baseline: { occurrences: 4, exposure: 20 },
      post: { occurrences: 4, exposure: 40 }, postWithinReductionThreshold: true });
    expect(measure([...baseline(20, 4), ...post(40, 5)]).outcome).toBe('recurred');
  });

  it('never reads lower volume as improvement: rates, not counts', () => {
    // Same 20% rate on half the volume: fewer occurrences, no improvement.
    const result = measure([...baseline(40, 8), ...post(20, 4)]);
    expect(result.rateComparison.post.occurrences).toBeLessThan(result.rateComparison.baseline.occurrences);
    expect(result.outcome).toBe('recurred');
  });

  it('refuses a fake 100% improvement from a tiny baseline', () => {
    const result = measure([...baseline(20, 1), ...post(20, 0)]);
    expect(result.outcome).toBe('insufficient_exposure');
    expect(result.reasons).toEqual(['baseline_occurrences_below_minimum']);
  });

  it('requires comparable exposure on both sides', () => {
    expect(measure([...baseline(19, 5), ...post(20, 0)]).reasons).toEqual(['baseline_exposure_below_minimum']);
    expect(measure([...baseline(20, 5), ...post(19, 0)]).reasons).toEqual(['post_exposure_below_minimum']);
    // Production today: nothing has shipped through the chain yet.
    expect(measure([]).outcome).toBe('insufficient_exposure');
  });
});

describe('attribution and segmentation (B8.4a)', () => {
  it('excludes units whose producer is unproven, never inventing one', () => {
    const result = measure([...baseline(20, 4), ...post(40, 2), ...post(10, 10, { unattributed: true })]);
    expect(result.post.exposure).toBe(40);
    expect(result.post.excluded.unattributed).toBe(10);
    expect(result.outcome).toBe('resolution_candidate');
    // A window with only unattributed units is unmeasurable, not "zero friction".
    const blind = measure([...baseline(20, 4), ...post(40, 0, { unattributed: true })]);
    expect(blind.outcome).toBe('unmeasurable');
    expect(blind.reasons).toEqual(['post_attribution_unavailable']);
  });

  it('keeps each unit on its producer side; units from the wrong side or an unknown producer are excluded', () => {
    // During rollout, an old producer still ran after the boundary, and a fixed one before it.
    const result = measure([...baseline(20, 4), ...post(40, 0),
      ...units(5, 5, { revision: OLD, at: '2026-10-20T00:00:00Z' }),
      ...units(3, 0, { revision: FIXED, at: '2026-09-20T00:00:00Z' }),
      ...units(4, 4, { revision: OTHER, at: '2026-10-20T00:00:00Z' })]);
    expect(result.post).toMatchObject({ exposure: 40, occurrences: 0,
      excluded: { unattributed: 0, unclassified_producer: 4, producer_window_mismatch: 5 } });
    expect(result.baseline.excluded.producer_window_mismatch).toBe(3);
    expect(result.post.producers).toEqual([`revision:${FIXED}`]);
  });

  it('segments Forgewing outcomes by request identity, not the app commit', () => {
    const before = 'd'.repeat(64);
    const after = 'e'.repeat(64);
    const forgewing = (count: number, occurrences: number, digest: string, at: string) =>
      units(count, occurrences, { at }).map((unit) => ({ ...unit,
        attribution: { status: 'attributed' as const, producer: { kind: 'forgewing_request' as const, identityDigest: digest } } }));
    const result = measure([...forgewing(20, 6, before, '2026-09-10T00:00:00Z'), ...forgewing(30, 2, after, '2026-10-10T00:00:00Z')], {
      problem: { ...problem, signalKind: 'forgewing_rejected', code: 'priced_value_reading' },
      producerClassification: { [`forgewing:${before}`]: 'lacks_fix', [`forgewing:${after}`]: 'contains_fix' } });
    expect(result.outcome).toBe('resolution_candidate');
  });

  it('ignores units outside both windows and counts them', () => {
    const result = measure([...baseline(20, 4), ...post(40, 0), ...units(7, 7, { at: '2026-12-01T00:00:00Z' })]);
    expect(result.unitsOutsideWindows).toBe(7);
  });
});

describe('confounders and unmeasurable reads (B8.4a)', () => {
  const mapping = (revision: string) => ({ customer_mapping_revision: revision });

  it('marks a customer mapping change between windows as confounded', () => {
    const result = measure([...baseline(20, 4, { configuration: mapping('rev-1:aa') }), ...post(40, 0, { configuration: mapping('rev-2:bb') })]);
    expect(result.outcome).toBe('confounded');
    expect(result.reasons).toEqual(['configuration_changed:customer_mapping_revision']);
    expect(measure([...baseline(20, 4, { configuration: mapping('rev-1:aa') }),
      ...post(40, 0, { configuration: mapping('rev-1:aa') })]).outcome).toBe('resolution_candidate');
  });

  it('allows the dimension the fix itself changes (a catalogue wording fix)', () => {
    const catalogue = (fingerprint: string) => ({ rule_catalogue: fingerprint });
    const unitList = [...baseline(20, 4, { configuration: catalogue('fp-1') }), ...post(40, 0, { configuration: catalogue('fp-2') })];
    expect(measure(unitList).outcome).toBe('confounded');
    expect(measure(unitList, { fixDimensions: ['rule_catalogue'] }).outcome).toBe('resolution_candidate');
  });

  it('confounding outranks thin exposure, and an unreliable read outranks both', () => {
    const thin = [...baseline(5, 2, { configuration: mapping('rev-1:aa') }), ...post(5, 0, { configuration: mapping('rev-2:bb') })];
    expect(measure(thin).outcome).toBe('confounded');
    expect(measure(thin, { readTruncated: true })).toMatchObject({ outcome: 'unmeasurable', reasons: ['read_truncated'] });
  });
});

describe('input integrity (B8.4a)', () => {
  const run = (overrides: Partial<FrictionMeasurementInput>) => measureFriction({ problem, windows,
    producerClassification: classification, fixDimensions: [], readTruncated: false, units: [], ...overrides });

  it('fails loudly instead of double counting or guessing', () => {
    const unit = baseline(1, 1)[0];
    expect(run({ units: [unit, unit] })).toEqual({ ok: false, code: 'duplicate_unit' });
    expect(run({ windows: { baseline: windows.baseline, post: { from: '2026-09-20T00:00:00Z', to: '2026-11-01T00:00:00Z' } } }))
      .toEqual({ ok: false, code: 'overlapping_windows' });
    expect(run({ windows: { baseline: { from: windows.baseline.to, to: windows.baseline.from }, post: windows.post } }))
      .toEqual({ ok: false, code: 'inverted_window' });
    expect(run({ units: [{ ...unit, attribution: { status: 'attributed', producer: { kind: 'deployment_revision', revision: 'HEAD' } } }] }))
      .toMatchObject({ ok: false, code: 'invalid_input' });
    expect(run({ problem: { ...problem, signalKind: 'qualification_demand' as never } })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('is deterministic: same evidence, same digest, regardless of unit order', () => {
    const unitList = [...baseline(20, 4), ...post(40, 1)];
    const a = measure(unitList);
    const b = measure([...unitList].reverse());
    expect(b.digest).toBe(a.digest);
    expect(measure(unitList, { fixDimensions: ['rule_catalogue'] }).digest).not.toBe(a.digest);
  });
});
