import { describe, expect, it } from 'vitest';

import type { HumanFactAssertionRow, RegionAssertionEntryTarget } from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  RESOLUTION_TIER_ORDER,
  buildResolutionQueue,
  type DocumentReviewedValueState,
  type PendingRecoveryProposal,
} from '@/lib/resolution/resolutionCases';
import { resolveProjectIssueObjects } from '@/lib/resolveProjectIssueObjects';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

const PROJECT = 'project-b5a';
const CONTRACT = 'contract-b5a';
const INVOICE = 'invoice-b5a';
const DIGEST = 'a'.repeat(64);

function finding(id: string, overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    id, run_id: 'run-1', project_id: PROJECT, rule_id: 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE',
    check_key: id, category: 'financial_integrity', severity: 'warning', status: 'open',
    subject_type: 'invoice_line', subject_id: `line:${id}`, field: 'unit_price', expected: '12.75', actual: '13',
    variance: 0.25, variance_unit: 'USD', blocked_reason: null, decision_eligible: true, action_eligible: true,
    linked_decision_id: null, linked_action_id: null, resolved_by_user_id: null, resolved_at: null,
    created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z',
    ...overrides,
  } as ValidationFinding;
}

function evidence(findingId: string, recordId: string, overrides: Partial<ValidationEvidence> = {}): ValidationEvidence {
  return {
    id: `ev:${findingId}:${recordId}`, finding_id: findingId, evidence_type: 'rate_schedule',
    source_document_id: CONTRACT, source_page: 8, fact_id: null, record_id: recordId, field_name: 'rate_amount',
    field_value: '12.75', note: 'Matched governing contract schedule line.', created_at: '2026-10-04T00:00:00Z',
    ...overrides,
  };
}

function target(anchor: string, page = 8, rawText = 'Debris removal CY 1 $ sia 50'): RegionAssertionEntryTarget {
  return {
    anchorKey: anchor, physicalPageNumber: page, pageRepresentationDigest: DIGEST, unresolvedReason: 'header_not_found',
    rawText, sourceObservationIds: [`${anchor}:o1`, `${anchor}:o2`],
    sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] },
  };
}

function assertion(id: string, anchor: string, overrides: Partial<HumanFactAssertionRow> = {}): HumanFactAssertionRow {
  return {
    id, organization_id: 'org', source_document_id: CONTRACT, fact_key: 'contract_rate_row',
    asserted_value: { description: 'Debris removal', unit_type: 'CY', rate_amount: 14.5 }, source_binding: 'region_bound',
    supersedes_assertion_id: null, actor_id: 'op', reason: 'r', asserted_at: `2026-10-04T00:00:0${id.length % 10}Z`,
    status: 'active', source_artifact_id: null, physical_page_number: 8,
    source_region: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] },
    page_representation_digest: DIGEST, parser_version: null, source_observation_ids: [`${anchor}:o1`],
    original_source_text: 'sia 50', anchor_key: anchor, review_origin: 'operator_entered', forgewing_proposal_id: null,
    ...overrides,
  };
}

const proposal: PendingRecoveryProposal = {
  proposalId: 'proposal-1', proposalDigestSha256: 'd'.repeat(64), recoveryType: 'pricing_rate_single_observation',
  physicalPageNumber: 9, sourceDocumentId: CONTRACT, recoveryReason: 'ambiguous_rate_clusters', proposedValue: '$8.75',
  certainty: 0.93, reviewState: 'pending_review', evidence: [{ observationId: 'p9:o1', rawText: '8.7S' }],
};

const DOCUMENTS = [{ id: CONTRACT, title: 'Contract' }, { id: INVOICE, title: 'Invoice' }];

function queue(params: {
  findings?: ValidationFinding[];
  evidence?: ValidationEvidence[];
  reviewed?: DocumentReviewedValueState;
  proposals?: PendingRecoveryProposal[];
  forgewingEnabled?: boolean;
  executionItems?: unknown[];
} = {}) {
  const findings = params.findings ?? [];
  const evidenceRows = params.evidence ?? [];
  return buildResolutionQueue({
    projectId: PROJECT,
    documents: DOCUMENTS,
    issues: resolveProjectIssueObjects({
      projectId: PROJECT, findings, evidence: evidenceRows, documents: DOCUMENTS,
      executionItems: (params.executionItems ?? []) as never,
    }),
    evidence: evidenceRows,
    reviewedValuesByDocument: new Map(params.reviewed ? [[CONTRACT, params.reviewed]] : []),
    recoveryProposals: params.proposals ?? [],
    forgewingEnabled: params.forgewingEnabled ?? false,
  });
}

