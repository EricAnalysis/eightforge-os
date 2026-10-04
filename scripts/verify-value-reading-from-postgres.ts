import { execFileSync } from 'node:child_process';

import {
  resolveRegionBoundAssertions,
  type CurrentDocumentEvidence,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  deriveValueReadingLifecycle,
  deriveValueReadingTelemetry,
} from '@/lib/resolution/valueReadingLifecycle';
import {
  loadRegionBoundAssertionRows,
  recordRegionBoundAssertion,
  type RecordRegionAssertionInput,
  type RegionAssertionClient,
} from '@/lib/server/regionBoundHumanAssertions';
import {
  buildValueReadingProposal,
  loadValueReadingRecords,
  recordValueReadingProposal,
  recordValueReadingReview,
  type ValueReadingClient,
  type ValueReadingProposalDraft,
} from '@/lib/server/valueReadingProposals';

/**
 * B4.2 qualification through the real TypeScript adapters against a freshly
 * replayed database: build and record a value-reading proposal, replay it,
 * refuse a second answer, defer it, promote it only through the B3 record
 * function (approved, then modified), refuse a stale citation, and read it all
 * back into the derived lifecycle, telemetry and the fail-closed resolver.
 * Runs after scripts/sql/verify-forgewing-value-reading.sql, whose fixtures it reuses.
 */

const databaseUrl = process.env.B42_DATABASE_URL;
if (!databaseUrl) throw new Error('B42_DATABASE_URL is required');

function literal(value: unknown): string {
  if (value == null) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(statement: string): unknown {
  const output = execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-At',
    '--dbname', databaseUrl!], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const text = output.trim();
  return text.length === 0 ? null : JSON.parse(text);
}

function sqlValue(value: unknown): string {
  if (value == null) return 'NULL';
  if (Array.isArray(value)) return `ARRAY[${value.map((entry) => literal(entry)).join(',')}]::text[]`;
  if (typeof value === 'object') return `${literal(JSON.stringify(value))}::jsonb`;
  if (typeof value === 'number') return String(value);
  return literal(value);
}

