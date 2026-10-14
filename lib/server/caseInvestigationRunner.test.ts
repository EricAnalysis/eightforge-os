import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { resolveForgewingWorkflowEligibility } from '@/lib/server/forgewingGates';
import {
  CASE_INVESTIGATION_PROMPT_VERSION,
  numericTokens,
  runProviderCaseInvestigation,
} from '@/lib/server/caseInvestigationRunner';

const query = { organizationId: 'org', projectId: 'p', caseId: 'finding:f1', requestedBy: 'u1' };
const FINDING_ACTIONS = [{ kind: 'resolve_execution_item' }, { kind: 'open_document' }, { kind: 'open_linked_documents' },
  { kind: 'open_in_validator' }];
const context = (transmitted: boolean, kind = 'validator_finding', actions: unknown[] = FINDING_ACTIONS) => vi.fn(async () => ({
  status: 'ok' as const,
  resolutionCase: { caseId: 'finding:f1', kind, actions } as never,
  context: { caseId: 'finding:f1', caseKind: kind, purpose: 'provider_investigation', omissions: [],
    transmittedDigest: 'd', readDigest: 'r',
    slices: [{ kind: 'validator_findings', contentClass: 'text_excerpts', transmitted,
      provenance: { source: 'project_validation_findings', documentId: 'doc', physicalPageNumber: 1, recordIds: ['check-1'] },
      payload: [{ id: 'check-1', ruleId: 'X', severity: 'critical', summary: 'Expected 1,250.00 found 1,300.00' }] }] } as never,
}));
const eligible = vi.fn(async () => ({ eligible: true as const, entitlementEventId: 'e', dataPolicyEventIds: ['d'], dailyCap: 3 }));
const reserved = vi.fn(async () => ({ status: 'reserved' as const, reservationId: 'r', usedInWindow: 1 }));
const provider = (output: unknown) => ({ providerModel: 'm',
  investigate: vi.fn(async (_request: { offeredActionKinds: readonly string[] }) => JSON.stringify(output)) });
const answer = (overrides: Record<string, unknown> = {}) => ({
  diagnosis: 'The invoice total 1300 differs from 1,250.00 in the contract.',
  rankedActionKinds: ['open_document', 'open_linked_documents'],
  rationale: 'Check the cited page first.',
  evidenceRefs: [{ sliceKind: 'validator_findings', recordId: 'check-1' }],
  ...overrides,
});
const run = (port: ReturnType<typeof provider>, read = context(true)) =>
  runProviderCaseInvestigation(query, { readContext: read, resolveEligibility: eligible, reserve: reserved, provider: port });

describe('runProviderCaseInvestigation', () => {
  it('is closed today: the case_investigation policy is unqualified whatever the environment asks', async () => {
    const env = { FORGEWING_SHADOW_ENABLED: '1', FORGEWING_CASE_INVESTIGATION_ENABLED: '1', FORGEWING_CASE_INVESTIGATION_DAILY_CAP: '9' };
    const port = provider({});
    const result = await runProviderCaseInvestigation(query, { readContext: context(true), provider: port,
      resolveEligibility: (admin, params) => resolveForgewingWorkflowEligibility(admin, params, { env }) });
    expect(result).toEqual({ status: 'gated', reason: 'activation_disabled' });
    expect(port.investigate).not.toHaveBeenCalled();
  });

  it('investigates Validator findings only (P3b)', async () => {
    const port = provider(answer());
    await expect(run(port, context(true, 'withheld_priced_line'))).resolves.toEqual({ status: 'case_kind_not_supported' });
    expect(port.investigate).not.toHaveBeenCalled();
  });

  it('sends nothing when the data policy approved no content for this case', async () => {
    const port = provider({});
    await expect(run(port, context(false))).resolves.toEqual({ status: 'nothing_to_send' });
    expect(port.investigate).not.toHaveBeenCalled();
  });

  it('spends its own budget before the call, and returns a non-authoritative, cited ranking', async () => {
    const port = provider(answer());
    const result = await run(port);
    expect(eligible).toHaveBeenCalledWith(undefined, { organizationId: 'org', workflow: 'case_investigation', contentClasses: ['text_excerpts'] });
    expect(reserved).toHaveBeenCalledWith(undefined, expect.objectContaining({ workflow: 'case_investigation', dailyCap: 3 }));
    expect(result).toMatchObject({ status: 'proposed', investigation: {
      authority: 'non_authoritative', rankedActionKinds: ['open_document', 'open_linked_documents'],
      evidenceRefs: [{ sliceKind: 'validator_findings', recordId: 'check-1' }], promptVersion: CASE_INVESTIGATION_PROMPT_VERSION } });
  });

  it('never offers the decision, the Validator or a value entry for ranking', async () => {
    const port = provider(answer());
    await run(port);
    const request = port.investigate.mock.calls[0]![0];
    expect(request.offeredActionKinds).toEqual(['open_document', 'open_linked_documents']);
    for (const kind of ['resolve_execution_item', 'open_in_validator', 'enter_reviewed_value']) {
      await expect(run(provider(answer({ rankedActionKinds: [kind] })))).resolves.toEqual({ status: 'output_invalid' });
    }
  });

  it('refuses uncited or wrongly cited answers', async () => {
    await expect(run(provider(answer({ evidenceRefs: [] })))).resolves.toEqual({ status: 'output_invalid' });
    await expect(run(provider(answer({ evidenceRefs: [{ sliceKind: 'validator_findings', recordId: 'check-9' }] }))))
      .resolves.toEqual({ status: 'output_invalid' });
    await expect(run(provider(answer({ evidenceRefs: [{ sliceKind: 'source_text', recordId: 'check-1' }] }))))
      .resolves.toEqual({ status: 'output_invalid' });
  });

  it('refuses an answer that writes a number the context never contained', async () => {
    await expect(run(provider(answer({ rationale: 'The correct amount is 1,275.00.' })))).resolves.toEqual({ status: 'output_invalid' });
    await expect(run(provider(answer({ diagnosis: 'Totals differ: 1,300.00 versus 1250.' })))).resolves
      .toMatchObject({ status: 'proposed' });
  });

  it('calls nothing over budget', async () => {
    const port = provider({});
    await expect(runProviderCaseInvestigation(query, { readContext: context(true), resolveEligibility: eligible,
      reserve: vi.fn(async () => ({ status: 'budget_exhausted' as const, usedInWindow: 3 })), provider: port }))
      .resolves.toEqual({ status: 'budget_exhausted' });
    expect(port.investigate).not.toHaveBeenCalled();
  });

  it('normalizes numbers so formatting differences are not inventions', () => {
    expect(numericTokens('$1,250.00 and 1250 and 12.50 and 12.5')).toEqual(['1250', '1250', '12.5', '12.5']);
  });
});
