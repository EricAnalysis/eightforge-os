import { describe, expect, it, vi } from 'vitest';

import { recordCaseInvestigation, RECORD_CASE_INVESTIGATION_RPC } from '@/lib/server/caseInvestigationRecords';

const investigation = {
  authority: 'non_authoritative' as const, diagnosis: 'The cited invoice total differs from the contract.',
  rankedActionKinds: ['open_document' as const], rationale: 'Check the page.',
  evidenceRefs: [{ sliceKind: 'validator_findings', recordId: 'check-1' }], promptVersion: 'case_investigation_prompt_v2',
  providerModel: 'claude-sonnet-4-6', requestDigestSha256: 'a'.repeat(64), caseKind: 'validator_finding' as const,
  findingCheckKey: 'check-1', ruleId: 'FINANCIAL_X', contextTransmittedDigest: 'b'.repeat(64), reservationId: 'res-1',
};
const params = { organizationId: 'org-1', projectId: 'p1', caseId: 'finding:f1', requestedBy: 'user-1', investigation };

describe('durable case investigation records (P3c)', () => {
  it('records the investigation with its identity, bound to the spent reservation', async () => {
    const rpc = vi.fn(async () => ({ data: [{ investigation_id: 'rec-1', inserted: true }], error: null }));
    await expect(recordCaseInvestigation({ rpc } as never, params))
      .resolves.toEqual({ status: 'recorded', recordId: 'rec-1', inserted: true });
    expect(rpc).toHaveBeenCalledWith(RECORD_CASE_INVESTIGATION_RPC, expect.objectContaining({
      p_organization_id: 'org-1', p_project_id: 'p1', p_case_id: 'finding:f1', p_case_kind: 'validator_finding',
      p_reservation_id: 'res-1', p_request_digest_sha256: 'a'.repeat(64), p_context_transmitted_digest: 'b'.repeat(64),
      p_model: 'claude-sonnet-4-6', p_prompt_version: 'case_investigation_prompt_v2', p_ranked_action_kinds: ['open_document'],
      p_requested_by: 'user-1' }));
  });

  it('is best effort: a refused or throwing record call is reported, never thrown', async () => {
    await expect(recordCaseInvestigation({ rpc: async () => ({ data: null, error: { code: '23514' } }) } as never, params))
      .resolves.toEqual({ status: 'not_recorded', reason: '23514' });
    await expect(recordCaseInvestigation({ rpc: async () => { throw new Error('down'); } } as never, params))
      .resolves.toEqual({ status: 'not_recorded', reason: 'threw' });
  });
});
