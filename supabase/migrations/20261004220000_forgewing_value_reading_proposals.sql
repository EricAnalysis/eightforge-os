-- Forgewing B4.2: immutable value-reading proposals and database-verified
-- human promotion. No provider call, no policy approval, no budget use.
--
-- Proposal. A Forgewing value reading is a version 3 row on the existing
-- forgewing_recovery_proposals table (recovery_type priced_value_reading). It
-- is AI_PROPOSED and non-authoritative like every row there: immutable,
-- idempotent, written only through a service-role record function. It reads
-- either a rate row (description, unit type, rate amount, optional category)
-- or "unreadable". Its binding is copied from the server's resolution entry
-- target: project, document, artifact, page, page representation digest,
-- anchor, observations and region. Lifecycle (pending, used, used edited,
-- rejected, deferred, stale) is derived from records, never stored.
--
-- One road to truth. A proposal reaches truth only through the B3 record
-- function, as an operator's human_fact_assertions row. When the operator
-- cites a proposal, the database verifies that its binding equals the
-- assertion's binding exactly and derives the review origin itself:
-- ai_proposed_operator_approved when the asserted value equals the proposal's
-- value, ai_proposed_operator_modified otherwise. The caller can only say a
-- proposal was used ('ai_proposed'); it can never choose the origin. A
-- proposal that does not bind is refused.
--
-- Currency. Which extraction is current is decided in exactly one place, the
-- server's preferred-extraction selection, and the B3 route already verifies
-- the assertion's page digest and observations against it before calling the
-- record function. This function then requires the proposal's digest and
-- observations to equal those verified values, so a proposal for any other
-- page representation (a stale one) can never be promoted. It does not
-- re-derive the current extraction in SQL, which would be a second truth path.
--
-- Reviews. A value-reading proposal may be reviewed only as rejected or
-- deferred. A trigger refuses accepted/modified reviews on version 3 rows, so
-- the review table can never authorize a value, through any function.
--
-- Additive. New columns are nullable and constrained to version 3. Widened
-- CHECK constraints are strict supersets of themselves. certainty and
-- provider_model become nullable, with versions 1 and 2 still requiring both.
-- The B3 record function keeps its signature and its operator_entered path.

