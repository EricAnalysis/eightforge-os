-- Forgewing B4.3: durable failure outcomes for value readings, on the existing
-- immutable forgewing_recovery_generation_outcomes ledger.
--
-- A value-reading attempt that does not end in a proposal records why, through
-- the existing record function: a refused gate (entitlement, data policy,
-- budget), a provider failure, invalid output, failed deterministic validation,
-- a changed binding, or a failed write. Outcomes are non-authoritative and
-- explain only; they confer nothing.
--
-- Additive only. Every widened CHECK is a strict superset of itself, and the
-- new codes and reasons are valid only for recovery_type priced_value_reading,
-- so every existing recovery type is constrained exactly as before. A value
-- reading cites no recovery candidates.

ALTER TABLE public.forgewing_recovery_generation_outcomes
  DROP CONSTRAINT forgewing_recovery_generation_outcomes_recovery_type_check,
  ADD CONSTRAINT forgewing_recovery_generation_outcomes_recovery_type_check CHECK (
    recovery_type IN ('pricing_rate_single_observation',
      'pricing_rate_multi_observation_cluster',
      'priced_schedule_continuation_attribution',
      'priced_schedule_header_role_selection',
      'priced_value_reading')),
  DROP CONSTRAINT forgewing_recovery_generation_outcomes_outcome_code_check,
  ADD CONSTRAINT forgewing_recovery_generation_outcomes_outcome_code_check CHECK (
    outcome_code IN (
      'provider_failed', 'structured_output_invalid', 'evidence_binding_failed',
      'deterministic_validation_failed', 'proposal_persist_failed',
      'budget_exhausted', 'recovery_disabled')
    OR (recovery_type = 'priced_value_reading'
      AND outcome_code IN ('entitlement_missing', 'data_policy_not_approved'))),
  DROP CONSTRAINT forgewing_recovery_generation_outcomes_sanitized_reason_check,
  ADD CONSTRAINT forgewing_recovery_generation_outcomes_sanitized_reason_check CHECK (
    sanitized_reason IN (
      'recovery_disabled', 'budget_exhausted', 'provider_timeout',
      'provider_truncated_output', 'provider_error', 'anthropic_not_configured',
      'invalid_json', 'candidate_closure_failed', 'input_identity_closure_failed',
      'insufficient_monetary_candidates', 'unknown_candidate',
      'unknown_evidence_reference', 'proposal_value_validation_failed',
      'invalid_proposal', 'write_failed', 'not_configured', 'projection_failed')
    OR (recovery_type = 'priced_value_reading'
      AND sanitized_reason IN (
        'no_entitlement', 'entitlement_revoked', 'data_policy_not_approved',
        'data_policy_revoked', 'budget_not_configured', 'binding_changed',
        'region_image_unavailable'))),
  DROP CONSTRAINT forgewing_recovery_generation_outcomes_provider_coherence,
  ADD CONSTRAINT forgewing_recovery_generation_outcomes_provider_coherence CHECK (
    (outcome_code IN ('budget_exhausted', 'recovery_disabled') AND NOT provider_invoked)
    OR (outcome_code IN (
      'provider_failed', 'structured_output_invalid', 'proposal_persist_failed')
      AND provider_invoked)
    OR outcome_code IN ('evidence_binding_failed', 'deterministic_validation_failed')
    OR (outcome_code IN ('entitlement_missing', 'data_policy_not_approved') AND NOT provider_invoked)),
  ADD CONSTRAINT forgewing_generation_outcomes_value_reading_shape CHECK (
    recovery_type <> 'priced_value_reading' OR candidate_ids = '[]'::jsonb);
