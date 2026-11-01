/**
 * Case Investigation qualification contract v4 (docs/runbooks/case-investigation-qualification-v4.md).
 *
 * The same frozen capability on a stronger model, after v3 FAILED on `claude-sonnet-4-6` (final
 * for v3). v4 changes only what the model requires:
 * - the model id, and its published list price in the cost bar's arithmetic;
 * - request compatibility: `temperature` omitted, `thinking: between_tools` (caseInvestigationClient.ts).
 * Every bar, the classes, the prompt, the schema, the output cap, the timeout, zero retries, the
 * run rules, the scorer's interpretations, the 111 cases and their labels are v3's, unchanged.
 *
 * This qualifies nothing by inference: no Sonnet 5.5 result from another capability counts here.
 */

import { hashCanonical } from '@/lib/extraction/domain/hash';

import type { CorpusManifestEntry } from './corpusV2';
import { FINAL_ADJUDICATOR, type FrozenCaseLabel } from './labelsV2';
import { type CaseGrade, type CaseInvestigationPricing, type CaseInvestigationScoring, type CaseRunRecord,
  type QualificationScorecard, scoreQualification } from './qualificationV2';
import { CASE_INVESTIGATION_SCORING_V3, type CarriedLabelSetV3 } from './qualificationV3';

export const CASE_INVESTIGATION_CONTRACT_V4 = 'case_investigation_qualification_v4';
export const CASE_INVESTIGATION_LABEL_SET_VERSION_V4 = 'case_investigation_labels_v4';
export const CASE_INVESTIGATION_MODEL_V4 = 'claude-sonnet-5-5';
/** The v3 label set v4 carries over, itself v2's labels verbatim. */
export const CARRIED_V3_LABEL_SET_DIGEST = '80d4c874fc570b8ee79fc90e9d83ea4a3d2326065e06c3f60702541f85ade605';
/** The committed v3 corpus manifest v4 derives from, and the frozen scoring identities it must leave alone. */
export const CARRIED_V3_MANIFEST_SHA256 = '017ee6339992ae42b8c39f4d9a2f9c788e005e10b2c645114c5e681bf8f64672';
export const FROZEN_BARS_DIGEST_V2 = 'e47875886300dce952827286c0584e10cfd6c70a16d8ff52d031723f54a9ccfd';
export const FROZEN_BARS_DIGEST_V3 = 'f288175020a6a9606d4c56284b9e1f9d7cb8ade599e669586aeaaff6b6324ce9';
/** The only pinned source v4 changes: request compatibility in the adapter. */
export const V4_CHANGED_PINNED_SOURCE = 'lib/forgewing/runtime/caseInvestigationClient.ts';

/** Published Claude Sonnet 5.5 list prices, USD per million tokens. */
export const CASE_INVESTIGATION_PRICING_V4: CaseInvestigationPricing = Object.freeze({
  model: CASE_INVESTIGATION_MODEL_V4, inputUsdPerMTok: 2, outputUsdPerMTok: 10,
});

export const CASE_INVESTIGATION_SCORING_V4: CaseInvestigationScoring = Object.freeze({
  scorer: 'case_investigation_scorecard_v4',
  bars: CASE_INVESTIGATION_SCORING_V3.bars,
  pricing: CASE_INVESTIGATION_PRICING_V4,
});

export type CarriedLabelSetV4 = Readonly<{
  version: typeof CASE_INVESTIGATION_LABEL_SET_VERSION_V4;
  contract: typeof CASE_INVESTIGATION_CONTRACT_V4;
  finalAdjudicator: typeof FINAL_ADJUDICATOR;
  carriedFrom: Readonly<{ contract: string; labelSetDigest: string }>;
  labels: readonly FrozenCaseLabel[];
  labelSetDigest: string;
}>;

function assertCoversCorpus(labels: readonly FrozenCaseLabel[], entries: readonly CorpusManifestEntry[]): void {
  const eligible = entries.filter((entry) => entry.excluded == null).map((entry) => entry.caseId).sort();
  const labelled = labels.map((label) => label.caseId).sort();
  if (hashCanonical(eligible) !== hashCanonical(labelled)) throw new Error('V4_LABEL_SET_DOES_NOT_COVER_CORPUS');
}

/** The v3 labels, verbatim, under the v4 identity. Refuses any other set or a changed case set. */
export function carryLabelSetToV4(v3: CarriedLabelSetV3, manifestEntriesV4: readonly CorpusManifestEntry[]): CarriedLabelSetV4 {
  if (v3.labelSetDigest !== CARRIED_V3_LABEL_SET_DIGEST) throw new Error(`V4_CARRY_UNEXPECTED_V3_LABELS: ${v3.labelSetDigest}`);
  const { labelSetDigest: _recorded, ...v3Body } = v3;
  if (hashCanonical(v3Body) !== CARRIED_V3_LABEL_SET_DIGEST) throw new Error('V4_CARRY_V3_LABELS_ALTERED');
  assertCoversCorpus(v3.labels, manifestEntriesV4);
  const body = {
    version: CASE_INVESTIGATION_LABEL_SET_VERSION_V4,
    contract: CASE_INVESTIGATION_CONTRACT_V4,
    finalAdjudicator: FINAL_ADJUDICATOR,
    carriedFrom: { contract: v3.contract, labelSetDigest: v3.labelSetDigest },
    labels: v3.labels,
  } as const;
  return { ...body, labelSetDigest: hashCanonical(body) };
}

export function verifyLabelSetV4(set: CarriedLabelSetV4, manifestEntriesV4: readonly CorpusManifestEntry[]): void {
  const { labelSetDigest: recorded, ...body } = set;
  if (hashCanonical(body) !== recorded) throw new Error('V4_LABEL_SET_DIGEST_MISMATCH');
  if (set.contract !== CASE_INVESTIGATION_CONTRACT_V4 || set.carriedFrom.labelSetDigest !== CARRIED_V3_LABEL_SET_DIGEST) {
    throw new Error('V4_LABEL_SET_IDENTITY_MISMATCH');
  }
  assertCoversCorpus(set.labels, manifestEntriesV4);
}

/** Label-only field names and sources. None may appear in a request; the build path never reads a label. */
const LABEL_ONLY_MARKERS = ['primaryAction', 'rootCause', 'labelSetDigest', 'finalAdjudicator', 'reviewer_agreement_',
  'owner_adjudication', 'Eric Martin'] as const;

export function labelMarkersIn(serializedRequestBody: string): readonly string[] {
  return LABEL_ONLY_MARKERS.filter((marker) => serializedRequestBody.includes(marker));
}

/**
 * The bars no grade can rescue: the frozen scorer, given the best grade every valid answer could
 * receive. Any reason here fails the real scorecard too, whatever the graders later decide. An
 * empty result does not pass anything: the graded bars still need their two independent reviews.
 */
export function gradeIndependentScore(input: Readonly<{ labels: readonly FrozenCaseLabel[];
  records: readonly CaseRunRecord[] }>, scoring: CaseInvestigationScoring = CASE_INVESTIGATION_SCORING_V4): QualificationScorecard {
  const labels = new Map(input.labels.map((label) => [label.caseId, label]));
  const grades: CaseGrade[] = input.records.filter((record) => record.status === 'proposed').map((record) => ({
    caseId: record.caseId, faithfulness: 2, rootCause: labels.get(record.caseId)!.rootCause,
    conflictSideSelection: false, decisionRecommendation: false,
  }));
  return scoreQualification({ labels: input.labels, records: input.records, grades }, scoring);
}
