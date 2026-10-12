-- B8.2d: optional action-time provenance. Older assertions remain NULL.
-- Historical pins are checked against the exact persisted interpretation,
-- never against mutable current active mapping configuration.
ALTER TABLE public.human_fact_assertions ADD COLUMN customer_mapping_evidence jsonb
  CHECK (customer_mapping_evidence IS NULL OR (source_binding='region_bound'
    AND jsonb_typeof(customer_mapping_evidence)='object'
    AND customer_mapping_evidence ?& ARRAY['extractionSnapshotId','mappingPins']
    AND (customer_mapping_evidence - ARRAY['extractionSnapshotId','mappingPins'])='{}'::jsonb
    AND jsonb_typeof(customer_mapping_evidence->'mappingPins')='array'
    AND jsonb_array_length(customer_mapping_evidence->'mappingPins') BETWEEN 1 AND 100));

CREATE FUNCTION public.is_valid_customer_mapping_assertion_evidence(
  evidence jsonb, org uuid, doc uuid, page_number integer, page_digest text, source_ids text[], artifact uuid
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE data jsonb; pages jsonb; p jsonb; pin jsonb; header_refs jsonb;
BEGIN
  IF evidence IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(evidence) IS DISTINCT FROM 'object'
    OR (evidence - ARRAY['extractionSnapshotId','mappingPins']) <> '{}'::jsonb
    OR jsonb_typeof(evidence->'mappingPins') IS DISTINCT FROM 'array'
    OR jsonb_array_length(evidence->'mappingPins') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  SELECT e.data INTO data FROM public.document_extractions e JOIN public.documents d ON d.id=e.document_id
    WHERE e.id=(evidence->>'extractionSnapshotId')::uuid AND e.document_id=doc
      AND e.organization_id=org AND d.organization_id=org AND e.field_key IS NULL FOR SHARE OF e,d;
  IF NOT FOUND THEN RETURN false; END IF;
  IF data #>> '{extraction,content_layers_v1,pdf,layout_observations_v1,source_artifact_id}' IS DISTINCT FROM artifact::text
    OR NOT EXISTS(SELECT 1 FROM public.extraction_source_artifacts a WHERE a.id=artifact AND a.organization_id=org AND a.source_document_id=doc)
    THEN RETURN false; END IF;
  pages := data #> '{extraction,content_layers_v1,pdf,priced_schedule_reconstruction_v1,pages}';
  IF jsonb_typeof(pages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(pages) page WHERE page->>'physical_page_number'=page_number::text) <> 1
    THEN RETURN false; END IF;
  SELECT page INTO p FROM jsonb_array_elements(pages) page WHERE page->>'physical_page_number'=page_number::text;
  IF p->'customer_header_mapping_pins' IS DISTINCT FROM evidence->'mappingPins'
    OR coalesce(p->'inherited_header','null'::jsonb) NOT IN ('null'::jsonb,'false'::jsonb)
    OR coalesce(p->'header_semantics','null'::jsonb) NOT IN ('null'::jsonb,'false'::jsonb)
    OR coalesce(p->'table_segment','null'::jsonb) NOT IN ('null'::jsonb,'false'::jsonb)
    OR p->>'semantic_status'='unresolved' THEN RETURN false; END IF;
  -- Mapping provenance belongs to the row whose values were actually reviewed.
  -- Same-page metadata is insufficient for an unrelated manual correction.
  IF coalesce(cardinality(source_ids),0)=0 OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p->'rows') row_value WHERE NOT EXISTS (
      SELECT 1 FROM unnest(source_ids) selected_id WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(row_value->'cells','[]'::jsonb)||coalesce(row_value->'unresolved_role_cells','[]'::jsonb)) cell_value,
          jsonb_array_elements(cell_value->'source_refs') ref WHERE ref->>'observation_id'=selected_id)))
    THEN RETURN false; END IF;
  FOR pin IN SELECT value FROM jsonb_array_elements(evidence->'mappingPins') LOOP
    header_refs := p #> ARRAY['columns',pin->>'columnIndex','header_source_refs'];
    IF jsonb_typeof(pin) IS DISTINCT FROM 'object'
      OR NOT (pin ?& ARRAY['version','organizationId','documentType','revisionId','digest','sourceSchemaIdentity',
        'physicalPageNumber','columnIndex','sourceLabel','orderedObservationIds','pageRepresentationDigest'])
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['version','organizationId','documentType','revisionId','digest','sourceSchemaIdentity','sourceLabel','pageRepresentationDigest']) key
        WHERE jsonb_typeof(pin->key) IS DISTINCT FROM 'string')
      OR jsonb_typeof(pin->'columnIndex') IS DISTINCT FROM 'number'
      OR jsonb_typeof(pin->'physicalPageNumber') IS DISTINCT FROM 'number'
      OR (pin - ARRAY['version','organizationId','documentType','revisionId','digest','sourceSchemaIdentity',
        'physicalPageNumber','columnIndex','sourceLabel','orderedObservationIds','pageRepresentationDigest']) <> '{}'::jsonb
      OR pin->>'version' IS DISTINCT FROM 'customer_header_mapping_pin_v1'
      OR pin->>'organizationId' IS DISTINCT FROM org::text
      OR pin->>'physicalPageNumber' IS DISTINCT FROM page_number::text
      OR pin->>'pageRepresentationDigest' IS DISTINCT FROM page_digest
      OR pin->>'sourceSchemaIdentity' !~ '^customer-header-schema-v1:[a-f0-9]{64}$'
      OR pin->>'digest' !~ '^[a-f0-9]{64}$'
      OR pin->>'columnIndex' !~ '^(0|[1-9][0-9]*)$'
      OR length(btrim(pin->>'sourceLabel')) NOT BETWEEN 1 AND 512
      OR jsonb_typeof(pin->'orderedObservationIds') IS DISTINCT FROM 'array'
      OR jsonb_array_length(pin->'orderedObservationIds') NOT BETWEEN 1 AND 200
      OR p #>> ARRAY['columns',pin->>'columnIndex','header_text'] IS DISTINCT FROM pin->>'sourceLabel'
      OR coalesce(p #>> ARRAY['columns',pin->>'columnIndex','role'],'') NOT IN ('description','unit','origin_destination','rate')
      OR jsonb_typeof(header_refs) IS DISTINCT FROM 'array'
      OR (SELECT jsonb_agg(ref->'observation_id' ORDER BY n) FROM jsonb_array_elements(header_refs) WITH ORDINALITY member(ref,n))
        IS DISTINCT FROM pin->'orderedObservationIds'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(pin->'orderedObservationIds') id
        WHERE id !~ '^pdf:layout-token:v1:[a-f0-9]{64}$')
      OR NOT EXISTS (SELECT 1 FROM public.customer_header_mapping_revisions r
        WHERE r.revision_id=(pin->>'revisionId')::uuid AND r.organization_id=org AND r.digest=pin->>'digest'
          AND r.document_type=pin->>'documentType' AND r.source_schema_identity=pin->>'sourceSchemaIdentity'
          AND r.source_label=pin->>'sourceLabel'
          AND r.target_role=p #>> ARRAY['columns',pin->>'columnIndex','role']
          AND EXISTS (SELECT 1 FROM public.customer_header_mapping_events history WHERE history.revision_id=r.revision_id AND history.action='activated'))
      THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.is_valid_customer_mapping_assertion_evidence(jsonb,uuid,uuid,integer,text,text[],uuid)
  FROM PUBLIC,anon,authenticated,service_role;
