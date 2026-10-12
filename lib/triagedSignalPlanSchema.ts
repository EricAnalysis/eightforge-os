import { z } from 'zod';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  TRIAGE_CAPABILITY_SCOPES,
  TRIAGE_PLAN_CLASSIFICATIONS,
  TRIAGE_SEMANTICS_DEFECT_CLASSES,
} from '@/lib/improvementSignalTriageContract';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import {
  BrowserSafeImplementationPlanSchema,
  TriagedSignalPlanPinSchema,
  type TriagedSignalPlanPin,
} from '@/lib/workflowImplementationPlanWire';

/**
 * The structure of a triaged-signal implementation plan (B8.3d): the
 * reviewed-specification input of a repository plan when the source is a
 * human-triaged improvement signal rather than a reviewed workflow assessment.
 *
 * Deterministic and dependency-light so the repository-plan foundation and the
 * provider guidance input can validate it. The builder that turns trusted rows
 * into this artifact (and re-validates the full B8.3a payload) lives in
 * `triagedSignalImplementationPlan.ts`.
 *
 * `TriagedSignalSpecificationSchema` is the data policy for what a provider may
 * see about a signal. It is strict: a key outside this set fails closed. The
 * vocabularies are pinned to their canonical sources by tests.
 */

export const TRIAGED_SIGNAL_PLAN_DOMAIN = 'eightforge.triaged-signal-implementation-plan' as const;
export const TRIAGED_SIGNAL_SPECIFICATION_DOMAIN = 'eightforge.triaged-signal-specification' as const;
export const TRIAGED_SIGNAL_STEP_ID = 'triaged-signal' as const;

/** Submittable friction signal kinds (B8.3b refuses qualification demand). */
export const TRIAGED_SIGNAL_KINDS = [
  'recurring_deterministic_failure', 'recurring_manual_correction', 'forgewing_rejected', 'rule_semantics_review',
] as const;
/** The Orchestrator root-cause taxonomy keys, as carried by a B8.3a payload. Context only. */
export const TRIAGED_SIGNAL_ROOT_CAUSES = [
  'extraction_issue', 'ocr_corruption', 'mapping_issue', 'canonical_persistence_issue', 'ui_consumption_issue',
  'duplicate_derivation_issue', 'lifecycle_coupling_issue', 'validation_rule_issue',
  'operator_review_persistence_issue', 'state_synchronization_issue', 'totals_reconciliation_issue',
  'evidence_trace_issue', 'performance_issue', 'relationship_governance_issue',
] as const;
export const TRIAGED_SIGNAL_RECORD_TYPES = [
  'execution_item', 'human_fact_assertion', 'forgewing_proposal', 'resolution_case',
] as const;
export const TRIAGED_SIGNAL_FINGERPRINT = /^rule-explanation-v1:sha256:[0-9a-f]{64}$/u;
const RECORD_REF = new RegExp(`^(?:${TRIAGED_SIGNAL_RECORD_TYPES.join('|')}):(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|sha256:[0-9a-f]{64})$`, 'u');

type PlanClassification = (typeof TRIAGE_PLAN_CLASSIFICATIONS)[number];
type Readiness =
  | Readonly<{ state: 'specification_complete' }>
  | Readonly<{ state: 'blocked_structural'; blocker: 'rule_definition_is_code' | 'no_organization_for_task' }>
  | Readonly<{ state: 'requires_operator_decision'; decision: 'source_document_taxonomy' | 'recovery_vocabulary_unresolved' }>;
/** The Plan V1 readiness of each classification, unchanged (parity-tested). */
export const TRIAGED_SIGNAL_READINESS: Readonly<Record<PlanClassification, Readiness>> = {
  RULE: { state: 'blocked_structural', blocker: 'rule_definition_is_code' },
  VERIFY: { state: 'blocked_structural', blocker: 'rule_definition_is_code' },
  HUMAN: { state: 'blocked_structural', blocker: 'no_organization_for_task' },
  EXTRACT: { state: 'requires_operator_decision', decision: 'source_document_taxonomy' },
  RECOVER: { state: 'requires_operator_decision', decision: 'recovery_vocabulary_unresolved' },
  ADVISORY: { state: 'specification_complete' },
};

const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const classification = z.enum(TRIAGE_PLAN_CLASSIFICATIONS);

