import { z } from 'zod';

/**
 * Durable identity of a Forgewing recovery proposal.
 *
 * Recovery V1 emits a bundle whose only persistence was a TTL'd shadow blob.
 * A human review has to pin something that outlives that TTL, so this is the
 * bounded projection that becomes a durable row: enough to review, to bind an
 * observation, and to draw the source location later, and nothing more.
 *
 * A proposal carries no authority. It is `non_authoritative` by construction
 * and has zero downstream effect until an exact human review accepts or
 * modifies it.
 */

const identifier = z.string().min(1).max(200).refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();

export const RECOVERY_PROPOSAL_ID_PATTERN =
  /^forgewing-proposal-pricing-rate-cluster-[a-f0-9]{32}$/;

export const RecoveryProposalEvidenceSchema = z.object({
  observationId: identifier,
  sourceLayer: z.enum(['pdf_native_text', 'ocr']),
  rawText: z.string().min(1).max(200),
  boundingBox: z.object({
    xMin: z.number().finite(), xMax: z.number().finite(),
    yMin: z.number().finite(), yMax: z.number().finite(),
  }).strict(),
  /** Whether this observation is a monetary candidate a review may select. */
  eligible: z.boolean(),
}).strict();
export type RecoveryProposalEvidence = z.infer<typeof RecoveryProposalEvidenceSchema>;

export const DurableRecoveryProposalSchema = z.object({
  organizationId: uuid,
  sourceDocumentId: uuid,
  sourceArtifactId: uuid,
  extractionSnapshotId: identifier,
  physicalPageNumber: z.number().int().positive(),
  proposalId: z.string().regex(RECOVERY_PROPOSAL_ID_PATTERN),
  proposalDigestSha256: digest,
  schemaVersion: identifier,
  taskType: z.literal('pricing_rate_cluster_recovery'),
  recoveryReason: z.literal('ambiguous_rate_clusters'),
  eligibilityReason: z.literal('ambiguous_relationship'),
  selectedObservationId: identifier,
  proposedValue: z.string().min(1).max(200),
  normalizedValue: z.string().min(1).max(200),
  pageRepresentationDigest: digest.nullable(),
  evidence: z.array(RecoveryProposalEvidenceSchema).min(2).max(32),
  alternativeObservationIds: z.array(identifier).min(1).max(8),
  certainty: z.number().min(0).max(1),
  reasonCategory: identifier,
  providerModel: identifier,
  promptTemplateId: identifier,
  promptTemplateVersion: identifier,
  authority: z.literal('non_authoritative'),
  requiresHumanReview: z.literal(true),
  /** Diagnostic pointer into the shadow blob. May expire; never load-bearing. */
  shadowArtifactPath: z.string().min(1).max(500).nullable(),
}).strict().superRefine((value, ctx) => {
  const byId = new Map(value.evidence.map((entry) => [entry.observationId, entry]));
  const selected = byId.get(value.selectedObservationId);
  if (byId.size !== value.evidence.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate recovery evidence observation' });
    return;
  }
  // A proposal that selects something it did not cite cannot be reviewed
  // against its own evidence, and a selection the reviewer cannot see is not
  // reviewable at all.
  if (!selected || !selected.eligible) {
    ctx.addIssue({ code: 'custom', message: 'selected observation is not eligible evidence' });
    return;
  }
  if (selected.rawText !== value.proposedValue) {
    ctx.addIssue({ code: 'custom', message: 'proposed value does not match selected observation' });
  }
  if (value.alternativeObservationIds.includes(value.selectedObservationId)
    || value.alternativeObservationIds.some((id) => !byId.get(id)?.eligible)) {
    ctx.addIssue({ code: 'custom', message: 'alternative observations are not eligible evidence' });
  }
});
export type DurableRecoveryProposal = z.infer<typeof DurableRecoveryProposalSchema>;

/**
 * The observations a human review may choose between. "Modified" means picking
 * a different one of these, never authoring a value: Forgewing V1 cannot author
 * rates and neither can this path.
 */
export function eligibleRecoveryObservationIds(
  proposal: Pick<DurableRecoveryProposal, 'evidence'>,
): readonly string[] {
  return proposal.evidence
    .filter((entry) => entry.eligible)
    .map((entry) => entry.observationId)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
}
