import { describe, expect, it } from 'vitest';

import type { openGitCheckout } from '@/lib/server/gitAncestry';
import {
  READ_CLASSIFICATION_WORK_FUNCTION,
  READ_IMPROVEMENT_DEPLOYMENT_WORK_FUNCTION,
  RECORD_IMPROVEMENT_DEPLOYMENT_FUNCTION,
  RECORD_PRODUCER_CLASSIFICATION_FUNCTION,
  runImprovementDeploymentProof,
  runImprovementProducerClassification,
} from '@/lib/server/improvementDeploymentWorker';

const FIX = '1'.repeat(40);
const BEFORE = '2'.repeat(40);
const FIRST_WITH_FIX = '3'.repeat(40);
const LATER_WITH_FIX = '4'.repeat(40);
const HEAD = '5'.repeat(40);
const EVENT = 'b84b0000-0000-4000-8000-000000000001';
const observation = (revision: string, n: number) => ({
  revision, run_id: `b84b0000-0000-4000-8000-00000000010${n}`, observed_at: `2026-10-0${n}T00:00:00+00:00`,
});

function fakeCheckout(contained: ReadonlySet<string>, unavailable: ReadonlySet<string> = new Set()): typeof openGitCheckout {
  return () => ({ ok: true, checkout: {
    headCommit: HEAD,
    contains: (_ancestor: string, descendant: string) => unavailable.has(descendant)
      ? { ok: false as const, code: 'commit_unavailable' as const }
      : { ok: true as const, contains: contained.has(descendant) },
  } });
}

function fakeClient(work: unknown) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === READ_IMPROVEMENT_DEPLOYMENT_WORK_FUNCTION) return { data: [work], error: null };
      return { data: [{ event_id: 'b84b0000-0000-4000-8000-000000000099', inserted: true }], error: null };
    },
  };
}

const work = (observations = [observation(BEFORE, 1), observation(FIRST_WITH_FIX, 2), observation(LATER_WITH_FIX, 3)]) => ({
  pending_attestations: [{ event_id: EVENT, fix_commit_sha: FIX }],
  production_observations: observations, observations_truncated: false,
});

describe('deployment proof worker (B8.4b)', () => {
  it('records the earliest observed production revision that contains the attested commit', async () => {
    const client = fakeClient(work());
    const result = await runImprovementDeploymentProof(client, '/checkout',
      { openCheckout: fakeCheckout(new Set([FIRST_WITH_FIX, LATER_WITH_FIX])) });
    expect(result).toMatchObject({ status: 'completed', verifierCheckoutCommit: HEAD,
      outcomes: [{ implementedEventId: EVENT, outcome: 'deployed', productionRevision: FIRST_WITH_FIX, inserted: true }] });
    expect(client.calls.filter((call) => call.name === RECORD_IMPROVEMENT_DEPLOYMENT_FUNCTION)).toEqual([{
      name: RECORD_IMPROVEMENT_DEPLOYMENT_FUNCTION, args: { p_implemented_event_id: EVENT,
        p_production_revision: FIRST_WITH_FIX, p_observation_run_id: observation(FIRST_WITH_FIX, 2).run_id,
        p_verifier_checkout_commit: HEAD },
    }]);
  });

  it('records nothing while no observed production revision contains the fix', async () => {
    const client = fakeClient(work([observation(BEFORE, 1)]));
    const result = await runImprovementDeploymentProof(client, '/checkout', { openCheckout: fakeCheckout(new Set()) });
    expect(result).toMatchObject({ status: 'completed', outcomes: [{ outcome: 'not_yet_deployed' }] });
    expect(client.calls.some((call) => call.name === RECORD_IMPROVEMENT_DEPLOYMENT_FUNCTION)).toBe(false);
  });

  it('never lets a later revision stand in for an earlier one it could not check', async () => {
    const client = fakeClient(work());
    const result = await runImprovementDeploymentProof(client, '/checkout',
      { openCheckout: fakeCheckout(new Set([FIRST_WITH_FIX, LATER_WITH_FIX]), new Set([BEFORE])) });
    expect(result).toMatchObject({ status: 'completed',
      outcomes: [{ outcome: 'unverifiable', code: 'commit_unavailable', revision: BEFORE }] });
    expect(client.calls.some((call) => call.name === RECORD_IMPROVEMENT_DEPLOYMENT_FUNCTION)).toBe(false);
  });

  it('fails closed on an unusable checkout, a truncated revision list, or malformed work', async () => {
    expect(await runImprovementDeploymentProof(fakeClient(work()), '/checkout',
      { openCheckout: () => ({ ok: false, code: 'shallow_repository' }) }))
      .toEqual({ status: 'failed', code: 'shallow_repository' });
    expect(await runImprovementDeploymentProof(fakeClient({ ...work(), observations_truncated: true }), '/checkout',
      { openCheckout: fakeCheckout(new Set()) })).toEqual({ status: 'failed', code: 'observations_truncated' });
    expect(await runImprovementDeploymentProof(fakeClient({ ...work(), pending_attestations: [{ event_id: EVENT,
      fix_commit_sha: 'main' }] }), '/checkout', { openCheckout: fakeCheckout(new Set()) }))
      .toEqual({ status: 'failed', code: 'invalid_work' });
  });
});

describe('producer classification worker (B8.4c)', () => {
  const DEPLOYED_EVENT = 'b84b0000-0000-4000-8000-000000000201';
  const classificationClient = (work: unknown) => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    return { calls, rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === READ_CLASSIFICATION_WORK_FUNCTION) return { data: work, error: null };
      return { data: [{ classification_id: DEPLOYED_EVENT, inserted: true }], error: null };
    } };
  };

  it('records, for each revision, whether it contains the attested commit, and skips what the checkout cannot answer', async () => {
    const client = classificationClient([{ deployed_event_id: DEPLOYED_EVENT, fix_commit_sha: FIX,
      revisions: [BEFORE, FIRST_WITH_FIX, LATER_WITH_FIX], revisions_truncated: false }]);
    const result = await runImprovementProducerClassification(client, '/checkout',
      { openCheckout: fakeCheckout(new Set([FIRST_WITH_FIX]), new Set([LATER_WITH_FIX])) });
    expect(result).toEqual({ status: 'completed', verifierCheckoutCommit: HEAD, classified: 2, unverifiable: 1,
      recordFailed: 0, truncatedEvents: 0 });
    expect(client.calls.filter((call) => call.name === RECORD_PRODUCER_CLASSIFICATION_FUNCTION).map((call) => call.args))
      .toEqual([
        { p_deployed_event_id: DEPLOYED_EVENT, p_producer_revision: BEFORE, p_contains_fix: false, p_verifier_checkout_commit: HEAD },
        { p_deployed_event_id: DEPLOYED_EVENT, p_producer_revision: FIRST_WITH_FIX, p_contains_fix: true, p_verifier_checkout_commit: HEAD },
      ]);
  });

  it('fails closed on an unusable checkout or malformed work', async () => {
    expect(await runImprovementProducerClassification(classificationClient([]), '/checkout',
      { openCheckout: () => ({ ok: false, code: 'shallow_repository' }) })).toEqual({ status: 'failed', code: 'shallow_repository' });
    expect(await runImprovementProducerClassification(classificationClient([{ deployed_event_id: DEPLOYED_EVENT,
      fix_commit_sha: FIX, revisions: ['main'], revisions_truncated: false }]), '/checkout',
      { openCheckout: fakeCheckout(new Set()) })).toEqual({ status: 'failed', code: 'invalid_work' });
  });
});
