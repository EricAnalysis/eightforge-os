import { describe, expect, it } from 'vitest';

import type { QualificationTargetBinding } from '@/lib/evaluation/benchmark/qualificationBinding';
import { assertQualificationExclusionsFinalized, partitionQualificationExclusions,
  type QualificationExclusionAnchor } from '@/lib/evaluation/benchmark/qualificationExclusions';
import { decideQualification } from '@/lib/evaluation/benchmark/qualificationScoring';
import { VALUE_READING_ACTIVATION_BAR, type ValueReadingBenchmarkRecord } from '@/lib/evaluation/benchmark/valueReadingBenchmark';

const binding = (index: number, evidenceClass: QualificationTargetBinding['evidenceClass'] = 'ocr_price_sheet'): QualificationTargetBinding => ({
  identity: `case-${index}`, task: 'confirm_scanned_amount', documentLabel: 'Golden', physicalPageNumber: 8,
  evidenceClass, pageKey: 'golden-p8', status: 'bound', reason: null, failure: null,
  labelRowKey: `r-${index}`, target: null,
});
const anchor = (b: QualificationTargetBinding): QualificationExclusionAnchor => ({ identity: b.identity,
  documentId: 'doc', sourceSha256: 'a'.repeat(64), pageDigest: 'b'.repeat(64), physicalPageNumber: 8,
  observationAnchorKey: `obs-${b.identity}`, pageKey: b.pageKey, labelRowKey: b.labelRowKey });
const record = (b: QualificationTargetBinding): ValueReadingBenchmarkRecord => ({
  pageKey: b.pageKey!, rowKey: b.labelRowKey!, evidenceClass: 'ocr_price_sheet', outcome: 'correct',
  fields: { rate: true, unit: true, description: true, category: null }, rateError: null, boundTo: null, inventions: [],
  requestDigestSha256: 'r', outputDigestSha256: 'o', providerCalled: true, failureReason: null,
  renderMs: 100, providerMs: 1000, totalMs: 1100, inputTokens: 1000, outputTokens: 100, usd: 0.01,
  renderDigestSha256: 'd', reuseEligible: true, semantic: null,
});
const partition = (bindings: readonly QualificationTargetBinding[], excluded: QualificationTargetBinding) =>
  partitionQualificationExclusions({ bindings, registry: [{ id: 'human-exclusion', reason: 'source review', anchor: anchor(excluded) }],
    anchorsByIdentity: new Map(bindings.map((b) => [b.identity, anchor(b)])) });

describe('B4.6.1 exact human exclusions', () => {
  it('matches every immutable anchor field, never nearby text, page or row alone', () => {
    const b = binding(1);
    for (const changed of [{ identity: 'other' }, { documentId: 'other' }, { sourceSha256: 'c'.repeat(64) },
      { pageDigest: 'c'.repeat(64) }, { physicalPageNumber: 9 }, { observationAnchorKey: 'other' },
      { pageKey: 'other' }, { labelRowKey: 'other' }]) {
      const result = partitionQualificationExclusions({ bindings: [b],
        registry: [{ id: 'x', reason: 'human', anchor: { ...anchor(b), ...changed } }],
        anchorsByIdentity: new Map([[b.identity, anchor(b)]]) });
      expect(result.eligibleBindings).toEqual([b]);
      expect(result.excludedCases).toEqual([]);
      expect(() => assertQualificationExclusionsFinalized(result)).toThrow('not finalized');
    }
    expect(partition([b], b).excludedCases).toHaveLength(1);
  });

  it('blocks an unresolved registry and duplicate exclusion anchors', () => {
    const b = binding(1);
    const pending = partitionQualificationExclusions({ bindings: [b], registry: [{ id: 'x', reason: 'human', anchor: null }],
      anchorsByIdentity: new Map() });
    expect(() => assertQualificationExclusionsFinalized(pending)).toThrow('immutable anchor unresolved');
    expect(decideQualification({ bindings: [b], records: [], exclusions: pending }).qualifiedClasses).toEqual([]);
    expect(() => partitionQualificationExclusions({ bindings: [b],
      registry: ['x', 'y'].map((id) => ({ id, reason: 'human', anchor: anchor(b) })),
      anchorsByIdentity: new Map([[b.identity, anchor(b)]]) })).toThrow('duplicate exclusion anchor');
  });

  it('never counts excluded targets toward the minimum or any score or safety failure', () => {
    const bindings = Array.from({ length: VALUE_READING_ACTIVATION_BAR.minRowsPerClass }, (_, i) => binding(i));
    const bad = { ...record(bindings[0]!), outcome: 'wrong_rate' as const, rateError: 'unsupported_numeric_invention' as const };
    const decision = decideQualification({ bindings, records: [bad, ...bindings.slice(1).map(record)],
      exclusions: partition(bindings, bindings[0]!) });
    expect(decision.classes[0]).toMatchObject({ cases: bindings.length - 1, bound: bindings.length - 1, status: 'insufficient_targets' });
    expect(decision.corpusSafetyFailures).toEqual([]);
    expect(decision.excludedCases).toHaveLength(1);
    expect(decision.provisional).toBe(false);
    expect(decision.activatable).toEqual([]);
  });

  it('keeps an excluded-only evidence class visible and blocking task activation', () => {
    const eligible = Array.from({ length: VALUE_READING_ACTIVATION_BAR.minRowsPerClass }, (_, i) => binding(i));
    const excluded = binding(99, 'dense_scanned_ocr_priced_schedule');
    const bindings = [...eligible, excluded];
    const decision = decideQualification({ bindings, records: eligible.map(record), exclusions: partition(bindings, excluded) });
    expect(decision.qualifiedClasses).toEqual(['confirm_scanned_amount:ocr_price_sheet']);
    expect(decision.classes.find((c) => c.evidenceClass === 'dense_scanned_ocr_priced_schedule'))
      .toMatchObject({ cases: 0, bound: 0, status: 'insufficient_targets', summary: null });
    expect(decision.activatable).toEqual([]);
  });
});
