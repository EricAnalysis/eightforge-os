import { createHash } from 'node:crypto';

import {
  RECORD_REGION_BOUND_ASSERTION_RPC,
  type SourceRegion,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import {
  isRegionAssertionSchemaUnavailable,
  type RegionAssertionClient,
} from '@/lib/server/regionBoundHumanAssertions';

/**
 * The one writer of region-bound human-reviewed values (B3): a human
 * authority path. Writes go only through the SECURITY DEFINER record function,
 * which pins organization, actor, document and chain head inside the database
 * and derives any AI origin itself.
 *
 * Only human-authority routes may import this module. No Forgewing or AI
 * surface may reach it, directly or transitively
 * (lib/architecture/forgewingAuthorityWriterBoundaries.test.ts).
 */

export type RecordRegionAssertionInput = Readonly<{
  customerMappingEvidence?: import('@/lib/customerAdaptation/headerMappingEvidence').CustomerMappingEvidence;
  /**
   * B8.4b: the extraction the trusted server verified this region against,
   * never a client value. The database re-checks it (and prefers a cited
   * proposal's pinned extraction) before recording the historical producer.
   */
  sourceExtractionId?: string | null;
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
  const args: Record<string, unknown> = {
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
    ...(input.customerMappingEvidence ? { p_customer_mapping_evidence: input.customerMappingEvidence } : {}),
  };
  let { data, error } = await admin.rpc(RECORD_REGION_BOUND_ASSERTION_RPC,
    input.sourceExtractionId ? { ...args, p_source_extraction_id: input.sourceExtractionId } : args);
  if (error && input.sourceExtractionId && (error.code === 'PGRST202' || error.code === '42883')) {
    // The provenance parameter is not in this database yet (migration
    // ordering): record the correction exactly as before, with no producer.
    console.warn('[regionBoundHumanAssertionWriter] source extraction provenance unavailable; correction recorded without it');
    ({ data, error } = await admin.rpc(RECORD_REGION_BOUND_ASSERTION_RPC, args));
  }
  if (error) {
    if (isRegionAssertionSchemaUnavailable(error) || error.code === '42883') return { status: 'unavailable' };
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
