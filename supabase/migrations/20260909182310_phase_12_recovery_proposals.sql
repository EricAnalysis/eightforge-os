-- Phase 12A: durable, immutable Forgewing recovery proposal identity.
--
-- Recovery V1 proposals previously existed only as TTL'd Supabase Storage
-- blobs. A blob that expires after five days cannot be the identity a human
-- review pins, so this table carries the bounded, reviewable proposal record.
-- The shadow blob remains a diagnostic raw payload only; nothing here depends
-- on its continued existence.
--
-- Authority: none. A proposal is non-authoritative by construction and has no
-- downstream effect until an exact human review accepts or modifies it.

CREATE TABLE public.forgewing_recovery_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL,
  extraction_snapshot_id text NOT NULL CHECK (btrim(extraction_snapshot_id) <> ''),
  physical_page_number integer NOT NULL CHECK (physical_page_number > 0),
  proposal_id text NOT NULL CHECK (proposal_id ~ '^forgewing-proposal-pricing-rate-cluster-[0-9a-f]{32}$'),
  proposal_digest_sha256 text NOT NULL UNIQUE CHECK (proposal_digest_sha256 ~ '^[0-9a-f]{64}$'),
  task_type text NOT NULL CHECK (task_type = 'pricing_rate_cluster_recovery'),
  schema_version text NOT NULL CHECK (btrim(schema_version) <> ''),
  recovery_reason text NOT NULL CHECK (recovery_reason = 'ambiguous_rate_clusters'),
  eligibility_reason text NOT NULL CHECK (eligibility_reason = 'ambiguous_relationship'),
  -- Forgewing V1 selects exactly one already-observed token. A recovery that
  -- would need more than one observation is out of contract and is rejected
  -- before it reaches this table.
  selected_observation_id text NOT NULL CHECK (btrim(selected_observation_id) <> ''),
  proposed_value text NOT NULL CHECK (length(proposed_value) BETWEEN 1 AND 200),
  normalized_value text NOT NULL CHECK (length(normalized_value) BETWEEN 1 AND 200),
  page_representation_digest text CHECK (page_representation_digest ~ '^[0-9a-f]{64}$'),
  -- Every eligible observation the proposal could have selected, with its
  -- authored text and geometry. This is what a "modified" review may choose
  -- from, and what Phase 14 will need to draw the source location.
  evidence jsonb NOT NULL,
  alternative_observation_ids jsonb NOT NULL,
  certainty numeric NOT NULL CHECK (certainty >= 0 AND certainty <= 1),
  reason_category text NOT NULL CHECK (btrim(reason_category) <> ''),
  provider_model text NOT NULL CHECK (btrim(provider_model) <> ''),
  prompt_template_id text NOT NULL CHECK (btrim(prompt_template_id) <> ''),
  prompt_template_version text NOT NULL CHECK (btrim(prompt_template_version) <> ''),
  authority text NOT NULL DEFAULT 'non_authoritative' CHECK (authority = 'non_authoritative'),
  requires_human_review boolean NOT NULL DEFAULT true CHECK (requires_human_review),
  -- Diagnostic pointer only. May be absent, and may expire under the shadow
  -- TTL without affecting this row or any review that pins it.
  shadow_artifact_path text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT forgewing_recovery_proposals_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT forgewing_recovery_proposals_artifact_fk
    FOREIGN KEY (organization_id, source_artifact_id)
    REFERENCES public.extraction_source_artifacts(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX forgewing_recovery_proposals_page_idx
  ON public.forgewing_recovery_proposals (organization_id, source_document_id, source_artifact_id, physical_page_number);

ALTER TABLE public.forgewing_recovery_proposals ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.reject_forgewing_recovery_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'forgewing recovery records are immutable' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER forgewing_recovery_proposals_immutable
  BEFORE UPDATE OR DELETE ON public.forgewing_recovery_proposals
  FOR EACH ROW EXECUTE FUNCTION public.reject_forgewing_recovery_mutation();

REVOKE ALL ON TABLE public.forgewing_recovery_proposals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.forgewing_recovery_proposals TO service_role;
REVOKE ALL ON FUNCTION public.reject_forgewing_recovery_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_forgewing_recovery_proposal(
  p_organization_id uuid, p_source_document_id uuid, p_source_artifact_id uuid,
  p_extraction_snapshot_id text, p_physical_page_number integer, p_proposal_id text,
  p_proposal_digest_sha256 text, p_schema_version text, p_selected_observation_id text,
  p_proposed_value text, p_normalized_value text, p_page_representation_digest text,
  p_evidence jsonb, p_alternative_observation_ids jsonb, p_certainty numeric,
  p_reason_category text, p_provider_model text, p_prompt_template_id text,
  p_prompt_template_version text, p_shadow_artifact_path text
) RETURNS TABLE(proposal_row_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_existing record;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_proposal_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_proposal_id !~ '^forgewing-proposal-pricing-rate-cluster-[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'invalid recovery proposal identity' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_evidence) <> 'array' OR jsonb_array_length(p_evidence) < 2
     OR jsonb_typeof(p_alternative_observation_ids) <> 'array'
     OR jsonb_array_length(p_alternative_observation_ids) < 1 THEN
    RAISE EXCEPTION 'invalid recovery proposal evidence' USING ERRCODE = '22023';
  END IF;
  -- The selected observation must be one this proposal actually cited.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_evidence) e
    WHERE e->>'observationId' = p_selected_observation_id
  ) THEN
    RAISE EXCEPTION 'selected observation not in evidence' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_proposal_digest_sha256, 0));
  SELECT * INTO v_existing FROM public.forgewing_recovery_proposals
    WHERE proposal_digest_sha256 = p_proposal_digest_sha256;
  IF FOUND THEN
    -- Idempotent replay of the identical proposal is fine; the same digest
    -- carrying different content is a contract violation, never an update.
    IF v_existing.organization_id <> p_organization_id
       OR v_existing.source_document_id <> p_source_document_id
       OR v_existing.source_artifact_id <> p_source_artifact_id
       OR v_existing.proposal_id <> p_proposal_id
       OR v_existing.physical_page_number <> p_physical_page_number
       OR v_existing.selected_observation_id <> p_selected_observation_id
       OR v_existing.proposed_value <> p_proposed_value
       OR v_existing.normalized_value <> p_normalized_value THEN
      RAISE EXCEPTION 'recovery proposal digest collision' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;

  INSERT INTO public.forgewing_recovery_proposals(
    organization_id, source_document_id, source_artifact_id, extraction_snapshot_id,
    physical_page_number, proposal_id, proposal_digest_sha256, task_type, schema_version,
    recovery_reason, eligibility_reason, selected_observation_id, proposed_value,
    normalized_value, page_representation_digest, evidence, alternative_observation_ids,
    certainty, reason_category, provider_model, prompt_template_id, prompt_template_version,
    shadow_artifact_path)
  VALUES (
    p_organization_id, p_source_document_id, p_source_artifact_id, p_extraction_snapshot_id,
    p_physical_page_number, p_proposal_id, p_proposal_digest_sha256,
    'pricing_rate_cluster_recovery', p_schema_version, 'ambiguous_rate_clusters',
    'ambiguous_relationship', p_selected_observation_id, p_proposed_value,
    p_normalized_value, p_page_representation_digest, p_evidence, p_alternative_observation_ids,
    p_certainty, p_reason_category, p_provider_model, p_prompt_template_id,
    p_prompt_template_version, p_shadow_artifact_path)
  RETURNING id INTO proposal_row_id;
  inserted := true;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_recovery_proposal(
  uuid,uuid,uuid,text,integer,text,text,text,text,text,text,text,jsonb,jsonb,numeric,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_forgewing_recovery_proposal(
  uuid,uuid,uuid,text,integer,text,text,text,text,text,text,text,jsonb,jsonb,numeric,text,text,text,text,text)
  TO service_role;
