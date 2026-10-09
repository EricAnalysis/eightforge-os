-- Forgewing B4.3: one durable outcome per value-reading request, on the
-- existing immutable forgewing_recovery_generation_outcomes ledger.
--
-- Every valid, authorized operator request that reaches the value-reading
-- engine leaves exactly one outcome, whatever happened: a proposal was
-- generated (a value or "unreadable"), an earlier answer was reused, or
-- Forgewing could not run because of deployment state (disabled, activation
-- not allowed), commercial or data policy (entitlement, data policy), budget,
-- the provider, the output, the evidence, or the system. Malformed or
-- unauthorized requests reach no engine and leave nothing. This is what lets
-- later improvement work tell "never needed" apart from "asked and blocked".
--
-- Outcomes are non-authoritative and explain only; they confer nothing.
--
-- A value-reading outcome is per request, not per page: it carries the anchor,
-- the requesting operator, the request digest (when a request was built) and
-- the proposal it produced or reused. Its identity is the operator's request
-- key, so a retried request records once and a new request records again.
-- It is written only through record_forgewing_value_reading_outcome, which
-- verifies the source, the operator's organization and any cited proposal.
-- The existing recovery record function cannot write one: the value-reading
-- columns it never sets are required for this type.
--
-- Additive only. New columns are nullable and constrained to
-- priced_value_reading; every widened CHECK is a strict superset of itself, and
-- the new codes and reasons are valid only for value readings, so every
-- existing recovery type is constrained exactly as before.

ALTER TABLE public.forgewing_recovery_generation_outcomes
  ADD COLUMN anchor_key text,
  ADD COLUMN request_digest_sha256 text,
  ADD COLUMN requested_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN proposal_id text;

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
    OR (recovery_type = 'priced_value_reading' AND outcome_code IN (
      'generated_proposal', 'unreadable', 'existing_result_reused', 'activation_not_allowed',
      'entitlement_missing', 'data_policy_not_approved', 'system_error'))),
  DROP CONSTRAINT forgewing_recovery_generation_outcomes_sanitized_reason_check,
  ADD CONSTRAINT forgewing_recovery_generation_outcomes_sanitized_reason_check CHECK (
    sanitized_reason IN (
      'recovery_disabled', 'budget_exhausted', 'provider_timeout',
      'provider_truncated_output', 'provider_error', 'anthropic_not_configured',
      'invalid_json', 'candidate_closure_failed', 'input_identity_closure_failed',
      'insufficient_monetary_candidates', 'unknown_candidate',
      'unknown_evidence_reference', 'proposal_value_validation_failed',
      'invalid_proposal', 'write_failed', 'not_configured', 'projection_failed')
    OR (recovery_type = 'priced_value_reading' AND sanitized_reason IN (
      'proposal_recorded', 'request_already_answered', 'kill_switch_off',
      'provider_not_configured', 'activation_disabled', 'no_entitlement',
      'entitlement_revoked', 'data_policy_not_approved', 'data_policy_revoked',
      'budget_not_configured', 'binding_changed', 'region_image_unavailable',
      'gate_lookup_failed', 'reservation_failed'))),
  DROP CONSTRAINT forgewing_recovery_generation_outcomes_provider_coherence,
  ADD CONSTRAINT forgewing_recovery_generation_outcomes_provider_coherence CHECK (
    (outcome_code IN ('budget_exhausted', 'recovery_disabled') AND NOT provider_invoked)
    OR (outcome_code IN (
      'provider_failed', 'structured_output_invalid', 'proposal_persist_failed')
      AND provider_invoked)
    OR outcome_code IN ('evidence_binding_failed', 'deterministic_validation_failed')
    -- Value readings: a refusal never reaches a provider; a generated reading always did.
    OR (outcome_code IN ('activation_not_allowed', 'entitlement_missing',
      'data_policy_not_approved', 'system_error') AND NOT provider_invoked)
    OR (outcome_code IN ('generated_proposal', 'unreadable') AND provider_invoked)
    -- A reuse is normally free; it may follow a call only when a concurrent
    -- identical request answered first.
    OR outcome_code = 'existing_result_reused'),
  ADD CONSTRAINT forgewing_generation_outcomes_value_reading_shape CHECK (
    CASE WHEN recovery_type = 'priced_value_reading' THEN
      candidate_ids = '[]'::jsonb
      AND length(btrim(anchor_key)) BETWEEN 1 AND 500
      AND requested_by IS NOT NULL
      AND (request_digest_sha256 IS NULL OR request_digest_sha256 ~ '^[0-9a-f]{64}$')
      -- A request that reached the provider, or was answered, was built.
      AND (request_digest_sha256 IS NOT NULL OR outcome_code IN (
        'recovery_disabled', 'activation_not_allowed', 'entitlement_missing',
        'data_policy_not_approved', 'budget_exhausted', 'system_error'))
      AND (proposal_id IS NOT NULL)
        = (outcome_code IN ('generated_proposal', 'unreadable', 'existing_result_reused'))
      AND (proposal_id IS NULL OR proposal_id ~ '^forgewing-proposal-value-reading-[0-9a-f]{64}$')
    ELSE
      num_nonnulls(anchor_key, request_digest_sha256, requested_by, proposal_id) = 0
    END);

