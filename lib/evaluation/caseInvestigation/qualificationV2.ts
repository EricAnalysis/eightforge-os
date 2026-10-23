/**
 * Case Investigation qualification contract v2: run plan, answer audit and
 * scorecard. The bars are v1's, unchanged (docs/runbooks/case-investigation-qualification.md);
 * v2 changed only the corpus.
 *
 * Interpretations fixed here before any provider call (strictest coherent
 * reading; never revised after outputs are seen):
 * - Raw-answer violations count against their hard bar even though the
 *   production runner then rejects the answer: an invented number, an
 *   unoffered action or an untransmitted evidence reference is a hard-bar
 *   breach AND an invalid answer.
 * - No case ever leaves a denominator. An invalid answer is a wrong top-1, a
 *   root-cause disagreement and faithfulness 0 in the class mean. The
 *   faithfulness-0 hard bar counts graded valid answers, so the separate
 *   at-most-5% invalid bar is not made meaningless.
 * - The ranking bar is measured over cases offering at least two rankable
 *   actions; single- and zero-action cases are reported, not used for it
 *   (v1: "scores top-1 trivially"). A class with no such case reports the
 *   ranking bar as not applicable.
 * - Cost is per investigation over the class. A call with no usage
 *   (timeout, transport error) is charged its upper bound: the estimated
 *   input plus the full output cap. Unknown is never zero.
 * - Percentiles are nearest-rank, as in the B4.6.1 benchmark.
 */

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { citableRecords, PROVIDER_RANKABLE_ACTION_KINDS, unsupportedNumbers } from '@/lib/server/caseInvestigationRunner';

import { CLASS_MINIMUMS, type QualificationClass } from './corpusV2';
import type { FrozenCaseLabel, RootCause } from './labelsV2';

export const CASE_INVESTIGATION_QUALIFICATION_SCORER_V2 = 'case_investigation_scorecard_v2';

/** v1's bars, verbatim. */
export const CASE_INVESTIGATION_BARS_V2 = Object.freeze({
  hard: Object.freeze({
    unofferedRankedActions: 0,
    inventedNumbers: 0,
    wrongEvidenceReferences: 0,
    conflictSideSelections: 0,
    decisionRecommendations: 0,
    faithfulnessZeroAnswers: 0,
    maxInvalidAnswerShare: 0.05,
    maxMedianLatencyMs: 6_000,
    maxP95LatencyMs: 12_000,
    maxUsdPerInvestigation: 0.03,
  }),
  soft: Object.freeze({
    top1MarginOverBaseline: 0.10,
    minTop1: 0.70,
    minMeanFaithfulness: 1.6,
    minRootCauseAgreement: 0.70,
  }),
  run: Object.freeze({ safetySpendCeilingUsd: 3.00, callCapMultiplier: 1.2 }),
});

/** Published Claude Sonnet 4.6 list prices, USD per million tokens. */
export const CASE_INVESTIGATION_PRICING_V2 = Object.freeze({
  model: 'claude-sonnet-4-6', inputUsdPerMTok: 3, outputUsdPerMTok: 15,
});

/** A contract's scoring: its scorer identity and bars. Later contracts change only what they name. */
type Bars = typeof CASE_INVESTIGATION_BARS_V2;
export type CaseInvestigationBars = Readonly<{ [Group in keyof Bars]: Readonly<Record<keyof Bars[Group], number>> }>;
export type CaseInvestigationScoring = Readonly<{ scorer: string; bars: CaseInvestigationBars }>;

export const CASE_INVESTIGATION_SCORING_V2: CaseInvestigationScoring = Object.freeze({
  scorer: CASE_INVESTIGATION_QUALIFICATION_SCORER_V2, bars: CASE_INVESTIGATION_BARS_V2,
});

export const qualificationBarsDigest = (scoring: CaseInvestigationScoring = CASE_INVESTIGATION_SCORING_V2) => hashCanonical({
  scorer: scoring.scorer, bars: scoring.bars, pricing: CASE_INVESTIGATION_PRICING_V2,
});

export function callCap(cases: number): number {
  return Math.ceil(CASE_INVESTIGATION_BARS_V2.run.callCapMultiplier * cases);
}

export function costUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * CASE_INVESTIGATION_PRICING_V2.inputUsdPerMTok
    + outputTokens * CASE_INVESTIGATION_PRICING_V2.outputUsdPerMTok) / 1_000_000;
}

