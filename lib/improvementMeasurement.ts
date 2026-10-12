import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { TRIAGED_SIGNAL_KINDS } from '@/lib/triagedSignalPlanSchema';

/**
 * B8.4a: measuring whether a shipped fix materially reduced the friction that
 * started it. Pure and deterministic: no IO, no clock, no writes.
 *
 * B8 is complete for a problem only when EightForge can show whether the
 * original friction decreased after deployment, against comparable exposure.
 * This module is the math and the attribution contract for that claim:
 *
 * - **Problem identity** is stable across changing counts: an organization, a
 *   signal kind and a controlled code. It is never the payload digest, which
 *   changes whenever a count does.
 * - **Measurement units** are single opportunities for the problem to occur
 *   (an extraction, a raised finding, a value-reading request). Each names the
 *   producer that actually made it: a deployment revision, or a Forgewing
 *   provider/model/prompt identity. A unit whose historical producer cannot be
 *   proven is never given an invented one; it is excluded and reported.
 * - **Segmentation** is by producer and time together. A baseline unit must come
 *   from a producer known to lack the fix; a post-deployment unit from one known
 *   to contain it. That classification is an input: B8.4b proves it by git
 *   ancestry. Units on the wrong side are excluded, never reassigned.
 * - **Policy** `friction_measurement_v1` decides the outcome from rates, never
 *   raw counts, so lower volume cannot read as improvement.
 *
 * The outcome is evidence for a person. `resolution_candidate` is not
 * `resolved`; nothing here closes work.
 */

// ---------------------------------------------------------------------------
// Problem identity
// ---------------------------------------------------------------------------

export const IMPROVEMENT_PROBLEM_IDENTITY_VERSION = 'improvement_problem_v1' as const;
/** Signal kinds with a defined exposure (qualification demand is a policy question, not a defect). */
export const MEASURABLE_SIGNAL_KINDS = TRIAGED_SIGNAL_KINDS;

const uuid = z.string().uuid();
export const ImprovementProblemSchema = z.object({
  organizationId: uuid,
  signalKind: z.enum(MEASURABLE_SIGNAL_KINDS),
  code: z.string().min(1).max(160),
}).strict();
export type ImprovementProblem = z.infer<typeof ImprovementProblemSchema>;

/**
 * The stable key of a problem. Counts, record refs and the rule catalogue
 * fingerprint are deliberately absent: a wording fix changes the fingerprint
 * and must still be measured as the same problem.
 */
export function improvementProblemKey(problem: ImprovementProblem): string {
  const parsed = ImprovementProblemSchema.parse(problem);
  return `${IMPROVEMENT_PROBLEM_IDENTITY_VERSION}:sha256:${hashCanonical({
    domain: 'eightforge.improvement-problem', version: IMPROVEMENT_PROBLEM_IDENTITY_VERSION,
    organizationId: parsed.organizationId, signalKind: parsed.signalKind, code: parsed.code,
  })}`;
}

/** The problem a submitted signal is about, from its allowlisted payload. */
export function improvementProblemFromSignal(organizationId: string, payload: Readonly<{ signalKind: string; code: string }>):
  ImprovementProblem | null {
  const parsed = ImprovementProblemSchema.safeParse({ organizationId, signalKind: payload.signalKind, code: payload.code });
  return parsed.success ? parsed.data : null;
}

/**
 * Whether an engineering request's source can be measured at all. Only a
 * triaged improvement signal carries originating friction; an assessment-sourced
 * request has none, so B8 recurrence never applies to it.
 */
