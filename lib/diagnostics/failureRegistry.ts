import type { RecoveryTypeV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  DIAGNOSTIC_CODES,
  type DiagnosticAttention,
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
  attention: DiagnosticAttention;
  recoveryType: DiagnosticRecoveryType | null;
  recommendedNextAction: DiagnosticNextAction;
  summary: string;
}>;

/**
 * Attention per code, independent of recoverability. Evidence that EightForge
 * knows it could not read, refused to publish, or could not interpret opens a
 * ResolutionCase whatever its recoverability; recovery machinery and runtime
 * state stay on the diagnostics panel, because the evidence they concern is
 * already a case of its own.
 */
const ATTENTION: Readonly<Record<DiagnosticCode, DiagnosticAttention>> = Object.freeze({
  // Coverage: EightForge could not read the page sufficiently.
  page_ocr_required: 'resolution_case',
  page_ocr_abstained: 'resolution_case',
  page_ocr_failed: 'resolution_case',
  page_image_decode_failed: 'resolution_case',
  page_extraction_coverage_incomplete: 'resolution_case',
  expected_pricing_page_no_usable_evidence: 'resolution_case',
  page_skipped_due_evidence_limit: 'resolution_case',
  // Structure and pricing authority EightForge could not settle.
  pricing_page_reconstruction_failed: 'resolution_case',
  priced_header_semantics_unresolved: 'resolution_case',
  ruling_line_pricing_authority_withheld: 'resolution_case',
  // Priced lines found and withheld, whatever recovery type exists for them.
  ambiguous_rate_clusters: 'resolution_case',
  insufficient_row_structure: 'resolution_case',
  outside_table_body: 'resolution_case',
  ambiguous_row_continuation: 'resolution_case',
  inconsistent_row_pitch: 'resolution_case',
  insufficient_priced_rows: 'resolution_case',
  ambiguous_recovery_confirmation: 'resolution_case',
  recovery_closure_failed: 'resolution_case',
  unpriced_row: 'resolution_case',
  // Covered by the withheld rows' own cases, or not pricing evidence.
  ambiguous_row_assignment: 'diagnostics_panel',
  unsupported_trailing_line: 'diagnostics_panel',
  // Recovery machinery: the evidence concerned is its own case.
  confirmed_recovery_unbound: 'diagnostics_panel',
  confirmed_recovery_evidence_changed: 'diagnostics_panel',
  confirmed_recovery_evidence_unverifiable: 'diagnostics_panel',
  duplicate_recovery_confirmation: 'diagnostics_panel',
  confirmed_recovery_not_applied: 'diagnostics_panel',
  confirmed_header_option_not_offered: 'diagnostics_panel',
  ambiguous_recovery_authority: 'diagnostics_panel',
  incoherent_recovery_confirmation: 'diagnostics_panel',
  recovery_source_evidence_unbound: 'diagnostics_panel',
  recovery_provider_failed: 'diagnostics_panel',
  recovery_structured_output_invalid: 'diagnostics_panel',
  recovery_evidence_binding_failed: 'diagnostics_panel',
  recovery_deterministic_validation_failed: 'diagnostics_panel',
  recovery_proposal_persist_failed: 'diagnostics_panel',
  recovery_budget_exhausted: 'diagnostics_panel',
  recovery_disabled: 'diagnostics_panel',
  // Runtime state.
  document_processing_failed: 'diagnostics_panel',
  document_processing_expired: 'diagnostics_panel',
  source_identity_read_failed: 'diagnostics_panel',
  recovery_read_failed: 'diagnostics_panel',
});

const entry = (
  stage: DiagnosticStage,
  severity: DiagnosticSeverity,
  recoverability: DiagnosticRecoverability,
  recoveryType: RecoveryTypeV2 | 'pricing_rate_single_observation' | null,
  recommendedNextAction: DiagnosticNextAction,
  summary: string,
): Omit<FailureRegistryEntry, 'attention'> => Object.freeze({
  stage, severity, recoverability, recoveryType, recommendedNextAction, summary,
});

