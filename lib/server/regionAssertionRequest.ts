import {
  CONTRACT_RATE_ROW_FACT_KEY,
  parseReviewedRateRowValue,
  verifyRegionEvidence,
  type HumanFactAssertionRow,
  type SourceRegion,
} from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { RecordRegionAssertionInput } from '@/lib/server/regionBoundHumanAssertions';

/**
 * The region-bound assertion write contract (B3), shared by the record route
 * and the B5-C impact preview. The preview validates a candidate exactly as
 * the write would, then builds the row exactly as the record function would
 * insert it, so what it previews is the write itself and nothing else.
 */

const DIGEST = /^[0-9a-f]{64}$/;

function nonEmpty(value: unknown, max = 4000): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
}

function parseRegion(value: unknown): SourceRegion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.coordinate_space !== 'string' || !Array.isArray(record.boxes)
    || record.boxes.length === 0 || record.boxes.length > 64) return null;
  const boxes = record.boxes.map((entry) => {
    const box = entry as Record<string, unknown> | null;
    const values = [box?.x_min, box?.x_max, box?.y_min, box?.y_max];
    if (!values.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    const [x_min, x_max, y_min, y_max] = values as number[];
    return x_min! <= x_max! && y_min! <= y_max! ? { x_min: x_min!, x_max: x_max!, y_min: y_min!, y_max: y_max! } : null;
  });
  if (boxes.some((box) => box == null)) return null;
  return { coordinate_space: record.coordinate_space, boxes: boxes as SourceRegion['boxes'] };
}

export type ParsedRegionAssertionRequest = Readonly<{
  factKey: string;
  status: 'active' | 'withdrawn';
  value: unknown;
  reason: string;
  anchorKey: string;
  idempotencyKey: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  sourceRegion: SourceRegion;
  sourceObservationIds: readonly string[];
  supersedesAssertionId: string | null;
}>;

export type RegionAssertionRequestRejection = Readonly<{ ok: false; status: 400 | 409; error: string; code?: string }>;

/** Shape checks the record route applies before it reads anything. */
export function parseRegionAssertionRequest(body: unknown):
  | Readonly<{ ok: true; request: ParsedRegionAssertionRequest }>
  | RegionAssertionRequestRejection {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'Invalid request body' };
  const record = body as Record<string, unknown>;
  const factKey = nonEmpty(record.factKey, 200);
  const reason = nonEmpty(record.reason);
  const anchorKey = nonEmpty(record.anchorKey, 500);
  const idempotencyKey = nonEmpty(record.idempotencyKey, 200);
  const status = record.status === 'withdrawn' ? 'withdrawn' as const : 'active' as const;
  const page = record.physicalPageNumber;
  const digest = record.pageRepresentationDigest;
  const region = parseRegion(record.sourceRegion);
  const observationIds = Array.isArray(record.sourceObservationIds)
    && record.sourceObservationIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)
    && record.sourceObservationIds.length <= 500
    ? record.sourceObservationIds as string[] : null;
  const supersedes = record.supersedesAssertionId == null ? null : nonEmpty(record.supersedesAssertionId, 64);

  if (!factKey || !reason || !anchorKey || !idempotencyKey || !region || !observationIds
    || typeof page !== 'number' || !Number.isInteger(page) || page < 1
    || typeof digest !== 'string' || !DIGEST.test(digest)
    || (record.supersedesAssertionId != null && !supersedes)) {
    return { ok: false, status: 400, error: 'factKey, reason, anchorKey, idempotencyKey, sourceRegion, sourceObservationIds, '
      + 'physicalPageNumber and pageRepresentationDigest are required' };
  }
  if (status === 'withdrawn' && !supersedes) return { ok: false, status: 400, error: 'A withdrawal must supersede an assertion' };
  const value = status === 'withdrawn' ? null : record.value;
  if (status === 'active') {
    if (value === undefined || value === null) return { ok: false, status: 400, error: 'value is required' };
    if (factKey === CONTRACT_RATE_ROW_FACT_KEY && !parseReviewedRateRowValue(value)) {
      return { ok: false, status: 400, error: 'A reviewed rate row needs description, unit_type and a numeric rate_amount' };
    }
    // Final authority over machine rows needs a source-bound target.
    if (factKey === CONTRACT_RATE_ROW_FACT_KEY && observationIds.length === 0) {
      return { ok: false, status: 400, error: 'A reviewed rate row must cite the source observations it reviews' };
    }
  }
  return {
    ok: true,
    request: {
      factKey, status, value, reason, anchorKey, idempotencyKey,
      physicalPageNumber: page, pageRepresentationDigest: digest, sourceRegion: region,
      sourceObservationIds: observationIds, supersedesAssertionId: supersedes,
    },
  };
}

