import { createHash } from 'node:crypto';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  CONTRACT_RATE_ROW_FACT_KEY,
  parseReviewedRateRowValue,
  type ReviewedRateRowValue,
  type SourceRegion,
} from '@/lib/humanFactAssertions/regionBoundAssertions';

/**
 * Value-reading proposals (Forgewing B4.2): the durable, non-authoritative
 * record of a value Forgewing read for an unresolved priced line.
 *
 * A proposal is AI_PROPOSED. It is stored as a version 3 row on the existing
 * immutable proposal table and never becomes truth on its own. The only road
 * from a proposal to truth is an operator's region-bound human fact assertion
 * that cites it: the database verifies the binding and derives whether the
 * operator used the value unchanged or edited it. Reviews here record only
 * rejected and deferred; usage is never a review.
 *
 * This module stores and reads. It calls no provider and grants nothing.
 */

export const VALUE_READING_RECOVERY_TYPE = 'priced_value_reading' as const;
export const VALUE_READING_PROPOSAL_VERSION = 3 as const;
export const VALUE_READING_SCHEMA_VERSION = 'forgewing-value-reading-proposal-v3' as const;
export const VALUE_READING_PROPOSAL_TABLE = 'forgewing_recovery_proposals' as const;
export const VALUE_READING_REVIEW_TABLE = 'forgewing_recovery_proposal_reviews' as const;
export const RECORD_VALUE_READING_PROPOSAL_RPC = 'record_forgewing_value_reading_proposal' as const;
export const RECORD_VALUE_READING_REVIEW_RPC = 'record_forgewing_value_reading_review' as const;
export const VALUE_READING_PROPOSAL_ID_PATTERN = /^forgewing-proposal-value-reading-[0-9a-f]{64}$/;

const DIGEST = /^[0-9a-f]{64}$/;
const RATIONALE_MAX = 500;

/**
 * Recovery readers (review queue, effective confirmations, evaluation prior
 * state) read versions 1 and 2 only. A value reading is never a recovery
 * confirmation candidate.
 */
export function isValueReadingProposalRow(row: Readonly<Record<string, unknown>>): boolean {
  return row.proposal_version === VALUE_READING_PROPOSAL_VERSION
    || row.recovery_type === VALUE_READING_RECOVERY_TYPE;
}

export type ValueReadingBasis = 'region_image' | 'region_image_with_text_excerpts';

export type ValueReading =
  | Readonly<{ kind: 'value'; rateRow: ReviewedRateRowValue }>
  | Readonly<{ kind: 'unreadable' }>;

/** Copied from the server's resolution entry target, never from a client. */
export type ValueReadingBinding = Readonly<{
  organizationId: string;
  projectId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  extractionSnapshotId: string;
  /** For audit only. Never used for binding. */
  resolutionCaseId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  factKey: typeof CONTRACT_RATE_ROW_FACT_KEY;
  anchorKey: string;
  sourceObservationIds: readonly string[];
  sourceRegion: SourceRegion;
}>;

export type ValueReadingProposalDraft = Readonly<{
  binding: ValueReadingBinding;
  reading: ValueReading;
  readingBasis: ValueReadingBasis;
  /** Null until a provider produces readings. */
  providerModel: string | null;
  promptTemplateId: string;
  promptTemplateVersion: string;
  requestDigestSha256: string;
  outputDigestSha256: string;
  rationale: string;
}>;

export type ValueReadingProposal = ValueReadingProposalDraft & Readonly<{
  proposalId: string;
  proposalDigestSha256: string;
  proposalVersion: typeof VALUE_READING_PROPOSAL_VERSION;
  schemaVersion: typeof VALUE_READING_SCHEMA_VERSION;
  authority: 'non_authoritative';
  requiresHumanReview: true;
}>;

/** One line, no control characters, at most 500 characters. Null when nothing is left. */
export function cleanValueReadingRationale(text: string): string | null {
  const cleaned = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length <= RATIONALE_MAX ? cleaned : cleaned.slice(0, RATIONALE_MAX).trimEnd();
}

