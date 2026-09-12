import { z } from 'zod';

import { RecoveryTypeV2Schema } from '@/lib/extraction/recovery/recoveryCandidateV2';

const identifier = z.string().min(1).max(240).refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const DIAGNOSTIC_CODES = [
  'ambiguous_row_assignment',
  'ambiguous_rate_clusters',
  'unsupported_trailing_line',
  'insufficient_row_structure',
  'outside_table_body',
  'inconsistent_row_pitch',
  'insufficient_priced_rows',
  'ambiguous_recovery_confirmation',
  'recovery_closure_failed',
  'confirmed_recovery_unbound',
  'duplicate_recovery_confirmation',
  'confirmed_recovery_not_applied',
  'ambiguous_recovery_authority',
  'incoherent_recovery_confirmation',
  'recovery_source_evidence_unbound',
  'recovery_provider_failed',
  'recovery_structured_output_invalid',
  'recovery_evidence_binding_failed',
  'recovery_deterministic_validation_failed',
  'recovery_proposal_persist_failed',
  'recovery_budget_exhausted',
  'recovery_disabled',
  'document_processing_failed',
  'source_identity_read_failed',
  'recovery_read_failed',
] as const;
export const DiagnosticCodeSchema = z.enum(DIAGNOSTIC_CODES);
export type DiagnosticCode = z.infer<typeof DiagnosticCodeSchema>;

export const DIAGNOSTIC_STAGES = [
  'source_ingest', 'extraction', 'reconstruction', 'recovery_generation',
  'recovery_authority', 'runtime',
] as const;
export const DiagnosticStageSchema = z.enum(DIAGNOSTIC_STAGES);
export type DiagnosticStage = z.infer<typeof DiagnosticStageSchema>;

export const DIAGNOSTIC_SEVERITIES = ['info', 'warning', 'blocking'] as const;
export const DiagnosticSeveritySchema = z.enum(DIAGNOSTIC_SEVERITIES);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

export const DIAGNOSTIC_RECOVERABILITIES = [
  'recoverable_now', 'recoverable_after_human_review', 'not_recoverable',
  'engineering_diagnostic', 'retryable_runtime_failure',
] as const;
export const DiagnosticRecoverabilitySchema = z.enum(DIAGNOSTIC_RECOVERABILITIES);
export type DiagnosticRecoverability = z.infer<typeof DiagnosticRecoverabilitySchema>;

export const DIAGNOSTIC_NEXT_ACTIONS = [
  'none', 'review_withheld_row', 'resolve_recovery_review', 'reject_and_re_review',
  're_review_current_page', 'reprocess_then_re_review', 'reprocess_document',
  'retry_read', 'engineering_attention', 'engineering_or_product_attention',
] as const;
export const DiagnosticNextActionSchema = z.enum(DIAGNOSTIC_NEXT_ACTIONS);
export type DiagnosticNextAction = z.infer<typeof DiagnosticNextActionSchema>;

export const DiagnosticRecoveryTypeSchema = z.union([
  RecoveryTypeV2Schema,
  z.literal('pricing_rate_single_observation'),
]);
export type DiagnosticRecoveryType = z.infer<typeof DiagnosticRecoveryTypeSchema>;

export const DiagnosticScopeSchema = z.object({
  organizationId: z.string().uuid(),
  sourceDocumentId: z.string().uuid(),
  sourceArtifactId: z.string().uuid().nullable(),
  physicalPageNumber: z.number().int().positive().nullable(),
  pageRepresentationDigest: digest.nullable(),
}).strict();
export type DiagnosticScope = z.infer<typeof DiagnosticScopeSchema>;

export const DiagnosticEvidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observation'), observationId: identifier }).strict(),
  z.object({ kind: z.literal('recovery_candidate'), candidateId: identifier }).strict(),
  z.object({ kind: z.literal('recovery_proposal'), proposalId: identifier,
    proposalDigestSha256: digest }).strict(),
  z.object({ kind: z.literal('recovery_review'), reviewId: z.string().uuid(),
    reviewVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('processing_gap'), processingGapId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('processing_job'), jobId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('validation_finding'), findingId: z.string().uuid() }).strict(),
]);
export type DiagnosticEvidenceRef = z.infer<typeof DiagnosticEvidenceRefSchema>;

export const FailureDiagnosticSchema = z.object({
  diagnosticId: z.string().regex(/^[a-f0-9]{64}$/),
  code: DiagnosticCodeSchema,
  stage: DiagnosticStageSchema,
  severity: DiagnosticSeveritySchema,
  recoverability: DiagnosticRecoverabilitySchema,
  recoveryType: DiagnosticRecoveryTypeSchema.nullable(),
  scope: DiagnosticScopeSchema,
  summary: z.string().min(1).max(1_200),
  evidenceRefs: z.array(DiagnosticEvidenceRefSchema).max(64),
  recommendedNextAction: DiagnosticNextActionSchema,
  sourceIdentity: z.object({
    extractionSnapshotId: identifier.nullable(),
    processingRunId: identifier.nullable(),
  }).strict(),
  occurredAt: z.string().datetime({ offset: true }),
  explanation: z.object({
    text: z.string().min(1).max(4_000),
    model: identifier,
    promptTemplateId: identifier,
    promptTemplateVersion: identifier,
    authority: z.literal('non_authoritative'),
  }).strict().optional(),
}).strict();
export type FailureDiagnostic = z.infer<typeof FailureDiagnosticSchema>;

