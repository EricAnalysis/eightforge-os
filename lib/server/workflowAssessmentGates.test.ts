// Forgewing S3: Workflow Assessment behind the shared Forgewing gates.
//
// Organization eligibility (entitlement, data policy, configured budget) is
// resolved before any claim, so a denied organization's submission is never
// claimed and keeps both lifetime attempts. Provider-free.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAdmin = vi.hoisted(() => vi.fn());
const runAssessment = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getAdmin }));
vi.mock('@/lib/server/workflowAssessment', () => ({
  runAndRecordWorkflowAssessment: runAssessment,
  isWorkflowAssessmentEnabled: enabled,
}));

import {
  executeClaimedWorkflowAssessment,
  resolveWorkflowAssessmentOrganizationGate,
  sweepWorkflowAssessments,
  WORKFLOW_ASSESSMENT_CANDIDATE_ORGANIZATIONS_FUNCTION,
  WORKFLOW_ASSESSMENT_CLAIM_FUNCTION,
  WORKFLOW_ASSESSMENT_CONTENT_CLASSES,
} from '@/lib/server/workflowAssessmentClaim';
import { FORGEWING_WORKFLOW_POLICIES, type ValueReadingEligibility } from '@/lib/server/forgewingGates';

const ENTITLED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DENIED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ELIGIBLE: ValueReadingEligibility = {
  eligible: true, entitlementEventId: 'e1', dataPolicyEventIds: ['d1'], dailyCap: 4,
};

function database(candidates: unknown, options: { listError?: boolean } = {}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === WORKFLOW_ASSESSMENT_CANDIDATE_ORGANIZATIONS_FUNCTION) {
      return options.listError ? { data: null, error: { message: 'down' } } : { data: candidates, error: null };
    }
    if (name === WORKFLOW_ASSESSMENT_CLAIM_FUNCTION) return { data: [], error: null };
    throw new Error(`unexpected rpc ${name}`);
  });
  getAdmin.mockReturnValue({ rpc });
  return rpc;
}

describe('Workflow Assessment organization gates (S3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    enabled.mockReturnValue(true);
  });

  it('is a gated Forgewing workflow whose ceiling equals its former env-only behaviour', () => {
    expect(FORGEWING_WORKFLOW_POLICIES.workflow_assessment).toMatchObject({
      qualificationCeiling: 'enabled',
      activationEnv: 'FORGEWING_WORKFLOW_ASSESSMENT_ENABLED',
      dailyCapEnv: 'FORGEWING_WORKFLOW_ASSESSMENT_DAILY_CAP',
      reviewRequired: true,
    });
    expect(WORKFLOW_ASSESSMENT_CONTENT_CLASSES).toEqual(['text_excerpts']);
  });

  it('claims only within organizations every gate admits, with the configured cap', async () => {
    vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_DAILY_CAP', '4');
    const rpc = database([{ organization_id: ENTITLED }, { organization_id: DENIED }]);
    const resolveEligibility = vi.fn(async (_admin: unknown, params: { organizationId: string }) =>
      (params.organizationId === ENTITLED ? ELIGIBLE
        : { eligible: false as const, reason: 'data_policy_not_approved' as const, contentClass: 'text_excerpts' as const }));

    const result = await executeClaimedWorkflowAssessment(undefined, [], undefined, { resolveEligibility });

    expect(result.status).toBe('nothing_claimable');
    for (const organizationId of [ENTITLED, DENIED]) {
      expect(resolveEligibility).toHaveBeenCalledWith(expect.anything(), {
        organizationId, workflow: 'workflow_assessment', contentClasses: ['text_excerpts'],
      });
    }
    const claim = rpc.mock.calls.find(([name]) => name === WORKFLOW_ASSESSMENT_CLAIM_FUNCTION);
    expect(claim).toBeDefined();
    expect((claim as unknown as [string, Record<string, unknown>])[1]).toMatchObject({
      p_eligible_organization_ids: [ENTITLED], p_daily_cap: 4,
    });
  });

  it('never claims, and so never spends an attempt, when no organization is eligible', async () => {
    const rpc = database([{ organization_id: DENIED }]);
    const resolveEligibility = vi.fn(async () =>
      ({ eligible: false as const, reason: 'no_entitlement' as const }));

    const result = await executeClaimedWorkflowAssessment('11111111-1111-4111-8111-111111111111', [], undefined,
      { resolveEligibility });

    expect(result).toEqual({ status: 'no_eligible_organization', candidates: 1 });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([WORKFLOW_ASSESSMENT_CANDIDATE_ORGANIZATIONS_FUNCTION]);
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('fails closed when the candidate lookup fails or returns malformed rows', async () => {
    database(null, { listError: true });
    await expect(resolveWorkflowAssessmentOrganizationGate(getAdmin()))
      .resolves.toEqual({ status: 'gate_lookup_failed' });

    database({ not: 'an array' });
    await expect(resolveWorkflowAssessmentOrganizationGate(getAdmin()))
      .resolves.toEqual({ status: 'gate_lookup_failed' });

    // Rows without an organization are never candidates.
    const resolveEligibility = vi.fn(async () => ELIGIBLE);
    database([{ organization_id: null }, {}]);
    await expect(resolveWorkflowAssessmentOrganizationGate(getAdmin(), { resolveEligibility }))
      .resolves.toEqual({ status: 'no_eligible_organization', candidates: 0 });
    expect(resolveEligibility).not.toHaveBeenCalled();
  });

  it('a sweep resolves the gates once and stops without claiming when nothing is eligible', async () => {
    const rpc = database([{ organization_id: DENIED }]);
    const resolveEligibility = vi.fn(async () =>
      ({ eligible: false as const, reason: 'budget_not_configured' as const }));

    const result = await sweepWorkflowAssessments({ resolveEligibility });

    expect(result).toMatchObject({ attempted: 0, stoppedBecause: 'no_eligible_organization' });
    expect(resolveEligibility).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.some(([name]) => name === WORKFLOW_ASSESSMENT_CLAIM_FUNCTION)).toBe(false);
  });

  it('a disabled deployment touches neither the gates nor the database', async () => {
    enabled.mockReturnValue(false);
    const rpc = database([{ organization_id: ENTITLED }]);
    const resolveEligibility = vi.fn();
    await expect(sweepWorkflowAssessments({ resolveEligibility }))
      .resolves.toMatchObject({ stoppedBecause: 'disabled' });
    await expect(executeClaimedWorkflowAssessment(undefined, [], undefined, { resolveEligibility }))
      .resolves.toEqual({ status: 'assessment_disabled' });
    expect(rpc).not.toHaveBeenCalled();
    expect(resolveEligibility).not.toHaveBeenCalled();
  });
});
