import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FORGEWING_QUALIFIED_MODELS } from '@/lib/forgewing/runtime/modelConfig';
import { forgewingWorkflowActivation, FORGEWING_WORKFLOW_POLICIES } from '@/lib/server/forgewingGates';

import type { CorpusManifestEntry } from './corpusV2';
import type { FrozenCaseLabel } from './labelsV2';
import { CASE_INVESTIGATION_SCORING_V2, type CaseGrade, type CaseRunRecord, costUsd, qualificationBarsDigest, scoreQualification } from './qualificationV2';
import { CASE_INVESTIGATION_SCORING_V3, type CarriedLabelSetV3 } from './qualificationV3';
import {
  CARRIED_V3_LABEL_SET_DIGEST, CASE_INVESTIGATION_CONTRACT_V4, CASE_INVESTIGATION_PRICING_V4, CASE_INVESTIGATION_SCORING_V4,
  carryLabelSetToV4, FROZEN_BARS_DIGEST_V2, FROZEN_BARS_DIGEST_V3, gradeIndependentScore, labelMarkersIn, verifyLabelSetV4,
} from './qualificationV4';

const clean = { schemaInvalid: false, unofferedRankedAction: false, duplicateRankedAction: false,
  wrongEvidenceReference: false, inventedNumber: false };

function fixture(overrides: Partial<CaseRunRecord> = {}) {
  const labels: FrozenCaseLabel[] = [];
  const records: CaseRunRecord[] = [];
  const grades: CaseGrade[] = [];
  for (const [qualificationClass, n] of [['validator_failure', 40], ['conflict', 20]] as const) {
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
  }
  return { labels, records, grades };
}

describe('Case Investigation v4 scoring identity', () => {
  it('leaves the v2 and v3 scoring identities exactly as they were frozen', () => {
    expect(qualificationBarsDigest(CASE_INVESTIGATION_SCORING_V2)).toBe(FROZEN_BARS_DIGEST_V2);
    expect(qualificationBarsDigest(CASE_INVESTIGATION_SCORING_V3)).toBe(FROZEN_BARS_DIGEST_V3);
    expect(qualificationBarsDigest(CASE_INVESTIGATION_SCORING_V4)).not.toBe(FROZEN_BARS_DIGEST_V3);
  });

  it('uses v3 bars unchanged; only the scorer name and the model price differ', () => {
    expect(CASE_INVESTIGATION_SCORING_V4.bars).toBe(CASE_INVESTIGATION_SCORING_V3.bars);
    expect(CASE_INVESTIGATION_SCORING_V4.bars.hard).toMatchObject({ inventedNumbers: 0, maxInvalidAnswerShare: 0.05,
      maxMedianLatencyMs: 15_000, maxP95LatencyMs: 25_000, maxUsdPerInvestigation: 0.03 });
    expect(CASE_INVESTIGATION_SCORING_V4.bars.soft).toMatchObject({ top1MarginOverBaseline: 0, minTop1: 0.9,
      minMeanFaithfulness: 1.6, minRootCauseAgreement: 0.7 });
    expect(CASE_INVESTIGATION_SCORING_V4.bars.run).toMatchObject({ safetySpendCeilingUsd: 3, callCapMultiplier: 1.2 });
    expect(CASE_INVESTIGATION_PRICING_V4).toEqual({ model: 'claude-sonnet-5-5', inputUsdPerMTok: 2, outputUsdPerMTok: 10 });
  });

  it('scores identically to v3 except the cost arithmetic', () => {
    for (const records of [fixture(), fixture({ latencyMs: 15_001 }), fixture({ violations: { ...clean, inventedNumber: true } })]) {
      const v3 = scoreQualification(records, CASE_INVESTIGATION_SCORING_V3);
      const v4 = scoreQualification(records, CASE_INVESTIGATION_SCORING_V4);
      expect(v4.result).toBe(v3.result);
      expect(v4.classes.map((entry) => entry.reasons)).toEqual(v3.classes.map((entry) => entry.reasons));
      expect(v4.classes[0]!.soft).toEqual(v3.classes[0]!.soft);
    }
    const card = scoreQualification(fixture(), CASE_INVESTIGATION_SCORING_V4);
    expect(card.classes[0]!.hard.usdPerInvestigation!.value).toBeCloseTo(costUsd(1_800, 480, CASE_INVESTIGATION_PRICING_V4), 10);
    // Unknown usage is still charged its upper bound.
    const noUsage = fixture({ status: 'provider_failed', inputTokens: null, outputTokens: null, violations: null, top1: null });
    noUsage.grades.length = 0;
    expect(scoreQualification(noUsage, CASE_INVESTIGATION_SCORING_V4).classes[0]!.hard.usdPerInvestigation!.value)
      .toBeCloseTo(costUsd(3_000, 1_500, CASE_INVESTIGATION_PRICING_V4), 10);
  });
});