function nonBlank(value: string, max: number): boolean {
  return value.trim().length > 0 && value.trim().length <= max;
}

function validRegion(region: SourceRegion): boolean {
  return typeof region.coordinate_space === 'string' && region.boxes.length >= 1 && region.boxes.length <= 64
    && region.boxes.every((box) => [box.x_min, box.x_max, box.y_min, box.y_max].every(Number.isFinite)
      && box.x_min <= box.x_max && box.y_min <= box.y_max);
}

function normalReading(reading: ValueReading): ValueReading | null {
  if (reading.kind === 'unreadable') return { kind: 'unreadable' };
  const rateRow = parseReviewedRateRowValue(reading.rateRow);
  return rateRow ? { kind: 'value', rateRow } : null;
}

/**
 * The immutable proposal for one reading. Pure: identical drafts give the same
 * proposal and digest. Null when the draft is out of contract.
 */
export function buildValueReadingProposal(draft: ValueReadingProposalDraft): ValueReadingProposal | null {
  const { binding } = draft;
  const reading = normalReading(draft.reading);
  const rationale = cleanValueReadingRationale(draft.rationale);
  const observationIds = binding.sourceObservationIds;
  if (!reading || !rationale
    || binding.factKey !== CONTRACT_RATE_ROW_FACT_KEY
    || !DIGEST.test(binding.pageRepresentationDigest)
    || !DIGEST.test(draft.requestDigestSha256) || !DIGEST.test(draft.outputDigestSha256)
    || !Number.isInteger(binding.physicalPageNumber) || binding.physicalPageNumber < 1
    || ![binding.organizationId, binding.projectId, binding.sourceDocumentId, binding.sourceArtifactId,
      binding.extractionSnapshotId].every((value) => nonBlank(value, 200))
    || !nonBlank(binding.resolutionCaseId, 300) || !nonBlank(binding.anchorKey, 500)
    || observationIds.length < 1 || observationIds.length > 500
    || observationIds.some((id) => !nonBlank(id, 200)) || new Set(observationIds).size !== observationIds.length
    || !validRegion(binding.sourceRegion)
    || (draft.providerModel !== null && !nonBlank(draft.providerModel, 200))
    || !nonBlank(draft.promptTemplateId, 200) || !nonBlank(draft.promptTemplateVersion, 200)
    || (draft.readingBasis !== 'region_image' && draft.readingBasis !== 'region_image_with_text_excerpts')) {
    return null;
  }
  const content = {
    proposalVersion: VALUE_READING_PROPOSAL_VERSION,
    schemaVersion: VALUE_READING_SCHEMA_VERSION,
    binding: { ...binding, sourceObservationIds: [...observationIds] },
    reading,
    readingBasis: draft.readingBasis,
    providerModel: draft.providerModel,
    promptTemplateId: draft.promptTemplateId,
    promptTemplateVersion: draft.promptTemplateVersion,
    requestDigestSha256: draft.requestDigestSha256,
    outputDigestSha256: draft.outputDigestSha256,
    rationale,
  };
  const digest = hashCanonical(content);
  return {
    ...content,
    proposalId: `forgewing-proposal-value-reading-${digest}`,
    proposalDigestSha256: digest,
    authority: 'non_authoritative',
    requiresHumanReview: true,
  };
}

type QueryResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
type SelectQuery = QueryResult & {
  eq(column: string, value: unknown): SelectQuery;
  in(column: string, values: readonly string[]): SelectQuery;
};
export type ValueReadingClient = {
  from(table: string): { select(columns: string): SelectQuery };
  rpc(fn: string, args: Record<string, unknown>): QueryResult;
};

export type RecordValueReadingResult =
  | Readonly<{ status: 'recorded'; proposalRowId: string; inserted: boolean }>
  /** The same request already produced a different reading. Never a second proposal. */
  | Readonly<{ status: 'collision' }>
  | Readonly<{ status: 'rejected'; reason: string }>;

