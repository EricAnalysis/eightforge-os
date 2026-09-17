import type { RecoveryTypeV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  DIAGNOSTIC_CODES,
  type DiagnosticCode,
  type DiagnosticNextAction,
  type DiagnosticRecoverability,
  type DiagnosticRecoveryType,
  type DiagnosticSeverity,
  type DiagnosticStage,
} from '@/lib/diagnostics/failureDiagnostic';

export type FailureRegistryEntry = Readonly<{
  stage: DiagnosticStage;
  severity: DiagnosticSeverity;
  recoverability: DiagnosticRecoverability;
  recoveryType: DiagnosticRecoveryType | null;
  recommendedNextAction: DiagnosticNextAction;
  summary: string;
}>;

const entry = (
  stage: DiagnosticStage,
  severity: DiagnosticSeverity,
  recoverability: DiagnosticRecoverability,
  recoveryType: RecoveryTypeV2 | 'pricing_rate_single_observation' | null,
  recommendedNextAction: DiagnosticNextAction,
  summary: string,
): FailureRegistryEntry => Object.freeze({
  stage, severity, recoverability, recoveryType, recommendedNextAction, summary,
});

export const FAILURE_REGISTRY: Readonly<Record<DiagnosticCode, FailureRegistryEntry>> =
  Object.freeze({
    page_ocr_required: entry('extraction', 'info', 'not_recoverable', null, 'none',
      'This page requires OCR before extraction coverage is complete.'),
    page_ocr_abstained: entry('extraction', 'warning', 'engineering_diagnostic', null,
      'engineering_attention', 'OCR completed without producing usable page evidence.'),
    page_ocr_failed: entry('extraction', 'warning', 'retryable_runtime_failure', null,
      'reprocess_document', 'OCR failed before page extraction coverage was complete.'),
    page_image_decode_failed: entry('extraction', 'warning', 'engineering_diagnostic', null,
      'engineering_attention',
      'A page image could not be proven decoded, so OCR coverage of this page cannot be trusted.'),
    page_extraction_coverage_incomplete: entry('extraction', 'warning',
      'engineering_diagnostic', null, 'engineering_attention',
      'Deterministic extraction coverage is incomplete for this page.'),
    expected_pricing_page_no_usable_evidence: entry('extraction', 'warning',
      'engineering_diagnostic', null, 'engineering_attention',
      'An expected pricing page produced no usable extraction evidence.'),
    page_skipped_due_evidence_limit: entry('extraction', 'warning',
      'engineering_diagnostic', null, 'engineering_attention',
      'This page was not inspected because it fell outside the evidence processing limit.'),
    pricing_page_reconstruction_failed: entry('reconstruction', 'warning',
      'engineering_diagnostic', null, 'engineering_attention',
      'Pricing evidence was extracted, but the page could not be reconstructed deterministically.'),
    ambiguous_row_assignment: entry('reconstruction', 'warning', 'recoverable_after_human_review',
      'priced_schedule_continuation_attribution', 'review_withheld_row',
      'A source line could not be attributed to one priced row deterministically.'),
    ambiguous_rate_clusters: entry('reconstruction', 'warning', 'recoverable_after_human_review',
      'pricing_rate_multi_observation_cluster', 'review_withheld_row',
      'A priced row contains more than one plausible authored rate cluster.'),
    unsupported_trailing_line: entry('reconstruction', 'info', 'not_recoverable', null, 'none',
      'A trailing authored line could not be attached to the priced table deterministically.'),
    insufficient_row_structure: entry('reconstruction', 'info', 'not_recoverable', null, 'none',
      'The source line did not contain enough row structure to publish.'),
    outside_table_body: entry('reconstruction', 'info', 'not_recoverable', null, 'none',
      'The source line was outside the table body established by accepted rows.'),
    inconsistent_row_pitch: entry('reconstruction', 'info', 'not_recoverable', null, 'none',
      'The source line did not match the table row spacing established by accepted rows.'),
    insufficient_priced_rows: entry('reconstruction', 'warning', 'engineering_diagnostic', null,
      'engineering_attention', 'Too few independent priced rows survived to publish the table.'),
    ambiguous_recovery_confirmation: entry('recovery_authority', 'blocking', 'not_recoverable', null,
      'resolve_recovery_review', 'More than one recovery confirmation applies to the withheld row.'),
    recovery_closure_failed: entry('recovery_authority', 'blocking', 'not_recoverable', null,
      'reject_and_re_review', 'The confirmed evidence did not close over the reconstructed row.'),
    confirmed_recovery_unbound: entry('recovery_authority', 'blocking',
      'recoverable_after_human_review', null, 're_review_current_page',
      'The confirmed recovery no longer binds to the current page representation.'),
    duplicate_recovery_confirmation: entry('recovery_authority', 'blocking',
      'engineering_diagnostic', null, 'engineering_attention',
      'The same recovery confirmation was supplied more than once.'),
    confirmed_recovery_not_applied: entry('recovery_authority', 'blocking',
      'engineering_diagnostic', null, 'engineering_attention',
      'The bound confirmation did not admit a priced row.'),
    ambiguous_recovery_authority: entry('recovery_authority', 'blocking', 'not_recoverable', null,
      'engineering_or_product_attention', 'More than one immutable review claims recovery authority.'),
    incoherent_recovery_confirmation: entry('recovery_authority', 'blocking',
      'engineering_diagnostic', null, 'engineering_attention',
      'The review receipt does not satisfy the recovery confirmation contract.'),
    recovery_source_evidence_unbound: entry('recovery_authority', 'warning',
      'recoverable_after_human_review', null, 'reprocess_then_re_review',
      'The recovery source evidence does not bind to the current source representation.'),
    recovery_provider_failed: entry('recovery_generation', 'info', 'retryable_runtime_failure', null,
      'reprocess_document', 'The recovery provider failed before producing a reviewable result.'),
    recovery_structured_output_invalid: entry('recovery_generation', 'warning',
      'engineering_diagnostic', null, 'engineering_attention',
      'The recovery provider output did not satisfy the closed result contract.'),
    recovery_evidence_binding_failed: entry('recovery_generation', 'warning',
      'engineering_diagnostic', null, 'engineering_attention',
      'The recovery result did not bind to the supplied evidence.'),
    recovery_deterministic_validation_failed: entry('recovery_generation', 'warning',
      'engineering_diagnostic', null, 'engineering_attention',
      'The recovery result failed deterministic validation.'),
    recovery_proposal_persist_failed: entry('recovery_generation', 'blocking',
      'retryable_runtime_failure', null, 'reprocess_document',
      'The reviewable recovery proposal could not be persisted.'),
    recovery_budget_exhausted: entry('recovery_generation', 'info', 'retryable_runtime_failure', null,
      'none', 'Recovery evaluation is queued for a later standard processing run.'),
    recovery_disabled: entry('recovery_generation', 'info', 'not_recoverable', null, 'none',
      'Recovery generation is not enabled under the current operational policy.'),
    document_processing_failed: entry('runtime', 'blocking', 'retryable_runtime_failure', null,
      'reprocess_document', 'Document processing failed before completion.'),
    source_identity_read_failed: entry('runtime', 'warning', 'retryable_runtime_failure', null,
      'reprocess_document', 'The source identity could not be read safely.'),
    recovery_read_failed: entry('runtime', 'warning', 'retryable_runtime_failure', null,
      'retry_read', 'Recovery state could not be read safely.'),
  } satisfies Record<DiagnosticCode, FailureRegistryEntry>);

export function getFailureRegistryEntry(code: DiagnosticCode): FailureRegistryEntry {
  return FAILURE_REGISTRY[code];
}

export function diagnosticRegistryCodes(): readonly DiagnosticCode[] {
  return DIAGNOSTIC_CODES;
}
