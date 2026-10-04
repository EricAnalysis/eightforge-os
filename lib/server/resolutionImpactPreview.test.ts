import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbAccess = vi.hoisted(() => ({ calls: [] as string[] }));
// Any database access during a preview would land here. None may happen: the
// queue and the reads are injected, and nothing else may reach the database.
vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: () => new Proxy({}, { get: (_target, property) => {
    dbAccess.calls.push(String(property));
    throw new Error(`database touched: ${String(property)}`);
  } }),
}));

import type { HumanFactAssertionRow } from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { ResolutionAction, ResolutionCase, ResolutionQueue } from '@/lib/resolution/resolutionCases';
import { parseResolutionPreviewInput } from '@/lib/resolution/resolutionPreviewInput';
import { recordRegionBoundAssertion, type RegionAssertionClient } from '@/lib/server/regionBoundHumanAssertions';
import { previewResolutionImpact, type ValidatorRun } from '@/lib/server/resolutionImpactPreview';
import type { ValidatorSourceHypothesis, ValidatorSourceReads } from '@/lib/validator/projectValidator';
import type { ValidationFinding, ValidatorResult } from '@/types/validator';

const ORG = 'org-1';
const ACTOR = 'actor-1';
const PROJECT = 'project-1';
const DOC = 'doc-1';
const DIGEST = 'a'.repeat(64);

const TARGET = {
  anchorKey: 'p3:priced_line:abc', physicalPageNumber: 3, pageRepresentationDigest: DIGEST,
  unresolvedReason: 'header_not_found', rawText: 'Hauling $ 13', sourceObservationIds: ['o1', 'o2'],
  sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] }, visual: null,
};

const extractionData = { extraction: {
  content_layers_v1: { pdf: {
    page_extraction_coverage_v1: { pages: [{ page_number: 3, page_representation_digest: DIGEST }] },
    layout_observations_v1: { source_artifact_id: 'artifact-1', observations: [
      { id: 'o1', raw_text: 'Hauling', physical_page_number: 3 },
      { id: 'o2', raw_text: '$ 13', physical_page_number: 3 },
    ] },
    priced_schedule_reconstruction_v1: { parser_version: 'priced_schedule_reconstruction_v2', pages: [] },
  } },
} };

function baseCase(overrides: Partial<ResolutionCase>): ResolutionCase {
  return {
    caseId: 'unreadable:doc-1:p3', kind: 'unreadable_priced_line', tier: 'missing_authoritative_value', exposureAmount: null,
    projectId: PROJECT, documentId: DOC, physicalPageNumber: 3, title: 't', problem: 'p', finding: null, previousReviews: [],
    deterministicState: 'd', originalSourceText: 'Hauling $ 13', rootCauseKey: `unresolved_page:${DOC}:3`, evidence: [],
    suggestions: [], actions: [], sourceRefs: { anchorKey: TARGET.anchorKey }, ...overrides,
  };
}

const enterAction: ResolutionAction = {
  kind: 'enter_reviewed_value', method: 'POST', endpoint: `/api/documents/${DOC}/facts/region-assertions`,
  factKey: 'contract_rate_row', target: TARGET, supersedesAssertionId: null,
};

function finding(checkKey: string, overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    id: checkKey, run_id: 'r', project_id: PROJECT, rule_id: checkKey.split(':')[0]!, check_key: checkKey,
    category: 'financial_integrity', severity: 'critical', status: 'open', subject_type: 'invoice_line',
    subject_id: 'line-1', field: 'unit_price', expected: '12.75', actual: '13', variance: null, variance_unit: null,
    blocked_reason: 'blocks', decision_eligible: true, action_eligible: true, linked_decision_id: null,
    linked_action_id: null, resolved_by_user_id: null, resolved_at: null, created_at: '', updated_at: '', ...overrides,
  } as ValidationFinding;
}