/** The provider-visible signal context. Its key set is the data policy. */
export const TriagedSignalSpecificationSchema = z.object({
  signalKind: z.enum(TRIAGED_SIGNAL_KINDS),
  signalCode: z.string().min(1).max(160),
  catalogueFingerprint: z.string().regex(TRIAGED_SIGNAL_FINGERPRINT).nullable(),
  counts: z.object({ occurrences: count, documents: count, projects: count }).strict(),
  recordRefs: z.array(z.string().regex(RECORD_REF)).max(10),
  rootCauseCategory: z.enum(TRIAGED_SIGNAL_ROOT_CAUSES).nullable(),
  triageDisposition: z.literal('route_to_engineering'),
  capabilityScope: z.enum(TRIAGE_CAPABILITY_SCOPES),
  semanticsDefectClass: z.enum(TRIAGE_SEMANTICS_DEFECT_CLASSES).nullable(),
  planClassification: classification,
}).strict().superRefine((specification, context) => {
  if ((specification.signalKind === 'rule_semantics_review') !== (specification.semanticsDefectClass !== null)) {
    context.addIssue({ code: 'custom', path: ['semanticsDefectClass'], message: 'only a semantics review carries a defect class' });
  }
});
export type TriagedSignalSpecification = z.infer<typeof TriagedSignalSpecificationSchema>;

export function triagedSignalSpecificationDigest(pin: TriagedSignalPlanPin, specification: TriagedSignalSpecification): string {
  return hashCanonical({ domain: TRIAGED_SIGNAL_SPECIFICATION_DOMAIN, schemaVersion: 1, pin, specification });
}

function sameReadiness(left: unknown, right: Readiness): boolean {
  if (typeof left !== 'object' || left === null) return false;
  const value = left as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = Object.keys(right).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]
    && value[key] === (right as Record<string, unknown>)[key]);
}

const envelopeSchema = z.object({
  domain: z.literal(TRIAGED_SIGNAL_PLAN_DOMAIN), schemaVersion: z.literal(1),
  authority: z.literal('non_authoritative'), executable: z.literal(false), grantsExecutionAuthority: z.literal(false),
  source: z.object({ pin: TriagedSignalPlanPinSchema, effectiveReviewedSpecificationDigestSha256: digest }).strict(),
  plannedSteps: z.array(z.object({
    stepId: z.literal(TRIAGED_SIGNAL_STEP_ID),
    effectiveClassification: classification,
    implementationReadiness: z.record(z.unknown()),
    specification: TriagedSignalSpecificationSchema,
  }).strict()).length(1),
}).strict();

export const TriagedSignalImplementationPlanSchema = envelopeSchema.extend({
  digest: z.object({ algorithm: z.literal('sha256'), encoding: z.literal('recursive-key-sorted-json-v1'), value: digest }).strict(),
}).strict().superRefine((plan, context) => {
  const { digest: planDigest, ...envelope } = plan;
  const step = plan.plannedSteps[0];
  if (hashCanonical(envelope) !== planDigest.value
    || plan.source.effectiveReviewedSpecificationDigestSha256
      !== triagedSignalSpecificationDigest(plan.source.pin, step.specification)
    || step.effectiveClassification !== step.specification.planClassification
    || !sameReadiness(step.implementationReadiness, TRIAGED_SIGNAL_READINESS[step.effectiveClassification])) {
    context.addIssue({ code: 'custom', message: 'Triaged signal plan identity mismatch' });
  }
});

export type TriagedSignalImplementationPlanArtifact = Readonly<{
  domain: typeof TRIAGED_SIGNAL_PLAN_DOMAIN; schemaVersion: 1;
  authority: 'non_authoritative'; executable: false; grantsExecutionAuthority: false;
  source: Readonly<{ pin: TriagedSignalPlanPin; effectiveReviewedSpecificationDigestSha256: string }>;
  plannedSteps: readonly [Readonly<{
    stepId: typeof TRIAGED_SIGNAL_STEP_ID;
    effectiveClassification: PlanClassification;
    implementationReadiness: Readiness;
    specification: TriagedSignalSpecification;
  }>];
  digest: Readonly<{ algorithm: 'sha256'; encoding: 'recursive-key-sorted-json-v1'; value: string }>;
}>;

/** A trusted implementation plan from either reviewed-specification source. */
export const TrustedImplementationPlanSchema = z.union([BrowserSafeImplementationPlanSchema, TriagedSignalImplementationPlanSchema]);
export type TrustedImplementationPlanArtifact = WorkflowImplementationPlanArtifact | TriagedSignalImplementationPlanArtifact;

export function isTriagedSignalImplementationPlan(plan: unknown): boolean {
  return typeof plan === 'object' && plan !== null && (plan as { domain?: unknown }).domain === TRIAGED_SIGNAL_PLAN_DOMAIN;
}