/**
 * Binds a parsed request to the current extraction and the actor: the record
 * input the write path hands to the record function.
 */
export function prepareRegionAssertionRecord(params: Readonly<{
  request: ParsedRegionAssertionRequest;
  organizationId: string;
  actorId: string;
  documentId: string;
  extractionData: unknown;
}>):
  | Readonly<{ ok: true; input: RecordRegionAssertionInput }>
  | RegionAssertionRequestRejection {
  const { request } = params;
  const evidence = verifyRegionEvidence({
    extractionData: params.extractionData,
    physicalPageNumber: request.physicalPageNumber,
    pageRepresentationDigest: request.pageRepresentationDigest,
    sourceObservationIds: request.sourceObservationIds,
  });
  if (evidence.status === 'rejected') {
    return { ok: false, status: 409, code: evidence.reason,
      error: 'The source region no longer matches the current extraction; reload the page and review again.' };
  }
  return {
    ok: true,
    input: {
      organizationId: params.organizationId,
      actorId: params.actorId,
      sourceDocumentId: params.documentId,
      factKey: request.factKey,
      assertedValue: request.value,
      status: request.status,
      reason: request.reason,
      sourceArtifactId: evidence.sourceArtifactId,
      physicalPageNumber: request.physicalPageNumber,
      sourceRegion: request.sourceRegion,
      pageRepresentationDigest: request.pageRepresentationDigest,
      parserVersion: evidence.parserVersion,
      sourceObservationIds: request.sourceObservationIds,
      originalSourceText: evidence.originalSourceText,
      anchorKey: request.anchorKey,
      supersedesAssertionId: request.supersedesAssertionId,
      idempotencyKey: request.idempotencyKey,
    },
  };
}

/**
 * The record function's chain rule, over rows already read: one linear chain
 * per (organization, document, fact key, anchor); a new row must supersede
 * exactly the current head. Mirrors `record_region_bound_human_fact_assertion`.
 */
export function regionAssertionChainCheck(
  rows: readonly HumanFactAssertionRow[],
  input: RecordRegionAssertionInput,
): 'ok' | 'stale_chain_head' | 'ambiguous_chain' {
  const chain = rows.filter((row) => row.organization_id === input.organizationId
    && row.source_binding === 'region_bound'
    && row.source_document_id === input.sourceDocumentId
    && row.fact_key === input.factKey
    && row.anchor_key === input.anchorKey);
  const superseded = new Set(rows.filter((row) => row.organization_id === input.organizationId)
    .flatMap((row) => (row.supersedes_assertion_id ? [row.supersedes_assertion_id] : [])));
  const heads = chain.filter((row) => !superseded.has(row.id));
  if (heads.length > 1) return 'ambiguous_chain';
  const head = heads.length === 1 ? heads[0]!.id : null;
  return input.supersedesAssertionId === head ? 'ok' : 'stale_chain_head';
}

/**
 * The row the record function would insert for this input. Ephemeral: used
 * only to derive an in-memory Validator snapshot, never written.
 */
export function hypotheticalRegionAssertionRow(
  input: RecordRegionAssertionInput,
  identity: Readonly<{ id: string; assertedAt: string }>,
): HumanFactAssertionRow {
  return {
    id: identity.id,
    organization_id: input.organizationId,
    source_document_id: input.sourceDocumentId,
    fact_key: input.factKey,
    asserted_value: input.status === 'withdrawn' ? null : input.assertedValue,
    source_binding: 'region_bound',
    supersedes_assertion_id: input.supersedesAssertionId,
    actor_id: input.actorId,
    reason: input.reason.trim(),
    asserted_at: identity.assertedAt,
    status: input.status,
    source_artifact_id: input.sourceArtifactId,
    physical_page_number: input.physicalPageNumber,
    source_region: input.sourceRegion,
    page_representation_digest: input.pageRepresentationDigest,
    parser_version: input.parserVersion,
    source_observation_ids: [...input.sourceObservationIds],
    original_source_text: input.originalSourceText,
    anchor_key: input.anchorKey,
    review_origin: 'operator_entered',
    forgewing_proposal_id: null,
  };
}
