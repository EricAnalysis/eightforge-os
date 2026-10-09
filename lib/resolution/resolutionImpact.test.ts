import { describe, expect, it } from 'vitest';

import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import { buildResolutionImpact, validatorRunFingerprint } from '@/lib/resolution/resolutionImpact';
import type { ProjectExposureSummary, ValidationFinding, ValidatorResult } from '@/types/validator';

function finding(checkKey: string, overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  const [ruleId, subjectId] = checkKey.split(':');
  return {
    id: `run-local-${checkKey}`, run_id: 'run', project_id: 'p', rule_id: ruleId!, check_key: checkKey,
    category: 'financial_integrity', severity: 'warning', status: 'open', subject_type: 'invoice_line',
    subject_id: subjectId ?? 'line-1', field: 'unit_price', expected: '12.75', actual: '13', variance: null,
    variance_unit: null, blocked_reason: null, decision_eligible: true, action_eligible: true, linked_decision_id: null,
    linked_action_id: null, resolved_by_user_id: null, resolved_at: null, created_at: '', updated_at: '',
    problem: `${ruleId} problem`, ...overrides,
  } as ValidationFinding;
}

const blocker = (checkKey: string, overrides: Partial<ValidationFinding> = {}) =>
  finding(checkKey, { severity: 'critical', blocked_reason: 'Blocks approval', ...overrides });

function exposure(atRisk: number): ProjectExposureSummary {
  return {
    total_billed_amount: 130, total_contract_supported_amount: 130 - atRisk, total_transaction_supported_amount: 0,
    total_fully_reconciled_amount: 0, total_unreconciled_amount: atRisk, total_at_risk_amount: atRisk,
    support_gap_tolerance_amount: 0, at_risk_tolerance_amount: 0, moderate_severity: 'warning', invoices: [],
  };
}

function result(findings: ValidationFinding[], exposureSummary: ProjectExposureSummary | null = null): ValidatorResult {
  return {
    status: 'BLOCKED', blocked_reasons: [], findings, summary: {} as ValidatorResult['summary'], rulesApplied: [],
    validator_status: 'BLOCKED' as ValidatorResult['validator_status'], validator_open_items: [], validator_blockers: [],
    exposure: exposureSummary,
  };
}

function findingCase(caseId: string, findingId: string, rootCauseKey: string): ResolutionCase {
  return {
    caseId, kind: 'validator_finding', tier: 'blocks_approval', exposureAmount: null, projectId: 'p', documentId: null,
    physicalPageNumber: null, title: caseId, problem: '', finding: null, previousReviews: [], deterministicState: '',
    originalSourceText: null, rootCauseKey, evidence: [], suggestions: [], actions: [], sourceRefs: { findingId },
  };
}

function impact(before: ValidationFinding[], after: ValidationFinding[], extra: Partial<Parameters<typeof buildResolutionImpact>[0]> = {}) {
  return buildResolutionImpact({
    caseId: 'unreadable:doc:a', actionKind: 'enter_reviewed_value', actionDocumentId: 'doc',
    before: result(before), after: result(after),
    persistedFindingIdsByKey: new Map(), queue: { cases: [] }, ...extra,
  });
}

