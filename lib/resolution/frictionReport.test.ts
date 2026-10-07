import { describe, expect, it } from 'vitest';

import { buildFrictionReport, frictionReason, orchestratorPrefillHref } from '@/lib/resolution/frictionReport';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';

/** Forgewing friction report (generalization, phase 5). Synthetic records only. */

const ORG = 'org-1';

function resolutionCase(kind: ResolutionCase['kind'], documentId: string, code?: string, text = 'Hauling TON $8.7S'): ResolutionCase {
  return {
    caseId: `${kind}:${documentId}:${code ?? ''}`, kind, tier: 'missing_authoritative_value', exposureAmount: null,
    projectId: 'p', documentId, physicalPageNumber: 2, title: 't', problem: 'p', finding: null, previousReviews: [],
    deterministicState: 'd', originalSourceText: text, rootCauseKey: 'r', evidence: [], suggestions: [], actions: [],
    sourceRefs: {},
    ...(code ? { diagnostic: { code: code as never, attention: 'resolution_case', recoverability: 'not_recoverable', recoveryType: null } } : {}),
  };
}

function assertion(id: string, documentId: string, overrides: Record<string, unknown> = {}) {
  return { id, organization_id: ORG, source_document_id: documentId, fact_key: 'contract_rate_row', asserted_value: {},
    source_binding: 'region_bound', supersedes_assertion_id: null, actor_id: 'op', reason: 'r', asserted_at: 't',
    status: 'active', source_artifact_id: null, physical_page_number: 2, source_region: null, page_representation_digest: null,
    parser_version: null, source_observation_ids: [], original_source_text: 'Hauling TON $8.7S', anchor_key: 'a',
    review_origin: 'operator_entered', forgewing_proposal_id: null, ...overrides } as never;
}

const types = new Map([['d1', 'contract'], ['d2', 'contract'], ['d3', 'invoice']]);

describe('buildFrictionReport', () => {
  it('aggregates open cases by kind, reason and document type', () => {
    const report = buildFrictionReport({ organizationId: ORG, documentTypeById: types, assertions: [], telemetry: [], outcomes: [],
      projects: [{ projectId: 'p1', cases: [resolutionCase('withheld_priced_line', 'd1', 'inconsistent_row_pitch'),
        resolutionCase('review_required_value', 'd1')] },
      { projectId: 'p2', cases: [resolutionCase('withheld_priced_line', 'd2', 'inconsistent_row_pitch')] }] });
    expect(report.openCases).toBe(3);
    expect(report.byReason).toEqual([
      { key: 'inconsistent_row_pitch', cases: 2, documents: 2, projects: 2 },
      { key: 'scanned_rate_requires_review', cases: 1, documents: 1, projects: 1 },
    ]);
    expect(report.byDocumentType).toEqual([{ key: 'contract', cases: 3, documents: 2, projects: 2 }]);
  });

  it('raises a recurring signal only across documents, prefilled for the Orchestrator with codes and ids, never document text', () => {
    const report = buildFrictionReport({ organizationId: ORG, documentTypeById: types, assertions: [], telemetry: [], outcomes: [],
      projects: [{ projectId: 'p1', cases: [resolutionCase('withheld_priced_line', 'd1', 'inconsistent_row_pitch'),
        resolutionCase('withheld_priced_line', 'd1', 'inconsistent_row_pitch'), resolutionCase('withheld_priced_line', 'd2', 'inconsistent_row_pitch'),
        resolutionCase('review_required_value', 'd1'), resolutionCase('review_required_value', 'd1')] }] });
    expect(report.signals.map((signal) => signal.signalId)).toEqual(['recurring_deterministic_failure:inconsistent_row_pitch']);
    const prefill = report.signals[0]!.orchestratorPrefill!;
    expect(prefill.rootCauseCategory).toBe('extraction_issue');
    expect(prefill.question).not.toContain('Hauling');
    expect(prefill.evidenceLinks).not.toContain('Hauling');
    expect(orchestratorPrefillHref(prefill)).toMatch(/^\/internal\/orchestrator\?question=.*rootCauseCategory=extraction_issue/u);
  });

  it('counts only real operator decisions, from this organization', () => {
    const report = buildFrictionReport({ organizationId: ORG, documentTypeById: types, telemetry: [], outcomes: [],
      projects: [{ projectId: 'p1', cases: [resolutionCase('validator_finding', 'd1'), resolutionCase('validator_finding', 'd2')] }],
      assertions: [assertion('a1', 'd1'), assertion('a2', 'd2'), assertion('a3', 'd2', { status: 'withdrawn' }),
        assertion('a4', 'd1', { organization_id: 'other' }), assertion('a5', 'd1', { review_origin: 'ai_proposed_operator_approved' }),
        assertion('a6', 'd2', { fact_key: 'priced_evidence_disposition' })] });
    expect(report.humanReview).toMatchObject({ reviewedValues: 3, dispositions: 1,
      byDocumentType: [{ key: 'contract', cases: 2, documents: 2, projects: 1 }] });
    expect(report.signals.find((signal) => signal.kind === 'recurring_manual_correction')).toMatchObject({
      key: 'contract', occurrences: 2, orchestratorPrefill: { rootCauseCategory: 'extraction_issue' } });
  });

  it('reports Forgewing use, rejection and blocked demand, and treats blocked demand as a qualification decision', () => {
    const event = (outcome: string, documentId: string) => ({ outcome, documentId, anchorKey: 'a', at: 't', assertionId: null,
      proposalId: `prop-${documentId}`, reviewId: null }) as never;
    const report = buildFrictionReport({ organizationId: ORG, documentTypeById: types, assertions: [], projects: [],
      telemetry: [event('forgewing_used_unchanged', 'd1'), event('forgewing_used_then_edited', 'd1'),
        event('forgewing_rejected', 'd1'), event('forgewing_rejected', 'd2'), event('suggestion_ignored', 'd2')],
      outcomes: [{ outcomeCode: 'activation_not_allowed', documentId: 'd1' }, { outcomeCode: 'budget_exhausted', documentId: 'd1' },
        { outcomeCode: 'unreadable', documentId: 'd2' }, { outcomeCode: 'provider_failed', documentId: 'd2' }] });
    expect(report.forgewing).toEqual({ usedUnchanged: 1, usedEdited: 1, rejected: 2, ignored: 1, enteredWithoutSuggestion: 0,
      unreadable: 1, policyBlocked: 1, budgetBlocked: 1, failed: 1 });
    expect(report.signals.find((signal) => signal.kind === 'qualification_demand')!.orchestratorPrefill).toBeNull();
    expect(report.signals.find((signal) => signal.kind === 'forgewing_rejected')!.orchestratorPrefill!.evidenceLinks)
      .toContain('forgewing_proposal:prop-d1');
  });

  it('names a reason for every case kind', () => {
    expect(frictionReason(resolutionCase('unreadable_priced_line', 'd1'))).toBe('priced_line_on_unread_page');
    expect(frictionReason({ ...resolutionCase('validator_finding', 'd1'), finding: { ruleId: 'R7' } as never })).toBe('validator_rule:R7');
  });
});
