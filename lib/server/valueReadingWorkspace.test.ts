import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/valueReadingProposals', async (original) => ({
  ...await original<typeof import('@/lib/server/valueReadingProposals')>(), loadValueReadingRecords: vi.fn(),
}));

import { regionAssertionEntryTargets, type HumanFactAssertionRow } from '@/lib/humanFactAssertions/regionBoundAssertions';
import { buildResolutionQueue } from '@/lib/resolution/resolutionCases';
import { loadValueReadingRecords, type ValueReadingClient, type ValueReadingProposalRecord } from '@/lib/server/valueReadingProposals';
import { addValueReadingsToResolutionQueue } from '@/lib/server/valueReadingWorkspace';

const ORG = 'org';
const PROJECT = 'project';
const DOC = '11111111-1111-4111-8111-111111111111';
const ARTIFACT = 'artifact';
const DIGEST = 'a'.repeat(64);
const extraction = { extraction: { content_layers_v1: { pdf: {
  page_extraction_coverage_v1: { pages: [{ page_number: 2, page_representation_digest: DIGEST }] },
  layout_observations_v1: { source_artifact_id: ARTIFACT, observations: [
    { id: 'o1', raw_text: 'Hauling', physical_page_number: 2 },
    { id: 'o2', raw_text: '$8.7S', physical_page_number: 2 },
  ] },
  priced_schedule_reconstruction_v1: { parser_version: 'priced_schedule_reconstruction_v2', pages: [],
    unresolved_pages: [{ authority: 'non_authoritative_diagnostic', reason: 'header_not_found', physical_page_number: 2,
      header_lines: [], priced_lines: [{ raw_text: 'Hauling TON $8.7S', y: 300, source_refs: [
        { observation_id: 'o1', x_min: 1, x_max: 2, y_min: 3, y_max: 4 },
        { observation_id: 'o2', x_min: 5, x_max: 6, y_min: 3, y_max: 4 },
      ] }] }],
  },
} } } };
const target = regionAssertionEntryTargets(extraction)[0]!;
const caseId = `unreadable:${DOC}:${target.anchorKey}`;
const proposal: ValueReadingProposalRecord = {
  rowId: 'row1', proposalId: `forgewing-proposal-value-reading-${'b'.repeat(64)}`, proposalDigestSha256: 'b'.repeat(64),
  binding: { organizationId: ORG, projectId: PROJECT, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
    extractionSnapshotId: 'extraction', resolutionCaseId: caseId, physicalPageNumber: 2, pageRepresentationDigest: DIGEST,
    factKey: 'contract_rate_row', anchorKey: target.anchorKey, sourceObservationIds: target.sourceObservationIds, sourceRegion: target.sourceRegion },
  reading: { kind: 'value', rateRow: { description: 'Hauling', unit_type: 'TON', rate_amount: 8.75, category: null } },
  readingBasis: 'region_image', providerModel: null, rationale: 'Read rate cell', createdAt: '2026-10-04T01:00:00Z',
};
const outcome = { id: 'outcome1', organization_id: ORG, source_document_id: DOC, source_artifact_id: ARTIFACT,
  physical_page_number: 2, page_representation_digest: DIGEST, anchor_key: target.anchorKey,
  recovery_type: 'priced_value_reading', outcome_code: 'activation_not_allowed', sanitized_reason: 'activation_disabled',
  observed_at: '2026-10-04T01:00:00Z' };

function queue(enabled = true) {
  return buildResolutionQueue({ projectId: PROJECT, documents: [{ id: DOC }], issues: [], evidence: [], recoveryProposals: [],
    forgewingEnabled: enabled, reviewedValuesByDocument: new Map([[DOC, { history: [], effective: [], held: [], entryTargets: [target] }]]) });
}
function admin(outcomes: unknown[] = [outcome], error: unknown = null) {
  const result = { data: outcomes, error };
  const query = { eq: () => query, in: () => query, then: (resolve: (data: unknown) => unknown) => Promise.resolve(result).then(resolve) };
  return { from: vi.fn(() => ({ select: () => query })), rpc: vi.fn() } as unknown as ValueReadingClient;
}
async function read(options: { enabled?: boolean; outcomes?: unknown[]; client?: ValueReadingClient } = {}) {
  return addValueReadingsToResolutionQueue(options.client ?? admin(options.outcomes), { organizationId: ORG,
    queue: queue(options.enabled), extractionDataByDocument: new Map([[DOC, extraction]]), assertions: [] });
}

