import { describe, expect, it, vi } from 'vitest';

import { executeProjectExecutionResolution } from '@/lib/projectExecutionResolution';
import {
  buildResolutionActionRequest,
  classifyResolutionWriteStatus,
  nextCaseIdAfterSave,
} from '@/lib/resolution/resolutionActionRequest';
import type { ResolutionAction, ResolutionCase } from '@/lib/resolution/resolutionCases';

const TARGET = {
  anchorKey: 'p8:priced_line:abc', physicalPageNumber: 8, pageRepresentationDigest: 'a'.repeat(64),
  unresolvedReason: 'header_not_found', rawText: 'Hauling CY $ sia 50', sourceObservationIds: ['o1', 'o2'],
  sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] }, visual: null,
};

function resolutionCase(actions: ResolutionAction[], overrides: Partial<ResolutionCase> = {}): ResolutionCase {
  return {
    caseId: 'case-1', kind: 'unreadable_priced_line', tier: 'missing_authoritative_value', exposureAmount: null,
    projectId: 'project-1', documentId: 'doc-1', physicalPageNumber: 8, title: 't', problem: 'p', finding: null,
    previousReviews: [], deterministicState: 'd', originalSourceText: null, rootCauseKey: 'r', evidence: [],
    suggestions: [], actions, sourceRefs: {}, ...overrides,
  };
}

const enter: ResolutionAction = {
  kind: 'enter_reviewed_value', method: 'POST', endpoint: '/api/documents/doc-1/facts/region-assertions',
  factKey: 'contract_rate_row', target: TARGET, supersedesAssertionId: 'head-1',
};
const withdraw: ResolutionAction = {
  kind: 'withdraw_reviewed_value', method: 'POST', endpoint: '/api/documents/doc-1/facts/region-assertions',
  anchorKey: TARGET.anchorKey, supersedesAssertionId: 'head-1', target: TARGET,
};
const recovery = (version: 1 | 2): ResolutionAction => ({
  kind: 'review_recovery_proposal', method: 'POST', endpoint: '/api/internal/forgewing-recovery-review',
  proposalId: 'proposal-1', proposalDigestSha256: 'd'.repeat(64), proposalVersion: version,
  dispositions: ['accepted', 'modified', 'rejected', 'deferred'], sourceEvidenceUnbound: false,
  selectableConfirmations: [{
    field: version === 2 ? 'confirmedCandidateId' : 'confirmedObservationId', id: 'option-1', rawText: '8.75',
    proposed: true, visual: null,
  }],
});
const execution: ResolutionAction = {
  kind: 'resolve_execution_item', method: 'PATCH', endpoint: '/api/execution-items/exec-1/outcome',
  outcomes: ['approve', 'correct', 'override'],
};
const value = { description: ' Hauling ', unitType: 'CY', rate: '14.50', category: '' };

