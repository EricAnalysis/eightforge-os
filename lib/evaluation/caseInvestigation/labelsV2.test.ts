import { describe, expect, it } from 'vitest';

import type { CorpusManifestEntry } from './corpusV2';
import { freezeLabelSetV2, type ReviewedCase, verifyFrozenLabelSet } from './labelsV2';

const entry = (caseId: string, extra: Partial<CorpusManifestEntry> = {}): CorpusManifestEntry => ({
  caseId, qualificationClass: 'validator_failure', source: 'production', projectId: 'p', projectName: 'P',
  ruleId: 'rule', checkKey: '', rankableActionKinds: ['open_document'], citedDocumentIds: [],
  transmittedDigest: 't', readDigest: 'r', excluded: null, ...extra,
});
const reviewed = (caseRef: string, a: [string, string], b: [string, string] = a): ReviewedCase => ({
  caseRef,
  reviewerA: { caseRef, primaryAction: a[0], rootCause: a[1] },
  reviewerB: { caseRef, primaryAction: b[0], rootCause: b[1] },
});

function input(overrides: Partial<Parameters<typeof freezeLabelSetV2>[0]> = {}) {
  return {
    manifestEntries: [entry('case-1'), entry('case-2'), entry('case-3'), entry('case-x', { excluded: 'duplicate_price_sheet_cited' })],
    phase1: { accepted: [reviewed('C001', ['open_document', 'source_missing'])], key: [{ caseRef: 'C001', caseId: 'case-1' }] },
    relabel: {
      accepted: [reviewed('C002', ['none', 'extraction_error'])],
      residual: [reviewed('C003', ['none', 'other'], ['none', 'genuine_exposure'])],
      key: [{ caseRef: 'C002', caseId: 'case-2' }, { caseRef: 'C003', caseId: 'case-3' }],
    },
    adjudication: { adjudicator: 'Eric Martin', contract: 'case_investigation_qualification_v2',
      decisions: [{ caseRef: 'C003', caseId: 'case-3', rootCause: 'genuine_exposure' }] },
    inputDigests: { owner: 'abc' },
    ...overrides,
  };
}

describe('freezeLabelSetV2', () => {
  it('freezes every eligible case once, recording the owner decision on residual root causes', () => {
    const set = freezeLabelSetV2(input());
    expect(set.labels.map((label) => [label.caseId, label.primaryAction, label.rootCause, label.source])).toEqual([
      ['case-1', 'open_document', 'source_missing', 'reviewer_agreement_phase1'],
      ['case-2', 'none', 'extraction_error', 'reviewer_agreement_relabel'],
      ['case-3', 'none', 'genuine_exposure', 'owner_adjudication'],
    ]);
    expect(set.finalAdjudicator).toBe('Eric Martin');
    expect(() => verifyFrozenLabelSet(set, input().manifestEntries)).not.toThrow();
    expect(freezeLabelSetV2(input()).labelSetDigest).toBe(set.labelSetDigest);
  });

  it('fails closed on an unadjudicated residual case', () => {
    expect(() => freezeLabelSetV2(input({ adjudication: { adjudicator: 'Eric Martin',
      contract: 'case_investigation_qualification_v2', decisions: [{ caseRef: 'C003', caseId: 'case-3', rootCause: null }] } })))
      .toThrow(/ADJUDICATION_MISSING/);
  });

  it('refuses an adjudication by anyone but the final adjudicator', () => {
    expect(() => freezeLabelSetV2(input({ adjudication: { ...input().adjudication, adjudicator: 'Reviewer A' } })))
      .toThrow(/ADJUDICATOR_NOT_FINAL/);
  });

  it('re-checks agreement instead of trusting an accepted list', () => {
    const accepted = [reviewed('C002', ['none', 'extraction_error'], ['none', 'other'])];
    expect(() => freezeLabelSetV2(input({ relabel: { ...input().relabel, accepted } }))).toThrow(/ACCEPTED_WITHOUT_AGREEMENT/);
  });

  it('refuses a primary action the case does not offer', () => {
    const accepted = [reviewed('C001', ['upload_document', 'source_missing'])];
    expect(() => freezeLabelSetV2(input({ phase1: { ...input().phase1, accepted } }))).toThrow(/PRIMARY_ACTION_NOT_OFFERED/);
  });

  it('refuses an invalid root cause from the adjudicator', () => {
    expect(() => freezeLabelSetV2(input({ adjudication: { ...input().adjudication,
      decisions: [{ caseRef: 'C003', caseId: 'case-3', rootCause: 'model_said_so' }] } }))).toThrow(/ROOT_CAUSE_INVALID/);
  });

  it('refuses a label for an excluded case and an unlabelled eligible case', () => {
    expect(() => freezeLabelSetV2(input({ phase1: { accepted: [reviewed('C009', ['none', 'other'])],
      key: [{ caseRef: 'C009', caseId: 'case-x' }] } }))).toThrow(/LABEL_FOR_INELIGIBLE_CASE/);
    expect(() => freezeLabelSetV2(input({ phase1: { accepted: [], key: [] } }))).toThrow(/ELIGIBLE_CASE_UNLABELLED/);
  });

  it('refuses a residual case whose reviewers disagree on the primary action', () => {
    const residual = [reviewed('C003', ['none', 'other'], ['open_document', 'other'])];
    expect(() => freezeLabelSetV2(input({ relabel: { ...input().relabel, residual } }))).toThrow(/RESIDUAL_PRIMARY_ACTION_UNDECIDED/);
  });

  it('detects a tampered frozen set', () => {
    const set = freezeLabelSetV2(input());
    const tampered = { ...set, labels: set.labels.map((label) => ({ ...label, rootCause: 'other' as const })) };
    expect(() => verifyFrozenLabelSet(tampered, input().manifestEntries)).toThrow(/LABEL_SET_DIGEST_MISMATCH/);
  });
});
