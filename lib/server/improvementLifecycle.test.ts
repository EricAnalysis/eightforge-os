import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RECORD_IMPROVEMENT_FIX_ATTESTATION_FUNCTION,
  recordImprovementFixAttestation,
} from '@/lib/server/improvementLifecycle';
import type { readApprovedEngineeringRequest } from '@/lib/server/approvedEngineeringRequestRead';

const REVIEWER = { actorId: 'b84b0000-0000-4000-8000-0000000000a1', email: 'reviewer@example.invalid', role: null };
const DIGEST = 'd'.repeat(64);
const input = {
  planV2RunId: 'b84b0000-0000-4000-8000-000000000201', planV2DigestSha256: 'a'.repeat(64),
  recommendationId: `rec_${'b'.repeat(64)}`, reviewId: 'b84b0000-0000-4000-8000-000000000301', reviewVersion: 1,
  fixCommitSha: 'c'.repeat(40),
};
const approved = (async () => ({ ok: true, request: { digest: { value: DIGEST } } })) as unknown as typeof readApprovedEngineeringRequest;

function admin(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  return { rpc };
}

afterEach(() => vi.unstubAllEnvs());

describe('fix commit attestation (B8.4b)', () => {
  it('binds the attested commit to the rebuilt approved-request digest and the session reviewer', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    const client = admin({ data: [{ event_id: 'b84b0000-0000-4000-8000-000000000401', inserted: true,
      recorded_at: '2026-10-12T00:00:00+00:00' }], error: null });
    const result = await recordImprovementFixAttestation(input, REVIEWER, { admin: client, readApproved: approved });
    expect(result).toMatchObject({ status: 'attested', inserted: true, engineeringRequestDigestSha256: DIGEST,
      fixCommitSha: input.fixCommitSha });
    expect(client.rpc).toHaveBeenCalledWith(RECORD_IMPROVEMENT_FIX_ATTESTATION_FUNCTION, {
      p_engineering_review_id: input.reviewId, p_engineering_review_version: 1,
      p_engineering_request_digest_sha256: DIGEST, p_fix_commit_sha: input.fixCommitSha, p_attested_by: REVIEWER.actorId,
    });
  });

  it('refuses non-reviewers, abbreviated SHAs and attester fields before any write', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'someone-else@example.invalid');
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES', '');
    const client = admin({ data: null, error: null });
    expect(await recordImprovementFixAttestation(input, REVIEWER, { admin: client, readApproved: approved }))
      .toEqual({ status: 'reviewer_not_eligible' });
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    for (const bad of [{ ...input, fixCommitSha: 'c'.repeat(7) }, { ...input, fixCommitSha: 'C'.repeat(40) },
      { ...input, attestedBy: REVIEWER.actorId }]) {
      expect(await recordImprovementFixAttestation(bad, REVIEWER, { admin: client, readApproved: approved }))
        .toEqual({ status: 'invalid_input' });
    }
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('refuses a request that is not approved before writing', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    const client = admin({ data: null, error: null });
    const rejected = (async () => ({ ok: false, code: 'not_approved' })) as unknown as typeof readApprovedEngineeringRequest;
    expect(await recordImprovementFixAttestation(input, REVIEWER, { admin: client, readApproved: rejected }))
      .toEqual({ status: 'request_not_approved' });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['B8402', 'review_superseded'], ['B8403', 'not_measurable_source'], ['B8404', 'conflicting_attestation'],
    ['P0002', 'request_not_found'], ['XX000', 'attestation_failed'],
  ])('maps database refusal %s to %s', async (code, status) => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    expect(await recordImprovementFixAttestation(input, REVIEWER,
      { admin: admin({ data: null, error: { code } }), readApproved: approved })).toEqual({ status });
  });
});
