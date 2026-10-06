import { describe, expect, it } from 'vitest';

import { DIAGNOSTIC_CODES } from '@/lib/diagnostics/failureDiagnostic';
import { FAILURE_REGISTRY } from '@/lib/diagnostics/failureRegistry';
import {
  PRICED_EVIDENCE_DISPOSITION_FACT_KEY,
  parsePricedEvidenceDisposition,
  reviewedDocumentFieldAssertions,
  type EffectiveRegionAssertion,
  type HumanFactAssertionRow,
  type RegionAssertionEntryTarget,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import { buildResolutionActionRequest } from '@/lib/resolution/resolutionActionRequest';
import {
  CASE_KIND_BY_DIAGNOSTIC_CODE,
  buildResolutionQueue,
  type AttentionDiagnostic,
  type DocumentEvidenceAttention,
  type DocumentReviewedValueState,
  type PendingRecoveryProposal,
} from '@/lib/resolution/resolutionCases';
import { parseRegionAssertionRequest } from '@/lib/server/regionAssertionRequest';

/**
 * Evidence attention (Forgewing generalization, phase 1). Whether evidence
 * reaches a person is decided by the registry's attention, never by whether a
 * recovery mechanism exists for it. Synthetic records only.
 */

const PROJECT = 'project-attention';
const DOC = 'document-attention';
const DIGEST = 'a'.repeat(64);

function target(anchor: string, ids: readonly string[], page = 10, reason = 'insufficient_row_structure'): RegionAssertionEntryTarget {
  return {
    anchorKey: anchor, physicalPageNumber: page, pageRepresentationDigest: DIGEST, unresolvedReason: reason,
    rawText: 'Snow Removal ROW Unit $96.00', sourceObservationIds: ids,
    sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] },
    visual: null,
  };
}

function diagnostic(code: AttentionDiagnostic['code'], overrides: Partial<AttentionDiagnostic> = {}): AttentionDiagnostic {
  const registry = FAILURE_REGISTRY[code];
  return {
    diagnosticId: `${code}:${overrides.physicalPageNumber ?? 10}`.padEnd(64, '0').slice(0, 64),
    code, attention: registry.attention, recoverability: registry.recoverability, recoveryType: registry.recoveryType,
    severity: registry.severity, summary: registry.summary, physicalPageNumber: 10, observationIds: [], visual: null,
    recoveryProposalId: null, ...overrides,
  };
}

function assertionRow(id: string, anchor: string, factKey: string, overrides: Partial<HumanFactAssertionRow> = {}): HumanFactAssertionRow {
  return {
    id, organization_id: 'org', source_document_id: DOC, fact_key: factKey,
    asserted_value: factKey === PRICED_EVIDENCE_DISPOSITION_FACT_KEY ? { disposition: 'not_a_rate_or_value' }
      : { description: 'Snow removal', unit_type: 'Hour', rate_amount: 95 },
    source_binding: 'region_bound', supersedes_assertion_id: null, actor_id: 'op', reason: 'r',
    asserted_at: '2026-10-06T00:00:00Z', status: 'active', source_artifact_id: null, physical_page_number: 10,
    source_region: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] },
    page_representation_digest: DIGEST, parser_version: null, source_observation_ids: ['o1'],
    original_source_text: null, anchor_key: anchor, review_origin: 'operator_entered', forgewing_proposal_id: null,
    ...overrides,
  };
}

function build(params: {
  attention: DocumentEvidenceAttention;
  reviewed?: Partial<DocumentReviewedValueState>;
  proposals?: PendingRecoveryProposal[];
  forgewingEnabled?: boolean;
}) {
  return buildResolutionQueue({
    projectId: PROJECT,
    documents: [{ id: DOC, title: 'Golden contract' }],
    issues: [], evidence: [],
    reviewedValuesByDocument: new Map([[DOC, { history: [], effective: [], held: [], entryTargets: [], ...params.reviewed }]]),
    recoveryProposals: params.proposals ?? [],
    forgewingEnabled: params.forgewingEnabled ?? false,
    evidenceAttentionByDocument: new Map([[DOC, params.attention]]),
  });
}

