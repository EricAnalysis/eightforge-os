import { describe, expect, it } from 'vitest';

import type { FrozenCaseLabel } from './labelsV2';
import {
  auditRawAnswer, baselineTop1, callCap, type CaseGrade, type CaseRunRecord, resolveGradesV2, scoreQualificationV2,
} from './qualificationV2';

const clean = { schemaInvalid: false, unofferedRankedAction: false, duplicateRankedAction: false,
  wrongEvidenceReference: false, inventedNumber: false };

function cohort(qualificationClass: 'validator_failure' | 'conflict', n: number, rankable: string[]) {
  const labels: FrozenCaseLabel[] = [];
  const records: CaseRunRecord[] = [];
  const grades: CaseGrade[] = [];
  for (let index = 0; index < n; index += 1) {
    const caseId = `${qualificationClass}-${index}`;
    labels.push({ caseId, qualificationClass, primaryAction: 'open_document', rootCause: 'source_missing',
      source: 'reviewer_agreement_phase1' });
    records.push({ caseId, qualificationClass, rankableActionKinds: rankable, status: 'proposed', latencyMs: 2_000,
      inputTokens: 2_000, outputTokens: 300, estimatedInputTokens: 3_000, maxOutputTokens: 1_500, violations: clean,
      top1: 'open_document', baselineTop1: 'open_linked_documents' });
    grades.push({ caseId, faithfulness: 2, rootCause: 'source_missing', conflictSideSelection: false,
      decisionRecommendation: false });
  }
  return { labels, records, grades };
}

function both(mutate?: (data: ReturnType<typeof cohort>) => void) {
  const vf = cohort('validator_failure', 40, ['open_document', 'open_linked_documents']);
  const conflict = cohort('conflict', 20, ['open_document', 'open_linked_documents']);
  mutate?.(vf);
  return { labels: [...vf.labels, ...conflict.labels], records: [...vf.records, ...conflict.records],
    grades: [...vf.grades, ...conflict.grades] };
}

describe('scoreQualificationV2', () => {
  it('passes only when every bar holds in both classes', () => {
    const card = scoreQualificationV2(both());
    expect(card.result).toBe('PASS');
    expect(card.classes.map((entry) => entry.status)).toEqual(['qualified', 'qualified']);
  });

  it('counts an invented number in a rejected answer as a hard-bar breach', () => {
    const card = scoreQualificationV2(both((vf) => {
      vf.records[0] = { ...vf.records[0]!, status: 'output_invalid', top1: null,
        violations: { ...clean, inventedNumber: true } };
      vf.grades.shift();
    }));
    expect(card.result).toBe('FAIL');
    expect(card.classes[0]!.reasons).toContain('hard:inventedNumbers');
  });

  it('never drops an invalid answer from a denominator', () => {
    const card = scoreQualificationV2(both((vf) => {
      for (const index of [0, 1, 2]) {
        vf.records[index] = { ...vf.records[index]!, status: 'provider_failed', top1: null, violations: null,
          inputTokens: null, outputTokens: null };
      }
      vf.grades.splice(0, 3);
    }));
    const vf = card.classes[0]!;
    expect(vf.hard.invalidAnswerShare!.value).toBeCloseTo(3 / 40);
    expect(vf.reasons).toContain('hard:invalidAnswerShare');
    expect(vf.soft.top1.top1).toBeCloseTo(37 / 40);
    expect(vf.soft.meanFaithfulness.value).toBeCloseTo((37 * 2) / 40);
  });

  it('charges the upper bound when a call reports no usage', () => {
    const card = scoreQualificationV2(both((vf) => {
      vf.records[0] = { ...vf.records[0]!, inputTokens: null, outputTokens: null, estimatedInputTokens: 2_000_000 };
    }));
    expect(card.classes[0]!.reasons).toContain('hard:usdPerInvestigation');
  });

  it('requires top-1 at least baseline plus 10 points and at least 0.70', () => {
    const card = scoreQualificationV2(both((vf) => {
      for (const record of vf.records) Object.assign(record, { baselineTop1: 'open_document' });
    }));
    expect(card.classes[0]!.soft.top1.required).toBeCloseTo(1.1);
    expect(card.classes[0]!.reasons).toContain('soft:top1');
  });

  it('reports single-action cases without using them for the ranking bar', () => {
    const vf = cohort('validator_failure', 40, ['open_document']);
    const conflict = cohort('conflict', 20, ['open_document', 'open_linked_documents']);
    const card = scoreQualificationV2({ labels: [...vf.labels, ...conflict.labels],
      records: [...vf.records, ...conflict.records], grades: [...vf.grades, ...conflict.grades] });
    expect(card.classes[0]!.soft.top1).toMatchObject({ applicable: false, rankingCases: 0, pass: true });
    expect(card.classes[0]!.soft.top1SingleOrNoActionCases).toEqual({ cases: 40, top1: 1 });
  });

  it('fails a class below its minimum and a side-selection in a conflict case', () => {
    const vf = cohort('validator_failure', 39, ['open_document', 'open_linked_documents']);
    const conflict = cohort('conflict', 20, ['open_document', 'open_linked_documents']);
    conflict.grades[0] = { ...conflict.grades[0]!, conflictSideSelection: true };
    const card = scoreQualificationV2({ labels: [...vf.labels, ...conflict.labels],
      records: [...vf.records, ...conflict.records], grades: [...vf.grades, ...conflict.grades] });
    expect(card.classes[0]!.reasons).toContain('below_minimum_cases:39<40');
    expect(card.classes[1]!.reasons).toContain('hard:conflictSideSelections');
  });

  it('refuses a scorecard with an unrun or ungraded case', () => {
    const data = both();
    expect(() => scoreQualificationV2({ ...data, records: data.records.slice(1) })).toThrow(/SCORE_CASE_NOT_RUN/);
    expect(() => scoreQualificationV2({ ...data, grades: data.grades.slice(1) })).toThrow(/SCORE_GRADE_COVERAGE/);
  });
});