-- Replace rather than retaining an overload that bypasses historical validation.
-- The trailing default preserves existing no-pin named/positional calls.
DROP FUNCTION public.record_region_bound_human_fact_assertion(uuid,uuid,uuid,text,jsonb,text,text,uuid,integer,jsonb,text,text,text[],text,text,text,text,uuid,text);
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
  p_customer_mapping_evidence jsonb DEFAULT NULL
) RETURNS TABLE(assertion_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_existing record;
  v_head_count integer;
  v_head_id uuid;
  v_proposal record;
  v_asserted_rate_row jsonb;
  v_origin text;
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
    review_origin, forgewing_proposal_id, request_digest_sha256, customer_mapping_evidence)
  VALUES (
    p_organization_id, p_source_document_id, p_fact_key, p_asserted_value, 'region_bound',
    p_supersedes_assertion_id, p_actor_id, btrim(p_reason), p_status,
    p_source_artifact_id, p_physical_page_number, p_source_region, p_page_representation_digest,
    p_parser_version, p_source_observation_ids, p_original_source_text, p_anchor_key,
    v_origin, p_forgewing_proposal_id, p_request_digest_sha256, p_customer_mapping_evidence)
  RETURNING id INTO assertion_id;
  inserted := true;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.record_region_bound_human_fact_assertion(uuid,uuid,uuid,text,jsonb,text,text,uuid,integer,jsonb,text,text,text[],text,text,text,text,uuid,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_region_bound_human_fact_assertion(uuid,uuid,uuid,text,jsonb,text,text,uuid,integer,jsonb,text,text,text[],text,text,text,text,uuid,text,jsonb)
  TO service_role;
