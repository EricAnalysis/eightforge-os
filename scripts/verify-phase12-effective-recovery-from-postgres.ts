import { execFileSync } from 'node:child_process';

import {
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
  resolveEffectiveRecoveryConfirmations,
}
  from '@/lib/server/effectiveRecoveryConfirmations';
import { recordForgewingRecoveryProposalReview }
  from '@/lib/server/forgewingRecoveryReview';

const databaseUrl = process.env.PHASE12_DATABASE_URL;
if (!databaseUrl) throw new Error('PHASE12_DATABASE_URL is required');

function runSql(statement: string): unknown {
  const common = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '--dbname', databaseUrl!];
  const output = process.platform === 'win32'
    ? execFileSync('wsl.exe', [
      '-u', 'root', '-e', '/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/psql', ...common,
    ], { input: statement, encoding: 'utf8' })
    : execFileSync('psql', common, { input: statement, encoding: 'utf8' });
  const text = output.trim();
  return text.length === 0 ? null : JSON.parse(text);
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

const allowedTables: ReadonlySet<string> = new Set([
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
]);

const admin = {
  async rpc(name: string, args: Record<string, unknown>) {
    try {
      if (name !== 'record_forgewing_recovery_proposal_review') {
        throw new Error(`unexpected RPC ${name}`);
      }
      const row = runSql(`SET ROLE service_role; SET request.jwt.claim.role='service_role';
        SELECT row_to_json(result) FROM public.${name}(
          ${literal(args.p_organization_id)}::uuid,
          ${literal(args.p_proposal_id)},
          ${literal(args.p_proposal_digest_sha256)},
          ${literal(args.p_reviewer_actor_id)}::uuid,
          ${literal(args.p_disposition)},
          ${literal(args.p_confirmed_observation_id)},
          ${literal(args.p_reviewer_rationale)},
          ${literal(args.p_review_request_digest_sha256)}
        ) AS result;`);
      return { data: row, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : 'database error' } };
    }
  },
  from(table: string) {
    if (!allowedTables.has(table)) throw new Error(`unexpected table ${table}`);
    let selectedColumns = '';
    const filters: string[] = [];
    const chain = {
      select(columns: string) {
        if (!/^[a-z0-9_, ]+$/.test(columns)) throw new Error('unsafe verifier columns');
        selectedColumns = columns;
        return chain;
      },
      eq(column: string, value: unknown) {
        if (!/^[a-z0-9_]+$/.test(column)) throw new Error('unsafe verifier column');
        filters.push(`${column}=${literal(value)}`);
        return chain;
      },
      in(column: string, values: readonly unknown[]) {
        if (!/^[a-z0-9_]+$/.test(column) || values.length === 0) {
          throw new Error('unsafe verifier IN filter');
        }
        filters.push(`${column} IN (${values.map(literal).join(',')})`);
        return chain;
      },
      then<R>(onfulfilled: (value: { data: unknown; error: null }) => R) {
        if (selectedColumns.length === 0) throw new Error('verifier query is missing select');
        const where = filters.length === 0 ? 'TRUE' : filters.join(' AND ');
        const data = runSql(`SELECT coalesce(json_agg(result), '[]'::json)
          FROM (SELECT ${selectedColumns} FROM public.${table} WHERE ${where}) AS result;`);
        return Promise.resolve(onfulfilled({ data, error: null }));
      },
    };
    return chain;
  },
};

const organizationId = 'a1000000-0000-4000-8000-000000000001';
const reviewerActorId = 'a6000000-0000-4000-8000-000000000001';
const sourceDocumentId = 'a2000000-0000-4000-8000-000000000001';
const sourceArtifactId = 'a3000000-0000-4000-8000-000000000001';
const fixture = runSql(`SELECT row_to_json(result) FROM (
  SELECT proposal_id, proposal_digest_sha256
  FROM public.${RECOVERY_PROPOSAL_TABLE}
  WHERE proposal_digest_sha256=repeat('f',64)
) AS result;`) as { proposal_id: string; proposal_digest_sha256: string };

if (!fixture?.proposal_id) throw new Error('Phase 12 TypeScript verifier proposal is missing');

const input = {
  proposalId: fixture.proposal_id,
  proposalDigestSha256: fixture.proposal_digest_sha256,
  disposition: 'accepted' as const,
  confirmedObservationId: 'obs:selected',
  reviewerRationale: 'Accepted through the real Phase 12 server seam.',
};
const actor = { actorId: reviewerActorId, organizationId };
const recorded = await recordForgewingRecoveryProposalReview(input, actor, { admin });
if (!recorded.ok || !recorded.inserted || recorded.review.confirmedRawText !== '8.75') {
  throw new Error(`real review persistence failed: ${recorded.ok ? 'unexpected receipt' : recorded.code}`);
}
const replay = await recordForgewingRecoveryProposalReview(input, actor, { admin });
if (!replay.ok || replay.inserted || replay.review.reviewId !== recorded.review.reviewId
  || replay.review.reviewVersion !== recorded.review.reviewVersion) {
  throw new Error('real review idempotency failed');
}
const stored = runSql(`SELECT row_to_json(result) FROM (
  SELECT organization_id, reviewer_actor_id, review_request_digest_sha256
  FROM public.${RECOVERY_REVIEW_TABLE}
  WHERE id=${literal(recorded.review.reviewId)}::uuid
) AS result;`) as Record<string, unknown>;
if (stored.organization_id !== organizationId || stored.reviewer_actor_id !== reviewerActorId
  || stored.review_request_digest_sha256 !== recorded.review.reviewRequestDigestSha256) {
  throw new Error('server-derived recovery review authority was not persisted exactly');
}

const injected = await recordForgewingRecoveryProposalReview(
  { ...input, organizationId: 'b1000000-0000-4000-8000-000000000001' }, actor, { admin });
if (injected.ok || injected.code !== 'invalid_review') {
  throw new Error('browser-supplied organization was not rejected');
}

const resolved = await resolveEffectiveRecoveryConfirmations(
  { organizationId, sourceDocumentId, sourceArtifactId }, { admin });
if (resolved.status !== 'ok') throw new Error(`resolver failed: ${resolved.status}`);
const dispositions = resolved.confirmations.map((entry) => entry.reviewDisposition).sort();
if (JSON.stringify(dispositions) !== JSON.stringify(['accepted', 'accepted', 'accepted', 'modified'])
  || resolved.diagnostics.length !== 1
  || resolved.diagnostics[0]?.code !== 'ambiguous_recovery_authority') {
  throw new Error('effective recovery review/concurrency/ambiguity matrix failed');
}
const ambiguousProposal = runSql(`SELECT to_json(proposal_id) FROM public.${RECOVERY_PROPOSAL_TABLE}
  WHERE proposal_digest_sha256=repeat('e',64);`);
if (resolved.confirmations.some((entry) => entry.proposalId === ambiguousProposal)) {
  throw new Error('resolver used a latest approving review instead of failing closed');
}
const crossTenant = await resolveEffectiveRecoveryConfirmations({
  organizationId: 'b1000000-0000-4000-8000-000000000001',
  sourceDocumentId: 'b2000000-0000-4000-8000-000000000001',
  sourceArtifactId: 'b3000000-0000-4000-8000-000000000001',
}, { admin });
if (crossTenant.status !== 'ok' || crossTenant.confirmations.length !== 0
  || crossTenant.diagnostics.length !== 0) {
  throw new Error('cross-tenant resolver query was not empty');
}

process.stdout.write('PHASE 12 EFFECTIVE RECOVERY REAL POSTGRESQL QUALIFICATION: PASS\n');
