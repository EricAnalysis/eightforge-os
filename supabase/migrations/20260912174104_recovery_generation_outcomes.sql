-- Phase 15B: immutable, non-authoritative recovery-generation failure outcomes.
-- These rows explain why an existing deterministic recovery candidate did not
-- become a reviewable proposal. They confer no recovery or canonical authority.

CREATE FUNCTION public.is_valid_recovery_generation_candidate_ids(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) BETWEEN 0 AND 32
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) candidate
      WHERE jsonb_typeof(candidate) IS DISTINCT FROM 'string'
        OR candidate #>> '{}' !~ '^recovery-candidate-v2-[0-9a-f]{64}$'
    )
    AND (
      SELECT count(*) = count(DISTINCT candidate #>> '{}')
      FROM jsonb_array_elements(value) candidate
    );
$$;

REVOKE ALL ON FUNCTION public.is_valid_recovery_generation_candidate_ids(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.forgewing_recovery_generation_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL,
  extraction_snapshot_id text NOT NULL CHECK (btrim(extraction_snapshot_id) <> ''),
  physical_page_number integer NOT NULL CHECK (physical_page_number > 0),
  page_representation_digest text NOT NULL CHECK (
    page_representation_digest ~ '^[0-9a-f]{64}$'),
  diagnostic_id text NOT NULL CHECK (diagnostic_id ~ '^[0-9a-f]{64}$'),
  recovery_type text NOT NULL CHECK (recovery_type IN (
    'pricing_rate_single_observation',
    'pricing_rate_multi_observation_cluster',
    'priced_schedule_continuation_attribution')),
  outcome_code text NOT NULL CHECK (outcome_code IN (
    'provider_failed', 'structured_output_invalid', 'evidence_binding_failed',
    'deterministic_validation_failed', 'proposal_persist_failed',
    'budget_exhausted', 'recovery_disabled')),
  sanitized_reason text NOT NULL CHECK (sanitized_reason IN (
    'recovery_disabled', 'budget_exhausted', 'provider_timeout',
    'provider_truncated_output', 'provider_error', 'anthropic_not_configured',
    'invalid_json', 'candidate_closure_failed', 'input_identity_closure_failed',
    'insufficient_monetary_candidates', 'unknown_candidate',
    'unknown_evidence_reference', 'proposal_value_validation_failed',
    'invalid_proposal', 'write_failed', 'not_configured', 'projection_failed')),
  provider_invoked boolean NOT NULL,
  candidate_ids jsonb NOT NULL
    CHECK (public.is_valid_recovery_generation_candidate_ids(candidate_ids)),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT forgewing_recovery_generation_outcomes_org_diagnostic_unique
    UNIQUE (organization_id, diagnostic_id),
  CONSTRAINT forgewing_recovery_generation_outcomes_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT forgewing_recovery_generation_outcomes_artifact_fk
    FOREIGN KEY (organization_id, source_artifact_id)
    REFERENCES public.extraction_source_artifacts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT forgewing_recovery_generation_outcomes_provider_coherence CHECK (
    (outcome_code IN ('budget_exhausted', 'recovery_disabled') AND NOT provider_invoked)
    OR (outcome_code IN (
      'provider_failed', 'structured_output_invalid', 'proposal_persist_failed')
      AND provider_invoked)
    OR outcome_code IN ('evidence_binding_failed', 'deterministic_validation_failed'))
);

CREATE INDEX forgewing_recovery_generation_outcomes_document_idx
  ON public.forgewing_recovery_generation_outcomes
  (organization_id, source_document_id, observed_at, diagnostic_id);

ALTER TABLE public.forgewing_recovery_generation_outcomes ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER forgewing_recovery_generation_outcomes_immutable
  BEFORE UPDATE OR DELETE ON public.forgewing_recovery_generation_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.reject_forgewing_recovery_mutation();

REVOKE ALL ON TABLE public.forgewing_recovery_generation_outcomes
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.forgewing_recovery_generation_outcomes TO service_role;

CREATE FUNCTION public.record_forgewing_recovery_generation_outcome(
  p_organization_id uuid,
  p_source_document_id uuid,
  p_source_artifact_id uuid,
  p_extraction_snapshot_id text,
  p_physical_page_number integer,
  p_page_representation_digest text,
  p_diagnostic_id text,
  p_recovery_type text,
  p_outcome_code text,
  p_sanitized_reason text,
  p_provider_invoked boolean,
  p_candidate_ids jsonb
) RETURNS TABLE(outcome_row_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_inserted_id uuid;
  v_existing public.forgewing_recovery_generation_outcomes%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.extraction_source_artifacts artifact
    JOIN public.documents document ON document.id = artifact.source_document_id
    WHERE artifact.id = p_source_artifact_id
      AND artifact.source_document_id = p_source_document_id
      AND artifact.organization_id = p_organization_id
      AND document.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'recovery generation outcome source binding mismatch'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.forgewing_recovery_generation_outcomes (
    organization_id, source_document_id, source_artifact_id, extraction_snapshot_id,
    physical_page_number, page_representation_digest, diagnostic_id, recovery_type,
    outcome_code, sanitized_reason, provider_invoked, candidate_ids)
  VALUES (
    p_organization_id, p_source_document_id, p_source_artifact_id, p_extraction_snapshot_id,
    p_physical_page_number, p_page_representation_digest, p_diagnostic_id, p_recovery_type,
    p_outcome_code, p_sanitized_reason, p_provider_invoked, p_candidate_ids)
  ON CONFLICT (organization_id, diagnostic_id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    RETURN QUERY SELECT v_inserted_id, true;
    RETURN;
  END IF;

  SELECT * INTO STRICT v_existing
  FROM public.forgewing_recovery_generation_outcomes
  WHERE organization_id = p_organization_id AND diagnostic_id = p_diagnostic_id;
  IF v_existing.source_document_id IS DISTINCT FROM p_source_document_id
     OR v_existing.source_artifact_id IS DISTINCT FROM p_source_artifact_id
     OR v_existing.extraction_snapshot_id IS DISTINCT FROM p_extraction_snapshot_id
     OR v_existing.physical_page_number IS DISTINCT FROM p_physical_page_number
     OR v_existing.page_representation_digest IS DISTINCT FROM p_page_representation_digest
     OR v_existing.recovery_type IS DISTINCT FROM p_recovery_type
     OR v_existing.outcome_code IS DISTINCT FROM p_outcome_code
     OR v_existing.sanitized_reason IS DISTINCT FROM p_sanitized_reason
     OR v_existing.provider_invoked IS DISTINCT FROM p_provider_invoked
     OR v_existing.candidate_ids IS DISTINCT FROM p_candidate_ids THEN
    RAISE EXCEPTION 'recovery generation diagnostic identity collision'
      USING ERRCODE = '23505';
  END IF;
  RETURN QUERY SELECT v_existing.id, false;
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_recovery_generation_outcome(
  uuid,uuid,uuid,text,integer,text,text,text,text,text,boolean,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_forgewing_recovery_generation_outcome(
  uuid,uuid,uuid,text,integer,text,text,text,text,text,boolean,jsonb)
  TO service_role;