export function improvementSourceMeasurability(reviewPin: unknown):
  Readonly<{ measurable: true }> | Readonly<{ measurable: false; reason: 'assessment_sourced_no_originating_friction' | 'unknown_source' }> {
  if (typeof reviewPin !== 'object' || reviewPin === null) return { measurable: false, reason: 'unknown_source' };
  const pin = reviewPin as Record<string, unknown>;
  if (pin.sourceKind === 'triaged_improvement_signal') return { measurable: true };
  if ('assessmentId' in pin && 'reviewId' in pin) return { measurable: false, reason: 'assessment_sourced_no_originating_friction' };
  return { measurable: false, reason: 'unknown_source' };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const FRICTION_MEASUREMENT_V1 = Object.freeze({
  version: 'friction_measurement_v1' as const,
  minimumBaselineExposure: 20,
  minimumPostExposure: 20,
  minimumBaselineOccurrences: 2,
  /** A resolution candidate needs post rate <= this fraction of the baseline rate (a 50% relative reduction). */
  maximumPostToBaselineRate: Object.freeze({ numerator: 1, denominator: 2 }),
});
export type FrictionMeasurementPolicy = typeof FRICTION_MEASUREMENT_V1;

// ---------------------------------------------------------------------------
// Units and input
// ---------------------------------------------------------------------------

const sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoInstant = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)),
  'must be an ISO-8601 instant');

/** Who actually produced the unit. Never the identity current at read time. */
export const MeasurementProducerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deployment_revision'), revision: sha1 }).strict(),
  /** Forgewing outcomes: the provider/model/prompt request identity, not merely the app commit. */
  z.object({ kind: z.literal('forgewing_request'), identityDigest: sha256 }).strict(),
]);
export type MeasurementProducer = z.infer<typeof MeasurementProducerSchema>;

export const UNATTRIBUTED_REASONS = [
  'producer_not_recorded',
  'historical_source_unproven',
] as const;

export const MeasurementUnitSchema = z.object({
  /** Opaque, unique reference (e.g. `document_extraction:<uuid>`). */
  unitRef: z.string().min(1).max(200),
  observedAt: isoInstant,
  attribution: z.discriminatedUnion('status', [
    z.object({ status: z.literal('attributed'), producer: MeasurementProducerSchema }).strict(),
    z.object({ status: z.literal('unattributed'), reason: z.enum(UNATTRIBUTED_REASONS) }).strict(),
  ]),
  /**
   * Configuration the unit was produced under, by dimension (e.g.
   * `customer_mapping_revision` -> `<revisionId>:<digest>`, `rule_catalogue` ->
   * fingerprint). Null means the dimension did not apply to this unit.
   */
  configuration: z.record(z.string().min(1).max(80), z.string().min(1).max(200).nullable()),
  /** Whether the problem occurred in this unit. */
  occurred: z.boolean(),
}).strict();
export type MeasurementUnit = z.infer<typeof MeasurementUnitSchema>;

const windowSchema = z.object({ from: isoInstant, to: isoInstant }).strict();

export const FrictionMeasurementInputSchema = z.object({
  problem: ImprovementProblemSchema,
  windows: z.object({ baseline: windowSchema, post: windowSchema }).strict(),
  /**
   * Producer key -> whether that producer contains the fix. Proven elsewhere
   * (git ancestry for deployment revisions); an absent producer is unclassified.
   */
  producerClassification: z.record(z.string(), z.enum(['contains_fix', 'lacks_fix'])),
  /** Configuration dimensions the fix itself is expected to change (e.g. the catalogue, for a wording fix). */
  fixDimensions: z.array(z.string().min(1).max(80)).max(20),
  /** True when the read that produced the units was cut short by a limit. */
  readTruncated: z.boolean(),
  units: z.array(MeasurementUnitSchema).max(100_000),
}).strict();
export type FrictionMeasurementInput = z.input<typeof FrictionMeasurementInputSchema>;

