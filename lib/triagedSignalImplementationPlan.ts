import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { triageShapeError } from '@/lib/improvementSignalTriageContract';
import { AllowlistedFrictionSignalSchema } from '@/lib/resolution/frictionSignalAllowlist';
import {
  TRIAGED_SIGNAL_PLAN_DOMAIN,
  TRIAGED_SIGNAL_READINESS,
  TRIAGED_SIGNAL_STEP_ID,
  TriagedSignalImplementationPlanSchema,
  TriagedSignalSpecificationSchema,
  triagedSignalSpecificationDigest,
  type TriagedSignalImplementationPlanArtifact,
} from '@/lib/triagedSignalPlanSchema';

/**
 * Builds the reviewed-specification input of a repository plan from a
 * human-triaged improvement signal (B8.3d). Pure: no IO, no clock.
 *
 * The triage row is the planning pin. The single planned step carries the
 * classification a person chose at triage and a specification that is exactly
 * the allowlisted, provider-visible signal context:
 * - from the B8.3a payload (re-validated here): signal kind, code, catalogue
 *   fingerprint, counts, bounded typed record refs, root-cause category;
 * - from the triage: disposition, capability scope, semantics defect class and
 *   the Plan V2 classification.
 * The evidence is strict, so a row carrying a rationale, a reviewer, an
 * organization or any other column is refused rather than silently dropped.
 * The root-cause category is context; the plan classification is the human
 * decision. Neither is derived from the other or from the signal kind.
 */

const uuid = z.string().uuid();
export const TriagedSignalPlanEvidenceSchema = z.object({
  submissionRow: z.object({
    id: uuid, signal_kind: z.string(), signal_code: z.string(), payload: z.unknown(),
  }).strict(),
  triageRow: z.object({
    id: uuid, submission_id: uuid, signal_kind: z.string(),
    triage_version: z.number().int().positive().max(2147483647),
    disposition: z.string(), capability_scope: z.string().nullable(),
    semantics_defect_class: z.string().nullable(), plan_classification: z.string().nullable(),
  }).strict(),
}).strict();

export type TriagedSignalPlanFailureCode =
  | 'invalid_evidence' | 'invalid_payload' | 'source_mismatch' | 'not_routed_to_engineering' | 'invalid_triage';
export type TriagedSignalPlanResult =
  | Readonly<{ ok: true; artifact: TriagedSignalImplementationPlanArtifact }>
  | Readonly<{ ok: false; code: TriagedSignalPlanFailureCode }>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function buildTriagedSignalImplementationPlan(input: unknown): TriagedSignalPlanResult {
  try {
    const evidence = TriagedSignalPlanEvidenceSchema.safeParse(input);
    if (!evidence.success) return { ok: false, code: 'invalid_evidence' };
    const { submissionRow: submission, triageRow: triage } = evidence.data;
    const payload = AllowlistedFrictionSignalSchema.safeParse(submission.payload);
    if (!payload.success) return { ok: false, code: 'invalid_payload' };
    if (triage.submission_id !== submission.id || triage.signal_kind !== submission.signal_kind
      || payload.data.signalKind !== submission.signal_kind || payload.data.code !== submission.signal_code) {
      return { ok: false, code: 'source_mismatch' };
    }
    if (triage.disposition !== 'route_to_engineering') return { ok: false, code: 'not_routed_to_engineering' };
    if (triageShapeError({ signalKind: triage.signal_kind, disposition: 'route_to_engineering',
      capabilityScope: triage.capability_scope, semanticsDefectClass: triage.semantics_defect_class,
      planClassification: triage.plan_classification })) return { ok: false, code: 'invalid_triage' };

    const specification = TriagedSignalSpecificationSchema.safeParse({
      signalKind: payload.data.signalKind,
      signalCode: payload.data.code,
      catalogueFingerprint: payload.data.catalogueFingerprint,
      counts: payload.data.counts,
      recordRefs: payload.data.recordRefs,
      rootCauseCategory: payload.data.rootCauseCategory,
      triageDisposition: triage.disposition,
      capabilityScope: triage.capability_scope,
      semanticsDefectClass: triage.semantics_defect_class,
      planClassification: triage.plan_classification,
    });
    if (!specification.success) return { ok: false, code: 'invalid_triage' };
    const pin = { sourceKind: 'triaged_improvement_signal' as const, submissionId: submission.id,
      triageReviewId: triage.id, triageVersion: triage.triage_version };
    const kind = specification.data.planClassification;
    const envelope = {
      domain: TRIAGED_SIGNAL_PLAN_DOMAIN, schemaVersion: 1 as const,
      authority: 'non_authoritative' as const, executable: false as const, grantsExecutionAuthority: false as const,
      source: { pin, effectiveReviewedSpecificationDigestSha256: triagedSignalSpecificationDigest(pin, specification.data) },
      plannedSteps: [{ stepId: TRIAGED_SIGNAL_STEP_ID, effectiveClassification: kind,
        implementationReadiness: TRIAGED_SIGNAL_READINESS[kind], specification: specification.data }],
    };
    const artifact = { ...envelope, digest: { algorithm: 'sha256' as const,
      encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } };
    const canonical = JSON.parse(canonicalJson(artifact)) as unknown;
    if (!TriagedSignalImplementationPlanSchema.safeParse(canonical).success) return { ok: false, code: 'invalid_triage' };
    return { ok: true, artifact: freeze(canonical as TriagedSignalImplementationPlanArtifact) };
  } catch {
    return { ok: false, code: 'invalid_evidence' };
  }
}
