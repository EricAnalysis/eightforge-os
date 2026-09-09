import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  DurableRecoveryProposalSchema,
  type DurableRecoveryProposal,
} from '@/lib/forgewingRecoveryProposal';
import type { ForgewingPricingRateClusterRecoveryBundle }
  from '@/lib/forgewing/tasks/pricingRateClusterRecovery';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const RECOVERY_PROPOSAL_WRITE_FUNCTION = 'record_forgewing_recovery_proposal' as const;

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export type RecoveryProposalPersistenceResult =
  | Readonly<{ status: 'persisted'; proposalRowId: string; proposalDigestSha256: string; inserted: boolean }>
  | Readonly<{ status: 'skipped'; reason: 'not_configured' }>
  | Readonly<{ status: 'failed'; reason: 'invalid_proposal' | 'write_failed' }>;

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
