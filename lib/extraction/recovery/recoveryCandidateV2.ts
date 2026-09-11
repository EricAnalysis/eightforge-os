import { z } from 'zod';

import { hashCanonical } from '@/lib/extraction/domain/hash';

const identifier = z.string().min(1).max(240).refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();

export const RECOVERY_TYPES_V2 = [
  'pricing_rate_multi_observation_cluster',
  'priced_schedule_continuation_attribution',
] as const;
export const RecoveryTypeV2Schema = z.enum(RECOVERY_TYPES_V2);
export type RecoveryTypeV2 = z.infer<typeof RecoveryTypeV2Schema>;

export const RecoveryCandidateEvidenceV2Schema = z.object({
  observationId: identifier,
  sourceLayer: z.enum(['pdf_native_text', 'ocr']),
  rawText: z.string().min(1).max(500),
  boundingBox: z.object({
    xMin: z.number().finite(), xMax: z.number().finite(),
    yMin: z.number().finite(), yMax: z.number().finite(),
  }).strict(),
}).strict();
export type RecoveryCandidateEvidenceV2 = z.infer<typeof RecoveryCandidateEvidenceV2Schema>;

export const RecoveryCandidateTargetContextEvidenceV2Schema = z.object({
  targetRowIdentity: identifier,
  orderedObservationIds: z.array(identifier).min(1).max(32),
  rawTexts: z.array(z.string().min(1).max(500)).min(1).max(32),
  composedRawText: z.string().min(1).max(4_000),
  evidence: z.array(RecoveryCandidateEvidenceV2Schema).min(1).max(32),
}).strict().superRefine((targetContext, ctx) => {
  if (new Set(targetContext.orderedObservationIds).size
    !== targetContext.orderedObservationIds.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate target context observation identity' });
  }
  if (targetContext.rawTexts.length !== targetContext.orderedObservationIds.length) {
    ctx.addIssue({ code: 'custom', message: 'target context raw text order is incomplete' });
  }
  if (targetContext.evidence.length !== targetContext.orderedObservationIds.length
    || targetContext.orderedObservationIds.some((id, index) =>
      targetContext.evidence[index]?.observationId !== id
      || targetContext.evidence[index]?.rawText !== targetContext.rawTexts[index])) {
    ctx.addIssue({ code: 'custom', message: 'target context evidence closure failed' });
  }
});
export type RecoveryCandidateTargetContextEvidenceV2 =
  z.infer<typeof RecoveryCandidateTargetContextEvidenceV2Schema>;

export const RecoveryCandidateV2Schema = z.object({
  candidateId: z.string().regex(/^recovery-candidate-v2-[a-f0-9]{64}$/),
  recoveryType: RecoveryTypeV2Schema,
  sourceDocumentId: uuid,
  sourceArtifactId: uuid,
  physicalPageNumber: z.number().int().positive(),
  pageRepresentationDigest: digest,
  /** Existing native row identity; recovery may select it but cannot invent it. */
  targetRowIdentity: identifier,
  orderedObservationIds: z.array(identifier).min(1).max(32),
  rawTexts: z.array(z.string().min(1).max(500)).min(1).max(32),
  composedRawText: z.string().min(1).max(4_000),
  evidence: z.array(RecoveryCandidateEvidenceV2Schema).min(1).max(32),
  targetContextEvidence: RecoveryCandidateTargetContextEvidenceV2Schema.optional(),
}).strict().superRefine((candidate, ctx) => {
  if (new Set(candidate.orderedObservationIds).size !== candidate.orderedObservationIds.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate candidate observation identity' });
  }
  if (candidate.rawTexts.length !== candidate.orderedObservationIds.length) {
    ctx.addIssue({ code: 'custom', message: 'candidate raw text order is incomplete' });
  }
  // Index alignment, not a by-id lookup. The three member arrays are one
  // ordered membership expressed three ways, and the persistence RPC validates
  // them positionally; accepting a candidate here whose evidence merely
  // *contains* the right ids would build something the database then rejects,
  // and would let a reviewer be shown members in an order the composed text
  // was not built in.
  if (candidate.evidence.length !== candidate.orderedObservationIds.length
    || candidate.orderedObservationIds.some((id, index) =>
      candidate.evidence[index]?.observationId !== id
      || candidate.evidence[index]?.rawText !== candidate.rawTexts[index])) {
    ctx.addIssue({ code: 'custom', message: 'candidate evidence closure failed' });
  }
  if (candidate.targetContextEvidence) {
    if (candidate.recoveryType !== 'priced_schedule_continuation_attribution') {
      ctx.addIssue({ code: 'custom', message: 'target context is continuation-only evidence' });
    }
    if (candidate.targetContextEvidence.targetRowIdentity !== candidate.targetRowIdentity) {
      ctx.addIssue({ code: 'custom', message: 'target context row identity mismatch' });
    }
    const fragmentIds = new Set(candidate.orderedObservationIds);
    if (candidate.targetContextEvidence.orderedObservationIds.some((id) => fragmentIds.has(id))) {
      ctx.addIssue({ code: 'custom', message: 'target context overlaps candidate evidence' });
    }
  }
  if (candidate.candidateId !== recoveryCandidateId(candidate)) {
    ctx.addIssue({ code: 'custom', message: 'candidate identity does not match source closure' });
  }
});
export type RecoveryCandidateV2 = z.infer<typeof RecoveryCandidateV2Schema>;

export function recoveryCandidateId(candidate: Readonly<{
  recoveryType: RecoveryTypeV2;
  sourceDocumentId: string;
  sourceArtifactId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  targetRowIdentity: string;
  orderedObservationIds: readonly string[];
  targetContextEvidence?: Readonly<{
    orderedObservationIds: readonly string[];
  }>;
}>): string {
  return `recovery-candidate-v2-${hashCanonical({
    recoveryType: candidate.recoveryType,
    sourceDocumentId: candidate.sourceDocumentId,
    sourceArtifactId: candidate.sourceArtifactId,
    physicalPageNumber: candidate.physicalPageNumber,
    pageRepresentationDigest: candidate.pageRepresentationDigest,
    targetRowIdentity: candidate.targetRowIdentity,
    orderedObservationIds: candidate.orderedObservationIds,
    ...(candidate.targetContextEvidence ? {
      targetContextObservationIds: candidate.targetContextEvidence.orderedObservationIds,
    } : {}),
  })}`;
}

export function buildRecoveryCandidateV2(
  input: Omit<RecoveryCandidateV2, 'candidateId'>,
): RecoveryCandidateV2 | null {
  const candidate = { ...input, candidateId: recoveryCandidateId(input) };
  const parsed = RecoveryCandidateV2Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function recoveryCandidateDigest(candidate: RecoveryCandidateV2): string {
  return hashCanonical(candidate);
}