describe('gradeIndependentScore', () => {
  it('reports what no grade can rescue, and nothing it cannot prove', () => {
    const { labels, records } = fixture();
    expect(gradeIndependentScore({ labels, records }).classes.flatMap((entry) => entry.reasons)).toEqual([]);
    const broken = records.map((record, index) => index < 3
      ? { ...record, status: 'output_invalid', top1: null, violations: { ...clean, inventedNumber: true } } : record);
    const card = gradeIndependentScore({ labels, records: broken });
    expect(card.result).toBe('FAIL');
    expect(card.classes[0]!.reasons).toEqual(expect.arrayContaining(['hard:inventedNumbers', 'hard:invalidAnswerShare']));
  });
});

describe('v4 label carry', () => {
  const labels: FrozenCaseLabel[] = [
    { caseId: 'a', qualificationClass: 'conflict', primaryAction: 'open_document', rootCause: 'source_missing', source: 'owner_adjudication' },
  ];
  const entries = [{ caseId: 'a', excluded: null }, { caseId: 'b', excluded: 'out' }] as unknown as CorpusManifestEntry[];

  it('refuses any label set other than the frozen v3 digest', () => {
    const other = { labels, labelSetDigest: 'other' } as unknown as CarriedLabelSetV3;
    expect(() => carryLabelSetToV4(other, entries)).toThrow('V4_CARRY_UNEXPECTED_V3_LABELS');
    const altered = { labels, labelSetDigest: CARRIED_V3_LABEL_SET_DIGEST } as unknown as CarriedLabelSetV3;
    expect(() => carryLabelSetToV4(altered, entries)).toThrow('V4_CARRY_V3_LABELS_ALTERED');
  });

  it('carries the committed v3 labels verbatim under the v4 identity', () => {
    const v3 = JSON.parse(readFileSync('scripts/evaluation/artifacts/case-investigation-v3/labels.json', 'utf8')) as CarriedLabelSetV3;
    const corpus = v3.labels.map((label) => ({ caseId: label.caseId, excluded: null })) as unknown as CorpusManifestEntry[];
    const v4 = carryLabelSetToV4(v3, corpus);
    expect(v4.labels).toEqual(v3.labels);
    expect(v4.labels).toHaveLength(111);
    expect(v4.contract).toBe(CASE_INVESTIGATION_CONTRACT_V4);
    expect(v4.finalAdjudicator).toBe('Eric Martin');
    expect(v4.carriedFrom).toEqual({ contract: v3.contract, labelSetDigest: CARRIED_V3_LABEL_SET_DIGEST });
    expect(() => verifyLabelSetV4(v4, corpus)).not.toThrow();
    expect(() => verifyLabelSetV4({ ...v4, labels: v4.labels.slice(1) }, corpus)).toThrow('V4_LABEL_SET_DIGEST_MISMATCH');
  });
});

describe('v4 boundaries before any result', () => {
  it('finds label-only markers in a request body', () => {
    expect(labelMarkersIn(JSON.stringify({ context: 'plain evidence' }))).toEqual([]);
    expect(labelMarkersIn(JSON.stringify({ rootCause: 'source_missing' }))).toEqual(['rootCause']);
  });

  it('does not activate or qualify anything', () => {
    expect(FORGEWING_WORKFLOW_POLICIES.case_investigation).toMatchObject({ qualification: 'unqualified', qualificationCeiling: 'disabled' });
    expect(forgewingWorkflowActivation('case_investigation', {
      FORGEWING_SHADOW_ENABLED: '1', FORGEWING_CASE_INVESTIGATION_ENABLED: '1' }).activation).toBe('disabled');
    expect(FORGEWING_QUALIFIED_MODELS).toEqual(['claude-sonnet-4-6']);
  });

  it('the harness reaches no database and no durable record', () => {
    const harness = readFileSync('scripts/evaluation/case-investigation/qualifyV2.ts', 'utf8');
    expect(harness).not.toMatch(/supabase|recordCaseInvestigation|getActorContext/iu);
  });
});