function runOf(findings: ValidationFinding[]): ValidatorRun {
  return {
    input: { invoiceLines: [], factLookups: { rateScheduleItems: [] }, invoiceLineToRateMap: new Map() } as never,
    result: { status: 'BLOCKED', blocked_reasons: [], findings, summary: {} as ValidatorResult['summary'], rulesApplied: [],
      validator_status: 'BLOCKED' as ValidatorResult['validator_status'], validator_open_items: [], validator_blockers: [],
      exposure: null },
  };
}

/** A stand-in Validator: an applied candidate rate of 13 clears the unit-price finding and opens none. */
function fakeValidate(calls: (ValidatorSourceHypothesis | undefined)[]) {
  return (_reads: ValidatorSourceReads, hypothesis?: ValidatorSourceHypothesis): ValidatorRun => {
    calls.push(hypothesis);
    const row = hypothesis?.additionalRegionAssertionRows?.[0];
    const rate = (row?.asserted_value as { rate_amount?: number } | null)?.rate_amount;
    if (row?.status === 'withdrawn') return runOf([finding('UNIT_PRICE:line-1'), finding('PRICING_ROW_MISSING:line-1')]);
    return runOf(rate === 13 ? [] : [finding('UNIT_PRICE:line-1')]);
  };
}

function reads(rows: HumanFactAssertionRow[] = []): ValidatorSourceReads {
  return {
    legacyRowsByDocumentId: new Map([[DOC, { document_id: DOC, data: extractionData }]]),
    regionAssertionRows: rows,
    invoiceLineRateLinkRows: [],
  } as unknown as ValidatorSourceReads;
}

function queueOf(cases: ResolutionCase[], forgewing = false): ResolutionQueue {
  return { modelVersion: 'resolution_case_v1', projectId: PROJECT, cases, groups: [],
    countsByTier: {} as ResolutionQueue['countsByTier'], forgewingSuggestionsIncluded: forgewing };
}

const enterInput = { kind: 'enter_reviewed_value' as const,
  value: { description: 'Hauling', unitType: 'TON', rate: '13', category: '' }, reason: '' };

async function preview(params: {
  cases: ResolutionCase[];
  input?: Parameters<typeof previewResolutionImpact>[0]['input'];
  caseId?: string;
  rows?: HumanFactAssertionRow[];
  forgewingEnabled?: boolean;
  validate?: ReturnType<typeof fakeValidate>;
  cleared?: [string, never[]][];
}) {
  const calls: (ValidatorSourceHypothesis | undefined)[] = [];
  const result = await previewResolutionImpact(
    { organizationId: ORG, actorId: ACTOR, projectId: PROJECT, caseId: params.caseId ?? params.cases[0]!.caseId,
      input: params.input ?? enterInput },
    {
      readQueue: async () => ({ status: 'ok', queue: queueOf(params.cases, params.forgewingEnabled) }),
      loadReads: async () => reads(params.rows),
      validate: params.validate ?? fakeValidate(calls),
      loadClearedHistory: async () => new Map(params.cleared ?? []),
      forgewingEnabled: params.forgewingEnabled ?? false,
    },
  );
  return { result, calls };
}

beforeEach(() => { dbAccess.calls = []; });

