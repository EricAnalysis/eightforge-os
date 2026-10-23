import { describe, expect, it } from 'vitest';

import type { FrozenCaseLabel } from './labelsV2';
import { type CaseGrade, type CaseRunRecord, qualificationBarsDigest, scoreQualification, scoreQualificationV2 } from './qualificationV2';
import { CASE_INVESTIGATION_SCORING_V3 } from './qualificationV3';

const clean = { schemaInvalid: false, unofferedRankedAction: false, duplicateRankedAction: false,
  wrongEvidenceReference: false, inventedNumber: false };

function cohort(qualificationClass: 'validator_failure' | 'conflict', n: number, overrides: Partial<CaseRunRecord> = {}) {
  const labels: FrozenCaseLabel[] = [];
  const records: CaseRunRecord[] = [];
  const grades: CaseGrade[] = [];
  for (let index = 0; index < n; index += 1) {
    const caseId = `${qualificationClass}-${index}`;
    labels.push({ caseId, qualificationClass, primaryAction: 'open_document', rootCause: 'source_missing',
      source: 'reviewer_agreement_phase1' });
    records.push({ caseId, qualificationClass, rankableActionKinds: ['open_document', 'open_linked_documents'],
      status: 'proposed', latencyMs: 13_000, inputTokens: 1_800, outputTokens: 480, estimatedInputTokens: 3_000,
      maxOutputTokens: 1_500, violations: clean, top1: 'open_document', baselineTop1: 'open_document', ...overrides });
    grades.push({ caseId, faithfulness: 2, rootCause: 'source_missing', conflictSideSelection: false,
      decisionRecommendation: false });
  }
  return { labels, records, grades };
}
const both = (overrides: Partial<CaseRunRecord> = {}) => {
  const vf = cohort('validator_failure', 40, overrides);
  const conflict = cohort('conflict', 20, overrides);
  return { labels: [...vf.labels, ...conflict.labels], records: [...vf.records, ...conflict.records],
    grades: [...vf.grades, ...conflict.grades] };
};

describe('Case Investigation v3 scoring', () => {
  it('changes only the latency and top-1 terms; v2 keeps its own identity', () => {
    const v2 = scoreQualificationV2(both());
    expect(v2.barsDigest).toBe('e47875886300dce952827286c0584e10cfd6c70a16d8ff52d031723f54a9ccfd');
    expect(v2.result).toBe('FAIL');
    expect(v2.classes[0]!.reasons).toEqual(['hard:medianLatencyMs', 'hard:p95LatencyMs', 'soft:top1']);
    const v3 = scoreQualification(both(), CASE_INVESTIGATION_SCORING_V3);
    expect(v3.result).toBe('PASS');
    expect(v3.barsDigest).toBe(qualificationBarsDigest(CASE_INVESTIGATION_SCORING_V3));
    expect(v3.scorer).toBe('case_investigation_scorecard_v3');
  });

  it('requires top-1 at least 0.90 and at least the baseline, with no margin', () => {
    const card = scoreQualification(both(), CASE_INVESTIGATION_SCORING_V3);
    expect(card.classes[0]!.soft.top1).toMatchObject({ baselineTop1: 1, required: 1, top1: 1, pass: true });
    const worse = both();
    worse.records[0] = { ...worse.records[0]!, top1: 'open_linked_documents' };
    expect(scoreQualification(worse, CASE_INVESTIGATION_SCORING_V3).classes[0]!.reasons).toEqual(['soft:top1']);
    const weakBaseline = both({ baselineTop1: 'open_linked_documents' });
    for (const record of weakBaseline.records.slice(0, 5)) Object.assign(record, { top1: 'open_linked_documents' });
    // Baseline 0: the 0.90 floor binds, and 35/40 = 0.875 misses it.
    expect(scoreQualification(weakBaseline, CASE_INVESTIGATION_SCORING_V3).classes[0]!.soft.top1)
      .toMatchObject({ required: 0.9, pass: false });
  });

  it('holds latency to median 15 s and p95 25 s, and keeps invalid answers at most 5%', () => {
    expect(scoreQualification(both({ latencyMs: 15_001 }), CASE_INVESTIGATION_SCORING_V3).classes[0]!.reasons)
      .toContain('hard:medianLatencyMs');
    const slowTail = both();
    for (const record of slowTail.records.slice(0, 3)) Object.assign(record, { latencyMs: 25_001 });
    expect(scoreQualification(slowTail, CASE_INVESTIGATION_SCORING_V3).classes[0]!.reasons).toContain('hard:p95LatencyMs');
    const timeouts = both();
    for (const record of timeouts.records.slice(0, 3)) Object.assign(record, { status: 'provider_failed', top1: null, violations: null });
    timeouts.grades.splice(0, 3);
    expect(scoreQualification(timeouts, CASE_INVESTIGATION_SCORING_V3).classes[0]!.reasons).toContain('hard:invalidAnswerShare');
  });
});
