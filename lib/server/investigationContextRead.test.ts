import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { readInvestigationContext } from '@/lib/server/investigationContextRead';

const DOC = 'doc-1';
const resolutionCase = {
  caseId: 'review_required:doc-1:p2:priced_line:x', kind: 'review_required_value', tier: 'missing_authoritative_value',
  exposureAmount: null, projectId: 'p', documentId: DOC, physicalPageNumber: 2, title: 't', problem: 'p', finding: null,
  previousReviews: [], deterministicState: 'd', originalSourceText: 'Haul $8.7S', rootCauseKey: 'r',
  evidence: [{ documentId: DOC, physicalPageNumber: 2, observationIds: [], role: 'current', label: 'l', visual: null, detail: null, region: null }],
  suggestions: [], actions: [], sourceRefs: { anchorKey: 'p2:priced_line:x' },
};
const finding = { ...resolutionCase, caseId: 'finding:1', kind: 'validator_finding', problem: 'Rate mismatch',
  finding: { checkKey: 'chk-1', ruleId: 'R1', severity: 'warning', field: null, expected: null, actual: null, recommendedAction: '' } };

function deps(overrides: Record<string, unknown> = {}) {
  return {
    admin: {} as never,
    readQueue: vi.fn(async () => ({ status: 'ok' as const, queue: { cases: [resolutionCase, finding] } as never,
      sources: { extractionDataByDocument: new Map([[DOC, null]]), reviewedValuesByDocument: new Map([[DOC,
        { history: [], effective: [], held: [{ anchorKey: 'p2:priced_line:x', factKey: 'contract_rate_row',
          reason: 'page_representation_changed', assertionIds: ['a1'], documentId: DOC }], entryTargets: [] }]]) } as never })),
    loadPrecedence: vi.fn(async () => ({ documents: [], families: [], relationships: [
      { id: 'rel-1', project_id: 'p', source_document_id: 'amendment-1', target_document_id: DOC, relationship_type: 'amends' }] })),
    resolveDataPolicy: vi.fn(async (_admin: unknown, params: { contentClasses: readonly string[] }) =>
      params.contentClasses[0] === 'text_excerpts'
        ? { approved: true as const, eventIds: ['dp'] }
        : { approved: false as const, reason: 'not_approved' as const, contentClass: 'page_region_images' as const }),
    ...overrides,
  };
}

describe('readInvestigationContext', () => {
  it('composes the case from the queue read, its reviewed state and its findings, without transmitting for the operator', async () => {
    const d = deps();
    const result = await readInvestigationContext({ organizationId: 'org', projectId: 'p', caseId: resolutionCase.caseId,
      purpose: 'operator_review' }, d);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.context.slices.map((slice) => slice.kind)).toEqual(
      ['case_evidence', 'source_text', 'human_reviewed_values', 'validator_findings']);
    expect(result.context.slices.find((slice) => slice.kind === 'human_reviewed_values')!.provenance.recordIds).toEqual(['a1']);
    expect(d.resolveDataPolicy).not.toHaveBeenCalled();
  });

  it('asks the data-policy ledger class by class for a provider purpose', async () => {
    const d = deps();
    const result = await readInvestigationContext({ organizationId: 'org', projectId: 'p', caseId: finding.caseId,
      purpose: 'provider_investigation' }, d);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(d.resolveDataPolicy).toHaveBeenCalledTimes(2);
    const relationships = result.context.slices.find((slice) => slice.kind === 'document_relationships')!;
    expect(relationships).toMatchObject({ transmitted: true, provenance: { source: 'document_precedence', recordIds: ['rel-1'] } });
  });

  it('returns not_found for a case the queue does not list', async () => {
    await expect(readInvestigationContext({ organizationId: 'org', projectId: 'p', caseId: 'nope', purpose: 'operator_review' }, deps()))
      .resolves.toEqual({ status: 'not_found' });
  });
});
