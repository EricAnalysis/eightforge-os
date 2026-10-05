import { currentDocumentEvidenceFromExtractionData, regionAssertionEntryTargets, resolveRegionBoundAssertions, type HumanFactAssertionRow } from '@/lib/humanFactAssertions/regionBoundAssertions';
import { buildResolutionQueue } from '@/lib/resolution/resolutionCases';
import { addValueReadingsToResolutionQueue } from '@/lib/server/valueReadingWorkspace';
import { buildValueReadingProposal, VALUE_READING_PROPOSAL_TABLE, VALUE_READING_REVIEW_TABLE, VALUE_READING_OUTCOMES_TABLE, type ValueReadingClient } from '@/lib/server/valueReadingProposals';
import { previewResolutionImpact } from '@/lib/server/resolutionImpactPreview';
import { hypotheticalRegionAssertionRow, parseRegionAssertionRequest, prepareRegionAssertionRecord, regionAssertionChainCheck } from '@/lib/server/regionAssertionRequest';
import type { ResolutionPreviewInput } from '@/lib/resolution/resolutionPreviewInput';
import type { ValidatorSourceReads } from '@/lib/validator/projectValidator';

export const DOC = '11111111-1111-4111-8111-111111111111';
export const PROJECT = 'fixture-project';
const ORG = 'fixture-org';
const DIGEST = 'a'.repeat(64);
const extraction = { extraction: { content_layers_v1: { pdf: {
  page_extraction_coverage_v1: { pages: [{ page_number: 2, page_representation_digest: DIGEST }] },
  layout_observations_v1: { source_artifact_id: 'fixture-artifact', observations: [
    { id: 'o1', raw_text: 'Hauling', physical_page_number: 2 },
    { id: 'o2', raw_text: 'TON $8.7S', physical_page_number: 2 },
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
const tables: Record<string, Record<string, unknown>[]> = {};
export const trace: { method: string; url: string; body: unknown }[] = [];
export const impacts: unknown[] = [];
let assertions: HumanFactAssertionRow[] = [];
let forgewing = true;
let requestCount = 0;
let outcomeCode: 'generated_proposal' | 'unreadable' | 'provider_failed' | 'budget_exhausted' = 'generated_proposal';
let staleReview = false;

// The adapter exposes only read queries over local synthetic rows. It has no credentials or network client.
const admin = { from: (table: string) => {
  const query = { select: () => query, eq: () => query, in: () => query,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve) };
  return query;
}, rpc: async () => { throw new Error('Fixture adapter has no database RPC'); } } as unknown as ValueReadingClient;

export function reset(options: { forgewing?: boolean; outcome?: typeof outcomeCode; staleReview?: boolean } = {}) {
  for (const key of Object.keys(tables)) delete tables[key];
  assertions = []; trace.length = 0; impacts.length = 0; requestCount = 0;
  forgewing = options.forgewing ?? true; outcomeCode = options.outcome ?? 'generated_proposal'; staleReview = options.staleReview ?? false;
}

export async function queue() {
  const resolved = resolveRegionBoundAssertions({ rows: assertions,
    currentEvidenceByDocumentId: new Map([[DOC, currentDocumentEvidenceFromExtractionData(extraction)]]) });
  const base = buildResolutionQueue({ projectId: PROJECT, documents: [{ id: DOC, title: 'Synthetic haul contract' }],
    issues: [], evidence: [], recoveryProposals: [], forgewingEnabled: forgewing,
    reviewedValuesByDocument: new Map([[DOC, { history: assertions, effective: resolved.effective, held: resolved.held, entryTargets: [target] }]]) });
  return addValueReadingsToResolutionQueue(admin, { organizationId: ORG, queue: base,
    extractionDataByDocument: new Map([[DOC, extraction]]), assertions });
}

function reads(): ValidatorSourceReads {
  return {
    project: { id: PROJECT, organization_id: ORG, name: 'Synthetic haul fixture', code: 'FIXTURE',
      validation_phase: 'billing_review', validation_status: 'PENDING', validation_summary_json: null },
    documents: [{ id: DOC, project_id: PROJECT, organization_id: ORG, title: 'Synthetic haul contract', name: 'fixture-contract.pdf',
      document_type: 'contract', document_role: 'contract', storage_path: 'fixtures/contract.pdf', created_at: '2026-10-04T00:00:00Z',
      processing_status: 'complete', operational_status: 'active', processed_at: '2026-10-04T00:00:00Z', intelligence_trace: null }],
    factRows: [], legacyRowsByDocumentId: new Map([[DOC, { document_id: DOC, created_at: '2026-10-04T00:00:00Z', data: extraction }]]),
    overrideRows: [], reviewRows: [], ruleStateByRuleId: new Map(), mobileTickets: [], loadTickets: [], transactionData: null,
    sourceArtifactSnapshotResult: { entries: [], storeState: 'read', readError: null }, regionAssertionRows: assertions,
    precedenceFamilies: [], documentRelationships: [], contractUploadGuidance: null, invoiceLineRateLinkRows: [],
  } as unknown as ValidatorSourceReads;
}

export async function handle(method: string, url: string, body: Record<string, unknown> = {}) {
  trace.push({ method, url, body });
  if (url.endsWith('/region-assertions') && method === 'GET') {
    const resolved = resolveRegionBoundAssertions({ rows: assertions,
      currentEvidenceByDocumentId: new Map([[DOC, currentDocumentEvidenceFromExtractionData(extraction)]]) });
    return { status: 200, body: { available: true, history: assertions, effective: resolved.effective, held: resolved.held, entryTargets: [target] } };
  }
  if (url.endsWith('/resolution-cases')) return { status: 200, body: await queue() };
  if (url.endsWith('/impact')) {
    const result = await previewResolutionImpact({ organizationId: ORG, actorId: 'fixture-operator', projectId: PROJECT,
      caseId: body.caseId as string, input: body.input as ResolutionPreviewInput }, {
      readQueue: async () => ({ status: 'ok', queue: await queue() }), loadReads: async () => reads(),
      loadClearedHistory: async () => new Map(), forgewingEnabled: forgewing,
    });
    if (result.status === 'ok') impacts.push(result.impact);
    return { status: result.status === 'ok' ? 200 : 500, body: result.status === 'ok' ? result.impact : result };
  }
  if (url.endsWith('/value-reading')) {
    if (!forgewing) return { status: 403, body: { error: 'Fixture entitlement missing' } };
    const current = await queue(); const entry = current.cases.find((entry) => entry.caseId === body.caseId);
    if (!entry) return { status: 409, body: { error: 'Case no longer open' } };
    requestCount++;
    const proposal = buildValueReadingProposal({ binding: { organizationId: ORG, projectId: PROJECT, sourceDocumentId: DOC,
      sourceArtifactId: 'fixture-artifact', extractionSnapshotId: 'fixture-extraction', resolutionCaseId: entry.caseId,
      physicalPageNumber: 2, pageRepresentationDigest: DIGEST, factKey: 'contract_rate_row', anchorKey: target.anchorKey,
      sourceObservationIds: target.sourceObservationIds, sourceRegion: target.sourceRegion },
      reading: outcomeCode === 'unreadable' ? { kind: 'unreadable' } : { kind: 'value', rateRow: { description: 'Hauling', unit_type: 'TON', rate_amount: 8.75, category: 'hauling' } },
      readingBasis: 'region_image', providerModel: 'fixture-provider', promptTemplateId: 'fixture', promptTemplateVersion: '1',
      requestDigestSha256: String(requestCount).padStart(64, '0'), outputDigestSha256: 'c'.repeat(64), rationale: 'Read synthetic source region' });
    if (!proposal) throw new Error('Fixture proposal failed actual deterministic validation');
    if (outcomeCode === 'generated_proposal' || outcomeCode === 'unreadable') {
      tables[VALUE_READING_PROPOSAL_TABLE] = [...(tables[VALUE_READING_PROPOSAL_TABLE] ?? []), {
        id: `fixture-proposal-${requestCount}`, proposal_id: proposal.proposalId, proposal_digest_sha256: proposal.proposalDigestSha256,
        proposal_version: proposal.proposalVersion, recovery_type: 'priced_value_reading', authority: 'non_authoritative',
        organization_id: ORG, project_id: PROJECT, source_document_id: DOC, source_artifact_id: 'fixture-artifact',
        extraction_snapshot_id: 'fixture-extraction', resolution_case_id: entry.caseId, physical_page_number: 2,
        page_representation_digest: DIGEST, fact_key: 'contract_rate_row', anchor_key: target.anchorKey,
        source_observation_ids: target.sourceObservationIds, source_region: target.sourceRegion,
        reading_outcome: proposal.reading.kind, proposed_rate_row: proposal.reading.kind === 'value' ? proposal.reading.rateRow : null,
        reading_basis: 'region_image', provider_model: 'fixture-provider', rationale: proposal.rationale,
        created_at: `2026-10-04T00:00:${String(requestCount).padStart(2, '0')}Z`,
      }];
    }
    tables[VALUE_READING_OUTCOMES_TABLE] = [{ id: `outcome-${requestCount}`, organization_id: ORG, source_document_id: DOC,
      source_artifact_id: 'fixture-artifact', physical_page_number: 2, page_representation_digest: DIGEST,
      anchor_key: target.anchorKey, recovery_type: 'priced_value_reading', outcome_code: outcomeCode,
      sanitized_reason: outcomeCode === 'provider_failed' ? 'provider_error' : outcomeCode === 'budget_exhausted' ? 'budget_exhausted' : 'proposal_recorded',
      observed_at: '2026-10-04T01:00:00Z' }];
    return { status: 200, body: { fixtureTransport: true, proposalId: proposal.proposalId } };
  }
  if (url.endsWith('/value-reading-review')) {
    const entry = (await queue()).cases.find((entry) => entry.caseId === body.caseId);
    const offered = entry?.actions.find((action) => action.kind === 'review_value_reading');
    if (staleReview || !offered || offered.kind !== 'review_value_reading'
      || offered.proposalId !== body.proposalId || offered.proposalDigestSha256 !== body.proposalDigestSha256) {
      staleReview = false; return { status: 409, body: { error: 'Reading changed before review' } };
    }
    if (!['rejected', 'deferred'].includes(String(body.disposition)) || !String(body.rationale ?? '').trim()) return { status: 400, body: { error: 'Invalid review' } };
    const proposal = tables[VALUE_READING_PROPOSAL_TABLE]!.find((row) => row.proposal_id === offered.proposalId)!;
    tables[VALUE_READING_REVIEW_TABLE] = [{ id: 'fixture-review', proposal_row_id: proposal.id, review_version: 1,
      reviewer_actor_id: 'fixture-operator', disposition: body.disposition, created_at: '2026-10-04T02:00:00Z' }];
    return { status: 200, body: { fixtureTransport: true } };
  }
  if (url.endsWith('/region-assertions')) {
    const parsed = parseRegionAssertionRequest(body);
    if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };
    const prepared = prepareRegionAssertionRecord({ request: parsed.request, organizationId: ORG,
      actorId: 'fixture-operator', documentId: DOC, extractionData: extraction });
    if (!prepared.ok) return { status: prepared.status, body: { error: prepared.error } };
    if (regionAssertionChainCheck(assertions, prepared.input) !== 'ok') return { status: 409, body: { error: 'Chain moved' } };
    // Transport fixture only. Real B3 origin derivation/persistence is proved separately by the SQL qualification gate.
    assertions.push(hypotheticalRegionAssertionRow(prepared.input, { id: 'fixture-assertion', assertedAt: '2026-10-04T03:00:00Z' }));
    return { status: 201, body: { fixtureTransport: true, assertionId: 'fixture-assertion' } };
  }
  return { status: 404, body: { error: 'Fixture route not found' } };
}
