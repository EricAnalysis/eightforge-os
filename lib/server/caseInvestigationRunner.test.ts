import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { resolveForgewingWorkflowEligibility } from '@/lib/server/forgewingGates';
import {
  CASE_INVESTIGATION_OUTPUT_LIMITS,
  CASE_INVESTIGATION_PROMPT_VERSION,
  CASE_INVESTIGATION_SYSTEM_PROMPT,
  citableRecords,
  citationRef,
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
  citations: ['A'],
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
    await expect(run(provider(answer({ citations: [] })))).resolves.toEqual({ status: 'output_invalid' });
    await expect(run(provider(answer({ citations: ['B'] })))).resolves.toEqual({ status: 'output_invalid' });
    await expect(run(provider(answer({ citations: ['A', 'A'] })))).resolves.toEqual({ status: 'output_invalid' });
    // A record id is no longer a citation: the model cites by letter ref only.
    await expect(run(provider(answer({ citations: ['check-1'] })))).resolves.toEqual({ status: 'output_invalid' });
  });

  it('gives each transmitted record a letter ref, sends the map and resolves citations to records', async () => {
    expect([0, 25, 26, 51, 52].map((index) => citationRef(index))).toEqual(['A', 'Z', 'AA', 'AZ', 'BA']);
    expect(citableRecords([
      { kind: 'case_evidence', provenance: { recordIds: ['c1'] } },
      { kind: 'validator_findings', provenance: { recordIds: ['f1', 'f2', 'f1'] } },
    ])).toEqual([{ ref: 'A', sliceKind: 'case_evidence', recordId: 'c1' },
      { ref: 'B', sliceKind: 'validator_findings', recordId: 'f1' }, { ref: 'C', sliceKind: 'validator_findings', recordId: 'f2' }]);
    const port = provider(answer());
    await run(port);
    expect((port.investigate.mock.calls[0]![0] as unknown as { context: { cite: unknown }[] }).context[0]!.cite)
      .toEqual({ A: 'check-1' });
  });

  it('accepts a citation of any transmitted record, however long its id', async () => {
    const longId = `finding:TRANSACTION_TICKET_GRAIN_CONFLICT:${'x'.repeat(300)}`;
    const read = vi.fn(async () => ({
      status: 'ok' as const,
      resolutionCase: { caseId: 'finding:f1', kind: 'validator_finding', actions: FINDING_ACTIONS } as never,
      context: { caseId: 'finding:f1', caseKind: 'validator_finding', purpose: 'provider_investigation', omissions: [],
        transmittedDigest: 'd', readDigest: 'r',
        slices: [{ kind: 'case_evidence', contentClass: 'text_excerpts', transmitted: true,
          provenance: { source: 'resolution_case', documentId: 'doc', physicalPageNumber: 1, recordIds: [longId] },
          payload: { problem: 'Expected 1,250.00 found 1,300.00' } }] } as never,
    }));
    await expect(run(provider(answer({ citations: ['A'] })), read))
      .resolves.toMatchObject({ status: 'proposed', investigation: { evidenceRefs: [{ sliceKind: 'case_evidence', recordId: longId }] } });
  });

  it('states the bounds it enforces to the model, and still enforces them', async () => {
    expect(CASE_INVESTIGATION_SYSTEM_PROMPT).toContain(`within ${CASE_INVESTIGATION_OUTPUT_LIMITS.diagnosisMaxChars} characters`);
    expect(CASE_INVESTIGATION_SYSTEM_PROMPT).toContain(`within ${CASE_INVESTIGATION_OUTPUT_LIMITS.rationaleMaxChars}`);
    expect(CASE_INVESTIGATION_SYSTEM_PROMPT).toContain(
      `${CASE_INVESTIGATION_OUTPUT_LIMITS.evidenceRefsMin} to ${CASE_INVESTIGATION_OUTPUT_LIMITS.evidenceRefsMax} records`);
    await expect(run(provider(answer({ diagnosis: 'x'.repeat(CASE_INVESTIGATION_OUTPUT_LIMITS.diagnosisMaxChars + 1) }))))
      .resolves.toEqual({ status: 'output_invalid' });
    await expect(run(provider(answer({ diagnosis: 'x'.repeat(CASE_INVESTIGATION_OUTPUT_LIMITS.diagnosisMaxChars) }))))
      .resolves.toMatchObject({ status: 'proposed' });
  });

  it('refuses an answer that writes a number the context never contained', async () => {
    await expect(run(provider(answer({ rationale: 'The correct amount is 1,275.00.' })))).resolves.toEqual({ status: 'output_invalid' });
    await expect(run(provider(answer({ diagnosis: 'Totals differ: 1,300.00 versus 1250.' })))).resolves
      .toMatchObject({ status: 'proposed' });
  });

  it('stays strict on list markers: numbering is a number the context never contained (the prompt forbids it)', async () => {
    expect(CASE_INVESTIGATION_SYSTEM_PROMPT).toContain('never number or letter them');
    await expect(run(provider(answer({ diagnosis: '(1) The invoice is 1,300.00; (2) the contract says 1,250.00.' }))))
      .resolves.toEqual({ status: 'output_invalid' });
    await expect(run(provider(answer({ diagnosis: 'The invoice is 1,300.00; the contract says 1,250.00.' }))))
      .resolves.toMatchObject({ status: 'proposed' });
  });

  it('reads a UUID whole: one the context carried is supported, any other is invented', async () => {
    const carried = '3336d895-c66a-4a1a-a0b1-0123456789ab';
    const read = vi.fn(async () => ({
      status: 'ok' as const,
      resolutionCase: { caseId: 'finding:f1', kind: 'validator_finding', actions: FINDING_ACTIONS } as never,
      context: { caseId: 'finding:f1', caseKind: 'validator_finding', purpose: 'provider_investigation', omissions: [],
        transmittedDigest: 'd', readDigest: 'r',
        slices: [{ kind: 'validator_findings', contentClass: 'text_excerpts', transmitted: true,
          provenance: { source: 'project_validation_findings', documentId: 'doc', physicalPageNumber: 1,
            recordIds: [`finding:decision:${carried}`] },
          payload: [{ summary: 'Expected 1,250.00 found 1,300.00' }] }] } as never,
    }));
    const cite = { citations: ['A'] };
    await expect(run(provider(answer({ ...cite, diagnosis: `Decision ${carried} flags 1,300.00.` })), read))
      .resolves.toMatchObject({ status: 'proposed' });
    await expect(run(provider(answer({ ...cite, diagnosis: 'Decision 9136d895-c66a-4a1a-a0b1-0123456789ab flags it.' })), read))
      .resolves.toEqual({ status: 'output_invalid' });
    // An identifier never shelters a factual number written beside it.
    await expect(run(provider(answer({ ...cite, diagnosis: `Decision ${carried} expects 1,275.00.` })), read))
      .resolves.toEqual({ status: 'output_invalid' });
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