CREATE INDEX forgewing_recovery_generation_outcomes_value_reading_idx
  ON public.forgewing_recovery_generation_outcomes (organization_id, source_document_id, anchor_key, observed_at)
  WHERE recovery_type = 'priced_value_reading';

CREATE FUNCTION public.record_forgewing_value_reading_outcome(
  p_organization_id uuid,
  p_source_document_id uuid,
  p_source_artifact_id uuid,
  p_extraction_snapshot_id text,
  p_physical_page_number integer,
  p_page_representation_digest text,
  p_anchor_key text,
  p_request_digest_sha256 text,
  p_requested_by uuid,
  p_request_key_digest text,
  p_outcome_code text,
  p_sanitized_reason text,
  p_provider_invoked boolean,
  p_proposal_id text
) RETURNS TABLE(outcome_row_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_inserted_id uuid;
  v_existing public.forgewing_recovery_generation_outcomes%ROWTYPE;
  v_proposal record;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_request_key_digest IS NULL OR p_request_key_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid value-reading request key' USING ERRCODE = '22023';
  END IF;
  -- The artifact ledger is the authority for document and tenant.
  IF NOT EXISTS (
    SELECT 1
    FROM public.extraction_source_artifacts artifact
    JOIN public.documents document ON document.id = artifact.source_document_id
    WHERE artifact.id = p_source_artifact_id
      AND artifact.source_document_id = p_source_document_id
      AND artifact.organization_id = p_organization_id
      AND document.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'value-reading outcome source binding mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles
                 WHERE id = p_requested_by AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'requesting operator not found in organization' USING ERRCODE = '42501';
  END IF;
  -- A produced or reused proposal must be the one this exact request answered.
  IF p_proposal_id IS NOT NULL THEN
    SELECT * INTO v_proposal FROM public.forgewing_recovery_proposals
      WHERE proposal_id = p_proposal_id AND proposal_version = 3;
    IF NOT FOUND
       OR v_proposal.organization_id IS DISTINCT FROM p_organization_id
       OR v_proposal.source_document_id IS DISTINCT FROM p_source_document_id
       OR v_proposal.anchor_key IS DISTINCT FROM p_anchor_key
       OR v_proposal.request_digest_sha256 IS DISTINCT FROM p_request_digest_sha256
       OR (p_outcome_code = 'generated_proposal' AND v_proposal.reading_outcome IS DISTINCT FROM 'value')
       OR (p_outcome_code = 'unreadable' AND v_proposal.reading_outcome IS DISTINCT FROM 'unreadable') THEN
      RAISE EXCEPTION 'value-reading outcome does not match its proposal' USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.forgewing_recovery_generation_outcomes (
    organization_id, source_document_id, source_artifact_id, extraction_snapshot_id,
    physical_page_number, page_representation_digest, diagnostic_id, recovery_type,
    outcome_code, sanitized_reason, provider_invoked, candidate_ids,
    anchor_key, request_digest_sha256, requested_by, proposal_id)
  VALUES (
    p_organization_id, p_source_document_id, p_source_artifact_id, p_extraction_snapshot_id,
    p_physical_page_number, p_page_representation_digest, p_request_key_digest, 'priced_value_reading',
    p_outcome_code, p_sanitized_reason, p_provider_invoked, '[]'::jsonb,
    p_anchor_key, p_request_digest_sha256, p_requested_by, p_proposal_id)
  ON CONFLICT (organization_id, diagnostic_id) DO NOTHING
  RETURNING id INTO v_inserted_id;
  IF v_inserted_id IS NOT NULL THEN
    RETURN QUERY SELECT v_inserted_id, true;
    RETURN;
  END IF;

  -- One request, one outcome: a replay must carry the identical outcome.
  SELECT * INTO STRICT v_existing FROM public.forgewing_recovery_generation_outcomes
    WHERE organization_id = p_organization_id AND diagnostic_id = p_request_key_digest;
  IF v_existing.recovery_type IS DISTINCT FROM 'priced_value_reading'
     OR v_existing.source_document_id IS DISTINCT FROM p_source_document_id
     OR v_existing.anchor_key IS DISTINCT FROM p_anchor_key
     OR v_existing.requested_by IS DISTINCT FROM p_requested_by
     OR v_existing.request_digest_sha256 IS DISTINCT FROM p_request_digest_sha256
     OR v_existing.outcome_code IS DISTINCT FROM p_outcome_code
     OR v_existing.sanitized_reason IS DISTINCT FROM p_sanitized_reason
     OR v_existing.provider_invoked IS DISTINCT FROM p_provider_invoked
     OR v_existing.proposal_id IS DISTINCT FROM p_proposal_id THEN
    RAISE EXCEPTION 'value-reading request already has a different outcome' USING ERRCODE = '23505';
  END IF;
  RETURN QUERY SELECT v_existing.id, false;
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_value_reading_outcome(
  uuid, uuid, uuid, text, integer, text, text, text, uuid, text, text, text, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_forgewing_value_reading_outcome(
  uuid, uuid, uuid, text, integer, text, text, text, uuid, text, text, text, boolean, text)
  TO service_role;