export function measurementProducerKey(producer: MeasurementProducer): string {
  return producer.kind === 'deployment_revision' ? `revision:${producer.revision}` : `forgewing:${producer.identityDigest}`;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export const FRICTION_MEASUREMENT_OUTCOMES = [
  'resolution_candidate', 'recurred', 'insufficient_exposure', 'confounded', 'unmeasurable',
] as const;
export type FrictionMeasurementOutcome = (typeof FRICTION_MEASUREMENT_OUTCOMES)[number];

type Rate = Readonly<{ occurrences: number; exposure: number }>;
export type WindowMeasurement = Readonly<{
  exposure: number;
  occurrences: number;
  /** Units in this window not counted, by reason. Never reassigned to the other window. */
  excluded: Readonly<{ unattributed: number; unclassified_producer: number; producer_window_mismatch: number }>;
  producers: readonly string[];
  configuration: Readonly<Record<string, readonly string[]>>;
}>;

export type FrictionMeasurement = Readonly<{
  policyVersion: FrictionMeasurementPolicy['version'];
  problemKey: string;
  outcome: FrictionMeasurementOutcome;
  /** Every reason that applies, in a fixed order. The outcome follows from the first decisive group. */
  reasons: readonly string[];
  baseline: WindowMeasurement;
  post: WindowMeasurement;
  /** Exact integer comparison; null when a rate is undefined. */
  rateComparison: Readonly<{ baseline: Rate; post: Rate; postWithinReductionThreshold: boolean | null }>;
  unitsOutsideWindows: number;
  digest: string;
}>;

export type FrictionMeasurementResult =
  | Readonly<{ ok: true; measurement: FrictionMeasurement }>
  | Readonly<{ ok: false; code: 'invalid_input' | 'overlapping_windows' | 'inverted_window' | 'duplicate_unit'; paths?: readonly string[] }>;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function inWindow(at: number, window: Readonly<{ from: number; to: number }>): boolean {
  return at >= window.from && at < window.to;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Measure one problem across a baseline window (producers lacking the fix) and
 * a post-deployment window (producers containing it), under
 * `friction_measurement_v1`.
 *
 * Outcome precedence: unmeasurable, then confounded, then insufficient
 * exposure, then recurred or resolution_candidate.
 */
export function measureFriction(rawInput: FrictionMeasurementInput,
  policy: FrictionMeasurementPolicy = FRICTION_MEASUREMENT_V1): FrictionMeasurementResult {
  const parsed = FrictionMeasurementInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: 'invalid_input', paths: parsed.error.issues.map((issue) => issue.path.join('.')) };
  }
  const input = parsed.data;
  const baselineWindow = { from: Date.parse(input.windows.baseline.from), to: Date.parse(input.windows.baseline.to) };
  const postWindow = { from: Date.parse(input.windows.post.from), to: Date.parse(input.windows.post.to) };
  if (baselineWindow.from >= baselineWindow.to || postWindow.from >= postWindow.to) return { ok: false, code: 'inverted_window' };
  if (baselineWindow.to > postWindow.from) return { ok: false, code: 'overlapping_windows' };
  const refs = new Set<string>();
  for (const unit of input.units) {
    if (refs.has(unit.unitRef)) return { ok: false, code: 'duplicate_unit' };
    refs.add(unit.unitRef);
  }

  const tally = () => ({ exposure: 0, occurrences: 0, unattributed: 0, unclassified: 0, mismatch: 0,
    producers: new Set<string>(), configuration: new Map<string, Set<string>>() });
  const windows = { baseline: tally(), post: tally() };
  let outside = 0;
  for (const unit of input.units) {
    const at = Date.parse(unit.observedAt);
    const side = inWindow(at, baselineWindow) ? 'baseline' : inWindow(at, postWindow) ? 'post' : null;
    if (!side) { outside += 1; continue; }
    const window = windows[side];
    if (unit.attribution.status !== 'attributed') { window.unattributed += 1; continue; }
    const producer = measurementProducerKey(unit.attribution.producer);
    const classification = input.producerClassification[producer];
    if (!classification) { window.unclassified += 1; continue; }
    if ((side === 'baseline') !== (classification === 'lacks_fix')) { window.mismatch += 1; continue; }
    window.exposure += 1;
    if (unit.occurred) window.occurrences += 1;
    window.producers.add(producer);
    for (const [dimension, value] of Object.entries(unit.configuration)) {
      const values = window.configuration.get(dimension) ?? new Set<string>();
      values.add(value ?? '∅');
      window.configuration.set(dimension, values);
    }
  }

  const summarize = (window: ReturnType<typeof tally>): WindowMeasurement => ({
    exposure: window.exposure, occurrences: window.occurrences,
    excluded: { unattributed: window.unattributed, unclassified_producer: window.unclassified,
      producer_window_mismatch: window.mismatch },
    producers: sortedUnique(window.producers),
    configuration: Object.fromEntries([...window.configuration.keys()].sort()
      .map((dimension) => [dimension, sortedUnique(window.configuration.get(dimension)!)])),
  });
  const baseline = summarize(windows.baseline);
  const post = summarize(windows.post);

  // Reasons, in fixed groups. The first non-empty group decides the outcome.
  const unmeasurable: string[] = [];
  if (input.readTruncated) unmeasurable.push('read_truncated');
  for (const [side, window] of [['baseline', windows.baseline], ['post', windows.post]] as const) {
    if (window.exposure === 0 && window.unattributed > 0) unmeasurable.push(`${side}_attribution_unavailable`);
  }

  const confounded: string[] = [];
  const dimensions = sortedUnique([...Object.keys(baseline.configuration), ...Object.keys(post.configuration)]);
  for (const dimension of dimensions) {
    if (input.fixDimensions.includes(dimension)) continue;
    const before = baseline.configuration[dimension] ?? [];
    const after = post.configuration[dimension] ?? [];
    if (baseline.exposure > 0 && post.exposure > 0 && canonicalJson(before) !== canonicalJson(after)) {
      confounded.push(`configuration_changed:${dimension}`);
    }
  }

  const insufficient: string[] = [];
  if (baseline.exposure < policy.minimumBaselineExposure) insufficient.push('baseline_exposure_below_minimum');
  if (post.exposure < policy.minimumPostExposure) insufficient.push('post_exposure_below_minimum');
  if (baseline.occurrences < policy.minimumBaselineOccurrences) insufficient.push('baseline_occurrences_below_minimum');

  // post/postExp <= (num/den) * base/baseExp, in integers.
  const { numerator, denominator } = policy.maximumPostToBaselineRate;
  const comparable = baseline.exposure > 0 && post.exposure > 0;
  const withinThreshold = comparable
    ? post.occurrences * baseline.exposure * denominator <= numerator * baseline.occurrences * post.exposure
    : null;

  let outcome: FrictionMeasurementOutcome;
  let reasons: string[];
  if (unmeasurable.length > 0) { outcome = 'unmeasurable'; reasons = unmeasurable; }
  else if (confounded.length > 0) { outcome = 'confounded'; reasons = confounded; }
  else if (insufficient.length > 0) { outcome = 'insufficient_exposure'; reasons = insufficient; }
  else if (withinThreshold) { outcome = 'resolution_candidate'; reasons = ['post_rate_within_reduction_threshold']; }
  else { outcome = 'recurred'; reasons = ['post_rate_above_reduction_threshold']; }

  const envelope = {
    policyVersion: policy.version,
    problemKey: improvementProblemKey(input.problem),
    outcome, reasons, baseline, post,
    rateComparison: { baseline: { occurrences: baseline.occurrences, exposure: baseline.exposure },
      post: { occurrences: post.occurrences, exposure: post.exposure }, postWithinReductionThreshold: withinThreshold },
    unitsOutsideWindows: outside,
  };
  return { ok: true, measurement: Object.freeze({ ...envelope, digest: hashCanonical({
    ...envelope, windows: input.windows, producerClassification: input.producerClassification,
    fixDimensions: [...input.fixDimensions].sort(), readTruncated: input.readTruncated }) }) };
}
