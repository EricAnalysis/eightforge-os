import { describe, expect, it } from 'vitest';

import type { HumanFactAssertionRow } from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  deriveValueReadingLifecycle,
  deriveValueReadingTelemetry,
} from '@/lib/resolution/valueReadingLifecycle';
import type { ValueReadingProposalRecord, ValueReadingReviewRecord } from '@/lib/server/valueReadingProposals';

const DIGEST = 'a'.repeat(64);

function proposal(id: string, overrides: Partial<{ anchorKey: string; digest: string; createdAt: string; unreadable: boolean }> = {}): ValueReadingProposalRecord {
  return {
    rowId: `row-${id}`,
    proposalId: `forgewing-proposal-value-reading-${id.padEnd(64, '0')}`,
    proposalDigestSha256: id.padEnd(64, '0'),
    binding: {
      organizationId: 'org-1', projectId: 'project-1', sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1',
      extractionSnapshotId: 'extraction-1', resolutionCaseId: 'case-1', physicalPageNumber: 8,
      pageRepresentationDigest: overrides.digest ?? DIGEST, factKey: 'contract_rate_row',
      anchorKey: overrides.anchorKey ?? 'p8:line:300', sourceObservationIds: ['obs-1'],
      sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 0, x_max: 1, y_min: 0, y_max: 1 }] },
    },
    reading: overrides.unreadable ? { kind: 'unreadable' }
      : { kind: 'value', rateRow: { description: 'Debris removal', unit_type: 'CY', rate_amount: 14.5, category: null } },
    readingBasis: 'region_image',
    providerModel: null,
    rationale: 'Reads $14.50',
    createdAt: overrides.createdAt ?? '2026-10-04T10:00:00Z',
  };
}

function review(id: string, proposalRowId: string, disposition: 'rejected' | 'deferred', version: number, createdAt: string): ValueReadingReviewRecord {
  return { id, proposalRowId, reviewVersion: version, reviewerActorId: 'actor-1', disposition, createdAt };
}

function assertion(id: string, origin: string, proposalId: string | null, overrides: Partial<HumanFactAssertionRow> = {}): HumanFactAssertionRow {
  return {
    id, organization_id: 'org-1', source_document_id: 'doc-1', fact_key: 'contract_rate_row',
    asserted_value: { description: 'Debris removal', unit_type: 'CY', rate_amount: 14.5 },
    source_binding: 'region_bound', supersedes_assertion_id: null, actor_id: 'actor-1', reason: 'r',
    asserted_at: '2026-10-04T11:00:00Z', status: 'active', source_artifact_id: 'artifact-1', physical_page_number: 8,
    source_region: { coordinate_space: 'source', boxes: [{ x_min: 0, x_max: 1, y_min: 0, y_max: 1 }] },
    page_representation_digest: DIGEST, parser_version: null, source_observation_ids: ['obs-1'],
    original_source_text: 'sia 50', anchor_key: 'p8:line:300', review_origin: origin, forgewing_proposal_id: proposalId,
    ...overrides,
  };
}

const CURRENT = new Map([['doc-1', new Map([[8, DIGEST]])]]);

describe('value-reading lifecycle (B4.2)', () => {
  it('derives every state from records, with fixed precedence', () => {
    const [used, edited, rejected, stale, deferred, pending, unreadable] = ['1', '2', '3', '4', '5', '6', '7'].map((id) =>
      proposal(id, id === '4' ? { digest: 'b'.repeat(64) } : id === '7' ? { unreadable: true } : {}));
    const lifecycle = deriveValueReadingLifecycle({
      proposals: [pending!, used!, edited!, rejected!, stale!, deferred!, unreadable!],
      reviews: [
        review('r1', rejected!.rowId, 'deferred', 1, '2026-10-04T10:10:00Z'),
        review('r2', rejected!.rowId, 'rejected', 2, '2026-10-04T10:20:00Z'),
        review('r3', deferred!.rowId, 'deferred', 1, '2026-10-04T10:10:00Z'),
        // A rejection does not undo a use: the use is a human assertion.
        review('r4', used!.rowId, 'rejected', 1, '2026-10-04T10:05:00Z'),
      ],
      assertions: [
        assertion('a1', 'ai_proposed_operator_approved', used!.proposalId),
        assertion('a2', 'ai_proposed_operator_modified', edited!.proposalId, { anchor_key: 'p8:line:301' }),
      ],
      currentPageDigests: CURRENT,
    });
    const state = Object.fromEntries(lifecycle.map((entry) => [entry.proposalId, entry]));
    expect(state[used!.proposalId]).toMatchObject({ state: 'used', usedByAssertionId: 'a1', offerable: false });
    expect(state[edited!.proposalId]).toMatchObject({ state: 'used_edited', usedByAssertionId: 'a2' });
    expect(state[rejected!.proposalId]).toMatchObject({ state: 'rejected', latestReviewId: 'r2', offerable: false });
    expect(state[stale!.proposalId]).toMatchObject({ state: 'stale', offerable: false });
    expect(state[deferred!.proposalId]).toMatchObject({ state: 'deferred', offerable: true });
    expect(state[pending!.proposalId]).toMatchObject({ state: 'pending', offerable: true });
    // An unreadable reading is never offered as a value.
    expect(state[unreadable!.proposalId]).toMatchObject({ state: 'pending', offerable: false });
  });

  it('is stale when the page is re-extracted or its current representation is unknown', () => {
    const one = proposal('1');
    expect(deriveValueReadingLifecycle({ proposals: [one], reviews: [], assertions: [],
      currentPageDigests: new Map([['doc-1', new Map([[8, 'c'.repeat(64)]])]]) })[0]!.state).toBe('stale');
    expect(deriveValueReadingLifecycle({ proposals: [one], reviews: [], assertions: [],
      currentPageDigests: new Map() })[0]!.state).toBe('stale');
  });

  it('ignores withdrawn and foreign-organization citations', () => {
    const one = proposal('1');
    const lifecycle = deriveValueReadingLifecycle({
      proposals: [one], reviews: [],
      assertions: [
        assertion('w', 'ai_proposed_operator_approved', one.proposalId, { status: 'withdrawn' }),
        assertion('x', 'ai_proposed_operator_approved', one.proposalId, { organization_id: 'org-2' }),
      ],
      currentPageDigests: CURRENT,
    });
    expect(lifecycle[0]).toMatchObject({ state: 'pending', usedByAssertionId: null });
  });
});