/** A conservative input-token estimate (one token per 3 characters) for budget bounds only. */
export function estimateInputTokens(requestBody: unknown): number {
  return Math.ceil(JSON.stringify(requestBody).length / 3);
}

export type AnswerViolations = Readonly<{
  schemaInvalid: boolean;
  unofferedRankedAction: boolean;
  duplicateRankedAction: boolean;
  wrongEvidenceReference: boolean;
  inventedNumber: boolean;
}>;

/**
 * Audit a raw provider answer with the runner's own checks, so a rejected
 * answer still says why. The runner remains the authority on acceptance.
 */
export function auditRawAnswer(raw: string, params: Readonly<{
  offeredActionKinds: readonly string[];
  transmitted: readonly Readonly<{ kind: string; provenance: { recordIds: readonly string[] }; payload: unknown }>[];
}>): AnswerViolations {
  const none: AnswerViolations = { schemaInvalid: false, unofferedRankedAction: false, duplicateRankedAction: false,
    wrongEvidenceReference: false, inventedNumber: false };
  let parsed: { diagnosis?: unknown; rankedActionKinds?: unknown; rationale?: unknown; evidenceRefs?: unknown;
    citations?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...none, schemaInvalid: true };
  }
  const ranked = Array.isArray(parsed.rankedActionKinds) ? parsed.rankedActionKinds.map(String) : [];
  const refs = Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs as Array<{ sliceKind?: unknown; recordId?: unknown }> : [];
  const offered = new Set(params.offeredActionKinds);
  const transmittedRecords = new Set(params.transmitted.flatMap((slice) =>
    slice.provenance.recordIds.map((recordId) => `${slice.kind}\u0000${recordId}`)));
  // v3 answers cite by letter ref (citableRecords); v2 answers echoed the slice kind and record id.
  const letterRefs = new Set(citableRecords(params.transmitted).map((record) => record.ref));
  const citations = Array.isArray(parsed.citations) ? parsed.citations.map(String) : null;
  const text = `${typeof parsed.diagnosis === 'string' ? parsed.diagnosis : ''} ${typeof parsed.rationale === 'string' ? parsed.rationale : ''}`;
  return {
    schemaInvalid: typeof parsed.diagnosis !== 'string' || typeof parsed.rationale !== 'string'
      || !Array.isArray(parsed.rankedActionKinds) || (citations == null && !Array.isArray(parsed.evidenceRefs)),
    unofferedRankedAction: ranked.some((kind) => !offered.has(kind)),
    duplicateRankedAction: new Set(ranked).size !== ranked.length,
    wrongEvidenceReference: citations != null
      ? citations.some((ref) => !letterRefs.has(ref)) || new Set(citations).size !== citations.length
      : refs.some((ref) => !transmittedRecords.has(`${String(ref.sliceKind)}\u0000${String(ref.recordId)}`)),
    inventedNumber: unsupportedNumbers(text, params.transmitted).length > 0,
  };
}

/** The deterministic baseline's top-1: its first option a provider could also rank, else `none`. */
export function baselineTop1(options: readonly Readonly<{ rank: number; actionKind: string }>[]): string {
  const ranked = [...options].sort((left, right) => left.rank - right.rank);
  return ranked.find((option) => PROVIDER_RANKABLE_ACTION_KINDS.has(option.actionKind as never))?.actionKind ?? 'none';
}

export type CaseRunRecord = Readonly<{
  caseId: string;
  qualificationClass: QualificationClass;
  rankableActionKinds: readonly string[];
  /** The production runner's status; only `proposed` is a valid answer. */
  status: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Upper-bound input estimate, charged when usage is missing. */
  estimatedInputTokens: number;
  maxOutputTokens: number;
  violations: AnswerViolations | null;
  /** First ranked action of a valid answer, `none` when it ranks nothing; null when invalid. */
  top1: string | null;
  baselineTop1: string;
}>;

/** A post-run grade, scored against the frozen evidence (never truth). */
export type CaseGrade = Readonly<{
  caseId: string;
  faithfulness: 0 | 1 | 2;
  /** The root cause the diagnosis asserts. */
  rootCause: RootCause | 'not_stated';
  conflictSideSelection: boolean;
  decisionRecommendation: boolean;
}>;

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

type Bar = Readonly<{ value: number | null; limit: number; pass: boolean }>;
const atMost = (value: number | null, limit: number): Bar => ({ value, limit, pass: value != null && value <= limit });
const atLeast = (value: number | null, limit: number): Bar => ({ value, limit, pass: value != null && value >= limit });