describe('resolution action requests (B5-B)', () => {
  it('refuses every action the server did not list on the case', () => {
    const core = resolutionCase([{ kind: 'open_in_validator', href: '/x' }]);
    expect(buildResolutionActionRequest(core, { kind: 'enter_reviewed_value', value, reason: 'r', idempotencyKey: 'k' }).ok).toBe(false);
    expect(buildResolutionActionRequest(core, { kind: 'withdraw_reviewed_value', reason: 'r', idempotencyKey: 'k' }).ok).toBe(false);
    expect(buildResolutionActionRequest(core, { kind: 'review_recovery_proposal', disposition: 'rejected', rationale: 'r' }).ok).toBe(false);
    expect(buildResolutionActionRequest(core, { kind: 'resolve_execution_item', outcome: 'approve', reason: '' }).ok).toBe(false);
    // An ambiguous listing is not chosen from.
    expect(buildResolutionActionRequest(resolutionCase([enter, enter]),
      { kind: 'enter_reviewed_value', value, reason: 'r', idempotencyKey: 'k' }).ok).toBe(false);
  });

  it('binds a reviewed value to the server target; the operator supplies only the value and reason', () => {
    const result = buildResolutionActionRequest(resolutionCase([enter]),
      { kind: 'enter_reviewed_value', value, reason: ' read from the page ', idempotencyKey: 'key-1' });
    expect(result).toEqual({ ok: true, request: {
      method: 'POST', url: '/api/documents/doc-1/facts/region-assertions',
      body: {
        factKey: 'contract_rate_row', status: 'active',
        value: { description: 'Hauling', unit_type: 'CY', rate_amount: 14.5 },
        reason: 'read from the page', anchorKey: TARGET.anchorKey, physicalPageNumber: 8,
        pageRepresentationDigest: TARGET.pageRepresentationDigest, sourceObservationIds: ['o1', 'o2'],
        sourceRegion: TARGET.sourceRegion, supersedesAssertionId: 'head-1', idempotencyKey: 'key-1',
      },
    } });
    for (const bad of [{ ...value, rate: 'abc' }, { ...value, rate: '' }, { ...value, unitType: ' ' }]) {
      expect(buildResolutionActionRequest(resolutionCase([enter]),
        { kind: 'enter_reviewed_value', value: bad, reason: 'r', idempotencyKey: 'k' }).ok).toBe(false);
    }
    expect(buildResolutionActionRequest(resolutionCase([enter]),
      { kind: 'enter_reviewed_value', value, reason: '  ', idempotencyKey: 'k' }).ok).toBe(false);
  });

  it('withdraws by superseding the listed head against the current target', () => {
    const result = buildResolutionActionRequest(resolutionCase([withdraw]),
      { kind: 'withdraw_reviewed_value', reason: 'wrong page', idempotencyKey: 'k' });
    expect(result.ok && result.request.body).toMatchObject({
      status: 'withdrawn', value: null, supersedesAssertionId: 'head-1', anchorKey: TARGET.anchorKey,
      pageRepresentationDigest: TARGET.pageRepresentationDigest, sourceObservationIds: ['o1', 'o2'],
    });
  });

  it('pins the exact proposal and confirms only an offered option, in the field its version takes', () => {
    const v1 = buildResolutionActionRequest(resolutionCase([recovery(1)]),
      { kind: 'review_recovery_proposal', disposition: 'accepted', confirmationId: 'option-1', rationale: 'matches' });
    expect(v1).toEqual({ ok: true, request: { method: 'POST', url: '/api/internal/forgewing-recovery-review', body: {
      proposalId: 'proposal-1', proposalDigestSha256: 'd'.repeat(64), disposition: 'accepted',
      confirmedObservationId: 'option-1', reviewerRationale: 'matches',
    } } });
    const v2 = buildResolutionActionRequest(resolutionCase([recovery(2)]),
      { kind: 'review_recovery_proposal', disposition: 'modified', confirmationId: 'option-1', rationale: 'matches' });
    expect(v2.ok && v2.request.body).toMatchObject({ confirmedCandidateId: 'option-1' });
    expect(buildResolutionActionRequest(resolutionCase([recovery(1)]),
      { kind: 'review_recovery_proposal', disposition: 'accepted', confirmationId: 'invented', rationale: 'r' }).ok).toBe(false);
    expect(buildResolutionActionRequest(resolutionCase([recovery(1)]),
      { kind: 'review_recovery_proposal', disposition: 'accepted', rationale: 'r' }).ok).toBe(false);
    const rejected = buildResolutionActionRequest(resolutionCase([recovery(1)]),
      { kind: 'review_recovery_proposal', disposition: 'rejected', confirmationId: 'option-1', rationale: 'no' });
    expect(rejected.ok && rejected.request.body).not.toHaveProperty('confirmedObservationId');
    expect(buildResolutionActionRequest(resolutionCase([recovery(1)]),
      { kind: 'review_recovery_proposal', disposition: 'rejected', rationale: ' ' }).ok).toBe(false);
  });

  it('sends the execution outcome exactly as the existing execution helper does', async () => {
    const result = buildResolutionActionRequest(resolutionCase([execution]),
      { kind: 'resolve_execution_item', outcome: 'override', reason: ' contract amendment governs ' });
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await executeProjectExecutionResolution({
      executionItemId: 'exec-1', action: 'override', accessToken: 't', reason: ' contract amendment governs ', fetcher,
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(result).toEqual({ ok: true, request: { method: init.method, url, body: JSON.parse(init.body) } });
    expect(buildResolutionActionRequest(resolutionCase([execution]),
      { kind: 'resolve_execution_item', outcome: 'override', reason: '' }).ok).toBe(false);
  });

  it('treats a 409 as stale (refresh in place), never as a retry', () => {
    expect(classifyResolutionWriteStatus(200)).toBe('saved');
    expect(classifyResolutionWriteStatus(201)).toBe('saved');
    expect(classifyResolutionWriteStatus(409)).toBe('stale');
    expect(classifyResolutionWriteStatus(400)).toBe('refused');
    expect(classifyResolutionWriteStatus(500)).toBe('refused');
  });

  it('advances after a save deterministically, only to a case the server returned', () => {
    expect(nextCaseIdAfterSave({ previousOrder: ['a', 'b', 'c'], savedCaseId: 'a', refreshedOrder: ['b', 'c'] })).toBe('b');
    // The following case was resolved elsewhere meanwhile: skip it.
    expect(nextCaseIdAfterSave({ previousOrder: ['a', 'b', 'c'], savedCaseId: 'a', refreshedOrder: ['c', 'd'] })).toBe('c');
    // Saved the last case: wrap to the first open one.
    expect(nextCaseIdAfterSave({ previousOrder: ['a', 'b'], savedCaseId: 'b', refreshedOrder: ['a'] })).toBe('a');
    // A deferral leaves the case open; the operator still moves on.
    expect(nextCaseIdAfterSave({ previousOrder: ['a'], savedCaseId: 'a', refreshedOrder: ['a', 'z'] })).toBe('z');
    expect(nextCaseIdAfterSave({ previousOrder: ['a'], savedCaseId: 'a', refreshedOrder: [] })).toBeNull();
  });
});
