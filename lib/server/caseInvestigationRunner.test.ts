import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { resolveForgewingWorkflowEligibility } from '@/lib/server/forgewingGates';
import { runProviderCaseInvestigation } from '@/lib/server/caseInvestigationRunner';

const query = { organizationId: 'org', projectId: 'p', caseId: 'c1', requestedBy: 'u1' };
const context = (transmitted: boolean) => vi.fn(async () => ({
  status: 'ok' as const,
  resolutionCase: { caseId: 'c1', actions: [{ kind: 'enter_reviewed_value' }, { kind: 'open_document' }] } as never,
  context: { caseId: 'c1', caseKind: 'withheld_priced_line', purpose: 'provider_investigation', omissions: [],
    transmittedDigest: 'd', readDigest: 'r',
    slices: [{ kind: 'source_text', contentClass: 'text_excerpts', transmitted, provenance: {} as never, payload: { t: 1 } }] } as never,
}));
const eligible = vi.fn(async () => ({ eligible: true as const, entitlementEventId: 'e', dataPolicyEventIds: ['d'], dailyCap: 3 }));
const reserved = vi.fn(async () => ({ status: 'reserved' as const, reservationId: 'r', usedInWindow: 1 }));
const provider = (output: string) => ({ providerModel: 'm', investigate: vi.fn(async () => output) });

describe('runProviderCaseInvestigation', () => {
  it('is closed today: the case_investigation policy is unqualified whatever the environment asks', async () => {
    const env = { FORGEWING_SHADOW_ENABLED: '1', FORGEWING_CASE_INVESTIGATION_ENABLED: '1', FORGEWING_CASE_INVESTIGATION_DAILY_CAP: '9' };
    const port = provider('{}');
    const result = await runProviderCaseInvestigation(query, { readContext: context(true), provider: port,
      resolveEligibility: (admin, params) => resolveForgewingWorkflowEligibility(admin, params, { env }) });
    expect(result).toEqual({ status: 'gated', reason: 'activation_disabled' });
    expect(port.investigate).not.toHaveBeenCalled();
  });

  it('sends nothing when the data policy approved no content for this case', async () => {
    const port = provider('{}');
    await expect(runProviderCaseInvestigation(query, { readContext: context(false), resolveEligibility: eligible, provider: port }))
      .resolves.toEqual({ status: 'nothing_to_send' });
    expect(port.investigate).not.toHaveBeenCalled();
  });

  it('spends its own budget before the call, and returns a non-authoritative ranking of offered actions only', async () => {
    const port = provider(JSON.stringify({ diagnosis: 'Row pitch broke', rankedActionKinds: ['enter_reviewed_value'], rationale: 'One amount.' }));
    const result = await runProviderCaseInvestigation(query, { readContext: context(true), resolveEligibility: eligible,
      reserve: reserved, provider: port });
    expect(eligible).toHaveBeenCalledWith(undefined, { organizationId: 'org', workflow: 'case_investigation', contentClasses: ['text_excerpts'] });
    expect(reserved).toHaveBeenCalledWith(undefined, expect.objectContaining({ workflow: 'case_investigation', dailyCap: 3 }));
    expect(result).toMatchObject({ status: 'proposed', investigation: { authority: 'non_authoritative', rankedActionKinds: ['enter_reviewed_value'] } });
  });

  it('refuses an answer that ranks an action the case does not list, and calls nothing over budget', async () => {
    const invented = provider(JSON.stringify({ diagnosis: 'x', rankedActionKinds: ['resolve_execution_item'], rationale: 'y' }));
    await expect(runProviderCaseInvestigation(query, { readContext: context(true), resolveEligibility: eligible,
      reserve: reserved, provider: invented })).resolves.toEqual({ status: 'output_invalid' });
    const port = provider('{}');
    await expect(runProviderCaseInvestigation(query, { readContext: context(true), resolveEligibility: eligible,
      reserve: vi.fn(async () => ({ status: 'budget_exhausted' as const, usedInWindow: 3 })), provider: port }))
      .resolves.toEqual({ status: 'budget_exhausted' });
    expect(port.investigate).not.toHaveBeenCalled();
  });
});
