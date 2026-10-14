import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  precedenceSnapshotDigest,
  REFERENCED_AMENDMENT_RULE_ID,
  referencedAmendmentCandidates,
  relationshipProposalDigest,
  type ReferencedAmendmentFinding,
} from '@/lib/relationshipProposalCandidates';
import { loadProjectDocumentPrecedenceSnapshot } from '@/lib/server/documentPrecedence';

/**
 * Relationship proposals (P3.2 V1, `amends` only): generation, listing and
 * review records. Nothing here writes document_relationships, documents,
 * precedence or Validator state. A proposal becomes a relationship only when
 * the operator links it through the document-precedence `link_relationship`
 * action, which records the acceptance below against the row it created.
 */

export const RELATIONSHIP_PROPOSALS_TABLE = 'forgewing_relationship_proposals';
export const RELATIONSHIP_PROPOSAL_REVIEWS_TABLE = 'forgewing_relationship_proposal_reviews';
export const RECORD_RELATIONSHIP_PROPOSAL_RPC = 'record_forgewing_relationship_proposal';
export const RECORD_RELATIONSHIP_PROPOSAL_REVIEW_RPC = 'record_forgewing_relationship_proposal_review';

export type RelationshipProposalRow = Readonly<{
  id: string;
  project_id: string;
  source_document_id: string;
  target_document_id: string;
  relationship_type: 'amends';
  proposal_kind: string;
  proposer: string;
  amendment_number: number | null;
  anchor_check_key: string | null;
  evidence: unknown;
  rationale: string;
  authority: 'non_authoritative';
  created_at: string;
}>;
export type RelationshipProposalReviewRow = Readonly<{
  proposal_id: string;
  disposition: 'accepted' | 'already_linked' | 'rejected' | 'deferred';
  relationship_id: string | null;
  reviewer_actor_id: string;
  created_at: string;
}>;

const PROPOSAL_SELECT = 'id, project_id, source_document_id, target_document_id, relationship_type, proposal_kind, '
  + 'proposer, amendment_number, anchor_check_key, evidence, rationale, authority, created_at';

async function loadOpenReferencedAmendmentFindings(admin: SupabaseClient, projectId: string): Promise<ReferencedAmendmentFinding[]> {
  const { data: findings, error } = await admin.from('project_validation_findings')
    .select('id, check_key, subject_id, created_at')
    .eq('project_id', projectId).eq('rule_id', REFERENCED_AMENDMENT_RULE_ID).eq('status', 'open')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to read referenced-amendment findings: ${error.message}`);
  // Newest open finding per check key.
  const latest = new Map<string, { id: string; check_key: string; subject_id: string }>();
  for (const row of (findings ?? []) as Array<{ id: string; check_key: string; subject_id: string }>) {
    if (!latest.has(row.check_key)) latest.set(row.check_key, row);
  }
  const ids = [...latest.values()].map((row) => row.id);
  if (ids.length === 0) return [];
  const { data: evidence, error: evidenceError } = await admin.from('project_validation_evidence')
    .select('finding_id, source_document_id, source_page, field_value')
    .in('finding_id', ids);
  if (evidenceError) throw new Error(`Failed to read referenced-amendment evidence: ${evidenceError.message}`);
  const byFinding = new Map<string, ReferencedAmendmentFinding['evidence'][number][]>();
  for (const row of (evidence ?? []) as Array<{ finding_id: string; source_document_id: string | null; source_page: number | null; field_value: string | null }>) {
    const entries = byFinding.get(row.finding_id) ?? [];
    entries.push({ documentId: row.source_document_id, page: row.source_page, matchedText: row.field_value });
    byFinding.set(row.finding_id, entries);
  }
  return [...latest.values()].map((row) => ({
    checkKey: row.check_key, subjectId: row.subject_id,
    evidence: (byFinding.get(row.id) ?? []).sort((left, right) => `${left.documentId}:${left.page}`.localeCompare(`${right.documentId}:${right.page}`)),
  }));
}

/** Computes deterministic candidates and records each as an immutable proposal. */
export async function generateRelationshipProposals(admin: SupabaseClient, params: Readonly<{
  organizationId: string; projectId: string; requestedBy: string;
}>): Promise<Readonly<{ proposalIds: readonly string[]; created: number }>> {
  const snapshot = await loadProjectDocumentPrecedenceSnapshot(admin, params);
  const findings = await loadOpenReferencedAmendmentFindings(admin, params.projectId);
  const documents = snapshot.documents.map((document) => ({ id: document.id, title: document.title ?? null, name: document.name ?? null }));
  const candidates = referencedAmendmentCandidates({ documents, relationships: snapshot.relationships, families: snapshot.families, findings });
  const snapshotDigest = precedenceSnapshotDigest({ documents, relationships: snapshot.relationships, families: snapshot.families });
  const proposalIds: string[] = [];
  let created = 0;
  for (const candidate of candidates) {
    const { data, error } = await admin.rpc(RECORD_RELATIONSHIP_PROPOSAL_RPC, {
      p_organization_id: params.organizationId,
      p_project_id: params.projectId,
      p_source_document_id: candidate.sourceDocumentId,
      p_target_document_id: candidate.targetDocumentId,
      p_relationship_type: candidate.relationshipType,
      p_proposal_kind: candidate.proposalKind,
      p_proposer: candidate.proposer,
      p_model: null,
      p_prompt_version: null,
      p_anchor_check_key: candidate.anchorCheckKey,
      p_amendment_number: candidate.amendmentNumber,
      p_evidence: candidate.evidence,
      p_rationale: candidate.rationale,
      p_precedence_snapshot_digest: snapshotDigest,
      p_proposal_digest: relationshipProposalDigest(params.projectId, candidate, snapshotDigest),
      p_requested_by: params.requestedBy,
    });
    if (error) throw new Error(`Failed to record relationship proposal: ${error.message}`);
    const row = Array.isArray(data) ? data[0] as { proposal_id?: unknown; inserted?: unknown } | undefined : undefined;
    if (typeof row?.proposal_id !== 'string') throw new Error('Relationship proposal was not recorded');
    proposalIds.push(row.proposal_id);
    if (row.inserted === true) created += 1;
  }
  return { proposalIds, created };
}

/** Proposals for a project with their reviews: evidence history, never truth. */
export async function listRelationshipProposals(admin: SupabaseClient, params: Readonly<{
  organizationId: string; projectId: string;
}>): Promise<ReadonlyArray<RelationshipProposalRow & { reviews: readonly RelationshipProposalReviewRow[] }>> {
  const { data, error } = await admin.from(RELATIONSHIP_PROPOSALS_TABLE).select(PROPOSAL_SELECT)
    .eq('organization_id', params.organizationId).eq('project_id', params.projectId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to read relationship proposals: ${error.message}`);
  const proposals = (data ?? []) as unknown as RelationshipProposalRow[];
  if (proposals.length === 0) return [];
  const { data: reviews, error: reviewError } = await admin.from(RELATIONSHIP_PROPOSAL_REVIEWS_TABLE)
    .select('proposal_id, disposition, relationship_id, reviewer_actor_id, created_at')
    .eq('organization_id', params.organizationId).in('proposal_id', proposals.map((proposal) => proposal.id))
    .order('created_at', { ascending: true });
  if (reviewError) throw new Error(`Failed to read relationship proposal reviews: ${reviewError.message}`);
  const byProposal = new Map<string, RelationshipProposalReviewRow[]>();
  for (const review of (reviews ?? []) as RelationshipProposalReviewRow[]) {
    byProposal.set(review.proposal_id, [...(byProposal.get(review.proposal_id) ?? []), review]);
  }
  return proposals.map((proposal) => ({ ...proposal, reviews: byProposal.get(proposal.id) ?? [] }));
}

