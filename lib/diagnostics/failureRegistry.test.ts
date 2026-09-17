import { describe, expect, it } from 'vitest';

import { RECOVERY_TYPES_V2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import type {
  PricedScheduleRecoveryDiagnosticReason,
  PricedScheduleRejectedSpineReason,
  PricedScheduleUnassignedLineReason,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { RECOVERY_CONFIRMATION_DIAGNOSTICS }
  from '@/lib/forgewingConfirmedRecovery';
import { RECOVERY_GENERATION_OUTCOME_CODES }
  from '@/lib/server/forgewingRecoveryGenerationOutcomePersistence';
import {
  DIAGNOSTIC_CODES,
  FailureDiagnosticSchema,
  type DiagnosticEvidenceRef,
  type DiagnosticScope,
} from '@/lib/diagnostics/failureDiagnostic';
import { diagnosticId } from '@/lib/diagnostics/diagnosticIdentity';
import { FAILURE_REGISTRY } from '@/lib/diagnostics/failureRegistry';

const scope: DiagnosticScope = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  sourceDocumentId: '00000000-0000-4000-8000-000000000002',
  sourceArtifactId: '00000000-0000-4000-8000-000000000003',
  physicalPageNumber: 7,
  pageRepresentationDigest: 'a'.repeat(64),
};

describe('failure diagnostic registry', () => {
  it('covers every closed diagnostic emitted by existing reconstruction and recovery producers', () => {
    type ReconstructionProducerCode = PricedScheduleRejectedSpineReason
      | PricedScheduleUnassignedLineReason | PricedScheduleRecoveryDiagnosticReason;
    const reconstructionCodes = [
      'insufficient_row_structure', 'insufficient_priced_rows', 'outside_table_body',
      'ambiguous_rate_clusters', 'ambiguous_recovery_confirmation', 'recovery_closure_failed',
      'inconsistent_row_pitch', 'ambiguous_row_assignment', 'unsupported_trailing_line',
      'confirmed_recovery_unbound', 'duplicate_recovery_confirmation',
      'confirmed_recovery_not_applied', 'confirmed_recovery_evidence_changed',
      'confirmed_recovery_evidence_unverifiable',
    ] as const satisfies readonly ReconstructionProducerCode[];
    const exhaustive: Exclude<ReconstructionProducerCode,
      (typeof reconstructionCodes)[number]> extends never ? true : never = true;
    expect(exhaustive).toBe(true);
    const registryCodes = new Set<string>(DIAGNOSTIC_CODES);
    expect([...reconstructionCodes, ...RECOVERY_CONFIRMATION_DIAGNOSTICS]
      .every((code) => registryCodes.has(code))).toBe(true);
    expect(RECOVERY_GENERATION_OUTCOME_CODES.every((code) =>
      registryCodes.has(code === 'recovery_disabled' ? code : `recovery_${code}`))).toBe(true);
  });

  it('has exactly one frozen entry for every closed diagnostic code', () => {
    expect(Object.keys(FAILURE_REGISTRY).sort()).toEqual([...DIAGNOSTIC_CODES].sort());
    expect(Object.isFrozen(FAILURE_REGISTRY)).toBe(true);
    expect(Object.values(FAILURE_REGISTRY).every(Object.isFrozen)).toBe(true);
  });

  it('only names existing Recovery V2 types and intentionally maps nothing recoverable-now', () => {
    const allowed = new Set([...RECOVERY_TYPES_V2, 'pricing_rate_single_observation']);
    expect(Object.values(FAILURE_REGISTRY).every((entry) =>
      entry.recoveryType === null || allowed.has(entry.recoveryType))).toBe(true);
    expect(Object.values(FAILURE_REGISTRY).some((entry) =>
      entry.recoverability === 'recoverable_now')).toBe(false);
  });

  it('keeps frozen authority classifications exact', () => {
    expect(FAILURE_REGISTRY.page_ocr_required).toMatchObject({
      stage: 'extraction', severity: 'info', recoverability: 'not_recoverable',
      recoveryType: null, recommendedNextAction: 'none',
    });
    expect(FAILURE_REGISTRY.page_ocr_failed).toMatchObject({
      stage: 'extraction', severity: 'warning', recoverability: 'retryable_runtime_failure',
      recoveryType: null, recommendedNextAction: 'reprocess_document',
    });
    expect(FAILURE_REGISTRY.pricing_page_reconstruction_failed).toMatchObject({
      stage: 'reconstruction', severity: 'warning', recoverability: 'engineering_diagnostic',
      recoveryType: null,
    });
    expect(FAILURE_REGISTRY.ambiguous_row_assignment).toMatchObject({
      recoverability: 'recoverable_after_human_review',
      recoveryType: 'priced_schedule_continuation_attribution',
    });
    expect(FAILURE_REGISTRY.confirmed_recovery_unbound).toMatchObject({
      recoverability: 'recoverable_after_human_review',
      recommendedNextAction: 're_review_current_page',
    });
    expect(FAILURE_REGISTRY.unsupported_trailing_line).toMatchObject({
      severity: 'info', recoverability: 'not_recoverable', recoveryType: null,
    });
  });

  it('derives stable order-independent identity and changes it with page identity', () => {
    const refs: DiagnosticEvidenceRef[] = [
      { kind: 'observation', observationId: 'obs-b' },
      { kind: 'observation', observationId: 'obs-a' },
    ];
    const first = diagnosticId({ code: 'ambiguous_row_assignment', scope, evidenceRefs: refs });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(diagnosticId({ code: 'ambiguous_row_assignment', scope,
      evidenceRefs: [...refs].reverse() })).toBe(first);
    expect(diagnosticId({ code: 'ambiguous_row_assignment',
      scope: { ...scope, pageRepresentationDigest: 'b'.repeat(64) }, evidenceRefs: refs }))
      .not.toBe(first);
    expect(() => diagnosticId({ code: 'ambiguous_row_assignment',
      scope: { ...scope, pageRepresentationDigest: null }, evidenceRefs: refs }))
      .toThrow('page_scoped_diagnostic_requires_page_representation_digest');
  });

  it('keeps optional explanation outside identity and validates the complete contract', () => {
    const evidenceRefs: DiagnosticEvidenceRef[] = [
      { kind: 'observation', observationId: 'obs-a' },
    ];
    const id = diagnosticId({ code: 'ambiguous_row_assignment', scope, evidenceRefs });
    const base = {
      diagnosticId: id,
      code: 'ambiguous_row_assignment' as const,
      ...FAILURE_REGISTRY.ambiguous_row_assignment,
      scope,
      evidenceRefs,
      sourceIdentity: { extractionSnapshotId: 'snapshot-1', processingRunId: null },
      occurredAt: '2026-09-12T12:00:00.000Z',
    };
    expect(FailureDiagnosticSchema.parse(base).diagnosticId).toBe(id);
    const withExplanation = { ...base, explanation: { text: 'Bounded explanation.', model: 'm',
      promptTemplateId: 'p', promptTemplateVersion: '1', authority: 'non_authoritative' as const } };
    expect(FailureDiagnosticSchema.parse(withExplanation).diagnosticId).toBe(id);
  });
});