export type ClassScorecard = Readonly<{
  qualificationClass: QualificationClass;
  cases: number;
  minimumCases: number;
  hard: Readonly<Record<string, Bar>>;
  soft: Readonly<{
    top1: Readonly<{ applicable: boolean; rankingCases: number; top1: number | null; baselineTop1: number | null;
      required: number | null; pass: boolean }>;
    top1SingleOrNoActionCases: Readonly<{ cases: number; top1: number | null }>;
    meanFaithfulness: Bar;
    rootCauseAgreement: Bar;
  }>;
  status: 'qualified' | 'not_qualified';
  reasons: readonly string[];
}>;

export type QualificationScorecard = Readonly<{
  scorer: string;
  barsDigest: string;
  classes: readonly ClassScorecard[];
  result: 'PASS' | 'FAIL';
}>;

export function scoreQualificationV2(input: Readonly<{
  labels: readonly FrozenCaseLabel[];
  records: readonly CaseRunRecord[];
  grades: readonly CaseGrade[];
}>): QualificationScorecard {
  return scoreQualification(input, CASE_INVESTIGATION_SCORING_V2);
}

export function scoreQualification(input: Readonly<{
  labels: readonly FrozenCaseLabel[];
  records: readonly CaseRunRecord[];
  grades: readonly CaseGrade[];
}>, scoring: CaseInvestigationScoring): QualificationScorecard {
  const labels = new Map(input.labels.map((label) => [label.caseId, label]));
  const grades = new Map(input.grades.map((grade) => [grade.caseId, grade]));
  const records = new Map(input.records.map((record) => [record.caseId, record]));
  if (records.size !== input.records.length) throw new Error('SCORE_DUPLICATE_RUN_RECORD');
  for (const caseId of labels.keys()) if (!records.has(caseId)) throw new Error(`SCORE_CASE_NOT_RUN: ${caseId}`);
  for (const caseId of records.keys()) if (!labels.has(caseId)) throw new Error(`SCORE_RECORD_WITHOUT_LABEL: ${caseId}`);
  for (const record of input.records) {
    const valid = record.status === 'proposed';
    if (valid !== grades.has(record.caseId)) throw new Error(`SCORE_GRADE_COVERAGE: ${record.caseId}`);
  }

  const classes = (['validator_failure', 'conflict'] as const).map((qualificationClass): ClassScorecard => {
    const rows = input.records.filter((record) => record.qualificationClass === qualificationClass);
    const n = rows.length;
    const graded = rows.flatMap((record) => grades.has(record.caseId) ? [grades.get(record.caseId)!] : []);
    const count = (predicate: (record: CaseRunRecord) => boolean) => rows.filter(predicate).length;
    const cost = rows.reduce((sum, record) => sum + (record.inputTokens != null && record.outputTokens != null
      ? costUsd(record.inputTokens, record.outputTokens)
      : costUsd(record.estimatedInputTokens, record.maxOutputTokens)), 0);
    const bars = scoring.bars.hard;
    const hard = {
      unofferedRankedActions: atMost(count((record) => record.violations?.unofferedRankedAction === true), bars.unofferedRankedActions),
      inventedNumbers: atMost(count((record) => record.violations?.inventedNumber === true), bars.inventedNumbers),
      wrongEvidenceReferences: atMost(count((record) => record.violations?.wrongEvidenceReference === true), bars.wrongEvidenceReferences),
      conflictSideSelections: atMost(qualificationClass === 'conflict'
        ? graded.filter((grade) => grade.conflictSideSelection).length : 0, bars.conflictSideSelections),
      decisionRecommendations: atMost(graded.filter((grade) => grade.decisionRecommendation).length, bars.decisionRecommendations),
      faithfulnessZeroAnswers: atMost(graded.filter((grade) => grade.faithfulness === 0).length, bars.faithfulnessZeroAnswers),
      invalidAnswerShare: atMost(n === 0 ? null : count((record) => record.status !== 'proposed') / n, bars.maxInvalidAnswerShare),
      medianLatencyMs: atMost(percentile(rows.map((record) => record.latencyMs), 0.5), bars.maxMedianLatencyMs),
      p95LatencyMs: atMost(percentile(rows.map((record) => record.latencyMs), 0.95), bars.maxP95LatencyMs),
      usdPerInvestigation: atMost(n === 0 ? null : cost / n, bars.maxUsdPerInvestigation),
    };

    const soft = scoring.bars.soft;
    const correct = (record: CaseRunRecord) => record.top1 != null && record.top1 === labels.get(record.caseId)!.primaryAction;
    const baselineCorrect = (record: CaseRunRecord) => record.baselineTop1 === labels.get(record.caseId)!.primaryAction;
    const ranking = rows.filter((record) => record.rankableActionKinds.length >= 2);
    const trivial = rows.filter((record) => record.rankableActionKinds.length < 2);
    const share = (subset: readonly CaseRunRecord[], predicate: (record: CaseRunRecord) => boolean) =>
      subset.length === 0 ? null : subset.filter(predicate).length / subset.length;
    const top1 = share(ranking, correct);
    const baseline = share(ranking, baselineCorrect);
    const required = baseline == null ? null : Math.max(baseline + soft.top1MarginOverBaseline, soft.minTop1);
    const meanFaithfulness = n === 0 ? null
      : rows.reduce((sum, record) => sum + (grades.get(record.caseId)?.faithfulness ?? 0), 0) / n;
    const rootCauseAgreement = share(rows, (record) => grades.get(record.caseId)?.rootCause === labels.get(record.caseId)!.rootCause);
    const softBars = {
      top1: { applicable: ranking.length > 0, rankingCases: ranking.length, top1, baselineTop1: baseline, required,
        pass: ranking.length === 0 || (top1 != null && required != null && top1 >= required) },
      top1SingleOrNoActionCases: { cases: trivial.length, top1: share(trivial, correct) },
      meanFaithfulness: atLeast(meanFaithfulness, soft.minMeanFaithfulness),
      rootCauseAgreement: atLeast(rootCauseAgreement, soft.minRootCauseAgreement),
    };
    const reasons = [
      ...(n < CLASS_MINIMUMS[qualificationClass] ? [`below_minimum_cases:${n}<${CLASS_MINIMUMS[qualificationClass]}`] : []),
      ...Object.entries(hard).filter(([, bar]) => !bar.pass).map(([name]) => `hard:${name}`),
      ...(softBars.top1.pass ? [] : ['soft:top1']),
      ...(softBars.meanFaithfulness.pass ? [] : ['soft:meanFaithfulness']),
      ...(softBars.rootCauseAgreement.pass ? [] : ['soft:rootCauseAgreement']),
    ];
    return { qualificationClass, cases: n, minimumCases: CLASS_MINIMUMS[qualificationClass], hard, soft: softBars,
      status: reasons.length === 0 ? 'qualified' : 'not_qualified', reasons };
  });
  return {
    scorer: scoring.scorer,
    barsDigest: qualificationBarsDigest(scoring),
    classes,
    // Activation is all-or-nothing for the workflow.
    result: classes.every((entry) => entry.status === 'qualified') ? 'PASS' : 'FAIL',
  };
}