const emptyReviewed = (overrides: Partial<DocumentReviewedValueState> = {}): DocumentReviewedValueState => ({
  history: [], effective: [], held: [], entryTargets: [], ...overrides,
});

describe('ResolutionCase read model (B5-A)', () => {
  it('ranks by impact tier, then dollars at stake, then a stable id — independent of input order', () => {
    const findings = [
      finding('info', { severity: 'info', category: 'identity_consistency', variance: null }),
      finding('pricing-small', { affected_amount: 10 } as Partial<ValidationFinding>),
      finding('pricing-large', { affected_amount: 900 } as Partial<ValidationFinding>),
      finding('sources', { category: 'required_sources', rule_id: 'SOURCES_NO_RATE_SCHEDULE' }),
      finding('blocker', { severity: 'critical', blocked_reason: 'Rate schedule missing' }),
    ];
    const reviewed = emptyReviewed({ entryTargets: [target('p8:a')] });
    const forward = queue({ findings, reviewed });
    const reversed = queue({ findings: [...findings].reverse(), reviewed });
    expect(forward.cases.map((entry) => entry.caseId)).toEqual(reversed.cases.map((entry) => entry.caseId));
    const tiers = forward.cases.map((entry) => entry.tier);
    expect(tiers).toEqual([...tiers].sort((left, right) =>
      RESOLUTION_TIER_ORDER.indexOf(left) - RESOLUTION_TIER_ORDER.indexOf(right)));
    expect(forward.cases[0]).toMatchObject({ caseId: 'finding:blocker', tier: 'blocks_approval' });
    const pricing = forward.cases.filter((entry) => entry.tier === 'affects_pricing').map((entry) => entry.caseId);
    expect(pricing.indexOf('finding:pricing-large')).toBeLessThan(pricing.indexOf('finding:pricing-small'));
    expect(forward.cases.find((entry) => entry.caseId === 'finding:sources')!.tier).toBe('missing_document_or_link');
    expect(forward.cases.at(-1)!.tier).toBe('informational');
    expect(forward.countsByTier.missing_authoritative_value).toBe(1);
  });

  it('opens an unreadable-line case with a typed reviewed-value action, and closes it once a value is effective', () => {
    const open = queue({ reviewed: emptyReviewed({ entryTargets: [target('p8:a')] }) });
    expect(open.cases).toHaveLength(1);
    expect(open.cases[0]).toMatchObject({
      kind: 'unreadable_priced_line', tier: 'missing_authoritative_value', documentId: CONTRACT,
      physicalPageNumber: 8, originalSourceText: 'Debris removal CY 1 $ sia 50',
    });
    expect(open.cases[0]!.actions[0]).toMatchObject({
      kind: 'enter_reviewed_value', method: 'POST', endpoint: `/api/documents/${CONTRACT}/facts/region-assertions`,
      factKey: 'contract_rate_row', target: { anchorKey: 'p8:a' }, supersedesAssertionId: null,
    });

    const effectiveRow = assertion('a1', 'p8:a');
    const closed = queue({ reviewed: emptyReviewed({
      entryTargets: [target('p8:a')], history: [effectiveRow],
      effective: [{ documentId: CONTRACT, factKey: 'contract_rate_row', anchorKey: 'p8:a', value: effectiveRow.asserted_value,
        provenance: {} as never }],
    }) });
    expect(closed.cases).toEqual([]);
  });

  it('after a withdrawal, re-entry supersedes the current chain head', () => {
    const first = assertion('a1', 'p8:a');
    const withdrawn = assertion('a2', 'p8:a', { status: 'withdrawn', asserted_value: null, supersedes_assertion_id: 'a1' });
    const result = queue({ reviewed: emptyReviewed({ entryTargets: [target('p8:a')], history: [first, withdrawn] }) });
    expect(result.cases[0]!.actions[0]).toMatchObject({ kind: 'enter_reviewed_value', supersedesAssertionId: 'a2' });
  });

  it('turns a held reviewed value into a re-review case that supersedes the head or withdraws it', () => {
    const held = assertion('a1', 'p8:a');
    const result = queue({ reviewed: emptyReviewed({
      entryTargets: [target('p8:a')], history: [held],
      held: [{ reason: 'page_representation_changed', documentId: CONTRACT, factKey: 'contract_rate_row',
        anchorKey: 'p8:a', assertionIds: ['a1'] }],
    }) });
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({
      kind: 'reviewed_value_needs_rereview', tier: 'missing_authoritative_value', originalSourceText: 'sia 50',
      sourceRefs: { assertionIds: ['a1'], anchorKey: 'p8:a' },
    });
    expect(result.cases[0]!.actions.map((action) => action.kind))
      .toEqual(['enter_reviewed_value', 'withdraw_reviewed_value', 'open_document']);
    expect(result.cases[0]!.actions[0]).toMatchObject({ supersedesAssertionId: 'a1' });
  });

  it('shows Forgewing recovery proposals only when Forgewing is enabled, as an uncalibrated suggestion', () => {
    expect(queue({ proposals: [proposal], forgewingEnabled: false }).cases).toEqual([]);
    const enabled = queue({ proposals: [proposal], forgewingEnabled: true });
    expect(enabled.forgewingSuggestionsIncluded).toBe(true);
    expect(enabled.cases[0]).toMatchObject({
      kind: 'recovery_proposal_pending', tier: 'affects_pricing', originalSourceText: '8.7S',
      suggestions: [{ source: 'forgewing_recovery_proposal', proposedValue: '$8.75', uncalibratedCertainty: 0.93 }],
    });
    expect(enabled.cases[0]!.actions[0]).toMatchObject({
      kind: 'review_recovery_proposal', endpoint: '/api/internal/forgewing-recovery-review',
      proposalId: 'proposal-1', proposalDigestSha256: 'd'.repeat(64),
    });
    // A suggestion is never an action input: no action carries the proposed value.
    expect(JSON.stringify(enabled.cases[0]!.actions)).not.toContain('$8.75');
    expect(queue({ proposals: [{ ...proposal, reviewState: 'rejected' }], forgewingEnabled: true }).cases).toEqual([]);
  });

  it('types finding actions by the write path that already handles them', () => {
    const result = queue({ findings: [
      finding('missing-code', { rule_id: 'FINANCIAL_RATE_CODE_MISSING' }),
      finding('plain'),
    ] });
    const byId = new Map(result.cases.map((entry) => [entry.caseId, entry]));
    expect(byId.get('finding:missing-code')!.actions[0]).toMatchObject({
      kind: 'link_invoice_line_rate', endpoint: `/api/projects/${PROJECT}/invoice-line-rate-link`, findingId: 'missing-code',
    });
    expect(byId.get('finding:plain')!.actions.map((action) => action.kind)).toEqual(['open_in_validator']);
  });

  it('names the execution outcome route with the method it accepts', () => {
    const result = queue({
      findings: [finding('executing', { linked_action_id: 'exec-1' })],
      executionItems: [{ id: 'exec-1', project_id: PROJECT, status: 'open', finding_id: 'executing',
        updated_at: '2026-10-04T00:00:00Z', created_at: '2026-10-04T00:00:00Z' }],
    });
    const action = result.cases[0]!.actions.find((entry) => entry.kind === 'resolve_execution_item');
    expect(action).toMatchObject({ method: 'PATCH', endpoint: '/api/execution-items/exec-1/outcome' });
  });

  it('excludes findings that are not open', () => {
    expect(queue({ findings: [finding('done', { status: 'resolved' })] }).cases).toEqual([]);
  });

  it('groups by source-bound root cause: one unresolved page, one cited rate row', () => {
    const result = queue({
      findings: [finding('f1', { affected_amount: 100 } as Partial<ValidationFinding>), finding('f2', { affected_amount: 50 } as Partial<ValidationFinding>), finding('f3')],
      evidence: [evidence('f1', 'human_fact_assertion:a9'), evidence('f2', 'human_fact_assertion:a9'), evidence('f3', 'rate-row-7')],
      reviewed: emptyReviewed({ entryTargets: [target('p8:a'), target('p8:b'), target('p9:c', 9)] }),
    });
    const groups = new Map(result.groups.map((group) => [group.rootCauseKey, group]));
    expect(groups.get(`unresolved_page:${CONTRACT}:8`)!.caseIds).toHaveLength(2);
    expect(groups.get(`unresolved_page:${CONTRACT}:9`)!.caseIds).toHaveLength(1);
    const rateGroup = groups.get(`rate_row:${CONTRACT}:human_fact_assertion:a9`)!;
    expect(rateGroup.caseIds).toEqual(['finding:f1', 'finding:f2']);
    expect(rateGroup.exposureAmount).toBe(150);
    expect(rateGroup.title).toContain('(+1 related)');
    expect(groups.get(`rate_row:${CONTRACT}:rate-row-7`)!.caseIds).toEqual(['finding:f3']);
    // Every case belongs to exactly one group.
    expect(result.groups.flatMap((group) => group.caseIds).sort())
      .toEqual(result.cases.map((entry) => entry.caseId).sort());
  });
});