describe('B4.4 value readings in the server-derived workspace', () => {
  beforeEach(() => vi.mocked(loadValueReadingRecords).mockResolvedValue({ proposals: [proposal], reviews: [] }));

  it('makes no Forgewing reads and preserves manual Core actions without entitlement', async () => {
    const client = admin();
    const result = await read({ enabled: false, client });
    expect(client.from).not.toHaveBeenCalled();
    expect(loadValueReadingRecords).not.toHaveBeenCalled();
    expect(result.cases[0]!.suggestions).toEqual([]);
    expect(result.cases[0]!.actions.map((action) => action.kind)).toEqual(['enter_reviewed_value', 'open_document']);
  });

  it('offers a non-authoritative proposal and keeps a gated outcome separate from its value', async () => {
    const result = await read();
    expect(result.cases[0]).toMatchObject({ valueReadingOutcome: { code: 'activation_not_allowed', reason: 'activation_disabled' },
      suggestions: [{ source: 'forgewing_value_reading', proposalId: proposal.proposalId, uncalibratedCertainty: null,
        rateRow: { rate_amount: 8.75 } }] });
    expect(result.cases[0]!.actions).toContainEqual(expect.objectContaining({ kind: 'enter_reviewed_value', forgewingProposalId: proposal.proposalId }));
    expect(result.cases[0]!.actions).toContainEqual(expect.objectContaining({ kind: 'review_value_reading', dispositions: ['rejected', 'deferred'] }));
  });

  it.each(['rejected', 'deferred'] as const)('does not offer %s proposals for promotion', async (disposition) => {
    vi.mocked(loadValueReadingRecords).mockResolvedValue({ proposals: [proposal], reviews: [{ id: 'r1', proposalRowId: proposal.rowId,
      reviewVersion: 1, reviewerActorId: 'actor', disposition, createdAt: '2026-10-04T02:00:00Z' }] });
    const result = await read();
    expect(result.cases[0]!.suggestions).toEqual([]);
    expect(result.cases[0]!.actions.some((action) => action.kind === 'review_value_reading')).toBe(false);
    expect(result.cases[0]!.actions.find((action) => action.kind === 'enter_reviewed_value')).not.toHaveProperty('forgewingProposalId');
  });

  it.each(['sourceArtifactId', 'pageRepresentationDigest', 'anchorKey', 'resolutionCaseId', 'projectId'] as const)(
    'does not offer a proposal with stale or mismatched %s', async (field) => {
      vi.mocked(loadValueReadingRecords).mockResolvedValue({ proposals: [{ ...proposal, binding: { ...proposal.binding, [field]: 'changed' } }], reviews: [] });
      expect((await read()).cases[0]!.suggestions).toEqual([]);
    });

  it('renders unreadable outcomes without fabricating a suggestion', async () => {
    vi.mocked(loadValueReadingRecords).mockResolvedValue({ proposals: [{ ...proposal, reading: { kind: 'unreadable' } }], reviews: [] });
    const result = await read({ outcomes: [{ ...outcome, outcome_code: 'unreadable', sanitized_reason: 'proposal_recorded' }] });
    expect(result.cases[0]!.suggestions).toEqual([]);
    expect(result.cases[0]!.valueReadingOutcome?.code).toBe('unreadable');
  });

  it('does not offer a reading already used by a durable human assertion', async () => {
    const result = await addValueReadingsToResolutionQueue(admin(), { organizationId: ORG, queue: queue(),
      extractionDataByDocument: new Map([[DOC, extraction]]), assertions: [{ id: 'assertion', organization_id: ORG,
        forgewing_proposal_id: proposal.proposalId, status: 'active', review_origin: 'ai_proposed_operator_approved',
        asserted_at: '2026-10-04T02:00:00Z' } as HumanFactAssertionRow] });
    expect(result.cases[0]!.suggestions).toEqual([]);
  });

  it('offers no reading action when the current artifact cannot be verified', async () => {
    const result = await addValueReadingsToResolutionQueue(admin(), { organizationId: ORG, queue: queue(),
      extractionDataByDocument: new Map([[DOC, null]]), assertions: [] });
    expect(result.cases[0]!.actions.map((action) => action.kind)).toEqual(['enter_reviewed_value', 'open_document']);
  });

  it('selects the latest current exact binding deterministically, ignoring foreign and stale outcomes', async () => {
    const valid = { ...outcome, id: 'z', outcome_code: 'provider_failed', sanitized_reason: 'provider_timeout' };
    const foreign = ['organization_id', 'source_document_id', 'source_artifact_id', 'page_representation_digest', 'anchor_key']
      .map((field) => ({ ...outcome, [field]: 'foreign', observed_at: '2026-10-05T00:00:00Z' }));
    for (const outcomes of [[...foreign, valid, outcome], [outcome, valid, ...foreign].reverse()]) {
      expect((await read({ outcomes })).cases[0]!.valueReadingOutcome).toEqual({ code: 'provider_failed', reason: 'provider_timeout' });
    }
  });

  it('does not silently replace an unavailable Forgewing read with invented actions', async () => {
    await expect(read({ client: admin([], { message: 'unavailable' }) })).rejects.toThrow('Value-reading outcomes unavailable');
  });
});