export async function recordValueReadingProposal(
  admin: ValueReadingClient,
  proposal: ValueReadingProposal,
): Promise<RecordValueReadingResult> {
  const { binding, reading } = proposal;
  const { data, error } = await admin.rpc(RECORD_VALUE_READING_PROPOSAL_RPC, {
    p_organization_id: binding.organizationId,
    p_project_id: binding.projectId,
    p_source_document_id: binding.sourceDocumentId,
    p_source_artifact_id: binding.sourceArtifactId,
    p_extraction_snapshot_id: binding.extractionSnapshotId,
    p_resolution_case_id: binding.resolutionCaseId,
    p_physical_page_number: binding.physicalPageNumber,
    p_page_representation_digest: binding.pageRepresentationDigest,
    p_fact_key: binding.factKey,
    p_anchor_key: binding.anchorKey,
    p_source_observation_ids: [...binding.sourceObservationIds],
    p_source_region: binding.sourceRegion,
    p_reading_outcome: reading.kind,
    p_proposed_rate_row: reading.kind === 'value' ? reading.rateRow : null,
    p_reading_basis: proposal.readingBasis,
    p_provider_model: proposal.providerModel,
    p_prompt_template_id: proposal.promptTemplateId,
    p_prompt_template_version: proposal.promptTemplateVersion,
    p_schema_version: proposal.schemaVersion,
    p_request_digest_sha256: proposal.requestDigestSha256,
    p_output_digest_sha256: proposal.outputDigestSha256,
    p_proposal_digest_sha256: proposal.proposalDigestSha256,
    p_proposal_id: proposal.proposalId,
    p_rationale: proposal.rationale,
  });
  if (error) {
    if (error.code === '23505') return { status: 'collision' };
    return { status: 'rejected', reason: error.message ?? 'value-reading proposal rejected' };
  }
  const row = Array.isArray(data) ? data[0] as { proposal_row_id?: unknown; inserted?: unknown } | undefined : undefined;
  if (!row || typeof row.proposal_row_id !== 'string') return { status: 'rejected', reason: 'record function returned no proposal' };
  return { status: 'recorded', proposalRowId: row.proposal_row_id, inserted: row.inserted === true };
}

export type ValueReadingReviewDisposition = 'rejected' | 'deferred';

export type RecordValueReadingReviewInput = Readonly<{
  organizationId: string;
  reviewerActorId: string;
  proposalId: string;
  proposalDigestSha256: string;
  disposition: ValueReadingReviewDisposition;
  rationale: string;
  /** Client-supplied idempotency key, scoped to this reviewer. */
  idempotencyKey: string;
}>;

export type RecordValueReadingReviewResult =
  | Readonly<{ status: 'recorded'; reviewId: string; reviewVersion: number; inserted: boolean }>
  | Readonly<{ status: 'rejected'; reason: string }>;

export function valueReadingReviewRequestDigest(input: RecordValueReadingReviewInput): string {
  return createHash('sha256').update(JSON.stringify([
    'value_reading_review_v1', input.organizationId, input.reviewerActorId, input.idempotencyKey,
  ])).digest('hex');
}

/** Records a rejection or deferral. Neither ever authorizes a value. */
export async function recordValueReadingReview(
  admin: ValueReadingClient,
  input: RecordValueReadingReviewInput,
): Promise<RecordValueReadingReviewResult> {
  if (input.disposition !== 'rejected' && input.disposition !== 'deferred') {
    return { status: 'rejected', reason: 'a value reading is reviewed only as rejected or deferred' };
  }
  const { data, error } = await admin.rpc(RECORD_VALUE_READING_REVIEW_RPC, {
    p_organization_id: input.organizationId,
    p_proposal_id: input.proposalId,
    p_proposal_digest_sha256: input.proposalDigestSha256,
    p_reviewer_actor_id: input.reviewerActorId,
    p_disposition: input.disposition,
    p_reviewer_rationale: input.rationale,
    p_review_request_digest_sha256: valueReadingReviewRequestDigest(input),
  });
  if (error) return { status: 'rejected', reason: error.message ?? 'value-reading review rejected' };
  const row = Array.isArray(data)
    ? data[0] as { review_id?: unknown; review_version?: unknown; inserted?: unknown } | undefined : undefined;
  if (!row || typeof row.review_id !== 'string' || typeof row.review_version !== 'number') {
    return { status: 'rejected', reason: 'record function returned no review' };
  }
  return { status: 'recorded', reviewId: row.review_id, reviewVersion: row.review_version, inserted: row.inserted === true };
}