describe('registry attention is separate from recoverability', () => {
  it('gives every code an attention, and every resolution-case code a case kind', () => {
    for (const code of DIAGNOSTIC_CODES) {
      expect(['resolution_case', 'diagnostics_panel']).toContain(FAILURE_REGISTRY[code].attention);
      if (FAILURE_REGISTRY[code].attention === 'resolution_case') expect(CASE_KIND_BY_DIAGNOSTIC_CODE[code], code).toBeDefined();
      else expect(CASE_KIND_BY_DIAGNOSTIC_CODE[code], code).toBeUndefined();
    }
  });

  it('keeps not_recoverable as not_recoverable while still demanding attention', () => {
    for (const code of ['insufficient_row_structure', 'outside_table_body', 'inconsistent_row_pitch'] as const) {
      expect(FAILURE_REGISTRY[code]).toMatchObject({ recoverability: 'not_recoverable', attention: 'resolution_case' });
    }
    // A recovery type that exists but is switched off does not decide visibility either.
    expect(FAILURE_REGISTRY.ambiguous_rate_clusters).toMatchObject({
      recoverability: 'recoverable_after_human_review', attention: 'resolution_case' });
    // Recovery machinery stays on the panel: its evidence is a case of its own.
    expect(FAILURE_REGISTRY.recovery_provider_failed.attention).toBe('diagnostics_panel');
  });
});

describe('withheld, structural, coverage and pricing-withheld evidence opens cases', () => {
  const ids = ['p10:o1', 'p10:o2'];
  const withheld = target('p10:priced_line:abc', ids);

  it('opens one case per attention diagnostic, with a stable identity and typed actions only', () => {
    const queue = build({ attention: {
      withheldTargets: [withheld],
      diagnostics: [
        diagnostic('insufficient_row_structure', { observationIds: [...ids].reverse() }),
        diagnostic('priced_header_semantics_unresolved', { physicalPageNumber: 9 }),
        diagnostic('page_ocr_abstained', { physicalPageNumber: 124 }),
        diagnostic('ruling_line_pricing_authority_withheld', { physicalPageNumber: 8 }),
        diagnostic('unsupported_trailing_line', { physicalPageNumber: 7 }),
        diagnostic('recovery_provider_failed', { physicalPageNumber: 7 }),
      ],
    } });
    expect(queue.cases.map((entry) => [entry.kind, entry.physicalPageNumber]).sort()).toEqual([
      ['coverage_gap', 124], ['pricing_withheld', 8], ['structure_review', 9], ['withheld_priced_line', 10],
    ].sort());
    const line = queue.cases.find((entry) => entry.kind === 'withheld_priced_line')!;
    expect(line.caseId).toBe(`withheld:${DOC}:p10:priced_line:abc`);
    expect(line.diagnostic).toEqual({ code: 'insufficient_row_structure', attention: 'resolution_case',
      recoverability: 'not_recoverable', recoveryType: null });
    expect(line.actions.map((action) => action.kind)).toEqual(['enter_reviewed_value', 'record_disposition', 'open_document']);
    // Non-value cases offer nothing but the document: no generic resolution action exists.
    for (const entry of queue.cases.filter((candidate) => candidate.kind !== 'withheld_priced_line')) {
      expect(entry.actions.map((action) => action.kind)).toEqual(['open_document']);
    }
  });

  it('closes a withheld case on an effective reviewed value or disposition for its anchor, and reopens on withdrawal', () => {
    const attention = { withheldTargets: [withheld], diagnostics: [diagnostic('insufficient_row_structure', { observationIds: ids })] };
    const effective = (factKey: string) => [{ anchorKey: withheld.anchorKey, factKey } as unknown as EffectiveRegionAssertion];
    expect(build({ attention, reviewed: { effective: effective('contract_rate_row') } }).cases).toEqual([]);
    expect(build({ attention, reviewed: { effective: effective(PRICED_EVIDENCE_DISPOSITION_FACT_KEY) } }).cases).toEqual([]);
    expect(build({ attention }).cases).toHaveLength(1);
  });

  it('keeps each fact key on its own chain when offering supersession', () => {
    const history = [assertionRow('rate-head', withheld.anchorKey, 'contract_rate_row'),
      assertionRow('disp-head', withheld.anchorKey, PRICED_EVIDENCE_DISPOSITION_FACT_KEY, { status: 'withdrawn' })];
    const line = build({ attention: { withheldTargets: [withheld],
      diagnostics: [diagnostic('insufficient_row_structure', { observationIds: ids })] }, reviewed: { history } }).cases[0]!;
    const enter = line.actions.find((action) => action.kind === 'enter_reviewed_value')!;
    const dispose = line.actions.find((action) => action.kind === 'record_disposition')!;
    expect(enter.kind === 'enter_reviewed_value' && enter.supersedesAssertionId).toBe('rate-head');
    expect(dispose.kind === 'record_disposition' && dispose.supersedesAssertionId).toBe('disp-head');
  });

  it('does not list a withheld line twice when a pending recovery proposal already is its case', () => {
    const proposal = { proposalId: 'proposal-1', reviewState: 'pending_review', sourceDocumentId: DOC, physicalPageNumber: 10,
      proposalDigestSha256: 'd'.repeat(64), recoveryType: 'priced_schedule_continuation_attribution',
      recoveryReason: 'ambiguous_row_continuation', proposedValue: 'x', certainty: 0.5, evidence: [], proposalVersion: 2,
      selectableConfirmations: [], sourceEvidenceUnbound: false } as PendingRecoveryProposal;
    const queue = build({ forgewingEnabled: true, proposals: [proposal], attention: { withheldTargets: [withheld],
      diagnostics: [diagnostic('ambiguous_row_continuation', { observationIds: ids, recoveryProposalId: 'proposal-1' })] } });
    expect(queue.cases.map((entry) => entry.kind)).toEqual(['recovery_proposal_pending']);
  });

  it('still opens a case for withheld evidence that cannot bind to observations', () => {
    const queue = build({ attention: { withheldTargets: [], diagnostics: [diagnostic('insufficient_priced_rows')] } });
    expect(queue.cases).toMatchObject([{ kind: 'withheld_priced_line', actions: [{ kind: 'open_document' }] }]);
  });
});