describe('value-reading telemetry (B4.2)', () => {
  it('derives all five outcomes from durable records only', () => {
    const shown = proposal('1', { createdAt: '2026-10-04T10:00:00Z' });
    const usedP = proposal('2', { anchorKey: 'p8:line:310' });
    const editedP = proposal('3', { anchorKey: 'p8:line:320' });
    const rejectedP = proposal('4', { anchorKey: 'p8:line:330' });
    const events = deriveValueReadingTelemetry({
      proposals: [shown, usedP, editedP, rejectedP],
      reviews: [review('r1', rejectedP.rowId, 'rejected', 1, '2026-10-04T10:30:00Z'),
        review('r2', shown.rowId, 'deferred', 1, '2026-10-04T10:31:00Z')],
      assertions: [
        assertion('a1', 'ai_proposed_operator_approved', usedP.proposalId, { anchor_key: 'p8:line:310' }),
        assertion('a2', 'ai_proposed_operator_modified', editedP.proposalId, { anchor_key: 'p8:line:320' }),
        // Typed while a current, unrejected suggestion existed.
        assertion('a3', 'operator_entered', null),
        // Typed after the suggestion for this anchor was rejected.
        assertion('a4', 'operator_entered', null, { anchor_key: 'p8:line:330' }),
        // Typed where Forgewing never read anything.
        assertion('a5', 'operator_entered', null, { anchor_key: 'p8:line:340' }),
        // Withdrawals are not outcomes.
        assertion('a6', 'operator_entered', null, { anchor_key: 'p8:line:350', status: 'withdrawn', asserted_value: null }),
      ],
    });
    const byKey = Object.fromEntries(events.map((event) => [event.assertionId ?? event.reviewId, event]));
    expect(byKey.a1).toMatchObject({ outcome: 'forgewing_used_unchanged', proposalId: usedP.proposalId });
    expect(byKey.a2).toMatchObject({ outcome: 'forgewing_used_then_edited', proposalId: editedP.proposalId });
    expect(byKey.r1).toMatchObject({ outcome: 'forgewing_rejected', proposalId: rejectedP.proposalId });
    expect(byKey.a3).toMatchObject({ outcome: 'suggestion_ignored', proposalId: shown.proposalId });
    expect(byKey.a4).toMatchObject({ outcome: 'operator_entered_without_suggestion', proposalId: null });
    expect(byKey.a5).toMatchObject({ outcome: 'operator_entered_without_suggestion' });
    expect(events).toHaveLength(6);
    expect(byKey.r2).toBeUndefined();
  });

  it('does not count a suggestion created later, for another page, or unreadable', () => {
    const later = proposal('1', { createdAt: '2026-10-04T12:00:00Z' });
    const otherPage = proposal('2', { digest: 'b'.repeat(64) });
    const unreadable = proposal('3', { unreadable: true });
    const events = deriveValueReadingTelemetry({
      proposals: [later, otherPage, unreadable], reviews: [], assertions: [assertion('a1', 'operator_entered', null)],
    });
    expect(events).toEqual([expect.objectContaining({ outcome: 'operator_entered_without_suggestion' })]);
  });

  it('does not count a suggestion the operator already used', () => {
    const shown = proposal('1');
    const events = deriveValueReadingTelemetry({ proposals: [shown], reviews: [], assertions: [
      assertion('a0', 'ai_proposed_operator_approved', shown.proposalId, { asserted_at: '2026-10-04T10:30:00Z' }),
      assertion('a1', 'operator_entered', null, { supersedes_assertion_id: 'a0' }),
    ] });
    expect(events.map((event) => event.outcome)).toEqual(['forgewing_used_unchanged', 'operator_entered_without_suggestion']);
  });

  it('is independent of input order', () => {
    const shown = proposal('1');
    const params = { proposals: [shown, proposal('2', { anchorKey: 'x' })], reviews: [],
      assertions: [assertion('a1', 'operator_entered', null), assertion('a0', 'ai_proposed_operator_approved',
        shown.proposalId, { asserted_at: '2026-10-04T10:30:00Z' })] };
    expect(deriveValueReadingTelemetry(params)).toEqual(deriveValueReadingTelemetry({
      proposals: [...params.proposals].reverse(), reviews: [], assertions: [...params.assertions].reverse() }));
  });
});