/** A stored proposal, as read back. */
export type ValueReadingProposalRecord = Readonly<{
  rowId: string;
  proposalId: string;
  proposalDigestSha256: string;
  binding: ValueReadingBinding;
  reading: ValueReading;
  readingBasis: ValueReadingBasis;
  providerModel: string | null;
  rationale: string;
  createdAt: string;
}>;

export type ValueReadingReviewRecord = Readonly<{
  id: string;
  proposalRowId: string;
  reviewVersion: number;
  reviewerActorId: string;
  disposition: ValueReadingReviewDisposition;
  createdAt: string;
}>;

export const VALUE_READING_PROPOSAL_SELECT = [
  'id', 'proposal_id', 'proposal_digest_sha256', 'proposal_version', 'recovery_type', 'organization_id',
  'project_id', 'source_document_id', 'source_artifact_id', 'extraction_snapshot_id', 'resolution_case_id',
  'physical_page_number', 'page_representation_digest', 'fact_key', 'anchor_key', 'source_observation_ids',
  'source_region', 'reading_outcome', 'proposed_rate_row', 'reading_basis', 'provider_model', 'rationale',
  'authority', 'created_at',
].join(', ');

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseRegion(value: unknown): SourceRegion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.coordinate_space !== 'string' || !Array.isArray(record.boxes)) return null;
  const boxes = record.boxes.flatMap((entry) => {
    const box = entry as Record<string, unknown> | null;
    const values = [box?.x_min, box?.x_max, box?.y_min, box?.y_max];
    return values.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? [{ x_min: values[0] as number, x_max: values[1] as number, y_min: values[2] as number, y_max: values[3] as number }]
      : [];
  });
  return boxes.length === record.boxes.length && boxes.length > 0
    ? { coordinate_space: record.coordinate_space, boxes } : null;
}

/** Parses one stored row. Null for anything that is not a well-formed value reading. */
export function parseValueReadingProposalRow(row: Readonly<Record<string, unknown>>): ValueReadingProposalRecord | null {
  if (row.proposal_version !== VALUE_READING_PROPOSAL_VERSION || row.recovery_type !== VALUE_READING_RECOVERY_TYPE
    || row.authority !== 'non_authoritative' || row.fact_key !== CONTRACT_RATE_ROW_FACT_KEY) return null;
  const rowId = str(row.id);
  const proposalId = str(row.proposal_id);
  const digest = str(row.proposal_digest_sha256);
  const region = parseRegion(row.source_region);
  const observationIds = Array.isArray(row.source_observation_ids)
    && row.source_observation_ids.every((id) => typeof id === 'string') ? row.source_observation_ids as string[] : null;
  const readingBasis = row.reading_basis === 'region_image' || row.reading_basis === 'region_image_with_text_excerpts'
    ? row.reading_basis : null;
  const rateRow = row.reading_outcome === 'value' ? parseReviewedRateRowValue(row.proposed_rate_row) : null;
  const reading: ValueReading | null = row.reading_outcome === 'unreadable' ? { kind: 'unreadable' }
    : rateRow ? { kind: 'value', rateRow } : null;
  const fields = [row.organization_id, row.project_id, row.source_document_id, row.source_artifact_id,
    row.extraction_snapshot_id, row.resolution_case_id, row.page_representation_digest, row.anchor_key,
    row.rationale, row.created_at].map(str);
  if (!rowId || !proposalId || !VALUE_READING_PROPOSAL_ID_PATTERN.test(proposalId) || !digest || !region
    || !observationIds || !readingBasis || !reading || fields.some((field) => field === null)
    || typeof row.physical_page_number !== 'number') return null;
  const [organizationId, projectId, sourceDocumentId, sourceArtifactId, extractionSnapshotId, resolutionCaseId,
    pageRepresentationDigest, anchorKey, rationale, createdAt] = fields as string[];
  return {
    rowId, proposalId, proposalDigestSha256: digest,
    binding: {
      organizationId: organizationId!, projectId: projectId!, sourceDocumentId: sourceDocumentId!,
      sourceArtifactId: sourceArtifactId!, extractionSnapshotId: extractionSnapshotId!,
      resolutionCaseId: resolutionCaseId!, physicalPageNumber: row.physical_page_number,
      pageRepresentationDigest: pageRepresentationDigest!, factKey: CONTRACT_RATE_ROW_FACT_KEY,
      anchorKey: anchorKey!, sourceObservationIds: observationIds, sourceRegion: region,
    },
    reading, readingBasis, providerModel: str(row.provider_model), rationale: rationale!, createdAt: createdAt!,
  };
}

