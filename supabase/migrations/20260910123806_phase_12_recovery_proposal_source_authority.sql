-- Phase 12 bounded remediation: close the recovery persistence authority seams.
--
-- The source artifact ledger already establishes the authoritative
-- artifact -> document -> organization chain. Recovery proposal persistence
-- must validate that exact tuple because this SECURITY DEFINER function cannot
-- rely on caller RLS. The same boundary also rejects malformed selectable
-- evidence and treats an idempotency digest as exact immutable content identity.

CREATE OR REPLACE FUNCTION public.record_forgewing_recovery_proposal(
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
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_proposal_digest_sha256 IS NULL
     OR p_proposal_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_proposal_id IS NULL
     OR p_proposal_id !~ '^forgewing-proposal-pricing-rate-cluster-[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'invalid recovery proposal identity' USING ERRCODE = '22023';
  END IF;

  -- The artifact ledger is the authority for both source document and tenant.
  IF NOT EXISTS (
    SELECT 1
    FROM public.extraction_source_artifacts artifact
    JOIN public.documents document ON document.id = artifact.source_document_id
    WHERE artifact.id = p_source_artifact_id
      AND artifact.source_document_id = p_source_document_id
      AND artifact.organization_id = p_organization_id
      AND document.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'recovery proposal source binding mismatch' USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_alternative_observation_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid recovery proposal evidence' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_evidence) NOT BETWEEN 2 AND 32
     OR jsonb_array_length(p_alternative_observation_ids) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'invalid recovery proposal evidence' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_evidence) evidence
    WHERE jsonb_typeof(evidence) IS DISTINCT FROM 'object'
      OR jsonb_typeof(evidence->'observationId') IS DISTINCT FROM 'string'
      OR btrim(evidence->>'observationId') = ''
      OR jsonb_typeof(evidence->'rawText') IS DISTINCT FROM 'string'
      OR length(evidence->>'rawText') NOT BETWEEN 1 AND 200
      OR jsonb_typeof(evidence->'sourceLayer') IS DISTINCT FROM 'string'
      OR evidence->>'sourceLayer' NOT IN ('pdf_native_text', 'ocr')
      OR jsonb_typeof(evidence->'eligible') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(evidence->'boundingBox') IS DISTINCT FROM 'object'
      OR jsonb_typeof(evidence->'boundingBox'->'xMin') IS DISTINCT FROM 'number'
      OR jsonb_typeof(evidence->'boundingBox'->'xMax') IS DISTINCT FROM 'number'
      OR jsonb_typeof(evidence->'boundingBox'->'yMin') IS DISTINCT FROM 'number'
      OR jsonb_typeof(evidence->'boundingBox'->'yMax') IS DISTINCT FROM 'number'
  ) OR (
    SELECT count(*) IS DISTINCT FROM count(DISTINCT evidence->>'observationId')
    FROM jsonb_array_elements(p_evidence) evidence
  ) THEN
    RAISE EXCEPTION 'invalid recovery proposal evidence' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_evidence) evidence
    WHERE evidence->>'observationId' = p_selected_observation_id
      AND evidence->'eligible' = 'true'::jsonb
      AND evidence->>'rawText' = p_proposed_value
  ) THEN
    RAISE EXCEPTION 'selected observation is not eligible proposal evidence'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_alternative_observation_ids) alternative
    WHERE jsonb_typeof(alternative) IS DISTINCT FROM 'string'
      OR btrim(alternative #>> '{}') = ''
      OR alternative #>> '{}' = p_selected_observation_id
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_evidence) evidence
        WHERE evidence->>'observationId' = alternative #>> '{}'
          AND evidence->'eligible' = 'true'::jsonb
      )
  ) OR (
    SELECT count(*) IS DISTINCT FROM count(DISTINCT alternative #>> '{}')
    FROM jsonb_array_elements(p_alternative_observation_ids) alternative
  ) THEN
    RAISE EXCEPTION 'alternative observations are not eligible proposal evidence'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_proposal_digest_sha256, 0));
  SELECT * INTO v_existing FROM public.forgewing_recovery_proposals
    WHERE proposal_digest_sha256 = p_proposal_digest_sha256;
  IF FOUND THEN
    IF v_existing.organization_id IS DISTINCT FROM p_organization_id
       OR v_existing.source_document_id IS DISTINCT FROM p_source_document_id
       OR v_existing.source_artifact_id IS DISTINCT FROM p_source_artifact_id
       OR v_existing.extraction_snapshot_id IS DISTINCT FROM p_extraction_snapshot_id
       OR v_existing.physical_page_number IS DISTINCT FROM p_physical_page_number
       OR v_existing.proposal_id IS DISTINCT FROM p_proposal_id
       OR v_existing.schema_version IS DISTINCT FROM p_schema_version
       OR v_existing.selected_observation_id IS DISTINCT FROM p_selected_observation_id
       OR v_existing.proposed_value IS DISTINCT FROM p_proposed_value
       OR v_existing.normalized_value IS DISTINCT FROM p_normalized_value
       OR v_existing.page_representation_digest IS DISTINCT FROM p_page_representation_digest
       OR v_existing.evidence IS DISTINCT FROM p_evidence
       OR v_existing.alternative_observation_ids IS DISTINCT FROM p_alternative_observation_ids
       OR v_existing.certainty IS DISTINCT FROM p_certainty
       OR v_existing.reason_category IS DISTINCT FROM p_reason_category
       OR v_existing.provider_model IS DISTINCT FROM p_provider_model
       OR v_existing.prompt_template_id IS DISTINCT FROM p_prompt_template_id
       OR v_existing.prompt_template_version IS DISTINCT FROM p_prompt_template_version
       OR v_existing.shadow_artifact_path IS DISTINCT FROM p_shadow_artifact_path THEN
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

