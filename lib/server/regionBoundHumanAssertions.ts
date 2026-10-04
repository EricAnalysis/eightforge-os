import { createHash } from 'node:crypto';

import {
  HUMAN_FACT_ASSERTIONS_TABLE,
  HUMAN_FACT_ASSERTION_SELECT,
  RECORD_REGION_BOUND_ASSERTION_RPC,
  type HumanFactAssertionRow,
  type SourceRegion,
} from '@/lib/humanFactAssertions/regionBoundAssertions';

/**
 * Server-side read and write of region-bound human-reviewed values (B3).
 *
 * EightForge Core: manual operator review never depends on the Forgewing
 * entitlement or on Forgewing being enabled. Writes go only through the
 * SECURITY DEFINER record function, which pins organization, actor, document
 * and chain head inside the database.
 */

type QueryResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
type SelectQuery = QueryResult & {
  in(column: string, values: readonly string[]): SelectQuery;
  eq(column: string, value: unknown): SelectQuery;
  order(column: string, options: { ascending: boolean }): SelectQuery;
};
export type RegionAssertionClient = {
  from(table: string): { select(columns: string): SelectQuery };
  rpc(fn: string, args: Record<string, unknown>): QueryResult;
};

export type RegionAssertionReadResult =
  | Readonly<{ status: 'ok'; rows: readonly HumanFactAssertionRow[] }>
  /** The B3 columns are not deployed yet. Nothing region-bound can exist. */
  | Readonly<{ status: 'unavailable'; rows: readonly [] }>;

/** undefined_table / undefined_column / PostgREST schema-cache misses. */
function isSchemaUnavailable(error: { code?: string; message?: string }): boolean {
  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();
  return code === '42P01' || code === '42703' || code === 'PGRST205' || code === 'PGRST204'
    || (message.includes('human_fact_assertions') && message.includes('schema cache'));
}

export async function loadRegionBoundAssertionRows(
  admin: RegionAssertionClient,
  documentIds: readonly string[],
): Promise<RegionAssertionReadResult> {
  if (documentIds.length === 0) return { status: 'ok', rows: [] };
  const { data, error } = await admin
    .from(HUMAN_FACT_ASSERTIONS_TABLE)
    .select(HUMAN_FACT_ASSERTION_SELECT)
    .in('source_document_id', [...documentIds])
    .eq('source_binding', 'region_bound')
    .order('asserted_at', { ascending: true });
  if (error) {
    if (isSchemaUnavailable(error)) return { status: 'unavailable', rows: [] };
    throw new Error(`Failed to load region-bound human assertions: ${error.message ?? 'unknown error'}`);
  }
  return { status: 'ok', rows: Array.isArray(data) ? data as HumanFactAssertionRow[] : [] };
}

export type RecordRegionAssertionInput = Readonly<{
  organizationId: string;
  actorId: string;
  sourceDocumentId: string;
  factKey: string;
  /** Null only for a withdrawal. */
  assertedValue: unknown;
  status: 'active' | 'withdrawn';
  reason: string;
  sourceArtifactId: string | null;
  physicalPageNumber: number;
  sourceRegion: SourceRegion;
  pageRepresentationDigest: string;
  parserVersion: string | null;
  sourceObservationIds: readonly string[];
  originalSourceText: string | null;
  anchorKey: string;
  supersedesAssertionId: string | null;
  /** Client-supplied idempotency key, scoped to this actor. */
  idempotencyKey: string;
  /**
   * The value-reading proposal the operator used, if any. The record function
   * verifies its binding and decides whether the value was used unchanged or
   * edited; this adapter never chooses an AI origin.
   */
  forgewingProposalId?: string | null;
}>;

export type RecordRegionAssertionResult =
  | Readonly<{ status: 'recorded'; assertionId: string; inserted: boolean }>
  /** Someone else reviewed this target first; reload and supersede the new head. */
  | Readonly<{ status: 'stale_chain_head' }>
  /** The cited proposal does not bind to this exact, current target. Nothing was written. */
  | Readonly<{ status: 'proposal_not_bound'; reason: string }>
  | Readonly<{ status: 'rejected'; reason: string }>
  | Readonly<{ status: 'unavailable' }>;

/** Stable digest of the exact request, so a retry is idempotent and a changed retry collides. */
export function regionAssertionRequestDigest(input: RecordRegionAssertionInput): string {
  return createHash('sha256').update(JSON.stringify([
    'region_bound_human_fact_assertion_v1', input.organizationId, input.actorId, input.idempotencyKey,
  ])).digest('hex');
}

export async function recordRegionBoundAssertion(
  admin: RegionAssertionClient,
  input: RecordRegionAssertionInput,
): Promise<RecordRegionAssertionResult> {
  const { data, error } = await admin.rpc(RECORD_REGION_BOUND_ASSERTION_RPC, {
    p_organization_id: input.organizationId,
    p_actor_id: input.actorId,
    p_source_document_id: input.sourceDocumentId,
    p_fact_key: input.factKey,
    p_asserted_value: input.status === 'withdrawn' ? null : input.assertedValue,
    p_status: input.status,
    p_reason: input.reason,
    p_source_artifact_id: input.sourceArtifactId,
    p_physical_page_number: input.physicalPageNumber,
    p_source_region: input.sourceRegion,
    p_page_representation_digest: input.pageRepresentationDigest,
    p_parser_version: input.parserVersion,
    p_source_observation_ids: [...input.sourceObservationIds],
    p_original_source_text: input.originalSourceText,
    p_anchor_key: input.anchorKey,
    // An input token, not the stored origin: with a cited proposal the
    // database verifies it and derives approved or modified itself.
    p_review_origin: input.forgewingProposalId ? 'ai_proposed' : 'operator_entered',
    p_forgewing_proposal_id: input.forgewingProposalId ?? null,
    p_supersedes_assertion_id: input.supersedesAssertionId,
    p_request_digest_sha256: regionAssertionRequestDigest(input),
  });
  if (error) {
    if (isSchemaUnavailable(error) || error.code === '42883') return { status: 'unavailable' };
    if (error.code === '40001') return { status: 'stale_chain_head' };
    if (input.forgewingProposalId && error.code === '23514') {
      return { status: 'proposal_not_bound', reason: error.message ?? 'proposal does not bind' };
    }
    return { status: 'rejected', reason: error.message ?? 'region assertion rejected' };
  }
  const row = Array.isArray(data) ? data[0] as { assertion_id?: unknown; inserted?: unknown } | undefined : undefined;
  if (!row || typeof row.assertion_id !== 'string') {
    return { status: 'rejected', reason: 'record function returned no assertion' };
  }
  return { status: 'recorded', assertionId: row.assertion_id, inserted: row.inserted === true };
}