export type ValueReadingRecords = Readonly<{
  proposals: readonly ValueReadingProposalRecord[];
  reviews: readonly ValueReadingReviewRecord[];
}>;

/** Every value-reading proposal for these documents, with its rejections and deferrals. */
export async function loadValueReadingRecords(
  admin: ValueReadingClient,
  query: Readonly<{ organizationId: string; documentIds: readonly string[] }>,
): Promise<ValueReadingRecords> {
  if (query.documentIds.length === 0) return { proposals: [], reviews: [] };
  const proposalRead = await admin.from(VALUE_READING_PROPOSAL_TABLE).select(VALUE_READING_PROPOSAL_SELECT)
    .eq('organization_id', query.organizationId)
    .eq('proposal_version', VALUE_READING_PROPOSAL_VERSION)
    .in('source_document_id', [...query.documentIds]);
  if (proposalRead.error) throw new Error(`Failed to load value readings: ${proposalRead.error.message ?? 'unknown error'}`);
  const proposals = (Array.isArray(proposalRead.data) ? proposalRead.data : [])
    .flatMap((row) => {
      const parsed = row && typeof row === 'object' ? parseValueReadingProposalRow(row as Record<string, unknown>) : null;
      return parsed && parsed.binding.organizationId === query.organizationId ? [parsed] : [];
    });
  if (proposals.length === 0) return { proposals: [], reviews: [] };
  const reviewRead = await admin.from(VALUE_READING_REVIEW_TABLE)
    .select('id, proposal_row_id, review_version, reviewer_actor_id, disposition, created_at')
    .eq('organization_id', query.organizationId)
    .in('proposal_row_id', proposals.map((proposal) => proposal.rowId));
  if (reviewRead.error) throw new Error(`Failed to load value-reading reviews: ${reviewRead.error.message ?? 'unknown error'}`);
  const reviews = (Array.isArray(reviewRead.data) ? reviewRead.data : []).flatMap((entry): ValueReadingReviewRecord[] => {
    const row = entry as Record<string, unknown> | null;
    const id = str(row?.id);
    const proposalRowId = str(row?.proposal_row_id);
    const reviewer = str(row?.reviewer_actor_id);
    const createdAt = str(row?.created_at);
    const disposition: ValueReadingReviewDisposition | null = row?.disposition === 'rejected' ? 'rejected'
      : row?.disposition === 'deferred' ? 'deferred' : null;
    return id && proposalRowId && reviewer && createdAt && disposition && typeof row?.review_version === 'number'
      ? [{ id, proposalRowId, reviewVersion: row.review_version, reviewerActorId: reviewer, disposition, createdAt }]
      : [];
  });
  return { proposals, reviews };
}

/** The stored proposal that already answered this exact request, if any. Reuse first, call never. */
export async function loadValueReadingProposalByRequestDigest(
  admin: ValueReadingClient,
  query: Readonly<{ organizationId: string; requestDigestSha256: string }>,
): Promise<ValueReadingProposalRecord | null> {
  const read = await admin.from(VALUE_READING_PROPOSAL_TABLE).select(VALUE_READING_PROPOSAL_SELECT)
    .eq('organization_id', query.organizationId)
    .eq('proposal_version', VALUE_READING_PROPOSAL_VERSION)
    .eq('request_digest_sha256', query.requestDigestSha256);
  if (read.error) throw new Error(`Failed to read value reading: ${read.error.message ?? 'unknown error'}`);
  const parsed = (Array.isArray(read.data) ? read.data : []).flatMap((row) => {
    const record = row && typeof row === 'object' ? parseValueReadingProposalRow(row as Record<string, unknown>) : null;
    return record && record.binding.organizationId === query.organizationId ? [record] : [];
  });
  return parsed[0] ?? null;
}