/** Verifies that a link the operator is about to create is exactly this proposal. */
export async function readProposalForLink(admin: SupabaseClient, params: Readonly<{
  organizationId: string; projectId: string; proposalId: string;
}>): Promise<RelationshipProposalRow | null> {
  const { data, error } = await admin.from(RELATIONSHIP_PROPOSALS_TABLE).select(PROPOSAL_SELECT)
    .eq('id', params.proposalId).eq('organization_id', params.organizationId).eq('project_id', params.projectId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read relationship proposal: ${error.message}`);
  return (data as RelationshipProposalRow | null) ?? null;
}

export type RelationshipProposalDisposition = RelationshipProposalReviewRow['disposition'];

export function relationshipProposalReviewDigest(params: Readonly<{
  organizationId: string; proposalId: string; disposition: RelationshipProposalDisposition;
  relationshipId: string | null; reviewerActorId: string;
}>): string {
  return createHash('sha256').update(JSON.stringify(['relationship_proposal_review_v1', params.organizationId,
    params.proposalId, params.disposition, params.relationshipId, params.reviewerActorId])).digest('hex');
}

export type RecordRelationshipProposalReviewResult =
  | Readonly<{ status: 'recorded'; reviewId: string }>
  | Readonly<{ status: 'already_decided' }>
  | Readonly<{ status: 'rejected'; reason: string }>;

export async function recordRelationshipProposalReview(admin: SupabaseClient, params: Readonly<{
  organizationId: string; proposalId: string; disposition: RelationshipProposalDisposition;
  relationshipId: string | null; reason: string | null; reviewerActorId: string;
}>): Promise<RecordRelationshipProposalReviewResult> {
  const { data, error } = await admin.rpc(RECORD_RELATIONSHIP_PROPOSAL_REVIEW_RPC, {
    p_organization_id: params.organizationId,
    p_proposal_id: params.proposalId,
    p_disposition: params.disposition,
    p_relationship_id: params.relationshipId,
    p_reason: params.reason,
    p_reviewer_actor_id: params.reviewerActorId,
    p_review_request_digest: relationshipProposalReviewDigest(params),
  });
  if (error) {
    if (error.code === '23505') return { status: 'already_decided' };
    return { status: 'rejected', reason: error.message ?? 'review rejected' };
  }
  const row = Array.isArray(data) ? data[0] as { review_id?: unknown } | undefined : undefined;
  return typeof row?.review_id === 'string' ? { status: 'recorded', reviewId: row.review_id }
    : { status: 'rejected', reason: 'record function returned no review' };
}

/** Whether the proposal already has a final (non-deferred) review. */
export async function relationshipProposalDecided(admin: SupabaseClient, params: Readonly<{
  organizationId: string; proposalId: string;
}>): Promise<boolean> {
  const { data, error } = await admin.from(RELATIONSHIP_PROPOSAL_REVIEWS_TABLE).select('id')
    .eq('organization_id', params.organizationId).eq('proposal_id', params.proposalId)
    .neq('disposition', 'deferred').limit(1);
  if (error) throw new Error(`Failed to read relationship proposal reviews: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}