/** The minimal Supabase surface the adapters use, backed by psql as service_role, named arguments. */
const client: RegionAssertionClient & ValueReadingClient = {
  rpc(fn, args) {
    const named = Object.entries(args).map(([name, value]) =>
      `${name} => ${name === 'p_asserted_value' && value != null ? `${literal(JSON.stringify(value))}::jsonb` : sqlValue(value)}`);
    try {
      const data = runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
        SELECT coalesce(json_agg(r), '[]'::json) FROM public.${fn}(${named.join(', ')}) r;`);
      return Promise.resolve({ data, error: null });
    } catch (error) {
      const text = String((error as { stderr?: unknown }).stderr ?? error);
      const code = /ERROR:\s+([0-9A-Z]{5}):/.exec(text)?.[1] ?? 'P0001';
      return Promise.resolve({ data: null, error: { code, message: text } });
    }
  },
  from(table) {
    return {
      select(columns: string) {
        const filters: string[] = [];
        let order = '';
        const query = {
          in(column: string, values: readonly string[]) {
            filters.push(`${column}::text IN (${values.map(literal).join(',')})`);
            return query;
          },
          eq(column: string, value: unknown) {
            filters.push(`${column} = ${literal(value)}`);
            return query;
          },
          order(column: string, options: { ascending: boolean }) {
            order = ` ORDER BY ${column} ${options.ascending ? 'ASC' : 'DESC'}, id`;
            return query;
          },
          then(resolve: (value: { data: unknown; error: null }) => unknown) {
            const data = runSql(`SET ROLE service_role;
              SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT ${columns} FROM public.${table}
              WHERE ${filters.join(' AND ') || 'true'}${order}) t;`);
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return query as never;
      },
    };
  },
};

function check(condition: unknown, label: string): void {
  if (!condition) throw new Error(`B4.2 ADAPTER FAIL: ${label}`);
}

const ORG = 'b4200000-0000-4000-8000-000000000001';
const ACTOR = 'b4200000-0000-4000-8000-0000000000a1';
const DOCUMENT = 'b4200000-0000-4000-8000-0000000000d1';
const ANCHOR = 'p8:line:700';
const PAGE_DIGEST = 'a'.repeat(64);
const REGION = { coordinate_space: 'source', boxes: [{ x_min: 440, x_max: 520, y_min: 700, y_max: 712 }] };

const draft: ValueReadingProposalDraft = {
  binding: {
    organizationId: ORG, projectId: 'b4200000-0000-4000-8000-0000000000e1', sourceDocumentId: DOCUMENT,
    sourceArtifactId: 'b4200000-0000-4000-8000-0000000000f1', extractionSnapshotId: 'extraction-snapshot-1',
    resolutionCaseId: 'case:unreadable-line:p8:700', physicalPageNumber: 8, pageRepresentationDigest: PAGE_DIGEST,
    factKey: 'contract_rate_row', anchorKey: ANCHOR, sourceObservationIds: ['obs-7a', 'obs-7b'], sourceRegion: REGION,
  },
  reading: { kind: 'value', rateRow: { description: 'Vegetative debris', unit_type: 'CY', rate_amount: 6.25, category: null } },
  readingBasis: 'region_image',
  providerModel: null,
  promptTemplateId: 'priced_value_reading',
  promptTemplateVersion: 'v1',
  requestDigestSha256: '1'.repeat(64),
  outputDigestSha256: '2'.repeat(64),
  rationale: 'Rate cell reads $6.25 in the source image.',
};

const proposal = buildValueReadingProposal(draft);
check(proposal, 'proposal builds');
const recorded = await recordValueReadingProposal(client, proposal!);
check(recorded.status === 'recorded' && recorded.inserted, 'proposal recorded');
const replay = await recordValueReadingProposal(client, proposal!);
check(replay.status === 'recorded' && !replay.inserted
  && replay.proposalRowId === (recorded as { proposalRowId: string }).proposalRowId, 'idempotent replay');
const secondAnswer = buildValueReadingProposal({ ...draft, outputDigestSha256: '3'.repeat(64),
  reading: { kind: 'value', rateRow: { description: 'Vegetative debris', unit_type: 'CY', rate_amount: 9, category: null } } });
check((await recordValueReadingProposal(client, secondAnswer!)).status === 'collision',
  'a second answer to the same request is a collision, never a second proposal');

const deferred = await recordValueReadingReview(client, {
  organizationId: ORG, reviewerActorId: ACTOR, proposalId: proposal!.proposalId,
  proposalDigestSha256: proposal!.proposalDigestSha256, disposition: 'deferred',
  rationale: 'Check against the original first', idempotencyKey: 'b42-adapter-defer',
});
check(deferred.status === 'recorded' && deferred.inserted, 'deferral recorded');

const base: RecordRegionAssertionInput = {
  organizationId: ORG, actorId: ACTOR, sourceDocumentId: DOCUMENT, factKey: 'contract_rate_row',
  assertedValue: { rate_amount: 6.250, unit_type: 'CY', description: 'Vegetative debris' },
  status: 'active', reason: 'Used the Forgewing reading after checking the source',
  sourceArtifactId: 'b4200000-0000-4000-8000-0000000000f1', physicalPageNumber: 8, sourceRegion: REGION,
  pageRepresentationDigest: PAGE_DIGEST, parserVersion: 'priced_schedule_reconstruction_v2',
  sourceObservationIds: ['obs-7b', 'obs-7a'], originalSourceText: 'sia 25', anchorKey: ANCHOR,
  supersedesAssertionId: null, idempotencyKey: 'b42-adapter-use', forgewingProposalId: proposal!.proposalId,
};
const used = await recordRegionBoundAssertion(client, base);
check(used.status === 'recorded' && used.inserted, 'exact value recorded through the B3 record function');
const usedId = (used as { assertionId: string }).assertionId;

const stale = await recordRegionBoundAssertion(client, {
  ...base, idempotencyKey: 'b42-adapter-stale', pageRepresentationDigest: 'b'.repeat(64), supersedesAssertionId: usedId,
});
check(stale.status === 'proposal_not_bound', 'a stale citation is refused');

const edited = await recordRegionBoundAssertion(client, {
  ...base, idempotencyKey: 'b42-adapter-edit', supersedesAssertionId: usedId,
  assertedValue: { description: 'Vegetative debris', unit_type: 'CY', rate_amount: 6.5 },
});
check(edited.status === 'recorded' && edited.inserted, 'edited value recorded');

const read = await loadRegionBoundAssertionRows(client, [DOCUMENT]);
check(read.status === 'ok', 'assertions read back');
const chain = read.rows.filter((row) => row.anchor_key === ANCHOR);
check(chain.length === 2, 'the refused stale citation wrote nothing');
check(chain.find((row) => row.id === usedId)?.review_origin === 'ai_proposed_operator_approved',
  'the database derived approved for the exact value');
check(chain.find((row) => row.id !== usedId)?.review_origin === 'ai_proposed_operator_modified',
  'the database derived modified for the edited value');

const records = await loadValueReadingRecords(client, { organizationId: ORG, documentIds: [DOCUMENT] });
const mine = records.proposals.find((entry) => entry.proposalId === proposal!.proposalId);
check(mine && mine.reading.kind === 'value' && mine.providerModel === null, 'proposal read back');
check(records.reviews.some((review) => review.disposition === 'deferred' && review.proposalRowId === mine!.rowId),
  'deferral read back');

const currentDigests = (digest: string) => new Map([[DOCUMENT, new Map([[8, digest]])]]);
const lifecycle = deriveValueReadingLifecycle({ proposals: records.proposals, reviews: records.reviews,
  assertions: read.rows, currentPageDigests: currentDigests(PAGE_DIGEST) });
check(lifecycle.find((entry) => entry.proposalId === proposal!.proposalId)?.state === 'used_edited',
  'lifecycle derives used_edited from the latest citing assertion');
const telemetry = deriveValueReadingTelemetry({ proposals: records.proposals, reviews: records.reviews, assertions: read.rows });
const outcomes = new Set(telemetry.map((event) => event.outcome));
for (const outcome of ['forgewing_used_unchanged', 'forgewing_used_then_edited', 'forgewing_rejected',
  'operator_entered_without_suggestion'] as const) {
  check(outcomes.has(outcome), `telemetry derives ${outcome} from durable records`);
}

const current = (digest: string): ReadonlyMap<string, CurrentDocumentEvidence> => new Map([[DOCUMENT, {
  pageRepresentationDigestByPage: new Map([[8, digest]]),
  reconstructionRowObservationIds: new Map<string, readonly string[]>(),
}]]);
const resolved = resolveRegionBoundAssertions({ rows: chain, currentEvidenceByDocumentId: current(PAGE_DIGEST) });
const effective = resolved.effective.find((entry) => entry.anchorKey === ANCHOR);
check(effective && effective.provenance.authority === 'human_reviewed'
  && effective.provenance.reviewOrigin === 'ai_proposed_operator_modified'
  && effective.provenance.forgewingProposalId === proposal!.proposalId
  && (effective.value as { rate_amount: number }).rate_amount === 6.5,
  'the effective value is human-reviewed and carries its proposal provenance');
const reprocessed = resolveRegionBoundAssertions({ rows: chain, currentEvidenceByDocumentId: current('c'.repeat(64)) });
check(!reprocessed.effective.some((entry) => entry.anchorKey === ANCHOR), 'a re-extracted page fails closed');

console.log('B4.2 VALUE-READING TYPESCRIPT ADAPTER ROUND TRIP: PASS');