export const RECORD_VALUE_READING_OUTCOME_RPC = 'record_forgewing_recovery_generation_outcome' as const;

/** Why a value-reading attempt ended without a proposal. Non-authoritative; explains only. */
export type ValueReadingOutcomeCode =
  | 'entitlement_missing'
  | 'data_policy_not_approved'
  | 'budget_exhausted'
  | 'provider_failed'
  | 'structured_output_invalid'
  | 'deterministic_validation_failed'
  | 'evidence_binding_failed'
  | 'proposal_persist_failed';

export type ValueReadingOutcomeReason =
  | 'no_entitlement' | 'entitlement_revoked'
  | 'data_policy_not_approved' | 'data_policy_revoked'
  | 'budget_exhausted' | 'budget_not_configured'
  | 'provider_timeout' | 'provider_truncated_output' | 'provider_error'
  | 'invalid_json' | 'invalid_proposal'
  | 'proposal_value_validation_failed'
  | 'binding_changed' | 'region_image_unavailable'
  | 'write_failed';

export type ValueReadingOutcome = Readonly<{
  binding: Pick<ValueReadingBinding, 'organizationId' | 'sourceDocumentId' | 'sourceArtifactId'
    | 'extractionSnapshotId' | 'physicalPageNumber' | 'pageRepresentationDigest'>;
  requestDigestSha256: string;
  /** The reservation this attempt spent, when it reached the provider. Distinguishes attempts. */
  reservationId: string | null;
  outcomeCode: ValueReadingOutcomeCode;
  sanitizedReason: ValueReadingOutcomeReason;
  providerInvoked: boolean;
}>;

/** One attempt, one identity: a gate refusal of the same request is recorded once. */
export function valueReadingOutcomeId(outcome: ValueReadingOutcome): string {
  return hashCanonical({
    kind: 'value_reading_outcome_v1',
    organizationId: outcome.binding.organizationId,
    requestDigestSha256: outcome.requestDigestSha256,
    reservationId: outcome.reservationId,
    outcomeCode: outcome.outcomeCode,
    sanitizedReason: outcome.sanitizedReason,
  });
}

export async function recordValueReadingOutcome(
  admin: ValueReadingClient,
  outcome: ValueReadingOutcome,
): Promise<Readonly<{ status: 'recorded'; diagnosticId: string } | { status: 'failed'; reason: string }>> {
  const diagnosticId = valueReadingOutcomeId(outcome);
  const { data, error } = await admin.rpc(RECORD_VALUE_READING_OUTCOME_RPC, {
    p_organization_id: outcome.binding.organizationId,
    p_source_document_id: outcome.binding.sourceDocumentId,
    p_source_artifact_id: outcome.binding.sourceArtifactId,
    p_extraction_snapshot_id: outcome.binding.extractionSnapshotId,
    p_physical_page_number: outcome.binding.physicalPageNumber,
    p_page_representation_digest: outcome.binding.pageRepresentationDigest,
    p_diagnostic_id: diagnosticId,
    p_recovery_type: VALUE_READING_RECOVERY_TYPE,
    p_outcome_code: outcome.outcomeCode,
    p_sanitized_reason: outcome.sanitizedReason,
    p_provider_invoked: outcome.providerInvoked,
    p_candidate_ids: [],
  });
  if (error) return { status: 'failed', reason: error.message ?? 'value-reading outcome rejected' };
  const row = Array.isArray(data) ? data[0] as { outcome_row_id?: unknown } | undefined : undefined;
  return row && typeof row.outcome_row_id === 'string'
    ? { status: 'recorded', diagnosticId } : { status: 'failed', reason: 'record function returned no outcome' };
}
