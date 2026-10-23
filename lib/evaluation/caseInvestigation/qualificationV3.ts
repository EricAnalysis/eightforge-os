/**
 * Case Investigation qualification contract v3 (docs/runbooks/case-investigation-qualification-v3.md).
 *
 * v3 changes only what the owner decided on 2026-10-22, after v2 FAILED (final for v2):
 * - Latency, raised deliberately for an operator-invoked investigation that never blocks the
 *   operator (the deterministic investigation is already shown): median <= 15 s, p95 <= 25 s,
 *   with the provider timeout raised to 30 s in the client. Invalid answers, timeouts
 *   included, stay at most 5%.
 * - Top-1, a contract correction: v2's max(baseline + 0.10, 0.70) cannot be met when the
 *   deterministic baseline is 1.00. v3 requires top-1 >= 0.90 and >= the baseline
 *   (margin 0), with no bonus, clipping or special case.
 * Every other bar, the classes, minimums, run rules and the scorecard's interpretations are v2's.
 *
 * Corpus and labels carry over: the same 111 cases (each frozen v2 context with only its
 * relationships provenance re-derived), and the frozen v2 label set verbatim, including
 * Eric Martin's 22 adjudications.
 */

import { hashCanonical } from '@/lib/extraction/domain/hash';

import type { CorpusManifestEntry } from './corpusV2';
import { FINAL_ADJUDICATOR, type FrozenCaseLabel, type FrozenLabelSet, verifyFrozenLabelSet } from './labelsV2';
import { CASE_INVESTIGATION_BARS_V2, type CaseInvestigationScoring } from './qualificationV2';

export const CASE_INVESTIGATION_CONTRACT_V3 = 'case_investigation_qualification_v3';
export const CASE_INVESTIGATION_LABEL_SET_VERSION_V3 = 'case_investigation_labels_v3';
/** The v2 label set v3 carries over, frozen 2026-10-22. */
export const CARRIED_V2_LABEL_SET_DIGEST = '7a139119e16be2cd3dac83a9994188bbde8c862fd1d6579885523844d494063f';

export const CASE_INVESTIGATION_SCORING_V3: CaseInvestigationScoring = Object.freeze({
  scorer: 'case_investigation_scorecard_v3',
  bars: Object.freeze({
    hard: Object.freeze({ ...CASE_INVESTIGATION_BARS_V2.hard, maxMedianLatencyMs: 15_000, maxP95LatencyMs: 25_000 }),
    soft: Object.freeze({ ...CASE_INVESTIGATION_BARS_V2.soft, top1MarginOverBaseline: 0, minTop1: 0.90 }),
    run: CASE_INVESTIGATION_BARS_V2.run,
  }),
});

export type CarriedLabelSetV3 = Readonly<{
  version: typeof CASE_INVESTIGATION_LABEL_SET_VERSION_V3;
  contract: typeof CASE_INVESTIGATION_CONTRACT_V3;
  finalAdjudicator: typeof FINAL_ADJUDICATOR;
  carriedFrom: Readonly<{ contract: string; labelSetDigest: string }>;
  labels: readonly FrozenCaseLabel[];
  labelSetDigest: string;
}>;

/** The v2 labels, verbatim, under the v3 identity. Refuses any other set or a changed case set. */
export function carryLabelSetToV3(v2: FrozenLabelSet, manifestEntriesV3: readonly CorpusManifestEntry[]): CarriedLabelSetV3 {
  if (v2.labelSetDigest !== CARRIED_V2_LABEL_SET_DIGEST) throw new Error(`V3_CARRY_UNEXPECTED_V2_LABELS: ${v2.labelSetDigest}`);
  verifyFrozenLabelSet(v2, manifestEntriesV3);
  const body = {
    version: CASE_INVESTIGATION_LABEL_SET_VERSION_V3,
    contract: CASE_INVESTIGATION_CONTRACT_V3,
    finalAdjudicator: FINAL_ADJUDICATOR,
    carriedFrom: { contract: v2.contract, labelSetDigest: v2.labelSetDigest },
    labels: v2.labels,
  } as const;
  return { ...body, labelSetDigest: hashCanonical(body) };
}

export function verifyLabelSetV3(set: CarriedLabelSetV3, manifestEntriesV3: readonly CorpusManifestEntry[]): void {
  const { labelSetDigest: recorded, ...body } = set;
  if (hashCanonical(body) !== recorded) throw new Error('V3_LABEL_SET_DIGEST_MISMATCH');
  if (set.contract !== CASE_INVESTIGATION_CONTRACT_V3 || set.carriedFrom.labelSetDigest !== CARRIED_V2_LABEL_SET_DIGEST) {
    throw new Error('V3_LABEL_SET_IDENTITY_MISMATCH');
  }
  const eligible = manifestEntriesV3.filter((entry) => entry.excluded == null).map((entry) => entry.caseId).sort();
  const labelled = set.labels.map((label) => label.caseId).sort();
  if (hashCanonical(eligible) !== hashCanonical(labelled)) throw new Error('V3_LABEL_SET_DOES_NOT_COVER_CORPUS');
}
