import { z } from 'zod';

import { diagnosticId } from '@/lib/diagnostics/diagnosticIdentity';
import {
  DiagnosticRecoveryTypeSchema,
  type DiagnosticCode,
} from '@/lib/diagnostics/failureDiagnostic';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const RECOVERY_GENERATION_OUTCOME_WRITE_FUNCTION =
  'record_forgewing_recovery_generation_outcome' as const;

export const RECOVERY_GENERATION_OUTCOME_CODES = [
  'provider_failed', 'structured_output_invalid', 'evidence_binding_failed',
  'deterministic_validation_failed', 'proposal_persist_failed',
  'budget_exhausted', 'recovery_disabled',
] as const;
export const RecoveryGenerationOutcomeCodeSchema = z.enum(RECOVERY_GENERATION_OUTCOME_CODES);
export type RecoveryGenerationOutcomeCode = z.infer<typeof RecoveryGenerationOutcomeCodeSchema>;

export const RECOVERY_GENERATION_SANITIZED_REASONS = [
  'recovery_disabled', 'budget_exhausted', 'provider_timeout',
  'provider_truncated_output', 'provider_error', 'anthropic_not_configured',
  'invalid_json', 'candidate_closure_failed', 'input_identity_closure_failed',
  'insufficient_monetary_candidates', 'unknown_candidate',
  'unknown_evidence_reference', 'proposal_value_validation_failed',
  'invalid_proposal', 'write_failed', 'not_configured', 'projection_failed',
] as const;
export const RecoveryGenerationSanitizedReasonSchema =
  z.enum(RECOVERY_GENERATION_SANITIZED_REASONS);
export type RecoveryGenerationSanitizedReason =
  z.infer<typeof RecoveryGenerationSanitizedReasonSchema>;

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const candidateId = z.string().regex(/^recovery-candidate-v2-[0-9a-f]{64}$/);

export const RecoveryGenerationOutcomeSchema = z.object({
  organizationId: z.string().uuid(),
  sourceDocumentId: z.string().uuid(),
  sourceArtifactId: z.string().uuid(),
  extractionSnapshotId: z.string().min(1).max(240).refine((value) => value.trim() === value),
  physicalPageNumber: z.number().int().positive(),
  pageRepresentationDigest: digest,
  recoveryType: DiagnosticRecoveryTypeSchema,
  outcomeCode: RecoveryGenerationOutcomeCodeSchema,
  sanitizedReason: RecoveryGenerationSanitizedReasonSchema,
  providerInvoked: z.boolean(),
  candidateIds: z.array(candidateId).max(32)
    .refine((ids) => new Set(ids).size === ids.length, 'candidate ids must be unique'),
}).strict().superRefine((value, context) => {
  const mustNotInvoke = value.outcomeCode === 'budget_exhausted'
    || value.outcomeCode === 'recovery_disabled';
  const mustInvoke = value.outcomeCode === 'provider_failed'
    || value.outcomeCode === 'structured_output_invalid'
    || value.outcomeCode === 'proposal_persist_failed';
  if ((mustNotInvoke && value.providerInvoked) || (mustInvoke && !value.providerInvoked)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['providerInvoked'],
      message: 'provider invocation does not match recovery outcome' });
  }
});
export type RecoveryGenerationOutcome = z.infer<typeof RecoveryGenerationOutcomeSchema>;