describe('the typed disposition', () => {
  it('builds exactly the region-assertion request the case names', () => {
    const queue = build({ attention: { withheldTargets: [target('p10:priced_line:abc', ['o1'])],
      diagnostics: [diagnostic('unpriced_row', { observationIds: ['o1'] })] } });
    const request = buildResolutionActionRequest(queue.cases[0]!, { kind: 'record_disposition', reason: 'Section heading', idempotencyKey: 'k1' });
    expect(request).toMatchObject({ ok: true, request: { method: 'POST',
      url: `/api/documents/${DOC}/facts/region-assertions`,
      body: { factKey: 'priced_evidence_disposition', status: 'active', value: { disposition: 'not_a_rate_or_value' },
        anchorKey: 'p10:priced_line:abc', sourceObservationIds: ['o1'], reason: 'Section heading' } } });
    expect(buildResolutionActionRequest(queue.cases[0]!, { kind: 'record_disposition', reason: ' ', idempotencyKey: 'k1' }).ok).toBe(false);
  });

  it('is validated by the write contract, and is never a document field', () => {
    const base = { factKey: PRICED_EVIDENCE_DISPOSITION_FACT_KEY, reason: 'Heading', anchorKey: 'a', idempotencyKey: 'k',
      physicalPageNumber: 10, pageRepresentationDigest: DIGEST,
      sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] } };
    expect(parseRegionAssertionRequest({ ...base, value: { disposition: 'not_a_rate_or_value' }, sourceObservationIds: ['o1'] }).ok).toBe(true);
    expect(parseRegionAssertionRequest({ ...base, value: { disposition: 'something_else' }, sourceObservationIds: ['o1'] }).ok).toBe(false);
    expect(parseRegionAssertionRequest({ ...base, value: { disposition: 'not_a_rate_or_value' }, sourceObservationIds: [] }).ok).toBe(false);
    expect(parsePricedEvidenceDisposition({ disposition: 'not_a_rate_or_value', rate: 5 })).toBeNull();
    expect(reviewedDocumentFieldAssertions([
      { factKey: PRICED_EVIDENCE_DISPOSITION_FACT_KEY } as unknown as EffectiveRegionAssertion,
      { factKey: 'contract_number' } as unknown as EffectiveRegionAssertion,
    ]).map((entry) => entry.factKey)).toEqual(['contract_number']);
  });
});