const BASE_REGISTRY: Readonly<Record<DiagnosticCode, Omit<FailureRegistryEntry, 'attention'>>> =
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
    priced_header_semantics_unresolved: entry('reconstruction', 'warning',
      'recoverable_after_human_review', 'priced_schedule_header_role_selection', 're_review_current_page',
      'The priced table structure was read, but a required header role is not recognized, so no row is priced.'),
    ruling_line_pricing_authority_withheld: entry('reconstruction', 'blocking',
      'engineering_diagnostic', null, 'engineering_attention',
      'Page pricing was withheld because ruling-line authority metadata cannot be verified. Structural evidence remains available.'),
    ambiguous_row_assignment: entry('reconstruction', 'warning', 'recoverable_after_human_review',
      'priced_schedule_continuation_attribution', 'review_withheld_row',
      'A source line could not be attributed to one priced row deterministically.'),
    unpriced_row: entry('reconstruction', 'warning', 'engineering_diagnostic', null,
      'engineering_attention',
      'A source-backed row carries no recognized authored price marker, so it is not published as a priced row.'),
    ambiguous_rate_clusters: entry('reconstruction', 'warning', 'recoverable_after_human_review',
      'pricing_rate_multi_observation_cluster', 'review_withheld_row',
      'A priced row contains more than one plausible authored rate cluster.'),
    unsupported_trailing_line: entry('reconstruction', 'info', 'not_recoverable', null, 'none',
      'A trailing authored line could not be attached to the priced table deterministically.'),
    insufficient_row_structure: entry('reconstruction', 'info', 'not_recoverable', null, 'none',
      'The source line did not contain enough row structure to publish.'),
    outside_table_body: entry('reconstruction', 'info', 'not_recoverable', null, 'none',
      'The source line was outside the table body established by accepted rows.'),
    ambiguous_row_continuation: entry('reconstruction', 'warning', 'recoverable_after_human_review',
      'priced_schedule_continuation_attribution', 'review_withheld_row',
      'A priced row was withheld because a line carrying part of a row\'s meaning could belong to it or its neighbour.'),
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
    confirmed_recovery_evidence_changed: entry('recovery_authority', 'blocking',
      'recoverable_after_human_review', null, 're_review_current_page',
      'The page evidence changed after this recovery was confirmed, so the confirmation was not reapplied.'),
    confirmed_recovery_evidence_unverifiable: entry('recovery_authority', 'blocking',
      'recoverable_after_human_review', null, 're_review_current_page',
      'The reviewed page evidence cannot be proven unchanged, so the confirmation was not reapplied.'),
    duplicate_recovery_confirmation: entry('recovery_authority', 'blocking',
      'engineering_diagnostic', null, 'engineering_attention',
      'The same recovery confirmation was supplied more than once.'),
    confirmed_recovery_not_applied: entry('recovery_authority', 'blocking',
      'engineering_diagnostic', null, 'engineering_attention',
      'The bound confirmation did not admit a priced row.'),
    confirmed_header_option_not_offered: entry('recovery_authority', 'blocking',
      'recoverable_after_human_review', 'priced_schedule_header_role_selection', 're_review_current_page',
      'The selected header option is no longer offered by the current reconstruction.'),
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
    document_processing_expired: entry('runtime', 'blocking', 'retryable_runtime_failure', null,
      'reprocess_document',
      'Processing is still recorded as running but has exceeded the platform maximum duration, so it is expired.'),
    source_identity_read_failed: entry('runtime', 'warning', 'retryable_runtime_failure', null,
      'reprocess_document', 'The source identity could not be read safely.'),
    recovery_read_failed: entry('runtime', 'warning', 'retryable_runtime_failure', null,
      'retry_read', 'Recovery state could not be read safely.'),
  });

export const FAILURE_REGISTRY: Readonly<Record<DiagnosticCode, FailureRegistryEntry>> = Object.freeze(
  Object.fromEntries(DIAGNOSTIC_CODES.map((code) => [code,
    Object.freeze({ ...BASE_REGISTRY[code], attention: ATTENTION[code] })])) as Record<DiagnosticCode, FailureRegistryEntry>);

export function getFailureRegistryEntry(code: DiagnosticCode): FailureRegistryEntry {
  return FAILURE_REGISTRY[code];
}

export function diagnosticRegistryCodes(): readonly DiagnosticCode[] {
  return DIAGNOSTIC_CODES;
}