describe('resolution impact (B5-C)', () => {
  it('is byte-identical for the same inputs, whatever the finding order', () => {
    const before = [blocker('UNIT_PRICE:line-1'), finding('CATEGORY:line-1'), finding('TOTAL:inv-1', { subject_type: 'invoice' })];
    const after = [finding('CATEGORY:line-1', { severity: 'info' }), finding('NEW:line-2')];
    const first = impact(before, after);
    const second = impact([...before].reverse(), [...after].reverse());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.impactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.impactDigest).toBe(first.impactDigest);
  });

  it('reports new findings rather than hiding them', () => {
    const result = impact([finding('UNIT_PRICE:line-1')], [finding('DUPLICATE_RATE:line-1', { severity: 'critical', blocked_reason: 'dup' })]);
    expect(result.opensFindingIds).toEqual(['DUPLICATE_RATE:line-1']);
    expect(result.opens[0]).toMatchObject({ title: 'DUPLICATE_RATE problem', blocksApproval: true });
    expect(result.resolvesFindingIds).toEqual(['UNIT_PRICE:line-1']);
  });

  it('counts approval blockers exactly, before and after', () => {
    const result = impact(
      [blocker('A:line-1'), blocker('B:line-2'), blocker('C:line-3'), finding('D:line-4'), finding('E:line-5', { status: 'resolved' })],
      [blocker('B:line-2'), finding('D:line-4'), blocker('F:line-6')],
    );
    expect(result).toMatchObject({ findingsBefore: 4, findingsAfter: 3, blockersBefore: 3, blockersAfter: 2 });
    expect(result.resolvesFindingIds).toEqual(['A:line-1', 'C:line-3']);
    expect(result.opensFindingIds).toEqual(['F:line-6']);
    // A finding that is not open is neither counted nor resolved.
    expect(result.resolvesFindingIds).not.toContain('E:line-5');
  });

  it('reports a change in place, not as one resolved and one opened', () => {
    const result = impact([blocker('UNIT_PRICE:line-1')], [finding('UNIT_PRICE:line-1', { actual: '12.75' })]);
    expect(result.resolves).toEqual([]);
    expect(result.opens).toEqual([]);
    expect(result.changes[0]).toMatchObject({
      findingKey: 'UNIT_PRICE:line-1', before: { severity: 'critical', blocksApproval: true, actual: '13' },
      after: { severity: 'warning', blocksApproval: false, actual: '12.75' },
    });
  });

  it('aggregates a root cause once: one action, every case it closes', () => {
    const queue = { cases: [
      findingCase('finding:f1', 'f1', 'rate_row:doc:r1'), findingCase('finding:f2', 'f2', 'rate_row:doc:r1'),
      findingCase('finding:f3', 'f3', 'rate_row:doc:r9'),
    ] };
    const result = impact(
      [blocker('A:line-1'), blocker('B:line-2'), blocker('C:line-3')],
      [blocker('C:line-3')],
      { persistedFindingIdsByKey: new Map([['A:line-1', 'f1'], ['B:line-2', 'f2'], ['C:line-3', 'f3']]), queue },
    );
    expect(result.resolvesCaseIds).toEqual(['finding:f1', 'finding:f2']);
    expect(result.resolves.map((entry) => entry.findingId)).toEqual(['f1', 'f2']);
    expect(result.affectedInvoiceLines).toEqual(['line-1', 'line-2']);
  });

  it('states exposure only when the Validator computed it on both sides', () => {
    const none = buildResolutionImpact({
      caseId: 'c', actionKind: 'enter_reviewed_value', actionDocumentId: null,
      before: result([], exposure(130)), after: result([], null), persistedFindingIdsByKey: new Map(), queue: { cases: [] },
    });
    expect(none.financialExposureDelta).toBeNull();
    const both = buildResolutionImpact({
      caseId: 'c', actionKind: 'enter_reviewed_value', actionDocumentId: null,
      before: result([], exposure(130)), after: result([], exposure(117)), persistedFindingIdsByKey: new Map(), queue: { cases: [] },
    });
    expect(both.financialExposureDelta!.totalAtRiskAmount).toEqual({ before: 130, after: 117, delta: -13 });
  });

  it('fingerprints a run by what it found, so contamination between runs is detectable', () => {
    expect(validatorRunFingerprint(result([finding('A:1')]))).toBe(validatorRunFingerprint(result([finding('A:1')])));
    expect(validatorRunFingerprint(result([finding('A:1')]))).not.toBe(validatorRunFingerprint(result([finding('A:1', { actual: '9' })])));
  });
});