describe('auditRawAnswer', () => {
  const transmitted = [{ kind: 'case_evidence', provenance: { recordIds: ['r1'] }, payload: { amount: '1,250.00' } }];
  it('names why the runner would reject an answer', () => {
    const answer = (fields: Record<string, unknown>) => JSON.stringify({ diagnosis: 'd', rationale: 'r', rankedActionKinds: [],
      evidenceRefs: [{ sliceKind: 'case_evidence', recordId: 'r1' }], ...fields });
    expect(auditRawAnswer(answer({ diagnosis: 'The amount is 1250' }), { offeredActionKinds: [], transmitted })).toEqual(clean);
    expect(auditRawAnswer(answer({ diagnosis: 'It should be 900' }), { offeredActionKinds: [], transmitted }).inventedNumber).toBe(true);
    expect(auditRawAnswer(answer({ rankedActionKinds: ['resolve_execution_item'] }), { offeredActionKinds: ['open_document'],
      transmitted }).unofferedRankedAction).toBe(true);
    expect(auditRawAnswer(answer({ evidenceRefs: [{ sliceKind: 'case_evidence', recordId: 'r2' }] }),
      { offeredActionKinds: [], transmitted }).wrongEvidenceReference).toBe(true);
    expect(auditRawAnswer('not json', { offeredActionKinds: [], transmitted }).schemaInvalid).toBe(true);
    // v3 answers cite by letter ref.
    const v3 = (citations: string[]) => auditRawAnswer(JSON.stringify({ diagnosis: 'd', rationale: 'r', rankedActionKinds: [], citations }),
      { offeredActionKinds: [], transmitted });
    expect(v3(['A'])).toEqual(clean);
    expect(v3(['B']).wrongEvidenceReference).toBe(true);
    expect(v3(['A', 'A']).wrongEvidenceReference).toBe(true);
  });
});

describe('plan helpers', () => {
  it('takes the first rankable baseline option and caps calls at 1.2x', () => {
    expect(baselineTop1([{ rank: 2, actionKind: 'open_document' }, { rank: 1, actionKind: 'resolve_execution_item' }]))
      .toBe('open_document');
    expect(baselineTop1([])).toBe('none');
    expect(callCap(111)).toBe(134);
  });

  it('accepts agreeing grades and requires Eric Martin for every disagreement', () => {
    const grade: CaseGrade = { caseId: 'c', faithfulness: 2, rootCause: 'other', conflictSideSelection: false,
      decisionRecommendation: false };
    expect(resolveGradesV2({ reviewerA: [grade], reviewerB: [grade], adjudication: null, gradedCaseIds: ['c'] })).toEqual([grade]);
    expect(() => resolveGradesV2({ reviewerA: [grade], reviewerB: [{ ...grade, faithfulness: 1 }], adjudication: null,
      gradedCaseIds: ['c'] })).toThrow(/GRADE_DISAGREEMENT_UNADJUDICATED/);
  });
});
