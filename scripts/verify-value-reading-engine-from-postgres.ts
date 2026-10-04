import {
  regionAssertionEntryTargets,
  verifyRegionEvidence,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { ValueReadingEligibility } from '@/lib/server/forgewingGates';
import {
  recordRegionBoundAssertion,
  type RegionAssertionClient,
} from '@/lib/server/regionBoundHumanAssertions';
import {
  runValueReading,
  type ValueReadingEngineClient,
  type ValueReadingProvider,
} from '@/lib/server/valueReadingEngine';

import { psqlServiceRoleClient, sqlLiteral } from './lib/psqlServiceRoleClient';

/**
 * B4.3 qualification of the value-reading engine against a freshly replayed
 * database, with a permitted fixture provider (no network, no model): it reads
 * the case target from a real extraction row, reserves real budget, records a
 * real proposal, reuses it without a second call, records typed outcomes for
 * invalid output, an exhausted budget and a refused data policy, and the
 * resulting proposal binds exactly to an operator's B3 write.
 *
 * The production policy keeps value reading disabled, so eligibility is
 * injected here; every other step runs through production code.
 * Runs after scripts/verify-value-reading-from-postgres.ts, whose fixtures it reuses.
 */

const databaseUrl = process.env.B42_DATABASE_URL;
if (!databaseUrl) throw new Error('B42_DATABASE_URL is required');
const db = psqlServiceRoleClient(databaseUrl);
const client = db as unknown as ValueReadingEngineClient & RegionAssertionClient;

function check(condition: unknown, label: string): void {
  if (!condition) throw new Error(`B4.3 ENGINE FAIL: ${label}`);
}

const ORG = 'b4200000-0000-4000-8000-000000000001';
const PROJECT = 'b4200000-0000-4000-8000-0000000000e1';
const ACTOR = 'b4200000-0000-4000-8000-0000000000a1';
const DOCUMENT = 'b4200000-0000-4000-8000-0000000000d1';
const ARTIFACT = 'b4200000-0000-4000-8000-0000000000f1';
const PAGE_DIGEST = 'e'.repeat(64);

const extraction = { extraction: { content_layers_v1: { pdf: {
  text: { pages: [{ plain_text_blocks: [{ text: 'Generic schedule' }] }] },
  page_extraction_coverage_v1: { pages: [{ page_number: 9, page_representation_digest: PAGE_DIGEST }] },
  layout_observations_v1: { source_artifact_id: ARTIFACT, observations: [
    { id: 'e9-o1', raw_text: 'Stump', physical_page_number: 9 },
    { id: 'e9-o2', raw_text: '4S.OO', physical_page_number: 9 },
    { id: 'e9-o3', raw_text: 'Hauling', physical_page_number: 9 },
    { id: 'e9-o4', raw_text: '8.7S', physical_page_number: 9 },
  ] },
  priced_schedule_reconstruction_v1: {
    parser_version: 'priced_schedule_reconstruction_v2', pages: [],
    unresolved_pages: [{ authority: 'non_authoritative_diagnostic', reason: 'header_not_found', physical_page_number: 9,
      header_lines: [], priced_lines: [
        { raw_text: 'Stump grinding EA 4S.OO', y: 300, source_refs: [
          { observation_id: 'e9-o1', x_min: 10, x_max: 60, y_min: 300, y_max: 312 },
          { observation_id: 'e9-o2', x_min: 440, x_max: 520, y_min: 300, y_max: 312 }] },
        { raw_text: 'Hauling TON 8.7S', y: 320, source_refs: [
          { observation_id: 'e9-o3', x_min: 10, x_max: 60, y_min: 320, y_max: 332 },
          { observation_id: 'e9-o4', x_min: 440, x_max: 520, y_min: 320, y_max: 332 }] },
      ] }],
  },
} } } };

// Hosted Supabase gives service_role read access to every public table; the
// replay role is created bare. Mirror that for the two tables the engine reads.
db.runSql(`GRANT SELECT ON public.documents, public.document_extractions TO service_role;
  SELECT json_build_object('granted', true);`);
db.runSql(`INSERT INTO public.document_extractions (document_id, organization_id, data)
  VALUES (${sqlLiteral(DOCUMENT)}, ${sqlLiteral(ORG)}, ${sqlLiteral(JSON.stringify(extraction))}::jsonb)
  RETURNING json_build_object('id', id);`);

const [stump, hauling] = regionAssertionEntryTargets(extraction, DOCUMENT);
check(stump && hauling, 'fixture extraction yields two open priced lines');
const caseOf = (anchorKey: string) => `unreadable:${DOCUMENT}:${anchorKey}`;

let calls = 0;
const fixtureProvider = (output: string): ValueReadingProvider => ({
  providerModel: null,
  read: async () => {
    calls += 1;
    return output;
  },
});
const renderRegionImage = async () => ({ mediaType: 'image/png' as const, bytes: new Uint8Array([137, 80, 78, 71]) });
const eligible = (dailyCap: number) => async (): Promise<ValueReadingEligibility> =>
  ({ eligible: true, entitlementEventId: 'fixture', dataPolicyEventIds: ['fixture'], dailyCap });
const reservations = () => Number((db.runSql(`SELECT json_build_object('n', count(*))
  FROM public.forgewing_provider_call_reservations WHERE organization_id = ${sqlLiteral(ORG)}`) as { n: number }).n);
const outcomes = () => db.runSql(`SELECT coalesce(json_agg(json_build_object('code', outcome_code, 'reason', sanitized_reason,
  'invoked', provider_invoked) ORDER BY observed_at, outcome_code), '[]'::json)
  FROM public.forgewing_recovery_generation_outcomes
  WHERE organization_id = ${sqlLiteral(ORG)} AND recovery_type = 'priced_value_reading'
    AND page_representation_digest = ${sqlLiteral(PAGE_DIGEST)}`) as
  Array<{ code: string; reason: string; invoked: boolean }>;

const VALUE = JSON.stringify({ reading: 'value', description: 'Stump grinding', unit_type: 'EA', rate_amount: 45,
  rationale: 'The rate cell reads $45.00.' });
const input = { organizationId: ORG, projectId: PROJECT, caseId: caseOf(stump!.anchorKey), requestedBy: ACTOR,
  includeTextExcerpts: false };

const first = await runValueReading(client, input, {
  provider: fixtureProvider(VALUE), renderRegionImage, resolveEligibility: eligible(2) });
check(first.status === 'proposed' && !first.reused, 'the first request records a proposal');
check(calls === 1 && reservations() === 1, 'exactly one provider call and one durable reservation');
const proposal = (first as Extract<typeof first, { status: 'proposed' }>).proposal;
check(proposal.binding.sourceArtifactId === ARTIFACT && proposal.binding.extractionSnapshotId.length > 0,
  'the proposal binds to the verified artifact and the preferred extraction');

const reused = await runValueReading(client, input, {
  provider: fixtureProvider(VALUE), renderRegionImage, resolveEligibility: eligible(2) });
check(reused.status === 'proposed' && reused.reused && reused.proposal.proposalId === proposal.proposalId,
  'the identical request is answered from the stored proposal');
check(calls === 1 && reservations() === 1, 'reuse makes no call and spends no budget');

const invalid = await runValueReading(client, { ...input, caseId: caseOf(hauling!.anchorKey) }, {
  provider: fixtureProvider('{"reading":"value"'), renderRegionImage, resolveEligibility: eligible(2) });
check(invalid.status === 'failed' && invalid.outcomeCode === 'structured_output_invalid' && invalid.outcomeRecorded,
  'invalid output is a recorded outcome, not a proposal');
check(reservations() === 2, 'the failed attempt still spent its reservation');

const exhausted = await runValueReading(client, { ...input, includeTextExcerpts: true }, {
  provider: fixtureProvider(VALUE), renderRegionImage, resolveEligibility: eligible(2) });
check(exhausted.status === 'failed' && exhausted.outcomeCode === 'budget_exhausted', 'the durable cap refuses the third call');
check(calls === 2 && reservations() === 2, 'nothing is called past the cap');

for (let attempt = 0; attempt < 2; attempt += 1) {
  const refused = await runValueReading(client, { ...input, caseId: caseOf(hauling!.anchorKey) }, {
    provider: fixtureProvider(VALUE), renderRegionImage,
    resolveEligibility: async () => ({ eligible: false, reason: 'data_policy_not_approved' }) });
  check(refused.status === 'refused' && refused.outcomeRecorded, 'a refused data policy is recorded');
}
const recorded = outcomes();
check(recorded.filter((row) => row.code === 'data_policy_not_approved').length === 1,
  'a repeated refusal of the same request is recorded once');
check(recorded.some((row) => row.code === 'structured_output_invalid' && row.invoked)
  && recorded.some((row) => row.code === 'budget_exhausted' && !row.invoked), 'every failure is typed and attributed');

// One road to truth: the operator cites the proposal through the unchanged B3 record path.
const evidence = verifyRegionEvidence({ extractionData: extraction, physicalPageNumber: 9,
  pageRepresentationDigest: PAGE_DIGEST, sourceObservationIds: stump!.sourceObservationIds });
check(evidence.status === 'verified', 'the B3 evidence check verifies the same line');
const used = await recordRegionBoundAssertion(client, {
  organizationId: ORG, actorId: ACTOR, sourceDocumentId: DOCUMENT, factKey: 'contract_rate_row',
  assertedValue: { description: 'Stump grinding', unit_type: 'EA', rate_amount: 45 }, status: 'active',
  reason: 'Checked the Forgewing reading against the page', physicalPageNumber: 9, sourceRegion: stump!.sourceRegion,
  pageRepresentationDigest: PAGE_DIGEST, sourceObservationIds: stump!.sourceObservationIds,
  sourceArtifactId: evidence.status === 'verified' ? evidence.sourceArtifactId : null,
  parserVersion: evidence.status === 'verified' ? evidence.parserVersion : null,
  originalSourceText: evidence.status === 'verified' ? evidence.originalSourceText : null,
  anchorKey: stump!.anchorKey, supersedesAssertionId: null, idempotencyKey: 'b43-engine-use',
  forgewingProposalId: proposal.proposalId,
});
check(used.status === 'recorded', 'the engine proposal binds exactly to the operator B3 write');
const origin = db.runSql(`SELECT json_build_object('o', review_origin) FROM public.human_fact_assertions
  WHERE id = ${sqlLiteral((used as { assertionId: string }).assertionId)}`) as { o: string };
check(origin.o === 'ai_proposed_operator_approved', 'the database derived approved for the unchanged value');

const closed = await runValueReading(client, input, {
  provider: fixtureProvider(VALUE), renderRegionImage, resolveEligibility: eligible(2) });
check(closed.status === 'refused' && closed.reason === 'target_not_open', 'a reviewed line is no longer offered for reading');

console.log('B4.3 VALUE-READING ENGINE FIXTURE ROUND TRIP: PASS');