/** Post-run grades: two independent reviewers; Eric Martin decides every disagreement. */
export function resolveGradesV2(input: Readonly<{
  reviewerA: readonly CaseGrade[];
  reviewerB: readonly CaseGrade[];
  adjudication: Readonly<{ adjudicator: string; decisions: readonly CaseGrade[] }> | null;
  gradedCaseIds: readonly string[];
}>): readonly CaseGrade[] {
  const byCase = (list: readonly CaseGrade[], who: string) => {
    const map = new Map<string, CaseGrade>();
    for (const grade of list) {
      if (map.has(grade.caseId)) throw new Error(`GRADE_DUPLICATE:${who}:${grade.caseId}`);
      map.set(grade.caseId, grade);
    }
    return map;
  };
  const a = byCase(input.reviewerA, 'A');
  const b = byCase(input.reviewerB, 'B');
  if (input.adjudication && input.adjudication.adjudicator !== 'Eric Martin') throw new Error('GRADE_ADJUDICATOR_NOT_FINAL');
  const decided = byCase(input.adjudication?.decisions ?? [], 'adjudicator');
  return input.gradedCaseIds.map((caseId) => {
    const left = a.get(caseId);
    const right = b.get(caseId);
    if (!left || !right) throw new Error(`GRADE_MISSING_REVIEWER:${caseId}`);
    if (hashCanonical(left) === hashCanonical(right)) return left;
    const decision = decided.get(caseId);
    if (!decision) throw new Error(`GRADE_DISAGREEMENT_UNADJUDICATED:${caseId}`);
    return decision;
  });
}
