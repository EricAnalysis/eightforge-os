import { execFileSync } from 'node:child_process';

import {
  resolveRegionBoundAssertions,
  type CurrentDocumentEvidence,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  loadRegionBoundAssertionRows,
  recordRegionBoundAssertion,
  type RecordRegionAssertionInput,
  type RegionAssertionClient,
} from '@/lib/server/regionBoundHumanAssertions';

/**
 * B3 qualification through the real TypeScript adapter against a freshly
 * replayed database: record, idempotent retry, stale-head refusal, supersession
 * and read-back into the fail-closed resolver. Runs after
 * scripts/sql/verify-region-bound-human-fact-assertions.sql, whose fixtures it reuses.
 */

const databaseUrl = process.env.B3_DATABASE_URL;
if (!databaseUrl) throw new Error('B3_DATABASE_URL is required');

function literal(value: unknown): string {
  if (value == null) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(statement: string): unknown {
  const output = execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '--dbname', databaseUrl!],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
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

const RPC_ARGUMENT_ORDER = [
  'p_organization_id', 'p_actor_id', 'p_source_document_id', 'p_fact_key', 'p_asserted_value', 'p_status',
  'p_reason', 'p_source_artifact_id', 'p_physical_page_number', 'p_source_region',
  'p_page_representation_digest', 'p_parser_version', 'p_source_observation_ids', 'p_original_source_text',
  'p_anchor_key', 'p_review_origin', 'p_forgewing_proposal_id', 'p_supersedes_assertion_id',
  'p_request_digest_sha256',
] as const;
const RPC_CASTS: Record<string, string> = {
  p_organization_id: 'uuid', p_actor_id: 'uuid', p_source_document_id: 'uuid', p_source_artifact_id: 'uuid',
  p_supersedes_assertion_id: 'uuid', p_asserted_value: 'jsonb', p_source_region: 'jsonb',
  p_physical_page_number: 'integer', p_source_observation_ids: 'text[]',
};

/** The minimal Supabase surface the adapter uses, backed by psql as service_role. */
const client: RegionAssertionClient = {
  rpc(fn, args) {
    const values = RPC_ARGUMENT_ORDER.map((name) => {
      const value = args[name];
      if (name === 'p_asserted_value') return value == null ? 'NULL::jsonb' : `${literal(JSON.stringify(value))}::jsonb`;
      return `${sqlValue(value)}${RPC_CASTS[name] ? `::${RPC_CASTS[name]}` : ''}`;
    });
    try {
      const data = runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
        SELECT coalesce(json_agg(r), '[]'::json) FROM public.${fn}(${values.join(', ')}) r;`);
      return Promise.resolve({ data, error: null });
    } catch (error) {
      const text = String((error as { stderr?: unknown }).stderr ?? error);
      const code = /ERROR:\s+([0-9A-Z]{5}):/.exec(text)?.[1]
        ?? (text.includes('must supersede the current chain head') ? '40001'
          : text.includes('request digest collision') ? '23505' : 'P0001');
      return Promise.resolve({ data: null, error: { code, message: text } });
    }
  },
  from(table) {
    return {
      select(columns) {
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

const DOCUMENT = 'b3000000-0000-4000-8000-0000000000d1';
const base: RecordRegionAssertionInput = {
  organizationId: 'b3000000-0000-4000-8000-000000000001',
  actorId: 'b3000000-0000-4000-8000-0000000000a1',
  sourceDocumentId: DOCUMENT,
  factKey: 'contract_rate_row',
  assertedValue: { description: 'Stump grinding', unit_type: 'EA', rate_amount: 45 },
  status: 'active',
  reason: 'Rate cell unreadable; operator read the source page',
  sourceArtifactId: null,
  physicalPageNumber: 9,
  sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 2, y_min: 3, y_max: 4 }] },
  pageRepresentationDigest: 'c'.repeat(64),
  parserVersion: 'priced_schedule_reconstruction_v2',
  sourceObservationIds: ['obs-9a'],
  originalSourceText: '4S.OO',
  anchorKey: 'p9:adapter',
  supersedesAssertionId: null,
  idempotencyKey: 'adapter-first',
};

function check(condition: unknown, label: string): void {
  if (!condition) throw new Error(`B3 ADAPTER FAIL: ${label}`);
}

const first = await recordRegionBoundAssertion(client, base);
check(first.status === 'recorded' && first.inserted, 'first record');
const retry = await recordRegionBoundAssertion(client, base);
check(retry.status === 'recorded' && !retry.inserted && retry.assertionId === (first as { assertionId: string }).assertionId,
  'idempotent retry returns the same assertion');
const competing = await recordRegionBoundAssertion(client, { ...base, idempotencyKey: 'adapter-competing' });
check(competing.status === 'stale_chain_head', 'competing root is reported as a stale chain head');
const correction = await recordRegionBoundAssertion(client, {
  ...base, idempotencyKey: 'adapter-correction', supersedesAssertionId: (first as { assertionId: string }).assertionId,
  assertedValue: { description: 'Stump grinding', unit_type: 'EA', rate_amount: 47.5 },
});
check(correction.status === 'recorded' && correction.inserted, 'correction supersedes the head');

const read = await loadRegionBoundAssertionRows(client, [DOCUMENT]);
check(read.status === 'ok', 'read back');
const chain = read.rows.filter((row) => row.anchor_key === 'p9:adapter');
check(chain.length === 2, 'history kept: both reviews persisted');
const current = (digest: string): ReadonlyMap<string, CurrentDocumentEvidence> => new Map([[DOCUMENT, {
  pageRepresentationDigestByPage: new Map([[9, digest]]),
  pricedRowObservationIds: new Set<string>(),
}]]);
const resolved = resolveRegionBoundAssertions({ rows: chain, currentEvidenceByDocumentId: current('c'.repeat(64)) });
check(resolved.effective.length === 1 && (resolved.effective[0]!.value as { rate_amount: number }).rate_amount === 47.5,
  'the latest review is effective');
check(resolved.effective[0]!.provenance.chainAssertionIds.length === 2, 'effective value carries its full chain');
check(resolved.effective[0]!.provenance.originalSourceText === '4S.OO', 'original source text preserved');
const stale = resolveRegionBoundAssertions({ rows: chain, currentEvidenceByDocumentId: current('d'.repeat(64)) });
check(stale.effective.length === 0 && stale.held[0]?.reason === 'page_representation_changed',
  'a changed page fails closed after reprocessing');

console.log('B3 REGION-BOUND ASSERTION TYPESCRIPT ADAPTER ROUND TRIP: PASS');
