-- ============================================================================
-- Manual correction provenance (B8.4b)
--
-- A human correction names the historical producer of the evidence it
-- corrected: the exact source extraction and the deployment revision that
-- extraction recorded when it ran. B8 measurement attributes a correction to
-- that producer, never to the deployment running when the person clicked
-- Correct.
--
-- Derived, never chosen by a client:
--   * with a cited Forgewing proposal: the proposal's pinned extraction;
--   * otherwise: the extraction the trusted server verified the region
--     against (service_role only), re-checked here against document,
--     organization and source artifact.
-- If no extraction binds, the columns stay NULL and the correction proceeds
-- exactly as before. The revision is copied from the extraction's own
-- runtime_identity_v1; an extraction that predates it records no revision.
--
-- Additive: three nullable columns and one trailing DEFAULT NULL parameter.
-- Existing positional and named calls keep working. Not part of the request
-- digest or replay comparison: it is server-derived provenance, not request
-- identity, so an idempotent retry still returns the original row.
-- ============================================================================

ALTER TABLE public.human_fact_assertions
  ADD COLUMN IF NOT EXISTS source_extraction_id uuid,
  ADD COLUMN IF NOT EXISTS source_deployment_revision text,
  ADD COLUMN IF NOT EXISTS source_deployment_environment text;

DO $b84b_assertion_provenance$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.human_fact_assertions'::regclass
        AND conname = 'human_fact_assertions_source_producer_check') THEN
    ALTER TABLE public.human_fact_assertions
      ADD CONSTRAINT human_fact_assertions_source_producer_check CHECK (
        (source_deployment_revision IS NULL OR source_deployment_revision ~ '^[a-f0-9]{40}$')
        AND (source_deployment_environment IS NULL
          OR source_deployment_environment IN ('production', 'preview', 'development'))
        -- A revision is only ever read from a named source extraction.
        AND (source_extraction_id IS NOT NULL OR source_deployment_revision IS NULL)
        AND (source_deployment_revision IS NOT NULL OR source_deployment_environment IS NULL)
        AND (source_extraction_id IS NULL OR source_binding = 'region_bound'));
  END IF;
END
$b84b_assertion_provenance$;

-- Replace rather than overload, so no older signature bypasses the derivation.
DROP FUNCTION public.record_region_bound_human_fact_assertion(uuid,uuid,uuid,text,jsonb,text,text,uuid,integer,jsonb,text,text,text[],text,text,text,text,uuid,text,jsonb);