-- Resolve and authorize the exact proposal before honoring review idempotency.
-- A caller-provided request digest is never itself tenant authorization.
CREATE OR REPLACE FUNCTION public.record_forgewing_recovery_proposal_review(
  p_organization_id uuid, p_proposal_id text, p_proposal_digest_sha256 text,
  p_reviewer_actor_id uuid, p_disposition text, p_confirmed_observation_id text,
  p_reviewer_rationale text, p_review_request_digest_sha256 text
) RETURNS TABLE(
  review_id uuid, review_version integer, proposal_row_id uuid,
  confirmed_observation_id text, confirmed_raw_text text, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_proposal record;
  v_existing record;
  v_version integer;
  v_confirmed_text text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_proposal_id IS NULL OR p_reviewer_actor_id IS NULL
     OR p_proposal_digest_sha256 IS NULL
     OR p_proposal_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_review_request_digest_sha256 IS NULL
     OR p_review_request_digest_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid recovery review identity' USING ERRCODE = '22023';
  END IF;
  IF p_disposition IS NULL OR p_disposition NOT IN ('accepted','modified','rejected','deferred')
     OR p_reviewer_rationale IS NULL
     OR length(btrim(p_reviewer_rationale)) NOT BETWEEN 1 AND 4000
     OR ((p_disposition IN ('accepted','modified')) <> (p_confirmed_observation_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'review disposition incoherent' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_proposal_digest_sha256, 0));

  SELECT * INTO v_proposal FROM public.forgewing_recovery_proposals
    WHERE proposal_id = p_proposal_id AND proposal_digest_sha256 = p_proposal_digest_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact recovery proposal not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_proposal.organization_id IS DISTINCT FROM p_organization_id
     OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = p_reviewer_actor_id AND organization_id = p_organization_id
     ) THEN
    RAISE EXCEPTION 'recovery review authority mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing FROM public.forgewing_recovery_proposal_reviews
    WHERE review_request_digest_sha256 = p_review_request_digest_sha256;
  IF FOUND THEN
    IF v_existing.organization_id IS DISTINCT FROM p_organization_id
       OR v_existing.proposal_row_id IS DISTINCT FROM v_proposal.id
       OR v_existing.proposal_digest_sha256 IS DISTINCT FROM p_proposal_digest_sha256
       OR v_existing.reviewer_actor_id IS DISTINCT FROM p_reviewer_actor_id
       OR v_existing.disposition IS DISTINCT FROM p_disposition
       OR v_existing.confirmed_observation_id IS DISTINCT FROM p_confirmed_observation_id
       OR v_existing.reviewer_rationale IS DISTINCT FROM btrim(p_reviewer_rationale) THEN
      RAISE EXCEPTION 'review request digest collision' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.review_version, v_existing.proposal_row_id,
      v_existing.confirmed_observation_id, v_existing.confirmed_raw_text, false;
    RETURN;
  END IF;

  IF p_confirmed_observation_id IS NOT NULL THEN
    SELECT evidence->>'rawText' INTO v_confirmed_text
      FROM jsonb_array_elements(v_proposal.evidence) evidence
      WHERE evidence->>'observationId' = p_confirmed_observation_id
        AND evidence->'eligible' = 'true'::jsonb;
    IF v_confirmed_text IS NULL THEN
      RAISE EXCEPTION 'confirmed observation is not eligible proposal evidence'
        USING ERRCODE = '22023';
    END IF;
    IF p_disposition = 'accepted'
       AND p_confirmed_observation_id <> v_proposal.selected_observation_id THEN
      RAISE EXCEPTION 'accepted review must confirm the proposed observation'
        USING ERRCODE = '22023';
    END IF;
    IF p_disposition = 'modified'
       AND p_confirmed_observation_id = v_proposal.selected_observation_id THEN
      RAISE EXCEPTION 'modified review must confirm a different observation'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT coalesce(pg_catalog.max(review.review_version), 0) + 1 INTO v_version
    FROM public.forgewing_recovery_proposal_reviews review
    WHERE review.proposal_row_id = v_proposal.id;

  INSERT INTO public.forgewing_recovery_proposal_reviews(
    organization_id, proposal_row_id, proposal_digest_sha256, review_version,
    reviewer_actor_id, disposition, confirmed_observation_id, confirmed_raw_text,
    reviewer_rationale, review_request_digest_sha256)
  VALUES (
    p_organization_id, v_proposal.id, p_proposal_digest_sha256, v_version,
    p_reviewer_actor_id, p_disposition, p_confirmed_observation_id, v_confirmed_text,
    btrim(p_reviewer_rationale), p_review_request_digest_sha256)
  RETURNING id INTO review_id;
  review_version := v_version;
  proposal_row_id := v_proposal.id;
  confirmed_observation_id := p_confirmed_observation_id;
  confirmed_raw_text := v_confirmed_text;
  inserted := true;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_recovery_proposal_review(
  uuid,text,text,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_forgewing_recovery_proposal_review(
  uuid,text,text,uuid,text,text,text,text) TO service_role;