-- The normal form two rate rows are compared in. NULL when the value is not a
-- reviewed rate row: description and unit_type non-blank strings, rate_amount
-- a JSON number, category a non-blank string or absent.
CREATE FUNCTION public.forgewing_rate_row_normal_form(value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_description text;
  v_unit_type text;
  v_category text;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(value->'description') IS DISTINCT FROM 'string'
     OR jsonb_typeof(value->'unit_type') IS DISTINCT FROM 'string'
     OR jsonb_typeof(value->'rate_amount') IS DISTINCT FROM 'number' THEN
    RETURN NULL;
  END IF;
  v_description := pg_catalog.regexp_replace(value->>'description', '^\s+|\s+$', '', 'g');
  v_unit_type := pg_catalog.regexp_replace(value->>'unit_type', '^\s+|\s+$', '', 'g');
  IF v_description = '' OR v_unit_type = '' THEN RETURN NULL; END IF;
  IF jsonb_typeof(value->'category') = 'string' THEN
    v_category := nullif(pg_catalog.regexp_replace(value->>'category', '^\s+|\s+$', '', 'g'), '');
  END IF;
  RETURN jsonb_build_object(
    'description', v_description,
    'unit_type', v_unit_type,
    'rate_amount', value->'rate_amount',
    'category', v_category);
END $$;

REVOKE ALL ON FUNCTION public.forgewing_rate_row_normal_form(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.forgewing_recovery_proposals
  ADD COLUMN project_id uuid REFERENCES public.projects(id) ON DELETE RESTRICT,
  -- The server-given case id, for audit only. Never used for binding.
  ADD COLUMN resolution_case_id text,
  ADD COLUMN fact_key text,
  ADD COLUMN anchor_key text,
  ADD COLUMN source_observation_ids text[],
  ADD COLUMN source_region jsonb,
  ADD COLUMN reading_outcome text,
  ADD COLUMN proposed_rate_row jsonb,
  ADD COLUMN reading_basis text,
  ADD COLUMN request_digest_sha256 text,
  ADD COLUMN output_digest_sha256 text,
  ADD COLUMN rationale text,
  ALTER COLUMN certainty DROP NOT NULL,
  ALTER COLUMN provider_model DROP NOT NULL,
  ADD CONSTRAINT forgewing_recovery_proposals_request_digest_unique UNIQUE (request_digest_sha256);

ALTER TABLE public.forgewing_recovery_proposals
  DROP CONSTRAINT forgewing_recovery_proposals_proposal_version_check,
  ADD CONSTRAINT forgewing_recovery_proposals_proposal_version_check CHECK (
    proposal_version IN (1, 2, 3)),
  DROP CONSTRAINT forgewing_recovery_proposals_task_type_check,
  ADD CONSTRAINT forgewing_recovery_proposals_task_type_check CHECK (
    task_type IN ('pricing_rate_cluster_recovery', 'extraction_recovery_v2', 'priced_value_reading')),
  DROP CONSTRAINT forgewing_recovery_proposals_proposal_id_check,
  ADD CONSTRAINT forgewing_recovery_proposals_proposal_id_check CHECK (
    proposal_id ~ '^forgewing-proposal-(pricing-rate-cluster-[0-9a-f]{32}|recovery-v2-[0-9a-f]{64}|value-reading-[0-9a-f]{64})$'),
  DROP CONSTRAINT forgewing_recovery_proposals_recovery_reason_check,
  ADD CONSTRAINT forgewing_recovery_proposals_recovery_reason_check CHECK (
    recovery_reason IN ('ambiguous_rate_clusters', 'ambiguous_row_assignment')
    OR (recovery_type = 'priced_schedule_header_role_selection'
      AND recovery_reason = 'unresolved_header_semantics')
    OR (recovery_type = 'priced_value_reading'
      AND recovery_reason = 'unresolved_priced_line')),
  DROP CONSTRAINT forgewing_recovery_proposals_eligibility_reason_check,
  ADD CONSTRAINT forgewing_recovery_proposals_eligibility_reason_check CHECK (
    eligibility_reason IN ('ambiguous_relationship', 'deterministic_candidate_set')
    OR (recovery_type = 'priced_value_reading'
      AND eligibility_reason = 'operator_requested_reading')),
  DROP CONSTRAINT forgewing_recovery_proposals_version_shape_check,
  ADD CONSTRAINT forgewing_recovery_proposals_version_shape_check CHECK (
    (proposal_version = 1
      AND recovery_type = 'pricing_rate_single_observation'
      AND selected_observation_id IS NOT NULL
      AND selected_candidate_id IS NULL
      AND recovery_candidates IS NULL
      AND certainty IS NOT NULL
      AND provider_model IS NOT NULL)
    OR
    (proposal_version = 2
      AND recovery_type IN (
        'pricing_rate_multi_observation_cluster',
        'priced_schedule_continuation_attribution',
        'priced_schedule_header_role_selection')
      AND selected_observation_id IS NULL
      AND selected_candidate_id ~ '^recovery-candidate-v2-[0-9a-f]{64}$'
      AND jsonb_typeof(recovery_candidates) = 'array'
      AND jsonb_array_length(recovery_candidates) BETWEEN 1 AND 32
      AND certainty IS NOT NULL
      AND provider_model IS NOT NULL)
    OR
    (proposal_version = 3
      AND recovery_type = 'priced_value_reading'
      AND task_type = 'priced_value_reading'
      AND selected_observation_id IS NULL
      AND selected_candidate_id IS NULL
      AND recovery_candidates IS NULL
      AND certainty IS NULL)
  ),
  ADD CONSTRAINT forgewing_recovery_proposals_value_reading_shape_check CHECK (
    CASE WHEN proposal_version = 3 THEN
      project_id IS NOT NULL
      AND length(btrim(resolution_case_id)) BETWEEN 1 AND 300
      AND fact_key = 'contract_rate_row'
      AND length(btrim(anchor_key)) BETWEEN 1 AND 500
      AND cardinality(source_observation_ids) BETWEEN 1 AND 500
      AND jsonb_typeof(source_region) = 'object'
      AND jsonb_typeof(source_region->'boxes') = 'array'
      AND jsonb_array_length(source_region->'boxes') BETWEEN 1 AND 64
      AND page_representation_digest IS NOT NULL
      AND reading_outcome IN ('value', 'unreadable')
      AND (reading_outcome = 'value') = (proposed_rate_row IS NOT NULL)
      AND (proposed_rate_row IS NULL
        OR proposed_rate_row = public.forgewing_rate_row_normal_form(proposed_rate_row))
      AND reading_basis IN ('region_image', 'region_image_with_text_excerpts')
      AND request_digest_sha256 ~ '^[0-9a-f]{64}$'
      AND output_digest_sha256 ~ '^[0-9a-f]{64}$'
      AND length(btrim(rationale)) BETWEEN 1 AND 500
      AND jsonb_array_length(evidence) = 0
      AND jsonb_array_length(alternative_observation_ids) = 0
    ELSE
      num_nonnulls(project_id, resolution_case_id, fact_key, anchor_key, source_observation_ids,
        source_region, reading_outcome, proposed_rate_row, reading_basis, request_digest_sha256,
        output_digest_sha256, rationale) = 0
    END
  );

-- A value-reading proposal id embeds its digest, so it names exactly one row.
CREATE UNIQUE INDEX forgewing_recovery_proposals_value_reading_id_idx
  ON public.forgewing_recovery_proposals (proposal_id) WHERE proposal_version = 3;
CREATE INDEX forgewing_recovery_proposals_value_reading_anchor_idx
  ON public.forgewing_recovery_proposals (organization_id, source_document_id, anchor_key)
  WHERE proposal_version = 3;

-- The review table cannot authorize a value reading. Only rejected and
-- deferred are recorded; usage is a human_fact_assertions row.
CREATE FUNCTION public.reject_value_reading_approving_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.disposition IN ('accepted', 'modified') AND EXISTS (
    SELECT 1 FROM public.forgewing_recovery_proposals proposal
    WHERE proposal.id = NEW.proposal_row_id AND proposal.proposal_version = 3
  ) THEN
    RAISE EXCEPTION 'a value-reading proposal is used only through a human fact assertion'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER forgewing_recovery_proposal_reviews_value_reading_guard
  BEFORE INSERT ON public.forgewing_recovery_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION public.reject_value_reading_approving_review();

REVOKE ALL ON FUNCTION public.reject_value_reading_approving_review()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_forgewing_value_reading_proposal(
  p_organization_id uuid,
  p_project_id uuid,
  p_source_document_id uuid,
  p_source_artifact_id uuid,
  p_extraction_snapshot_id text,
  p_resolution_case_id text,
  p_physical_page_number integer,
  p_page_representation_digest text,
  p_fact_key text,
  p_anchor_key text,
  p_source_observation_ids text[],
  p_source_region jsonb,
  p_reading_outcome text,
  p_proposed_rate_row jsonb,
  p_reading_basis text,
  p_provider_model text,
  p_prompt_template_id text,
  p_prompt_template_version text,
  p_schema_version text,
  p_request_digest_sha256 text,
  p_output_digest_sha256 text,
  p_proposal_digest_sha256 text,
  p_proposal_id text,
  p_rationale text
) RETURNS TABLE(proposal_row_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_existing record;
  v_rate_row jsonb;
  v_proposed_value text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_proposal_digest_sha256 IS NULL OR p_proposal_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_proposal_id IS DISTINCT FROM 'forgewing-proposal-value-reading-' || p_proposal_digest_sha256
     OR p_request_digest_sha256 IS NULL OR p_request_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_output_digest_sha256 IS NULL OR p_output_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_page_representation_digest IS NULL OR p_page_representation_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid value-reading proposal identity' USING ERRCODE = '22023';
  END IF;
  IF p_reading_outcome = 'value' THEN
    v_rate_row := public.forgewing_rate_row_normal_form(p_proposed_rate_row);
    IF v_rate_row IS NULL THEN
      RAISE EXCEPTION 'value-reading proposal is not a rate row' USING ERRCODE = '22023';
    END IF;
    v_proposed_value := v_rate_row->>'rate_amount';
  ELSIF p_reading_outcome = 'unreadable' AND p_proposed_rate_row IS NULL THEN
    v_proposed_value := 'unreadable';
  ELSE
    RAISE EXCEPTION 'invalid value-reading outcome' USING ERRCODE = '22023';
  END IF;
  -- The artifact ledger is the authority for document and tenant, and the
  -- document is the authority for its project.
  IF NOT EXISTS (
    SELECT 1
    FROM public.extraction_source_artifacts artifact
    JOIN public.documents document ON document.id = artifact.source_document_id
    WHERE artifact.id = p_source_artifact_id
      AND artifact.source_document_id = p_source_document_id
      AND artifact.organization_id = p_organization_id
      AND document.organization_id = p_organization_id
      AND document.project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'value-reading proposal source binding mismatch' USING ERRCODE = '23514';
  END IF;

  -- One answer per exact request. A different answer to the same request is a
  -- contract violation, never a second proposal.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_digest_sha256, 0));
  SELECT * INTO v_existing FROM public.forgewing_recovery_proposals
    WHERE request_digest_sha256 = p_request_digest_sha256;
  IF FOUND THEN
    IF v_existing.proposal_digest_sha256 IS DISTINCT FROM p_proposal_digest_sha256
       OR v_existing.organization_id IS DISTINCT FROM p_organization_id
       OR v_existing.project_id IS DISTINCT FROM p_project_id
       OR v_existing.source_document_id IS DISTINCT FROM p_source_document_id
       OR v_existing.source_artifact_id IS DISTINCT FROM p_source_artifact_id
       OR v_existing.extraction_snapshot_id IS DISTINCT FROM p_extraction_snapshot_id
       OR v_existing.resolution_case_id IS DISTINCT FROM p_resolution_case_id
       OR v_existing.physical_page_number IS DISTINCT FROM p_physical_page_number
       OR v_existing.page_representation_digest IS DISTINCT FROM p_page_representation_digest
       OR v_existing.fact_key IS DISTINCT FROM p_fact_key
       OR v_existing.anchor_key IS DISTINCT FROM p_anchor_key
       OR v_existing.source_observation_ids IS DISTINCT FROM p_source_observation_ids
       OR v_existing.source_region IS DISTINCT FROM p_source_region
       OR v_existing.reading_outcome IS DISTINCT FROM p_reading_outcome
       OR v_existing.proposed_rate_row IS DISTINCT FROM v_rate_row
       OR v_existing.reading_basis IS DISTINCT FROM p_reading_basis
       OR v_existing.provider_model IS DISTINCT FROM p_provider_model
       OR v_existing.prompt_template_id IS DISTINCT FROM p_prompt_template_id
       OR v_existing.prompt_template_version IS DISTINCT FROM p_prompt_template_version
       OR v_existing.schema_version IS DISTINCT FROM p_schema_version
       OR v_existing.output_digest_sha256 IS DISTINCT FROM p_output_digest_sha256
       OR v_existing.rationale IS DISTINCT FROM btrim(p_rationale) THEN
      RAISE EXCEPTION 'value-reading request digest collision' USING ERRCODE = '23505';
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
    shadow_artifact_path, proposal_version, recovery_type, selected_candidate_id,
    recovery_candidates, project_id, resolution_case_id, fact_key, anchor_key,
    source_observation_ids, source_region, reading_outcome, proposed_rate_row, reading_basis,
    request_digest_sha256, output_digest_sha256, rationale)
  VALUES (
    p_organization_id, p_source_document_id, p_source_artifact_id, p_extraction_snapshot_id,
    p_physical_page_number, p_proposal_id, p_proposal_digest_sha256, 'priced_value_reading',
    p_schema_version, 'unresolved_priced_line', 'operator_requested_reading', NULL,
    v_proposed_value, v_proposed_value, p_page_representation_digest, '[]'::jsonb, '[]'::jsonb,
    NULL, 'value_reading', p_provider_model, p_prompt_template_id, p_prompt_template_version,
    NULL, 3, 'priced_value_reading', NULL, NULL, p_project_id, p_resolution_case_id, p_fact_key,
    p_anchor_key, p_source_observation_ids, p_source_region, p_reading_outcome, v_rate_row,
    p_reading_basis, p_request_digest_sha256, p_output_digest_sha256, btrim(p_rationale))
  RETURNING id INTO proposal_row_id;
  inserted := true;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_value_reading_proposal(
  uuid, uuid, uuid, uuid, text, text, integer, text, text, text, text[], jsonb, text, jsonb, text,
  text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_forgewing_value_reading_proposal(
  uuid, uuid, uuid, uuid, text, text, integer, text, text, text, text[], jsonb, text, jsonb, text,
  text, text, text, text, text, text, text, text, text) TO service_role;

-- Rejected and deferred only. Neither confirms anything.
CREATE FUNCTION public.record_forgewing_value_reading_review(
  p_organization_id uuid,
  p_proposal_id text,
  p_proposal_digest_sha256 text,
  p_reviewer_actor_id uuid,
  p_disposition text,
  p_reviewer_rationale text,
  p_review_request_digest_sha256 text
) RETURNS TABLE(review_id uuid, review_version integer, proposal_row_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_proposal record; v_existing record; v_version integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_proposal_digest_sha256 IS NULL OR p_proposal_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_review_request_digest_sha256 IS NULL OR p_review_request_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_disposition IS NULL OR p_disposition NOT IN ('rejected', 'deferred')
     OR p_reviewer_rationale IS NULL OR length(btrim(p_reviewer_rationale)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'invalid value-reading review' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_proposal_digest_sha256, 0));
  SELECT * INTO v_proposal FROM public.forgewing_recovery_proposals
    WHERE proposal_id = p_proposal_id AND proposal_digest_sha256 = p_proposal_digest_sha256
      AND proposal_version = 3;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact value-reading proposal not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_proposal.organization_id IS DISTINCT FROM p_organization_id
     OR NOT EXISTS (SELECT 1 FROM public.user_profiles
       WHERE id = p_reviewer_actor_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'value-reading review authority mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_existing FROM public.forgewing_recovery_proposal_reviews
    WHERE review_request_digest_sha256 = p_review_request_digest_sha256;
  IF FOUND THEN
    IF v_existing.organization_id IS DISTINCT FROM p_organization_id
       OR v_existing.proposal_row_id IS DISTINCT FROM v_proposal.id
       OR v_existing.reviewer_actor_id IS DISTINCT FROM p_reviewer_actor_id
       OR v_existing.disposition IS DISTINCT FROM p_disposition
       OR v_existing.reviewer_rationale IS DISTINCT FROM btrim(p_reviewer_rationale) THEN
      RAISE EXCEPTION 'review request digest collision' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.review_version, v_existing.proposal_row_id, false;
    RETURN;
  END IF;
  SELECT coalesce(pg_catalog.max(review.review_version), 0) + 1 INTO v_version
    FROM public.forgewing_recovery_proposal_reviews review
    WHERE review.proposal_row_id = v_proposal.id;
  INSERT INTO public.forgewing_recovery_proposal_reviews(
    organization_id, proposal_row_id, proposal_digest_sha256, review_version,
    reviewer_actor_id, disposition, confirmed_observation_id, confirmed_candidate_id,
    confirmed_raw_text, reviewer_rationale, review_request_digest_sha256)
  VALUES (p_organization_id, v_proposal.id, p_proposal_digest_sha256, v_version,
    p_reviewer_actor_id, p_disposition, NULL, NULL, NULL, btrim(p_reviewer_rationale),
    p_review_request_digest_sha256)
  RETURNING id INTO review_id;
  review_version := v_version; proposal_row_id := v_proposal.id; inserted := true;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_value_reading_review(
  uuid, text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_forgewing_value_reading_review(
  uuid, text, text, uuid, text, text, text) TO service_role;

-- The B3 record function, extended. Same signature, same operator_entered
-- path. p_review_origin is now an input token: 'operator_entered' without a
-- proposal, 'ai_proposed' with one. The stored origin is derived here.
CREATE OR REPLACE FUNCTION public.record_region_bound_human_fact_assertion(
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
  p_request_digest_sha256 text
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
       OR v_existing.forgewing_proposal_id IS DISTINCT FROM p_forgewing_proposal_id THEN
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

  v_origin := 'operator_entered';
  IF p_forgewing_proposal_id IS NOT NULL THEN
    SELECT * INTO v_proposal FROM public.forgewing_recovery_proposals
      WHERE proposal_id = p_forgewing_proposal_id AND proposal_version = 3;
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
    review_origin, forgewing_proposal_id, request_digest_sha256)
  VALUES (
    p_organization_id, p_source_document_id, p_fact_key, p_asserted_value, 'region_bound',
    p_supersedes_assertion_id, p_actor_id, btrim(p_reason), p_status,
    p_source_artifact_id, p_physical_page_number, p_source_region, p_page_representation_digest,
    p_parser_version, p_source_observation_ids, p_original_source_text, p_anchor_key,
    v_origin, p_forgewing_proposal_id, p_request_digest_sha256)
  RETURNING id INTO assertion_id;
  inserted := true;
  RETURN NEXT;
END $$;