CREATE FUNCTION public.record_region_bound_human_fact_assertion(
  p_organization_id uuid,
  p_actor_id uuid,
  p_source_document_id uuid,
  p_fact_key text,
  p_asserted_value jsonb,
  p_status text,
  p_reason text,
  p_source_artifact_id uuid,
  p_physical_page_number integer,
  p_source_region jsonb,
  p_page_representation_digest text,
  p_parser_version text,
  p_source_observation_ids text[],
  p_original_source_text text,
  p_anchor_key text,
  p_review_origin text,
  p_forgewing_proposal_id text,
  p_supersedes_assertion_id uuid,
  p_request_digest_sha256 text,
  p_customer_mapping_evidence jsonb DEFAULT NULL,
  p_source_extraction_id uuid DEFAULT NULL
) RETURNS TABLE(assertion_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_existing record;
  v_head_count integer;
  v_head_id uuid;
  v_proposal record;
  v_asserted_rate_row jsonb;
  v_origin text;
  v_source_extraction_id uuid;
  v_source_identity jsonb;
  v_source_revision text;
  v_source_environment text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_request_digest_sha256 IS NULL OR p_request_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_page_representation_digest IS NULL OR p_page_representation_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid region assertion identity' USING ERRCODE = '22023';
  END IF;
  IF p_fact_key IS NULL OR btrim(p_fact_key) = '' OR p_anchor_key IS NULL OR btrim(p_anchor_key) = ''
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'region assertion requires fact key, anchor and reason' USING ERRCODE = '22023';
  END IF;
  -- The caller never chooses an AI origin. Without a proposal the value is
  -- the operator's own; with one, this function decides how it was used.
  IF p_forgewing_proposal_id IS NULL THEN
    IF p_review_origin IS DISTINCT FROM 'operator_entered' THEN
      RAISE EXCEPTION 'only operator_entered is accepted without a proposal' USING ERRCODE = '22023';
    END IF;
  ELSIF p_review_origin IS DISTINCT FROM 'ai_proposed' OR p_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'a cited proposal requires review origin ai_proposed on an active value'
      USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('active', 'withdrawn')
     OR (p_status = 'withdrawn') <> (p_asserted_value IS NULL)
     OR (p_status = 'withdrawn' AND p_supersedes_assertion_id IS NULL) THEN
    RAISE EXCEPTION 'region assertion status incoherent' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || '|' || p_source_document_id::text || '|' || p_fact_key || '|' || p_anchor_key, 0));

  SELECT * INTO v_existing FROM public.human_fact_assertions
    WHERE request_digest_sha256 = p_request_digest_sha256;
  IF FOUND THEN
    IF v_existing.organization_id <> p_organization_id
       OR v_existing.actor_id <> p_actor_id
       OR v_existing.source_document_id IS DISTINCT FROM p_source_document_id
       OR v_existing.fact_key <> p_fact_key
       OR v_existing.anchor_key IS DISTINCT FROM p_anchor_key
       OR v_existing.asserted_value IS DISTINCT FROM p_asserted_value
       OR v_existing.status <> p_status
       OR v_existing.page_representation_digest IS DISTINCT FROM p_page_representation_digest
       OR v_existing.supersedes_assertion_id IS DISTINCT FROM p_supersedes_assertion_id
       OR v_existing.forgewing_proposal_id IS DISTINCT FROM p_forgewing_proposal_id
       OR v_existing.customer_mapping_evidence IS DISTINCT FROM p_customer_mapping_evidence THEN
      RAISE EXCEPTION 'region assertion request digest collision' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.documents
                 WHERE id = p_source_document_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'document outside actor organization' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles
                 WHERE id = p_actor_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'actor not found in organization' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_valid_customer_mapping_assertion_evidence(p_customer_mapping_evidence, p_organization_id, p_source_document_id, p_physical_page_number, p_page_representation_digest,p_source_observation_ids,p_source_artifact_id) THEN
    RAISE EXCEPTION 'historical mapping evidence mismatch' USING ERRCODE = '23514';
  END IF;
  v_origin := 'operator_entered';
  IF p_forgewing_proposal_id IS NOT NULL THEN
    SELECT * INTO v_proposal FROM public.forgewing_recovery_proposals
      WHERE proposal_id = p_forgewing_proposal_id AND proposal_version = 3 FOR UPDATE;
    IF NOT FOUND OR v_proposal.recovery_type IS DISTINCT FROM 'priced_value_reading'
       OR v_proposal.authority IS DISTINCT FROM 'non_authoritative' THEN
      RAISE EXCEPTION 'cited proposal is not a value-reading proposal' USING ERRCODE = '23514';
    END IF;
    IF v_proposal.organization_id IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'cited proposal belongs to another organization' USING ERRCODE = '42501';
    END IF;
    IF v_proposal.source_document_id IS DISTINCT FROM p_source_document_id
       OR v_proposal.project_id IS DISTINCT FROM (
         SELECT document.project_id FROM public.documents document WHERE document.id = p_source_document_id)
       OR v_proposal.source_artifact_id IS DISTINCT FROM p_source_artifact_id THEN
      RAISE EXCEPTION 'cited proposal is bound to another document' USING ERRCODE = '23514';
    END IF;
    IF v_proposal.fact_key IS DISTINCT FROM p_fact_key
       OR v_proposal.anchor_key IS DISTINCT FROM p_anchor_key THEN
      RAISE EXCEPTION 'cited proposal is bound to another anchor' USING ERRCODE = '23514';
    END IF;
    IF v_proposal.physical_page_number IS DISTINCT FROM p_physical_page_number
       OR v_proposal.page_representation_digest IS DISTINCT FROM p_page_representation_digest THEN
      RAISE EXCEPTION 'cited proposal is stale for this page representation' USING ERRCODE = '23514';
    END IF;
    IF (SELECT array_agg(DISTINCT id ORDER BY id) FROM unnest(v_proposal.source_observation_ids) id)
       IS DISTINCT FROM
       (SELECT array_agg(DISTINCT id ORDER BY id) FROM unnest(p_source_observation_ids) id) THEN
      RAISE EXCEPTION 'cited proposal cites other source observations' USING ERRCODE = '23514';
    END IF;
    IF v_proposal.reading_outcome IS DISTINCT FROM 'value' THEN
      RAISE EXCEPTION 'an unreadable reading proposes no value' USING ERRCODE = '23514';
    END IF;
    -- Share the proposal row lock with rejection/deferral recording. A prior
    -- disposition blocks a new citation, including an edited value. Exact
    -- assertion replay returned above and never rewrites existing truth.
    IF EXISTS (
      SELECT 1 FROM public.forgewing_recovery_proposal_reviews review
      WHERE review.proposal_row_id = v_proposal.id
        AND review.disposition IN ('rejected', 'deferred')
    ) THEN
      RAISE EXCEPTION 'cited value-reading proposal is rejected or deferred' USING ERRCODE = '23514';
    END IF;
    v_asserted_rate_row := public.forgewing_rate_row_normal_form(p_asserted_value);
    IF v_asserted_rate_row IS NULL THEN
      RAISE EXCEPTION 'asserted value is not a rate row' USING ERRCODE = '22023';
    END IF;
    v_origin := CASE WHEN v_asserted_rate_row = v_proposal.proposed_rate_row
      THEN 'ai_proposed_operator_approved' ELSE 'ai_proposed_operator_modified' END;
  END IF;

  -- B8.4b: the historical producer of the evidence being corrected. A cited
  -- proposal's pinned extraction is what the reviewed value was read from;
  -- otherwise the trusted server names the extraction it verified the region
  -- against. Either way it must bind to this document, organization and source
  -- artifact, or no provenance is recorded and the correction proceeds. The
  -- revision is read from that extraction's own runtime identity, never from
  -- the deployment running now.
  IF p_forgewing_proposal_id IS NOT NULL THEN
    IF v_proposal.extraction_snapshot_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_extraction_id := v_proposal.extraction_snapshot_id::uuid;
    END IF;
  ELSE
    v_source_extraction_id := p_source_extraction_id;
  END IF;
  IF v_source_extraction_id IS NOT NULL THEN
    SELECT e.data #> '{extraction,runtime_identity_v1,identity}' INTO v_source_identity
    FROM public.document_extractions e
    WHERE e.id = v_source_extraction_id AND e.document_id = p_source_document_id
      AND e.organization_id = p_organization_id AND e.field_key IS NULL
      AND coalesce(e.data #>> '{extraction,content_layers_v1,pdf,layout_observations_v1,source_artifact_id}',
        e.data #>> '{extraction,physical_page_provenance_v1,source_artifact_id}') = p_source_artifact_id::text;
    IF NOT FOUND THEN
      v_source_extraction_id := NULL;
    ELSE
      v_source_revision := CASE WHEN v_source_identity->>'deployment_revision' ~ '^[a-f0-9]{40}$'
        THEN v_source_identity->>'deployment_revision' END;
      v_source_environment := CASE WHEN v_source_revision IS NOT NULL
        AND v_source_identity->>'deployment_environment' IN ('production', 'preview', 'development')
        THEN v_source_identity->>'deployment_environment' END;
    END IF;
  END IF;

  -- One linear chain per (document, fact_key, anchor_key). A new row must
  -- supersede exactly the current head, so two competing active values are
  -- never created through this function.
  SELECT count(*), min(h.id::text)::uuid INTO v_head_count, v_head_id
    FROM public.human_fact_assertions h
    WHERE h.organization_id = p_organization_id
      AND h.source_binding = 'region_bound'
      AND h.source_document_id = p_source_document_id
      AND h.fact_key = p_fact_key
      AND h.anchor_key = p_anchor_key
      AND NOT EXISTS (
        SELECT 1 FROM public.human_fact_assertions s
        WHERE s.organization_id = h.organization_id AND s.supersedes_assertion_id = h.id);
  IF v_head_count > 1 THEN
    RAISE EXCEPTION 'region assertion chain is ambiguous' USING ERRCODE = '23505';
  END IF;
  IF p_supersedes_assertion_id IS DISTINCT FROM (CASE WHEN v_head_count = 1 THEN v_head_id END) THEN
    RAISE EXCEPTION 'region assertion must supersede the current chain head' USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.human_fact_assertions(
    organization_id, source_document_id, fact_key, asserted_value, source_binding,
    supersedes_assertion_id, actor_id, reason, status,
    source_artifact_id, physical_page_number, source_region, page_representation_digest,
    parser_version, source_observation_ids, original_source_text, anchor_key,
    review_origin, forgewing_proposal_id, request_digest_sha256, customer_mapping_evidence,
    source_extraction_id, source_deployment_revision, source_deployment_environment)
  VALUES (
    p_organization_id, p_source_document_id, p_fact_key, p_asserted_value, 'region_bound',
    p_supersedes_assertion_id, p_actor_id, btrim(p_reason), p_status,
    p_source_artifact_id, p_physical_page_number, p_source_region, p_page_representation_digest,
    p_parser_version, p_source_observation_ids, p_original_source_text, p_anchor_key,
    v_origin, p_forgewing_proposal_id, p_request_digest_sha256, p_customer_mapping_evidence,
    v_source_extraction_id, v_source_revision, v_source_environment)
  RETURNING id INTO assertion_id;
  inserted := true;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.record_region_bound_human_fact_assertion(uuid,uuid,uuid,text,jsonb,text,text,uuid,integer,jsonb,text,text,text[],text,text,text,text,uuid,text,jsonb,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_region_bound_human_fact_assertion(uuid,uuid,uuid,text,jsonb,text,text,uuid,integer,jsonb,text,text,text[],text,text,text,text,uuid,text,jsonb,uuid)
  TO service_role;
