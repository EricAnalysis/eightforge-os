import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  DurableRecoveryProposalSchema,
  DurableRecoveryProposalV2Schema,
  type DurableRecoveryProposal,
  type DurableRecoveryProposalV2,
} from '@/lib/forgewingRecoveryProposal';
import type { RecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import type { ForgewingPricingRateClusterRecoveryBundle }
  from '@/lib/forgewing/tasks/pricingRateClusterRecovery';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const RECOVERY_PROPOSAL_WRITE_FUNCTION = 'record_forgewing_recovery_proposal' as const;
export const RECOVERY_PROPOSAL_V2_WRITE_FUNCTION = 'record_forgewing_recovery_proposal_v2' as const;

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export type RecoveryProposalPersistenceResult =
  | Readonly<{ status: 'persisted'; proposalRowId: string; proposalDigestSha256: string; inserted: boolean }>
  | Readonly<{ status: 'skipped'; reason: 'not_configured' }>
  | Readonly<{ status: 'failed'; reason: 'invalid_proposal' | 'write_failed' }>;

export function buildDurableRecoveryProposalV2(params: Readonly<{
  organizationId: string;
  extractionSnapshotId: string;
  candidates: readonly RecoveryCandidateV2[];
  selectedCandidateId: string;
  certainty: number;
  reasonCategory: string;
  providerModel: string;
  promptTemplateId: string;
  promptTemplateVersion: string;
  shadowArtifactPath?: string | null;
}>): DurableRecoveryProposalV2 | null {
  const selected = params.candidates.find((candidate) =>
    candidate.candidateId === params.selectedCandidateId);
  if (!selected || params.candidates.some((candidate) =>
    candidate.recoveryType !== selected.recoveryType
    || candidate.sourceDocumentId !== selected.sourceDocumentId
    || candidate.sourceArtifactId !== selected.sourceArtifactId
    || candidate.physicalPageNumber !== selected.physicalPageNumber)) return null;
  const identity = hashCanonical({
    proposalVersion: 2,
    extractionSnapshotId: params.extractionSnapshotId,
    recoveryType: selected.recoveryType,
    selectedCandidateId: params.selectedCandidateId,
    candidates: params.candidates,
    certainty: params.certainty,
    reasonCategory: params.reasonCategory,
    providerModel: params.providerModel,
    promptTemplateId: params.promptTemplateId,
    promptTemplateVersion: params.promptTemplateVersion,
  });
  const parsed = DurableRecoveryProposalV2Schema.safeParse({
    organizationId: params.organizationId,
    sourceDocumentId: selected.sourceDocumentId,
    sourceArtifactId: selected.sourceArtifactId,
    extractionSnapshotId: params.extractionSnapshotId,
    physicalPageNumber: selected.physicalPageNumber,
    proposalId: `forgewing-proposal-recovery-v2-${identity}`,
    proposalDigestSha256: identity,
    proposalVersion: 2,
    schemaVersion: 'forgewing-recovery-proposal-v2',
    recoveryType: selected.recoveryType,
    selectedCandidateId: params.selectedCandidateId,
    candidates: params.candidates,
    certainty: params.certainty,
    reasonCategory: params.reasonCategory,
    providerModel: params.providerModel,
    promptTemplateId: params.promptTemplateId,
    promptTemplateVersion: params.promptTemplateVersion,
    authority: 'non_authoritative',
    requiresHumanReview: true,
    shadowArtifactPath: params.shadowArtifactPath ?? null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Projects a validated Recovery V1 bundle onto the durable proposal record.
 *
 * The bundle's monetary candidate set is exactly selected + alternatives -- the
 * recovery task already decided which observations parse as authored rates --
 * so eligibility is read off that closure rather than re-derived here. Nothing
 * in this module reparses a rate.
 */
export function buildDurableRecoveryProposal(params: Readonly<{
  organizationId: string;
  bundle: ForgewingPricingRateClusterRecoveryBundle;
  providerModel: string;
  promptTemplateId: string;
  promptTemplateVersion: string;
  pageRepresentationDigest?: string | null;
  shadowArtifactPath?: string | null;
}>): DurableRecoveryProposal | null {
  if (params.organizationId !== params.bundle.run.organizationId) return null;
  const proposal = params.bundle.proposals[0];
  if (!proposal) return null;
  const eligible = new Set<string>([
    ...proposal.selectedObservationIds,
    ...proposal.alternativeObservationIds,
  ]);
  const candidate = {
    organizationId: params.organizationId,
    sourceDocumentId: proposal.sourceDocumentId,
    sourceArtifactId: proposal.sourceArtifactId,
    extractionSnapshotId: proposal.extractionSnapshotId,
    physicalPageNumber: proposal.physicalPageNumber,
    proposalId: proposal.proposalId,
    proposalDigestSha256: recoveryProposalDigest(params.bundle),
    schemaVersion: params.bundle.schemaVersion,
    taskType: proposal.taskType,
    recoveryReason: 'ambiguous_rate_clusters' as const,
    eligibilityReason: 'ambiguous_relationship' as const,
    selectedObservationId: proposal.selectedObservationIds[0]!,
    proposedValue: proposal.proposedValue,
    normalizedValue: proposal.normalizedValue,
    pageRepresentationDigest: params.pageRepresentationDigest ?? null,
    evidence: proposal.evidence.map((entry) => ({
      observationId: entry.observationId,
      sourceLayer: entry.sourceLayer,
      rawText: entry.rawText,
      boundingBox: { ...entry.boundingBox },
      eligible: eligible.has(entry.observationId),
    })),
    alternativeObservationIds: [...proposal.alternativeObservationIds],
    certainty: proposal.certainty,
    reasonCategory: proposal.reasonCategory,
    providerModel: params.providerModel,
    promptTemplateId: params.promptTemplateId,
    promptTemplateVersion: params.promptTemplateVersion,
    authority: 'non_authoritative' as const,
    requiresHumanReview: true as const,
    shadowArtifactPath: params.shadowArtifactPath ?? null,
  };
  const parsed = DurableRecoveryProposalSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Canonical proposal digest. This is what a review pins, so it must cover
 * every field a reviewer sees and every field re-entry later depends on.
 */
export function recoveryProposalDigest(
  bundle: ForgewingPricingRateClusterRecoveryBundle,
): string {
  const proposal = bundle.proposals[0]!;
  return hashCanonical({
    schemaVersion: bundle.schemaVersion,
    taskId: bundle.taskId,
    inputSnapshotHash: bundle.run.inputSnapshotHash,
    proposalId: proposal.proposalId,
    sourceDocumentId: proposal.sourceDocumentId,
    sourceArtifactId: proposal.sourceArtifactId,
    extractionSnapshotId: proposal.extractionSnapshotId,
    physicalPageNumber: proposal.physicalPageNumber,
    selectedObservationIds: proposal.selectedObservationIds,
    alternativeObservationIds: proposal.alternativeObservationIds,
    proposedValue: proposal.proposedValue,
    normalizedValue: proposal.normalizedValue,
    evidence: proposal.evidence,
  });
}

export async function persistForgewingRecoveryProposal(
  proposal: DurableRecoveryProposal,
  dependencies: Readonly<{ admin?: RpcClient | null }> = {},
): Promise<RecoveryProposalPersistenceResult> {
  const parsed = DurableRecoveryProposalSchema.safeParse(proposal);
  if (!parsed.success) return { status: 'failed', reason: 'invalid_proposal' };
  const value = parsed.data;
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() : dependencies.admin;
  if (!admin) return { status: 'skipped', reason: 'not_configured' };
  const result = await admin.rpc(RECOVERY_PROPOSAL_WRITE_FUNCTION, {
    p_organization_id: value.organizationId,
    p_source_document_id: value.sourceDocumentId,
    p_source_artifact_id: value.sourceArtifactId,
    p_extraction_snapshot_id: value.extractionSnapshotId,
    p_physical_page_number: value.physicalPageNumber,
    p_proposal_id: value.proposalId,
    p_proposal_digest_sha256: value.proposalDigestSha256,
    p_schema_version: value.schemaVersion,
    p_selected_observation_id: value.selectedObservationId,
    p_proposed_value: value.proposedValue,
    p_normalized_value: value.normalizedValue,
    p_page_representation_digest: value.pageRepresentationDigest,
    p_evidence: value.evidence,
    p_alternative_observation_ids: value.alternativeObservationIds,
    p_certainty: value.certainty,
    p_reason_category: value.reasonCategory,
    p_provider_model: value.providerModel,
    p_prompt_template_id: value.promptTemplateId,
    p_prompt_template_version: value.promptTemplateVersion,
    p_shadow_artifact_path: value.shadowArtifactPath,
  });
  if (result.error) return { status: 'failed', reason: 'write_failed' };
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | { proposal_row_id?: unknown; inserted?: unknown }
    | null
    | undefined;
  if (!row || typeof row.proposal_row_id !== 'string' || typeof row.inserted !== 'boolean') {
    return { status: 'failed', reason: 'write_failed' };
  }
  return {
    status: 'persisted',
    proposalRowId: row.proposal_row_id,
    proposalDigestSha256: value.proposalDigestSha256,
    inserted: row.inserted,
  };
}

export async function persistForgewingRecoveryProposalV2(
  proposal: DurableRecoveryProposalV2,
  dependencies: Readonly<{ admin?: RpcClient | null }> = {},
): Promise<RecoveryProposalPersistenceResult> {
  const parsed = DurableRecoveryProposalV2Schema.safeParse(proposal);
  if (!parsed.success) return { status: 'failed', reason: 'invalid_proposal' };
  const value = parsed.data;
  const selected = value.candidates.find((candidate) => candidate.candidateId === value.selectedCandidateId)!;
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() : dependencies.admin;
  if (!admin) return { status: 'skipped', reason: 'not_configured' };
  const result = await admin.rpc(RECOVERY_PROPOSAL_V2_WRITE_FUNCTION, {
    p_organization_id: value.organizationId,
    p_source_document_id: value.sourceDocumentId,
    p_source_artifact_id: value.sourceArtifactId,
    p_extraction_snapshot_id: value.extractionSnapshotId,
    p_physical_page_number: value.physicalPageNumber,
    p_proposal_id: value.proposalId,
    p_proposal_digest_sha256: value.proposalDigestSha256,
    p_recovery_type: value.recoveryType,
    p_selected_candidate_id: value.selectedCandidateId,
    p_proposed_value: selected.composedRawText,
    p_page_representation_digest: selected.pageRepresentationDigest,
    p_recovery_candidates: value.candidates,
    p_certainty: value.certainty,
    p_reason_category: value.reasonCategory,
    p_provider_model: value.providerModel,
    p_prompt_template_id: value.promptTemplateId,
    p_prompt_template_version: value.promptTemplateVersion,
    p_shadow_artifact_path: value.shadowArtifactPath,
  });
  if (result.error) return { status: 'failed', reason: 'write_failed' };
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | { proposal_row_id?: unknown; inserted?: unknown } | null | undefined;
  return row && typeof row.proposal_row_id === 'string' && typeof row.inserted === 'boolean'
    ? { status: 'persisted', proposalRowId: row.proposal_row_id,
        proposalDigestSha256: value.proposalDigestSha256, inserted: row.inserted }
    : { status: 'failed', reason: 'write_failed' };
}