export type RecoveryGenerationOutcomePersistenceResult =
  | Readonly<{ status: 'persisted'; outcomeRowId: string; diagnosticId: string; inserted: boolean }>
  | Readonly<{ status: 'skipped'; reason: 'not_configured' }>
  | Readonly<{ status: 'failed'; reason: 'invalid_outcome' | 'write_failed' }>;

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export function sanitizeRecoveryGenerationReason(
  outcomeCode: RecoveryGenerationOutcomeCode,
  reason: unknown,
): RecoveryGenerationSanitizedReason {
  const raw = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
  const direct = RecoveryGenerationSanitizedReasonSchema.safeParse(raw);
  if (direct.success) return direct.data;
  const normalized = raw.toLowerCase();
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'provider_timeout';
  if (normalized.includes('truncated')) return 'provider_truncated_output';
  if (normalized.includes('anthropic_api_key')) return 'anthropic_not_configured';
  switch (outcomeCode) {
    case 'recovery_disabled': return 'recovery_disabled';
    case 'budget_exhausted': return 'budget_exhausted';
    case 'structured_output_invalid': return 'invalid_json';
    case 'evidence_binding_failed': return 'candidate_closure_failed';
    case 'deterministic_validation_failed': return 'proposal_value_validation_failed';
    case 'proposal_persist_failed': return 'write_failed';
    case 'provider_failed': return 'provider_error';
  }
}

export function recoveryGenerationDiagnosticId(outcome: RecoveryGenerationOutcome): string {
  const code: DiagnosticCode = {
    provider_failed: 'recovery_provider_failed',
    structured_output_invalid: 'recovery_structured_output_invalid',
    evidence_binding_failed: 'recovery_evidence_binding_failed',
    deterministic_validation_failed: 'recovery_deterministic_validation_failed',
    proposal_persist_failed: 'recovery_proposal_persist_failed',
    budget_exhausted: 'recovery_budget_exhausted',
    recovery_disabled: 'recovery_disabled',
  }[outcome.outcomeCode] as DiagnosticCode;
  return diagnosticId({
    code,
    scope: {
      organizationId: outcome.organizationId,
      sourceDocumentId: outcome.sourceDocumentId,
      sourceArtifactId: outcome.sourceArtifactId,
      physicalPageNumber: outcome.physicalPageNumber,
      pageRepresentationDigest: outcome.pageRepresentationDigest,
    },
    evidenceRefs: outcome.candidateIds.map((candidateId) => ({
      kind: 'recovery_candidate' as const, candidateId,
    })),
  });
}

export async function persistForgewingRecoveryGenerationOutcome(
  outcome: RecoveryGenerationOutcome,
  dependencies: Readonly<{ admin?: RpcClient | null }> = {},
): Promise<RecoveryGenerationOutcomePersistenceResult> {
  const parsed = RecoveryGenerationOutcomeSchema.safeParse(outcome);
  if (!parsed.success) return { status: 'failed', reason: 'invalid_outcome' };
  const value = { ...parsed.data, candidateIds: [...parsed.data.candidateIds].sort() };
  const diagnosticId = recoveryGenerationDiagnosticId(value);
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() : dependencies.admin;
  if (!admin) return { status: 'skipped', reason: 'not_configured' };
  const result = await admin.rpc(RECOVERY_GENERATION_OUTCOME_WRITE_FUNCTION, {
    p_organization_id: value.organizationId,
    p_source_document_id: value.sourceDocumentId,
    p_source_artifact_id: value.sourceArtifactId,
    p_extraction_snapshot_id: value.extractionSnapshotId,
    p_physical_page_number: value.physicalPageNumber,
    p_page_representation_digest: value.pageRepresentationDigest,
    p_diagnostic_id: diagnosticId,
    p_recovery_type: value.recoveryType,
    p_outcome_code: value.outcomeCode,
    p_sanitized_reason: value.sanitizedReason,
    p_provider_invoked: value.providerInvoked,
    p_candidate_ids: value.candidateIds,
  });
  if (result.error) return { status: 'failed', reason: 'write_failed' };
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | { outcome_row_id?: unknown; inserted?: unknown } | null | undefined;
  return row && typeof row.outcome_row_id === 'string' && typeof row.inserted === 'boolean'
    ? { status: 'persisted', outcomeRowId: row.outcome_row_id, diagnosticId,
        inserted: row.inserted }
    : { status: 'failed', reason: 'write_failed' };
}