describe('resolution impact preview (B5-C)', () => {
  it('performs no writes and touches no database beyond the injected reads', async () => {
    const { result } = await preview({ cases: [baseCase({ actions: [enterAction] })] });
    expect(result.status).toBe('ok');
    expect(dbAccess.calls).toEqual([]);
  });

  it('produces a byte-identical impact for the same input', async () => {
    const first = await preview({ cases: [baseCase({ actions: [enterAction] })] });
    const second = await preview({ cases: [baseCase({ actions: [enterAction] })] });
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result));
  });

  it('simulates exactly the row the write path would record', async () => {
    const { calls, result } = await preview({ cases: [baseCase({ actions: [enterAction] })] });
    expect(result.status === 'ok' && result.impact).toMatchObject({
      status: 'available', resolvesFindingIds: ['UNIT_PRICE:line-1'], opensFindingIds: [], blockersBefore: 1, blockersAfter: 0,
    });
    // before, after, before again (the contamination check)
    expect(calls).toEqual([undefined, expect.anything(), undefined]);
    const row = calls[1]!.additionalRegionAssertionRows![0]!;
    // Capture what the record path sends to the record function for the same decision.
    const rpc = vi.fn(async () => ({ data: [{ assertion_id: 'x', inserted: true }], error: null }));
    await recordRegionBoundAssertion({ rpc, from: vi.fn() } as unknown as RegionAssertionClient, {
      organizationId: ORG, actorId: ACTOR, sourceDocumentId: DOC, factKey: 'contract_rate_row',
      assertedValue: { description: 'Hauling', unit_type: 'TON', rate_amount: 13 }, status: 'active',
      reason: 'Impact preview (not recorded)', sourceArtifactId: 'artifact-1', physicalPageNumber: 3,
      sourceRegion: TARGET.sourceRegion, pageRepresentationDigest: DIGEST, parserVersion: 'priced_schedule_reconstruction_v2',
      sourceObservationIds: ['o1', 'o2'], originalSourceText: 'Hauling $ 13', anchorKey: TARGET.anchorKey,
      supersedesAssertionId: null, idempotencyKey: 'k',
    });
    const args = (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect({
      organization_id: row.organization_id, actor_id: row.actor_id, source_document_id: row.source_document_id,
      fact_key: row.fact_key, asserted_value: row.asserted_value, status: row.status,
      source_artifact_id: row.source_artifact_id, physical_page_number: row.physical_page_number,
      source_region: row.source_region, page_representation_digest: row.page_representation_digest,
      parser_version: row.parser_version, source_observation_ids: row.source_observation_ids,
      original_source_text: row.original_source_text, anchor_key: row.anchor_key, review_origin: row.review_origin,
      forgewing_proposal_id: row.forgewing_proposal_id, supersedes_assertion_id: row.supersedes_assertion_id,
    }).toEqual({
      organization_id: args.p_organization_id, actor_id: args.p_actor_id, source_document_id: args.p_source_document_id,
      fact_key: args.p_fact_key, asserted_value: args.p_asserted_value, status: args.p_status,
      source_artifact_id: args.p_source_artifact_id, physical_page_number: args.p_physical_page_number,
      source_region: args.p_source_region, page_representation_digest: args.p_page_representation_digest,
      parser_version: args.p_parser_version, source_observation_ids: args.p_source_observation_ids,
      original_source_text: args.p_original_source_text, anchor_key: args.p_anchor_key, review_origin: args.p_review_origin,
      forgewing_proposal_id: args.p_forgewing_proposal_id, supersedes_assertion_id: args.p_supersedes_assertion_id,
    });
    expect(row.source_binding).toBe('region_bound');
  });

  it('says unsupported for actions it cannot reproduce, without reading or validating', async () => {
    const loadReads = vi.fn();
    for (const [kind, action] of [
      ['review_recovery_proposal', { kind: 'review_recovery_proposal', method: 'POST', endpoint: '/api/internal/forgewing-recovery-review',
        proposalId: 'p', proposalDigestSha256: 'd', proposalVersion: 1, dispositions: ['accepted'], selectableConfirmations: [],
        sourceEvidenceUnbound: false }],
      ['resolve_execution_item', { kind: 'resolve_execution_item', method: 'PATCH', endpoint: '/x', outcomes: ['approve'] }],
    ] as const) {
      const result = await previewResolutionImpact(
        { organizationId: ORG, actorId: ACTOR, projectId: PROJECT, caseId: 'c', input: { kind } },
        { readQueue: async () => ({ status: 'ok', queue: queueOf([baseCase({ caseId: 'c', actions: [action as ResolutionAction] })]) }),
          loadReads },
      );
      expect(result.status === 'ok' && result.impact).toMatchObject({ status: 'unsupported', actionKind: kind });
      expect(result.status === 'ok' && result.impact.status !== 'available' && result.impact.reason.length).toBeGreaterThan(20);
    }
    expect(loadReads).not.toHaveBeenCalled();
  });

  it('reports a finding the action would open', async () => {
    const withdraw: ResolutionAction = { kind: 'withdraw_reviewed_value', method: 'POST', endpoint: enterAction.endpoint,
      anchorKey: TARGET.anchorKey, supersedesAssertionId: 'head-1', target: TARGET };
    const head = { id: 'head-1', organization_id: ORG, source_document_id: DOC, fact_key: 'contract_rate_row',
      source_binding: 'region_bound', anchor_key: TARGET.anchorKey, supersedes_assertion_id: null } as HumanFactAssertionRow;
    const { result } = await preview({ cases: [baseCase({ actions: [withdraw] })], rows: [head],
      input: { kind: 'withdraw_reviewed_value', reason: '' } });
    expect(result.status === 'ok' && result.impact).toMatchObject({
      status: 'available', opensFindingIds: ['PRICING_ROW_MISSING:line-1'], blockersBefore: 1, blockersAfter: 2,
    });
  });

  it('previews what persistence will show: a recurrence of a cleared finding stays closed', async () => {
    const withdraw: ResolutionAction = { kind: 'withdraw_reviewed_value', method: 'POST', endpoint: enterAction.endpoint,
      anchorKey: TARGET.anchorKey, supersedesAssertionId: 'head-1', target: TARGET };
    const head = { id: 'head-1', organization_id: ORG, source_document_id: DOC, fact_key: 'contract_rate_row',
      source_binding: 'region_bound', anchor_key: TARGET.anchorKey, supersedes_assertion_id: null } as HumanFactAssertionRow;
    const recurring = finding('PRICING_ROW_MISSING:line-1');
    const cleared = [[recurring.check_key, [{ ...recurring, id: 'cleared-1', status: 'resolved', resolved_at: 'x',
      evidenceSignature: '[]' }]]] as unknown as [string, never[]][];
    const { result } = await preview({ cases: [baseCase({ actions: [withdraw] })], rows: [head],
      input: { kind: 'withdraw_reviewed_value', reason: '' }, cleared });
    expect(result.status === 'ok' && result.impact).toMatchObject({ status: 'available', opensFindingIds: [], blockersAfter: 1 });
  });

  it('refuses to preview what the write path would refuse', async () => {
    // Someone superseded the head meanwhile: the record function would raise 40001.
    const other = { id: 'other', organization_id: ORG, source_document_id: DOC, fact_key: 'contract_rate_row',
      source_binding: 'region_bound', anchor_key: TARGET.anchorKey, supersedes_assertion_id: null } as HumanFactAssertionRow;
    const stale = await preview({ cases: [baseCase({ actions: [enterAction] })], rows: [other] });
    expect(stale.result.status === 'ok' && stale.result.impact).toMatchObject({ status: 'unavailable', code: 'stale_chain_head' });
    // The page was re-extracted since the case was read.
    const moved = await preview({ cases: [baseCase({ actions: [{ ...enterAction, target: { ...TARGET, pageRepresentationDigest: 'b'.repeat(64) } }] })] });
    expect(moved.result.status === 'ok' && moved.result.impact).toMatchObject({ status: 'unavailable', code: 'page_representation_not_current' });
    // The case is not offered that action.
    const notOffered = await preview({ cases: [baseCase({ actions: [] })] });
    expect(notOffered.result.status === 'ok' && notOffered.result.impact).toMatchObject({ status: 'unavailable', code: 'action_not_offered' });
  });

  it('reports nothing when the unchanged snapshot does not validate identically twice', async () => {
    let call = 0;
    const flaky = () => runOf(call++ === 2 ? [] : [finding('UNIT_PRICE:line-1')]);
    const { result } = await preview({ cases: [baseCase({ actions: [enterAction] })], validate: flaky });
    expect(result.status === 'ok' && result.impact).toMatchObject({ status: 'unavailable', code: 'preview_nondeterministic' });
  });

  it('accepts no impact from the client: only the decision fields survive', () => {
    const parsed = parseResolutionPreviewInput({
      ...enterInput, impact: { resolvesFindingIds: ['X'] }, resolvesFindingIds: ['X'], blockersAfter: 0,
      suggestion: '$999', proposedValue: '$999', anchorKey: 'invented', supersedesAssertionId: 'invented',
    });
    expect(parsed).toEqual(enterInput);
    expect(parseResolutionPreviewInput({ kind: 'approve' })).toBeNull();
  });

  it('is unaffected by Forgewing text, and identical for Core and Core + Forgewing', async () => {
    const suggestion = { source: 'forgewing_recovery_proposal' as const, proposedValue: '$999', uncalibratedCertainty: 0.99, proposalId: 'p' };
    const core = await preview({ cases: [baseCase({ actions: [enterAction] })], forgewingEnabled: false });
    const withSuggestion = await preview({ cases: [baseCase({ actions: [enterAction], suggestions: [suggestion] })], forgewingEnabled: true });
    expect(JSON.stringify(withSuggestion.result)).toBe(JSON.stringify(core.result));
    expect(JSON.stringify(withSuggestion.calls)).toBe(JSON.stringify(core.calls));
    expect(JSON.stringify(withSuggestion.calls)).not.toContain('$999');
  });

  it('simulates a manual rate link the way the link path records it: the line\'s active link replaced', async () => {
    const INVOICE = 'invoice-1';
    const link: ResolutionAction = { kind: 'link_invoice_line_rate', method: 'POST',
      endpoint: `/api/projects/${PROJECT}/invoice-line-rate-link`, findingId: 'f1', invoiceLineSubjectId: 'line-1' };
    const beforeInput = {
      invoiceLines: [{ id: 'line-1', source_document_id: INVOICE, description: 'Hauling' }],
      factLookups: { rateScheduleItems: [
        { source_document_id: DOC, record_id: 'rate-7', rate_code: null, description: 'Hauling', unit_type: 'TON', rate_amount: 13 },
      ] },
      invoiceLineToRateMap: new Map(),
    };
    const existing = { id: 'old-link', organization_id: ORG, project_id: PROJECT, invoice_document_id: INVOICE,
      invoice_line_subject_id: 'line-1', contract_document_id: DOC, contract_rate_row_id: 'rate-1', rate_row_description: null,
      rate_row_unit_type: null, rate_row_rate_amount: null, reason: null, created_at: null, is_active: true, superseded_by: null };
    const other = { ...existing, id: 'other-line-link', invoice_line_subject_id: 'line-2' };
    const calls: (ValidatorSourceHypothesis | undefined)[] = [];
    const run = (input: unknown) => (_reads: ValidatorSourceReads, hypothesis?: ValidatorSourceHypothesis): ValidatorRun => {
      calls.push(hypothesis);
      return { ...runOf(hypothesis ? [] : [finding('RATE_CODE_MISSING:line-1')]), input: input as never };
    };
    const go = (contractRateRowId: string) => previewResolutionImpact(
      { organizationId: ORG, actorId: ACTOR, projectId: PROJECT, caseId: 'finding:f1',
        input: { kind: 'link_invoice_line_rate', contractDocumentId: DOC, contractRateRowId } },
      { readQueue: async () => ({ status: 'ok', queue: queueOf([baseCase({ caseId: 'finding:f1', kind: 'validator_finding', actions: [link] })]) }),
        loadReads: async () => ({ ...reads(), invoiceLineRateLinkRows: [existing, other] } as unknown as ValidatorSourceReads),
        validate: run(beforeInput), loadClearedHistory: async () => new Map() },
    );
    const result = await go('rate-7');
    expect(result.status === 'ok' && result.impact).toMatchObject({ status: 'available', resolvesFindingIds: ['RATE_CODE_MISSING:line-1'] });
    expect(calls[1]!.invoiceLineRateLinkRows).toEqual([
      expect.objectContaining({ invoice_document_id: INVOICE, invoice_line_subject_id: 'line-1', contract_document_id: DOC,
        contract_rate_row_id: 'rate-7', rate_row_description: 'Hauling', rate_row_unit_type: 'TON', rate_row_rate_amount: 13,
        is_active: true }),
      other,
    ]);
    // Only the options the link route accepts can be previewed.
    const refused = await go('invented-row');
    expect(refused.status === 'ok' && refused.impact).toMatchObject({ status: 'unavailable', code: 'option_not_offered' });
  });
});
