-- Forgewing B4.4: a rejected or deferred reading cannot authorize a new value.
-- Forward-only correction to the existing B3 recording path. No new truth
-- writer, ledger, provider path, grant, or schema shape. Already-recorded
-- assertions and their exact idempotent replays are preserved.
-- Both record functions lock the same proposal row, serializing a new human
-- citation against rejection/deferral. All existing binding and tenant checks,
-- manual operator entry, immutable chains, and database-derived origins remain.
-- Deploy this migration before the B4.4 workspace. Roll forward to repair;
-- restoring the prior functions would reopen the rejected/deferred citation gap.
-- The existing trigger covers legacy review functions and direct owner inserts
-- as well. Every review insertion for this proposal shares the B3 row lock.
CREATE OR REPLACE FUNCTION public.reject_value_reading_approving_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_proposal_version integer;
BEGIN
  SELECT proposal.proposal_version INTO v_proposal_version
    FROM public.forgewing_recovery_proposals proposal
    WHERE proposal.id = NEW.proposal_row_id AND proposal.proposal_version = 3 FOR UPDATE;
  IF NEW.disposition IN ('accepted', 'modified') AND v_proposal_version = 3 THEN
    RAISE EXCEPTION 'a value-reading proposal is used only through a human fact assertion'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.record_forgewing_value_reading_review(
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
      AND proposal_version = 3 FOR UPDATE;
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
